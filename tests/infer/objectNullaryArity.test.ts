// P2 (corrected): truly nullary built-in types take NO type arguments.
// `String`, `Number`, `Boolean`, … all have arity 0, so `String a`, `Number a`,
// etc. must produce an arity diagnostic.  `Object` and `Function` are the
// exception: they now carry two *mandatory* children (`Object key value`,
// `Function [params] result`), so a bare `Object` is itself an arity error and
// `Object a b c` reports "expects 2 ... got 3".  Types that genuinely carry
// type parameters (`Array a`, `Map a b`, …) are unaffected.

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

describe('nullary built-in type arity (P2)', () => {
  test('`Object a b c` annotation reports an arity error', () => {
    const src = `
// build :: (Object k a, Object k a) -> Object a b c
const build = (x, y) => ({});
`;
    const diags = diagsOf(src);
    expect(diags.some(m =>
      m.includes("'Object'") && m.includes('2 type arguments') && m.includes('got 3'))).toBe(true);
  });

  test('`String a` annotation reports an arity error', () => {
    const src = `
// f :: (String a) -> Number
const f = (s) => 1;
`;
    const diags = diagsOf(src);
    expect(diags.some(m =>
      m.includes("'String'") && m.includes('0 type arguments'))).toBe(true);
  });

  test('`Number a` annotation reports an arity error', () => {
    const src = `
// g :: (Number a) -> Number
const g = (n) => 1;
`;
    const diags = diagsOf(src);
    expect(diags.some(m =>
      m.includes("'Number'") && m.includes('0 type arguments'))).toBe(true);
  });

  test('a bare `Object` annotation reports an arity error', () => {
    const src = `
// h :: (Object) -> Number
const h = (o) => 1;
const r = h({ x: 5 });
`;
    const diags = diagsOf(src);
    expect(diags.some(m =>
      m.includes("'Object'") && m.includes('2 type arguments') && m.includes('got 0'))).toBe(true);
  });

  test('parameterised built-ins (`Array a`, `Map a b`) are unaffected', () => {
    const src = `
// p :: (Array a, Map a b) -> Number
const p = (xs, m) => 1;
`;
    const diags = diagsOf(src);
    expect(diags.some(m => m.includes('type argument'))).toBe(false);
  });
});
