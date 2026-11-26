import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

interface TargetMetadata {
  readonly target: string;
  readonly triple: string;
  readonly archive: string;
  readonly entry: string;
  readonly binaryName: string;
  readonly format: 'zip' | 'tar.gz';
  readonly isWindows: boolean;
}

interface FetchBinaryModule {
  TARGETS: Record<string, TargetMetadata>;
  computeCrc32(buf: Buffer): number;
  resolveTarget(
    explicitTarget?: string,
    platform?: string,
    arch?: string,
    isAlpine?: boolean,
  ): TargetMetadata;
  validateVersion(ver: unknown): string;
  resolveVersion(opts?: {
    cliVersion?: string;
    envVersion?: string;
    packageJsonPath?: string;
  }): string;
  validateArchiveEntryPath(entryPath: string): string;
  parseSha256Sums(content: string): Map<string, string>;
  verifySha256(buffer: Buffer, expectedHex: string): boolean;
  extractTarGzEntry(
    gzBuffer: Buffer,
    expectedEntry: string,
    maxUncompressedBytes?: number,
  ): Buffer;
  extractZipEntry(
    zipBuffer: Buffer,
    expectedEntry: string,
    maxUncompressedBytes?: number,
  ): Buffer;
  isAllowedDownloadUrl(rawUrl: string): boolean;
  downloadHttpsBuffer(
    rawUrl: string,
    options?: {
      maxBytes?: number;
      timeoutMs?: number;
      maxRedirects?: number;
    },
  ): Promise<Buffer>;
  fetchOrStageBinary(options: {
    target?: string;
    version?: string;
    outDir?: string;
    localBin?: string;
    downloadFn?: (url: string) => Promise<Buffer>;
  }): Promise<{
    destPath: string;
    target: string;
    version: string;
    sha256?: string;
    source: string;
  }>;
}

async function loadFetchModule(): Promise<FetchBinaryModule> {
  const scriptPath = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'scripts',
    'fetch-binary.mjs',
  );
  return (await import(pathToFileURL(scriptPath).href)) as FetchBinaryModule;
}

function buildTarGz(
  entries: ReadonlyArray<{
    readonly name: string;
    readonly prefix?: string;
    readonly typeflag?: string;
    readonly data?: Buffer;
    readonly corruptChecksum?: boolean;
  }>,
): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    const payload = entry.data ?? Buffer.alloc(0);
    const typeChar = entry.typeflag ?? '0';

    header.write(entry.name, 0, Math.min(100, Buffer.byteLength(entry.name)), 'utf8');
    header.write('0000755\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${payload.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = typeChar.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    if (entry.prefix) {
      header.write(
        entry.prefix,
        345,
        Math.min(155, Buffer.byteLength(entry.prefix)),
        'utf8',
      );
    }

    let sum = 0;
    for (let i = 0; i < 512; i++) {
      sum += header[i]!;
    }
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

    if (entry.corruptChecksum) {
      // Mutate a byte in mtime AFTER computing header checksum
      header[136] = header[136] === 0x30 ? 0x31 : 0x30;
    }

    blocks.push(header);
    if (payload.length > 0) {
      blocks.push(payload);
      const remainder = payload.length % 512;
      if (remainder !== 0) {
        blocks.push(Buffer.alloc(512 - remainder, 0));
      }
    }
  }

  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function buildPaxRecord(key: string, value: string): Buffer {
  const tail = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(tail, 'utf8') + 1;
  while (true) {
    const candidate = `${len}${tail}`;
    const actualBytes = Buffer.byteLength(candidate, 'utf8');
    if (actualBytes === len) {
      return Buffer.from(candidate, 'utf8');
    }
    len = actualBytes;
  }
}

function buildZip(
  computeCrc32: (buf: Buffer) => number,
  entries: ReadonlyArray<{
    readonly name: string;
    readonly data: Buffer;
    readonly corruptCrc?: boolean;
    readonly unixMode?: number;
    readonly flags?: number;
  }>,
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.data);
    const crc = entry.corruptCrc
      ? (computeCrc32(entry.data) ^ 0x00000001) >>> 0
      : computeCrc32(entry.data);
    const flags = entry.flags ?? 0;

    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBytes.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(((entry.unixMode ?? 0o100755) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBytes.copy(centralHeader, 46);

    localParts.push(localHeader, compressed);
    centralParts.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }

  const cdBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuffer, eocd]);
}

describe('fetch-binary supply-chain & archive security invariants', () => {
  it('maps all 7 VSCE targets accurately and rejects unknown targets', async () => {
    const mod = await loadFetchModule();

    const expectedTargets: Record<string, TargetMetadata> = {
      'win32-x64': {
        target: 'win32-x64',
        triple: 'x86_64-pc-windows-msvc',
        archive: 'tvek-x86_64-pc-windows-msvc.zip',
        entry: 'tvek-x86_64-pc-windows-msvc/tvek.exe',
        binaryName: 'tvek.exe',
        format: 'zip',
        isWindows: true,
      },
      'win32-arm64': {
        target: 'win32-arm64',
        triple: 'aarch64-pc-windows-msvc',
        archive: 'tvek-aarch64-pc-windows-msvc.zip',
        entry: 'tvek-aarch64-pc-windows-msvc/tvek.exe',
        binaryName: 'tvek.exe',
        format: 'zip',
        isWindows: true,
      },
      'darwin-x64': {
        target: 'darwin-x64',
        triple: 'x86_64-apple-darwin',
        archive: 'tvek-x86_64-apple-darwin.tar.gz',
        entry: 'tvek-x86_64-apple-darwin/tvek',
        binaryName: 'tvek',
        format: 'tar.gz',
        isWindows: false,
      },
      'darwin-arm64': {
        target: 'darwin-arm64',
        triple: 'aarch64-apple-darwin',
        archive: 'tvek-aarch64-apple-darwin.tar.gz',
        entry: 'tvek-aarch64-apple-darwin/tvek',
        binaryName: 'tvek',
        format: 'tar.gz',
        isWindows: false,
      },
      'linux-x64': {
        target: 'linux-x64',
        triple: 'x86_64-unknown-linux-gnu',
        archive: 'tvek-x86_64-unknown-linux-gnu.tar.gz',
        entry: 'tvek-x86_64-unknown-linux-gnu/tvek',
        binaryName: 'tvek',
        format: 'tar.gz',
        isWindows: false,
      },
      'linux-arm64': {
        target: 'linux-arm64',
        triple: 'aarch64-unknown-linux-gnu',
        archive: 'tvek-aarch64-unknown-linux-gnu.tar.gz',
        entry: 'tvek-aarch64-unknown-linux-gnu/tvek',
        binaryName: 'tvek',
        format: 'tar.gz',
        isWindows: false,
      },
      'alpine-x64': {
        target: 'alpine-x64',
        triple: 'x86_64-unknown-linux-musl',
        archive: 'tvek-x86_64-unknown-linux-musl.tar.gz',
        entry: 'tvek-x86_64-unknown-linux-musl/tvek',
        binaryName: 'tvek',
        format: 'tar.gz',
        isWindows: false,
      },
    };

    assert.deepEqual(Object.keys(mod.TARGETS).sort(), Object.keys(expectedTargets).sort());
    for (const [key, expected] of Object.entries(expectedTargets)) {
      assert.deepEqual(mod.resolveTarget(key), expected);
    }

    // Host auto-detection across platforms including Alpine musl
    assert.equal(mod.resolveTarget(undefined, 'win32', 'x64', false).target, 'win32-x64');
    assert.equal(mod.resolveTarget(undefined, 'win32', 'arm64', false).target, 'win32-arm64');
    assert.equal(mod.resolveTarget(undefined, 'darwin', 'x64', false).target, 'darwin-x64');
    assert.equal(mod.resolveTarget(undefined, 'darwin', 'arm64', false).target, 'darwin-arm64');
    assert.equal(mod.resolveTarget(undefined, 'linux', 'x64', false).target, 'linux-x64');
    assert.equal(mod.resolveTarget(undefined, 'linux', 'arm64', false).target, 'linux-arm64');
    assert.equal(mod.resolveTarget(undefined, 'linux', 'x64', true).target, 'alpine-x64');

    assert.throws(() => mod.resolveTarget('freebsd-x64'), /Unsupported target/);
    assert.throws(
      () => mod.resolveTarget(undefined, 'linux', 'arm64', true),
      /Unsupported host platform\/arch "alpine-arm64"/,
    );
  });

  it('validates SemVer versions strictly and rejects traversal or injection strings', async () => {
    const mod = await loadFetchModule();
    assert.equal(mod.validateVersion('0.1.4'), '0.1.4');
    assert.equal(mod.validateVersion('v0.1.4-rc.1'), '0.1.4-rc.1');
    assert.equal(mod.resolveVersion({ cliVersion: 'v1.2.3' }), '1.2.3');

    for (const bad of [
      '',
      'latest',
      '1.2',
      '1.2.3.4',
      '1.2.3+build1',
      '1.2.3/../../evil',
      '0.1.4?token=leak',
      '0.1.4;rm -rf /',
      null,
      123,
    ]) {
      assert.throws(() => mod.validateVersion(bad), /Invalid tvek/);
    }
  });

  it('enforces HTTPS github.com / *.githubusercontent.com URL allowlist and blocks disallowed redirects', async () => {
    const mod = await loadFetchModule();
    assert.equal(
      mod.isAllowedDownloadUrl(
        'https://github.com/Xpt0xZv/tvek/releases/download/v0.1.4/SHA256SUMS',
      ),
      true,
    );
    assert.equal(
      mod.isAllowedDownloadUrl(
        'https://objects.githubusercontent.com/github-production-release-asset/123',
      ),
      true,
    );
    assert.equal(
      mod.isAllowedDownloadUrl(
        'http://github.com/Xpt0xZv/tvek/releases/download/v0.1.4/SHA256SUMS',
      ),
      false,
    );
    assert.equal(mod.isAllowedDownloadUrl('https://evil.example.com/tvek.zip'), false);
    assert.equal(mod.isAllowedDownloadUrl('https://evilgithub.com/payload.zip'), false);
    assert.equal(mod.isAllowedDownloadUrl('https://githubusercontent.com/payload.zip'), false);
    assert.equal(mod.isAllowedDownloadUrl('https://user:pass@github.com/Xpt0xZv/tvek'), false);

    // Non-HTTPS URL rejected immediately without network socket
    await assert.rejects(
      () =>
        mod.downloadHttpsBuffer(
          'http://github.com/Xpt0xZv/tvek/releases/download/v0.1.4/SHA256SUMS',
        ),
      /Blocked download URL/,
    );

    // Disallowed redirect host (evil.example.com) and HTTP downgrade redirect blocked without following
    const requestedUrls: string[] = [];
    const getMock = mock.method(
      https,
      'get',
      (
        url: string | URL,
        _opts: unknown,
        cb: (res: IncomingMessage) => void,
      ): ClientRequest => {
        const urlStr = String(url);
        requestedUrls.push(urlStr);

        const reqEmitter = new EventEmitter() as ClientRequest;
        reqEmitter.setTimeout = () => reqEmitter;
        reqEmitter.destroy = () => reqEmitter;

        const resEmitter = new EventEmitter() as IncomingMessage;
        resEmitter.resume = () => resEmitter;
        resEmitter.destroy = () => resEmitter;

        if (urlStr.includes('/redirect-to-evil')) {
          resEmitter.statusCode = 302;
          resEmitter.headers = { location: 'https://evil.example.com/malicious.zip' };
          queueMicrotask(() => cb(resEmitter));
        } else if (urlStr.includes('/redirect-to-http')) {
          resEmitter.statusCode = 302;
          resEmitter.headers = {
            location: 'http://objects.githubusercontent.com/downgrade.zip',
          };
          queueMicrotask(() => cb(resEmitter));
        } else if (urlStr.includes('/redirect-to-allowed')) {
          resEmitter.statusCode = 302;
          resEmitter.headers = {
            location: 'https://objects.githubusercontent.com/asset-ok',
          };
          queueMicrotask(() => cb(resEmitter));
        } else if (urlStr === 'https://objects.githubusercontent.com/asset-ok') {
          resEmitter.statusCode = 200;
          resEmitter.headers = { 'content-length': '2' };
          queueMicrotask(() => {
            cb(resEmitter);
            resEmitter.emit('data', Buffer.from('OK', 'utf8'));
            resEmitter.emit('end');
          });
        }

        return reqEmitter;
      },
    );

    try {
      await assert.rejects(
        () => mod.downloadHttpsBuffer('https://github.com/redirect-to-evil'),
        /Blocked download URL "https:\/\/evil\.example\.com\/malicious\.zip"/,
      );
      assert.ok(
        !requestedUrls.some((u) => u.includes('evil.example.com')),
        'Must never connect to disallowed redirect host',
      );

      await assert.rejects(
        () => mod.downloadHttpsBuffer('https://github.com/redirect-to-http'),
        /Blocked download URL "http:\/\/objects\.githubusercontent\.com\/downgrade\.zip"/,
      );

      const okBytes = await mod.downloadHttpsBuffer(
        'https://github.com/redirect-to-allowed',
      );
      assert.deepEqual(okBytes, Buffer.from('OK', 'utf8'));
    } finally {
      getMock.mock.restore();
    }
  });

  it('parses SHA256SUMS strictly and rejects malformed, conflicting, or empty checksum files', async () => {
    const mod = await loadFetchModule();
    const payload = Buffer.from('verified-tvek-binary-payload', 'utf8');
    const validHex = crypto.createHash('sha256').update(payload).digest('hex');

    const sumsText = [
      '# comment header',
      `${validHex}  tvek-x86_64-pc-windows-msvc.zip\r`,
      `${'a'.repeat(64)} *tvek-x86_64-unknown-linux-gnu.tar.gz`,
      '',
    ].join('\n');

    const parsed = mod.parseSha256Sums(sumsText);
    assert.equal(parsed.get('tvek-x86_64-pc-windows-msvc.zip'), validHex);
    assert.equal(parsed.get('tvek-x86_64-unknown-linux-gnu.tar.gz'), 'a'.repeat(64));

    // Malformed digests & filenames
    assert.throws(
      () => mod.parseSha256Sums(`${'a'.repeat(63)}  tvek.zip\n`),
      /Malformed SHA256SUMS entry/,
    );
    assert.throws(
      () => mod.parseSha256Sums(`${'g'.repeat(64)}  tvek.zip\n`),
      /Malformed SHA256SUMS entry/,
    );
    assert.throws(
      () => mod.parseSha256Sums(`${'a'.repeat(64)}  ../evil/tvek.zip\n`),
      /Malformed SHA256SUMS entry/,
    );
    assert.throws(
      () =>
        mod.parseSha256Sums(
          `${'a'.repeat(64)}  tvek.zip\n${'b'.repeat(64)}  tvek.zip\n`,
        ),
      /Conflicting SHA-256 digests/,
    );
    assert.throws(
      () => mod.parseSha256Sums('# only comments\n\n'),
      /did not contain any valid digest entries/,
    );

    // verifySha256 malformed expectedHex vs 1-bit flipped buffer
    assert.throws(() => mod.verifySha256(payload, 'not-a-sha256'), /Invalid expected SHA-256/);
    const tamperedPayload = Buffer.from(payload);
    tamperedPayload[0] = (tamperedPayload[0] ?? 0) ^ 0x01;
    assert.throws(
      () => mod.verifySha256(tamperedPayload, validHex),
      /SHA-256 verification failed/,
    );
  });

  it('hardens tar.gz extraction against Tar-Slip (USTAR/PAX/GNU), symlinks, hardlinks, and header checksum corruption', async () => {
    const mod = await loadFetchModule();
    const expectedBytes = Buffer.from('#!/bin/sh\necho "tvek 0.1.4"\n', 'utf8');

    const goodTarGz = buildTarGz([
      { name: 'tvek-x86_64-unknown-linux-gnu/', typeflag: '5' },
      { name: 'tvek-x86_64-unknown-linux-gnu/README.md', data: Buffer.from('readme') },
      { name: 'tvek-x86_64-unknown-linux-gnu/tvek', data: expectedBytes },
    ]);
    assert.deepEqual(
      mod.extractTarGzEntry(goodTarGz, 'tvek-x86_64-unknown-linux-gnu/tvek'),
      expectedBytes,
    );

    // 1. Direct Tar-Slip (`../../evil/tvek`)
    const directSlip = buildTarGz([
      { name: '../../evil/tvek', data: expectedBytes },
    ]);
    assert.throws(
      () => mod.extractTarGzEntry(directSlip, 'tvek-x86_64-unknown-linux-gnu/tvek'),
      /Unsafe archive entry path/,
    );

    // 2. USTAR prefix Tar-Slip (`prefix: "../../evil"`, `name: "tvek"`)
    const prefixSlip = buildTarGz([
      { name: 'tvek', prefix: '../../evil', data: expectedBytes },
    ]);
    assert.throws(
      () => mod.extractTarGzEntry(prefixSlip, 'tvek-x86_64-unknown-linux-gnu/tvek'),
      /Unsafe archive entry path/,
    );

    // 3. PAX extended header Tar-Slip (`typeflag: 'x'`, `path=../../evil/tvek`)
    const paxSlip = buildTarGz([
      {
        name: 'PaxHeader/tvek',
        typeflag: 'x',
        data: buildPaxRecord('path', '../../evil/tvek'),
      },
      { name: 'tvek-x86_64-unknown-linux-gnu/tvek', data: expectedBytes },
    ]);
    assert.throws(
      () => mod.extractTarGzEntry(paxSlip, 'tvek-x86_64-unknown-linux-gnu/tvek'),
      /Unsafe archive entry path/,
    );

    // 4. GNU LongLink Tar-Slip (`typeflag: 'L'`)
    const gnuLongSlip = buildTarGz([
      {
        name: '././@LongLink',
        typeflag: 'L',
        data: Buffer.from('../../evil/tvek\0', 'utf8'),
      },
      { name: 'tvek-x86_64-unknown-linux-gnu/tvek', data: expectedBytes },
    ]);
    assert.throws(
      () => mod.extractTarGzEntry(gnuLongSlip, 'tvek-x86_64-unknown-linux-gnu/tvek'),
      /Unsafe archive entry path/,
    );

    // 5. Tar symlink ('2') and hardlink ('1') and FIFO ('6')
    for (const forbiddenType of ['1', '2', '3', '4', '6']) {
      const linkTarGz = buildTarGz([
        { name: 'tvek-x86_64-unknown-linux-gnu/tvek', typeflag: forbiddenType },
      ]);
      assert.throws(
        () => mod.extractTarGzEntry(linkTarGz, 'tvek-x86_64-unknown-linux-gnu/tvek'),
        /Unsafe tar entry typeflag/,
      );
    }

    // 6. Corrupted USTAR header checksum
    const corruptChecksumTarGz = buildTarGz([
      {
        name: 'tvek-x86_64-unknown-linux-gnu/tvek',
        data: expectedBytes,
        corruptChecksum: true,
      },
    ]);
    assert.throws(
      () =>
        mod.extractTarGzEntry(
          corruptChecksumTarGz,
          'tvek-x86_64-unknown-linux-gnu/tvek',
        ),
      /Corrupt tar header checksum/,
    );
  });

  it('hardens zip extraction against Zip-Slip, CRC-32 mismatch, symlinks, and encryption', async () => {
    const mod = await loadFetchModule();
    const expectedExe = Buffer.from('MZ-fake-pe-tvek-binary', 'utf8');

    const goodZip = buildZip(mod.computeCrc32, [
      { name: 'tvek-x86_64-pc-windows-msvc/LICENSE-MIT', data: Buffer.from('MIT') },
      { name: 'tvek-x86_64-pc-windows-msvc/tvek.exe', data: expectedExe },
    ]);
    assert.deepEqual(
      mod.extractZipEntry(goodZip, 'tvek-x86_64-pc-windows-msvc/tvek.exe'),
      expectedExe,
    );

    // Zip-Slip path traversal (`../../evil/tvek.exe`), backslashes, leading slash, drive prefix
    for (const maliciousName of [
      '../../evil/tvek.exe',
      'tvek-x86_64-pc-windows-msvc/../../evil/tvek.exe',
      'tvek-x86_64-pc-windows-msvc\\tvek.exe',
      '/etc/tvek.exe',
      'C:/Windows/tvek.exe',
      'tvek\0.exe',
    ]) {
      const badZip = buildZip(mod.computeCrc32, [
        { name: maliciousName, data: expectedExe },
      ]);
      assert.throws(
        () => mod.extractZipEntry(badZip, 'tvek-x86_64-pc-windows-msvc/tvek.exe'),
        /Unsafe archive entry path/,
      );
    }

    // CRC-32 mismatch
    const badCrcZip = buildZip(mod.computeCrc32, [
      {
        name: 'tvek-x86_64-pc-windows-msvc/tvek.exe',
        data: expectedExe,
        corruptCrc: true,
      },
    ]);
    assert.throws(
      () => mod.extractZipEntry(badCrcZip, 'tvek-x86_64-pc-windows-msvc/tvek.exe'),
      /CRC-32 mismatch/,
    );

    // Unix symlink mode inside zip
    const symlinkZip = buildZip(mod.computeCrc32, [
      {
        name: 'tvek-x86_64-pc-windows-msvc/tvek.exe',
        data: expectedExe,
        unixMode: 0o120777,
      },
    ]);
    assert.throws(
      () => mod.extractZipEntry(symlinkZip, 'tvek-x86_64-pc-windows-msvc/tvek.exe'),
      /symbolic links are forbidden/,
    );

    // Encrypted zip entry
    const encryptedZip = buildZip(mod.computeCrc32, [
      {
        name: 'tvek-x86_64-pc-windows-msvc/tvek.exe',
        data: expectedExe,
        flags: 0x01,
      },
    ]);
    assert.throws(
      () => mod.extractZipEntry(encryptedZip, 'tvek-x86_64-pc-windows-msvc/tvek.exe'),
      /Encrypted zip entries are not supported/,
    );
  });

  it('rejects 1-bit tampered archives BEFORE extraction with zero files written, rejects missing SHA256SUMS entry, and stages TVEK_LOCAL_BIN', async () => {
    const mod = await loadFetchModule();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tvek-stage-adv-'));
    const outDir = path.join(tmpRoot, 'bundled', 'bin');

    try {
      const exePayload = Buffer.from('MZ-verified-binary-014', 'utf8');
      const validZip = buildZip(mod.computeCrc32, [
        { name: 'tvek-x86_64-pc-windows-msvc/tvek.exe', data: exePayload },
      ]);
      const expectedSha = crypto.createHash('sha256').update(validZip).digest('hex');

      // Flip 1 single bit in the downloaded zip archive
      const tamperedZip = Buffer.from(validZip);
      const midIdx = Math.floor(tamperedZip.length / 2);
      tamperedZip[midIdx] = (tamperedZip[midIdx] ?? 0) ^ 0x01;

      await assert.rejects(
        () =>
          mod.fetchOrStageBinary({
            target: 'win32-x64',
            version: '0.1.4',
            outDir,
            localBin: '',
            downloadFn: async (url: string) => {
              if (url.endsWith('/SHA256SUMS')) {
                return Buffer.from(
                  `${expectedSha}  tvek-x86_64-pc-windows-msvc.zip\n`,
                  'utf8',
                );
              }
              return tamperedZip;
            },
          }),
        /SHA-256 verification failed/,
      );
      assert.equal(
        fs.existsSync(outDir),
        false,
        'Zero output directory or files may be created when SHA-256 verification fails',
      );

      // Prove verification occurs BEFORE extraction: pass a Zip-Slip archive with wrong SHA-256
      const zipSlipArchive = buildZip(mod.computeCrc32, [
        { name: '../../evil/tvek.exe', data: exePayload },
      ]);
      await assert.rejects(
        () =>
          mod.fetchOrStageBinary({
            target: 'win32-x64',
            version: '0.1.4',
            outDir,
            localBin: '',
            downloadFn: async (url: string) => {
              if (url.endsWith('/SHA256SUMS')) {
                return Buffer.from(
                  `${expectedSha}  tvek-x86_64-pc-windows-msvc.zip\n`,
                  'utf8',
                );
              }
              return zipSlipArchive;
            },
          }),
        /SHA-256 verification failed/,
      );
      assert.equal(fs.existsSync(outDir), false);

      // Missing target archive filename in SHA256SUMS -> rejected cleanly before extraction
      await assert.rejects(
        () =>
          mod.fetchOrStageBinary({
            target: 'win32-x64',
            version: '0.1.4',
            outDir,
            localBin: '',
            downloadFn: async (url: string) => {
              if (url.endsWith('/SHA256SUMS')) {
                return Buffer.from(
                  `${expectedSha}  tvek-x86_64-unknown-linux-gnu.tar.gz\n`,
                  'utf8',
                );
              }
              return validZip;
            },
          }),
        /was not listed in SHA256SUMS/,
      );
      assert.equal(fs.existsSync(outDir), false);

      // TVEK_LOCAL_BIN error boundaries: missing file, directory, and 0-byte file
      await assert.rejects(
        () =>
          mod.fetchOrStageBinary({
            target: 'win32-x64',
            outDir,
            localBin: path.join(tmpRoot, 'does-not-exist.exe'),
          }),
        /TVEK_LOCAL_BIN does not exist/,
      );

      await assert.rejects(
        () =>
          mod.fetchOrStageBinary({
            target: 'win32-x64',
            outDir,
            localBin: tmpRoot,
          }),
        /TVEK_LOCAL_BIN is not a regular file/,
      );

      const emptyLocalBin = path.join(tmpRoot, 'empty-tvek.exe');
      fs.writeFileSync(emptyLocalBin, Buffer.alloc(0));
      await assert.rejects(
        () =>
          mod.fetchOrStageBinary({
            target: 'win32-x64',
            outDir,
            localBin: emptyLocalBin,
          }),
        /TVEK_LOCAL_BIN has invalid file size/,
      );

      // Valid TVEK_LOCAL_BIN staging for win32-x64 -> stages tvek.exe, then linux-x64 -> replaces stale tvek.exe with tvek
      const validLocalBin = path.join(tmpRoot, 'local-built-tvek');
      const localBytes = Buffer.from('local-tvek-binary-contents', 'utf8');
      fs.writeFileSync(validLocalBin, localBytes);

      const stagedWin = await mod.fetchOrStageBinary({
        target: 'win32-x64',
        outDir,
        localBin: validLocalBin,
      });
      assert.equal(stagedWin.source, 'local');
      assert.equal(stagedWin.version, 'local');
      assert.equal(stagedWin.destPath, path.join(outDir, 'tvek.exe'));
      assert.deepEqual(fs.readFileSync(stagedWin.destPath), localBytes);

      const stagedLinux = await mod.fetchOrStageBinary({
        target: 'linux-x64',
        outDir,
        localBin: validLocalBin,
      });
      assert.equal(stagedLinux.destPath, path.join(outDir, 'tvek'));
      assert.equal(
        fs.existsSync(path.join(outDir, 'tvek.exe')),
        false,
        'Stale cross-platform sibling binary must be cleaned up when restaging',
      );
      assert.deepEqual(fs.readFileSync(stagedLinux.destPath), localBytes);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
