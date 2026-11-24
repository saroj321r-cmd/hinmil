// =============================================================================
// Rank-N phase 6 — skolem escape (the runST/brand pattern)
//
// A type bound by `forall` in an argument position may not leak into the
// result of the call: that would let callers observe the "secret" type.
// =============================================================================

import { diags } from '../helpers/infer';

describe('rank-N skolem escape', () => {
  test('identity leaking the brand into the result is flagged', () => {
    const src = `
// extract :: (forall s. s -> a) -> a
const extract = f => f(0);
const leaked = extract(x => x);
`;
    const d = diags(src);
    expect(d.some(m => m.includes('escapes its scope'))).toBe(true);
    expect(d.length).toBe(1);
  });

  test('constant callback does not escape', () => {
    const src = `
// extract :: (forall s. s -> a) -> a
const extract = f => f(0);
const fine = extract(_x => "safe");
`;
    expect(diags(src)).toEqual([]);
  });

  test('brand kept inside the callback is fine', () => {
    const src = `
// withSecret :: (forall s. s -> Number) -> Number
const withSecret = use => use({ token: 42 });
const ok = withSecret(_s => 7);
`;
    expect(diags(src)).toEqual([]);
  });
});
