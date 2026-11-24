/**
 * Option 2 — JS body parameter defaults make trailing slots optional at call sites.
 *
 * When a function implementation declares a parameter with a JS default
 * (`(x = ...)`), the corresponding annotation slot becomes optional in the
 * call-site arity check.  This complements option 1 (declaring the slot
 * type as `... | Undefined` in the annotation) and lets users skip
 * trailing arguments without ceremony.
 *
 * The `= undefined` default is treated purely as an optionality marker
 * (no unification) so the annotation type for that slot stays polymorphic.
 * Any other default value (`= []`, `= 0`, …) still ties the slot's type
 * to the default — the slot is optional but its type is constrained.
 */

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';

beforeEach(() => resetTypeVarCounter());

function infer(src: string) {
  const e = new InferenceEngine();
  return e.infer(src).diagnostics.map(d => d.message);
}

describe('JS default parameters mark trailing slots optional', () => {
  test('trailing `= undefined` accepts shorter call (annotated arrow)', () => {
    const diags = infer(`
// Path :: (a, [b], c) -> a
const Path = (k, r, d = undefined) => k;
const x = Path("p", [1,2]);
const y = Path("p", [1,2], 3);
`);
    expect(diags).toEqual([]);
  });

  test('trailing `= undefined` accepts shorter call (function declaration)', () => {
    const diags = infer(`
// Path :: (a, [b], c) -> a
function Path(k, r, d = undefined) { return k; }
const x = Path("p", [1,2]);
const y = Path("p", [1,2], 3);
`);
    expect(diags).toEqual([]);
  });

  test('multiple trailing defaults — every prefix length is accepted', () => {
    const diags = infer(`
// F :: (a, Number, c) -> a
const F = (x, y = 0, z = undefined) => x;
F("a");
F("a", 1);
F("a", 1, 2);
`);
    expect(diags).toEqual([]);
  });

  test('non-trailing default does not relax arity for shorter calls', () => {
    const diags = infer(`
// G :: (a, b, c) -> a
const G = (x, y = 0, z) => x;
G("a", 1);
`);
    // Missing slot is index 2 (z), which is NOT optional — arity diag fires.
    expect(diags.some(d => /Expected 3 argument.* but got 2/.test(d))).toBe(true);
  });

  test('`= undefined` default does not bind the polymorphic slot type', () => {
    // If `d = undefined` were unified with the slot's type, `c` would
    // collapse to `Undefined` and the explicit-arg call would conflict.
    const diags = infer(`
// H :: (a, c) -> a
function H(k, d = undefined) { return k; }
const x = H("p", 42);
const y = H("p", "s");
`);
    expect(diags).toEqual([]);
  });

  test('non-undefined default constrains the slot type at the param site', () => {
    // The default value's type unifies with the slot's type; mixing an
    // unrelated default with an annotation slot of a different type must
    // produce a diagnostic at the function definition.
    const diags = infer(`
// K :: (a, [b]) -> a
function K(k, n = "wrong") { return k; }
K("p", [1]);
`);
    expect(diags.length).toBeGreaterThan(0);
  });  test('option 1 + option 2 together — annotation `| Undefined` and JS default both work', () => {
    const diags = infer(`
// J :: (a, c | Undefined) -> a
const J = (k, d = undefined) => k;
J("p");
J("p", 1);
`);
    expect(diags).toEqual([]);
  });

  test('member-access call respects optional slots from RHS function defaults', () => {
    const diags = infer(`
// Param :: Path a b c
const Param = {};
// Path :: Param.Path :: (a, [b], c) -> Param a b c
const Path = Param.Path = (key, rules, defaultValue = undefined) => key;
const direct = Path("k", [1,2]);
const member = Param.Path("k", [1,2]);
`);
    // Neither call should produce an arity diagnostic.
    expect(diags.filter(d => /Expected 3 argument.* but got 2/.test(d))).toEqual([]);
  });
});
