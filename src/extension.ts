// ============================================================================
// VS Code Extension Client — starts hinmil language server
//
// Plain language: the tiny piece that runs inside VS Code itself.  When a
// JavaScript file opens, it launches the language server (server.ts) as a
// separate process, connects the two, and registers a few commands.  All
// actual type checking happens in the server — this is just the ignition key.
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import {
  ExtensionContext,
  workspace,
  window,
  commands,
  extensions,
} from 'vscode';

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

import { hasProjectConfig, loadProjectConfig } from './config';

let client: LanguageClient | undefined;

/** Empty grammar JSON written when syntax highlighting is disabled. */
const EMPTY_GRAMMAR = JSON.stringify({
  "$schema": "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
  "name": "HM Type Annotations in JS Comments (disabled)",
  "scopeName": "hm-injection.js",
  "injectionSelector": "L:source.js -string -comment, L:source.js.jsx -string -comment",
  "patterns": []
}, null, 2);

/**
 * Ensure the active grammar injection file matches the syntaxHighlighting setting.
 * Returns true if the file was changed (reload needed).
 */
function syncGrammarFile(context: ExtensionContext): boolean {
  const enabled = workspace.getConfiguration('hinmil').get<boolean>('syntaxHighlighting.enabled', true);
  const syntaxDir = path.join(context.extensionPath, 'syntaxes');
  const activePath = path.join(syntaxDir, 'hm-injection.tmLanguage.json');
  const fullPath = path.join(syntaxDir, 'hm-injection.full.tmLanguage.json');

  try {
    const current = fs.readFileSync(activePath, 'utf-8');
    if (enabled) {
      const full = fs.readFileSync(fullPath, 'utf-8');
      if (current === full) return false;
      fs.writeFileSync(activePath, full, 'utf-8');
      return true;
    } else {
      if (current === EMPTY_GRAMMAR) return false;
      fs.writeFileSync(activePath, EMPTY_GRAMMAR, 'utf-8');
      return true;
    }
  } catch {
    return false;
  }
}

/** Show a reload prompt when the grammar file was changed. */
function promptReload(): void {
  window.showInformationMessage(
    'Reload window to apply HM syntax highlighting changes.',
    'Reload'
  ).then(choice => {
    if (choice === 'Reload') {
      commands.executeCommand('workbench.action.reloadWindow');
    }
  });
}

/**
 * Should the language server run right now?
 *
 *  - `hinmil.enable: false` (editor setting) disables the server
 *    unconditionally.
 *  - `"enable": false` in a folder's project config (`hinmil.config.json`,
 *    `hinmil.config.js`, or the `"hinmil"` key in `package.json`) opts that
 *    folder out from within the repository itself.
 *  - `hinmil.requiresConfig: true` only starts the server when at least one
 *    (non-opted-out) workspace folder carries explicit hinmil project
 *    configuration.
 */
function shouldRunServer(): boolean {
  const cfg = workspace.getConfiguration('hinmil');
  if (!cfg.get<boolean>('enable', true)) return false;

  const folders = workspace.workspaceFolders ?? [];
  const requiresConfig = cfg.get<boolean>('requiresConfig', false);
  if (folders.length === 0) return !requiresConfig;

  const eligible = folders.filter(
    folder => loadProjectConfig(folder.uri.fsPath).enable !== false
  );
  if (requiresConfig) {
    return eligible.some(folder => hasProjectConfig(folder.uri.fsPath));
  }
  return eligible.length > 0;
}

/** VS Code's built-in TypeScript/JavaScript extension.  A disabled
 *  extension is not listed, so `getExtension` returns undefined. */
const TS_EXTENSION_ID = 'vscode.typescript-language-features';

/** Does the built-in TS/JS extension answer go-to-definition here?  The
 *  server then leaves imports and local names to it (`navigation.definitions:
 *  "auto"`), so the editor never shows the same target twice. */
function typescriptLanguageFeaturesActive(): boolean {
  return extensions.getExtension(TS_EXTENSION_ID) !== undefined;
}

function startClient(context: ExtensionContext): void {
  if (client) return;

  // Path to the compiled server module
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

  // Server runs in a separate Node process, communicating via stdio
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  // The client activates on JavaScript and HM annotation files
  const clientOptions: LanguageClientOptions = {
    initializationOptions: {
      typescriptLanguageFeatures: typescriptLanguageFeaturesActive(),
    },
    documentSelector: [
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'javascriptreact' },
      { scheme: 'file', language: 'hm' },
    ],
    synchronize: {
      fileEvents: [
        // Source-file watchers are registered dynamically by the server for
        // exactly the effective (runtime-configurable) extension set; only
        // config files are watched statically here.
        workspace.createFileSystemWatcher('**/package.json'),
        workspace.createFileSystemWatcher('**/hinmil.config.json'),
        workspace.createFileSystemWatcher('**/hinmil.config.js'),
      ],
    },
  };

  client = new LanguageClient(
    'hinmil',
    'Hindley-Milner JS',
    serverOptions,
    clientOptions,
  );

  // Start the client (which also launches the server)
  client.start();
}

async function stopClient(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  await current.stop();
}

/** Start or stop the client so it matches the current enable/config state. */
function syncClientState(context: ExtensionContext): void {
  if (shouldRunServer()) {
    startClient(context);
  } else {
    void stopClient();
  }
}

export function activate(context: ExtensionContext): void {
  // Sync grammar file on activation (silently — only prompt if a change was needed
  // and the user hasn't reloaded yet)
  if (syncGrammarFile(context)) {
    promptReload();
  }

  // Watch for setting changes
  context.subscriptions.push(
    workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('hinmil.syntaxHighlighting.enabled')) {
        if (syncGrammarFile(context)) {
          promptReload();
        }
      }
      if (
        e.affectsConfiguration('hinmil.enable') ||
        e.affectsConfiguration('hinmil.requiresConfig')
      ) {
        syncClientState(context);
      }
    })
  );

  // With requiresConfig the server may need to start (or stop) when project
  // config files appear/disappear or when workspace folders change.
  const configWatcher = workspace.createFileSystemWatcher(
    '**/{hinmil.config.json,hinmil.config.js,package.json}'
  );
  context.subscriptions.push(
    configWatcher,
    configWatcher.onDidCreate(() => syncClientState(context)),
    configWatcher.onDidChange(() => syncClientState(context)),
    configWatcher.onDidDelete(() => syncClientState(context)),
    workspace.onDidChangeWorkspaceFolders(() => syncClientState(context)),
    // Enabling / disabling the built-in TS/JS extension changes who answers
    // go-to-definition for code.
    extensions.onDidChange(() => {
      void client?.sendNotification('hinmil/typescriptLanguageFeatures', {
        active: typescriptLanguageFeaturesActive(),
      });
    }),
  );

  syncClientState(context);

  // Register restart command
  context.subscriptions.push(
    commands.registerCommand('hinmil.restartServer', async () => {
      await stopClient();
      if (!shouldRunServer()) {
        window.showInformationMessage(
          'HinMil is disabled here (hinmil.enable setting, project-config "enable": false, or hinmil.requiresConfig); server not started.'
        );
        return;
      }
      startClient(context);
      window.showInformationMessage('HinMil server restarted.');
    })
  );
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
