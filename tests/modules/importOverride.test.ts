// Tests for project-level `.hm` package overrides + their interaction with
// the package's own `.hm` sidecar. Verifies the merge semantics of
// `createImportResolver` in `ImportInferenceContext`:
//
//   1. Override entry wins on name collision with the package sidecar.
//   2. Names absent from the override fall through to the package sidecar.
//   3. Without a package sidecar the override is authoritative — names
//      missing from it surface as `'X' is not exported from '...'`.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';

const tmpRoot = '/tmp/hm-import-override-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function inferConsumer(consumerRel: string, opts: {
  overrides?: Record<string, string>;
  typesDir?: string;
} = {}) {
  const consumerPath = path.join(tmpRoot, consumerRel);
  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  ctx.setProjectConfig(tmpRoot, opts);
  const resolver = ctx.createImportResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const eng = new InferenceEngine();
  return eng.infer(fs.readFileSync(consumerPath, 'utf8'), undefined, resolver, undefined, aliasResolver);
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  // Fake npm package `pkg` with its own .hm sidecar exposing `inSidecar`
  // and `shared`. Located under node_modules so it's treated as an npm
  // package rather than user source.
  writeFile('node_modules/pkg/package.json', JSON.stringify({
    name: 'pkg',
    main: 'index.js',
    'hinmil': { sidecars: 'index.hm' },
  }));
  writeFile('node_modules/pkg/index.js', [
    'exports.inSidecar = (s) => s.length;',
    'exports.shared = 1;',
  ].join('\n'));
  writeFile('node_modules/pkg/index.hm', [
    'inSidecar :: String -> Number',
    'shared :: Number',
    '',
  ].join('\n'));

  // Project-level override that types `inOverride` and re-types `shared`.
  writeFile('hm-types/pkg.hm', [
    'inOverride :: Boolean -> String',
    'shared :: String',
    '',
  ].join('\n'));

  // Second fake npm package with NO sidecar — used to test the
  // override-only authoritative case.
  writeFile('node_modules/lonely/package.json', JSON.stringify({
    name: 'lonely',
    main: 'index.js',
  }));
  writeFile('node_modules/lonely/index.js', [
    'exports.declared = 1;',
    'exports.undeclared = 2;',
  ].join('\n'));
  writeFile('hm-types/lonely.hm', [
    'declared :: Number',
    '',
  ].join('\n'));
});

describe('project `.hm` override × package sidecar', () => {
  test('override entry wins on name collision with sidecar', () => {
    const consumer = writeFile('src/collision.js', [
      'import { shared } from "pkg";',
      // Override types `shared :: String` — concatenating with another
      // string must succeed.
      'export const v = shared + " world";',
    ].join('\n'));
    void consumer;
    const result = inferConsumer('src/collision.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('names absent from override fall through to sidecar', () => {
    const consumer = writeFile('src/fallthrough.js', [
      'import { inSidecar } from "pkg";',
      // Sidecar types this as `String -> Number`.
      'export const n = inSidecar("hello");',
    ].join('\n'));
    void consumer;
    const result = inferConsumer('src/fallthrough.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('override-only names are usable', () => {
    const consumer = writeFile('src/overrideOnly.js', [
      'import { inOverride } from "pkg";',
      'export const s = inOverride(true);',
    ].join('\n'));
    void consumer;
    const result = inferConsumer('src/overrideOnly.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('package without sidecar: name absent from override but present at runtime is bound to Any', () => {
    // `undeclared` exists at runtime in `lonely` but is NOT typed in
    // the override.  We supplement the override with an `Any`-typed
    // entry — opaque under unification, so the import works without
    // producing a hallucinated signature from how it is used.
    const consumer = writeFile('src/lonelyMissing.js', [
      'import { undeclared } from "lonely";',
      'export const id = (x) => x;',
      'export const x = id(undeclared);',
    ].join('\n'));
    void consumer;
    const result = inferConsumer('src/lonelyMissing.js');
    const messages = result.diagnostics.map(d => d.message);
    expect(messages.filter(m => m.includes("'undeclared'"))).toEqual([]);
  });

  test('runtime-only exports: name truly absent from JS still errors', () => {
    const consumer = writeFile('src/lonelyGhost.js', [
      'import { ghost } from "lonely";',
      'export const x = ghost;',
    ].join('\n'));
    void consumer;
    const result = inferConsumer('src/lonelyGhost.js');
    const messages = result.diagnostics.map(d => d.message);
    expect(messages).toContain("'ghost' is not exported from 'lonely'");
  });

  test('package without sidecar: present override name is typed', () => {
    const consumer = writeFile('src/lonelyOk.js', [
      'import { declared } from "lonely";',
      'export const y = declared + 1;',
    ].join('\n'));
    void consumer;
    const result = inferConsumer('src/lonelyOk.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('Any-typed import is opaque: usage does not propagate into hallucinated signature', () => {
    // `undeclared` is supplemented with `Any` because it exists in the
    // package's runtime exports but not in the override.  When the user
    // writes `Limit(5)` against an `Any` value, the engine MUST NOT
    // infer `Limit :: Number -> QueryTag b` (the regression that this
    // whole change exists to prevent).  The result of calling the
    // `Any` value should remain `Any`, and the local binding's scheme
    // should still be `Any` after inference.
    const consumer = writeFile('src/lonelyOpaque.js', [
      'import { undeclared } from "lonely";',
      'export const result = undeclared(5);',
    ].join('\n'));
    void consumer;
    const result = inferConsumer('src/lonelyOpaque.js');
    // No diagnostics from the call.
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
    // The inferred export type for `result` must be `Any`, not a
    // hallucinated `Number -> ...` shape.
    const resultScheme = result.exports.get('result');
    expect(resultScheme).toBeDefined();
    const ts = require('../../src').schemeToString(resultScheme!);
    expect(ts).toBe('Any');
  });

  test('package with no override and no sidecar (UNTYPED_MODULE): bindings are Any', () => {
    // Create a third throwaway package with neither override nor
    // sidecar.  Its imported names should be bound to `Any` (opaque),
    // not a fresh tvar (which would propagate via usage).
    writeFile('node_modules/anonymous/package.json', JSON.stringify({
      name: 'anonymous',
      main: 'index.js',
    }));
    writeFile('node_modules/anonymous/index.js', [
      'exports.foo = 1;',
      'exports.bar = (x) => x;',
    ].join('\n'));
    const consumer = writeFile('src/anonymousUse.js', [
      'import { bar } from "anonymous";',
      'export const v = bar("hello");',
    ].join('\n'));
    void consumer;
    const result = inferConsumer('src/anonymousUse.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
    const vScheme = result.exports.get('v');
    expect(vScheme).toBeDefined();
    const ts = require('../../src').schemeToString(vScheme!);
    expect(ts).toBe('Any');
  });

  test('override `Type#method` annotation wins over package sidecar same-named method', () => {
    // Regression: method registration is last-write-wins.  Previously,
    // override methods were registered BEFORE package sidecar methods,
    // so the package version overwrote the override.  Concretely, a
    // package's `Table#update :: Table p ~> [a] -> QueryTag b` would
    // overwrite an override's `Table#update :: Table p ~> [Selector] -> QueryTag b`,
    // making `model.update([prop, otherTable])` fail with
    //   "Cannot unify 'QueryTag b' with 'Prop a'"
    // because both elements unify against the same `a`.
    writeFile('node_modules/withmethods/package.json', JSON.stringify({
      name: 'withmethods',
      main: 'index.js',
      'hinmil': { sidecars: 'index.hm' },
    }));
    writeFile('node_modules/withmethods/index.js', [
      'function Box(x) { this.x = x; }',
      'Box.prototype.put = function(xs) { return xs; };',
      'exports.Box = Box;',
      'exports.mkProp = (s) => ({ kind: "prop", s });',
      'exports.mkTag  = (s) => ({ kind: "tag",  s });',
    ].join('\n'));
    // Package sidecar: homogeneous `[a]` parameter — would fail on
    // mixed-shape arrays.
    writeFile('node_modules/withmethods/index.hm', [
      'Box :: a -> Box p',
      'mkProp :: String -> Prop a',
      'mkTag  :: String -> QueryTag a',
      'Selector :: (String | Prop a | QueryTag a)',
      'Box#put :: Box p ~> [a] -> Box p',
      '',
    ].join('\n'));
    // Override: same method, but `[Selector]` so heterogeneous elements
    // are accepted via the union.
    writeFile('hm-types/withmethods.hm', [
      'Selector :: (String | Prop a | QueryTag a)',
      'Box#put :: Box p ~> [Selector] -> Box p',
      '',
    ].join('\n'));

    const consumer = writeFile('src/methodOverride.js', [
      'import { Box, mkProp, mkTag } from "withmethods";',
      'const b = Box(1);',
      'const p = mkProp("id");',
      'const t = mkTag("rows");',
      'export const r = b.put([p, t]);',
    ].join('\n'));
    void consumer;
    const result = inferConsumer('src/methodOverride.js');
    const messages = result.diagnostics.map(d => d.message);
    // The previously-failing diagnostic must be gone.
    expect(messages.find(m => /Cannot unify .* 'Prop|Cannot unify .* 'QueryTag/.test(m))).toBeUndefined();
    expect(messages).toEqual([]);
  });

  test('package sidecar method references type alias from same sidecar (alias is expanded at registration)', () => {
    // Regression: when a sidecar method signature references a type
    // alias that has free type variables (e.g. `Selector` in
    //   Selector :: (String | Prop a | QueryTag a)
    //   Box#put  :: Box p ~> [Selector] -> Box p
    // ), the bare `Selector` in `[Selector]` was left unexpanded by
    // `expandAliases` (it treated the missing type args as an arity
    // mismatch and silently skipped expansion).  At the call site
    // `b.put([prop, tag])`, unify would then compare `QueryTag a` against
    // the opaque `Selector` TCon and fail with
    //   `Cannot unify 'QueryTag a' with 'Selector'`
    // even though `QueryTag a` is one of the union's branches.  Bare
    // alias references must freshen the alias's free vars at expansion.
    writeFile('node_modules/aliasmethods/package.json', JSON.stringify({
      name: 'aliasmethods',
      main: 'index.js',
      'hinmil': { sidecars: 'index.hm' },
    }));
    writeFile('node_modules/aliasmethods/index.js', [
      'function Box(x) { this.x = x; }',
      'Box.prototype.put = function(xs) { return this; };',
      'exports.Box = Box;',
      'exports.mkProp = (s) => ({ kind: "prop", s });',
      'exports.mkTag  = (s) => ({ kind: "tag",  s });',
    ].join('\n'));
    writeFile('node_modules/aliasmethods/index.hm', [
      'Box :: a -> Box p',
      'mkProp :: String -> Prop a',
      'mkTag  :: String -> QueryTag a',
      'Selector :: (String | Prop a | QueryTag a)',
      'Box#put :: Box p ~> [Selector] -> Box p',
      '',
    ].join('\n'));
    // No override sidecar — only the package's own sidecar.

    writeFile('src/aliasMethods.js', [
      'import { Box, mkProp, mkTag } from "aliasmethods";',
      'const b = Box(1);',
      'const p = mkProp("id");',
      'const t = mkTag("rows");',
      'export const r = b.put([p, t]);',
    ].join('\n'));
    const result = inferConsumer('src/aliasMethods.js');
    const messages = result.diagnostics.map(d => d.message);
    expect(messages.find(m => /Cannot unify .* 'Selector'|Cannot unify 'Selector'/.test(m))).toBeUndefined();
    expect(messages).toEqual([]);
  });
});
