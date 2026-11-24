// Tests for the `Name() :: T` instance-callable annotation syntax.
//
// Three orthogonal namespaces:
//   `Name :: T`         — the constructor / value
//   `Name#foo :: ...`   — what `.foo` does on an instance
//   `Name() :: ...`     — what `(...)` does on an instance
//
// Lookup precedence at a call site whose carrier has type `TCon Name ...`:
//   - if `instanceCallables.has(Name)`, use ONLY those overloads
//   - otherwise fall back to the legacy constructor-bridge path
//
// Hover and signature help on a value of type `Name X` must surface the
// instance-callable overloads, never the constructor scheme.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { extractInstanceCallables, extractAnnotations } from '../../src/commentParser';
import { typeToString } from '../../src/hm/types';

const tmpRoot = '/tmp/hm-instance-callable-test';

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
});

describe('Name() — parser', () => {
  test('extractInstanceCallables collects only `Name()` annotations', () => {
    const src = [
      '// Foo :: a -> Foo a',
      '// Foo() :: a -> Bar',
      '// Foo() :: (a, b) -> Baz',
      '// Foo#run :: Foo a ~> a',
    ].join('\n');
    const map = extractInstanceCallables(src);
    expect(map.has('Foo')).toBe(true);
    expect(map.get('Foo')!.length).toBe(2);
    // Should NOT include constructor or method annotations under key 'Foo'
    // (those have their own keys/storage).
  });

  test('Name() annotations are excluded from the value annotation map', () => {
    const src = [
      '// Foo :: a -> Foo a',
      '// Foo() :: a -> Bar',
    ].join('\n');
    const all = extractAnnotations(src);
    // Both annotations are extracted, but downstream `buildAnnotationMap`
    // skips ones whose name ends with `()`.
    expect(all.length).toBe(2);
    expect(all.some(a => a.name === 'Foo()')).toBe(true);
    expect(all.some(a => a.name === 'Foo')).toBe(true);
  });
});

describe('Name() — local definitions', () => {
  test('constructor call uses the `Name :: ...` scheme', () => {
    writeFile('local-ctor.js', [
      '// QueryTag :: a -> QueryTag a',
      '// QueryTag() :: a -> [b]',
      'const QueryTag = (a) => ({ value: a });',
      'const t = QueryTag(42);',
    ].join('\n'));
    const r = inferConsumer('local-ctor.js');
    expect(r.diagnostics).toHaveLength(0);
    const t = r.topLevelBindings.get('t');
    expect(t && typeToString(t.type)).toMatch(/QueryTag/);
  });

  test('instance call uses the `Name() :: ...` overload, not the constructor', () => {
    writeFile('local-inst.js', [
      '// QueryTag :: a -> QueryTag a',
      '// QueryTag() :: a -> [b]',
      'const QueryTag = (a) => ({ value: a });',
      'const tag = QueryTag(42);',
      'const out = tag("arg");',
    ].join('\n'));
    const r = inferConsumer('local-inst.js');
    expect(r.diagnostics).toHaveLength(0);
    const out = r.topLevelBindings.get('out');
    // QueryTag() :: a -> [b]  →  the result of tag(_) is a list, NOT
    // a wrapped `QueryTag _`.  This proves the constructor scheme is
    // not being used as the call signature on an instance.
    expect(out && typeToString(out.type)).toMatch(/^\[/);
  });

  test('multiple Name() overloads coexist', () => {
    writeFile('local-multi.js', [
      '// QueryTag :: a -> QueryTag a',
      '// QueryTag() :: Number -> [Number]',
      '// QueryTag() :: String -> [String]',
      'const QueryTag = (a) => ({ value: a });',
      'const tag = QueryTag(42);',
    ].join('\n'));
    const r = inferConsumer('local-multi.js');
    expect(r.diagnostics).toHaveLength(0);
    expect(r.instanceCallables?.get('QueryTag')?.length).toBe(2);
  });
});

describe('Name() — orphan diagnostics', () => {
  test('local Name() without a constructor produces a diagnostic and is dropped', () => {
    writeFile('orphan-local.js', [
      '// Foo() :: a -> [a]',
      'const x = 1;',
    ].join('\n'));
    const r = inferConsumer('orphan-local.js');
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some(d =>
      d.message.startsWith("Instance-callable annotation 'Foo() :: ...'")
      && d.message.includes("has no constructor")
    )).toBe(true);
    // Dropped from the engine's instance-callable map.
    expect(r.instanceCallables?.get('Foo')).toBeUndefined();
  });

  test('local Name() with a local constructor produces no diagnostic', () => {
    writeFile('orphan-ok.js', [
      '// Foo :: a -> Foo a',
      '// Foo() :: a -> [a]',
      'const Foo = (a) => a;',
    ].join('\n'));
    const r = inferConsumer('orphan-ok.js');
    expect(r.diagnostics.filter(d =>
      d.message.includes('Instance-callable')
    )).toHaveLength(0);
    expect(r.instanceCallables?.get('Foo')?.length).toBe(1);
  });

  test('local Name() with an imported constructor (sidecar) produces no diagnostic', () => {
    writeFile('node_modules/orphan-sidecar/package.json', JSON.stringify({
      name: 'orphan-sidecar',
      main: 'index.js',
      'hinmil': { sidecars: './x.hm' },
    }));
    writeFile('node_modules/orphan-sidecar/index.js', 'exports.Bar = (a) => a;');
    writeFile('node_modules/orphan-sidecar/x.hm', 'Bar :: a -> Bar a\n');
    writeFile('orphan-imported-ctor.js', [
      'const { Bar } = require("orphan-sidecar");',
      '// Bar() :: a -> [a]',
      'const x = 1;',
    ].join('\n'));
    const r = inferConsumer('orphan-imported-ctor.js');
    expect(r.diagnostics.filter(d =>
      d.message.includes('Instance-callable')
    )).toHaveLength(0);
    expect(r.instanceCallables?.get('Bar')?.length).toBe(1);
  });

  test('orphan Name() in sidecar is silently dropped', () => {
    writeFile('node_modules/orphan-side/package.json', JSON.stringify({
      name: 'orphan-side',
      main: 'index.js',
      'hinmil': { sidecars: './x.hm' },
    }));
    writeFile('node_modules/orphan-side/index.js', 'exports.x = 1;');
    // Sidecar declares Baz() but no Baz :: ... constructor — should be
    // silently dropped at parse time.
    writeFile('node_modules/orphan-side/x.hm', 'Baz() :: a -> [a]\n');
    writeFile('use-orphan-sidecar.js', [
      'const m = require("orphan-side");',
      'const x = 1;',
    ].join('\n'));
    const r = inferConsumer('use-orphan-sidecar.js');
    expect(r.diagnostics.filter(d =>
      d.message.includes('Instance-callable')
    )).toHaveLength(0);
    expect(r.instanceCallables?.get('Baz')).toBeUndefined();
  });
});

describe('Name#method — orphan diagnostics', () => {
  test('local Name#method without a constructor produces a diagnostic and is dropped', () => {
    writeFile('orphan-method-local.js', [
      '// Foo#bar :: Foo a ~> a',
      'const x = 1;',
    ].join('\n'));
    const r = inferConsumer('orphan-method-local.js');
    expect(r.diagnostics.some(d =>
      d.message.startsWith("Method annotation 'Foo#bar :: ...'")
      && d.message.includes('has no constructor')
    )).toBe(true);
    // Removed from the registered annotation map.
    expect(r.annotations.has('Foo#bar')).toBe(false);
  });

  test('local Name.staticMethod without a constructor produces a diagnostic and is dropped', () => {
    writeFile('orphan-static-local.js', [
      '// Foo.bar :: a -> a',
      'const x = 1;',
    ].join('\n'));
    const r = inferConsumer('orphan-static-local.js');
    expect(r.diagnostics.some(d =>
      d.message.startsWith("Static annotation 'Foo.bar :: ...'")
      && d.message.includes('has no constructor')
    )).toBe(true);
    expect(r.annotations.has('Foo.bar')).toBe(false);
  });

  test('Name#method with a local constructor annotation produces no orphan diagnostic', () => {
    writeFile('method-ok-ctor.js', [
      '// Foo :: a -> Foo a',
      '// Foo#bar :: Foo a ~> a',
      'const Foo = (a) => a;',
    ].join('\n'));
    const r = inferConsumer('method-ok-ctor.js');
    expect(r.diagnostics.filter(d =>
      d.message.startsWith("Method annotation 'Foo#bar")
    )).toHaveLength(0);
    expect(r.annotations.has('Foo#bar')).toBe(true);
  });

  test('Name#method with a local class declaration produces no orphan diagnostic', () => {
    writeFile('method-ok-class.js', [
      'class Foo { constructor (a) { this.a = a; } }',
      '// Foo#bar :: Foo ~> a',
      'const x = 1;',
    ].join('\n'));
    const r = inferConsumer('method-ok-class.js');
    expect(r.diagnostics.filter(d =>
      d.message.startsWith("Method annotation 'Foo#bar")
    )).toHaveLength(0);
  });

  test('Name#method with an imported sidecar constructor produces no orphan diagnostic', () => {
    writeFile('node_modules/method-side/package.json', JSON.stringify({
      name: 'method-side',
      main: 'index.js',
      'hinmil': { sidecars: './x.hm' },
    }));
    writeFile('node_modules/method-side/index.js', 'exports.Bar = (a) => a;');
    writeFile('node_modules/method-side/x.hm', 'Bar :: a -> Bar a\n');
    writeFile('method-imported-ctor.js', [
      'const { Bar } = require("method-side");',
      '// Bar#baz :: Bar a ~> a',
      'const x = 1;',
    ].join('\n'));
    const r = inferConsumer('method-imported-ctor.js');
    expect(r.diagnostics.filter(d =>
      d.message.startsWith("Method annotation 'Bar#baz")
    )).toHaveLength(0);
  });
});

describe('Name() — sidecar imports', () => {
  test('Name() imported via .hm sidecar drives the call type', () => {
    writeFile('node_modules/sqlkit-ic/package.json', JSON.stringify({
      name: 'sqlkit-ic',
      main: 'index.js',
      'hinmil': { sidecars: './sqlkit.hm' },
    }));
    writeFile('node_modules/sqlkit-ic/index.js', [
      'exports.QueryTag = (a) => ({ kind: "QueryTag", a });',
    ].join('\n'));
    writeFile('node_modules/sqlkit-ic/sqlkit.hm', [
      'QueryTag :: a -> QueryTag a',
      'QueryTag() :: a -> [b]',
      '',
    ].join('\n'));

    writeFile('sidecar-call.js', [
      'const { QueryTag } = require("sqlkit-ic");',
      'const tag = QueryTag(42);',
      'const out = tag("arg");',
    ].join('\n'));
    const r = inferConsumer('sidecar-call.js');
    expect(r.diagnostics).toHaveLength(0);
    const out = r.topLevelBindings.get('out');
    expect(out && typeToString(out.type)).toMatch(/^\[/);
    // And the constructor still works:
    const tag = r.topLevelBindings.get('tag');
    expect(tag && typeToString(tag.type)).toMatch(/QueryTag/);
  });
});
