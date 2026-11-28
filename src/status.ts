import * as vscode from 'vscode';

import type { BinarySource, ExtensionSnapshot } from './types.js';

export const TVEK_DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { language: 'json', scheme: 'file' },
  { language: 'json', scheme: 'untitled' },
  { language: 'jsonc', scheme: 'file' },
  { language: 'jsonc', scheme: 'untitled' },
];

function formatSourceLabel(source: BinarySource): string {
  switch (source) {
    case 'path':
      return 'PATH';
    case 'bundled':
      return 'bundled';
    case 'venv':
      return 'venv';
    case 'custom':
      return 'custom';
  }
}

export class LanguageStatusPresenter implements vscode.Disposable {
  private readonly primaryItem: vscode.LanguageStatusItem;
  private readonly logsItem: vscode.LanguageStatusItem;

  public constructor() {
    this.primaryItem = vscode.languages.createLanguageStatusItem(
      'tvek.status',
      TVEK_DOCUMENT_SELECTOR,
    );
    this.primaryItem.name = 'tvek';

    this.logsItem = vscode.languages.createLanguageStatusItem(
      'tvek.logs',
      TVEK_DOCUMENT_SELECTOR,
    );
    this.logsItem.name = 'tvek Logs';
    this.logsItem.severity = vscode.LanguageStatusSeverity.Information;
    this.logsItem.text = '$(output) tvek Logs';
    this.logsItem.detail = 'Open the tvek language server output channel';
    this.logsItem.command = {
      title: 'Show Logs',
      command: 'tvek.showLogs',
      tooltip: 'Open the tvek Output Channel',
    };
    this.logsItem.accessibilityInformation = {
      label: 'tvek Logs: Open the tvek language server output channel',
      role: 'status',
    };
  }

  public update(snapshot: ExtensionSnapshot): void {
    switch (snapshot.state) {
      case 'starting': {
        this.primaryItem.busy = true;
        this.primaryItem.severity = vscode.LanguageStatusSeverity.Information;
        this.primaryItem.text = 'tvek';
        this.primaryItem.detail = 'Starting language server…';
        this.primaryItem.command = {
          title: 'Show Logs',
          command: 'tvek.showLogs',
        };
        this.primaryItem.accessibilityInformation = {
          label: 'tvek language server is starting',
          role: 'status',
        };
        break;
      }

      case 'stopping': {
        this.primaryItem.busy = true;
        this.primaryItem.severity = vscode.LanguageStatusSeverity.Information;
        this.primaryItem.text = 'tvek';
        this.primaryItem.detail = 'Stopping language server…';
        this.primaryItem.command = {
          title: 'Show Logs',
          command: 'tvek.showLogs',
        };
        this.primaryItem.accessibilityInformation = {
          label: 'tvek language server is stopping',
          role: 'status',
        };
        break;
      }

      case 'running': {
        const version = snapshot.binary?.version ?? 'unknown';
        const source = snapshot.binary
          ? formatSourceLabel(snapshot.binary.source)
          : 'unknown';
        const trustSuffix = snapshot.isTrusted ? '' : ' · Restricted Mode';

        this.primaryItem.busy = false;
        this.primaryItem.severity = vscode.LanguageStatusSeverity.Information;
        this.primaryItem.text = `$(check) tvek v${version}`;
        this.primaryItem.detail = `Source: ${source}${trustSuffix}`;
        this.primaryItem.command = {
          title: 'Restart Server',
          command: 'tvek.restartServer',
          tooltip: 'Restart the tvek language server',
        };
        this.primaryItem.accessibilityInformation = {
          label: `tvek version ${version} running from ${source}${snapshot.isTrusted ? '' : ' in restricted mode'}`,
          role: 'status',
        };
        break;
      }

      case 'disabled': {
        this.primaryItem.busy = false;
        this.primaryItem.severity = vscode.LanguageStatusSeverity.Information;
        this.primaryItem.text = '$(circle-slash) tvek (Disabled)';
        this.primaryItem.detail = 'Disabled via tvek.enable';
        this.primaryItem.command = {
          title: 'Show Logs',
          command: 'tvek.showLogs',
        };
        this.primaryItem.accessibilityInformation = {
          label: 'tvek language server is disabled via settings',
          role: 'status',
        };
        break;
      }

      case 'missingBinary': {
        this.primaryItem.busy = false;
        this.primaryItem.severity = vscode.LanguageStatusSeverity.Warning;
        this.primaryItem.text = '$(warning) tvek (Binary Missing)';
        this.primaryItem.detail =
          snapshot.lastError ?? 'Unable to find tvek executable';
        this.primaryItem.command = {
          title: 'Show Logs',
          command: 'tvek.showLogs',
        };
        this.primaryItem.accessibilityInformation = {
          label: `tvek warning: ${snapshot.lastError ?? 'executable not found'}`,
          role: 'status',
        };
        break;
      }

      case 'error': {
        this.primaryItem.busy = false;
        this.primaryItem.severity = vscode.LanguageStatusSeverity.Error;
        this.primaryItem.text = '$(error) tvek (Error)';
        this.primaryItem.detail =
          snapshot.lastError ?? 'Language server failed to start';
        this.primaryItem.command = {
          title: 'Restart Server',
          command: 'tvek.restartServer',
        };
        this.primaryItem.accessibilityInformation = {
          label: `tvek error: ${snapshot.lastError ?? 'language server failed'}`,
          role: 'status',
        };
        break;
      }

      case 'idle': {
        this.primaryItem.busy = false;
        this.primaryItem.severity = vscode.LanguageStatusSeverity.Information;
        this.primaryItem.text = 'tvek';
        this.primaryItem.detail = 'Idle';
        this.primaryItem.command = {
          title: 'Show Logs',
          command: 'tvek.showLogs',
        };
        this.primaryItem.accessibilityInformation = {
          label: 'tvek language server is idle',
          role: 'status',
        };
        break;
      }
    }
  }

  public dispose(): void {
    this.primaryItem.dispose();
    this.logsItem.dispose();
  }
}
