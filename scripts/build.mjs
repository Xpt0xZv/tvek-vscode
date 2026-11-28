import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(repoRoot, 'dist', 'extension.js');

fs.mkdirSync(path.dirname(outFile), { recursive: true });

function collectBundledLicenseFooter(metafile) {
  const pkgDirs = new Map();
  for (const inputPath of Object.keys(metafile.inputs)) {
    const absInput = path.resolve(repoRoot, inputPath);
    const normalized = absInput.replace(/\\/g, '/');
    const marker = '/node_modules/';
    const idx = normalized.lastIndexOf(marker);
    if (idx === -1) continue;

    const after = normalized.slice(idx + marker.length);
    const parts = after.split('/');
    const pkgName = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    if (!pkgName || pkgDirs.has(pkgName)) continue;

    const pkgRoot = path.join(absInput.slice(0, idx + marker.length), ...pkgName.split('/'));
    pkgDirs.set(pkgName, pkgRoot);
  }

  const notices = [];
  for (const [pkgName, pkgRoot] of [...pkgDirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let licenseText = '';
    try {
      const files = fs.readdirSync(pkgRoot);
      const licFile = files.find((f) => /^(license|licence)(\.|$)/i.test(f));
      if (licFile) {
        licenseText = fs.readFileSync(path.join(pkgRoot, licFile), 'utf8').trim();
      }
    } catch {
      continue;
    }
    if (licenseText) {
      const safeText = licenseText.replace(/\*\//g, '* /');
      notices.push(` * === ${pkgName} ===\n * ${safeText.split(/\r?\n/).join('\n * ')}`);
    }
  }

  return notices.length > 0 ? `\n/*!\n * Third-Party Bundled Licenses\n *\n${notices.join('\n *\n')}\n */\n` : '';
}

const result = await esbuild.build({
  entryPoints: [path.join(repoRoot, 'src', 'extension.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: outFile,
  external: ['vscode'],
  minify: true,
  sourcemap: false,
  legalComments: 'eof',
  metafile: true,
  logLevel: 'info',
});

const licenseFooter = collectBundledLicenseFooter(result.metafile);
if (licenseFooter) {
  fs.appendFileSync(outFile, licenseFooter, 'utf8');
}

const stat = fs.statSync(outFile);
const maxBytes = 450 * 1024;
if (stat.size > maxBytes) {
  throw new Error(
    `Bundle size budget exceeded: dist/extension.js is ${stat.size} bytes (ceiling: ${maxBytes} bytes).`,
  );
}

const outputs = Object.keys(result.metafile.outputs);
console.log(`Built ${outputs.join(', ')} (${(stat.size / 1024).toFixed(1)} KiB)`);
