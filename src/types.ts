export type BinarySource = 'custom' | 'bundled' | 'venv' | 'path';
export type ImportStrategy = 'useBundled' | 'fromEnvironment';
export type TraceLevel = 'off' | 'messages' | 'verbose';

export type ClientLifecycleState =
  | 'idle'
  | 'disabled'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'missingBinary'
  | 'error';

export const DEFAULT_LINE_WIDTH = 80;
export const MIN_LINE_WIDTH = 0;
export const MAX_LINE_WIDTH = 4096;

export const DEFAULT_MAX_SIZE = 104_857_600; // 100 MiB
export const MIN_MAX_SIZE = 1;
export const MAX_MAX_SIZE = 104_857_600;

/** Upstream `tvek server` LSP `initializeParams.initializationOptions` payload. */
export interface TvekInitializationOptions {
  readonly sortKeys: boolean;
  readonly minify: boolean;
  readonly allowComments: boolean;
  readonly strict: boolean;
  readonly structural: boolean;
  readonly lineWidth: number;
  readonly maxSize: number;
}

export interface ResolvedConfig {
  readonly enable: boolean;
  readonly path: string | null;
  readonly importStrategy: ImportStrategy;
  readonly traceServer: TraceLevel;
  readonly initOptions: TvekInitializationOptions;
}

/** Abstracts `vscode.WorkspaceConfiguration.inspect<T>()` for pure Node testing. */
export interface InspectedSetting<T> {
  readonly defaultValue?: T;
  readonly globalValue?: T;
  readonly workspaceValue?: T;
  readonly workspaceFolderValue?: T;
}

export type SettingInspector = <T>(key: string) => InspectedSetting<T> | undefined;

export interface BinaryResolutionContext {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly extensionPath: string;
  readonly workspaceFolders: readonly string[];
  readonly isTrusted: boolean;
  readonly execPath?: string;
}

export interface ResolvedBinary {
  /** Canonical verified absolute path to the tvek binary (or trusted custom Node script). */
  readonly executablePath: string;
  /** Actual executable passed to `execFile` / `LanguageClient` (`shell: false`). */
  readonly command: string;
  /** Leading arguments prepended before tvek CLI arguments (e.g. `[executablePath]` for custom `.mjs`). */
  readonly prefixArgs: readonly string[];
  readonly source: BinarySource;
  readonly version: string;
  /** Always pinned to `extensionPath`, never a workspace directory. */
  readonly safeCwd: string;
  /** Sanitized environment including `NoDefaultCurrentDirectoryInExePath=1`. */
  readonly safeEnv: NodeJS.ProcessEnv;
}

export interface BinarySnapshot {
  readonly executablePath: string;
  readonly source: BinarySource;
  readonly version: string;
}

export interface ExtensionSnapshot {
  readonly state: ClientLifecycleState;
  readonly isTrusted: boolean;
  readonly config: ResolvedConfig;
  readonly binary: BinarySnapshot | null;
  readonly lastError: string | null;
  readonly restartGeneration: number;
}

export interface TvekExtensionApi {
  getSnapshot(): ExtensionSnapshot;
  waitForIdle(): Promise<ExtensionSnapshot>;
}
