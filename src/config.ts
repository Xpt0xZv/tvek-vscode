import {
  DEFAULT_LINE_WIDTH,
  DEFAULT_MAX_SIZE,
  MAX_LINE_WIDTH,
  MAX_MAX_SIZE,
  MIN_LINE_WIDTH,
  MIN_MAX_SIZE,
  type ImportStrategy,
  type ResolvedConfig,
  type SettingInspector,
  type TraceLevel,
  type TvekInitializationOptions,
} from './types.js';

export function clampInt(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fallback;
  }
  const truncated = Math.trunc(raw);
  if (truncated < min) {
    return min;
  }
  if (truncated > max) {
    return max;
  }
  return truncated;
}

function readBoolean(
  inspect: SettingInspector,
  key: string,
  isTrusted: boolean,
  fallback: boolean,
): boolean {
  const inspected = inspect<unknown>(key);
  const candidate = isTrusted
    ? (inspected?.workspaceFolderValue ??
      inspected?.workspaceValue ??
      inspected?.globalValue ??
      inspected?.defaultValue)
    : (inspected?.globalValue ?? inspected?.defaultValue);

  return typeof candidate === 'boolean' ? candidate : fallback;
}

function readNumber(
  inspect: SettingInspector,
  key: string,
  isTrusted: boolean,
  min: number,
  max: number,
  fallback: number,
): number {
  const inspected = inspect<unknown>(key);
  const candidate = isTrusted
    ? (inspected?.workspaceFolderValue ??
      inspected?.workspaceValue ??
      inspected?.globalValue ??
      inspected?.defaultValue)
    : (inspected?.globalValue ?? inspected?.defaultValue);

  return clampInt(candidate, min, max, fallback);
}

function readCustomPath(inspect: SettingInspector, isTrusted: boolean): string | null {
  if (!isTrusted) {
    return null;
  }
  const inspected = inspect<unknown>('path');
  const candidate =
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue ??
    inspected?.defaultValue;

  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readImportStrategy(
  inspect: SettingInspector,
  isTrusted: boolean,
): ImportStrategy {
  if (!isTrusted) {
    return 'useBundled';
  }
  const inspected = inspect<unknown>('importStrategy');
  const candidate =
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue ??
    inspected?.defaultValue;

  return candidate === 'fromEnvironment' ? 'fromEnvironment' : 'useBundled';
}

function readTraceLevel(inspect: SettingInspector, isTrusted: boolean): TraceLevel {
  const inspected = inspect<unknown>('trace.server');
  const candidate = isTrusted
    ? (inspected?.workspaceFolderValue ??
      inspected?.workspaceValue ??
      inspected?.globalValue ??
      inspected?.defaultValue)
    : (inspected?.globalValue ?? inspected?.defaultValue);

  if (candidate === 'messages' || candidate === 'verbose' || candidate === 'off') {
    return candidate;
  }
  return 'off';
}

export function buildInitializationOptions(params: {
  readonly sortKeys: boolean;
  readonly minify: boolean;
  readonly strict: boolean;
  readonly structural: boolean;
  readonly lineWidth: unknown;
  readonly maxSize: unknown;
}): TvekInitializationOptions {
  const clampedWidth = clampInt(
    params.lineWidth,
    MIN_LINE_WIDTH,
    MAX_LINE_WIDTH,
    DEFAULT_LINE_WIDTH,
  );
  const clampedMaxSize = clampInt(
    params.maxSize,
    MIN_MAX_SIZE,
    MAX_MAX_SIZE,
    DEFAULT_MAX_SIZE,
  );

  return {
    sortKeys: params.sortKeys,
    minify: params.minify,
    allowComments: !params.strict,
    strict: params.strict,
    structural: params.structural,
    lineWidth: params.structural ? 0 : clampedWidth,
    maxSize: clampedMaxSize,
  };
}

export function resolveConfig(
  inspect: SettingInspector,
  isTrusted: boolean,
): ResolvedConfig {
  const enable = readBoolean(inspect, 'enable', isTrusted, true);
  const sortKeys = readBoolean(inspect, 'sortKeys', isTrusted, false);
  const strict = readBoolean(inspect, 'strict', isTrusted, false);
  const structural = readBoolean(inspect, 'structural', isTrusted, false);
  const minify = readBoolean(inspect, 'minify', isTrusted, false);
  const lineWidth = readNumber(
    inspect,
    'lineWidth',
    isTrusted,
    MIN_LINE_WIDTH,
    MAX_LINE_WIDTH,
    DEFAULT_LINE_WIDTH,
  );
  const maxSize = readNumber(
    inspect,
    'maxSize',
    isTrusted,
    MIN_MAX_SIZE,
    MAX_MAX_SIZE,
    DEFAULT_MAX_SIZE,
  );

  return {
    enable,
    path: readCustomPath(inspect, isTrusted),
    importStrategy: readImportStrategy(inspect, isTrusted),
    traceServer: readTraceLevel(inspect, isTrusted),
    initOptions: buildInitializationOptions({
      sortKeys,
      minify,
      strict,
      structural,
      lineWidth,
      maxSize,
    }),
  };
}

export function configsEqual(a: ResolvedConfig, b: ResolvedConfig): boolean {
  return (
    a.enable === b.enable &&
    a.path === b.path &&
    a.importStrategy === b.importStrategy &&
    a.traceServer === b.traceServer &&
    a.initOptions.sortKeys === b.initOptions.sortKeys &&
    a.initOptions.minify === b.initOptions.minify &&
    a.initOptions.allowComments === b.initOptions.allowComments &&
    a.initOptions.strict === b.initOptions.strict &&
    a.initOptions.structural === b.initOptions.structural &&
    a.initOptions.lineWidth === b.initOptions.lineWidth &&
    a.initOptions.maxSize === b.initOptions.maxSize
  );
}
