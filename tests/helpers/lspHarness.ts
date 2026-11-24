// ============================================================================
// In-process language-server harness.
//
// Starts the real `src/server.ts` inside the Jest worker and talks to it over
// a socket with JSON-RPC — the same protocol and handlers an editor uses, and
// the server's code counts towards coverage.  The server is told to connect
// with `--socket=<port>` (vscode-languageserver's own transport switch); the
// harness is the listening side and acts as the client.
//
// The server module holds process-wide state, so start ONE server per test
// file (in `beforeAll`) and stop it in `afterAll`.
// ============================================================================

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  createMessageConnection,
  MessageConnection,
  SocketMessageReader,
  SocketMessageWriter,
  Diagnostic,
} from 'vscode-languageserver/node';

export interface PublishedDiagnostics {
  uri: string;
  diagnostics: Diagnostic[];
}

export interface LspClient {
  connection: MessageConnection;
  /** Root directory of the temporary workspace. */
  root: string;
  /** `window/logMessage` texts received from the server. */
  logs: string[];
  /** Every `textDocument/publishDiagnostics` notification, in order. */
  published: PublishedDiagnostics[];
  /** Editor settings answered to `workspace/configuration` (mutable). */
  editorSettings: Record<string, unknown>;
  uri(relativePath: string): string;
  write(relativePath: string, source: string): string;
  open(relativePath: string, source?: string): string;
  change(relativePath: string, source: string): void;
  close(relativePath: string): void;
  /** Resolve with the first diagnostics publication for `uri` (after the
   *  `since` index of `published`) that satisfies `accept`. */
  waitForDiagnostics(
    uri: string,
    accept?: (diagnostics: Diagnostic[]) => boolean,
    since?: number,
  ): Promise<Diagnostic[]>;
  request<R>(method: string, params: unknown): Promise<R>;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Files of the workspace, written before the server starts. */
  files?: Record<string, string>;
  editorSettings?: Record<string, unknown>;
  initializationOptions?: Record<string, unknown>;
  linkSupport?: boolean;
  dynamicWatchers?: boolean;
  /** Open a multi-root workspace: these folders (relative to the temporary
   *  directory) are sent as `workspaceFolders`, and the client reports
   *  workspace-folder changes.  Default: the directory itself, as `rootUri`. */
  workspaceFolders?: string[];
}

const WAIT_TIMEOUT_MS = 15000;

export async function startLanguageServer(options: StartOptions = {}): Promise<LspClient> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hinmil-lsp-')));
  const write = (relativePath: string, source: string): string => {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
    return filePath;
  };
  for (const [relativePath, source] of Object.entries(options.files ?? {})) write(relativePath, source);

  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  const accepted = new Promise<net.Socket>(resolve => listener.once('connection', resolve));

  const savedArgv = process.argv;
  process.argv = [savedArgv[0], 'server.js', `--socket=${port}`];
  try {
    jest.isolateModules(() => {
      require('../../src/server');
    });
  } finally {
    process.argv = savedArgv;
  }
  const socket = await accepted;

  const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
  const logs: string[] = [];
  const published: PublishedDiagnostics[] = [];
  const waiters: Array<() => void> = [];
  const client: LspClient = {
    connection,
    root,
    logs,
    published,
    editorSettings: { diagnostics: { debounceMs: 10 }, ...(options.editorSettings ?? {}) },
    uri: (relativePath) => pathToFileURL(path.join(root, relativePath)).href,
    write,
    open(relativePath, source) {
      const text = source ?? fs.readFileSync(path.join(root, relativePath), 'utf8');
      const languageId = relativePath.endsWith('.hm') ? 'hm' : 'javascript';
      connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri: client.uri(relativePath), languageId, version: 1, text },
      });
      openDocuments.add(relativePath);
      return client.uri(relativePath);
    },
    change(relativePath, source) {
      versions.set(relativePath, (versions.get(relativePath) ?? 1) + 1);
      connection.sendNotification('textDocument/didChange', {
        textDocument: { uri: client.uri(relativePath), version: versions.get(relativePath) },
        contentChanges: [{ text: source }],
      });
    },
    close(relativePath) {
      openDocuments.delete(relativePath);
      connection.sendNotification('textDocument/didClose', { textDocument: { uri: client.uri(relativePath) } });
    },
    waitForDiagnostics(uri, accept = () => true, since = 0) {
      return new Promise<Diagnostic[]>((resolve, reject) => {
        const check = (): boolean => {
          for (let index = since; index < published.length; index++) {
            const entry = published[index];
            if (entry.uri === uri && accept(entry.diagnostics)) {
              resolve(entry.diagnostics);
              return true;
            }
          }
          return false;
        };
        if (check()) return;
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`No matching diagnostics for ${uri} within ${WAIT_TIMEOUT_MS} ms`));
        }, WAIT_TIMEOUT_MS);
        const waiter = (): void => {
          if (check()) {
            clearTimeout(timer);
            waiters.splice(waiters.indexOf(waiter), 1);
          }
        };
        waiters.push(waiter);
      });
    },
    request: <R>(method: string, params: unknown) => connection.sendRequest(method, params) as Promise<R>,
    async stop() {
      // Close every open document first: that cancels the server's pending
      // (debounced) validations, which would otherwise fire on a closed
      // connection.  The shutdown round-trip guarantees they were handled.
      for (const relativePath of [...openDocuments]) client.close(relativePath);
      await connection.sendRequest('shutdown');
      connection.dispose();
      socket.destroy();
      await new Promise<void>(resolve => listener.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  const versions = new Map<string, number>();
  const openDocuments = new Set<string>();

  connection.onNotification('window/logMessage', (params: { message: string }) => {
    logs.push(params.message);
  });
  connection.onNotification('textDocument/publishDiagnostics', (params: PublishedDiagnostics) => {
    published.push(params);
    for (const waiter of [...waiters]) waiter();
  });
  connection.onRequest('workspace/configuration', (params: { items: Array<{ section?: string }> }) =>
    params.items.map(() => client.editorSettings));
  connection.onRequest('client/registerCapability', () => null);
  connection.onRequest('client/unregisterCapability', () => null);
  connection.listen();

  const folders = options.workspaceFolders?.map(folder => ({
    uri: client.uri(folder),
    name: path.basename(folder),
  }));
  await connection.sendRequest('initialize', {
    processId: null,
    rootUri: folders ? folders[0].uri : pathToFileURL(root).href,
    ...(folders ? { workspaceFolders: folders } : {}),
    capabilities: {
      textDocument: { definition: { linkSupport: options.linkSupport ?? true } },
      workspace: {
        configuration: true,
        workspaceFolders: folders !== undefined,
        didChangeWatchedFiles: { dynamicRegistration: options.dynamicWatchers ?? true },
      },
    },
    initializationOptions: options.initializationOptions ?? {},
  });
  connection.sendNotification('initialized', {});
  return client;
}
