// Container-wrapped spread arrow-chain combinators — the `pipe` family and its
// cousins (`sample/demo9.js`).  A `Foldable` container of a spread arrow-chain
// `f (a -> b, b -> c, ..., y -> z)` must behave EXACTLY like the bare spread
// tuple `(...)` (demo2 ex3) and the spread array `[...]` (demo2 ex8):
//
//   * the combinator body infers cleanly against its chain-container annotation
//   * every call site (`combinator([f, g, ...])(x)`) threads the heterogeneous
//     element types through the chain instead of melting them into a union
//   * genuinely ill-typed chains and arity violations are still reported
//   * the fan-out combinator (`converge`) — same shape, multi-arity head — is
//     unaffected.

import * as fs from 'fs';
import * as path from 'path';
import { InferenceEngine } from '../../src/infer';
import { InferenceResult } from '../../src/infer';
import { prettyTypeToString, resetTypeVarCounter } from '../../src/hm/types';

function infer(src: string): InferenceResult {
  resetTypeVarCounter();
  return new InferenceEngine().infer(src);
}

function typeOf(r: InferenceResult, src: string, name: string): string | null {
  const needle = `const ${name} = `;
  const off = src.indexOf(needle) + 'const '.length;
  const entry = r.nodeTypes.get(off);
  return entry ? prettyTypeToString(r.substitution.apply(entry.type)) : null;
}

describe('demo9.js — container-wrapped spread arrow-chain cousins', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'sample', 'demo9.js'),
    'utf-8',
  );
  const r = infer(src);

  test('the whole file infers without diagnostics', () => {
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test.each([
    ['pipe1', 'Boolean'], // inline arrows, Number -> Number -> Boolean
    ['pipe2', 'Boolean'], // three-stage heterogeneous, ends String -> Boolean
    ['pipe3', 'Boolean'], // point-free application of a stored pipe
    ['pipe4', 'Boolean'], // named-function stages
    ['pipe5', 'Boolean'], // four-stage named + inline
    ['pipe6', 'Boolean'], // chain supplied as a plain variable, not a literal
    ['pipe7', 'Boolean'], // a pipe used as a stage inside another pipe
    ['pipe8', 'Boolean'], // point-free composition-returning pipe (pipeFn)
    ['compose1', 'Boolean'], // genuine right-to-left (reduceRight) container chain
    ['pipeK1', 'Box Boolean'], // Kleisli chain over a Chain functor
    ['converge1', 'Number'], // fan-out (multi-arity head) still recognised
    ['sum2', 'Number'], // applyArgs full application (2 levels, 2 elements)
    ['firstOf2', 'String'], // applyArgs heterogeneous element types tie to params
  ])('%s :: %s', (name, expected) => {
    expect(typeOf(r, src, name)).toBe(expected);
  });

  test('the partially-applied combinators have the expected arrow types', () => {
    expect(typeOf(r, src, 'numberToFlag')).toBe('Number -> Boolean');
    expect(typeOf(r, src, 'numberToFlag2')).toBe('Number -> Boolean');
    expect(typeOf(r, src, 'addTwice')).toBe('Number -> Number');
  });

  test('applyArgs partial application yields the curried remainder', () => {
    // 3 curried levels, 2 elements supplied -> one argument still outstanding
    expect(typeOf(r, src, 'addThreePartial')).toBe('a -> Number');
  });
});

// --------------------------------------------------------------------------
// Soundness: the chain machinery must NOT paper over real errors.
// --------------------------------------------------------------------------

const PRELUDE = [
  '"use strict";',
  '// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }',
  'let natives = {};',
  '// ::rep Foldable Array#reduce',
  '// natives.Array :: Array a ~> (b -> a -> b) -> b -> b',
  'natives.Array = function (fn) { return init => this.reduce((acc, value) => fn(acc)(value), init); };',
  '// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b',
  'const reduce = fn => init => foldable => natives.Array(fn)(init);',
  '// applyTo :: a -> (a -> b) -> b',
  'const applyTo = value => fn => fn(value);',
  '// pipe :: Foldable f => f (a -> b, b -> c, ..., y -> z) -> a -> z',
  'const pipe = foldable => value => reduce(applyTo)(value)(foldable);',
  '',
].join('\n');

describe('container spread chain — soundness gates', () => {
  test('a broken link in the chain is reported', () => {
    // stage 1 yields Number, stage 2 (`x.length`) demands String
    const r = infer(`${PRELUDE}const bad = pipe([x => x + 1, x => x.length])(3);\n`);
    expect(
      r.diagnostics.some(d => /length.*does not exist on type Number/.test(d.message)),
    ).toBe(true);
  });

  test('a single-stage chain is accepted (the `...` allows one link)', () => {
    // `[x => x + 1]` is a one-link chain: Number -> Number applied to 3.
    const r = infer(`${PRELUDE}const single = pipe([x => x + 1])(3);\n`);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(
      r.diagnostics.some(d => /expected at least/.test(d.message)),
    ).toBe(false);
  });

  test('an empty chain is accepted as the identity `a -> a`', () => {
    // `pipe([])` is the empty fold: it returns its input unchanged, so the
    // result of applying it to `3` is `3` (Number).
    const r = infer(`${PRELUDE}const identity = pipe([]);\n`);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(
      r.diagnostics.some(d => /expected at least/.test(d.message)),
    ).toBe(false);
  });
});

// --------------------------------------------------------------------------
// applyArgs (the DUAL rule) soundness: over-application is a hard error.
// --------------------------------------------------------------------------

const APPLY_PRELUDE = [
  '"use strict";',
  '// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }',
  'let natives = {};',
  '// ::rep Foldable Array#reduce',
  '// natives.Array :: Array a ~> (b -> a -> b) -> b -> b',
  'natives.Array = function (fn) { return init => this.reduce((acc, value) => fn(acc)(value), init); };',
  '// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b',
  'const reduce = fn => init => foldable => natives.Array(fn)(init);',
  '// apply :: (a -> b) -> a -> b',
  'const apply = fn => value => fn(value);',
  '// applyArgs :: (a -> b -> ... -> z) -> [a, b, ...] -> z',
  'const applyArgs = reduce(apply);',
  '',
].join('\n');

describe('applyArgs — peeling soundness gates', () => {
  test('over-application (more elements than curried levels) is reported', () => {
    const r = infer(`${APPLY_PRELUDE}const bad = applyArgs(x => x)([1, 2]);\n`);
    expect(
      r.diagnostics.some(d => /takes at most 1 argument/.test(d.message)),
    ).toBe(true);
  });

  test('a matching arity is NOT flagged as over-application', () => {
    const r = infer(`${APPLY_PRELUDE}const ok = applyArgs(x => y => x + y)([1, 2]);\n`);
    expect(r.diagnostics.some(d => /takes at most/.test(d.message))).toBe(false);
  });
});
