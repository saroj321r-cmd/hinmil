// Regression coverage for a five-item batch of fpkit-driven fixes:
//
//   Bug 4 — an IIFE-wrapped *single* (non-overload) annotation must bind its
//           returned-arrow parameters exactly like a direct arrow, including
//           the constraint prefix (`value1 :: Ord a => a`).
//   Bug 1 — `process.env.<key>` is an open String-valued index signature
//           (`Object k String`) rather than a bare childless `Object`.
//   Bug 2 — `var` declarations are function-scoped/hoisted, so a `var`
//           introduced in a nested block is visible in a sibling block.
//   Bug 3 — an imported JS binding carrying multiple `// name :: ...`
//           overload annotations surfaces ALL of them, not just the first.
//   Feature A — `lensPath` is a single overloaded form whose branch is chosen
//           by the LENGTH of the path literal at the call site.

import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, schemeToString } from '../../src/hm/types';
import type { Type } from '../../src/hm/types';
import { buildHover } from '../../src/services/hover';
import { ImportInferenceContext } from '../../src/services/importContext';

beforeEach(() => resetTypeVarCounter());

function infer(source: string) {
  return new InferenceEngine().infer(source);
}

/** End-to-end hover string for the first occurrence of `token` in `source`. */
function hoverAtToken(source: string, token: string, offsetInToken = 0): string | null {
  const r = infer(source);
  const offset = source.indexOf(token) + offsetInToken;
  let bestStart = -1;
  let bestType: Type | null = null;
  for (const [s, info] of r.nodeTypes) {
    const end = (info as { end: number }).end;
    if (s <= offset && offset < end && s > bestStart) {
      bestStart = s;
      bestType = r.substitution.apply((info as { type: Type }).type);
    }
  }
  const h = buildHover({
    source, offset, result: r, bestType, bestStart, arrayShift: 0,
    inferredTypeStyle: 'pretty', uri: 'file:///t.js',
    resolveImportSpecifier: () => null,
    extractImportSpecifiers: () => new Map(),
  } as Parameters<typeof buildHover>[0]);
  return h ? (h.contents as { value: string }).value : null;
}

/** Inferred scheme string of a top-level binding. */
function bindingType(r: ReturnType<InferenceEngine['infer']>, name: string): string | null {
  const b = (r as { topLevelBindings: Map<string, unknown> }).topLevelBindings.get(name);
  return b ? schemeToString(b as never) : null;
}

// ---------------------------------------------------------------------------
// Bug 4 — IIFE single-annotation parameter inheritance (with constraint)
// ---------------------------------------------------------------------------
describe('Bug 4: IIFE-wrapped single annotation binds params like a direct arrow', () => {
  const ORD = '// ::constraint Ord a { a :: { lte :: a ~> a -> Boolean } }';

  const DIRECT = [
    ORD,
    '// lte :: Ord a => a -> a -> Boolean',
    'const lte = value1 => value2 => value1 === value2;',
  ].join('\n');

  const IIFE_EXPR = [
    ORD,
    '// lte :: Ord a => a -> a -> Boolean',
    'const lte = (() => value1 => value2 => value1 === value2)();',
  ].join('\n');

  const IIFE_BLOCK = [
    ORD,
    '// lte :: Ord a => a -> a -> Boolean',
    'const lte = (() => {',
    '  return value1 => value2 => value1 === value2;',
    '})();',
  ].join('\n');

  test('direct arrow param shows the Ord constraint (baseline)', () => {
    expect(hoverAtToken(DIRECT, 'value1')).toContain('value1 :: Ord a => a');
  });

  test('IIFE (expression body) param matches the direct arrow exactly', () => {
    expect(hoverAtToken(IIFE_EXPR, 'value1')).toContain('value1 :: Ord a => a');
  });

  test('IIFE (block body) param matches the direct arrow exactly', () => {
    expect(hoverAtToken(IIFE_BLOCK, 'value1')).toContain('value1 :: Ord a => a');
    expect(hoverAtToken(IIFE_BLOCK, 'value2')).toContain('value2 :: Ord a => a');
  });

  test('IIFE binding type and diagnostics match the direct form', () => {
    const direct = infer(DIRECT);
    const iife = infer(IIFE_BLOCK);
    expect(direct.diagnostics.map(d => d.message)).toEqual([]);
    expect(iife.diagnostics.map(d => d.message)).toEqual([]);
    expect(bindingType(iife, 'lte')).toBe(bindingType(direct, 'lte'));
  });
});

// ---------------------------------------------------------------------------
// Bug 1 — process.env is an open String-valued index signature
// ---------------------------------------------------------------------------
describe('Bug 1: process.env members are String (open index signature)', () => {
  test('process.env.NODE_ENV is String with no diagnostics', () => {
    const src = 'const mode = process.env.NODE_ENV;';
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(bindingType(r, 'mode')).toBe('String');
  });

  test('an arbitrary env key is also String', () => {
    const src = 'const x = process.env.ANYTHING_AT_ALL;';
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(bindingType(r, 'x')).toBe('String');
  });

  test('process.argv is still [String]', () => {
    const src = 'const a = process.argv;';
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(bindingType(r, 'a')).toBe('[String]');
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — var hoisting / function-scoping inside function bodies
// ---------------------------------------------------------------------------
describe('Bug 2: var declarations are function-scoped (hoisted)', () => {
  test('a var declared in a nested block is visible in a sibling block', () => {
    const src = [
      'function f(xs) {',
      '  if (Array.isArray(xs)) { for (var idx = 0; idx < xs.length; idx++) {} }',
      '  for (idx = 0; idx < 3; idx++) {}',
      '  return idx;',
      '}',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.some(d => /Unbound variable: 'idx'/.test(d.message))).toBe(false);
  });

  test('let remains block-scoped (still an error across blocks)', () => {
    const src = [
      'function g(xs) {',
      '  if (Array.isArray(xs)) { for (let jdx = 0; jdx < xs.length; jdx++) {} }',
      '  return jdx;',
      '}',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.some(d => /Unbound variable: 'jdx'/.test(d.message))).toBe(true);
  });

  test('a var inside a nested function does not leak to the outer scope', () => {
    const src = [
      'function h() {',
      '  function inner() { var leaked = 1; return leaked; }',
      '  return leaked;',
      '}',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.some(d => /Unbound variable: 'leaked'/.test(d.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bug 3 — imported JS overload annotations surface every branch
// ---------------------------------------------------------------------------
describe('Bug 3: imported JS binding surfaces all overload annotations', () => {
  let tmpRoot: string;
  let ctx: ImportInferenceContext;
  let consumerUri: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-ovl-'));
    const composePath = path.join(tmpRoot, 'compose.js');
    const consumerPath = path.join(tmpRoot, 'consumer.js');
    fs.writeFileSync(composePath, [
      '// compose :: (b -> c) -> (a -> b) -> a -> c',
      '// compose :: (b -> c, a -> b) -> a -> c',
      'export const compose = (f, g) => x => f(g(x));',
    ].join('\n'));
    fs.writeFileSync(consumerPath, [
      'import { compose } from "./compose";',
      'const c = compose;',
    ].join('\n'));
    consumerUri = pathToFileURL(consumerPath).href;

    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    ctx = new ImportInferenceContext(docs, { warn: () => { /* noop */ } });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('getImportedRawSignature joins both overload signatures', () => {
    const raw = ctx.getImportedRawSignature('./compose', 'compose', consumerUri);
    expect(raw).not.toBeNull();
    expect(raw).toContain('(b -> c) -> (a -> b) -> a -> c');
    expect(raw).toContain('compose :: (b -> c, a -> b) -> a -> c');
  });
});

// ---------------------------------------------------------------------------
// Feature A — lensPath single overloaded form, selected by path length
// ---------------------------------------------------------------------------
describe('Feature A: lensPath single overloaded form', () => {
  const LENS = [
    '// lens :: (s -> a, (a, s) -> s) -> { getter :: s -> a, setter :: (a, s) -> s }',
    'const lens = (getter, setter) => ({ getter, setter });',
    '// view :: ({ getter :: s -> a, setter :: (a, s) -> s }, s) -> a',
    'const view = (l, obj) => l.getter(obj);',
    '// set :: ({ getter :: s -> a, setter :: (a, s) -> s }, a, s) -> s',
    'const set = (l, val, obj) => l.setter(val, obj);',
    '// over :: ({ getter :: s -> a, setter :: (a, s) -> s }, a -> a, s) -> s',
    'const over = (l, fn, obj) => l.setter(fn(l.getter(obj)), obj);',
    '// composeL :: ( { getter :: s -> b, setter :: (b, s) -> s }, { getter :: b -> c, setter :: (c, b) -> b } ) -> { getter :: s -> c, setter :: (c, s) -> s }',
    'const composeL = (outer, inner) => lens((s) => inner.getter(outer.getter(s)), (a, s) => outer.setter(inner.setter(a, outer.getter(s)), s));',
    '// lensProp :: (k) -> { getter :: { [k] :: a, ...r } -> a, setter :: (a, { [k] :: a, ...r }) -> { [k] :: a, ...r } }',
    'const lensProp = (key) => lens((obj) => obj[key], (val, obj) => ({ ...obj, [key]: val }));',
    '// lensPath :: ([k1,]) -> { getter :: { [k1] :: a, ...r } -> a, setter :: (a, { [k1] :: a, ...r }) -> { [k1] :: a, ...r } }',
    '// lensPath :: ([k1, k2]) -> { getter :: { [k1] :: { [k2] :: a, ...s }, ...r } -> a, setter :: (a, { [k1] :: { [k2] :: a, ...s }, ...r }) -> { [k1] :: { [k2] :: a, ...s }, ...r } }',
    '// lensPath :: ([k1, k2, k3]) -> { getter :: { [k1] :: { [k2] :: { [k3] :: a, ...t }, ...s }, ...r } -> a, setter :: (a, { [k1] :: { [k2] :: { [k3] :: a, ...t }, ...s }, ...r }) -> { [k1] :: { [k2] :: { [k3] :: a, ...t }, ...s }, ...r } }',
    'const lensPath = (keys) =>',
    '  keys.length === 1 ? lensProp(keys[0])',
    '  : keys.length === 2 ? composeL(lensProp(keys[0]), lensProp(keys[1]))',
    '  : composeL(composeL(lensProp(keys[0]), lensProp(keys[1])), lensProp(keys[2]));',
  ].join('\n');

  test('the definition alone produces no diagnostics', () => {
    const r = infer(LENS);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('view selects the branch by path length at depths 1, 2 and 3', () => {
    const r1 = infer(LENS + '\nconst v1 = view(lensPath(["a"]), { a: 42 });');
    const r2 = infer(LENS + '\nconst v2 = view(lensPath(["a", "b"]), { a: { b: 42 } });');
    const r3 = infer(LENS + '\nconst v3 = view(lensPath(["a", "b", "c"]), { a: { b: { c: 42 } } });');
    expect(r1.diagnostics.map(d => d.message)).toEqual([]);
    expect(r2.diagnostics.map(d => d.message)).toEqual([]);
    expect(r3.diagnostics.map(d => d.message)).toEqual([]);
    expect(bindingType(r1, 'v1')).toBe('Number');
    expect(bindingType(r2, 'v2')).toBe('Number');
    expect(bindingType(r3, 'v3')).toBe('Number');
  });

  test('set and over rebuild the focused whole at depth 2', () => {
    const rs = infer(LENS + '\nconst s2 = set(lensPath(["a", "b"]), 99, { a: { b: 42 } });');
    const ro = infer(LENS + '\nconst o2 = over(lensPath(["a", "b"]), x => x + 1, { a: { b: 42 } });');
    expect(rs.diagnostics.map(d => d.message)).toEqual([]);
    expect(ro.diagnostics.map(d => d.message)).toEqual([]);
    expect(bindingType(rs, 's2')).toBe('{ a :: { b :: Number } }');
    expect(bindingType(ro, 'o2')).toBe('{ a :: { b :: Number } }');
  });
});
