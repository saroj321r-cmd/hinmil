// =============================================================================
// Rank-N — Fase 2: body-semantiek van forall-parameters
//
// Een `forall`-geannoteerde parameter bindt in de functie-body als een echte
// polymorfe Scheme: elke use-site instantieert vers, zodat één parameter in
// één body op meerdere types gebruikt kan worden (het klassieke rank-2 gedrag).
// =============================================================================

import { inferSource, diags, isClean } from '../helpers/infer';
import { schemeToString } from '../../src/hm/types';

function bindingStr(source: string, name: string): string {
  const result = inferSource(source);
  const scheme = result.topLevelBindings.get(name);
  if (!scheme) throw new Error(`binding '${name}' not found`);
  return schemeToString(scheme);
}

describe('rank-N body semantics — polymorphic parameter use', () => {
  test('applyBoth: forall param used at two types in one body', () => {
    const src = `
// applyBoth :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];
`;
    expect(diags(src)).toEqual([]);
  });

  test('forall param used at Number AND String in one expression', () => {
    const src = `
// both :: (forall a. a -> a) -> Boolean
const both = f => f(1) > 0 && f("x").length > 0;
`;
    expect(diags(src)).toEqual([]);
  });

  test('body-swap is rejected (wildcard leniency does NOT mask the forall)', () => {
    const src = `
// swapped :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const swapped = f => (n, s) => [f(s), f(n)];
`;
    expect(diags(src).length).toBeGreaterThan(0);
  });

  test('binding scheme renders the quantifier', () => {
    const src = `
// applyBoth :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];
`;
    expect(bindingStr(src, 'applyBoth'))
      .toBe('(forall a. a -> a) -> (Number, String) -> [Number, String]');
  });

  test('multi-binder forall param: const at two instantiations', () => {
    const src = `
// pick :: (forall a b. a -> b -> a) -> Boolean
const pick = k => k(1)("x") > 0 && k("y")(2).length > 0;
`;
    expect(diags(src)).toEqual([]);
  });

  test('rank-2 param inside function declaration', () => {
    const src = `
// apply2 :: (forall a. a -> a, Number) -> Number
function apply2(f, n) {
  const s = f("probe");
  return s.length + f(n);
}
`;
    expect(diags(src)).toEqual([]);
  });

  test('misusing the forall param monomorphically across returns is rejected', () => {
    const src = `
// toStr :: (forall a. a -> a) -> Number -> String
const toStr = f => n => f(n);
`;
    expect(diags(src).length).toBeGreaterThan(0);
  });

  test('rank-1: a plain (a -> a) parameter is ONE type, so using it at two types is an error', () => {
    // Without `forall`, `a` is chosen by the caller: the body may not apply
    // `f` to both a Number and a String.  (Before strict const-arrow checking,
    // wildcards hid this; `function` declarations always reported it.)
    const src = `
// applyBoth :: (a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];
`;
    expect(diags(src).some(m => m.includes("Cannot unify 'a' with 'Number'"))).toBe(true);
  });

  test('unused forall param is harmless', () => {
    const src = `
// ignore :: (forall a. a -> a) -> Number
const ignore = f => 42;
`;
    expect(diags(src)).toEqual([]);
  });
});
