// Regression coverage for immediately-invoked function expressions (IIFE).
//
// A zero-parameter arrow that returns a (possibly curried) function — e.g. the
// memoising wrapper at the bottom of fpkit's `fl/equals.js`:
//
//   const equals = (() => {
//     const pairs = [];
//     return value1 => value2 => ...;
//   })();
//
// must type as the RETURNED function (`a -> a -> Boolean`), not collapse the
// nullary level away.  Two cooperating fixes make this work:
//   1. a zero-param arrow is always wrapped as `() -> T` (even when `T` is
//      itself a function), preserving the nullary level; and
//   2. a zero-argument call of a `Void -> R` callee consumes only that single
//      Void parameter and yields `R`, instead of walking the result chain.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString } from '../../src/hm/types';
import type { Type } from '../../src/hm/types';

function infer(source: string) {
  return new InferenceEngine().infer(source);
}

function hoverType(
  r: ReturnType<InferenceEngine['infer']>,
  source: string,
  needle: string,
  offsetInNeedle = 0,
): string | null {
  const offset = source.indexOf(needle) + offsetInNeedle;
  let bestStart = -1;
  let bestType: Type | null = null;
  for (const [s, { type, end }] of r.nodeTypes) {
    if (s <= offset && offset < end && s > bestStart) {
      bestStart = s;
      bestType = r.substitution.apply(type);
    }
  }
  return bestType ? prettyTypeToString(bestType) : null;
}

beforeEach(() => resetTypeVarCounter());

describe('immediately-invoked function expressions (IIFE)', () => {
  test('IIFE returning a curried function (annotated) infers the function type', () => {
    const source = [
      '// equals :: a -> a -> Boolean',
      'const equals = (() => {',
      '  const pairs = [];',
      '  return value1 => value2 => value1 === value2;',
      '})();',
      'const z = equals(1)(2);',
    ].join('\n');
    const r = infer(source);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(hoverType(r, source, 'const equals', 'const '.length)).toBe('a -> a -> Boolean');
    expect(hoverType(r, source, 'const z', 'const '.length)).toBe('Boolean');
  });

  test('IIFE returning a curried function (no annotation) infers the function type', () => {
    const source = [
      'const equals = (() => {',
      '  return value1 => value2 => value1 === value2;',
      '})();',
      'const z = equals(1)(2);',
    ].join('\n');
    const r = infer(source);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(hoverType(r, source, 'const equals', 'const '.length)).toBe('a -> a -> Boolean');
  });

  test('IIFE with an expression body infers the returned function', () => {
    const source = [
      'const f = (() => x => x)();',
      'const y = f(1);',
    ].join('\n');
    const r = infer(source);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(hoverType(r, source, 'const f', 'const '.length)).toBe('a -> a');
    expect(hoverType(r, source, 'const y', 'const '.length)).toBe('Number');
  });

  test('a bare nullary thunk returning a function keeps the nullary level', () => {
    const source = ['const t = () => x => x;'].join('\n');
    const r = infer(source);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(hoverType(r, source, 'const t', 'const '.length)).toBe('() -> a -> a');
  });

  test('a nullary thunk returning a primitive still types as () -> T', () => {
    const source = [
      'const five = () => 5;',
      'const n = five();',
    ].join('\n');
    const r = infer(source);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(hoverType(r, source, 'const five', 'const '.length)).toBe('() -> Number');
    expect(hoverType(r, source, 'const n', 'const '.length)).toBe('Number');
  });

  test('overloaded annotation: IIFE params display the union across all branches', () => {
    // The annotated function is wrapped in an IIFE, so the overload-union
    // parameter display must descend through the thunk to the returned arrow
    // chain (`value1 => value2 => …`) — mirrors fpkit `fl/equals.js`.
    const source = [
      '// equals :: Setoid a => a -> a -> Boolean',
      '// equals :: Null -> Null -> Boolean',
      '// equals :: Undefined -> Undefined -> Boolean',
      '// equals :: Number -> Number -> Boolean',
      '// equals :: String -> String -> Boolean',
      '// equals :: Boolean -> Boolean -> Boolean',
      'const equals = (() => {',
      '  const pairs = [];',
      '  return value1 => value2 => value1 === value2;',
      '})();',
    ].join('\n');
    const r = infer(source);
    const expected = 'a | Boolean | Null | Number | String | Undefined';
    expect(hoverType(r, source, 'value1 => value2')).toBe(expected);
    expect(hoverType(r, source, 'value2 => value1')).toBe(expected);
  });

  test('overloaded annotation: expression-bodied IIFE params display the union', () => {
    const source = [
      '// equals :: Setoid a => a -> a -> Boolean',
      '// equals :: Number -> Number -> Boolean',
      '// equals :: String -> String -> Boolean',
      'const equals = (() => value1 => value2 => value1 === value2)();',
    ].join('\n');
    const r = infer(source);
    const expected = 'a | Number | String';
    expect(hoverType(r, source, 'value1 => value2')).toBe(expected);
    expect(hoverType(r, source, 'value2 => value1')).toBe(expected);
  });
});
