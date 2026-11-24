// P3: empty-body constructor annotation trust.
// A function with an empty (unit-returning) body annotated to return a
// data/sum type should trust the annotation instead of emitting a spurious
// `has type '() -> ()' but annotation expects '() -> Maybe a'` mismatch.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  engine = new InferenceEngine();
});

describe('empty-body constructor annotation trust', () => {
  test('Nothing :: () -> Maybe a with empty body → no mismatch diagnostic', () => {
    const src = `
// Maybe :: Nothing | Just a
function Maybe() {
  throw TypeError ("You can't evaluate Maybe.");
}

// Nothing :: () -> Maybe a
function Nothing() {
}
`;
    const result = engine.infer(src);
    const mismatches = result.diagnostics.filter(d =>
      d.message.includes("has type '() -> ()'")
      || d.message.includes('annotation expects'));
    expect(mismatches).toEqual([]);
  });

  test('non-constructor empty body annotated to return a primitive still mismatches', () => {
    const src = `
// answer :: () -> Number
function answer() {
}
`;
    const result = engine.infer(src);
    const mismatches = result.diagnostics.filter(d =>
      d.message.includes('annotation expects'));
    // Number is not a data/sum type — trust does NOT apply, mismatch remains.
    expect(mismatches.length).toBeGreaterThan(0);
  });
});
