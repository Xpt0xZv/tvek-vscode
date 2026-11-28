import { defineConfig } from '@vscode/test-cli';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const vscodeTestRoot = path.join(repoRoot, '.vscode-test');
const e2eWorkspaceDir = path.join(vscodeTestRoot, 'workspace');
fs.mkdirSync(e2eWorkspaceDir, { recursive: true });

function resolveDarwinMacOsBin(macOsDir) {
  if (!fs.existsSync(macOsDir)) return undefined;
  for (const name of ['Code', 'Electron']) {
    const candidate = path.join(macOsDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const entry of fs.readdirSync(macOsDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const candidate = path.join(macOsDir, entry.name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function findCachedWorkspaceVsCode() {
  if (
    process.env.VSCODE_EXECUTABLE_PATH &&
    fs.existsSync(process.env.VSCODE_EXECUTABLE_PATH)
  ) {
    return process.env.VSCODE_EXECUTABLE_PATH;
  }
  try {
    const entries = fs.readdirSync(vscodeTestRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('vscode-')) {
        continue;
      }
      const dirPath = path.join(vscodeTestRoot, entry.name);
      if (process.platform === 'darwin') {
        const subDirs = fs
          .readdirSync(dirPath, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.endsWith('.app'))
          .map((d) => path.join(dirPath, d.name));
        for (const base of [dirPath, ...subDirs]) {
          const found = resolveDarwinMacOsBin(
            path.join(base, 'Visual Studio Code.app', 'Contents', 'MacOS'),
          );
          if (found) return found;
        }
        continue;
      }
      const candidates =
        process.platform === 'win32'
          ? [path.join(dirPath, 'Code.exe')]
          : [path.join(dirPath, 'code')];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    // No cached installation yet; @vscode/test-cli will download stable automatically.
  }
  return undefined;
}

let resolvedVsCodePath = findCachedWorkspaceVsCode();
if (!resolvedVsCodePath && process.platform === 'darwin') {
  const downloadedExecPath = await downloadAndUnzipVSCode({ cachePath: vscodeTestRoot });
  resolvedVsCodePath = fs.existsSync(downloadedExecPath)
    ? downloadedExecPath
    : (resolveDarwinMacOsBin(path.dirname(downloadedExecPath)) ?? findCachedWorkspaceVsCode());
}

export default defineConfig({
  files: 'out-test/test/e2e/**/*.test.js',
  workspaceFolder: e2eWorkspaceDir,
  ...(resolvedVsCodePath
    ? { useInstallation: { fromPath: resolvedVsCodePath } }
    : {}),
  mocha: {
    ui: 'tdd',
    timeout: 30000,
  },
  launchArgs: [
    '--disable-extensions',
    '--disable-workspace-trust',
    '--no-sandbox',
    '--disable-gpu',
  ],
  env: {
    TVEK_E2E_REPO_ROOT: repoRoot,
  },
});
