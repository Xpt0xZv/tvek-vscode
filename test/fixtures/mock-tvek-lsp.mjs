import process from 'node:process';

const VERSION = '0.1.4';

const argv = process.argv.slice(2);
if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V' || argv[0] === '-v')) {
  process.stdout.write(`tvek ${VERSION}\n`);
  process.exit(0);
}

const isServerMode = argv[0] === 'server' || argv.includes('--lsp');
if (!isServerMode) {
  process.stderr.write(`Usage: tvek server [--max-size <BYTES>] | tvek --version\n`);
  process.exit(2);
}

let cliMaxSize = 104_857_600;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if ((i === 0 && arg === 'server') || arg === '--lsp') {
    continue;
  }
  if (arg === '--max-size' && argv[i + 1] && !argv[i + 1].startsWith('-')) {
    const parsed = Number.parseInt(argv[i + 1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      cliMaxSize = parsed;
    }
    i += 1;
  } else if (arg?.startsWith('--max-size=')) {
    const parsed = Number.parseInt(arg.slice('--max-size='.length), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      cliMaxSize = parsed;
    }
  } else {
    process.stderr.write(
      `error: Unknown option '${arg}'\n\nRun 'tvek --help' for usage information.\n`,
    );
    process.exit(2);
  }
}

let serverConfig = {
  sortKeys: false,
  minify: false,
  allowComments: true,
  strict: false,
  structural: false,
  lineWidth: 80,
  maxSize: cliMaxSize,
};

let initialized = false;
let shuttingDown = false;
const documents = new Map();

function sendMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  process.stdout.write(Buffer.concat([header, body]));
}

function sendResponse(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function sendNotification(method, params) {
  sendMessage({ jsonrpc: '2.0', method, params });
}

function buildLineOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function offsetToPosition(lineOffsets, offset) {
  let low = 0;
  let high = lineOffsets.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (lineOffsets[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const line = Math.max(0, high);
  const character = offset - lineOffsets[line];
  return { line, character };
}

function fullDocumentRange(text) {
  const lineOffsets = buildLineOffsets(text);
  return {
    start: { line: 0, character: 0 },
    end: offsetToPosition(lineOffsets, text.length),
  };
}

/**
 * Lexes JSON/JSONC into tokens while detecting trailing commas, single-quoted strings,
 * unquoted object keys, and comments, producing diagnostics + optional repaired JSON text.
 */
function analyzeJsonDocument(text, cfg) {
  const diagnostics = [];
  const lineOffsets = buildLineOffsets(text);

  const byteLen = Buffer.byteLength(text, 'utf8');
  if (byteLen > cfg.maxSize) {
    diagnostics.push({
      range: fullDocumentRange(text),
      severity: 1,
      source: 'tvek',
      code: 'max-size',
      message: `Document size (${byteLen} bytes) exceeds maximum allowed size (${cfg.maxSize} bytes).`,
    });
    return { diagnostics, repairedText: null, strippedForParse: null };
  }

  const tokens = [];
  const patches = [];
  let i = 0;
  const len = text.length;

  const makeRange = (startOff, endOff) => ({
    start: offsetToPosition(lineOffsets, startOff),
    end: offsetToPosition(lineOffsets, Math.max(startOff, endOff)),
  });

  while (i < len) {
    const ch = text[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }

    // Line comment
    if (ch === '/' && text[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < len && text[i] !== '\n' && text[i] !== '\r') {
        i += 1;
      }
      if (!cfg.allowComments) {
        diagnostics.push({
          range: makeRange(start, i),
          severity: 1,
          source: 'tvek',
          code: 'disallowed-comment',
          message: 'Comments are not allowed when strict JSON mode is enabled.',
        });
      }
      patches.push({ start, end: i, replacement: '', isFix: !cfg.allowComments });
      continue;
    }

    // Block comment
    if (ch === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      if (i < len) {
        i += 2;
      } else {
        diagnostics.push({
          range: makeRange(start, len),
          severity: 1,
          source: 'tvek',
          code: 'unterminated-comment',
          message: 'Unterminated block comment.',
        });
      }
      if (!cfg.allowComments) {
        diagnostics.push({
          range: makeRange(start, i),
          severity: 1,
          source: 'tvek',
          code: 'disallowed-comment',
          message: 'Comments are not allowed when strict JSON mode is enabled.',
        });
      }
      patches.push({ start, end: i, replacement: ' ', isFix: !cfg.allowComments });
      continue;
    }

    // Double-quoted string
    if (ch === '"') {
      const start = i;
      i += 1;
      let terminated = false;
      while (i < len) {
        const c = text[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '"') {
          i += 1;
          terminated = true;
          break;
        }
        if (c === '\n' || c === '\r') {
          break;
        }
        i += 1;
      }
      if (!terminated) {
        diagnostics.push({
          range: makeRange(start, i),
          severity: 1,
          source: 'tvek',
          code: 'unterminated-string',
          message: 'Unterminated string literal.',
        });
      }
      tokens.push({ type: 'string', start, end: i, raw: text.slice(start, i) });
      continue;
    }

    // Single-quoted string (auto-fixable)
    if (ch === "'") {
      const start = i;
      i += 1;
      let inner = '';
      let terminated = false;
      while (i < len) {
        const c = text[i];
        if (c === '\\' && i + 1 < len) {
          const next = text[i + 1];
          if (next === "'") {
            inner += "'";
          } else {
            inner += '\\' + next;
          }
          i += 2;
          continue;
        }
        if (c === "'") {
          i += 1;
          terminated = true;
          break;
        }
        if (c === '"') {
          inner += '\\"';
          i += 1;
          continue;
        }
        if (c === '\n' || c === '\r') {
          break;
        }
        inner += c;
        i += 1;
      }
      diagnostics.push({
        range: makeRange(start, i),
        severity: 1,
        source: 'tvek',
        code: 'single-quoted-string',
        message: 'Single-quoted strings are not valid RFC 8259 JSON.',
      });
      if (terminated) {
        const replacement = `"${inner}"`;
        patches.push({ start, end: i, replacement, isFix: true });
      }
      tokens.push({ type: 'string', start, end: i, raw: `"${inner}"` });
      continue;
    }

    // Structural punctuation
    if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ':' || ch === ',') {
      tokens.push({ type: ch, start: i, end: i + 1, raw: ch });
      i += 1;
      continue;
    }

    // Numbers, booleans, null, or unquoted keys
    const start = i;
    while (
      i < len &&
      !' \t\r\n{}[]:,"\'/'.includes(text[i])
    ) {
      i += 1;
    }
    const word = text.slice(start, i);
    tokens.push({ type: 'atom', start, end: i, raw: word });
  }

  // Inspect token stream for trailing commas and unquoted object keys
  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    const next = tokens[idx + 1];

    if (tok.type === ',' && next && (next.type === '}' || next.type === ']')) {
      diagnostics.push({
        range: makeRange(tok.start, tok.end),
        severity: 1,
        source: 'tvek',
        code: 'trailing-comma',
        message: 'Trailing comma is not allowed in JSON.',
      });
      patches.push({ start: tok.start, end: tok.end, replacement: '', isFix: true });
    }

    if (
      tok.type === 'atom' &&
      next &&
      next.type === ':' &&
      idx > 0 &&
      (tokens[idx - 1].type === '{' || tokens[idx - 1].type === ',') &&
      /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(tok.raw)
    ) {
      diagnostics.push({
        range: makeRange(tok.start, tok.end),
        severity: 1,
        source: 'tvek',
        code: 'unquoted-key',
        message: `Unquoted object key "${tok.raw}" is not valid JSON.`,
      });
      patches.push({
        start: tok.start,
        end: tok.end,
        replacement: JSON.stringify(tok.raw),
        isFix: true,
      });
    }
  }

  // Apply non-fix comment-stripping patches to validate clean JSONC
  const applyPatchList = (onlyComments) => {
    const selected = onlyComments ? patches.filter((p) => !p.isFix) : patches;
    if (selected.length === 0) {
      return text;
    }
    const sorted = [...selected].sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const p of sorted) {
      if (p.start < cursor) {
        continue;
      }
      out += text.slice(cursor, p.start) + p.replacement;
      cursor = p.end;
    }
    out += text.slice(cursor);
    return out;
  };

  const commentStripped = cfg.allowComments ? applyPatchList(true) : text;
  if (diagnostics.length === 0) {
    try {
      JSON.parse(commentStripped);
      return {
        diagnostics: [],
        repairedText: null,
        strippedForParse: commentStripped,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid JSON syntax.';
      diagnostics.push({
        range: makeRange(0, Math.min(len, 1)),
        severity: 1,
        source: 'tvek',
        code: 'syntax-error',
        message: msg,
      });
      return { diagnostics, repairedText: null, strippedForParse: null };
    }
  }

  // Check if applying recorded auto-fixes produces valid JSON
  const candidateFixed = applyPatchList(false);
  let repairedValue;
  try {
    repairedValue = JSON.parse(candidateFixed);
  } catch {
    return { diagnostics, repairedText: null, strippedForParse: null };
  }

  const formattedFixed = formatJsonValue(repairedValue, cfg, {
    insertSpaces: true,
    tabSize: 2,
  });

  return {
    diagnostics,
    repairedText: formattedFixed,
    strippedForParse: null,
  };
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const k of keys) {
      sorted[k] = sortKeysDeep(value[k]);
    }
    return sorted;
  }
  return value;
}

function isPrimitiveJson(value) {
  return (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  );
}

function formatJsonValue(rawValue, cfg, formattingOptions) {
  const prepared = cfg.sortKeys ? sortKeysDeep(rawValue) : rawValue;

  if (cfg.minify) {
    return JSON.stringify(prepared);
  }

  const rawTabSize =
    typeof formattingOptions?.tabSize === 'number' &&
    Number.isFinite(formattingOptions.tabSize)
      ? Math.max(1, Math.min(64, Math.trunc(formattingOptions.tabSize)))
      : 2;
  const insertSpaces = formattingOptions?.insertSpaces !== false;
  const indentUnit = insertSpaces ? ' '.repeat(rawTabSize) : '\t';
  const visualUnitWidth = rawTabSize;
  const effectiveLineWidth = cfg.structural ? 0 : cfg.lineWidth;

  const render = (val, depth) => {
    if (isPrimitiveJson(val)) {
      return JSON.stringify(val);
    }

    const currentIndent = indentUnit.repeat(depth);
    const childIndent = indentUnit.repeat(depth + 1);

    if (Array.isArray(val)) {
      if (val.length === 0) {
        return '[]';
      }

      if (effectiveLineWidth > 0 && val.every(isPrimitiveJson)) {
        const inline = `[${val.map((item) => JSON.stringify(item)).join(', ')}]`;
        const estimatedCols = depth * visualUnitWidth + inline.length;
        if (estimatedCols <= effectiveLineWidth) {
          return inline;
        }
      }

      const items = val.map((item) => `${childIndent}${render(item, depth + 1)}`);
      return `[\n${items.join(',\n')}\n${currentIndent}]`;
    }

    const keys = Object.keys(val);
    if (keys.length === 0) {
      return '{}';
    }

    const entries = keys.map(
      (k) => `${childIndent}${JSON.stringify(k)}: ${render(val[k], depth + 1)}`,
    );
    return `{\n${entries.join(',\n')}\n${currentIndent}}`;
  };

  return `${render(prepared, 0)}\n`;
}

function matchesCodeActionFilter(onlyFilters, actionKind) {
  if (!Array.isArray(onlyFilters) || onlyFilters.length === 0) {
    return true;
  }
  return onlyFilters.some(
    (filter) =>
      actionKind === filter ||
      actionKind.startsWith(`${filter}.`) ||
      filter.startsWith(`${actionKind}.`),
  );
}

function updateDocument(uri, text) {
  const analysis = analyzeJsonDocument(text, serverConfig);
  documents.set(uri, { text, analysis });
  sendNotification('textDocument/publishDiagnostics', {
    uri,
    diagnostics: analysis.diagnostics,
  });
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    const rawOpts = params?.initializationOptions ?? {};
    const strict = Boolean(rawOpts.strict);
    const allowComments = strict
      ? false
      : rawOpts.allowComments === undefined
        ? true
        : Boolean(rawOpts.allowComments);
    const structural = Boolean(rawOpts.structural);
    const rawLineWidth =
      typeof rawOpts.lineWidth === 'number' && Number.isFinite(rawOpts.lineWidth)
        ? Math.max(0, Math.min(4096, Math.trunc(rawOpts.lineWidth)))
        : 80;
    const rawMaxSize =
      typeof rawOpts.maxSize === 'number' && Number.isFinite(rawOpts.maxSize)
        ? Math.max(1, Math.min(104_857_600, Math.trunc(rawOpts.maxSize)))
        : cliMaxSize;

    serverConfig = {
      sortKeys: Boolean(rawOpts.sortKeys),
      minify: Boolean(rawOpts.minify),
      allowComments,
      strict,
      structural,
      lineWidth: structural ? 0 : rawLineWidth,
      maxSize: Math.min(cliMaxSize, rawMaxSize),
    };
    initialized = true;

    sendResponse(id, {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: 1,
        },
        documentFormattingProvider: true,
        codeActionProvider: {
          codeActionKinds: ['quickfix', 'source.fixAll', 'source.fixAll.tvek'],
        },
      },
      serverInfo: {
        name: 'tvek',
        version: VERSION,
      },
    });
    return;
  }

  if (method === 'initialized' || method === '$/setTrace' || method === '$/cancelRequest') {
    return;
  }

  if (method === 'shutdown') {
    shuttingDown = true;
    if (id !== undefined) {
      sendResponse(id, null);
    }
    return;
  }

  if (method === 'exit') {
    process.exit(shuttingDown ? 0 : 1);
  }

  // Upstream `tvek server` explicitly rejects workspace/didChangeConfiguration with -32601.
  if (method === 'workspace/didChangeConfiguration') {
    if (id !== undefined) {
      sendError(id, -32601, 'Method not found: workspace/didChangeConfiguration');
    }
    return;
  }

  if (!initialized) {
    if (id !== undefined) {
      sendError(id, -32002, 'Server not initialized');
    }
    return;
  }

  if (method === 'textDocument/didOpen') {
    const doc = params?.textDocument;
    if (doc?.uri && typeof doc.text === 'string') {
      updateDocument(doc.uri, doc.text);
    }
    return;
  }

  if (method === 'textDocument/didChange') {
    const uri = params?.textDocument?.uri;
    const changes = params?.contentChanges;
    if (uri && Array.isArray(changes) && changes.length > 0) {
      const latest = changes[changes.length - 1];
      if (typeof latest?.text === 'string') {
        updateDocument(uri, latest.text);
      }
    }
    return;
  }

  if (method === 'textDocument/didClose') {
    const uri = params?.textDocument?.uri;
    if (uri) {
      documents.delete(uri);
      sendNotification('textDocument/publishDiagnostics', {
        uri,
        diagnostics: [],
      });
    }
    return;
  }

  if (method === 'textDocument/formatting') {
    const uri = params?.textDocument?.uri;
    const docState = uri ? documents.get(uri) : undefined;
    if (!docState || docState.analysis.strippedForParse === null) {
      sendResponse(id, []);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(docState.analysis.strippedForParse);
    } catch {
      sendResponse(id, []);
      return;
    }

    const formatted = formatJsonValue(parsed, serverConfig, params?.options);
    if (formatted === docState.text) {
      sendResponse(id, []);
      return;
    }

    sendResponse(id, [
      {
        range: fullDocumentRange(docState.text),
        newText: formatted,
      },
    ]);
    return;
  }

  if (method === 'textDocument/codeAction') {
    const uri = params?.textDocument?.uri;
    const docState = uri ? documents.get(uri) : undefined;
    if (!docState || docState.analysis.repairedText === null) {
      sendResponse(id, []);
      return;
    }

    const onlyFilters = params?.context?.only;
    const edit = {
      changes: {
        [uri]: [
          {
            range: fullDocumentRange(docState.text),
            newText: docState.analysis.repairedText,
          },
        ],
      },
    };

    const actions = [];
    if (matchesCodeActionFilter(onlyFilters, 'quickfix')) {
      actions.push({
        title: 'Fix JSON syntax issues (tvek)',
        kind: 'quickfix',
        isPreferred: true,
        diagnostics: docState.analysis.diagnostics,
        edit,
      });
    }
    if (matchesCodeActionFilter(onlyFilters, 'source.fixAll.tvek')) {
      actions.push({
        title: 'Fix all auto-fixable tvek issues',
        kind: 'source.fixAll.tvek',
        diagnostics: docState.analysis.diagnostics,
        edit,
      });
    }

    sendResponse(id, actions);
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

let receiveBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  receiveBuffer = Buffer.concat([receiveBuffer, chunk]);

  while (true) {
    const headerEnd = receiveBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      break;
    }

    const headerText = receiveBuffer.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (!match) {
      receiveBuffer = receiveBuffer.subarray(headerEnd + 4);
      continue;
    }

    const contentLength = Number.parseInt(match[1], 10);
    const totalFrameLength = headerEnd + 4 + contentLength;
    if (receiveBuffer.length < totalFrameLength) {
      break;
    }

    const jsonBytes = receiveBuffer.subarray(headerEnd + 4, totalFrameLength);
    receiveBuffer = receiveBuffer.subarray(totalFrameLength);

    let parsed;
    try {
      parsed = JSON.parse(jsonBytes.toString('utf8'));
    } catch {
      continue;
    }
    handleMessage(parsed);
  }
});

process.stdin.on('end', () => {
  process.exit(shuttingDown ? 0 : 1);
});
