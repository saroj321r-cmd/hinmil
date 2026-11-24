// =============================================================================
// Rank-N phase 3 — call-site subsumption
//
// When a callee's annotation demands a `forall` parameter, arguments supplied
// at the call site must be genuinely polymorphic.  Monomorphic arguments are
// rejected with a targeted "not polymorphic enough" diagnostic; polymorphic
// identifiers and lambdas pass; skolems may not escape into the call result.
// =============================================================================

import { inferSource, diags } from '../helpers/infer';

describe('rank-N call-site subsumption', () => {
  test('polymorphic lambda argument is accepted', () => {
    const src = `
// applyBoth :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];
const r = applyBoth(x => x)(1, "one");
`;
    expect(diags(src)).toEqual([]);
  });

  test('monomorphic lambda argument is rejected', () => {
    const src = `
// applyBoth :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];
const r = applyBoth(x => x + 1)(1, "one");
`;
    const d = diags(src);
    expect(d.some(m => m.includes('not polymorphic enough'))).toBe(true);
  });

  test('polymorphic identifier argument is accepted', () => {
    const src = `
// applyBoth :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];
// id :: a -> a
const id = x => x;
const r = applyBoth(id)(1, "one");
`;
    expect(diags(src)).toEqual([]);
  });

  test('monomorphic identifier argument is rejected', () => {
    const src = `
// applyBoth :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];
// inc :: Number -> Number
const inc = x => x + 1;
const r = applyBoth(inc)(1, "one");
`;
    const d = diags(src);
    expect(d.some(m => m.includes('not polymorphic enough'))).toBe(true);
  });

  test('subsumption failure produces exactly one diagnostic (no cascade)', () => {
    const src = `
// applyBoth :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];
const r = applyBoth(x => x * 2)(1, "one");
`;
    const d = diags(src);
    expect(d.filter(m => m.includes('not polymorphic enough')).length).toBe(1);
    expect(d.length).toBe(1);
  });

  test('property access on the forall param is lenient (matches rank-1 skolems)', () => {
    // Rank-1 precedent: \`f :: a -> Number\` with body \`x.length\` is accepted
    // today — property access on skolems is deliberately lenient.  The
    // rank-N skolems behave identically.
    const src = `
// applyBoth :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];
const r = applyBoth(x => x.length)(1, "one");
`;
    expect(diags(src)).toEqual([]);
  });

  test('forall param can be forwarded to another forall slot', () => {
    const src = `
// applyBoth :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];
// outer :: (forall a. a -> a) -> [Number, String]
const outer = g => applyBoth(g)(1, "one");
`;
    expect(diags(src)).toEqual([]);
  });

  test('result of calling the forall param stays usable', () => {
    const src = `
// useAt :: (forall a. a -> a) -> String
const useAt = f => f("hello").toUpperCase();
const r = useAt(x => x);
`;
    expect(diags(src)).toEqual([]);
  });

  test('rank-1 callee still accepts monomorphic function args (compat)', () => {
    const src = `
// applyNum :: (Number -> Number) -> Number
const applyNum = f => f(1);
const r = applyNum(x => x + 1);
`;
    expect(diags(src)).toEqual([]);
  });

  test('constant-returning lambda is rejected against forall a. a -> a', () => {
    const src = `
// applyBoth :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];
const r = applyBoth(x => 42)(1, "one");
`;
    const d = diags(src);
    expect(d.some(m => m.includes('not polymorphic enough'))).toBe(true);
  });
});
