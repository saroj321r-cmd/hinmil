// ============================================================================
// A multi-root workspace: several independent projects opened side by side
// in one editor window.  Every workspace folder is its own project — its own
// configuration, globals, file selection and settings — and folders can be
// added while the server runs.
//
//   shop/     a web shop; its `Customer` has loyalty points; hover is off
//   billing/  invoicing; its `Customer` has an IBAN; only `lib/` is checked
//   legacy/   an old project that opts out with `"enable": false`
//   reports/  not part of the workspace until it is added later
// ============================================================================

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { startLanguageServer, LspClient } from '../helpers/lspHarness';

const files: Record<string, string> = {
  'shop/hinmil.config.json': JSON.stringify({ settings: { hover: { enabled: false } } }),
  'shop/globals.hm': 'Customer :: { name :: String, points :: Number }\n',
  'shop/src/loyalty.js': [
    '// bonus :: Customer -> Number',
    'export const bonus = (customer) => customer.points * 2;',
    '',
  ].join('\n'),
  'billing/hinmil.config.json': JSON.stringify({ files: { include: ['lib/**'] } }),
  'billing/globals.hm': 'Customer :: { name :: String, iban :: String }\n',
  'billing/lib/invoice.js': [
    '// payee :: Customer -> String',
    'export const payee = (customer) => customer.name + " " + customer.iban;',
    '',
    '// rounded :: Number -> Number',
    'export const rounded = (amount) => Math.round (amount);',
    '',
    'export const broken = rounded ("12.50");',
    '',
  ].join('\n'),
  'billing/scripts/once.js': 'export const oops = Math.round ("x");\n',
  'legacy/hinmil.config.json': JSON.stringify({ enable: false }),
  'legacy/src/old.js': 'export const oops = Math.round ("x");\n',
  'reports/src/monthly.js': 'export const oops = Math.round ("x");\n',
};

const errorsOf = (diagnostics: Diagnostic[]): Diagnostic[] =>
  diagnostics.filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error);

let lsp: LspClient;

beforeAll(async () => {
  lsp = await startLanguageServer({ files, workspaceFolders: ['shop', 'billing', 'legacy'] });
});

afterAll(async () => {
  await lsp.stop();
});

describe('every workspace folder is its own project', () => {
  test('a file in the first folder is checked against that folder\'s globals', async () => {
    const uri = lsp.open('shop/src/loyalty.js');
    expect(errorsOf(await lsp.waitForDiagnostics(uri))).toEqual([]);
  });

  test('a file in another folder is checked too, against its own globals', async () => {
    const uri = lsp.open('billing/lib/invoice.js');
    const errors = errorsOf(await lsp.waitForDiagnostics(uri));
    // `customer.iban` is fine (billing's Customer); only the string argument fails.
    expect(errors).toHaveLength(1);
    expect(errors[0].range.start.line).toBe(6);
  });

  test('each folder has its own file selection', async () => {
    const uri = lsp.open('billing/scripts/once.js');
    expect(await lsp.waitForDiagnostics(uri)).toEqual([]);
  });

  test('each folder has its own settings', async () => {
    const shopHover = await lsp.request('textDocument/hover', {
      textDocument: { uri: lsp.uri('shop/src/loyalty.js') },
      position: { line: 1, character: 15 },
    });
    expect(shopHover).toBeNull();
    const billingHover = await lsp.request<{ contents: unknown } | null>('textDocument/hover', {
      textDocument: { uri: lsp.uri('billing/lib/invoice.js') },
      position: { line: 1, character: 15 },
    });
    expect(JSON.stringify(billingHover?.contents)).toContain('Customer -> String');
  });

  test('a folder that opts out is not checked and gets no answers', async () => {
    const uri = lsp.open('legacy/src/old.js');
    expect(await lsp.waitForDiagnostics(uri)).toEqual([]);
    const hover = await lsp.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 0, character: 15 },
    });
    expect(hover).toBeNull();
  });
});

describe('workspace folders change while the server runs', () => {
  test('a file outside every folder is checked once its folder is added', async () => {
    const uri = lsp.open('reports/src/monthly.js');
    expect(await lsp.waitForDiagnostics(uri)).toEqual([]);

    const since = lsp.published.length;
    lsp.connection.sendNotification('workspace/didChangeWorkspaceFolders', {
      event: { added: [{ uri: lsp.uri('reports'), name: 'reports' }], removed: [] },
    });
    const errors = errorsOf(await lsp.waitForDiagnostics(uri, diagnostics => errorsOf(diagnostics).length > 0, since));
    expect(errors).toHaveLength(1);
  });

  test('a removed folder is no longer checked', async () => {
    const since = lsp.published.length;
    lsp.connection.sendNotification('workspace/didChangeWorkspaceFolders', {
      event: { added: [], removed: [{ uri: lsp.uri('reports'), name: 'reports' }] },
    });
    const diagnostics = await lsp.waitForDiagnostics(lsp.uri('reports/src/monthly.js'), undefined, since);
    expect(diagnostics).toEqual([]);
  });
});
