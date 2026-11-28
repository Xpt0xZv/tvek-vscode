import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

export const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024; // 64 MiB
export const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024; // 128 MiB
export const DOWNLOAD_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 5;

export const TARGETS = Object.freeze({
  'win32-x64': Object.freeze({
    target: 'win32-x64',
    triple: 'x86_64-pc-windows-msvc',
    archive: 'tvek-x86_64-pc-windows-msvc.zip',
    entry: 'tvek-x86_64-pc-windows-msvc/tvek.exe',
    binaryName: 'tvek.exe',
    format: 'zip',
    isWindows: true,
  }),
  'win32-arm64': Object.freeze({
    target: 'win32-arm64',
    triple: 'aarch64-pc-windows-msvc',
    archive: 'tvek-aarch64-pc-windows-msvc.zip',
    entry: 'tvek-aarch64-pc-windows-msvc/tvek.exe',
    binaryName: 'tvek.exe',
    format: 'zip',
    isWindows: true,
  }),
  'darwin-x64': Object.freeze({
    target: 'darwin-x64',
    triple: 'x86_64-apple-darwin',
    archive: 'tvek-x86_64-apple-darwin.tar.gz',
    entry: 'tvek-x86_64-apple-darwin/tvek',
    binaryName: 'tvek',
    format: 'tar.gz',
    isWindows: false,
  }),
  'darwin-arm64': Object.freeze({
    target: 'darwin-arm64',
    triple: 'aarch64-apple-darwin',
    archive: 'tvek-aarch64-apple-darwin.tar.gz',
    entry: 'tvek-aarch64-apple-darwin/tvek',
    binaryName: 'tvek',
    format: 'tar.gz',
    isWindows: false,
  }),
  'linux-x64': Object.freeze({
    target: 'linux-x64',
    triple: 'x86_64-unknown-linux-gnu',
    archive: 'tvek-x86_64-unknown-linux-gnu.tar.gz',
    entry: 'tvek-x86_64-unknown-linux-gnu/tvek',
    binaryName: 'tvek',
    format: 'tar.gz',
    isWindows: false,
  }),
  'linux-arm64': Object.freeze({
    target: 'linux-arm64',
    triple: 'aarch64-unknown-linux-gnu',
    archive: 'tvek-aarch64-unknown-linux-gnu.tar.gz',
    entry: 'tvek-aarch64-unknown-linux-gnu/tvek',
    binaryName: 'tvek',
    format: 'tar.gz',
    isWindows: false,
  }),
  'alpine-x64': Object.freeze({
    target: 'alpine-x64',
    triple: 'x86_64-unknown-linux-musl',
    archive: 'tvek-x86_64-unknown-linux-musl.tar.gz',
    entry: 'tvek-x86_64-unknown-linux-musl/tvek',
    binaryName: 'tvek',
    format: 'tar.gz',
    isWindows: false,
  }),
});

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function detectAlpineLinux() {
  if (process.platform !== 'linux') {
    return false;
  }
  try {
    return fs.existsSync('/etc/alpine-release');
  } catch {
    return false;
  }
}

export function validateVersion(rawVersion) {
  if (typeof rawVersion !== 'string') {
    throw new Error('Invalid tvek version: expected string.');
  }
  const normalized = rawVersion.trim().replace(/^v/, '');
  if (!SEMVER_REGEX.test(normalized)) {
    throw new Error(
      `Invalid tvek SemVer version "${rawVersion}": expected X.Y.Z or X.Y.Z-prerelease.`,
    );
  }
  return normalized;
}

export function resolveVersion({
  cliVersion,
  envVersion = process.env.TVEK_VERSION,
  packageJsonPath = path.join(REPO_ROOT, 'package.json'),
} = {}) {
  if (cliVersion !== undefined && cliVersion !== null && cliVersion !== '') {
    return validateVersion(cliVersion);
  }
  if (envVersion !== undefined && envVersion !== null && envVersion.trim() !== '') {
    return validateVersion(envVersion);
  }
  if (fs.existsSync(packageJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (typeof pkg.tvekVersion === 'string' && pkg.tvekVersion.trim() !== '') {
      return validateVersion(pkg.tvekVersion);
    }
  }
  return '0.1.3';
}

export function resolveTarget(
  explicitTarget,
  platform = process.platform,
  arch = process.arch,
  isAlpine = detectAlpineLinux(),
) {
  if (explicitTarget) {
    const entry = TARGETS[explicitTarget];
    if (!entry) {
      throw new Error(
        `Unsupported target "${explicitTarget}". Supported targets: ${Object.keys(TARGETS).join(', ')}`,
      );
    }
    return entry;
  }

  let inferredKey;
  if (platform === 'linux' && isAlpine) {
    inferredKey = `alpine-${arch}`;
  } else {
    inferredKey = `${platform}-${arch}`;
  }

  const entry = TARGETS[inferredKey];
  if (!entry) {
    throw new Error(
      `Unsupported host platform/arch "${inferredKey}". Supported targets: ${Object.keys(TARGETS).join(', ')}`,
    );
  }
  return entry;
}

export function validateArchiveEntryPath(entryPath) {
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    throw new Error('Invalid archive entry path: empty path.');
  }
  if (entryPath.includes('\0')) {
    throw new Error('Unsafe archive entry path: null byte detected.');
  }
  if (entryPath.includes('\\')) {
    throw new Error(`Unsafe archive entry path "${entryPath}": backslashes are disallowed.`);
  }
  if (entryPath.startsWith('/')) {
    throw new Error(`Unsafe archive entry path "${entryPath}": leading slash is disallowed.`);
  }
  if (/^[A-Za-z]:/.test(entryPath)) {
    throw new Error(`Unsafe archive entry path "${entryPath}": Windows drive prefix is disallowed.`);
  }

  const trimmed = entryPath.endsWith('/') ? entryPath.slice(0, -1) : entryPath;
  if (trimmed.length === 0) {
    throw new Error(`Unsafe archive entry path "${entryPath}": root directory entry is disallowed.`);
  }

  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new Error(
        `Unsafe archive entry path "${entryPath}": path traversal or empty segment "${segment}" is disallowed.`,
      );
    }
  }
  return trimmed;
}

export function parseSha256Sums(content) {
  if (typeof content !== 'string') {
    throw new Error('SHA256SUMS content must be a string.');
  }
  const digests = new Map();
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    if (line.length > 4096) {
      throw new Error(`Malformed SHA256SUMS entry at line ${i + 1}: exceeds maximum line length.`);
    }
    const match = /^([0-9a-fA-F]{64})\s+\*?([^\s/\\]+)$/.exec(line);
    if (!match) {
      throw new Error(`Malformed SHA256SUMS entry at line ${i + 1}: "${line}"`);
    }
    const hash = match[1].toLowerCase();
    const filename = match[2];
    const existing = digests.get(filename);
    if (existing !== undefined && existing !== hash) {
      throw new Error(`Conflicting SHA-256 digests in SHA256SUMS for "${filename}".`);
    }
    digests.set(filename, hash);
  }

  if (digests.size === 0) {
    throw new Error('SHA256SUMS did not contain any valid digest entries.');
  }
  return digests;
}

export function verifySha256(buffer, expectedHex) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('verifySha256 expects a Buffer.');
  }
  if (typeof expectedHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(expectedHex)) {
    throw new Error(`Invalid expected SHA-256 hex digest: "${expectedHex}".`);
  }

  const actualDigest = crypto.createHash('sha256').update(buffer).digest();
  const expectedDigest = Buffer.from(expectedHex.toLowerCase(), 'hex');

  if (
    actualDigest.length !== expectedDigest.length ||
    !crypto.timingSafeEqual(actualDigest, expectedDigest)
  ) {
    throw new Error(
      `SHA-256 verification failed: expected ${expectedHex.toLowerCase()}, got ${actualDigest.toString('hex')}.`,
    );
  }
  return true;
}

function readTarString(buf, start, length) {
  const end = start + length;
  let nul = start;
  while (nul < end && buf[nul] !== 0) {
    nul++;
  }
  return buf.subarray(start, nul).toString('utf8');
}

function parseTarOctal(buf, start, length, fieldName) {
  const raw = readTarString(buf, start, length).trim();
  if (raw.length === 0) {
    return 0;
  }
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`Invalid octal value "${raw}" in tar header field "${fieldName}".`);
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Out-of-range octal value "${raw}" in tar header field "${fieldName}".`);
  }
  return value;
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) {
      return false;
    }
  }
  return true;
}

function verifyTarHeaderChecksum(header) {
  const expected = parseTarOctal(header, 148, 8, 'chksum');
  let unsignedSum = 0;
  let signedSum = 0;
  for (let i = 0; i < 512; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i];
    unsignedSum += byte;
    signedSum += byte > 127 ? byte - 256 : byte;
  }
  if (unsignedSum !== expected && signedSum !== expected) {
    throw new Error(
      `Corrupt tar header checksum: expected ${expected}, computed ${unsignedSum}.`,
    );
  }
}

function parsePaxRecords(buffer) {
  const records = new Map();
  let offset = 0;
  const text = buffer.toString('utf8');
  while (offset < text.length) {
    const spaceIdx = text.indexOf(' ', offset);
    if (spaceIdx === -1) {
      break;
    }
    const lenStr = text.slice(offset, spaceIdx);
    const recordByteLen = Number.parseInt(lenStr, 10);
    if (!Number.isSafeInteger(recordByteLen) || recordByteLen <= 0) {
      throw new Error(`Invalid PAX extended header record length: "${lenStr}".`);
    }
    const slice = buffer.subarray(
      Buffer.byteLength(text.slice(0, offset), 'utf8'),
      Buffer.byteLength(text.slice(0, offset), 'utf8') + recordByteLen,
    );
    const recordStr = slice.toString('utf8');
    const eqOffset = recordStr.indexOf('=');
    const spOffset = recordStr.indexOf(' ');
    if (spOffset !== -1 && eqOffset > spOffset) {
      const key = recordStr.slice(spOffset + 1, eqOffset);
      const val = recordStr.endsWith('\n')
        ? recordStr.slice(eqOffset + 1, -1)
        : recordStr.slice(eqOffset + 1);
      records.set(key, val);
    }
    offset += recordStr.length;
  }
  return records;
}

export function extractTarGzEntry(
  gzBuffer,
  expectedEntry,
  maxUncompressedBytes = MAX_UNCOMPRESSED_BYTES,
) {
  if (!Buffer.isBuffer(gzBuffer)) {
    throw new Error('extractTarGzEntry expects a Buffer.');
  }
  const normalizedTarget = validateArchiveEntryPath(expectedEntry);
  const tarBuffer = zlib.gunzipSync(gzBuffer, { maxOutputLength: maxUncompressedBytes });

  let offset = 0;
  let pendingPaxPath = null;
  let pendingLongName = null;
  let extracted = null;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      break;
    }

    verifyTarHeaderChecksum(header);

    const size = parseTarOctal(header, 124, 12, 'size');
    if (size > maxUncompressedBytes) {
      throw new Error(`Tar entry exceeds maximum allowed uncompressed size (${size} bytes).`);
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const paddedSize = Math.ceil(size / 512) * 512;
    const nextHeaderOffset = dataStart + paddedSize;

    if (dataEnd > tarBuffer.length || nextHeaderOffset > tarBuffer.length) {
      throw new Error('Truncated tar archive: entry payload exceeds archive length.');
    }

    const typeflagByte = header[156];
    const typeflag = typeflagByte === 0 ? '0' : String.fromCharCode(typeflagByte);

    if (typeflag === 'x') {
      const pax = parsePaxRecords(tarBuffer.subarray(dataStart, dataEnd));
      if (pax.has('path')) {
        pendingPaxPath = pax.get('path');
      }
      offset = nextHeaderOffset;
      continue;
    }

    if (typeflag === 'g') {
      offset = nextHeaderOffset;
      continue;
    }

    if (typeflag === 'L') {
      pendingLongName = readTarString(tarBuffer, dataStart, size);
      offset = nextHeaderOffset;
      continue;
    }

    if (
      typeflag === '1' ||
      typeflag === '2' ||
      typeflag === '3' ||
      typeflag === '4' ||
      typeflag === '6'
    ) {
      throw new Error(
        `Unsafe tar entry typeflag "${typeflag}" (links and special device nodes are forbidden).`,
      );
    }

    const magic = readTarString(header, 257, 6);
    const nameField = readTarString(header, 0, 100);
    const prefixField = magic.startsWith('ustar') ? readTarString(header, 345, 155) : '';
    const ustarPath = prefixField ? `${prefixField}/${nameField}` : nameField;

    const rawEntryPath = pendingPaxPath ?? pendingLongName ?? ustarPath;
    pendingPaxPath = null;
    pendingLongName = null;

    const normalizedEntryPath = validateArchiveEntryPath(rawEntryPath);

    if (typeflag === '0') {
      if (normalizedEntryPath === normalizedTarget) {
        if (extracted !== null) {
          throw new Error(`Duplicate binary entry "${normalizedTarget}" in tar archive.`);
        }
        extracted = Buffer.from(tarBuffer.subarray(dataStart, dataEnd));
      }
    } else if (typeflag !== '5') {
      throw new Error(`Unsupported tar entry typeflag "${typeflag}" for "${rawEntryPath}".`);
    }

    offset = nextHeaderOffset;
  }

  if (extracted === null) {
    throw new Error(`Expected binary entry "${normalizedTarget}" not found in tar.gz archive.`);
  }
  return extracted;
}

export function extractZipEntry(
  zipBuffer,
  expectedEntry,
  maxUncompressedBytes = MAX_UNCOMPRESSED_BYTES,
) {
  if (!Buffer.isBuffer(zipBuffer)) {
    throw new Error('extractZipEntry expects a Buffer.');
  }
  const normalizedTarget = validateArchiveEntryPath(expectedEntry);

  if (zipBuffer.length < 22) {
    throw new Error('Invalid zip archive: buffer shorter than End of Central Directory record.');
  }

  const minEocdOffset = Math.max(0, zipBuffer.length - 22 - 0xffff);
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= minEocdOffset; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      const commentLen = zipBuffer.readUInt16LE(i + 20);
      if (i + 22 + commentLen === zipBuffer.length) {
        eocdOffset = i;
        break;
      }
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid zip archive: End of Central Directory signature not found.');
  }

  const diskNumber = zipBuffer.readUInt16LE(eocdOffset + 4);
  const cdStartDisk = zipBuffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = zipBuffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || cdStartDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error('Unsupported multi-disk zip archive.');
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('Unsupported ZIP64 archive.');
  }
  if (cdOffset + cdSize > eocdOffset) {
    throw new Error('Corrupt zip archive: Central Directory bounds exceed EOCD offset.');
  }

  let cursor = cdOffset;
  let extracted = null;

  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > eocdOffset || zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Invalid Central Directory header at entry ${i}.`);
    }

    const flags = zipBuffer.readUInt16LE(cursor + 8);
    const compressionMethod = zipBuffer.readUInt16LE(cursor + 10);
    const expectedCrc32 = zipBuffer.readUInt32LE(cursor + 16);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(cursor + 24);
    const fileNameLen = zipBuffer.readUInt16LE(cursor + 28);
    const extraLen = zipBuffer.readUInt16LE(cursor + 30);
    const commentLen = zipBuffer.readUInt16LE(cursor + 32);
    const externalAttrs = zipBuffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);

    const headerEnd = cursor + 46 + fileNameLen + extraLen + commentLen;
    if (headerEnd > eocdOffset) {
      throw new Error(`Truncated Central Directory entry at index ${i}.`);
    }

    if ((flags & 0x01) !== 0) {
      throw new Error('Encrypted zip entries are not supported.');
    }

    const unixModeType = (externalAttrs >>> 16) & 0o170000;
    if (unixModeType === 0o120000) {
      throw new Error('Unsafe zip entry: symbolic links are forbidden.');
    }

    const rawName = zipBuffer.subarray(cursor + 46, cursor + 46 + fileNameLen).toString('utf8');
    const normalizedName = validateArchiveEntryPath(rawName);
    const isDirectory = rawName.endsWith('/') || unixModeType === 0o040000;

    if (!isDirectory && normalizedName === normalizedTarget) {
      if (extracted !== null) {
        throw new Error(`Duplicate binary entry "${normalizedTarget}" in zip archive.`);
      }
      if (uncompressedSize > maxUncompressedBytes) {
        throw new Error(
          `Zip entry "${rawName}" exceeds maximum uncompressed size (${uncompressedSize} bytes).`,
        );
      }
      if (
        localHeaderOffset + 30 > cdOffset ||
        zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50
      ) {
        throw new Error(`Invalid Local File Header for "${rawName}".`);
      }

      const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const dataEnd = dataStart + compressedSize;

      if (dataEnd > cdOffset) {
        throw new Error(`Zip entry "${rawName}" payload overflows Central Directory.`);
      }

      const compressedSlice = zipBuffer.subarray(dataStart, dataEnd);
      let payload;
      if (compressionMethod === 0) {
        payload = Buffer.from(compressedSlice);
      } else if (compressionMethod === 8) {
        payload = zlib.inflateRawSync(compressedSlice, {
          maxOutputLength: maxUncompressedBytes,
        });
      } else {
        throw new Error(
          `Unsupported zip compression method ${compressionMethod} for "${rawName}".`,
        );
      }

      if (payload.length !== uncompressedSize) {
        throw new Error(
          `Uncompressed size mismatch for "${rawName}": expected ${uncompressedSize}, got ${payload.length}.`,
        );
      }

      const actualCrc32 = computeCrc32(payload);
      if (actualCrc32 !== expectedCrc32) {
        throw new Error(
          `CRC-32 mismatch for "${rawName}": expected 0x${expectedCrc32.toString(16)}, got 0x${actualCrc32.toString(16)}.`,
        );
      }

      extracted = payload;
    }

    cursor = headerEnd;
  }

  if (extracted === null) {
    throw new Error(`Expected binary entry "${normalizedTarget}" not found in zip archive.`);
  }
  return extracted;
}

export function isAllowedDownloadUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return host === 'github.com' || host.endsWith('.githubusercontent.com');
}

export function downloadHttpsBuffer(
  rawUrl,
  {
    maxBytes = MAX_DOWNLOAD_BYTES,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
    maxRedirects = MAX_REDIRECTS,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const requestUrl = (currentUrl, redirectsRemaining) => {
      if (!isAllowedDownloadUrl(currentUrl)) {
        reject(
          new Error(
            `Blocked download URL "${currentUrl}": only HTTPS github.com and *.githubusercontent.com are permitted.`,
          ),
        );
        return;
      }

      const req = https.get(
        currentUrl,
        {
          minVersion: 'TLSv1.2',
          headers: {
            'User-Agent': 'tvek-vscode-binary-fetcher/0.1.0',
            Accept: 'application/octet-stream, text/plain, */*',
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;

          if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
            res.resume();
            if (redirectsRemaining <= 0) {
              reject(new Error(`Exceeded maximum redirect count (${maxRedirects}) for "${rawUrl}".`));
              return;
            }
            const location = res.headers.location;
            if (!location) {
              reject(new Error(`Redirect response (${status}) missing Location header.`));
              return;
            }
            const nextUrl = new URL(location, currentUrl).toString();
            requestUrl(nextUrl, redirectsRemaining - 1);
            return;
          }

          if (status !== 200) {
            res.resume();
            reject(new Error(`HTTP ${status} while fetching "${currentUrl}".`));
            return;
          }

          const contentLengthHeader = res.headers['content-length'];
          if (contentLengthHeader !== undefined) {
            const declaredLength = Number.parseInt(String(contentLengthHeader), 10);
            if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
              res.destroy();
              reject(
                new Error(
                  `Response Content-Length (${declaredLength} bytes) exceeds ceiling (${maxBytes} bytes).`,
                ),
              );
              return;
            }
          }

          const chunks = [];
          let totalBytes = 0;

          res.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
              res.destroy(
                new Error(`Download exceeded maximum allowed size (${maxBytes} bytes).`),
              );
              return;
            }
            chunks.push(chunk);
          });

          res.on('end', () => {
            resolve(Buffer.concat(chunks, totalBytes));
          });

          res.on('error', (err) => {
            reject(err);
          });
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`HTTPS request timed out after ${timeoutMs} ms: "${currentUrl}".`));
      });

      req.on('error', (err) => {
        reject(err);
      });
    };

    requestUrl(rawUrl, maxRedirects);
  });
}

function stageBinaryBufferAtomically(payload, outDir, targetInfo) {
  fs.mkdirSync(outDir, { recursive: true });

  const staleSibling = path.join(outDir, targetInfo.isWindows ? 'tvek' : 'tvek.exe');
  fs.rmSync(staleSibling, { force: true });

  const destPath = path.join(outDir, targetInfo.binaryName);
  const tmpName = `.${targetInfo.binaryName}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(outDir, tmpName);

  try {
    const fd = fs.openSync(tmpPath, 'wx', targetInfo.isWindows ? 0o666 : 0o755);
    try {
      fs.writeFileSync(fd, payload);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    if (!targetInfo.isWindows) {
      fs.chmodSync(tmpPath, 0o755);
    }

    fs.renameSync(tmpPath, destPath);

    if (!targetInfo.isWindows) {
      fs.chmodSync(destPath, 0o755);
    }
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }

  return destPath;
}

export async function fetchOrStageBinary({
  target,
  version,
  outDir = path.join(REPO_ROOT, 'bundled', 'bin'),
  localBin = process.env.TVEK_LOCAL_BIN,
  downloadFn = downloadHttpsBuffer,
} = {}) {
  const targetInfo = resolveTarget(target);

  if (typeof localBin === 'string' && localBin.trim() !== '') {
    const resolvedLocal = path.resolve(localBin.trim());
    let fd;
    try {
      fd = fs.openSync(resolvedLocal, fs.constants.O_RDONLY);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'EISDIR') {
        throw new Error(`TVEK_LOCAL_BIN is not a regular file: "${resolvedLocal}".`, {
          cause: err,
        });
      }
      throw new Error(`TVEK_LOCAL_BIN does not exist: "${resolvedLocal}".`, {
        cause: err,
      });
    }
    let payload;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) {
        throw new Error(`TVEK_LOCAL_BIN is not a regular file: "${resolvedLocal}".`);
      }
      if (stat.size === 0 || stat.size > MAX_UNCOMPRESSED_BYTES) {
        throw new Error(`TVEK_LOCAL_BIN has invalid file size (${stat.size} bytes).`);
      }
      payload = Buffer.allocUnsafe(stat.size);
      let totalRead = 0;
      while (totalRead < stat.size) {
        const bytesRead = fs.readSync(fd, payload, totalRead, stat.size - totalRead, totalRead);
        if (bytesRead === 0) {
          break;
        }
        totalRead += bytesRead;
      }
      if (totalRead !== stat.size) {
        throw new Error(
          `TVEK_LOCAL_BIN truncated during read: expected ${stat.size} bytes, got ${totalRead} bytes.`,
        );
      }
    } finally {
      fs.closeSync(fd);
    }
    const destPath = stageBinaryBufferAtomically(payload, outDir, targetInfo);
    return {
      destPath,
      target: targetInfo.target,
      version: 'local',
      source: 'local',
    };
  }

  const resolvedVer = resolveVersion({ cliVersion: version });
  const baseUrl = `https://github.com/Xpt0xZv/tvek/releases/download/v${resolvedVer}`;
  const sumsUrl = `${baseUrl}/SHA256SUMS`;
  const archiveUrl = `${baseUrl}/${targetInfo.archive}`;

  const [sumsBytes, archiveBytes] = await Promise.all([
    downloadFn(sumsUrl),
    downloadFn(archiveUrl),
  ]);

  const sumsMap = parseSha256Sums(sumsBytes.toString('utf8'));
  const expectedSha256 = sumsMap.get(targetInfo.archive);
  if (!expectedSha256) {
    throw new Error(
      `Archive "${targetInfo.archive}" was not listed in SHA256SUMS for v${resolvedVer}.`,
    );
  }

  verifySha256(archiveBytes, expectedSha256);

  const binaryBytes =
    targetInfo.format === 'zip'
      ? extractZipEntry(archiveBytes, targetInfo.entry)
      : extractTarGzEntry(archiveBytes, targetInfo.entry);

  const destPath = stageBinaryBufferAtomically(binaryBytes, outDir, targetInfo);
  return {
    destPath,
    target: targetInfo.target,
    version: resolvedVer,
    sha256: expectedSha256,
    source: 'release',
  };
}

function parseCliArgs(argv) {
  let target;
  let version;
  let outDir;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') {
      target = argv[++i];
      if (!target) {
        throw new Error('Missing value for --target.');
      }
    } else if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
    } else if (arg === '--version') {
      version = argv[++i];
      if (!version) {
        throw new Error('Missing value for --version.');
      }
    } else if (arg.startsWith('--version=')) {
      version = arg.slice('--version='.length);
    } else if (arg === '--out-dir') {
      outDir = argv[++i];
      if (!outDir) {
        throw new Error('Missing value for --out-dir.');
      }
    } else if (arg.startsWith('--out-dir=')) {
      outDir = arg.slice('--out-dir='.length);
    } else {
      throw new Error(`Unknown CLI argument: "${arg}".`);
    }
  }

  return {
    target,
    version,
    outDir: outDir ? path.resolve(outDir) : undefined,
  };
}

const isMainModule =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  try {
    const cliOptions = parseCliArgs(process.argv.slice(2));
    const result = await fetchOrStageBinary(cliOptions);
    const safeVersion = String(result.version).replace(/[\r\n]/g, ' ');
    const safeTarget = String(result.target).replace(/[\r\n]/g, ' ');
    const safeSource = String(result.source).replace(/[\r\n]/g, ' ');
    const safeDestPath = String(result.destPath).replace(/[\r\n]/g, ' ');
    console.log(
      `Staged tvek (${safeVersion}, target=${safeTarget}, source=${safeSource}) -> ${safeDestPath}`,
    );
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]/g, ' ');
    console.error(`[fetch-binary] ERROR: ${message}`);
    process.exitCode = 1;
  }
}
