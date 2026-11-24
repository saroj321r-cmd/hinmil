// =============================================================================
// Regression — constructor provenance must not leak out of nested functions.
//
// `blockHasThisAssignment` used to descend into nested function bodies, so a
// factory whose INNER function assigned to `this` was itself classified as a
// `function-this` constructor and calling it without `new` was flagged.
// (Found via fpkit's composeTypes applicative factory.)
// =============================================================================

import { diags } from '../helpers/infer';

describe('constructor provenance and nested this-assignments', () => {
  test('factory with nested function-this constructor is callable without new', () => {
    const src = `
function makeType(tag) {
  function Inner(value) {
    this.value = value;
    this.tag = tag;
  }
  return Inner;
}
const T = makeType("t");
`;
    expect(diags(src)).toEqual([]);
  });

  test('a real function-this constructor still requires new', () => {
    const src = `
const Box = function (value) {
  this.value = value;
};
const b = Box(1);
`;
    const d = diags(src);
    expect(d.some(m => m.includes("must be called with 'new'"))).toBe(true);
  });
});
