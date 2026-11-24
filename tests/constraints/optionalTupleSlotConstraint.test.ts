// Fase A: constraint-aware tuple arity relaxation.
//
// When a tuple-parameter function is called with fewer args than expected,
// the strict arity check is skipped if every missing trailing slot is
// typed as a constraint variable whose structural body admits Undefined.
// This lets sqlkit consumers write `NumberProp("id")` once `Source` has
// been overridden to include `| Undefined`.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';

const tmpRoot = '/tmp/hm-optional-tuple-slot-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function inferConsumer(consumerRel: string) {
  const consumerPath = path.join(tmpRoot, consumerRel);
  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  ctx.setProjectConfig(tmpRoot, {});
  const resolver = ctx.createImportResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const eng = new InferenceEngine();
  const source = fs.readFileSync(consumerPath, 'utf8');
  return eng.infer(source, undefined, resolver, undefined, aliasResolver);
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  writeFile('node_modules/sqlkit/package.json', JSON.stringify({
    name: 'sqlkit',
    main: 'index.js',
    'hinmil': { sidecars: './sqlkit.hm' },
  }));
  writeFile('node_modules/sqlkit/index.js', [
    'exports.NumberProp = (col, src) => ({ kind: "NumberProp", col, src });',
    'exports.StrictProp = (col, src) => ({ kind: "StrictProp", col, src });',
    'exports.sql = (parts, ...vals) => ({ kind: "SQLTag", parts, vals });',
  ].join('\n'));

  writeFile('node_modules/sqlkit/sqlkit.hm', [
    "sql :: ([String], [a]) -> SQLTag b c",
    "::constraint Source s { s :: String | SQLTag a b | Undefined }",
    "::constraint StrictSource s { s :: String | SQLTag a b }",
    "NumberProp :: Source s => (String, s) -> Prop t Number",
    "StrictProp :: StrictSource s => (String, s) -> Prop t Number",
    "",
  ].join('\n'));
});

describe('Fase A — constraint-aware tuple arity', () => {
  const isError = (d: { severity?: number }) => d.severity === undefined || d.severity === 1;

  test('NumberProp("id") is accepted when Source admits Undefined', () => {
    writeFile('shortcall.js', [
      'const { NumberProp } = require("sqlkit");',
      'const p = NumberProp("id");',
      '',
    ].join('\n'));
    const r = inferConsumer('shortcall.js');
    const arity = r.diagnostics.filter(d => /Expected .* argument/i.test(d.message));
    expect(arity).toEqual([]);
    expect(r.diagnostics.filter(isError)).toEqual([]);
  });

  test('NumberProp("id", "col") still works (full arity)', () => {
    writeFile('fullcall.js', [
      'const { NumberProp } = require("sqlkit");',
      'const p = NumberProp("id", "col");',
      '',
    ].join('\n'));
    const r = inferConsumer('fullcall.js');
    expect(r.diagnostics.filter(isError)).toEqual([]);
  });

  test('StrictProp("id") is rejected (StrictSource does NOT admit Undefined)', () => {
    writeFile('strictshort.js', [
      'const { StrictProp } = require("sqlkit");',
      'const p = StrictProp("id");',
      '',
    ].join('\n'));
    const r = inferConsumer('strictshort.js');
    const arity = r.diagnostics.filter(d => /Expected .* argument/i.test(d.message));
    expect(arity.length).toBe(1);
    expect(arity[0].message).toBe('Expected 2 arguments but got 1');
  });

  test('Too-many-args still flagged when Source admits Undefined', () => {
    writeFile('toomany.js', [
      'const { NumberProp } = require("sqlkit");',
      'const p = NumberProp("id", "col", "extra");',
      '',
    ].join('\n'));
    const r = inferConsumer('toomany.js');
    const arity = r.diagnostics.filter(d => /Expected .* argument/i.test(d.message));
    expect(arity.length).toBe(1);
    expect(arity[0].message).toBe('Expected 2 arguments but got 3');
  });
});
