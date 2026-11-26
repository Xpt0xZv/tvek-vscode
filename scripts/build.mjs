import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(repoRoot, 'dist', 'extension.js');

fs.mkdirSync(path.dirname(outFile), { recursive: true });

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
  legalComments: 'none',
  metafile: true,
  logLevel: 'info',
});

const stat = fs.statSync(outFile);
const maxBytes = 450 * 1024;
if (stat.size > maxBytes) {
  throw new Error(
    `Bundle size budget exceeded: dist/extension.js is ${stat.size} bytes (ceiling: ${maxBytes} bytes).`,
  );
}

const outputs = Object.keys(result.metafile.outputs);
console.log(`Built ${outputs.join(', ')} (${(stat.size / 1024).toFixed(1)} KiB)`);
