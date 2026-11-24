// Regression: chained `// X :: Obj.X :: sig` annotation must produce
// symmetric diagnostics for direct calls (`X(...)`) and member-access
// calls (`Obj.X(...)`).  Two specific behaviours are exercised:
//
//  1. A heterogeneous array literal `[1, "3"]` passed to a parameter
//     typed `[b]` (b free) is widened to `Number | String` instead of
//     producing a "Cannot unify" diagnostic on the second element.
//     This must hold for BOTH the direct and member-access call paths.
//
//  2. A union constraint like `(String | Boolean) b =>` must be
//     enforced at every call site — including member-access — and a
//     widened element-union must satisfy the constraint *for every
//     member*, not just one.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  engine = new InferenceEngine();
});

const PRELUDE = `
// Param :: Path a b c | Query a b c
const Param = {};

// Path :: Param.Path :: (a, [b], c) -> Param a b c
const Path = Param.Path = (key, rules, defaultValue) => key;

// Query :: Param.Query :: (String | Boolean) b => (a, [b], c) -> Param a b c
const Query = Param.Query = (key, rules, defaultValue) => key;
`;

function inferAndDiags(extra: string) {
  const src = PRELUDE + extra;
  const r = engine.infer(src);
  return r.diagnostics.map(d => d.message);
}

describe('chained annotation X :: Obj.X — symmetric call diagnostics', () => {
  test('direct call: heterogeneous [1, "3"] on free [b] is accepted (widened to union)', () => {
    const diags = inferAndDiags(`const r = Path("p", [1, "3"], undefined);\n`);
    const elemMismatch = diags.filter(m =>
      m.includes('Cannot unify') && m.includes('String') && m.includes('Number'));
    expect(elemMismatch).toEqual([]);
  });

  test('member-access call: heterogeneous [1, "3"] on free [b] is accepted', () => {
    const diags = inferAndDiags(`const r = Param.Path("p", [1, "3"], undefined);\n`);
    const elemMismatch = diags.filter(m =>
      m.includes('Cannot unify') && m.includes('String') && m.includes('Number'));
    expect(elemMismatch).toEqual([]);
  });

  test('direct call: [1, true] violates (String | Boolean) constraint', () => {
    const diags = inferAndDiags(`const r = Query("q", [1, true], undefined);\n`);
    const violations = diags.filter(m =>
      m.includes('does not satisfy union constraint'));
    expect(violations.length).toBeGreaterThan(0);
    // The offending member must be reported.
    expect(violations.some(m => m.includes("'Number'"))).toBe(true);
  });

  test('member-access call: [1, true] violates (String | Boolean) constraint', () => {
    const diags = inferAndDiags(`const r = Param.Query("q", [1, true], undefined);\n`);
    const violations = diags.filter(m =>
      m.includes('does not satisfy union constraint'));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(m => m.includes("'Number'"))).toBe(true);
  });

  test('member-access call: [true] (single, satisfies constraint) → no violation', () => {
    const diags = inferAndDiags(`const r = Param.Query("q", [true], undefined);\n`);
    const violations = diags.filter(m =>
      m.includes('does not satisfy union constraint'));
    expect(violations).toEqual([]);
  });

  test('direct vs member-access calls produce the same diagnostics shape', () => {
    const direct = inferAndDiags(`const r = Query("q", [1, true], undefined);\n`)
      .filter(m => m.includes('does not satisfy union constraint'));
    const member = inferAndDiags(`const r = Param.Query("q", [1, true], undefined);\n`)
      .filter(m => m.includes('does not satisfy union constraint'));
    expect(direct.length).toBe(member.length);
  });

  test('aliased member-access: const A = Param; A.Query([1, true], …) violates constraint', () => {
    const diags = inferAndDiags(
      `const Aliased = Param;\n`
      + `const r = Aliased.Query("q", [1, true], undefined);\n`,
    );
    const violations = diags.filter(m =>
      m.includes('does not satisfy union constraint'));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(m => m.includes("'Number'"))).toBe(true);
  });

  test('aliased member-access: heterogeneous [1, "3"] on free [b] is accepted', () => {
    const diags = inferAndDiags(
      `const Aliased = Param;\n`
      + `const r = Aliased.Path("p", [1, "3"], undefined);\n`,
    );
    const elemMismatch = diags.filter(m =>
      m.includes('Cannot unify') && m.includes('String') && m.includes('Number'));
    expect(elemMismatch).toEqual([]);
  });
});
