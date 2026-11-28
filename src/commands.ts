import * as vscode from 'vscode';

import type { TvekClientManager } from './client.js';

export const COMMAND_RESTART_SERVER = 'tvek.restartServer';
export const COMMAND_FIX_ALL = 'tvek.fixAll';
export const COMMAND_SHOW_LOGS = 'tvek.showLogs';

export function registerCommands(
  context: vscode.ExtensionContext,
  manager: TvekClientManager,
  outputChannel: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_RESTART_SERVER, async () => {
      await manager.restart();
    }),
    vscode.commands.registerCommand(COMMAND_FIX_ALL, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return false;
      }
      return manager.fixAllInDocument(editor.document);
    }),
    vscode.commands.registerCommand(COMMAND_SHOW_LOGS, () => {
      outputChannel.show(true);
    }),
  );
}
