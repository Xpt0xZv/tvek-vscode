import * as vscode from 'vscode';

import { TvekClientManager } from './client.js';
import { registerCommands } from './commands.js';
import { LanguageStatusPresenter } from './status.js';
import type { TvekExtensionApi } from './types.js';

let activeManager: TvekClientManager | null = null;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<TvekExtensionApi> {
  const outputChannel = vscode.window.createOutputChannel('tvek');
  const statusPresenter = new LanguageStatusPresenter();
  const manager = new TvekClientManager(
    context.extensionPath,
    outputChannel,
    statusPresenter,
  );
  activeManager = manager;

  registerCommands(context, manager, outputChannel);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('tvek')) {
        manager.scheduleConfigReload();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void manager.onWorkspaceTrustGranted();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      manager.scheduleConfigReload();
    }),
  );

  await manager.startInitial();

  return {
    getSnapshot: () => manager.getSnapshot(),
    waitForIdle: () => manager.waitForIdle(),
  };
}

export async function deactivate(): Promise<void> {
  const manager = activeManager;
  activeManager = null;
  if (manager) {
    await manager.dispose();
  }
}
