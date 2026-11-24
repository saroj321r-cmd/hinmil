// Spread-arrow chain combinator inference — consolidated suite.
//
// A spread arrow chain `a -> b -> ... -> z` in PARAMETER position absorbs a
// variable number of middle curried params, letting one signature accept
// functions of varying arity (the fpkit `applyArgs = reduce(apply)` combinator).
// This suite covers:
//   1. SpreadArray ~ Array equivalence — `[a, b, ...]` array args produce the
//      internal `SpreadArray` constructor, which must behave exactly like
//      `Array` for method lookup and typeclass-constraint (`Foldable`)
//      resolution, including `::rep`-covered constraint methods.
//   2. Standalone spread arrow chains — parsing, unification against concrete
//      curried functions, and the annotated `applyArgs` binding whose
//      signature overrules its infinite (type-changing fold) body.
//   3. Endomorphic wrappers `(a -> b -> ... -> z) -> a -> b -> ... -> z`
//      (memoize/once) — applying one to a concrete function must collapse the
//      result chain's spread to the argument's real arity.

import { inferSource, freshEngine, InferenceEngine } from '../helpers/infer';
import {
  typeToString,
  prettyTypeToString,
  Type,
} from '../../src/hm/types';
import { parseType } from '../../src/hm/typeParser';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';

// ---------------------------------------------------------------------------
// From tests/infer/spreadArrayFoldable.test.ts
// ---------------------------------------------------------------------------
// Follow-up: switching the `applyArgs` arg type from `[a]` to `[a, b, ...]`
// turns the second parameter into the internal `SpreadArray` constructor.
// `SpreadArray` is a positional view of a plain JS array, so for method and
// typeclass-constraint resolution it must behave exactly like `Array`.  Before
// the fix it was an unknown receiver, so a `Foldable`-constrained `reduce`
// reported a spurious presence failure:
//   Type 'SpreadArray' does not satisfy constraint 'Foldable': missing method 'reduce'

{
  const PRELUDE = `
// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }
// apply :: (a -> b) -> a -> b
const apply = (f) => (x) => f(x);
// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b
const reduce = (f) => (acc) => (xs) => acc;
`;

  function applyArgsDiags(arrSig: string): string[] {
    const src = `${PRELUDE}
// applyArgs :: (a -> b -> ... -> z) -> ${arrSig} -> z
const applyArgs = reduce(apply);
`;
    return inferSource(src).diagnostics.map((d) => d.message);
  }

  describe('SpreadArray behaves like Array for constraints/methods', () => {
    test('`[a, b, ...]` never reports the missing-method presence failure', () => {
      const diags = applyArgsDiags('[a, b, ...]');
      const presenceFailure = diags.filter((m) =>
        /does not satisfy constraint .*missing method/.test(m),
      );
      expect(presenceFailure).toEqual([]);
    });

    test('`[a, b, ...]` (SpreadArray) yields the same constraint outcome as `[a]` (Array)', () => {
      const arrayDiags = applyArgsDiags('[a]');
      const spreadDiags = applyArgsDiags('[a, b, ...]').map((m) =>
        m.replace(/SpreadArray/g, 'Array'),
      );
      expect(spreadDiags).toEqual(arrayDiags);
    });

    test('member access on a `[a, b, ...]` value resolves Array methods', () => {
      const src = `
// f :: [Number, String, ...] -> Number
const f = (xs) => xs.length;
`;
      const r = inferSource(src);
      const missingMethod = r.diagnostics.filter(
        (d) => d.message.includes('does not exist') || d.message.includes('missing method'),
      );
      expect(missingMethod).toEqual([]);
    });
  });

  describe('SpreadArray honours a `::rep`-covered constraint method', () => {
    // Mirrors fpkit src/fl/reduce.js: a `::rep Foldable Array#reduce` declares that
    // the (curried) `Array#reduce` annotation satisfies Foldable, so the built-in
    // native `Array.reduce` shape-check is intentionally skipped.  When the
    // Foldable variable resolved to `SpreadArray` (via a `[a, b, ...]` applier),
    // the rep was filtered out by `typeName === 'Array'` and the native reduce was
    // shape-checked, producing the spurious:
    //   method 'reduce' has signature '((b, a, Number, [a]) -> b, b | Undefined) -> b'
    //   which cannot be unified with the required '(b -> a -> b) -> b -> b'
    const REP_PRELUDE = `
// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }
const natives = {};
// ::rep Foldable Array#reduce
// natives.Array :: Array a ~> (b -> a -> b) -> b -> b
natives.Array = function () {};
// apply :: (a -> b) -> a -> b
const apply = (f) => (x) => f(x);
// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b
const reduce = (f) => (acc) => (xs) => acc;
`;

    function repDiags(arrSig: string): string[] {
      const src = `${REP_PRELUDE}
// applyArgs :: (a -> b -> ... -> z) -> ${arrSig} -> z
const applyArgs = reduce(apply);
`;
      return inferSource(src).diagnostics.map((d) => d.message);
    }

    test('`[a, b, ...]` does not report the native-reduce signature mismatch', () => {
      const mismatches = repDiags('[a, b, ...]').filter((m) =>
        /method 'reduce' has signature .* cannot be unified/.test(m),
      );
      expect(mismatches).toEqual([]);
    });

    test('`[a, b, ...]` yields the same constraint outcome as `[a]` with a ::rep', () => {
      const arrayDiags = repDiags('[a]');
      const spreadDiags = repDiags('[a, b, ...]').map((m) =>
        m.replace(/SpreadArray/g, 'Array'),
      );
      expect(spreadDiags).toEqual(arrayDiags);
    });
  });
}

// ---------------------------------------------------------------------------
// From tests/infer/spreadArrowChain.test.ts
// ---------------------------------------------------------------------------
// Phase B + integration: standalone spread arrow chains `a -> b -> ... -> z`
// and the `applyArgs = reduce(apply)` combinator they were designed for.
//
// A spread arrow chain in PARAMETER position absorbs a variable number of
// *middle* curried params when a concrete curried function is unified against
// it.  This lets a single signature accept functions of varying arity, which
// is exactly what the fpkit `applyArgs` combinator needs:
//
//   // apply     :: (a -> b) -> a -> b
//   // reduce    :: (b -> a -> b) -> b -> Array a -> b
//   // applyArgs :: (a -> b -> ... -> z) -> [a] -> z
//   const applyArgs = reduce(apply)
//
// The body `reduce(apply)` is a genuine type-changing fold (infinite type when
// unsigned), but the signature is authoritative and overrules it.

{
  function declType(
    result: ReturnType<InferenceEngine['infer']>,
    src: string,
    name: string,
  ): Type | null {
    const off = src.indexOf(`const ${name} = `) + 'const '.length;
    const entry = result.nodeTypes.get(off);
    return entry ? result.substitution.apply(entry.type) : null;
  }

  const PRELUDE = `
// apply :: (a -> b) -> a -> b
const apply = (f) => (x) => f(x);
// reduce :: (b -> a -> b) -> b -> Array a -> b
const reduce = (f) => (acc) => (xs) => acc;
`;

  describe('spread arrow chain — unification', () => {
    test('parses `a -> b -> ... -> z` with a spread arrow link', () => {
      const t = parseType('a -> b -> ... -> z');
      expect(t.tag).toBe('TFun');
      expect(typeToString(t)).toBe('a -> b -> ... -> z');
    });

    test('a 2-arg curried fn unifies against `(a -> b -> ... -> z)` param', () => {
      const src = `${PRELUDE}
// applyArgs :: (a -> b -> ... -> z) -> [a] -> z
const applyArgs = reduce(apply);
const ex = applyArgs(x => y => x + y)([1, 2]);
`;
      const r = inferSource(src);
      expect(declType(r, src, 'ex')).not.toBeNull();
      expect(typeToString(declType(r, src, 'ex')!)).toBe('Number');
    });

    test('a 1-arg fn is accepted by the variadic chain (permissive arity)', () => {
      const src = `${PRELUDE}
// applyArgs :: (a -> b -> ... -> z) -> [a] -> z
const applyArgs = reduce(apply);
const ex2 = applyArgs(x => x)([1]);
`;
      const r = inferSource(src);
      expect(typeToString(declType(r, src, 'ex2')!)).toBe('Number');
    });
  });

  describe('applyArgs integration — signature overrules infinite body', () => {
    test('the annotated `applyArgs = reduce(apply)` binding produces no diagnostics', () => {
      const src = `${PRELUDE}
// applyArgs :: (a -> b -> ... -> z) -> [a] -> z
const applyArgs = reduce(apply);
`;
      const r = inferSource(src);
      expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    });

    test('full end-to-end usage is clean', () => {
      const src = `${PRELUDE}
// applyArgs :: (a -> b -> ... -> z) -> [a] -> z
const applyArgs = reduce(apply);
const ex = applyArgs(x => y => x + y)([1, 2]);
const ex2 = applyArgs(x => x)([1]);
`;
      const r = inferSource(src);
      expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    });
  });
}

// ---------------------------------------------------------------------------
// From tests/infer/spreadChainEndomorphicCollapse.test.ts
// ---------------------------------------------------------------------------
// An endomorphic spread-arrow-chain wrapper — annotated
// `(a -> b -> ... -> z) -> a -> b -> ... -> z` (memoize / once / identity-
// preserving combinators) — returns a function of the SAME type as the one it
// receives.  Applying it to a CONCRETE curried function must collapse the
// result chain's spread `...` to the argument's real arity instead of leaving
// it (and any surplus fixed params) dangling.
//
// Regression: `memoizeCurried(greet2)` where `greet2 :: a -> b -> String`
// previously inferred `memoGreet2 :: a -> b -> ... -> String`; a 1-arg function
// `x => x + 1` inferred `Number -> b -> ... -> Number`.  Both should equal the
// argument's own type.

describe('endomorphic spread-arrow-chain wrapper collapses to the argument arity', () => {
  let engine: InferenceEngine;

  beforeEach(() => {
    clearDataTypes();
    engine = freshEngine();
  });

  const errs = (r: ReturnType<InferenceEngine['infer']>) =>
    r.diagnostics.filter(d => d.severity !== 3 && !/Unused/.test(d.message));

  const memoBase = [
    '// memoizeCurried :: (a -> b -> ... -> z) -> a -> b -> ... -> z',
    'const memoizeCurried = (fn) => {',
    '  const cache = new Map();',
    '  const memoized = (cacheNode, f) => (arg) => {',
    '    if (cacheNode.has(arg)) { return cacheNode.get(arg); }',
    '    const result = f(arg);',
    '    if (typeof result === "function") {',
    '      const nextCache = new Map();',
    '      const nextFn = memoized(nextCache, result);',
    '      cacheNode.set(arg, nextFn);',
    '      return nextFn;',
    '    }',
    '    cacheNode.set(arg, result);',
    '    return result;',
    '  };',
    '  return memoized(cache, fn);',
    '};',
  ].join('\n');

  function typeOf(r: ReturnType<InferenceEngine['infer']>, name: string): string {
    const b = r.topLevelBindings.get(name);
    return b ? prettyTypeToString(engine.subst.apply(b.type)) : '<none>';
  }

  test('2-arg concrete function: memoGreet2 :: a -> b -> String (no spread)', () => {
    const src = memoBase +
      '\nconst greet2 = name => age => name + " is " + age;' +
      '\nconst memoGreet2 = memoizeCurried(greet2);';
    const r = engine.infer(src);
    expect(errs(r)).toHaveLength(0);
    const t = typeOf(r, 'memoGreet2');
    expect(t).not.toContain('...');
    expect(t).toBe('a -> b -> String');
  });

  test('1-arg concrete function: mg1 :: Number -> Number (no spread, no surplus param)', () => {
    const src = memoBase +
      '\nconst g1 = x => x + 1;' +
      '\nconst mg1 = memoizeCurried(g1);';
    const r = engine.infer(src);
    expect(errs(r)).toHaveLength(0);
    const t = typeOf(r, 'mg1');
    expect(t).not.toContain('...');
    expect(t).toBe('Number -> Number');
  });

  test('the wrapper annotation itself still displays its spread chain', () => {
    const src = memoBase +
      '\nconst g1 = x => x + 1;' +
      '\nconst mg1 = memoizeCurried(g1);';
    const r = engine.infer(src);
    expect(typeOf(r, 'memoizeCurried')).toBe('(a -> b -> ... -> z) -> a -> b -> ... -> z');
  });
});
