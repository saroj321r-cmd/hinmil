// `Function` and `Object` built-in type constructors now carry two *mandatory*
// children:
//   Function [params] result   — e.g. `Function [x, y] a` ≡ `(x, y) -> a`
//   Object   key   value       — e.g. `Object k a`        ≡ `{ [k] :: a }`
//
// This suite covers:
//   * arity diagnostics for a bare / wrong-arity `Function` or `Object`
//   * the "first child of Function must be a parameter-list array" diagnostic
//   * the desugaring equivalences enforced through duplicate-overload detection
//   * `Object k a` unifying with record literals (the `{ [k] :: a }` form)

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

function dupDiags(src: string): string[] {
  return diagsOf(src).filter(m => /Duplicate overload signature/.test(m));
}

describe('Function / Object mandatory children — arity diagnostics', () => {
  test('bare `Function` is an arity error (expects 2, got 0)', () => {
    const diags = diagsOf(`
// f :: Function -> Number
const f = (g) => 1;
`);
    expect(diags.some(m =>
      m.includes("'Function'") && m.includes('2 type arguments') && m.includes('got 0'))).toBe(true);
  });

  test('bare `Object` is an arity error (expects 2, got 0)', () => {
    const diags = diagsOf(`
// h :: Object -> Number
const h = (o) => 1;
`);
    expect(diags.some(m =>
      m.includes("'Object'") && m.includes('2 type arguments') && m.includes('got 0'))).toBe(true);
  });

  test('wrong-arity `Object a b c` reports expects 2, got 3', () => {
    const diags = diagsOf(`
// b :: Object a b c -> Number
const b = (o) => 1;
`);
    expect(diags.some(m =>
      m.includes("'Object'") && m.includes('2 type arguments') && m.includes('got 3'))).toBe(true);
  });

  test('well-formed `Function [x] a` produces no arity error', () => {
    const diags = diagsOf(`
// p :: Function [x] a -> Number
const p = (f) => 1;
`);
    expect(diags.some(m => m.includes('type argument'))).toBe(false);
  });

  test('well-formed `Object k a` produces no arity error', () => {
    const diags = diagsOf(`
// g :: Object k a -> Number
const g = (o) => 1;
`);
    expect(diags.some(m => m.includes('type argument'))).toBe(false);
  });
});

describe('Function first child must be a parameter-list array', () => {
  test('non-array first child (`Function p a`) is reported', () => {
    const diags = diagsOf(`
// q :: Function p a -> Number
const q = (f) => 1;
`);
    expect(diags.some(m =>
      m.includes("first child of 'Function'") && m.includes('parameter-list array'))).toBe(true);
  });

  test('empty parameter list (`Function [] a`) is accepted', () => {
    const diags = diagsOf(`
// thunk :: Function [] a -> a
const thunk = (f) => f();
`);
    expect(diags.some(m => m.includes("first child of 'Function'"))).toBe(false);
  });

  test('multi-parameter list (`Function [x, y] a`) is accepted', () => {
    const diags = diagsOf(`
// bin :: Function [x, y] a -> a
const bin = (f) => f(1, 2);
`);
    expect(diags.some(m => m.includes("first child of 'Function'"))).toBe(false);
  });
});

describe('Function / Object desugaring equivalences (duplicate overloads)', () => {
  test('`Function [x, y] a` ≡ `(x, y) -> a`', () => {
    const diags = dupDiags(`
// fn :: Function [x, y] a
// fn :: (x, y) -> a
const fn = (a, b) => a;
`);
    expect(diags).toHaveLength(1);
  });

  test('curried `Function [x] (Function [y] a)` ≡ `x -> y -> a`', () => {
    const diags = dupDiags(`
// h :: Function [x] (Function [y] a)
// h :: x -> y -> a
const h = a => b => a;
`);
    expect(diags).toHaveLength(1);
  });

  test('tupled and curried Function forms are NOT equivalent', () => {
    const diags = dupDiags(`
// k :: Function [x, y] a
// k :: Function [x] (Function [y] a)
const k = (a, b) => a;
`);
    expect(diags).toHaveLength(0);
  });

  test('`Object k a` ≡ `{ [k] :: a }`', () => {
    const diags = dupDiags(`
// g :: Object k a -> b
// g :: { [k] :: a } -> b
const g = (o) => o;
`);
    expect(diags).toHaveLength(1);
  });
});

describe('Object k a unifies with record literals', () => {
  test('`Object k a` annotation accepts a record literal argument', () => {
    const diags = diagsOf(`
// clone :: Object k a -> Object k a
const clone = (x) => x;
const r = clone({ x: 1, y: 2 });
`);
    expect(diags).toHaveLength(0);
  });
});
