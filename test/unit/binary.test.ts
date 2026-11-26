import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  BinaryResolutionError,
  buildServerArgs,
  isPathInsideOrEqual,
  parseTvekVersionOutput,
  resolveBinary,
  sanitizePathEntries,
  type FileSystemDeps,
} from '../../src/binary.js';
import { resolveConfig } from '../../src/config.js';
import type { ResolvedConfig } from '../../src/types.js';

function createFakeFs(params: {
  readonly files: readonly string[];
  readonly directories?: readonly string[];
  readonly executables?: readonly string[];
  readonly symlinks?: Readonly<Record<string, string>>;
  readonly caseInsensitive?: boolean;
}): FileSystemDeps {
  const norm = (p: string) => (params.caseInsensitive ? p.toLowerCase() : p);
  const fileSet = new Set(params.files.map(norm));
  const dirSet = new Set((params.directories ?? []).map(norm));
  const execSet = new Set((params.executables ?? params.files).map(norm));
  const linkMap = new Map(
    Object.entries(params.symlinks ?? {}).map(([k, v]) => [norm(k), v]),
  );

  return {
    async isRegularFile(filePath: string): Promise<boolean> {
      const resolved = linkMap.get(norm(filePath)) ?? filePath;
      if (dirSet.has(norm(resolved))) {
        return false;
      }
      return fileSet.has(norm(resolved));
    },
    async isExecutable(filePath: string): Promise<boolean> {
      const resolved = linkMap.get(norm(filePath)) ?? filePath;
      return execSet.has(norm(resolved));
    },
    async realpath(filePath: string): Promise<string> {
      const target = linkMap.get(norm(filePath));
      if (target !== undefined) {
        return target;
      }
      if (fileSet.has(norm(filePath)) || dirSet.has(norm(filePath))) {
        return filePath;
      }
      throw new Error(`ENOENT: ${filePath}`);
    },
  };
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const base = resolveConfig(() => undefined, true);
  return { ...base, ...overrides };
}

describe('binary resolution & PATH / Workspace Trust security invariants', () => {
  it('parses valid tvek --version stdout and rejects unrelated binaries', () => {
    assert.equal(parseTvekVersionOutput('tvek 0.1.4\n'), '0.1.4');
    assert.equal(parseTvekVersionOutput('tvek 1.2.0-rc.1+abc123\r\n'), '1.2.0-rc.1+abc123');
    assert.equal(parseTvekVersionOutput('other-tool 0.1.4\n'), null);
    assert.equal(parseTvekVersionOutput('tvek v0.1.4\n'), null);
    assert.equal(parseTvekVersionOutput(''), null);
  });

  it('enforces full fallback chain bundled -> .venv -> PATH under useBundled in trusted workspaces', async () => {
    const extPath = '/opt/vscode/ext/tvek-vscode';
    const wsPath = '/home/dev/project';
    const bundledBin = '/opt/vscode/ext/tvek-vscode/bundled/bin/tvek';
    const venvBin = '/home/dev/project/.venv/bin/tvek';
    const pathBin = '/usr/local/bin/tvek';

    // 1. All 3 present -> bundled wins
    const allThree = await resolveBinary(
      {
        platform: 'linux',
        env: { PATH: '/usr/local/bin:/usr/bin' },
        extensionPath: extPath,
        workspaceFolders: [wsPath],
        isTrusted: true,
      },
      makeConfig({ importStrategy: 'useBundled' }),
      {
        fs: createFakeFs({ files: [bundledBin, venvBin, pathBin] }),
        probeVersion: async () => '0.1.4',
      },
    );
    assert.equal(allThree.source, 'bundled');
    assert.equal(allThree.command, bundledBin);
    assert.equal(allThree.safeCwd, extPath);
    assert.equal(allThree.safeEnv.NoDefaultCurrentDirectoryInExePath, '1');

    // 2. Bundled absent -> .venv wins over PATH
    const venvFallback = await resolveBinary(
      {
        platform: 'linux',
        env: { PATH: '/usr/local/bin:/usr/bin' },
        extensionPath: extPath,
        workspaceFolders: [wsPath],
        isTrusted: true,
      },
      makeConfig({ importStrategy: 'useBundled' }),
      {
        fs: createFakeFs({ files: [venvBin, pathBin] }),
        probeVersion: async () => '0.1.4',
      },
    );
    assert.equal(venvFallback.source, 'venv');
    assert.equal(venvFallback.command, venvBin);

    // 3. Bundled + .venv absent -> PATH wins
    const pathFallback = await resolveBinary(
      {
        platform: 'linux',
        env: { PATH: '/usr/local/bin:/usr/bin' },
        extensionPath: extPath,
        workspaceFolders: [wsPath],
        isTrusted: true,
      },
      makeConfig({ importStrategy: 'useBundled' }),
      {
        fs: createFakeFs({ files: [pathBin] }),
        probeVersion: async () => '0.1.4',
      },
    );
    assert.equal(pathFallback.source, 'path');
    assert.equal(pathFallback.command, pathBin);
  });

  it('enforces full fallback chain .venv -> PATH -> bundled under fromEnvironment and multi-root .venv order', async () => {
    const extPath = 'C:\\Users\\Dev\\.vscode\\extensions\\tvek';
    const ws1 = 'C:\\Users\\Dev\\WorkspaceA';
    const ws2 = 'C:\\Users\\Dev\\WorkspaceB';
    const ws3 = 'C:\\Users\\Dev\\WorkspaceC';
    const bundledBin = 'C:\\Users\\Dev\\.vscode\\extensions\\tvek\\bundled\\bin\\tvek.exe';
    const venvBin2 = 'C:\\Users\\Dev\\WorkspaceB\\.venv\\Scripts\\tvek.exe';
    const venvBin3 = 'C:\\Users\\Dev\\WorkspaceC\\.venv\\Scripts\\tvek.exe';
    const pathBin = 'C:\\Program Files\\tvek\\tvek.exe';

    // 1. Multi-root workspace: ws1 has no .venv, ws2 & ws3 have .venv -> ws2 wins over ws3, PATH, and bundled
    const fromVenv = await resolveBinary(
      {
        platform: 'win32',
        env: { Path: 'C:\\Program Files\\tvek;C:\\Windows\\System32' },
        extensionPath: extPath,
        workspaceFolders: [ws1, ws2, ws3],
        isTrusted: true,
      },
      makeConfig({ importStrategy: 'fromEnvironment' }),
      {
        fs: createFakeFs({
          files: [bundledBin, venvBin2, venvBin3, pathBin],
          caseInsensitive: true,
        }),
        probeVersion: async () => '0.1.4',
      },
    );
    assert.equal(fromVenv.source, 'venv');
    assert.equal(fromVenv.command, venvBin2);
    assert.equal(fromVenv.prefixArgs.length, 0);

    // 2. If ws2's .venv binary fails --version probe, falls through to ws3's .venv binary
    const fromVenv3 = await resolveBinary(
      {
        platform: 'win32',
        env: { Path: 'C:\\Program Files\\tvek' },
        extensionPath: extPath,
        workspaceFolders: [ws1, ws2, ws3],
        isTrusted: true,
      },
      makeConfig({ importStrategy: 'fromEnvironment' }),
      {
        fs: createFakeFs({
          files: [bundledBin, venvBin2, venvBin3, pathBin],
          caseInsensitive: true,
        }),
        probeVersion: async (opts) => {
          if (opts.command.toLowerCase() === venvBin2.toLowerCase()) {
            throw new Error('corrupt binary in ws2');
          }
          return '0.1.4';
        },
      },
    );
    assert.equal(fromVenv3.source, 'venv');
    assert.equal(fromVenv3.command, venvBin3);

    // 3. No .venv present -> PATH wins over bundled
    const fromPath = await resolveBinary(
      {
        platform: 'win32',
        env: { Path: 'C:\\Program Files\\tvek' },
        extensionPath: extPath,
        workspaceFolders: [ws1, ws2],
        isTrusted: true,
      },
      makeConfig({ importStrategy: 'fromEnvironment' }),
      {
        fs: createFakeFs({
          files: [bundledBin, pathBin],
          caseInsensitive: true,
        }),
        probeVersion: async () => '0.1.4',
      },
    );
    assert.equal(fromPath.source, 'path');
    assert.equal(fromPath.command, pathBin);

    // 4. Neither .venv nor PATH present -> falls back to bundled
    const fromBundledFallback = await resolveBinary(
      {
        platform: 'win32',
        env: { Path: 'C:\\Windows\\System32' },
        extensionPath: extPath,
        workspaceFolders: [ws1],
        isTrusted: true,
      },
      makeConfig({ importStrategy: 'fromEnvironment' }),
      {
        fs: createFakeFs({
          files: [bundledBin],
          caseInsensitive: true,
        }),
        probeVersion: async () => '0.1.4',
      },
    );
    assert.equal(fromBundledFallback.source, 'bundled');
    assert.equal(fromBundledFallback.command, bundledBin);
  });

  it('fails closed without silent fallback when explicit tvek.path is non-existent, a directory, relative without workspace, or non-executable', async () => {
    const extPath = '/opt/vscode/ext/tvek-vscode';
    const bundledBin = '/opt/vscode/ext/tvek-vscode/bundled/bin/tvek';

    // 1. Non-existent file
    await assert.rejects(
      () =>
        resolveBinary(
          {
            platform: 'linux',
            env: { PATH: '/usr/bin' },
            extensionPath: extPath,
            workspaceFolders: ['/home/dev/project'],
            isTrusted: true,
          },
          makeConfig({ path: '/nonexistent/custom/tvek' }),
          {
            fs: createFakeFs({ files: [bundledBin] }),
            probeVersion: async () => '0.1.4',
          },
        ),
      (err: unknown) =>
        err instanceof BinaryResolutionError && err.code === 'CUSTOM_PATH_INVALID',
    );

    // 2. Real directory path on disk -> fails closed as CUSTOM_PATH_INVALID (never falls back to bundled)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvek-dir-path-'));
    try {
      await assert.rejects(
        () =>
          resolveBinary(
            {
              platform: process.platform,
              env: process.env,
              extensionPath: tmpDir,
              workspaceFolders: [tmpDir],
              isTrusted: true,
            },
            makeConfig({ path: tmpDir }),
          ),
        (err: unknown) =>
          err instanceof BinaryResolutionError && err.code === 'CUSTOM_PATH_INVALID',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // 3. Relative custom path with zero workspace folders -> fails closed
    await assert.rejects(
      () =>
        resolveBinary(
          {
            platform: 'linux',
            env: { PATH: '/usr/bin' },
            extensionPath: extPath,
            workspaceFolders: [],
            isTrusted: true,
          },
          makeConfig({ path: './bin/tvek' }),
          {
            fs: createFakeFs({ files: [bundledBin] }),
            probeVersion: async () => '0.1.4',
          },
        ),
      (err: unknown) =>
        err instanceof BinaryResolutionError && err.code === 'CUSTOM_PATH_INVALID',
    );

    // 4. Non-executable file on POSIX -> fails closed
    const nonExecCustom = '/home/dev/project/tools/tvek';
    await assert.rejects(
      () =>
        resolveBinary(
          {
            platform: 'linux',
            env: { PATH: '/usr/bin' },
            extensionPath: extPath,
            workspaceFolders: ['/home/dev/project'],
            isTrusted: true,
          },
          makeConfig({ path: nonExecCustom }),
          {
            fs: createFakeFs({
              files: [bundledBin, nonExecCustom],
              executables: [bundledBin],
            }),
            probeVersion: async () => '0.1.4',
          },
        ),
      (err: unknown) =>
        err instanceof BinaryResolutionError && err.code === 'CUSTOM_PATH_INVALID',
    );
  });

  it('permits .mjs/.js ELECTRON_RUN_AS_NODE wrapping ONLY for trusted custom tvek.path and never for PATH/.venv/untrusted', async () => {
    const extPath = 'C:\\Ext\\tvek-vscode';
    const customScript = 'C:\\Mocks\\mock-tvek-lsp.mjs';
    const electronExe = 'C:\\Program Files\\Microsoft VS Code\\Code.exe';

    const resolvedCustom = await resolveBinary(
      {
        platform: 'win32',
        env: { Path: 'C:\\Windows\\System32' },
        extensionPath: extPath,
        workspaceFolders: ['C:\\Work\\App'],
        isTrusted: true,
        execPath: electronExe,
      },
      makeConfig({ path: customScript }),
      {
        fs: createFakeFs({ files: [customScript], caseInsensitive: true }),
        probeVersion: async (opts) => {
          assert.equal(opts.command, electronExe);
          assert.deepEqual(opts.args, [customScript, '--version']);
          assert.equal(opts.env.ELECTRON_RUN_AS_NODE, '1');
          return '0.1.4';
        },
      },
    );

    assert.equal(resolvedCustom.source, 'custom');
    assert.equal(resolvedCustom.executablePath, customScript);
    assert.equal(resolvedCustom.command, electronExe);
    assert.deepEqual(resolvedCustom.prefixArgs, [customScript]);
    assert.deepEqual(buildServerArgs(resolvedCustom, 1024), [
      customScript,
      'server',
      '--max-size',
      '1024',
    ]);

    // If a PATH or .venv symlink resolves to a .mjs/.js script, it MUST NOT wrap with execPath or ELECTRON_RUN_AS_NODE!
    const symlinkOnPath = '/usr/local/bin/tvek';
    const scriptTarget = '/usr/local/lib/tvek-wrapper.mjs';
    const resolvedFromPath = await resolveBinary(
      {
        platform: 'linux',
        env: {
          PATH: '/usr/local/bin',
          ELECTRON_RUN_AS_NODE: '1',
        },
        extensionPath: '/opt/ext',
        workspaceFolders: ['/work/app'],
        isTrusted: true,
        execPath: '/opt/vscode/code',
      },
      makeConfig({ path: null, importStrategy: 'fromEnvironment' }),
      {
        fs: createFakeFs({
          files: [scriptTarget],
          symlinks: { [symlinkOnPath]: scriptTarget },
        }),
        probeVersion: async (opts) => {
          assert.equal(opts.command, scriptTarget);
          assert.deepEqual(opts.args, ['--version']);
          assert.equal(opts.env.ELECTRON_RUN_AS_NODE, undefined);
          return '0.1.4';
        },
      },
    );
    assert.equal(resolvedFromPath.command, scriptTarget);
    assert.deepEqual(resolvedFromPath.prefixArgs, []);
    assert.equal(resolvedFromPath.safeEnv.ELECTRON_RUN_AS_NODE, undefined);
  });

  it('strips mixed-case Electron_Run_As_Node from Windows child environment for native binaries', async () => {
    const extPath = 'C:\\Ext\\tvek-vscode';
    const customScript = 'C:\\Mocks\\mock-tvek-lsp.mjs';
    const electronExe = 'C:\\Program Files\\Microsoft VS Code\\Code.exe';
    const winSystemBin = 'C:\\Program Files\\tvek\\tvek.exe';
    const resolvedWinNative = await resolveBinary(
      {
        platform: 'win32',
        env: {
          Path: 'C:\\Program Files\\tvek',
          Electron_Run_As_Node: '1',
        },
        extensionPath: extPath,
        workspaceFolders: ['C:\\Work\\App'],
        isTrusted: false,
        execPath: electronExe,
      },
      makeConfig({ path: customScript, importStrategy: 'fromEnvironment' }),
      {
        fs: createFakeFs({
          files: [customScript, winSystemBin],
          caseInsensitive: true,
        }),
        probeVersion: async (opts) => {
          const envKeysLower = Object.keys(opts.env).map((k) => k.toLowerCase());
          assert.ok(
            !envKeysLower.includes('electron_run_as_node'),
            'Mixed-case Electron_Run_As_Node must be stripped on Windows',
          );
          return '0.1.4';
        },
      },
    );
    assert.equal(resolvedWinNative.source, 'path');
    assert.equal(resolvedWinNative.command, winSystemBin);
  });

  it('blocks .venv, relative PATH entries, workspace PATH dirs, and symlinks into workspace when untrusted', async () => {
    const extPath = 'C:\\Ext\\tvek-vscode';
    const wsPath = 'C:\\Users\\Victim\\UntrustedRepo';
    const venvEvil = 'C:\\Users\\Victim\\UntrustedRepo\\.venv\\Scripts\\tvek.exe';
    const wsBinEvil = 'c:\\users\\victim\\untrustedrepo\\bin\\tvek.exe';
    const symlinkInSystem = 'C:\\Tools\\tvek.exe';
    const safeSystemBin = 'C:\\Program Files\\tvek\\tvek.exe';

    const fakeFs = createFakeFs({
      files: [venvEvil, wsBinEvil, safeSystemBin],
      symlinks: {
        // External PATH entry whose symlink target resolves inside the untrusted workspace!
        [symlinkInSystem]: wsBinEvil,
      },
      caseInsensitive: true,
    });

    const rawPath = [
      '',
      '.',
      '..',
      'bin',
      'relative\\bin',
      '\\drive-relative\\bin',
      'C:cwd-relative',
      'c:\\users\\victim\\untrustedrepo\\bin',
      'C:\\Tools',
      'C:\\Program Files\\tvek',
    ].join(';');

    const sanitized = sanitizePathEntries(rawPath, 'win32', [wsPath], false);
    assert.deepEqual(sanitized, ['C:\\Tools', 'C:\\Program Files\\tvek']);

    const resolved = await resolveBinary(
      {
        platform: 'win32',
        env: { Path: rawPath },
        extensionPath: extPath,
        workspaceFolders: [wsPath],
        isTrusted: false,
      },
      // Even if a caller passed custom path / fromEnvironment, untrusted resolution must ignore both
      makeConfig({ path: venvEvil, importStrategy: 'fromEnvironment' }),
      {
        fs: fakeFs,
        probeVersion: async () => '0.1.4',
      },
    );

    assert.equal(resolved.source, 'path');
    assert.equal(resolved.executablePath, safeSystemBin);
    assert.equal(resolved.command, safeSystemBin);
  });

  it('blocks untrusted workspace subdirectories named with leading double-dots (..evil) across PATH and symlink realpath', async () => {
    const wsPosix = '/home/victim/untrusted-repo';
    const dotDotSubdirBin = '/home/victim/untrusted-repo/..evil/tvek';
    const externalSymlink = '/usr/local/bin/tvek';
    const safeBin = '/usr/bin/tvek';

    // `..evil` is a child directory INSIDE `/home/victim/untrusted-repo`, NOT `../` parent traversal!
    assert.equal(
      isPathInsideOrEqual(dotDotSubdirBin, wsPosix, 'linux'),
      true,
      'Subdirectory starting with ".." inside workspace must be classified as inside workspace',
    );
    assert.equal(
      isPathInsideOrEqual(
        'C:\\Users\\Victim\\UntrustedRepo\\..evil\\tvek.exe',
        'C:\\Users\\Victim\\UntrustedRepo',
        'win32',
      ),
      true,
      'Windows subdirectory starting with ".." inside workspace must be classified as inside workspace',
    );

    const sanitized = sanitizePathEntries(
      '/home/victim/untrusted-repo/..evil:/usr/local/bin:/usr/bin',
      'linux',
      [wsPosix],
      false,
    );
    assert.deepEqual(sanitized, ['/usr/local/bin', '/usr/bin']);

    const resolved = await resolveBinary(
      {
        platform: 'linux',
        env: { PATH: '/home/victim/untrusted-repo/..evil:/usr/local/bin:/usr/bin' },
        extensionPath: '/opt/vscode/ext/tvek-vscode',
        workspaceFolders: [wsPosix],
        isTrusted: false,
      },
      makeConfig(),
      {
        fs: createFakeFs({
          files: [dotDotSubdirBin, safeBin],
          symlinks: { [externalSymlink]: dotDotSubdirBin },
        }),
        probeVersion: async () => '0.1.4',
      },
    );

    assert.equal(resolved.executablePath, safeBin);
    assert.equal(resolved.source, 'path');
  });

  it('blocks Windows device-namespace PATH entries (\\\\?\\C:\\... and \\\\.\\C:\\...) pointing inside an untrusted workspace', async () => {
    const wsWin = 'C:\\Users\\Victim\\UntrustedRepo';
    const rawPath = [
      '\\\\?\\C:\\Users\\Victim\\UntrustedRepo\\bin',
      '\\\\.\\C:\\Users\\Victim\\UntrustedRepo\\bin',
      'C:\\Program Files\\tvek',
    ].join(';');

    const sanitized = sanitizePathEntries(rawPath, 'win32', [wsWin], false);
    assert.deepEqual(
      sanitized,
      ['C:\\Program Files\\tvek'],
      'Win32 device-prefixed untrusted workspace paths must not survive PATH sanitization',
    );
  });

  it('does not confuse sibling prefix directories (/work/app-other vs /work/app)', () => {
    assert.equal(isPathInsideOrEqual('/work/app/bin', '/work/app', 'linux'), true);
    assert.equal(isPathInsideOrEqual('/work/app-other/bin', '/work/app', 'linux'), false);
    assert.equal(
      isPathInsideOrEqual('C:\\Work\\App-Other\\bin', 'C:\\Work\\App', 'win32'),
      false,
    );
    assert.equal(
      isPathInsideOrEqual('d:\\Work\\App\\bin', 'C:\\Work\\App', 'win32'),
      false,
    );
  });

  it('normalizes \\\\?\\UNC\\ shares, rejects double-prefix attacks, and rejects raw Win32 device namespaces', () => {
    const uncWorkspace = '\\\\fileserver\\eng\\UntrustedRepo';
    const winWorkspace = 'C:\\Users\\Victim\\UntrustedRepo';
    const rawPath = [
      '\\\\?\\UNC\\fileserver\\eng\\UntrustedRepo\\bin',
      '\\\\.\\UNC\\fileserver\\eng\\UntrustedRepo\\tools',
      '\\\\?\\\\\\?\\C:\\Users\\Victim\\UntrustedRepo\\bin',
      '\\\\?\\ \\\\?\\C:\\Users\\Victim\\UntrustedRepo\\bin',
      '\\??\\\\\\?\\C:\\Users\\Victim\\UntrustedRepo\\bin',
      '\\\\.\\PIPE\\malicious-pipe',
      '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\bin',
      '\\\\fileserver\\eng\\SharedTools\\bin',
    ].join(';');

    const sanitized = sanitizePathEntries(
      rawPath,
      'win32',
      [uncWorkspace, winWorkspace],
      false,
    );
    assert.deepEqual(sanitized, ['\\\\fileserver\\eng\\SharedTools\\bin']);
  });

  it('blocks Win32 trailing-dot/slash aliases, UNC share trailing dots, resurrected ".. " segments, and NTFS ADS streams', () => {
    const wsWin = 'C:\\Users\\Victim\\UntrustedRepo';
    const uncShareWs = '\\\\fileserver\\UntrustedShare';

    assert.equal(
      isPathInsideOrEqual('C:\\Users\\Victim\\UntrustedRepo\\', wsWin, 'win32'),
      true,
    );
    assert.equal(
      isPathInsideOrEqual('C:\\Users\\Victim\\UntrustedRepo.\\bin', wsWin, 'win32'),
      true,
      'Win32 strips trailing dots on path segments (UntrustedRepo.\\bin resolves to UntrustedRepo\\bin under SearchPathW)',
    );
    assert.equal(
      isPathInsideOrEqual('C:\\Users\\Victim\\UntrustedRepo.', wsWin, 'win32'),
      true,
      'Win32 strips trailing dot on leaf workspace directory (UntrustedRepo. resolves to UntrustedRepo)',
    );
    assert.equal(
      isPathInsideOrEqual('\\\\fileserver\\UntrustedShare.\\bin', uncShareWs, 'win32'),
      true,
      'Win32 UNC share trailing dot must match canonical UNC share root',
    );

    const rawPath = [
      'C:\\Users\\Victim\\UntrustedRepo\\',
      'C:\\Users\\Victim\\UntrustedRepo.',
      'C:\\Users\\Victim\\UntrustedRepo.\\bin',
      'C:\\Users\\Victim\\UntrustedRepo \\bin',
      'C:\\Users\\Victim\\UntrustedRepo\\bin.',
      '\\\\?\\C:\\Users\\Victim\\UntrustedRepo.\\bin',
      '\\\\fileserver\\UntrustedShare.\\bin',
      'C:\\Users\\Victim\\UntrustedRepo::$INDEX_ALLOCATION\\bin',
      'C:\\Safe\\.. \\Users\\Victim\\UntrustedRepo\\bin',
      'C:\\Program Files\\tvek',
    ].join(';');

    const sanitized = sanitizePathEntries(rawPath, 'win32', [wsWin, uncShareWs], false);
    assert.deepEqual(sanitized, ['C:\\Program Files\\tvek']);
  });

  it('probes the real mock-tvek-lsp.mjs fixture via child_process.execFile', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const mockPath = path.join(repoRoot, 'test', 'fixtures', 'mock-tvek-lsp.mjs');

    const resolved = await resolveBinary(
      {
        platform: process.platform,
        env: process.env,
        extensionPath: repoRoot,
        workspaceFolders: [repoRoot],
        isTrusted: true,
        execPath: process.execPath,
      },
      makeConfig({ path: mockPath }),
    );

    assert.equal(resolved.source, 'custom');
    assert.equal(resolved.version, '0.1.4');
    assert.equal(resolved.safeCwd, repoRoot);
  });
});
