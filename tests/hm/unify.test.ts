import { unify, UnificationError } from '../../src/hm/unify';
import {
  tVar,
  tNumber,
  tString,
  tBool,
  tFun,
  tCon,
  tArray,
  tRecord,
  typeToString,
  resetTypeVarCounter,
  T_TYPEREP,
  tAnyType, T_TUPLE } from '../../src/hm/types';

beforeEach(() => {
  resetTypeVarCounter();
});

describe('Unification', () => {
  test('identical concrete types unify trivially', () => {
    const s = unify(tNumber, tNumber);
    expect(s.size).toBe(0);
  });

  test('variable unifies with concrete type', () => {
    const a = tVar('a');
    const s = unify(a, tNumber);
    expect(typeToString(s.apply(a))).toBe('Number');
  });

  test('concrete type unifies with variable', () => {
    const a = tVar('a');
    const s = unify(tString, a);
    expect(typeToString(s.apply(a))).toBe('String');
  });

  test('two variables unify', () => {
    const a = tVar('a');
    const b = tVar('b');
    const s = unify(a, b);
    // After unification a and b should resolve to the same type
    expect(typeToString(s.apply(a))).toBe(typeToString(s.apply(b)));
  });

  test('same variable unifies with itself', () => {
    const a = tVar('a');
    const s = unify(a, a);
    expect(s.size).toBe(0);
  });

  test('function types unify', () => {
    const a = tVar('a');
    const b = tVar('b');
    const fn1 = tFun(a, tNumber);
    const fn2 = tFun(tString, b);
    const s = unify(fn1, fn2);
    expect(typeToString(s.apply(a))).toBe('String');
    expect(typeToString(s.apply(b))).toBe('Number');
  });

  test('constructed types with same name unify', () => {
    const a = tVar('a');
    const arr1 = tArray(a);
    const arr2 = tArray(tNumber);
    const s = unify(arr1, arr2);
    expect(typeToString(s.apply(a))).toBe('Number');
  });

  test('different concrete types fail', () => {
    expect(() => unify(tNumber, tString)).toThrow(UnificationError);
  });

  test('different constructed type names fail', () => {
    expect(() => unify(tCon('Foo'), tCon('Bar'))).toThrow(UnificationError);
  });

  test('different arity constructed types fail', () => {
    expect(() => unify(tCon('X', [tNumber]), tCon('X', [tNumber, tString]))).toThrow(
      UnificationError,
    );
  });

  test('function vs concrete type fail', () => {
    expect(() => unify(tFun(tNumber, tString), tNumber)).toThrow(UnificationError);
  });

  test('occurs check prevents infinite types', () => {
    const a = tVar('a');
    expect(() => unify(a, tFun(a, tNumber))).toThrow(/Infinite type/);
  });

  test('nested function unification', () => {
    const a = tVar('a');
    const b = tVar('b');
    // (a -> b) ~ (Number -> (String -> Boolean))
    const fn1 = tFun(a, b);
    const fn2 = tFun(tNumber, tFun(tString, tBool));
    const s = unify(fn1, fn2);
    expect(typeToString(s.apply(a))).toBe('Number');
    expect(typeToString(s.apply(b))).toBe('String -> Boolean');
  });

  test('transitive unification', () => {
    const a = tVar('a');
    const b = tVar('b');
    const c = tVar('c');
    // a ~ b, then b ~ Number => a should be Number
    const s1 = unify(a, b);
    const s2 = unify(s1.apply(b), tNumber);
    const composed = s2.compose(s1);
    expect(typeToString(composed.apply(a))).toBe('Number');
    expect(typeToString(composed.apply(b))).toBe('Number');
  });

  // ---- Wildcard unification ----
  test('wildcard unifies with concrete type', () => {
    const s = unify(tCon('*'), tNumber);
    expect(s.size).toBe(0);
  });

  test('wildcard unifies with TVar (binds TVar to wildcard)', () => {
    const a = tVar('a');
    const s = unify(tCon('*'), a);
    expect(s.size).toBe(1);
    expect(typeToString(s.apply(a))).toBe('*');
  });

  test('TVar unifies with wildcard (binds TVar to wildcard)', () => {
    const a = tVar('a');
    const s = unify(a, tCon('*'));
    expect(s.size).toBe(1);
    expect(typeToString(s.apply(a))).toBe('*');
  });

  test('named wildcard unifies with concrete type', () => {
    const s = unify(tCon('*:foo'), tNumber);
    expect(s.size).toBe(0);
  });

  test('named wildcard unifies with TVar', () => {
    const a = tVar('a');
    const s = unify(tCon('*:foo'), a);
    expect(s.size).toBe(1);
  });

  // ---- Union unification ----
  test('union unifies with matching member', () => {
    const union = tCon('Union', [tNumber, tString]);
    const s = unify(union, tNumber);
    expect(s.size).toBe(0);
  });

  test('union on right side unifies with matching member', () => {
    const union = tCon('Union', [tNumber, tString]);
    const s = unify(tString, union);
    expect(s.size).toBe(0);
  });

  test('union fails with non-matching type', () => {
    const union = tCon('Union', [tNumber, tString]);
    expect(() => unify(union, tBool)).toThrow(UnificationError);
  });

  test('union vs union: subset succeeds', () => {
    const u1 = tCon('Union', [tNumber, tString, tBool]);
    const u2 = tCon('Union', [tNumber, tBool]);
    const s = unify(u1, u2);
    expect(s.size).toBe(0);
  });

  test('union vs union: non-subset fails', () => {
    const u1 = tCon('Union', [tNumber]);
    const u2 = tCon('Union', [tString, tBool]);
    expect(() => unify(u1, u2)).toThrow(UnificationError);
  });

  // ---- Kind variable unification ----
  test('kind variable unifies with concrete constructor', () => {
    const a = tVar('a');
    const kv = tCon(`$kv:f:${a.id}`, [tNumber]);
    const concrete = tCon('Array', [tNumber]);
    const s = unify(kv, concrete);
    const resolved = s.apply(a);
    expect(resolved.tag).toBe('TCon');
    if (resolved.tag === 'TCon') expect(resolved.name).toBe('Array');
  });

  test('concrete constructor unifies with kind variable', () => {
    const a = tVar('a');
    const kv = tCon(`$kv:f:${a.id}`, [tNumber]);
    const concrete = tCon('Array', [tNumber]);
    const s = unify(concrete, kv);
    const resolved = s.apply(a);
    expect(resolved.tag).toBe('TCon');
    if (resolved.tag === 'TCon') expect(resolved.name).toBe('Array');
  });

  test('two kind variables with same id unify args', () => {
    const a = tVar('f');
    const b = tVar('x');
    const c = tVar('y');
    const kv1 = tCon(`$kv:f:${a.id}`, [b]);
    const kv2 = tCon(`$kv:f:${a.id}`, [tNumber]);
    const s = unify(kv1, kv2);
    expect(typeToString(s.apply(b))).toBe('Number');
  });

  test('two kind variables with different ids unify', () => {
    const a = tVar('f');
    const b = tVar('g');
    const kv1 = tCon(`$kv:f:${a.id}`, [tNumber]);
    const kv2 = tCon(`$kv:g:${b.id}`, [tNumber]);
    const s = unify(kv1, kv2);
    // One should be bound to the other
    expect(s.size).toBeGreaterThan(0);
  });

  test('kind variable arity mismatch fails', () => {
    const a = tVar('f');
    const kv = tCon(`$kv:f:${a.id}`, [tNumber]);
    const concrete = tCon('Array', [tNumber, tString]);
    expect(() => unify(kv, concrete)).toThrow(UnificationError);
  });

  // ---- Record unification ----
  test('two records with common fields unify', () => {
    const r1 = { tag: 'TRecord' as const, fields: { x: tNumber, y: tString } };
    const a = tVar('a');
    const r2 = { tag: 'TRecord' as const, fields: { x: a } };
    const s = unify(r1, r2);
    expect(typeToString(s.apply(a))).toBe('Number');
  });

  test('records with no overlapping fields unify trivially', () => {
    const r1 = { tag: 'TRecord' as const, fields: { x: tNumber } };
    const r2 = { tag: 'TRecord' as const, fields: { y: tString } };
    const s = unify(r1, r2);
    expect(s.size).toBe(0);
  });

  test('wildcard TCon unifies with TRecord', () => {
    const r = { tag: 'TRecord' as const, fields: { x: tNumber } };
    const w = tCon('*');
    const s = unify(w, r);
    expect(s.size).toBe(0);
  });

  test('non-wildcard TCon fails with TRecord', () => {
    const r = { tag: 'TRecord' as const, fields: { x: tNumber } };
    const c = tCon('Foo');
    expect(() => unify(c, r)).toThrow(UnificationError);
  });

  // ---- Wildcard+Wildcard unification ----
  test('wildcard unifies with wildcard', () => {
    const s = unify(tCon('*'), tCon('*'));
    expect(s.size).toBe(0);
  });

  test('named wildcard unifies with named wildcard', () => {
    const s = unify(tCon('*:a'), tCon('*:b'));
    expect(s.size).toBe(0);
  });

  test('concrete type on left unifies with wildcard on right', () => {
    const s = unify(tNumber, tCon('*'));
    expect(s.size).toBe(0);
  });

  test('function type on left unifies with wildcard on right', () => {
    const s = unify(tFun(tNumber, tString), tCon('*'));
    expect(s.size).toBe(0);
  });

  // ---- Occurs check with t2 as TVar ----
  test('occurs check prevents infinite types (t2 is TVar)', () => {
    const a = tVar('a');
    expect(() => unify(tFun(a, tNumber), a)).toThrow(/Infinite type/);
  });

  // ---- Both wildcards ----
  test('wildcard + wildcard unifies to empty substitution', () => {
    const s = unify(tCon('*'), tCon('*'));
    expect(s.size).toBe(0);
  });

  // ---- Any (top type) unification ----
  test('Any unifies with concrete type', () => {
    const s = unify(tAnyType, tNumber);
    expect(s.size).toBe(0);
  });

  test('Any unifies with TVar (binds TVar to Any)', () => {
    const a = tVar('a');
    const s = unify(tAnyType, a);
    expect(s.size).toBe(1);
    expect(typeToString(s.apply(a))).toBe('Any');
  });

  test('TVar unifies with Any (binds TVar to Any)', () => {
    const a = tVar('a');
    const s = unify(a, tAnyType);
    expect(s.size).toBe(1);
    expect(typeToString(s.apply(a))).toBe('Any');
  });

  test('Any unifies with function type', () => {
    const s = unify(tAnyType, tFun(tNumber, tString));
    expect(s.size).toBe(0);
  });

  test('Any unifies with record type', () => {
    const s = unify(tAnyType, tRecord({ x: tNumber }));
    expect(s.size).toBe(0);
  });

  test('Any + Any unifies to empty substitution', () => {
    const s = unify(tAnyType, tAnyType);
    expect(s.size).toBe(0);
  });

  // ---- kv2 branch: concrete on left, kind variable on right ----
  test('concrete TCon on left, kind variable on right', () => {
    const a = tVar('a');
    const kvType = tCon('$kv:f:' + a.id, [tNumber]);
    const concreteType = tCon('Array', [tNumber]);
    const s = unify(concreteType, kvType);
    // Array renders as [Number] in typeToString
    expect(typeToString(s.apply(kvType))).toBe('[Number]');
  });

  // ---- Both kind variables ----
  test('two kind variables with same id unify args', () => {
    const a = tVar('f');
    const b = tVar('x');
    const c = tVar('y');
    const kv1 = tCon('$kv:f:' + a.id, [b]);
    const kv2 = tCon('$kv:f:' + a.id, [c]);
    const s = unify(kv1, kv2);
    // Should unify b and c
    expect(typeToString(s.apply(b))).toBe(typeToString(s.apply(c)));
  });

  // ---- Two kind variables with different IDs ----
  test('two kind variables with different ids unify names', () => {
    const a = tVar('f');
    const g = tVar('g');
    const x = tVar('x');
    const kv1 = tCon('$kv:f:' + a.id, [x]);
    const kv2 = tCon('$kv:g:' + g.id, [x]);
    const s = unify(kv1, kv2);
    // Should bind one kv to the other
    expect(s.size).toBeGreaterThan(0);
  });

  // ---- TCon arg count mismatch ----
  test('TCon arg count mismatch throws', () => {
    expect(() => unify(tCon('Array', [tNumber]), tCon('Array', [tNumber, tString]))).toThrow(UnificationError);
  });

  // ---- TRecord occurs check ----
  test('occurs check in TRecord field throws', () => {
    const a = tVar('a');
    const rec = tRecord({ x: a });
    expect(() => unify(a, rec)).toThrow(/Infinite type/);
  });

  // ---- Function TCon matches TFun ----
  test('TFun unifies with bare Function TCon (left)', () => {
    const s = unify(tFun(tNumber, tString), tCon('Function'));
    expect(s.size).toBe(0);
  });

  test('bare Function TCon unifies with TFun (right)', () => {
    const s = unify(tCon('Function'), tFun(tNumber, tString));
    expect(s.size).toBe(0);
  });

  // ---- TRecord + wildcard TCon ----
  test('TRecord on left unifies with wildcard on right', () => {
    const r = tRecord({ x: tNumber });
    const s = unify(r, tCon('*'));
    expect(s.size).toBe(0);
  });

  test('non-wildcard TCon on right fails with TRecord on left', () => {
    const r = tRecord({ x: tNumber });
    expect(() => unify(r, tCon('Foo'))).toThrow(UnificationError);
  });

  // ---- Spread tuple unification ----
  test('spread tuple: Tuple(a, b, ...) unifies with Tuple(Number, String, Boolean)', () => {
    const a = tVar('a');
    const b = tVar('b');
    const spread = tCon(T_TUPLE, [a, b, tCon('...')]);
    const concrete = tCon(T_TUPLE, [tNumber, tString, tBool]);
    const s = unify(spread, concrete);
    expect(typeToString(s.apply(a))).toBe('Number');
    expect(typeToString(s.apply(b))).toBe('String');
  });

  test('spread tuple on right: concrete unifies with Tuple(..., y)', () => {
    const y = tVar('y');
    const spread = tCon(T_TUPLE, [tCon('...'), y]);
    const concrete = tCon(T_TUPLE, [tNumber, tString]);
    const s = unify(concrete, spread);
    expect(typeToString(s.apply(y))).toBe('String');
  });

  test('spread tuple: both sides have spread', () => {
    const a = tVar('a');
    const b = tVar('b');
    const t1 = tCon(T_TUPLE, [a, tCon('...')]);
    const t2 = tCon(T_TUPLE, [tNumber, tCon('...')]);
    const s = unify(t1, t2);
    expect(typeToString(s.apply(a))).toBe('Number');
  });

  test('spread tuple: too few concrete elements throws', () => {
    const a = tVar('a');
    const b = tVar('b');
    const spread = tCon(T_TUPLE, [a, b, tCon('...'), tVar('z')]);
    const concrete = tCon(T_TUPLE, [tNumber]);
    expect(() => unify(spread, concrete)).toThrow(UnificationError);
  });

  test('spread tuple matching length with spread markers still works', () => {
    const a = tVar('a');
    const t1 = tCon(T_TUPLE, [a, tCon('...')]);
    const t2 = tCon(T_TUPLE, [tNumber, tCon('...')]);
    const s = unify(t1, t2);
    expect(typeToString(s.apply(a))).toBe('Number');
  });

  // ---- Kind variable occurs check ----
  test('kind variable occurs in concrete arg — throws infinite type (kv left)', () => {
    // Unifying `f a` with `Maybe (f a)` where both `f`s are the same kind var.
    // occursIn(f.id, Maybe (f a)) is true → infinite type error.
    const f = tVar('f');
    const a = tVar('a');
    const kv = tCon(`$kv:f:${f.id}`, [a]);
    // Build Maybe whose single arg is the same kv-encoded reference
    const inner = tCon(`$kv:f:${f.id}`, [a]);
    const concrete = tCon('Maybe', [inner]);
    expect(() => unify(kv, concrete)).toThrow(UnificationError);
  });

  test('kind variable occurs in concrete arg — throws infinite type (kv right)', () => {
    // Same scenario with arguments swapped (line 167 branch).
    const f = tVar('f');
    const a = tVar('a');
    const kv = tCon(`$kv:f:${f.id}`, [a]);
    const inner = tCon(`$kv:f:${f.id}`, [a]);
    const concrete = tCon('Maybe', [inner]);
    expect(() => unify(concrete, kv)).toThrow(UnificationError);
  });

  // ---- Spread tuple too short ----
  test('spread tuple: concrete side too short — throws', () => {
    // Tuple(a, b, ..., c) needs at least 3 concrete slots (a, b, and c).
    // Tuple(Number, String) only has 2 — not enough.
    const spread = tCon('...');
    const a = tVar('a');
    const b = tVar('b');
    const c = tVar('c');
    const withSpread = tCon(T_TUPLE, [a, b, spread, c]);
    const tooShort   = tCon(T_TUPLE, [tNumber, tString]);
    expect(() => unify(withSpread, tooShort)).toThrow(UnificationError);
  });

  test('both-spreads: after elements are unified', () => {
    // Tuple(a, ..., b) vs Tuple(Number, ..., String)
    // Both have a spread; both have one element after the spread.
    // The after-elements loop in unifySpreadTuple must unify b ↔ String.
    const spread = tCon('...');
    const a = tVar('a');
    const b = tVar('b');
    const lhs = tCon(T_TUPLE, [a, spread, b]);
    const rhs = tCon(T_TUPLE, [tNumber, spread, tString]);
    const s = unify(lhs, rhs);
    expect(typeToString(s.apply(a))).toBe('Number');
    expect(typeToString(s.apply(b))).toBe('String');
  });

  test('same-name Tuple with different arg counts and no spread — throws', () => {
    // Covers the false branch of `if (spread1 || spread2)` in the different-length path.
    const t1 = tCon(T_TUPLE, [tNumber, tString]);
    const t2 = tCon(T_TUPLE, [tNumber, tString, tBool]);
    expect(() => unify(t1, t2)).toThrow(UnificationError);
  });

  test('non-wildcard TCon vs TRecord — throws', () => {
    // TCon that is not a wildcard paired with a TRecord is a type mismatch.
    expect(() => unify(tCon('Maybe', [tNumber]), tRecord({ x: tNumber }))).toThrow(UnificationError);
  });

  // ---- Kind variable edge cases ----
  test('kind variable with more args than concrete fails', () => {
    const f = tVar('f');
    const kv = tCon(`$kv:f:${f.id}`, [tNumber, tString]);
    const concrete = tCon('Array', [tNumber]);
    expect(() => unify(kv, concrete)).toThrow(UnificationError);
  });

  test('concrete on left with more args than kind variable on right fails', () => {
    const f = tVar('f');
    const kv = tCon(`$kv:f:${f.id}`, [tNumber, tString]);
    const concrete = tCon('Array', [tNumber]);
    expect(() => unify(concrete, kv)).toThrow(UnificationError);
  });

  test('two kind variables with mismatched arg count fails', () => {
    const f = tVar('f');
    const g = tVar('g');
    const kv1 = tCon(`$kv:f:${f.id}`, [tNumber]);
    const kv2 = tCon(`$kv:g:${g.id}`, [tNumber, tString]);
    expect(() => unify(kv1, kv2)).toThrow(UnificationError);
  });

  // ---- Kind variable partial application ----
  test('kind variable partial application: f a matches RTask r e a', () => {
    const f = tVar('f');
    const a = tVar('a');
    const r = tVar('r');
    const e = tVar('e');
    const kv = tCon(`$kv:f:${f.id}`, [a]);
    const concrete = tCon('RTask', [r, e, a]);
    const s = unify(kv, concrete);
    const resolved = s.apply(f);
    // f should be bound to RTask r e (absorbing 2 leading args)
    expect(resolved.tag).toBe('TCon');
    if (resolved.tag === 'TCon') {
      expect(resolved.name).toBe('RTask');
      expect(resolved.args).toHaveLength(2);
    }
  });

  // ---- Union with TVar ----
  test('union with TVar binds the TVar', () => {
    const a = tVar('a');
    const s = unify(tCon('Union', [tNumber, tString]), a);
    // TVar should be bound to the union
    expect(typeToString(s.apply(a))).toBe('Number | String');
  });

  // ---- Mismatched tags ----
  test('TFun vs TRecord throws', () => {
    expect(() => unify(tFun(tNumber, tString), tRecord({ x: tNumber }))).toThrow(UnificationError);
  });

  // ---- TypeRep coercion ----
  test('TypeRep m unifies with constructor function by extracting return type', () => {
    const m = tVar('m');
    const a = tVar('a');
    // TypeRep m ~ (a -> Identity a) — binds the BARE constructor (the
    // witness's own element param is stripped), so the rep stays usable at
    // multiple element types.
    const s = unify(tCon(T_TYPEREP, [m]), tFun(a, tCon('Identity', [a])));
    const resolved = s.apply(m);
    expect(resolved.tag).toBe('TCon');
    if (resolved.tag === 'TCon') {
      expect(resolved.name).toBe('Identity');
      expect(resolved.args).toHaveLength(0);
    }
  });

  test('TypeRep coercion works symmetrically (TFun on left)', () => {
    const m = tVar('m');
    const a = tVar('a');
    // (a -> Maybe a) ~ TypeRep m — bare constructor, element param stripped.
    const s = unify(tFun(a, tCon('Maybe', [a])), tCon(T_TYPEREP, [m]));
    const resolved = s.apply(m);
    expect(resolved.tag).toBe('TCon');
    if (resolved.tag === 'TCon') {
      expect(resolved.name).toBe('Maybe');
      expect(resolved.args).toHaveLength(0);
    }
  });

  test('TypeRep coercion fails when return type is not a TCon', () => {
    const m = tVar('m');
    const a = tVar('a');
    // TypeRep m ~ (a -> a) — return type is TVar, not TCon
    expect(() => unify(tCon(T_TYPEREP, [m]), tFun(a, a))).toThrow(UnificationError);
  });
});

describe('Unification — extracted helper coverage', () => {
  test('wildcard unifies with concrete from both sides', () => {
    const wc = tCon('*', []);
    expect(unify(wc, tNumber).size).toBe(0);
    expect(unify(tString, wc).size).toBe(0);
  });

  test('wildcard binds TVar when on opposite side', () => {
    const wc = tCon('*', []);
    const a = tVar('a');
    const s1 = unify(wc, a);
    expect(typeToString(s1.apply(a))).toBe('*');
    const b = tVar('b');
    const s2 = unify(b, wc);
    expect(typeToString(s2.apply(b))).toBe('*');
  });

  test('Any binds TVar symmetrically', () => {
    const a = tVar('a');
    const s1 = unify(tAnyType, a);
    expect(typeToString(s1.apply(a))).toBe('Any');
    const b = tVar('b');
    const s2 = unify(b, tAnyType);
    expect(typeToString(s2.apply(b))).toBe('Any');
  });

  test('bindVar succeeds when TVar is union member', () => {
    const a = tVar('a');
    const union = tCon('Union', [a, tNumber]);
    // a ~ (a | Number) should succeed (a is already a member)
    const s = unify(a, union);
    expect(s.size).toBe(0);
  });

  test('bindVar detects infinite type', () => {
    const a = tVar('a');
    const nested = tFun(a, tNumber);
    expect(() => unify(a, nested)).toThrow(/Infinite type/);
  });

  test('Function TCon is compatible with any TFun', () => {
    const fn = tFun(tNumber, tString);
    const funcTCon = tCon('Function', []);
    // Both directions
    expect(unify(fn, funcTCon).size).toBe(0);
    expect(unify(funcTCon, fn).size).toBe(0);
  });

  test('TypeRep coercion works from both sides', () => {
    const m = tVar('m');
    const a = tVar('a');
    const ctor = tFun(a, tCon('Box', [a]));
    // TypeRep m ~ (a -> Box a)
    const s1 = unify(tCon(T_TYPEREP, [m]), ctor);
    expect(s1.apply(m).tag).toBe('TCon');
    // (a -> Box a) ~ TypeRep m
    const m2 = tVar('m2');
    const a2 = tVar('a2');
    const ctor2 = tFun(a2, tCon('Box', [a2]));
    const s2 = unify(ctor2, tCon(T_TYPEREP, [m2]));
    expect(s2.apply(m2).tag).toBe('TCon');
  });

  test('kv partial application absorbs leading args symmetrically', () => {
    // f a ~ RTask r e a  (f is kind var)
    const f = tVar('f');
    const a = tVar('a');
    const r = tVar('r');
    const e = tVar('e');
    const kvName = `$kv:f:${f.id}`;
    const kvTCon = tCon(kvName, [a]);
    const concrete = tCon('RTask', [r, e, a]);
    const s = unify(kvTCon, concrete);
    const resolved = s.apply(f);
    expect(resolved.tag).toBe('TCon');
    if (resolved.tag === 'TCon') {
      expect(resolved.name).toBe('RTask');
      // Should have absorbed 2 leading args
      expect(resolved.args).toHaveLength(2);
    }
    // Symmetric: concrete ~ kv
    resetTypeVarCounter();
    const f2 = tVar('f2');
    const a2 = tVar('a2');
    const r2 = tVar('r2');
    const e2 = tVar('e2');
    const kvName2 = `$kv:f2:${f2.id}`;
    const kvTCon2 = tCon(kvName2, [a2]);
    const concrete2 = tCon('RTask', [r2, e2, a2]);
    const s2 = unify(concrete2, kvTCon2);
    const resolved2 = s2.apply(f2);
    expect(resolved2.tag).toBe('TCon');
    if (resolved2.tag === 'TCon') {
      expect(resolved2.name).toBe('RTask');
    }
  });
});

describe('UnificationError — cheap construction (speculative inference)', () => {
  test('message is rendered lazily but matches the eager format', () => {
    const e = new UnificationError(tCon('Number'), tCon('String'));
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('UnificationError');
    expect(e.message).toBe('Cannot unify Number with String');
  });

  test('an explicit message wins and the message stays writable', () => {
    const e = new UnificationError(tCon('Number'), tCon('String'), 'custom');
    expect(e.message).toBe('custom');
    e.message = 'rewritten';
    expect(e.message).toBe('rewritten');
  });

  test('unify failures still surface the readable message', () => {
    expect(() => unify(tCon('Number'), tCon('String'))).toThrow(/Number/);
  });
});
