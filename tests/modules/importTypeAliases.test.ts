// Tests for type-alias propagation across imports.
//
// When an imported `.hm` sidecar (or project-level override) declares a
// type alias such as `Selector :: (String | Prop a | QueryTag a)`, the
// importing file's inference engine must learn that alias so that bare
// `TCon('Selector', [])` references appearing inside other imported
// schemes (e.g. `Table :: [Selector] -> QueryTag b`) are expanded to the
// underlying union at unification time.  Without this, calls like
// `Table([propVal, "literal"])` produce spurious
// `Cannot unify 'String' with 'Selector'` diagnostics.
//
// These tests pin down the public-API contract of the new
// `createImportTypeAliasResolver` factory on `ImportInferenceContext`
// and the new 5th `importTypeAliasResolver` argument of `engine.infer`.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { parseHmTypeAliases } from '../../src/services/files';

const tmpRoot = '/tmp/hm-import-alias-test';

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

  // A fake `sqlkit`-shaped npm package whose sidecar declares a polymorphic
  // type alias (`Selector`), a constructor (`Prop`), and a factory whose
  // parameter list mentions the alias.
  writeFile('node_modules/qpkg/package.json', JSON.stringify({
    name: 'qpkg',
    main: 'index.js',
    'hinmil': { sidecars: 'index.hm' },
  }));
  writeFile('node_modules/qpkg/index.js', [
    'exports.Prop = (s) => ({ prop: s });',
    'exports.makeQuery = (xs) => ({ query: xs });',
    'exports.Limit = (n) => ({ limit: n });',
  ].join('\n'));
  writeFile('node_modules/qpkg/index.hm', [
    'Prop :: a -> Prop a',
    'Limit :: Number -> Limit',
    'Selector :: (String | Prop a | Limit)',
    'makeQuery :: [Selector] -> Result',
    '',
  ].join('\n'));
});

describe('parseHmTypeAliases', () => {
  it('extracts uppercase non-functional bindings as aliases', () => {
    const source = [
      'Selector :: (String | Prop a | Limit)',
      'Person :: { name :: String, age :: Number }',
      'Counter :: Number',
    ].join('\n');
    const { aliases, aliasVars } = parseHmTypeAliases(source);
    expect(Array.from(aliases.keys()).sort()).toEqual(['Counter', 'Person', 'Selector']);
    // Polymorphic alias records its free type-variable names in order.
    expect(aliasVars.get('Selector')).toEqual(['a']);
    expect(aliasVars.get('Person')).toEqual([]);
  });

  it('skips constructor-shaped functions even when the return type name differs from the binding name', () => {
    // `BooleanProp :: (String, a) -> Prop Boolean` — return type `Prop Boolean`
    // does not match the binding name `BooleanProp`, but the value is a
    // factory function, not an alias.  It must not appear as an alias
    // because that would make bare `TCon('BooleanProp', [])` references
    // expand into a function type at use sites.
    const source = [
      'BooleanProp :: (String, a) -> Prop Boolean',
      'Box :: a -> Box a',
      'PureType :: { x :: Number }',
    ].join('\n');
    const { aliases } = parseHmTypeAliases(source);
    expect(aliases.has('BooleanProp')).toBe(false);
    expect(aliases.has('Box')).toBe(false); // already filtered by buildTypeAliases (return TCon == name)
    expect(aliases.has('PureType')).toBe(true);
  });

  it('skips method/static-shaped names', () => {
    const source = [
      'Foo#bar :: Foo ~> Number',
      'Foo.baz :: Number -> Number',
      'Real :: { x :: Number }',
    ].join('\n');
    const { aliases } = parseHmTypeAliases(source);
    expect(Array.from(aliases.keys())).toEqual(['Real']);
  });

  it('skips overloaded function annotations even when merged into a union', () => {
    // Two `Table :: ...` declarations are merged by `buildTypeAliases`
    // into a single binding whose body is a union of function types.
    // Treating that as an alias would make bare references to `Table`
    // (e.g. inside `Selector :: ... | Table | ...`) expand to a union
    // of function types and lose the registered `Table#...` methods.
    const source = [
      'Table :: [String] -> Result a',
      'Table :: a -> Promise [b]',
      'KeepMe :: { x :: Number }',
    ].join('\n');
    const { aliases } = parseHmTypeAliases(source);
    expect(aliases.has('Table')).toBe(false);
    expect(aliases.has('KeepMe')).toBe(true);
  });
});

describe('createImportTypeAliasResolver', () => {
  it('returns null for an unresolvable specifier', () => {
    writeFile('src/r1.js', 'export const x = 1;');
    const fileUri = pathToFileURL(path.join(tmpRoot, 'src/r1.js')).href;
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpRoot, {});
    const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
    expect(aliasResolver('totally-not-a-real-package-xyz-789')).toBeNull();
  });

  it('returns aliases declared in a package sidecar', () => {
    writeFile('src/r2.js', 'export const x = 1;');
    const fileUri = pathToFileURL(path.join(tmpRoot, 'src/r2.js')).href;
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpRoot, {});
    const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
    const got = aliasResolver('qpkg');
    expect(got).not.toBeNull();
    expect(got!.aliases.has('Selector')).toBe(true);
    expect(got!.aliasVars.get('Selector')).toEqual(['a']);
    // Constructor functions in the sidecar must NOT show up as aliases.
    expect(got!.aliases.has('Prop')).toBe(false);
    expect(got!.aliases.has('makeQuery')).toBe(false);
  });
});

describe('imported type alias is used during unification', () => {
  it('a String literal element matches the imported `Selector` alias', () => {
    writeFile('src/use1.js', [
      'import { makeQuery } from "qpkg";',
      'export const q = makeQuery(["id", "name"]);',
    ].join('\n'));
    const result = inferConsumer('src/use1.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  it('a Prop value element matches the imported `Selector` alias', () => {
    writeFile('src/use2.js', [
      'import { makeQuery, Prop } from "qpkg";',
      'const p = Prop("hello");',
      'export const q = makeQuery([p]);',
    ].join('\n'));
    const result = inferConsumer('src/use2.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  it('mixed-shape elements (String, Prop, Limit) all match the alias', () => {
    writeFile('src/use3.js', [
      'import { makeQuery, Prop, Limit } from "qpkg";',
      'export const q = makeQuery(["id", Prop("foo"), Limit(5)]);',
    ].join('\n'));
    const result = inferConsumer('src/use3.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  it('a Prop value invoked through an overloaded callable TCon matches Selector', () => {
    // Regression for: `Cannot unify 'Prop String' with 'Selector'` when
    // calling an overloaded callable type (`Table :: [Selector] -> QueryTag b`
    // and `Table :: a -> Promise [b]`) with a `Prop String` element.
    // Bare polymorphic alias references inside an imported scheme were
    // never expanded — neither at scheme-load (no alias map yet) nor at
    // unification (which knows nothing about aliases).
    writeFile('node_modules/qpkg2/package.json', JSON.stringify({
      name: 'qpkg2', main: 'index.js', 'hinmil': { sidecars: 'index.hm' },
    }));
    writeFile('node_modules/qpkg2/index.js',
      'exports.StringProp = (s,a)=>({}); exports.Table = (xs)=>({ update: f => 0 });');
    writeFile('node_modules/qpkg2/index.hm', [
      'StringProp :: (String, a) -> Prop String',
      'Selector :: (String | Prop a | Limit)',
      'Table :: [Selector] -> QueryTag b',
      'Table :: a -> Promise [b]',
      'Table#update :: Table p ~> [a] -> QueryTag b',
    ].join('\n'));
    writeFile('src/useOverload.js', [
      'import { StringProp, Table } from "qpkg2";',
      'const createdAtF = StringProp("c", 1);',
      'const Repo = model => {',
      '  let returning = [createdAtF];',
      '  return model.update([model(returning)]);',
      '};',
      'export { Repo };',
    ].join('\n'));
    const result = inferConsumer('src/useOverload.js');
    expect(result.diagnostics.map(d => d.message))
      .not.toContain("Type mismatch: Cannot unify 'Prop String' with 'Selector'");
  });

  it('without the alias resolver, the same source produces unification errors', () => {
    // Sanity check: the bug DOES surface when aliases are not propagated,
    // proving the resolver is the thing that fixes it.
    writeFile('src/use4.js', [
      'import { makeQuery } from "qpkg";',
      'export const q = makeQuery(["id", "name"]);',
    ].join('\n'));
    const consumerPath = path.join(tmpRoot, 'src/use4.js');
    const fileUri = pathToFileURL(consumerPath).href;
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpRoot, {});
    const resolver = ctx.createImportResolver(fileUri);
    // Note: deliberately omit aliasResolver.
    const eng = new InferenceEngine();
    const source = fs.readFileSync(consumerPath, 'utf8');
    const result = eng.infer(source, undefined, resolver);
    const messages = result.diagnostics.map(d => d.message);
    expect(messages.some(m => m.includes("'String'") && m.includes("'Selector'"))).toBe(true);
  });
});
