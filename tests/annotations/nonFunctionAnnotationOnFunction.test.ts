// Regression (P1): a function value annotated with a concrete, non-function
// data type (e.g. `// concat :: Array a`) must produce a type-mismatch
// diagnostic.  Previously the rigid check was skipped whenever the annotation
// return type contained a quantified variable, so a `Array a` annotation over
// a function silently passed.

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

describe('non-function annotation on a function value (P1)', () => {
  test('`Array a` annotation over a two-arg function reports a mismatch', () => {
    const src = `
// concat :: Array a
const concat = (arr, arr2) => arr.concat(arr2);
`;
    const diags = diagsOf(src);
    const mismatch = diags.filter(m => m.startsWith('Type mismatch:'));
    expect(mismatch.length).toBeGreaterThan(0);
  });

  test('concrete `Number` annotation over a function reports a mismatch', () => {
    const src = `
// f :: Number
const f = (x) => x + 1;
`;
    const diags = diagsOf(src);
    expect(diags.some(m => m.startsWith('Type mismatch:'))).toBe(true);
  });

  test('a correct function annotation produces no mismatch', () => {
    const src = `
// add :: (Number, Number) -> Number
const add = (a, b) => a + b;
`;
    const diags = diagsOf(src);
    expect(diags.filter(m => m.startsWith('Type mismatch:'))).toEqual([]);
  });

  test('a bare polymorphic annotation `a` is not flagged', () => {
    const src = `
// id :: a
const id = (x) => x;
`;
    const diags = diagsOf(src);
    expect(diags.filter(m => m.startsWith('Type mismatch:'))).toEqual([]);
  });
});
