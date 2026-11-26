import * as vscode from 'vscode';
import {
  CloseAction,
  CodeAction,
  CodeActionRequest,
  ErrorAction,
  LanguageClient,
  RevealOutputChannelOn,
  Trace,
  TransportKind,
  type CodeActionParams,
  type DocumentSelector as LspDocumentSelector,
  type ErrorHandler,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';

import {
  BinaryResolutionError,
  buildServerArgs,
  resolveBinary,
} from './binary.js';
import { resolveConfig } from './config.js';
import { ReloadCoordinator } from './mutex.js';
import type { LanguageStatusPresenter } from './status.js';
import type {
  BinarySnapshot,
  ClientLifecycleState,
  ExtensionSnapshot,
  ResolvedConfig,
  SettingInspector,
  TraceLevel,
} from './types.js';

const STOP_TIMEOUT_MS = 5_000;
const HARD_STOP_GUARD_MS = 5_500;
const MAX_AUTO_RESTARTS = 4;
const CRASH_WINDOW_MS = 180_000;

export const TVEK_LSP_DOCUMENT_SELECTOR: LspDocumentSelector = [
  { language: 'json', scheme: 'file' },
  { language: 'json', scheme: 'untitled' },
  { language: 'jsonc', scheme: 'file' },
  { language: 'jsonc', scheme: 'untitled' },
];

function mapTraceLevel(level: TraceLevel): Trace {
  switch (level) {
    case 'verbose':
      return Trace.Verbose;
    case 'messages':
      return Trace.Messages;
    case 'off':
      return Trace.Off;
  }
}

function readCurrentConfig(isTrusted: boolean): ResolvedConfig {
  const configuration = vscode.workspace.getConfiguration('tvek');
  const inspector: SettingInspector = <T>(key: string) =>
    configuration.inspect<T>(key);
  return resolveConfig(inspector, isTrusted);
}

function getWorkspaceFolderPaths(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) {
    return [];
  }
  return folders
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);
}

export class TvekClientManager {
  private readonly extensionPath: string;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly statusPresenter: LanguageStatusPresenter;
  private readonly coordinator = new ReloadCoordinator(150);

  private client: LanguageClient | null = null;
  private state: ClientLifecycleState = 'idle';
  private activeConfig: ResolvedConfig;
  private activeBinary: BinarySnapshot | null = null;
  private lastError: string | null = null;
  private restartGeneration = 0;
  private stoppingIntentionally = false;
  private crashTimestamps: number[] = [];

  public constructor(
    extensionPath: string,
    outputChannel: vscode.OutputChannel,
    statusPresenter: LanguageStatusPresenter,
  ) {
    this.extensionPath = extensionPath;
    this.outputChannel = outputChannel;
    this.statusPresenter = statusPresenter;
    this.activeConfig = readCurrentConfig(vscode.workspace.isTrusted);
    this.publishStatus();
  }

  public getSnapshot(): ExtensionSnapshot {
    return {
      state: this.state,
      isTrusted: vscode.workspace.isTrusted,
      config: this.activeConfig,
      binary: this.activeBinary ? { ...this.activeBinary } : null,
      lastError: this.lastError,
      restartGeneration: this.restartGeneration,
    };
  }

  public async waitForIdle(): Promise<ExtensionSnapshot> {
    await this.coordinator.waitForIdle();
    return this.getSnapshot();
  }

  public async startInitial(): Promise<void> {
    await this.coordinator.runImmediate(async () => {
      await this.reconcileInternal('initial activation');
    });
  }

  public scheduleConfigReload(): void {
    void this.coordinator.scheduleDebounced(async () => {
      await this.reconcileInternal('configuration change');
    });
  }

  public async onWorkspaceTrustGranted(): Promise<void> {
    await this.coordinator.runImmediate(async () => {
      await this.reconcileInternal('workspace trust granted');
    });
  }

  public async restart(): Promise<void> {
    await this.coordinator.runImmediate(async () => {
      this.crashTimestamps = [];
      await this.reconcileInternal('manual restart');
    });
  }

  public async fixAllInDocument(document: vscode.TextDocument): Promise<boolean> {
    if (
      (document.languageId !== 'json' && document.languageId !== 'jsonc') ||
      (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled')
    ) {
      return false;
    }

    const client = this.client;
    if (!client || !client.isRunning()) {
      return false;
    }

    const lastLine = Math.max(0, document.lineCount - 1);
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      document.lineAt(lastLine).range.end,
    );

    const vscodeDiagnostics = vscode.languages.getDiagnostics(document.uri);
    const protocolDiagnostics =
      await client.code2ProtocolConverter.asDiagnostics([...vscodeDiagnostics]);

    const params: CodeActionParams = {
      textDocument:
        client.code2ProtocolConverter.asTextDocumentIdentifier(document),
      range: client.code2ProtocolConverter.asRange(fullRange),
      context: {
        diagnostics: protocolDiagnostics,
        only: ['source.fixAll.tvek'],
      },
    };

    const actions = await client.sendRequest(CodeActionRequest.type, params);
    if (!actions || actions.length === 0) {
      return false;
    }

    let appliedAny = false;
    for (const item of actions) {
      // Strictly apply WorkspaceEdits only; never invoke server-supplied Commands (ADR-0001 §3.2).
      if (CodeAction.is(item) && item.edit !== undefined) {
        const workspaceEdit =
          await client.protocol2CodeConverter.asWorkspaceEdit(item.edit);
        if (workspaceEdit) {
          const ok = await vscode.workspace.applyEdit(workspaceEdit);
          if (ok) {
            appliedAny = true;
          }
        }
      }
    }

    return appliedAny;
  }

  public async dispose(): Promise<void> {
    await this.coordinator.dispose(async () => {
      await this.stopActiveClientInternal();
      this.state = 'idle';
      this.activeBinary = null;
    });
    this.statusPresenter.dispose();
    this.outputChannel.dispose();
  }

  private async reconcileInternal(reason: string): Promise<void> {
    if (this.coordinator.isDisposed) {
      return;
    }

    const isTrusted = vscode.workspace.isTrusted;
    const nextConfig = readCurrentConfig(isTrusted);
    this.activeConfig = nextConfig;

    this.logInfo(`Reconciling tvek language server (${reason}, trusted=${isTrusted}).`);

    await this.stopActiveClientInternal();

    if (!nextConfig.enable) {
      this.state = 'disabled';
      this.activeBinary = null;
      this.lastError = null;
      this.publishStatus();
      this.logInfo('tvek language server is disabled (tvek.enable = false).');
      return;
    }

    this.state = 'starting';
    this.lastError = null;
    this.publishStatus();

    let resolvedBinary;
    try {
      resolvedBinary = await resolveBinary(
        {
          platform: process.platform,
          env: process.env,
          extensionPath: this.extensionPath,
          workspaceFolders: getWorkspaceFolderPaths(),
          isTrusted,
          execPath: process.execPath,
        },
        nextConfig,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.activeBinary = null;
      this.lastError = message;
      this.state =
        err instanceof BinaryResolutionError && err.code === 'NOT_FOUND'
          ? 'missingBinary'
          : 'error';
      this.publishStatus();
      this.logError(message);
      return;
    }

    const serverArgs = buildServerArgs(
      resolvedBinary,
      nextConfig.initOptions.maxSize,
    );

    const serverOptions: ServerOptions = {
      command: resolvedBinary.command,
      args: serverArgs,
      transport: TransportKind.stdio,
      options: {
        cwd: resolvedBinary.safeCwd,
        env: resolvedBinary.safeEnv,
        shell: false,
      },
    };

    const clientOptions: LanguageClientOptions = {
      documentSelector: TVEK_LSP_DOCUMENT_SELECTOR,
      outputChannel: this.outputChannel,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      initializationOptions: nextConfig.initOptions,
      errorHandler: this.createErrorHandler(),
      middleware: {
        workspace: {
          didChangeConfiguration: () => Promise.resolve(),
        },
        provideCodeActions: async (document, range, context, token, next) => {
          const items = await next(document, range, context, token);
          if (!items) {
            return items;
          }
          const sanitized: vscode.CodeAction[] = [];
          for (const item of items) {
            if (item instanceof vscode.CodeAction) {
              item.command = undefined;
              if (item.edit !== undefined) {
                sanitized.push(item);
              }
            }
          }
          return sanitized;
        },
      },
    };

    const nextClient = new LanguageClient(
      'tvek',
      'tvek',
      serverOptions,
      clientOptions,
    );

    this.stoppingIntentionally = false;
    try {
      await nextClient.start();
      await nextClient.setTrace(mapTraceLevel(nextConfig.traceServer));

      this.client = nextClient;
      this.activeBinary = {
        executablePath: resolvedBinary.executablePath,
        source: resolvedBinary.source,
        version: resolvedBinary.version,
      };
      this.lastError = null;
      this.restartGeneration += 1;
      this.state = 'running';
      this.publishStatus();

      this.logInfo(
        `Started tvek v${resolvedBinary.version} [source=${resolvedBinary.source}] (${resolvedBinary.executablePath}) args=[server --max-size ${nextConfig.initOptions.maxSize}].`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await nextClient.dispose(1_000).catch(() => {
        // Ignore secondary cleanup error after failed startup.
      });
      this.client = null;
      this.activeBinary = null;
      this.lastError = `Failed to start tvek server: ${message}`;
      this.state = 'error';
      this.publishStatus();
      this.logError(this.lastError);
    }
  }

  private async stopActiveClientInternal(): Promise<void> {
    const existing = this.client;
    if (!existing) {
      return;
    }

    this.client = null;
    this.stoppingIntentionally = true;
    this.state = 'stopping';
    this.publishStatus();

    let guardTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        existing.stop(STOP_TIMEOUT_MS),
        new Promise<void>((resolve) => {
          guardTimer = setTimeout(resolve, HARD_STOP_GUARD_MS);
        }),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logInfo(`Non-fatal warning while stopping tvek server: ${msg}`);
    } finally {
      if (guardTimer !== null) {
        clearTimeout(guardTimer);
      }
      await existing.dispose(1_000).catch(() => {
        // Ensure disposables are cleaned up even if server process already exited.
      });
    }
  }

  private createErrorHandler(): ErrorHandler {
    return {
      error: (error, _message, count) => {
        this.logError(`LSP transport error (count=${count ?? 1}): ${error.message}`);
        if ((count ?? 1) <= MAX_AUTO_RESTARTS) {
          return { action: ErrorAction.Continue, handled: true };
        }
        return { action: ErrorAction.Shutdown, handled: true };
      },
      closed: () => {
        if (this.stoppingIntentionally || this.coordinator.isDisposed) {
          return { action: CloseAction.DoNotRestart, handled: true };
        }

        const now = Date.now();
        this.crashTimestamps = this.crashTimestamps.filter(
          (ts) => now - ts <= CRASH_WINDOW_MS,
        );
        this.crashTimestamps.push(now);

        if (this.crashTimestamps.length <= MAX_AUTO_RESTARTS) {
          this.logError(
            `tvek server exited unexpectedly (attempt ${this.crashTimestamps.length}/${MAX_AUTO_RESTARTS}); restarting…`,
          );
          return { action: CloseAction.Restart, handled: true };
        }

        const fatalMsg = `tvek server crashed more than ${MAX_AUTO_RESTARTS} times within 3 minutes; not restarting automatically.`;
        this.lastError = fatalMsg;
        this.state = 'error';
        this.publishStatus();
        this.logError(fatalMsg);
        return { action: CloseAction.DoNotRestart, handled: true };
      },
    };
  }

  private publishStatus(): void {
    if (!this.coordinator.isDisposed) {
      this.statusPresenter.update(this.getSnapshot());
    }
  }

  private logInfo(message: string): void {
    this.outputChannel.appendLine(`[INFO ${new Date().toISOString()}] ${message}`);
  }

  private logError(message: string): void {
    this.outputChannel.appendLine(`[ERROR ${new Date().toISOString()}] ${message}`);
  }
}
