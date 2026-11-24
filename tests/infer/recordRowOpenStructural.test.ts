// Plan v6.3 Phase D — structural row-opening at the call site.
// Row-opening is OPT-IN: it fires only when the user has declared a
// Merge-form (spread-sugar) signature on `Object#<method>` for some
// method required by one of the constraints attached to the polymorphic
// TVars in the callee's scheme.
//
// Without that opt-in, structural args keep classical rigid HM —
// `f :: a -> a -> a` applied to two different records reports the
// normal unification mismatch.

import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

const OPT_IN_PREAMBLE = `
// ::constraint Semigroup a { a :: { concat :: a ~> a -> a } }
// Object#concat :: { ...a } ~> { ...b } -> { ...a, ...b }
// f :: Semigroup a => a -> a -> a
const f = x => y => x.concat(y);
`;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

function tsOf(src: string): { ts: string; diags: string[] } {
  const r = engine.infer(src);
  return { ts: typeToString(r.type), diags: r.diagnostics.map(d => d.message) };
}

describe('Plan v6.3 — structural row-opening (opt-in via Merge-form Object#method)', () => {
  test('without opt-in, `f :: a -> a -> a` does NOT row-open record args', () => {
    const { diags } = tsOf(`
// f :: a -> a -> a
const f = x => y => x;
const r = f({ a: 1 })({ b: 2 });
    `);
    // Classical HM: { a :: Number } and { b :: Number } don't unify.
    expect(diags.length).toBeGreaterThanOrEqual(1);
  });

  test('with opt-in, disjoint record fields collapse into a single record via Merge', () => {
    const { ts, diags } = tsOf(`${OPT_IN_PREAMBLE}
const r = f({ a: 1 })({ b: 2 });
    `);
    expect(diags).toHaveLength(0);
    expect(ts).toContain('a :: Number');
    expect(ts).toContain('b :: Number');
  });

  test('with opt-in, overlapping record fields of matching types unify cleanly', () => {
    const { ts, diags } = tsOf(`${OPT_IN_PREAMBLE}
const r = f({ a: 1, b: 2 })({ b: 3, c: 4 });
    `);
    expect(diags).toHaveLength(0);
    expect(ts).toContain('a :: Number');
    expect(ts).toContain('b :: Number');
    expect(ts).toContain('c :: Number');
  });

  test('with opt-in, conflicting field types union into a single field', () => {
    const { ts, diags } = tsOf(`${OPT_IN_PREAMBLE}
const r = f({ a: 1 })({ a: "x" });
    `);
    // Overlapping keys with differing value types are merged into a single,
    // deduplicated field whose type is the union of the two (no diagnostic).
    expect(diags).toHaveLength(0);
    expect(ts).toMatch(/a :: (Number \| String|String \| Number)/);
  });

  test('array args row-open into [Union ...] under arrayUnion mode', () => {
    const { ts, diags } = tsOf(`${OPT_IN_PREAMBLE}
const r = f([ 1 ])([ 2 ]);
    `);
    // Plan v6.4 W1: ArrayExpression args at polymorphic positions trigger
    // array-element widening; identical element types collapse via Union
    // dedup back to `[Number]`.
    expect(diags).toHaveLength(0);
    expect(ts).toContain('[Number]');
  });

  test('mismatched array element types widen into [Number | String]', () => {
    const { ts, diags } = tsOf(`${OPT_IN_PREAMBLE}
const r = f([ 1 ])([ "a" ]);
    `);
    // Plan v6.4 W1: array-element union — no diagnostic; result is a Union.
    expect(diags).toHaveLength(0);
    expect(ts).toMatch(/\[(Number \| String|String \| Number)\]/);
  });

  test('with opt-in, mixed record + non-record yields a diagnostic', () => {
    const { diags } = tsOf(`${OPT_IN_PREAMBLE}
const r = f({ a: 1 })(2);
    `);
    expect(diags.length).toBeGreaterThanOrEqual(1);
  });

  test('id :: a -> a with a record argument is unchanged (no row-opening needed)', () => {
    const { ts, diags } = tsOf(`
// id :: a -> a
const id = x => x;
const r = id({ a: 1 });
    `);
    expect(diags).toHaveLength(0);
    expect(ts).toContain('a :: Number');
  });
});
