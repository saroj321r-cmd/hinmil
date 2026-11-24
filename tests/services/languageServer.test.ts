// ============================================================================
// The language server end to end: the real `src/server.ts` over JSON-RPC
// (see tests/helpers/lspHarness.ts), on a small order-management monorepo
// with a `server/` and a `client/` application that each have their own
// hinmil configuration and their own `Order` type.
//
// Covers what an editor sees: published diagnostics (open, edit, re-publish
// of an unchanged text, close), per-folder project scopes, hover,
// completion (also the `{` trigger), signature help, go to definition (and
// the TypeScript-extension handshake), document symbols, references, rename,
// code actions, editor-setting and project-config changes, `.hm` files and
// the file selection.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { DiagnosticSeverity, Diagnostic } from 'vscode-languageserver/node';
import { startLanguageServer, LspClient } from '../helpers/lspHarness';

const MONEY = [
  '// formatAmount :: Number -> String',
  'export const formatAmount = (cents) => (cents / 100).toFixed (2);',
  '',
  '// addVat :: (Number, Number) -> Number',
  'export const addVat = (amount, rate) => Math.round (amount * (1 + rate));',
  '',
].join('\n');

const ORDERS = [
  'import { formatAmount, addVat } from "./money";',
  '',
  '// orderLabel :: Order -> String',
  'export const orderLabel = (order) => order.id + ": " + formatAmount (addVat (order.total, 0.21));',
  '',
  '// unpaid :: [Order] -> [Order]',
  'export const unpaid = (orders) => orders.filter (order => !order.paid);',
  '',
].join('\n');

const files: Record<string, string> = {
  'hinmil.config.json': JSON.stringify({
    files: { exclude: ['**/node_modules/**', '**/generated/**'] },
  }),
  'server/hinmil.config.json': JSON.stringify({ globals: ['./globals.hm'] }),
  'server/globals.hm': 'Order :: { id :: String, total :: Number, paid :: Boolean }\n',
  'server/src/money.js': MONEY,
  'server/src/orders.js': ORDERS,
  'client/hinmil.config.json': JSON.stringify({ globals: ['./globals.hm'] }),
  'client/globals.hm': 'Order :: { id :: String, lines :: [String] }\n',
};

/** Zero-based position of `needle` (plus `delta` characters) in `source`. */
function positionOf(source: string, needle: string, delta = 0): { line: number; character: number } {
  const offset = source.indexOf(needle);
  if (offset < 0) throw new Error(`'${needle}' not found`);
  const before = source.slice(0, offset + delta).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}

const errorsOf = (diagnostics: Diagnostic[]): Diagnostic[] =>
  diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);

let client: LspClient;

// Loading the server module (compiled by ts-jest) takes a few seconds on a
// busy machine, and the first inference of each scope warms the caches.
jest.setTimeout(30000);

beforeAll(async () => {
  client = await startLanguageServer({ files });
}, 60000);

afterAll(async () => {
  await client.stop();
});

describe('diagnostics', () => {
  test('a clean module publishes no errors', async () => {
    const uri = client.open('server/src/orders.js');
    const diagnostics = await client.waitForDiagnostics(uri);
    expect(errorsOf(diagnostics)).toEqual([]);
    client.close('server/src/orders.js');
  });

  test('an argument that does not fit an imported signature is reported at the argument', async () => {
    const source = [
      'import { formatAmount } from "./money";',
      '',
      '// receiptLine :: String -> String',
      'export const receiptLine = (cents) => "Total: " + formatAmount (cents);',
      '',
    ].join('\n');
    const uri = client.open('server/src/receipt.js', source);
    const diagnostics = errorsOf(await client.waitForDiagnostics(uri, d => errorsOf(d).length > 0));
    expect(diagnostics[0].code).toBe(1001);
    expect(diagnostics[0].message).toMatch(/String.*Number|Number.*String/);
    expect(diagnostics[0].range.start.line).toBe(3);
    client.close('server/src/receipt.js');
  });

  test('editing re-validates; an unchanged text re-publishes the same diagnostics; closing clears them', async () => {
    const broken = [
      '// vatOf :: Number -> Number',
      'export const vatOf = (amount) => amount * "0.21";',
      '',
    ].join('\n');
    const fixed = broken.replace('"0.21"', '0.21');
    const uri = client.open('server/src/vat.js', broken);
    await client.waitForDiagnostics(uri, d => errorsOf(d).length > 0);

    let since = client.published.length;
    client.change('server/src/vat.js', fixed);
    await client.waitForDiagnostics(uri, d => errorsOf(d).length === 0, since);

    // Same text again (an undo/redo pair, or overlapping change events): the
    // server skips inference and re-publishes the diagnostics of that text.
    since = client.published.length;
    client.change('server/src/vat.js', fixed);
    const again = await client.waitForDiagnostics(uri, () => true, since);
    expect(errorsOf(again)).toEqual([]);

    since = client.published.length;
    client.close('server/src/vat.js');
    expect(await client.waitForDiagnostics(uri, d => d.length === 0, since)).toEqual([]);
  });

  test('while the caret is inside a word, validation waits for the next edit at a word boundary', async () => {
    const start = '// grossOf :: Number -> Number\nexport const grossOf = (net) => net * 1.21;\n';
    const uri = client.open('server/src/gross.js', start);
    await client.waitForDiagnostics(uri);

    // Typing inside `net` (→ `neXt`): a half-typed name would only produce an
    // "Unbound variable" flash, so nothing is published for this edit.
    let since = client.published.length;
    client.change('server/src/gross.js', start.replace('=> net *', '=> neXt *'));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(client.published.slice(since).filter(p => p.uri === uri)).toEqual([]);

    // Finishing the edit at a word boundary validates again.
    since = client.published.length;
    client.change('server/src/gross.js', start.replace('=> net *', '=> neXt  *'));
    const diagnostics = await client.waitForDiagnostics(uri, d => errorsOf(d).length > 0, since);
    expect(diagnostics.some(d => d.code === 1007 && /neXt/.test(d.message))).toBe(true);
    client.close('server/src/gross.js');
  });

  test('an excluded file gets an empty diagnostics list', async () => {
    const uri = client.open('server/src/generated/schema.js', '// version :: Number\nconst version = "3";\n');
    expect(await client.waitForDiagnostics(uri)).toEqual([]);
    client.close('server/src/generated/schema.js');
  });

  test('a malformed .hm file reports a parse problem', async () => {
    const uri = client.open('server/hm-types/payments.hm', 'charge :: (Number -> String\n');
    const diagnostics = await client.waitForDiagnostics(uri, d => d.length > 0);
    expect(diagnostics[0].message).toMatch(/charge|parse|Invalid|Expected/i);
    client.close('server/hm-types/payments.hm');
  });
});

describe('project scopes (configuration per folder)', () => {
  test('each application uses the globals of its own nearest configuration', async () => {
    const source = [
      '// orderTotal :: Order -> Number',
      'export const orderTotal = (order) => order.total;',
      '',
    ].join('\n');
    const serverUri = client.open('server/src/total.js', source);
    const clientUri = client.open('client/src/total.js', source);

    expect(errorsOf(await client.waitForDiagnostics(serverUri))).toEqual([]);
    const clientErrors = errorsOf(await client.waitForDiagnostics(clientUri, d => errorsOf(d).length > 0));
    expect(clientErrors[0].code).toBe(1005);
    expect(clientErrors[0].message).toMatch(/total/);
    client.close('server/src/total.js');
    client.close('client/src/total.js');
  });
});

describe('editor features', () => {
  let uri: string;
  beforeAll(async () => {
    uri = client.open('server/src/orders.js', ORDERS);
    await client.waitForDiagnostics(uri);
  });
  afterAll(() => client.close('server/src/orders.js'));

  test('hover shows the signature of an imported function', async () => {
    const hover = await client.request<{ contents: { value: string } }>('textDocument/hover', {
      textDocument: { uri }, position: positionOf(ORDERS, 'formatAmount (addVat', 2),
    });
    expect(hover.contents.value).toContain('Number -> String');
  });

  test('hover on a parameter shows the global alias of the scope', async () => {
    const hover = await client.request<{ contents: { value: string } }>('textDocument/hover', {
      textDocument: { uri }, position: positionOf(ORDERS, 'order.total', 1),
    });
    expect(hover.contents.value).toMatch(/Order|total :: Number/);
  });

  test('completion after a dot lists the fields of the record', async () => {
    const source = '// isLarge :: Order -> Boolean\nexport const isLarge = (order) => order.\n';
    const fileUri = client.open('server/src/large.js', source);
    const items = await client.request<Array<{ label: string }>>('textDocument/completion', {
      textDocument: { uri: fileUri },
      position: positionOf(source, 'order.\n', 6),
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    expect(items.map(i => i.label)).toEqual(expect.arrayContaining(['id', 'total', 'paid']));
    client.close('server/src/large.js');
  });

  test('completion after `{` suggests record fields in an argument and stays silent for a block', async () => {
    const source = [
      'import { orderLabel } from "./orders";',
      '',
      'const label = orderLabel ({',
      'if (label) {',
      '',
    ].join('\n');
    const fileUri = client.open('server/src/labels.js', source);
    const fields = await client.request<Array<{ label: string }>>('textDocument/completion', {
      textDocument: { uri: fileUri },
      position: positionOf(source, 'orderLabel ({', 13),
      context: { triggerKind: 2, triggerCharacter: '{' },
    });
    expect(fields.map(i => i.label)).toEqual(expect.arrayContaining(['id', 'total', 'paid']));
    const block = await client.request<Array<{ label: string }>>('textDocument/completion', {
      textDocument: { uri: fileUri },
      position: positionOf(source, '(label) {', 9),
      context: { triggerKind: 2, triggerCharacter: '{' },
    });
    expect(block).toEqual([]);
    client.close('server/src/labels.js');
  });

  test('signature help shows the parameters of the called function', async () => {
    const source = 'import { addVat } from "./money";\n\nconst gross = addVat (1250, \n';
    const fileUri = client.open('server/src/gross.js', source);
    const help = await client.request<{ signatures: Array<{ label: string }>; activeParameter?: number }>(
      'textDocument/signatureHelp',
      {
        textDocument: { uri: fileUri },
        position: positionOf(source, '1250, ', 6),
        context: { triggerKind: 2, triggerCharacter: ',', isRetrigger: false },
      },
    );
    expect(help.signatures[0].label).toContain('Number');
    expect(help.activeParameter ?? help.signatures[0]).toBeDefined();
    client.close('server/src/gross.js');
  });

  test('go to definition on a module path is one link to the file', async () => {
    const links = await client.request<Array<{ targetUri: string; originSelectionRange: { start: { character: number }; end: { character: number } } }>>(
      'textDocument/definition',
      { textDocument: { uri }, position: positionOf(ORDERS, '"./money"', 4) },
    );
    expect(links[0].targetUri).toBe(client.uri('server/src/money.js'));
    // The clicked text is the whole string literal, quotes included.
    const { start, end } = links[0].originSelectionRange;
    expect(end.character - start.character).toBe('"./money"'.length);
  });

  test('go to definition on an imported name jumps to its declaration', async () => {
    const links = await client.request<Array<{ targetUri: string; targetSelectionRange: { start: { line: number } } }>>(
      'textDocument/definition',
      { textDocument: { uri }, position: positionOf(ORDERS, 'addVat (order', 2) },
    );
    expect(links[0].targetUri).toBe(client.uri('server/src/money.js'));
    expect(links[0].targetSelectionRange.start.line).toBe(4);
  });

  test('code definitions are left to the TypeScript extension while it is active', async () => {
    const params = { textDocument: { uri }, position: positionOf(ORDERS, '"./money"', 4) };
    client.connection.sendNotification('hinmil/typescriptLanguageFeatures', { active: true });
    expect(await client.request('textDocument/definition', params)).toBeNull();
    client.connection.sendNotification('hinmil/typescriptLanguageFeatures', { active: false });
    expect(await client.request<unknown[]>('textDocument/definition', params)).toHaveLength(1);
  });

  test('document symbols list the declarations of the file', async () => {
    const symbols = await client.request<Array<{ name: string }>>('textDocument/documentSymbol', { textDocument: { uri } });
    expect(symbols.map(s => s.name)).toEqual(expect.arrayContaining(['orderLabel', 'unpaid']));
  });

  test('references and rename cover every use of a local binding', async () => {
    const source = [
      '// shippingFee :: Number -> Number',
      'const shippingFee = (total) => total >= 5000 ? 0 : 495;',
      '',
      '// totalWithShipping :: Number -> Number',
      'export const totalWithShipping = (total) => total + shippingFee (total);',
      '',
    ].join('\n');
    const fileUri = client.open('server/src/shipping.js', source);
    const position = positionOf(source, 'shippingFee (total)', 3);
    const references = await client.request<unknown[]>('textDocument/references', {
      textDocument: { uri: fileUri }, position, context: { includeDeclaration: true },
    });
    expect(references.length).toBeGreaterThanOrEqual(2);

    const prepared = await client.request<{ placeholder: string }>('textDocument/prepareRename', {
      textDocument: { uri: fileUri }, position,
    });
    expect(prepared.placeholder).toBe('shippingFee');
    const edit = await client.request<{ changes: Record<string, Array<{ newText: string }>> }>('textDocument/rename', {
      textDocument: { uri: fileUri }, position, newName: 'deliveryFee',
    });
    const edits = edit.changes[fileUri];
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(edits.every(e => e.newText === 'deliveryFee')).toBe(true);
    client.close('server/src/shipping.js');
  });

  test('a function without a signature gets a quick fix that adds the inferred one', async () => {
    const source = 'export const centsToEuros = (cents) => cents / 100;\n';
    const fileUri = client.open('server/src/euros.js', source);
    const diagnostics = await client.waitForDiagnostics(fileUri, d => d.some(x => x.code === 6001));
    const missing = diagnostics.filter(d => d.code === 6001);
    const actions = await client.request<Array<{ title: string }>>('textDocument/codeAction', {
      textDocument: { uri: fileUri },
      range: missing[0].range,
      context: { diagnostics: missing },
    });
    expect(actions.map(a => a.title)).toEqual(
      expect.arrayContaining([expect.stringContaining('Add HM annotation: centsToEuros :: Number -> Number')]),
    );
    client.close('server/src/euros.js');
  });
});

describe('configuration changes', () => {
  const broken = '// vatRate :: Number\nexport const vatRate = "21%";\n';

  test('an editor setting changes the severity of open documents', async () => {
    const uri = client.open('server/src/rate.js', broken);
    await client.waitForDiagnostics(uri, d => errorsOf(d).length > 0);

    let since = client.published.length;
    client.editorSettings = { diagnostics: { debounceMs: 10, typeErrors: 'warning' } };
    client.connection.sendNotification('workspace/didChangeConfiguration', { settings: { 'hinmil': client.editorSettings } });
    const warned = await client.waitForDiagnostics(uri, d => d.some(x => x.code === 1003 || x.code === 1001), since);
    expect(warned.filter(d => d.code === 1003 || d.code === 1001).every(d => d.severity === DiagnosticSeverity.Warning)).toBe(true);

    // An empty payload makes the server pull the settings itself.
    since = client.published.length;
    client.editorSettings = { diagnostics: { debounceMs: 10 } };
    client.connection.sendNotification('workspace/didChangeConfiguration', { settings: {} });
    await client.waitForDiagnostics(uri, d => errorsOf(d).length > 0, since);
    client.close('server/src/rate.js');
  });

  test('a changed project configuration on disk is picked up without a restart', async () => {
    const uri = client.open('server/src/rate.js', broken);
    await client.waitForDiagnostics(uri, d => errorsOf(d).length > 0);

    const configPath = client.write('hinmil.config.json', JSON.stringify({
      files: { exclude: ['**/node_modules/**', '**/generated/**'] },
      settings: { diagnostics: { typeErrors: 'off' } },
    }));
    const since = client.published.length;
    client.connection.sendNotification('workspace/didChangeWatchedFiles', {
      changes: [{ uri: client.uri('hinmil.config.json'), type: 2 }],
    });
    const after = await client.waitForDiagnostics(uri, d => errorsOf(d).length === 0, since);
    expect(errorsOf(after)).toEqual([]);

    fs.writeFileSync(configPath, files['hinmil.config.json']);
    client.connection.sendNotification('workspace/didChangeWatchedFiles', {
      changes: [{ uri: client.uri('hinmil.config.json'), type: 2 }],
    });
    client.close('server/src/rate.js');
  });

  test('a globals file edited in the editor re-checks the open documents of its scope', async () => {
    const source = '// isPaid :: Order -> Boolean\nexport const isPaid = (order) => order.paid;\n';
    const uri = client.open('server/src/paid.js', source);
    expect(errorsOf(await client.waitForDiagnostics(uri))).toEqual([]);

    client.open('server/globals.hm', files['server/globals.hm']);
    const since = client.published.length;
    client.change('server/globals.hm', 'Order :: { id :: String, total :: Number, settled :: Boolean }\n');
    const errors = errorsOf(await client.waitForDiagnostics(uri, d => errorsOf(d).length > 0, since));
    expect(errors[0].message).toMatch(/paid/);

    client.change('server/globals.hm', files['server/globals.hm']);
    client.close('server/globals.hm');
    client.close('server/src/paid.js');
  });

  test('an on-disk change to an unopened dependency re-checks its open importers', async () => {
    const source = [
      'import { formatAmount } from "./money";',
      '',
      '// priceTag :: Number -> String',
      'export const priceTag = (cents) => formatAmount (cents);',
      '',
    ].join('\n');
    const uri = client.open('server/src/priceTag.js', source);
    expect(errorsOf(await client.waitForDiagnostics(uri))).toEqual([]);

    const moneyPath = path.join(client.root, 'server/src/money.js');
    fs.writeFileSync(moneyPath, MONEY.replace('// formatAmount :: Number -> String', '// formatAmount :: String -> String'));
    const since = client.published.length;
    client.connection.sendNotification('workspace/didChangeWatchedFiles', {
      changes: [{ uri: client.uri('server/src/money.js'), type: 2 }],
    });
    expect(errorsOf(await client.waitForDiagnostics(uri, d => errorsOf(d).length > 0, since)).length).toBeGreaterThan(0);

    fs.writeFileSync(moneyPath, MONEY);
    client.close('server/src/priceTag.js');
  });
});
