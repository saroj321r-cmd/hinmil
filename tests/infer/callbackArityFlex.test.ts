// Flexible callback arity: a callback that accepts *more* arguments than the
// expected function type is accepted, because the extra parameters are simply
// ignored at runtime.  This mirrors how native higher-order methods supply
// extra arguments (e.g. Array#reduce passes `(acc, x, index, array)`).
//
//   Scenario A — an arrow with extra params (`(a, b) => a`) is accepted where a
//                unary `a -> b` callback is expected.
//   Scenario B — a 4-parameter reduce callback satisfies the 2-parameter
//                reducer the Foldable/Array#reduce signature expects.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

function diagsOf(src: string): string[] {
  return engine.infer(src).diagnostics.map(d => d.message);
}

describe('flexible callback arity (extra params allowed)', () => {
  test('Scenario A — `(a, b) => a` accepted where `a -> b` is expected', () => {
    const diags = diagsOf(`
// applyUnary :: (a -> b) -> a -> b
const applyUnary = f => x => f(x);
const r = applyUnary((a, b) => a);
`);
    expect(diags).toHaveLength(0);
  });

  test('Scenario B — native 4-param reduce callback satisfies the reducer', () => {
    const diags = diagsOf(`
// sum :: [Number] -> Number
const sum = xs => xs.reduce((acc, x, i, arr) => acc + x, 0);
`);
    expect(diags).toHaveLength(0);
  });

  test('a 3-param reduce callback is also accepted', () => {
    const diags = diagsOf(`
// total :: [Number] -> Number
const total = xs => xs.reduce((acc, x, i) => acc + x, 0);
`);
    expect(diags).toHaveLength(0);
  });

  test('exact-arity callback still works (no regression)', () => {
    const diags = diagsOf(`
// applyUnary :: (a -> b) -> a -> b
const applyUnary = f => x => f(x);
const r = applyUnary((a) => a);
`);
    expect(diags).toHaveLength(0);
  });
});
