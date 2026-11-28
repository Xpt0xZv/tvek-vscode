import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildInitializationOptions,
  clampInt,
  configsEqual,
  resolveConfig,
} from '../../src/config.js';
import {
  DEFAULT_LINE_WIDTH,
  DEFAULT_MAX_SIZE,
  MAX_LINE_WIDTH,
  MAX_MAX_SIZE,
  MIN_LINE_WIDTH,
  MIN_MAX_SIZE,
  type InspectedSetting,
  type SettingInspector,
} from '../../src/types.js';

function makeInspector(
  map: Record<string, InspectedSetting<unknown>>,
): SettingInspector {
  return <T>(key: string) => map[key] as InspectedSetting<T> | undefined;
}

describe('config resolution & Workspace Trust filtering', () => {
  it('applies documented defaults when no settings are customized', () => {
    const cfg = resolveConfig(makeInspector({}), true);
    assert.equal(cfg.enable, true);
    assert.equal(cfg.path, null);
    assert.equal(cfg.importStrategy, 'useBundled');
    assert.equal(cfg.traceServer, 'off');
    assert.deepEqual(cfg.initOptions, {
      sortKeys: false,
      minify: false,
      allowComments: true,
      strict: false,
      structural: false,
      lineWidth: 80,
      maxSize: 104_857_600,
    });
  });

  it('honors workspaceFolderValue > workspaceValue > globalValue > defaultValue in trusted workspaces', () => {
    const inspect = makeInspector({
      path: {
        defaultValue: null,
        globalValue: '/usr/local/bin/tvek',
        workspaceValue: './tools/tvek',
        workspaceFolderValue: '  ./folder-tools/tvek  ',
      },
      importStrategy: {
        globalValue: 'useBundled',
        workspaceValue: 'fromEnvironment',
      },
      sortKeys: {
        globalValue: false,
        workspaceValue: true,
      },
      lineWidth: {
        defaultValue: 80,
        globalValue: 90,
        workspaceValue: 100,
        workspaceFolderValue: 120,
      },
      'trace.server': {
        globalValue: 'off',
        workspaceValue: 'verbose',
      },
    });

    const cfg = resolveConfig(inspect, true);
    assert.equal(cfg.path, './folder-tools/tvek');
    assert.equal(cfg.importStrategy, 'fromEnvironment');
    assert.equal(cfg.traceServer, 'verbose');
    assert.equal(cfg.initOptions.sortKeys, true);
    assert.equal(cfg.initOptions.lineWidth, 120);
  });

  it('normalizes blank or non-string custom path and unknown enum values safely', () => {
    const blankCfg = resolveConfig(
      makeInspector({
        path: { workspaceValue: '   \t  ' },
        importStrategy: { workspaceValue: 'invalidStrategy' },
        'trace.server': { workspaceValue: 'debug-everything' },
        enable: { workspaceValue: 'false' },
      }),
      true,
    );
    assert.equal(blankCfg.path, null);
    assert.equal(blankCfg.importStrategy, 'useBundled');
    assert.equal(blankCfg.traceServer, 'off');
    assert.equal(blankCfg.enable, true);
  });

  it('strictly ignores ALL workspace/folder settings and forces path=null & importStrategy=useBundled when untrusted', () => {
    const inspect = makeInspector({
      enable: {
        defaultValue: true,
        globalValue: true,
        workspaceValue: false,
        workspaceFolderValue: false,
      },
      path: {
        defaultValue: null,
        globalValue: '/Users/alice/bin/tvek',
        workspaceValue: './malicious/tvek',
        workspaceFolderValue: './malicious/tvek2',
      },
      importStrategy: {
        defaultValue: 'useBundled',
        globalValue: 'fromEnvironment',
        workspaceValue: 'fromEnvironment',
        workspaceFolderValue: 'fromEnvironment',
      },
      sortKeys: {
        defaultValue: false,
        workspaceValue: true,
        workspaceFolderValue: true,
      },
      strict: {
        defaultValue: false,
        globalValue: true,
        workspaceValue: false,
        workspaceFolderValue: false,
      },
      structural: {
        defaultValue: false,
        workspaceValue: true,
        workspaceFolderValue: true,
      },
      minify: {
        defaultValue: false,
        workspaceValue: true,
        workspaceFolderValue: true,
      },
      lineWidth: {
        defaultValue: 80,
        globalValue: 100,
        workspaceValue: 12,
        workspaceFolderValue: 16,
      },
      maxSize: {
        defaultValue: 104_857_600,
        workspaceValue: 64,
        workspaceFolderValue: 32,
      },
      'trace.server': {
        defaultValue: 'off',
        globalValue: 'messages',
        workspaceValue: 'verbose',
        workspaceFolderValue: 'verbose',
      },
    });

    const cfg = resolveConfig(inspect, false);
    assert.equal(cfg.enable, true);
    assert.equal(cfg.path, null);
    assert.equal(cfg.importStrategy, 'useBundled');
    assert.equal(cfg.traceServer, 'messages');
    assert.deepEqual(cfg.initOptions, {
      sortKeys: false,
      minify: false,
      allowComments: false,
      strict: true,
      structural: false,
      lineWidth: 100,
      maxSize: 104_857_600,
    });
  });

  it('enforces strict -> allowComments=false and structural -> lineWidth=0 invariants', () => {
    const strictAndStructural = buildInitializationOptions({
      sortKeys: true,
      minify: false,
      strict: true,
      structural: true,
      lineWidth: 4096,
      maxSize: 65_536,
    });

    assert.equal(strictAndStructural.strict, true);
    assert.equal(strictAndStructural.allowComments, false);
    assert.equal(strictAndStructural.structural, true);
    assert.equal(strictAndStructural.lineWidth, 0);
    assert.equal(strictAndStructural.maxSize, 65_536);

    const relaxed = buildInitializationOptions({
      sortKeys: false,
      minify: true,
      strict: false,
      structural: false,
      lineWidth: 120,
      maxSize: 1024,
    });
    assert.equal(relaxed.strict, false);
    assert.equal(relaxed.allowComments, true);
    assert.equal(relaxed.structural, false);
    assert.equal(relaxed.lineWidth, 120);
    assert.equal(relaxed.minify, true);
  });

  it('clamps degenerate, boundary, float, and non-finite lineWidth and maxSize inputs', () => {
    // lineWidth bounds: [0, 4096], fallback 80
    assert.equal(clampInt(0, MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH), 0);
    assert.equal(clampInt(4096, MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH), 4096);
    assert.equal(clampInt(-1, MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH), 0);
    assert.equal(clampInt(-999_999, MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH), 0);
    assert.equal(clampInt(4097, MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH), 4096);
    assert.equal(clampInt(999_999, MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH), 4096);
    assert.equal(clampInt(88.99, MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH), 88);
    assert.equal(clampInt(0.75, MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH), 0);
    assert.equal(clampInt(Number.NaN, MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH), 80);
    assert.equal(
      clampInt(Number.POSITIVE_INFINITY, MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH),
      80,
    );
    assert.equal(
      clampInt(Number.NEGATIVE_INFINITY, MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH),
      80,
    );
    assert.equal(clampInt('120', MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH), 80);
    assert.equal(clampInt(null, MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH), 80);
    assert.equal(clampInt(undefined, MIN_LINE_WIDTH, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH), 80);

    // maxSize bounds: [1, 104_857_600], fallback 104_857_600
    assert.equal(clampInt(1, MIN_MAX_SIZE, MAX_MAX_SIZE, DEFAULT_MAX_SIZE), 1);
    assert.equal(
      clampInt(104_857_600, MIN_MAX_SIZE, MAX_MAX_SIZE, DEFAULT_MAX_SIZE),
      104_857_600,
    );
    assert.equal(clampInt(0, MIN_MAX_SIZE, MAX_MAX_SIZE, DEFAULT_MAX_SIZE), 1);
    assert.equal(clampInt(-1, MIN_MAX_SIZE, MAX_MAX_SIZE, DEFAULT_MAX_SIZE), 1);
    assert.equal(clampInt(-0.5, MIN_MAX_SIZE, MAX_MAX_SIZE, DEFAULT_MAX_SIZE), 1);
    assert.equal(
      clampInt(104_857_601, MIN_MAX_SIZE, MAX_MAX_SIZE, DEFAULT_MAX_SIZE),
      104_857_600,
    );
    assert.equal(
      clampInt(Number.MAX_SAFE_INTEGER, MIN_MAX_SIZE, MAX_MAX_SIZE, DEFAULT_MAX_SIZE),
      104_857_600,
    );
    assert.equal(
      clampInt(Number.NaN, MIN_MAX_SIZE, MAX_MAX_SIZE, DEFAULT_MAX_SIZE),
      104_857_600,
    );
    assert.equal(
      clampInt(Number.POSITIVE_INFINITY, MIN_MAX_SIZE, MAX_MAX_SIZE, DEFAULT_MAX_SIZE),
      104_857_600,
    );
    assert.equal(clampInt(4096.8, MIN_MAX_SIZE, MAX_MAX_SIZE, DEFAULT_MAX_SIZE), 4096);

    const opts = buildInitializationOptions({
      sortKeys: false,
      minify: false,
      strict: false,
      structural: false,
      lineWidth: 9999,
      maxSize: 0,
    });
    assert.equal(opts.lineWidth, 4096);
    assert.equal(opts.maxSize, 1);

    const nanOpts = buildInitializationOptions({
      sortKeys: false,
      minify: false,
      strict: false,
      structural: false,
      lineWidth: Number.NaN,
      maxSize: Number.NaN,
    });
    assert.equal(nanOpts.lineWidth, 80);
    assert.equal(nanOpts.maxSize, 104_857_600);
  });

  it('compares every field accurately via configsEqual', () => {
    const base = resolveConfig(makeInspector({}), true);
    const same = resolveConfig(makeInspector({}), true);
    assert.equal(configsEqual(base, same), true);

    assert.equal(
      configsEqual(base, { ...base, enable: false }),
      false,
    );
    assert.equal(
      configsEqual(base, { ...base, path: '/custom/tvek' }),
      false,
    );
    assert.equal(
      configsEqual(base, { ...base, importStrategy: 'fromEnvironment' }),
      false,
    );
    assert.equal(
      configsEqual(base, { ...base, traceServer: 'verbose' }),
      false,
    );
    assert.equal(
      configsEqual(base, {
        ...base,
        initOptions: { ...base.initOptions, maxSize: 2048 },
      }),
      false,
    );
  });
});
