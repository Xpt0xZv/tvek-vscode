import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

interface JsonRpcMessage {
  readonly jsonrpc: string;
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function startLspSession(maxSizeArg = '4096') {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const mockPath = path.join(repoRoot, 'test', 'fixtures', 'mock-tvek-lsp.mjs');

  const proc = spawn(process.execPath, [mockPath, 'server', '--max-size', maxSizeArg], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });

  let buffer = Buffer.alloc(0);
  const waiters = new Map<number, (msg: JsonRpcMessage) => void>();
  const notifications: JsonRpcMessage[] = [];
  const notificationListeners: Array<(msg: JsonRpcMessage) => void> = [];

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        break;
      }
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number.parseInt(match[1]!, 10);
      if (buffer.length < headerEnd + 4 + len) {
        break;
      }
      const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      buffer = buffer.subarray(headerEnd + 4 + len);

      const parsed = JSON.parse(body) as JsonRpcMessage;
      if (typeof parsed.id === 'number') {
        const waiter = waiters.get(parsed.id);
        if (waiter) {
          waiters.delete(parsed.id);
          waiter(parsed);
        }
      } else if (parsed.method) {
        notifications.push(parsed);
        for (const listener of [...notificationListeners]) {
          listener(parsed);
        }
      }
    }
  });

  let nextId = 1;

  const sendRaw = (obj: Record<string, unknown>, chunkSize?: number) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    const frame = Buffer.concat([header, body]);
    if (chunkSize && chunkSize > 0) {
      for (let offset = 0; offset < frame.length; offset += chunkSize) {
        proc.stdin.write(frame.subarray(offset, offset + chunkSize));
      }
    } else {
      proc.stdin.write(frame);
    }
  };

  const request = (
    method: string,
    params?: unknown,
    chunkSize?: number,
  ): Promise<JsonRpcMessage> => {
    const id = nextId++;
    return new Promise((resolve) => {
      waiters.set(id, resolve);
      sendRaw({ jsonrpc: '2.0', id, method, params }, chunkSize);
    });
  };

  const notify = (method: string, params?: unknown, chunkSize?: number): void => {
    sendRaw({ jsonrpc: '2.0', method, params }, chunkSize);
  };

  const waitForNotification = (
    predicate: (msg: JsonRpcMessage) => boolean,
  ): Promise<JsonRpcMessage> => {
    const existing = notifications.find(predicate);
    if (existing) {
      notifications.splice(notifications.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      const listener = (msg: JsonRpcMessage) => {
        if (predicate(msg)) {
          const idx = notificationListeners.indexOf(listener);
          if (idx !== -1) {
            notificationListeners.splice(idx, 1);
          }
          const nIdx = notifications.indexOf(msg);
          if (nIdx !== -1) {
            notifications.splice(nIdx, 1);
          }
          resolve(msg);
        }
      };
      notificationListeners.push(listener);
    });
  };

  return { proc, request, notify, waitForNotification };
}

describe('mock-tvek-lsp stdio JSON-RPC 2.0 protocol compliance', () => {
  it('handles initialize, diagnostics, formatting, fixAll, -32601 didChangeConfiguration, and clean shutdown', async () => {
    const session = startLspSession();

    try {
      // Rejects requests sent prior to initialize with -32002 ServerNotInitialized
      const preInit = await session.request('textDocument/formatting', {
        textDocument: { uri: 'file:///workspace/early.json' },
      });
      assert.equal(preInit.error?.code, -32002);

      const initRes = await session.request('initialize', {
        processId: process.pid,
        rootUri: null,
        capabilities: {},
        initializationOptions: {
          sortKeys: true,
          minify: false,
          allowComments: false,
          strict: true,
          structural: false,
          lineWidth: 80,
          maxSize: 4096,
        },
      });
      assert.equal(initRes.error, undefined);
      session.notify('initialized', {});

      // Rejects workspace/didChangeConfiguration with -32601 MethodNotFound
      const cfgRes = await session.request('workspace/didChangeConfiguration', {
        settings: {},
      });
      assert.equal(cfgRes.error?.code, -32601);

      const uri = 'file:///workspace/sample.json';
      session.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: 'json',
          version: 1,
          text: '// disallowed comment\n{"b": 1, "a": 2,}\n',
        },
      });

      const openDiag = await session.waitForNotification(
        (m) => m.method === 'textDocument/publishDiagnostics',
      );
      const diagList = (openDiag.params?.diagnostics ?? []) as Array<{ code: string }>;
      assert.deepEqual(
        diagList.map((d) => d.code).sort(),
        ['disallowed-comment', 'trailing-comma'],
      );

      const actionsRes = await session.request('textDocument/codeAction', {
        textDocument: { uri },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 2, character: 0 },
        },
        context: {
          diagnostics: diagList,
          only: ['source.fixAll.tvek'],
        },
      });
      const actions = actionsRes.result as Array<{
        kind: string;
        edit: { changes: Record<string, Array<{ newText: string }>> };
      }>;
      assert.equal(actions.length, 1);
      assert.equal(actions[0]?.kind, 'source.fixAll.tvek');
      const fixedText = actions[0]?.edit.changes[uri]?.[0]?.newText ?? '';
      assert.ok(fixedText.indexOf('"a"') < fixedText.indexOf('"b"'));
      assert.ok(!fixedText.includes('//'));

      // didClose clears diagnostics
      session.notify('textDocument/didClose', { textDocument: { uri } });
      const closeDiag = await session.waitForNotification(
        (m) => m.method === 'textDocument/publishDiagnostics',
      );
      assert.deepEqual(closeDiag.params?.diagnostics, []);

      const shutdownRes = await session.request('shutdown');
      assert.equal(shutdownRes.result, null);

      const exitPromise = new Promise<number | null>((resolve) => {
        session.proc.once('exit', (code) => resolve(code));
      });
      session.notify('exit');
      const exitCode = await exitPromise;
      assert.equal(exitCode, 0);
    } finally {
      if (!session.proc.killed && session.proc.exitCode === null) {
        session.proc.kill();
      }
    }
  });

  it('handles fragmented multi-byte UTF-8 frames, structural formatting, and maxSize enforcement', async () => {
    const session = startLspSession('128');

    try {
      await session.request('initialize', {
        processId: process.pid,
        rootUri: null,
        capabilities: {},
        initializationOptions: {
          sortKeys: false,
          minify: false,
          allowComments: true,
          strict: false,
          structural: true,
          lineWidth: 0,
          maxSize: 128,
        },
      });
      session.notify('initialized', {});

      // Fragmented 7-byte chunks with emoji grapheme clusters + RTL text
      const unicodeUri = 'file:///workspace/unicode.json';
      session.notify(
        'textDocument/didOpen',
        {
          textDocument: {
            uri: unicodeUri,
            languageId: 'json',
            version: 1,
            text: '{"emoji":"👨‍👩‍👧‍👦🚀","arr":[1,2]}',
          },
        },
        7,
      );

      const unicodeDiag = await session.waitForNotification(
        (m) =>
          m.method === 'textDocument/publishDiagnostics' &&
          m.params?.uri === unicodeUri,
      );
      assert.deepEqual(unicodeDiag.params?.diagnostics, []);

      const formatRes = await session.request(
        'textDocument/formatting',
        {
          textDocument: { uri: unicodeUri },
          options: { tabSize: 2, insertSpaces: true },
        },
        9,
      );
      const edits = formatRes.result as Array<{ newText: string }>;
      assert.equal(edits.length, 1);
      assert.ok(
        edits[0]?.newText.includes('[\n    1,\n    2\n  ]'),
        `Expected structural array expansion, got:\n${edits[0]?.newText}`,
      );

      // Oversized payload > 128 bytes triggers max-size diagnostic
      const bigUri = 'file:///workspace/oversized.json';
      session.notify('textDocument/didOpen', {
        textDocument: {
          uri: bigUri,
          languageId: 'json',
          version: 1,
          text: JSON.stringify({ payload: 'x'.repeat(200) }),
        },
      });
      const bigDiag = await session.waitForNotification(
        (m) =>
          m.method === 'textDocument/publishDiagnostics' &&
          m.params?.uri === bigUri,
      );
      const codes = (
        (bigDiag.params?.diagnostics ?? []) as Array<{ code: string }>
      ).map((d) => d.code);
      assert.deepEqual(codes, ['max-size']);

      await session.request('shutdown');
      const exitPromise = new Promise<number | null>((resolve) => {
        session.proc.once('exit', (code) => resolve(code));
      });
      session.notify('exit');
      assert.equal(await exitPromise, 0);
    } finally {
      if (!session.proc.killed && session.proc.exitCode === null) {
        session.proc.kill();
      }
    }
  });

  it('rejects unknown CLI flags such as --stdio with exit code 2', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const mockPath = path.join(repoRoot, 'test', 'fixtures', 'mock-tvek-lsp.mjs');
    const proc = spawn(process.execPath, [mockPath, 'server', '--max-size', '4096', '--stdio'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    const code = await new Promise<number | null>((resolve) => proc.once('exit', resolve));
    assert.equal(code, 2);
    assert.match(stderr, /Unknown option '--stdio'/);
  });
});
