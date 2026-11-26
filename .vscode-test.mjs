import { defineConfig } from '@vscode/test-cli';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const vscodeTestRoot = path.join(repoRoot, '.vscode-test');
const e2eWorkspaceDir = path.join(vscodeTestRoot, 'workspace');
fs.mkdirSync(e2eWorkspaceDir, { recursive: true });

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
      const candidates =
        process.platform === 'win32'
          ? [path.join(dirPath, 'Code.exe')]
          : process.platform === 'darwin'
            ? [
                path.join(
                  dirPath,
                  'Visual Studio Code.app',
                  'Contents',
                  'MacOS',
                  'Electron',
                ),
              ]
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

const cachedVsCodePath = findCachedWorkspaceVsCode();

export default defineConfig({
  files: 'out-test/test/e2e/**/*.test.js',
  workspaceFolder: e2eWorkspaceDir,
  ...(cachedVsCodePath
    ? { useInstallation: { fromPath: cachedVsCodePath } }
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
