// src/extension.ts — VS Code client entry point, tested with a virtual
// 'vscode' mock and a stubbed LanguageClient.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const showInformationMessage = jest.fn();
const executeCommand = jest.fn();
const registerCommand: jest.Mock = jest.fn((_id: string, _cb: unknown) => ({ dispose: jest.fn() }));
const onDidChangeConfiguration: jest.Mock = jest.fn((_cb: unknown) => ({ dispose: jest.fn() }));
const onDidChangeWorkspaceFolders: jest.Mock = jest.fn((_cb: unknown) => ({ dispose: jest.fn() }));
const createFileSystemWatcher: jest.Mock = jest.fn(() => ({
  dispose: jest.fn(),
  onDidCreate: jest.fn(() => ({ dispose: jest.fn() })),
  onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
  onDidDelete: jest.fn(() => ({ dispose: jest.fn() })),
}));
const getConfiguration = jest.fn();
/** Installed extensions by id (a disabled extension is simply absent). */
let installedExtensions = new Set<string>();
const onDidChangeExtensions: jest.Mock = jest.fn((_cb: unknown) => ({ dispose: jest.fn() }));
const sendNotification = jest.fn().mockResolvedValue(undefined);
let workspaceFolders: Array<{ uri: { fsPath: string } }> = [];

jest.mock(
  'vscode',
  () => ({
    workspace: {
      getConfiguration: (...a: unknown[]) => getConfiguration(...(a as [])),
      onDidChangeConfiguration: (...a: unknown[]) => onDidChangeConfiguration(...(a as [])),
      onDidChangeWorkspaceFolders: (...a: unknown[]) => onDidChangeWorkspaceFolders(...(a as [])),
      createFileSystemWatcher: (...a: unknown[]) => createFileSystemWatcher(...(a as [])),
      get workspaceFolders() { return workspaceFolders; },
    },
    window: {
      showInformationMessage: (...a: unknown[]) => showInformationMessage(...(a as [])),
    },
    commands: {
      executeCommand: (...a: unknown[]) => executeCommand(...(a as [])),
      registerCommand: (...a: unknown[]) => registerCommand(...(a as [])),
    },
    extensions: {
      getExtension: (id: string) => (installedExtensions.has(id) ? { id } : undefined),
      onDidChange: (...a: unknown[]) => onDidChangeExtensions(...(a as [])),
    },
  }),
  { virtual: true },
);

const clientStart = jest.fn().mockResolvedValue(undefined);
const clientStop = jest.fn().mockResolvedValue(undefined);
const languageClientCtor = jest.fn();

jest.mock(
  'vscode-languageclient/node',
  () => ({
    TransportKind: { ipc: 'ipc' },
    LanguageClient: class {
      constructor(...args: unknown[]) {
        languageClientCtor(...args);
      }
      start = clientStart;
      stop = clientStop;
      sendNotification = sendNotification;
    },
  }),
  { virtual: true },
);

// ---------------------------------------------------------------------------
// Fixture: a fake extension directory with a syntaxes/ folder
// ---------------------------------------------------------------------------

const ROOT = path.join(os.tmpdir(), 'hm-test-extension');
const SYNTAX_DIR = path.join(ROOT, 'syntaxes');
const ACTIVE = path.join(SYNTAX_DIR, 'hm-injection.tmLanguage.json');
const FULL = path.join(SYNTAX_DIR, 'hm-injection.full.tmLanguage.json');
const FULL_CONTENT = JSON.stringify({ name: 'full grammar', patterns: [{ match: 'x' }] });

function makeContext() {
  return {
    extensionPath: ROOT,
    asAbsolutePath: (rel: string) => path.join(ROOT, rel),
    subscriptions: [] as unknown[],
  };
}

function setHighlightingEnabled(enabled: boolean) {
  setSettings({ 'syntaxHighlighting.enabled': enabled });
}

/** Configure the `hinmil.*` settings returned by the workspace mock. */
function setSettings(overrides: Record<string, unknown>) {
  const settings: Record<string, unknown> = {
    'syntaxHighlighting.enabled': true,
    enable: true,
    requiresConfig: false,
    ...overrides,
  };
  getConfiguration.mockReturnValue({
    get: (key: string, dflt: unknown) => (key in settings ? settings[key] : dflt),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  workspaceFolders = [];
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(SYNTAX_DIR, { recursive: true });
  fs.writeFileSync(FULL, FULL_CONTENT, 'utf-8');
  fs.writeFileSync(ACTIVE, '{}', 'utf-8');
});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe('deactivate before activate', () => {
  test('returns undefined when no client was started', () => {
    jest.isolateModules(() => {
      const ext = require('../../src/extension') as typeof import('../../src/extension');
      expect(ext.deactivate()).toBeUndefined();
    });
  });
});

describe('activate', () => {
  function load() {
    let ext!: typeof import('../../src/extension');
    jest.isolateModules(() => {
      ext = require('../../src/extension');
    });
    return ext;
  }

  test('syncs grammar to the full file and prompts for reload', () => {
    setHighlightingEnabled(true);
    showInformationMessage.mockResolvedValue('Reload');
    const ctx = makeContext();
    load().activate(ctx as never);

    expect(fs.readFileSync(ACTIVE, 'utf-8')).toBe(FULL_CONTENT);
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Reload window'),
      'Reload',
    );
    expect(languageClientCtor).toHaveBeenCalledWith(
      'hinmil',
      'Hindley-Milner JS',
      expect.objectContaining({ run: expect.objectContaining({ transport: 'ipc' }) }),
      expect.objectContaining({ documentSelector: expect.any(Array) }),
    );
    expect(clientStart).toHaveBeenCalled();
    // Source files are watched via server-side dynamic registration; the
    // client only watches config files statically.
    expect(createFileSystemWatcher).toHaveBeenCalledWith('**/package.json');
    expect(createFileSystemWatcher).toHaveBeenCalledWith('**/hinmil.config.json');
    expect(createFileSystemWatcher).toHaveBeenCalledWith('**/hinmil.config.js');
    expect(createFileSystemWatcher).not.toHaveBeenCalledWith('**/*');
  });

  test('choosing Reload in the prompt triggers a window reload', async () => {
    setHighlightingEnabled(true);
    showInformationMessage.mockResolvedValue('Reload');
    load().activate(makeContext() as never);
    await Promise.resolve();
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  test('dismissing the prompt does not reload', async () => {
    setHighlightingEnabled(true);
    showInformationMessage.mockResolvedValue(undefined);
    load().activate(makeContext() as never);
    await Promise.resolve();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test('no prompt when the grammar file already matches', () => {
    setHighlightingEnabled(true);
    fs.writeFileSync(ACTIVE, FULL_CONTENT, 'utf-8');
    load().activate(makeContext() as never);
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  test('disabling highlighting writes the empty grammar', () => {
    setHighlightingEnabled(false);
    showInformationMessage.mockResolvedValue(undefined);
    fs.writeFileSync(ACTIVE, FULL_CONTENT, 'utf-8');
    load().activate(makeContext() as never);
    const active = JSON.parse(fs.readFileSync(ACTIVE, 'utf-8'));
    expect(active.patterns).toEqual([]);
    expect(active.name).toContain('disabled');
    expect(showInformationMessage).toHaveBeenCalled();
  });

  test('missing syntaxes directory is tolerated (no prompt, no crash)', () => {
    setHighlightingEnabled(true);
    fs.rmSync(SYNTAX_DIR, { recursive: true, force: true });
    expect(() => load().activate(makeContext() as never)).not.toThrow();
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  test('configuration-change listener re-syncs the grammar', () => {
    setHighlightingEnabled(true);
    showInformationMessage.mockResolvedValue(undefined);
    fs.writeFileSync(ACTIVE, FULL_CONTENT, 'utf-8');
    load().activate(makeContext() as never);
    expect(showInformationMessage).not.toHaveBeenCalled();

    // Flip the setting off and fire the listener.
    setHighlightingEnabled(false);
    const listener = onDidChangeConfiguration.mock.calls[0][0] as (e: unknown) => void;
    listener({ affectsConfiguration: (s: string) => s === 'hinmil.syntaxHighlighting.enabled' });
    expect(JSON.parse(fs.readFileSync(ACTIVE, 'utf-8')).patterns).toEqual([]);
    expect(showInformationMessage).toHaveBeenCalledTimes(1);

    // Unrelated config changes are ignored.
    showInformationMessage.mockClear();
    listener({ affectsConfiguration: () => false });
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  test('restart command stops and restarts the client', async () => {
    setHighlightingEnabled(true);
    showInformationMessage.mockResolvedValue(undefined);
    const ext = load();
    ext.activate(makeContext() as never);

    const restartCall = registerCommand.mock.calls.find(c => c[0] === 'hinmil.restartServer');
    expect(restartCall).toBeDefined();
    clientStart.mockClear();
    await (restartCall![1] as () => Promise<void>)();
    expect(clientStop).toHaveBeenCalled();
    expect(clientStart).toHaveBeenCalled();
    expect(showInformationMessage).toHaveBeenCalledWith('HinMil server restarted.');

    // deactivate stops the running client
    clientStop.mockClear();
    ext.deactivate();
    expect(clientStop).toHaveBeenCalled();
  });

  test('hinmil.enable: false prevents the client from starting', () => {
    setSettings({ enable: false });
    load().activate(makeContext() as never);
    expect(languageClientCtor).not.toHaveBeenCalled();
    expect(clientStart).not.toHaveBeenCalled();
  });

  test('requiresConfig without project config keeps the server off', () => {
    setSettings({ requiresConfig: true });
    workspaceFolders = [{ uri: { fsPath: ROOT } }]; // ROOT has no hinmil config
    load().activate(makeContext() as never);
    expect(languageClientCtor).not.toHaveBeenCalled();
  });

  test('requiresConfig starts the server when a folder has hinmil config', () => {
    setSettings({ requiresConfig: true });
    fs.writeFileSync(path.join(ROOT, 'hinmil.config.json'),
      JSON.stringify({ globals: ['./server/globals.hm'] }));
    workspaceFolders = [{ uri: { fsPath: ROOT } }];
    load().activate(makeContext() as never);
    expect(languageClientCtor).toHaveBeenCalled();
    expect(clientStart).toHaveBeenCalled();
  });

  test('requiresConfig accepts an "hinmil" key in package.json', () => {
    setSettings({ requiresConfig: true });
    fs.writeFileSync(path.join(ROOT, 'package.json'),
      JSON.stringify({ name: 'server', 'hinmil': { globals: ['./globals.hm'] } }));
    workspaceFolders = [{ uri: { fsPath: ROOT } }];
    load().activate(makeContext() as never);
    expect(languageClientCtor).toHaveBeenCalled();
  });

  test('project-config "enable": false opts the folder out', () => {
    setSettings({});
    fs.writeFileSync(path.join(ROOT, 'hinmil.config.json'),
      JSON.stringify({ enable: false }));
    workspaceFolders = [{ uri: { fsPath: ROOT } }];
    load().activate(makeContext() as never);
    expect(languageClientCtor).not.toHaveBeenCalled();
    expect(clientStart).not.toHaveBeenCalled();
  });

  test('"enable": false under package.json "hinmil" key opts the folder out', () => {
    setSettings({});
    fs.writeFileSync(path.join(ROOT, 'package.json'),
      JSON.stringify({ name: 'app', 'hinmil': { enable: false } }));
    workspaceFolders = [{ uri: { fsPath: ROOT } }];
    load().activate(makeContext() as never);
    expect(languageClientCtor).not.toHaveBeenCalled();
  });

  test('an opted-out folder does not satisfy requiresConfig', () => {
    setSettings({ requiresConfig: true });
    fs.writeFileSync(path.join(ROOT, 'hinmil.config.json'),
      JSON.stringify({ enable: false, globals: ['./globals.hm'] }));
    workspaceFolders = [{ uri: { fsPath: ROOT } }];
    load().activate(makeContext() as never);
    expect(languageClientCtor).not.toHaveBeenCalled();
  });

  test('config-file watcher stops the server when "enable": false appears', () => {
    setSettings({});
    workspaceFolders = [{ uri: { fsPath: ROOT } }];
    load().activate(makeContext() as never);
    expect(clientStart).toHaveBeenCalledTimes(1);

    const watcher = createFileSystemWatcher.mock.results[0].value as {
      onDidCreate: jest.Mock;
    };
    const onCreate = watcher.onDidCreate.mock.calls[0][0] as () => void;
    fs.writeFileSync(path.join(ROOT, 'hinmil.config.json'),
      JSON.stringify({ enable: false }));
    onCreate();
    expect(clientStop).toHaveBeenCalledTimes(1);
  });

  test('toggling hinmil.enable at runtime stops and restarts the client', () => {
    setSettings({});
    load().activate(makeContext() as never);
    expect(clientStart).toHaveBeenCalledTimes(1);

    const listener = onDidChangeConfiguration.mock.calls[0][0] as (e: unknown) => void;
    const affectsEnable = { affectsConfiguration: (s: string) => s === 'hinmil.enable' };

    setSettings({ enable: false });
    listener(affectsEnable);
    expect(clientStop).toHaveBeenCalledTimes(1);

    setSettings({ enable: true });
    listener(affectsEnable);
    expect(clientStart).toHaveBeenCalledTimes(2);
  });

  test('restart command refuses to start while disabled', async () => {
    setSettings({ enable: false });
    load().activate(makeContext() as never);
    const restartCall = registerCommand.mock.calls.find(c => c[0] === 'hinmil.restartServer');
    await (restartCall![1] as () => Promise<void>)();
    expect(clientStart).not.toHaveBeenCalled();
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('disabled'),
    );
  });

  test('config-file watcher creation starts a dormant server once config appears', () => {
    setSettings({ requiresConfig: true });
    workspaceFolders = [{ uri: { fsPath: ROOT } }];
    load().activate(makeContext() as never);
    expect(languageClientCtor).not.toHaveBeenCalled();

    // The config watcher is the first watcher created during activate().
    const watcher = createFileSystemWatcher.mock.results[0].value as {
      onDidCreate: jest.Mock;
    };
    const onCreate = watcher.onDidCreate.mock.calls[0][0] as () => void;

    fs.writeFileSync(path.join(ROOT, 'hinmil.config.json'),
      JSON.stringify({ globals: ['./globals.hm'] }));
    onCreate();
    expect(languageClientCtor).toHaveBeenCalled();
  });

  test('tells the server whether the built-in TS/JS extension is active, also after a change', () => {
    setSettings({});
    installedExtensions = new Set(['vscode.typescript-language-features']);
    load().activate(makeContext() as never);
    const options = languageClientCtor.mock.calls[0][3] as { initializationOptions: unknown };
    expect(options.initializationOptions).toEqual({ typescriptLanguageFeatures: true });

    // The user disables the extension in this workspace.
    installedExtensions = new Set();
    const onChange = onDidChangeExtensions.mock.calls[0][0] as () => void;
    onChange();
    expect(sendNotification).toHaveBeenCalledWith('hinmil/typescriptLanguageFeatures', { active: false });
    installedExtensions = new Set();
  });
});
