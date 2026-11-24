// Array#concat union widening + dedup — consolidated suite.
//
//   1. Plan v6.4 W1 — polymorphic Array#concat + arrayUnion row-opening mode.
//      Receiver-style `[…].concat([…])` uses the built-in Array#concat
//      signature `[a] ~> [b] -> [a | b]` directly.  Curried
//      `Semigroup s => s -> s -> s` applied to two array literals goes
//      through Phase D arrayUnion mode and produces `[Union γ₁ γ₂]`.
//   2. Dedup regression — union members produced by Array#concat `[a | b]`
//      must be flattened and deduplicated (no duplicate `Number` from the
//      nested unions of the two element types).

import { inferSource } from '../helpers/infer';
import { typeToString } from '../../src/hm/types';

function tsOf(src: string, binding: string): { ts: string; diags: string[] } {
  const r = inferSource(src);
  const b = r.topLevelBindings.get(binding);
  return {
    ts: b ? typeToString(b.type) : '<none>',
    diags: r.diagnostics.map(d => d.message),
  };
}

// ---------------------------------------------------------------------------
// 1. Plan v6.4 W1 — polymorphic Array#concat + arrayUnion row-opening mode.
// ---------------------------------------------------------------------------

describe('Plan v6.4 W1 — polymorphic Array#concat', () => {
  test('receiver-style: [1].concat([2]) :: [Number]', () => {
    const { ts, diags } = tsOf(`const r = [1].concat([2]);`, 'r');
    expect(diags).toHaveLength(0);
    expect(ts).toBe('[Number]');
  });

  test('receiver-style: [1].concat(["a"]) :: [Number | String]', () => {
    const { ts, diags } = tsOf(`const r = [1].concat(["a"]);`, 'r');
    expect(diags).toHaveLength(0);
    expect(ts).toMatch(/\[(Number \| String|String \| Number)\]/);
  });

  test('receiver-style with record elements: widens to [{x,y} | {y,z}]', () => {
    const src = `const r = [{x:1, y:2}].concat([{y:3, z:4}]);`;
    const { ts, diags } = tsOf(src, 'r');
    expect(diags).toHaveLength(0);
    // Should contain a Union of two record types inside an Array.
    expect(ts).toMatch(/^\[/);
    expect(ts).toContain('|');
    expect(ts).toContain('x :: Number');
    expect(ts).toContain('z :: Number');
  });

  test('curried Semigroup form: concat([1])([2]) :: [Number]', () => {
    const src = `
// ::constraint Semigroup s { s :: { concat :: s ~> s -> s } }
// concat :: Semigroup s => s -> s -> s
const concat = a => b => a.concat(b);
const r = concat([1])([2]);
    `;
    const { ts, diags } = tsOf(src, 'r');
    expect(diags).toHaveLength(0);
    expect(ts).toBe('[Number]');
  });

  test('curried Semigroup form: concat([1,"a"])([true]) widens to triple union', () => {
    const src = `
// ::constraint Semigroup s { s :: { concat :: s ~> s -> s } }
// concat :: Semigroup s => s -> s -> s
const concat = a => b => a.concat(b);
const r = concat([1, "a"])([true]);
    `;
    const { ts, diags } = tsOf(src, 'r');
    expect(diags).toHaveLength(0);
    expect(ts).toMatch(/^\[/);
    expect(ts).toContain('|');
    expect(ts).toContain('Number');
    expect(ts).toContain('String');
    expect(ts).toContain('Boolean');
  });

  test('curried form with record elements: concat([{x,y}])([{y,z}])', () => {
    const src = `
// ::constraint Semigroup s { s :: { concat :: s ~> s -> s } }
// concat :: Semigroup s => s -> s -> s
const concat = a => b => a.concat(b);
const r = concat([{x:1, y:2}])([{y:3, z:4}]);
    `;
    const { ts, diags } = tsOf(src, 'r');
    expect(diags).toHaveLength(0);
    expect(ts).toMatch(/^\[/);
    expect(ts).toContain('|');
    expect(ts).toContain('x :: Number');
    expect(ts).toContain('z :: Number');
  });
});

// ---------------------------------------------------------------------------
// 2. Regression: union members produced by Array#concat `[a | b]` must be
//    flattened and deduplicated.  Previously the nested unions arriving from
//    the two array element types survived as distinct members, yielding a
//    duplicate `Number` (e.g. `[Number | String | Number | Boolean]`).
// ---------------------------------------------------------------------------

describe('Array#concat union dedup (P5)', () => {
  test('annotated concat result union is deduplicated', () => {
    const src = `
// concat :: ([a], [b]) -> [a | b]
const concat = (arr, arr2) => arr.concat(arr2);
const c1 = concat([1, 2, "String"], [1, true]);
`;
    const { ts, diags } = tsOf(src, 'c1');
    expect(diags).toHaveLength(0);
    // No duplicate Number; exactly Number, String, Boolean in some order.
    const members = ts.replace(/^\[|\]$/g, '').split('|').map(s => s.trim()).sort();
    expect(members).toEqual(['Boolean', 'Number', 'String']);
  });

  test('receiver concat of overlapping unions has no duplicate', () => {
    const src = `const r = [1, "a"].concat([2, true]);`;
    const { ts, diags } = tsOf(src, 'r');
    expect(diags).toHaveLength(0);
    const members = ts.replace(/^\[|\]$/g, '').split('|').map(s => s.trim()).sort();
    expect(members).toEqual(['Boolean', 'Number', 'String']);
  });
});
