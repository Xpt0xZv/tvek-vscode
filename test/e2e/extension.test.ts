import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { TvekExtensionApi } from '../../src/types.js';

const EXTENSION_ID = 'xpt0xzv.tvek-vscode';

function resolveTestServerBinaryPath(): string {
  const localEnv = process.env.TVEK_LOCAL_BIN;
  if (localEnv && fs.existsSync(localEnv) && fs.statSync(localEnv).isFile()) {
    return path.resolve(localEnv);
  }

  const repoRoot =
    process.env.TVEK_E2E_REPO_ROOT ??
    path.resolve(__dirname, '..', '..', '..');
  const binName = process.platform === 'win32' ? 'tvek.exe' : 'tvek';
  const bundledCandidate = path.join(repoRoot, 'bundled', 'bin', binName);
  if (
    fs.existsSync(bundledCandidate) &&
    fs.statSync(bundledCandidate).isFile()
  ) {
    return bundledCandidate;
  }

  return path.join(repoRoot, 'test', 'fixtures', 'mock-tvek-lsp.mjs');
}

async function waitForDiagnostics(
  uri: vscode.Uri,
  predicate: (diagnostics: readonly vscode.Diagnostic[]) => boolean,
  timeoutMs = 8_000,
): Promise<readonly vscode.Diagnostic[]> {
  const immediate = vscode.languages.getDiagnostics(uri);
  if (predicate(immediate)) {
    return immediate;
  }

  return new Promise<readonly vscode.Diagnostic[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      const latest = vscode.languages.getDiagnostics(uri);
      if (predicate(latest)) {
        resolve(latest);
        return;
      }
      reject(
        new Error(
          `Timed out waiting for diagnostics on ${uri.toString()} (current count=${latest.length}).`,
        ),
      );
    }, timeoutMs);

    const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
      if (
        event.uris.some((changed) => changed.toString() === uri.toString())
      ) {
        const current = vscode.languages.getDiagnostics(uri);
        if (predicate(current)) {
          clearTimeout(timer);
          subscription.dispose();
          resolve(current);
        }
      }
    });
  });
}

async function resetTvekSettings(binaryPath: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('tvek');
  await cfg.update('enable', true, vscode.ConfigurationTarget.Global);
  await cfg.update('path', binaryPath, vscode.ConfigurationTarget.Global);
  await cfg.update('sortKeys', false, vscode.ConfigurationTarget.Global);
  await cfg.update('strict', false, vscode.ConfigurationTarget.Global);
  await cfg.update('structural', false, vscode.ConfigurationTarget.Global);
  await cfg.update('lineWidth', 80, vscode.ConfigurationTarget.Global);
  await cfg.update('minify', false, vscode.ConfigurationTarget.Global);
}

suite('tvek-vscode E2E Extension Host Suite', () => {
  const serverPath = resolveTestServerBinaryPath();
  let api!: TvekExtensionApi;
  let workspaceDir!: string;
  const createdFiles: vscode.Uri[] = [];

  suiteSetup(async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'Expected E2E workspace folder to be open');
    workspaceDir = folder.uri.fsPath;

    await resetTvekSettings(serverPath);

    // Open a seed JSON document to trigger `onLanguage:json` activation naturally
    const seedUri = vscode.Uri.file(path.join(workspaceDir, 'seed.json'));
    fs.writeFileSync(seedUri.fsPath, '{"ok": true}\n', 'utf8');
    createdFiles.push(seedUri);

    const doc = await vscode.workspace.openTextDocument(seedUri);
    await vscode.window.showTextDocument(doc);

    const ext = vscode.extensions.getExtension<TvekExtensionApi>(EXTENSION_ID);
    assert.ok(ext, `Extension ${EXTENSION_ID} not found`);
    api = ext.isActive ? ext.exports : await ext.activate();

    const snapshot = await api.waitForIdle();
    assert.equal(snapshot.state, 'running', snapshot.lastError ?? undefined);
    assert.ok(snapshot.binary !== null);
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetTvekSettings(serverPath);
    if (api) {
      await api.waitForIdle();
    }
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const cfg = vscode.workspace.getConfiguration('tvek');
    await cfg.update('enable', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('path', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('sortKeys', undefined, vscode.ConfigurationTarget.Global);
    for (const uri of createdFiles) {
      fs.rmSync(uri.fsPath, { force: true });
    }
  });

  test('1. publishes tvek diagnostics on invalid JSON (didOpen/didChange) and clears on close', async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: 'json',
      content: '{\n  "alpha": 1,\n  "beta": 2,\n}\n',
    });
    const editor = await vscode.window.showTextDocument(doc);
    const targetUri = doc.uri;

    const diagsOnOpen = await waitForDiagnostics(targetUri, (list) =>
      list.some((d) => d.source === 'tvek'),
    );
    assert.ok(
      diagsOnOpen.some((d) => d.source === 'tvek'),
      'Expected trailing-comma diagnostic from tvek on didOpen',
    );

    // Fix trailing comma via didChange -> tvek diagnostics clear
    await editor.edit((editBuilder) => {
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        doc.lineAt(doc.lineCount - 1).range.end,
      );
      editBuilder.replace(fullRange, '{\n  "alpha": 1,\n  "beta": 2\n}\n');
    });
    const diagsAfterEdit = await waitForDiagnostics(
      targetUri,
      (list) => list.filter((d) => d.source === 'tvek').length === 0,
    );
    assert.equal(
      diagsAfterEdit.filter((d) => d.source === 'tvek').length,
      0,
      'Expected tvek diagnostics to clear on valid JSON edit',
    );

    // Re-introduce trailing comma, then close document -> didClose clears tvek diagnostics
    await editor.edit((editBuilder) => {
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        doc.lineAt(doc.lineCount - 1).range.end,
      );
      editBuilder.replace(fullRange, '{\n  "alpha": 1,\n}\n');
    });
    await waitForDiagnostics(targetUri, (list) =>
      list.some((d) => d.source === 'tvek'),
    );

    await vscode.commands.executeCommand(
      'workbench.action.revertAndCloseActiveEditor',
    );
    const diagsAfterClose = await waitForDiagnostics(
      targetUri,
      (list) => list.filter((d) => d.source === 'tvek').length === 0,
    );
    assert.equal(diagsAfterClose.filter((d) => d.source === 'tvek').length, 0);
  });

  test('2. formats JSON documents honoring insertSpaces and tabSize', async () => {
    const fileUri = vscode.Uri.file(path.join(workspaceDir, 'format.json'));
    fs.writeFileSync(
      fileUri.fsPath,
      '{"zebra":1,"alpha":[1,2,3]}',
      'utf8',
    );
    createdFiles.push(fileUri);

    const doc = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(doc);

    const spaceEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatDocumentProvider',
      fileUri,
      { insertSpaces: true, tabSize: 4 },
    );
    assert.ok(spaceEdits && spaceEdits.length > 0, 'Expected formatting edits');

    const wsEdit = new vscode.WorkspaceEdit();
    wsEdit.set(fileUri, spaceEdits);
    await vscode.workspace.applyEdit(wsEdit);

    const textWithSpaces = doc.getText();
    assert.ok(
      textWithSpaces.includes('    "zebra": 1'),
      `Expected 4-space indentation, got:\n${textWithSpaces}`,
    );
    assert.ok(
      textWithSpaces.indexOf('"zebra"') < textWithSpaces.indexOf('"alpha"'),
      'Expected original key order when sortKeys is false',
    );

    const tabEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatDocumentProvider',
      fileUri,
      { insertSpaces: false, tabSize: 2 },
    );
    assert.ok(tabEdits && tabEdits.length > 0, 'Expected tab formatting edits');

    const tabWsEdit = new vscode.WorkspaceEdit();
    tabWsEdit.set(fileUri, tabEdits);
    await vscode.workspace.applyEdit(tabWsEdit);

    assert.ok(
      doc.getText().includes('\t"zebra": 1'),
      `Expected tab indentation, got:\n${doc.getText()}`,
    );
  });

  test('3. provides source.fixAll.tvek code action and executes tvek.fixAll command', async () => {
    const fileUri = vscode.Uri.file(path.join(workspaceDir, 'fixall.json'));
    fs.writeFileSync(
      fileUri.fsPath,
      '{\n  "first": 10,\n  "second": 20,\n}\n',
      'utf8',
    );
    createdFiles.push(fileUri);

    const doc = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(doc);

    await waitForDiagnostics(fileUri, (list) =>
      list.some((d) => d.source === 'tvek'),
    );

    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      doc.lineAt(doc.lineCount - 1).range.end,
    );
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      fileUri,
      fullRange,
      'source.fixAll.tvek',
    );
    assert.ok(
      actions && actions.length > 0,
      'Expected source.fixAll.tvek code action to be registered',
    );

    const applied = await vscode.commands.executeCommand<boolean>('tvek.fixAll');
    assert.equal(applied, true, 'Expected tvek.fixAll to apply WorkspaceEdit');

    const parsed = JSON.parse(doc.getText()) as { first: number; second: number };
    assert.deepEqual(parsed, { first: 10, second: 20 });

    const remainingDiags = await waitForDiagnostics(
      fileUri,
      (list) => list.filter((d) => d.source === 'tvek').length === 0,
    );
    assert.equal(remainingDiags.filter((d) => d.source === 'tvek').length, 0);
  });

  test('4. cleanly stops and restarts LanguageClient when tvek.sortKeys changes', async () => {
    const fileUri = vscode.Uri.file(path.join(workspaceDir, 'sortkeys.json'));
    fs.writeFileSync(
      fileUri.fsPath,
      '{"zebra": 1, "alpha": 2, "middle": 3}\n',
      'utf8',
    );
    createdFiles.push(fileUri);

    const doc = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(doc);

    const beforeSnapshot = await api.waitForIdle();
    const beforeGen = beforeSnapshot.restartGeneration;

    const unsortedEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatDocumentProvider',
      fileUri,
      { insertSpaces: true, tabSize: 2 },
    );
    if (unsortedEdits && unsortedEdits.length > 0) {
      const e = new vscode.WorkspaceEdit();
      e.set(fileUri, unsortedEdits);
      await vscode.workspace.applyEdit(e);
    }
    assert.ok(
      doc.getText().indexOf('"zebra"') < doc.getText().indexOf('"alpha"'),
      'Keys should remain unsorted before enabling tvek.sortKeys',
    );

    // Mutate `tvek.sortKeys` -> triggers debounced full stop+start cycle
    const cfg = vscode.workspace.getConfiguration('tvek');
    await cfg.update('sortKeys', true, vscode.ConfigurationTarget.Global);

    const afterSnapshot = await api.waitForIdle();
    assert.equal(afterSnapshot.state, 'running');
    assert.equal(afterSnapshot.config.initOptions.sortKeys, true);
    assert.ok(
      afterSnapshot.restartGeneration > beforeGen,
      `Expected restartGeneration (${afterSnapshot.restartGeneration}) > ${beforeGen}`,
    );

    const sortedEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatDocumentProvider',
      fileUri,
      { insertSpaces: true, tabSize: 2 },
    );
    assert.ok(
      sortedEdits && sortedEdits.length > 0,
      'Expected formatting edits after enabling sortKeys',
    );

    const wsEdit = new vscode.WorkspaceEdit();
    wsEdit.set(fileUri, sortedEdits);
    await vscode.workspace.applyEdit(wsEdit);

    const finalText = doc.getText();
    const alphaIdx = finalText.indexOf('"alpha"');
    const middleIdx = finalText.indexOf('"middle"');
    const zebraIdx = finalText.indexOf('"zebra"');
    assert.ok(
      alphaIdx !== -1 && alphaIdx < middleIdx && middleIdx < zebraIdx,
      `Expected sorted keys ("alpha" < "middle" < "zebra"), got:\n${finalText}`,
    );
  });

  test('5. transitions cleanly across disable, fail-closed invalid path, and tvek.restartServer recovery', async () => {
    const initial = await api.waitForIdle();
    assert.equal(initial.state, 'running');
    const initialGen = initial.restartGeneration;

    const cfg = vscode.workspace.getConfiguration('tvek');

    // Disable server -> stops cleanly and enters disabled state
    await cfg.update('enable', false, vscode.ConfigurationTarget.Global);
    const disabledSnap = await api.waitForIdle();
    assert.equal(disabledSnap.state, 'disabled');
    assert.equal(disabledSnap.binary, null);

    // Re-enable with invalid custom tvek.path -> fails closed into error state (no silent fallback)
    const missingCustom = path.join(workspaceDir, 'nonexistent-tvek-binary');
    await cfg.update('path', missingCustom, vscode.ConfigurationTarget.Global);
    await cfg.update('enable', true, vscode.ConfigurationTarget.Global);
    const errorSnap = await api.waitForIdle();
    assert.equal(errorSnap.state, 'error');
    assert.equal(errorSnap.binary, null);
    assert.ok((errorSnap.lastError ?? '').length > 0);

    // Restore valid path and invoke manual restart command -> recovers to running
    await cfg.update('path', serverPath, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('tvek.restartServer');
    const recoveredSnap = await api.waitForIdle();
    assert.equal(recoveredSnap.state, 'running');
    assert.ok(recoveredSnap.binary !== null);
    assert.ok(recoveredSnap.restartGeneration > initialGen);
  });
});
