import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type {
  BinaryResolutionContext,
  BinarySource,
  ResolvedBinary,
  ResolvedConfig,
} from './types.js';

export const VERSION_OUTPUT_REGEX =
  /^tvek\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/;

export const VERSION_PROBE_TIMEOUT_MS = 3_000;
export const VERSION_PROBE_MAX_BUFFER = 16_384;

const NODE_SCRIPT_EXTENSIONS = new Set(['.mjs', '.cjs', '.js']);

export type BinaryErrorCode =
  | 'CUSTOM_PATH_INVALID'
  | 'NOT_FOUND'
  | 'VERSION_PROBE_FAILED';

export class BinaryResolutionError extends Error {
  public readonly code: BinaryErrorCode;
  public readonly attempted: readonly string[];

  public constructor(
    code: BinaryErrorCode,
    message: string,
    attempted: readonly string[] = [],
  ) {
    super(message);
    this.name = 'BinaryResolutionError';
    this.code = code;
    this.attempted = attempted;
  }
}

export interface FileSystemDeps {
  isRegularFile(filePath: string): Promise<boolean>;
  isExecutable(filePath: string): Promise<boolean>;
  realpath(filePath: string): Promise<string>;
}

export interface VersionProbeOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export type VersionProbeFn = (options: VersionProbeOptions) => Promise<string>;

export interface BinaryResolutionDeps {
  readonly fs?: FileSystemDeps;
  readonly probeVersion?: VersionProbeFn;
}

const defaultFsDeps: FileSystemDeps = {
  async isRegularFile(filePath: string): Promise<boolean> {
    try {
      const st = await fsp.stat(filePath);
      return st.isFile();
    } catch {
      return false;
    }
  },
  async isExecutable(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  async realpath(filePath: string): Promise<string> {
    return fsp.realpath(filePath);
  },
};

export function parseTvekVersionOutput(stdout: string): string | null {
  const firstLine = stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  const match = VERSION_OUTPUT_REGEX.exec(firstLine);
  return match?.[1] ?? null;
}

export const defaultProbeVersion: VersionProbeFn = ({
  command,
  args,
  cwd,
  env,
}: VersionProbeOptions): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        timeout: VERSION_PROBE_TIMEOUT_MS,
        maxBuffer: VERSION_PROBE_MAX_BUFFER,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              `Version probe failed for "${command}": ${error.message}`,
            ),
          );
          return;
        }
        const parsed = parseTvekVersionOutput(stdout);
        if (!parsed) {
          reject(
            new Error(
              `Unexpected --version output from "${command}": expected "tvek <semver>".`,
            ),
          );
          return;
        }
        resolve(parsed);
      },
    );
  });

function pathModuleFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function canonicalizeWin32FilesystemPath(unwrapped: string): string | null {
  const normalized = path.win32.normalize(unwrapped);
  const { root } = path.win32.parse(normalized);
  if (root.length === 0) {
    return null;
  }

  let canonicalRoot = root;
  if (root.startsWith('\\\\')) {
    const uncParts = root
      .slice(2)
      .split('\\')
      .filter((part) => part.length > 0);
    if (uncParts.length !== 2) {
      return null;
    }
    const server = uncParts[0]!;
    const share = uncParts[1]!.replace(/[. ]+$/g, '');
    if (
      server.includes(':') ||
      share.includes(':') ||
      share.length === 0 ||
      share === '.' ||
      share === '..'
    ) {
      return null;
    }
    canonicalRoot = `\\\\${server}\\${share}\\`;
  }

  const remainder = normalized.slice(root.length);
  if (remainder.length === 0) {
    return canonicalRoot;
  }

  const cleanSegments: string[] = [];
  for (const seg of remainder.split('\\')) {
    if (seg.length === 0) {
      continue;
    }
    // Reject NTFS Alternate Data Streams (e.g. `dir::$INDEX_ALLOCATION` or `file.exe:stream`)
    if (seg.includes(':')) {
      return null;
    }
    // Win32 SearchPathW / CreateFileW strips trailing ASCII dots and spaces per segment
    const stripped = seg.replace(/[. ]+$/g, '');
    if (stripped.length === 0 || stripped === '.' || stripped === '..') {
      return null;
    }
    cleanSegments.push(stripped);
  }

  return `${canonicalRoot}${cleanSegments.join('\\')}`;
}

/**
 * Validates and canonicalizes an absolute filesystem path for the target platform.
 * On `win32`, unwraps DOS/extended-length drive (`\\?\C:\...`, `\\.\C:\...`, `\??\C:\...`)
 * and UNC (`\\?\UNC\server\share\...`, `\\.\UNC\server\share\...`) prefixes, strips Win32
 * trailing dots/spaces per segment, and rejects NTFS ADS streams, raw device namespaces
 * (`\\.\PIPE\...`, `\\?\Volume{...}\...`), drive-relative (`C:foo`), and root-relative (`\foo`) paths.
 */
export function canonicalizeComparisonPath(
  candidate: string,
  platform: NodeJS.Platform,
): string | null {
  if (candidate.length === 0 || candidate.includes('\0')) {
    return null;
  }

  if (platform === 'win32') {
    const extUncMatch =
      /^(?:[\\/]{2}[.?]|\\\?\?)[\\/]unc[\\/]([^.\\/?][^\\/]*[\\/][^\\/]+.*)$/i.exec(
        candidate,
      );
    if (extUncMatch?.[1]) {
      return canonicalizeWin32FilesystemPath(`\\\\${extUncMatch[1]}`);
    }

    const extDriveMatch =
      /^(?:[\\/]{2}[.?]|\\\?\?)[\\/]([A-Za-z]:[\\/].*)$/.exec(candidate);
    if (extDriveMatch?.[1]) {
      return canonicalizeWin32FilesystemPath(extDriveMatch[1]);
    }

    // Reject all remaining Win32 device/NT namespaces (e.g. \\.\PIPE\..., \\?\Volume{...}\...)
    if (/^(?:[\\/]{2}[.?]|\\\?\?)(?:[\\/]|$)/.test(candidate)) {
      return null;
    }

    // Require explicit drive root (`C:\` or `C:/`) or standard UNC share (`\\server\share`)
    if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^.\\/?][^\\/]*[\\/][^\\/]+)/.test(candidate)) {
      return canonicalizeWin32FilesystemPath(candidate);
    }

    return null;
  }

  if (!candidate.startsWith('/')) {
    return null;
  }
  return path.posix.normalize(candidate);
}

export function isStrictlyAbsolutePath(
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  return canonicalizeComparisonPath(candidate, platform) !== null;
}

export function isPathInsideOrEqual(
  targetPath: string,
  parentDir: string,
  platform: NodeJS.Platform,
): boolean {
  const pathMod = pathModuleFor(platform);
  let normTarget = canonicalizeComparisonPath(targetPath, platform);
  let normParent = canonicalizeComparisonPath(parentDir, platform);

  if (normTarget === null || normParent === null) {
    return false;
  }

  if (platform === 'win32' || platform === 'darwin') {
    normTarget = normTarget.toLowerCase();
    normParent = normParent.toLowerCase();
  }

  const rel = pathMod.relative(normParent, normTarget);
  return (
    rel === '' ||
    (rel !== '..' &&
      !rel.startsWith(`..${pathMod.sep}`) &&
      !pathMod.isAbsolute(rel))
  );
}

export function isInsideAnyWorkspace(
  targetPath: string,
  workspaceRoots: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  for (const wsRoot of workspaceRoots) {
    if (isPathInsideOrEqual(targetPath, wsRoot, platform)) {
      return true;
    }
  }
  return false;
}

function readEnvPathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (typeof env.PATH === 'string') {
    return env.PATH;
  }
  if (platform === 'win32') {
    for (const [key, value] of Object.entries(env)) {
      if (key.toLowerCase() === 'path' && typeof value === 'string') {
        return value;
      }
    }
  }
  return '';
}

export function sanitizePathEntries(
  rawPath: string,
  platform: NodeJS.Platform,
  workspaceRoots: readonly string[],
  isTrusted: boolean,
): string[] {
  const delimiter = platform === 'win32' ? ';' : ':';
  const entries = rawPath.split(delimiter);
  const clean: string[] = [];
  const seen = new Set<string>();

  for (const rawEntry of entries) {
    const unquoted =
      platform === 'win32'
        ? rawEntry.trim().replace(/^"(.*)"$/, '$1').trim()
        : rawEntry.trim();

    if (unquoted.length === 0 || unquoted === '.' || unquoted === '..') {
      continue;
    }

    const normalized = canonicalizeComparisonPath(unquoted, platform);
    if (normalized === null) {
      continue;
    }
    if (!isTrusted && isInsideAnyWorkspace(normalized, workspaceRoots, platform)) {
      continue;
    }

    const dedupeKey =
      platform === 'win32' || platform === 'darwin'
        ? normalized.toLowerCase()
        : normalized;
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      clean.push(normalized);
    }
  }

  return clean;
}

function buildSafeEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  sanitizedPathEntries: readonly string[],
  platform: NodeJS.Platform,
  enableElectronRunAsNode: boolean,
): NodeJS.ProcessEnv {
  const delimiter = platform === 'win32' ? ';' : ':';
  const joinedPath = sanitizedPathEntries.join(delimiter);
  const nextEnv: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    const upperKey = key.toUpperCase();
    if (platform === 'win32' && upperKey === 'PATH') {
      continue;
    }
    if (upperKey === 'ELECTRON_RUN_AS_NODE') {
      continue;
    }
    if (upperKey === 'NODEFAULTCURRENTDIRECTORYINEXEPATH') {
      continue;
    }
    nextEnv[key] = value;
  }

  nextEnv.PATH = joinedPath;
  nextEnv.NoDefaultCurrentDirectoryInExePath = '1';
  if (enableElectronRunAsNode) {
    nextEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  return nextEnv;
}

interface CandidateSpec {
  readonly path: string;
  readonly source: BinarySource;
}

async function expandWorkspaceRoots(
  workspaceFolders: readonly string[],
  fsDeps: FileSystemDeps,
): Promise<string[]> {
  const roots = new Set<string>();
  for (const folder of workspaceFolders) {
    roots.add(folder);
    try {
      const canonical = await fsDeps.realpath(folder);
      roots.add(canonical);
    } catch {
      // Workspace folder might not exist on disk yet; keep original path.
    }
  }
  return [...roots];
}

export function buildServerArgs(
  binary: ResolvedBinary,
  maxSize: number,
): string[] {
  return [...binary.prefixArgs, 'server', '--max-size', String(maxSize)];
}

export async function resolveBinary(
  ctx: BinaryResolutionContext,
  cfg: ResolvedConfig,
  deps: BinaryResolutionDeps = {},
): Promise<ResolvedBinary> {
  const fsDeps = deps.fs ?? defaultFsDeps;
  const probeVersion = deps.probeVersion ?? defaultProbeVersion;
  const pathMod = pathModuleFor(ctx.platform);
  const binaryFileName = ctx.platform === 'win32' ? 'tvek.exe' : 'tvek';

  const workspaceRoots = await expandWorkspaceRoots(ctx.workspaceFolders, fsDeps);
  const rawEnvPath = readEnvPathValue(ctx.env, ctx.platform);
  const sanitizedPathDirs = sanitizePathEntries(
    rawEnvPath,
    ctx.platform,
    workspaceRoots,
    ctx.isTrusted,
  );

  // 1. Trusted explicit custom `tvek.path` (fail-closed if invalid; no silent fallback)
  if (ctx.isTrusted && cfg.path !== null && cfg.path.trim().length > 0) {
    const rawCustom = cfg.path.trim();
    let resolvedCandidate: string;

    const customNormalized = canonicalizeComparisonPath(rawCustom, ctx.platform);
    if (customNormalized !== null) {
      resolvedCandidate = customNormalized;
    } else if (/^(?:[\\/]{2}[.?]|\\\?\?)(?:[\\/]|$)/.test(rawCustom) && ctx.platform === 'win32') {
      throw new BinaryResolutionError(
        'CUSTOM_PATH_INVALID',
        `Configured tvek.path uses an unsupported Win32 device namespace: "${rawCustom}".`,
        [rawCustom],
      );
    } else if (ctx.workspaceFolders.length > 0) {
      const firstWs = ctx.workspaceFolders[0]!;
      resolvedCandidate = pathMod.resolve(firstWs, rawCustom);
    } else {
      throw new BinaryResolutionError(
        'CUSTOM_PATH_INVALID',
        `Configured tvek.path "${rawCustom}" is relative, but no workspace folder is open.`,
        [rawCustom],
      );
    }

    if (!(await fsDeps.isRegularFile(resolvedCandidate))) {
      throw new BinaryResolutionError(
        'CUSTOM_PATH_INVALID',
        `Configured tvek.path does not exist or is not a regular file: "${resolvedCandidate}".`,
        [resolvedCandidate],
      );
    }

    let canonicalPath: string;
    try {
      canonicalPath = await fsDeps.realpath(resolvedCandidate);
    } catch {
      throw new BinaryResolutionError(
        'CUSTOM_PATH_INVALID',
        `Failed to resolve canonical path for tvek.path: "${resolvedCandidate}".`,
        [resolvedCandidate],
      );
    }

    if (!(await fsDeps.isRegularFile(canonicalPath))) {
      throw new BinaryResolutionError(
        'CUSTOM_PATH_INVALID',
        `Resolved tvek.path target is not a regular file: "${canonicalPath}".`,
        [canonicalPath],
      );
    }

    const ext = pathMod.extname(canonicalPath).toLowerCase();
    const isNodeScript = NODE_SCRIPT_EXTENSIONS.has(ext);

    if (!isNodeScript && ctx.platform !== 'win32') {
      if (!(await fsDeps.isExecutable(canonicalPath))) {
        throw new BinaryResolutionError(
          'CUSTOM_PATH_INVALID',
          `Configured tvek.path is not executable: "${canonicalPath}".`,
          [canonicalPath],
        );
      }
    }

    const command = isNodeScript ? (ctx.execPath ?? process.execPath) : canonicalPath;
    const prefixArgs = isNodeScript ? [canonicalPath] : [];
    const safeEnv = buildSafeEnvironment(
      ctx.env,
      sanitizedPathDirs,
      ctx.platform,
      isNodeScript,
    );

    let version: string;
    try {
      version = await probeVersion({
        command,
        args: [...prefixArgs, '--version'],
        cwd: ctx.extensionPath,
        env: safeEnv,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new BinaryResolutionError(
        'VERSION_PROBE_FAILED',
        `Configured tvek.path failed version check: ${detail}`,
        [canonicalPath],
      );
    }

    return {
      executablePath: canonicalPath,
      command,
      prefixArgs,
      source: 'custom',
      version,
      safeCwd: ctx.extensionPath,
      safeEnv,
    };
  }

  // 2. Build ordered native candidate list based on Workspace Trust & importStrategy
  const bundledCandidate: CandidateSpec = {
    path: pathMod.join(ctx.extensionPath, 'bundled', 'bin', binaryFileName),
    source: 'bundled',
  };

  const venvCandidates: CandidateSpec[] = ctx.isTrusted
    ? ctx.workspaceFolders.map((ws) => ({
        path:
          ctx.platform === 'win32'
            ? pathMod.join(ws, '.venv', 'Scripts', 'tvek.exe')
            : pathMod.join(ws, '.venv', 'bin', 'tvek'),
        source: 'venv' as const,
      }))
    : [];

  const pathCandidates: CandidateSpec[] = sanitizedPathDirs.map((dir) => ({
    path: pathMod.join(dir, binaryFileName),
    source: 'path' as const,
  }));

  let orderedCandidates: CandidateSpec[];
  if (!ctx.isTrusted) {
    orderedCandidates = [bundledCandidate, ...pathCandidates];
  } else if (cfg.importStrategy === 'fromEnvironment') {
    orderedCandidates = [...venvCandidates, ...pathCandidates, bundledCandidate];
  } else {
    orderedCandidates = [bundledCandidate, ...venvCandidates, ...pathCandidates];
  }

  const safeEnv = buildSafeEnvironment(
    ctx.env,
    sanitizedPathDirs,
    ctx.platform,
    false,
  );

  const attempted: string[] = [];
  let lastProbeError: string | null = null;

  for (const candidate of orderedCandidates) {
    attempted.push(candidate.path);

    if (!(await fsDeps.isRegularFile(candidate.path))) {
      continue;
    }

    let canonicalPath: string;
    try {
      canonicalPath = await fsDeps.realpath(candidate.path);
    } catch {
      continue;
    }

    if (!(await fsDeps.isRegularFile(canonicalPath))) {
      continue;
    }

    const normalizedCanonical = canonicalizeComparisonPath(
      canonicalPath,
      ctx.platform,
    );
    if (normalizedCanonical === null) {
      continue;
    }

    // Untrusted workspace boundary check on canonical symlink-resolved target
    if (
      !ctx.isTrusted &&
      candidate.source !== 'bundled' &&
      isInsideAnyWorkspace(normalizedCanonical, workspaceRoots, ctx.platform)
    ) {
      continue;
    }

    if (ctx.platform !== 'win32' && !(await fsDeps.isExecutable(canonicalPath))) {
      continue;
    }

    try {
      const version = await probeVersion({
        command: canonicalPath,
        args: ['--version'],
        cwd: ctx.extensionPath,
        env: safeEnv,
      });

      return {
        executablePath: canonicalPath,
        command: canonicalPath,
        prefixArgs: [],
        source: candidate.source,
        version,
        safeCwd: ctx.extensionPath,
        safeEnv,
      };
    } catch (err) {
      lastProbeError = err instanceof Error ? err.message : String(err);
    }
  }

  if (lastProbeError !== null) {
    throw new BinaryResolutionError(
      'VERSION_PROBE_FAILED',
      `Found candidate tvek binary, but version verification failed: ${lastProbeError}`,
      attempted,
    );
  }

  throw new BinaryResolutionError(
    'NOT_FOUND',
    'Unable to locate a valid tvek executable (checked bundled binary, environment, and PATH).',
    attempted,
  );
}
