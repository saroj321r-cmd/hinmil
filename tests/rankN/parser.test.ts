// =============================================================================
// Rank-N — Fase 1: parser, representation & display of nested `forall`
// =============================================================================

import { parseTypeSignature, parseType, TypeParseError } from '../../src/hm/typeParser';
import {
  Type, TForall, typeToString, schemeToString, prettyTypeToString,
  resetTypeVarCounter, structuralEquals, containsForall,
} from '../../src/hm/types';
import { freshenType, collectTVarIdsFromType, mapType, someType } from '../../src/hm/typeUtils';
import { Substitution } from '../../src/hm/substitution';
import { unify, UnificationError } from '../../src/hm/unify';
import { freeTypeVarsInType, generalize, TypeEnv, instantiate } from '../../src/hm/env';

beforeEach(() => {
  resetTypeVarCounter();
});

function firstParam(t: Type): Type {
  if (t.tag !== 'TFun') throw new Error(`expected TFun, got ${t.tag}`);
  return t.param;
}

describe('rank-N parser — basic forms', () => {
  test('rank-2 param: (forall a. a -> a) -> b parses to nested TForall', () => {
    const sig = parseTypeSignature('(forall a. a -> a) -> b');
    expect(sig.hasForall).toBe(true);
    const p = firstParam(sig.type);
    expect(p.tag).toBe('TForall');
    if (p.tag === 'TForall') {
      expect(p.vars).toHaveLength(1);
      expect(p.varNames).toEqual(['a']);
      expect(p.body.tag).toBe('TFun');
    }
  });

  test('multiple binders: (forall a b. a -> b -> a) -> c', () => {
    const sig = parseTypeSignature('(forall a b. a -> b -> a) -> c');
    const p = firstParam(sig.type);
    expect(p.tag).toBe('TForall');
    if (p.tag === 'TForall') {
      expect(p.vars).toHaveLength(2);
      expect(p.varNames).toEqual(['a', 'b']);
    }
  });

  test('bound vars are NOT quantified by the enclosing scheme', () => {
    const sig = parseTypeSignature('(forall a. a -> a) -> b');
    const p = firstParam(sig.type) as TForall;
    for (const v of p.vars) {
      expect(sig.vars).not.toContain(v);
    }
    // The outer `b` IS scheme-quantified.
    expect(sig.vars.length).toBeGreaterThanOrEqual(1);
  });

  test('bound var shadows outer var of the same name', () => {
    const sig = parseTypeSignature('a -> (forall a. a -> a) -> a');
    expect(sig.type.tag).toBe('TFun');
    const outer1 = firstParam(sig.type);
    expect(outer1.tag).toBe('TVar');
    const f = (sig.type as Type & { tag: 'TFun' }).result;
    const inner = firstParam(f) as TForall;
    expect(inner.tag).toBe('TForall');
    const last = (f as Type & { tag: 'TFun' }).result;
    expect(last.tag).toBe('TVar');
    // Outer `a` positions share one id; bound `a` has a DIFFERENT id.
    if (outer1.tag === 'TVar' && last.tag === 'TVar') {
      expect(outer1.id).toBe(last.id);
      expect(inner.vars[0]).not.toBe(outer1.id);
    }
  });

  test('tuple-slot forall: ((forall a. a -> a), Number) -> b', () => {
    const sig = parseTypeSignature('((forall a. a -> a), Number) -> b');
    const p = firstParam(sig.type);
    expect(p.tag).toBe('TCon');
    if (p.tag === 'TCon') {
      expect(p.args[0].tag).toBe('TForall');
      expect(p.args[1].tag).toBe('TCon');
    }
  });

  test('record field forall: { run :: forall a. [a] -> Number } -> b', () => {
    const sig = parseTypeSignature('{ run :: forall a. [a] -> Number } -> b');
    const p = firstParam(sig.type);
    expect(p.tag).toBe('TRecord');
    if (p.tag === 'TRecord') {
      expect(p.fields.run.tag).toBe('TForall');
    }
  });

  test('constraints inside forall: (forall f. Functor f => (a -> f a)) -> s', () => {
    const sig = parseTypeSignature('(forall f. Functor f => (a -> f a)) -> s');
    const p = firstParam(sig.type) as TForall;
    expect(p.tag).toBe('TForall');
    expect(p.constraints).toHaveLength(1);
    expect(p.constraints![0].className).toBe('Functor');
    expect(p.constraints![0].typeVarName).toBe('f');
    expect(p.constraints![0].varId).toBe(p.vars[0]);
    // Scheme-level constraints stay empty — the constraint is SCOPED.
    expect(sig.constraints).toBeUndefined();
  });

  test('nested rank-2 inside callback param', () => {
    const sig = parseTypeSignature('((forall a. a -> a) -> b) -> b');
    const outer = firstParam(sig.type);
    expect(outer.tag).toBe('TFun');
    if (outer.tag === 'TFun') {
      expect(outer.param.tag).toBe('TForall');
    }
  });
});

describe('rank-N parser — prenex hoisting (covariant positions)', () => {
  test('toplevel forall is absorbed into the scheme', () => {
    const sig = parseTypeSignature('forall a. a -> a');
    expect(sig.type.tag).toBe('TFun');
    expect(containsForall(sig.type)).toBe(false);
    expect(sig.hasForall).toBeUndefined();
    expect(sig.vars).toHaveLength(1);
    expect(schemeToString(sig)).toBe('a -> a');
  });

  test('result-position forall is hoisted: a -> forall b. b -> b', () => {
    const sig = parseTypeSignature('a -> forall b. b -> b');
    expect(containsForall(sig.type)).toBe(false);
    expect(sig.vars).toHaveLength(2);
    expect(typeToString(sig.type)).toBe('a -> b -> b');
  });

  test('toplevel forall with constraint merges into scheme constraints', () => {
    const sig = parseTypeSignature('forall f. Functor f => f a -> f b');
    expect(containsForall(sig.type)).toBe(false);
    expect(sig.constraints).toHaveLength(1);
    expect(sig.constraints![0].className).toBe('Functor');
    expect(schemeToString(sig)).toBe('Functor f => f a -> f b');
  });
});

describe('rank-N parser — backward compatibility', () => {
  test("plain var named 'forall' still parses (no dot ahead)", () => {
    const sig = parseTypeSignature('forall -> forall');
    expect(sig.type.tag).toBe('TFun');
    expect(typeToString(sig.type)).toBe('forall -> forall');
    expect(sig.hasForall).toBeUndefined();
  });

  test("'forall' as callee arg name: forall a (juxtaposition unaffected)", () => {
    // `forall a` without a dot is NOT a quantifier — it stays two atoms
    // which (as before) is a parse error for a lowercase head; the point is
    // it must NOT silently become a quantifier.
    expect(() => parseTypeSignature('forall a')).toThrow();
  });

  test('ordinary rank-1 schemes are unchanged', () => {
    const sig = parseTypeSignature('(a -> b) -> [a] -> [b]');
    expect(sig.hasForall).toBeUndefined();
    expect(containsForall(sig.type)).toBe(false);
    expect(schemeToString(sig)).toBe('(a -> b) -> [a] -> [b]');
  });
});

describe('rank-N parser — predicativity validation', () => {
  test('forall inside array is rejected', () => {
    expect(() => parseTypeSignature('[forall a. a -> a] -> b'))
      .toThrow(TypeParseError);
  });

  test('forall inside type-constructor args is rejected', () => {
    expect(() => parseTypeSignature('Either (forall a. a -> a) b -> c'))
      .toThrow(TypeParseError);
  });

  test('forall as union member is rejected', () => {
    expect(() => parseTypeSignature('(Number | (forall a. a -> a)) -> b'))
      .toThrow(TypeParseError);
  });
});

describe('rank-N display — typeToString / schemeToString round-trip', () => {
  test('rank-2 param renders with parens', () => {
    const sig = parseTypeSignature('(forall a. a -> a) -> b');
    expect(schemeToString(sig)).toBe('(forall a. a -> a) -> b');
  });

  test('multiple binders render space-separated', () => {
    const sig = parseTypeSignature('(forall a b. a -> b -> a) -> c');
    expect(schemeToString(sig)).toBe('(forall a b. a -> b -> a) -> c');
  });

  test('scoped constraint renders after the dot', () => {
    const sig = parseTypeSignature('(forall f. Functor f => (a -> f a)) -> s');
    expect(schemeToString(sig)).toBe('(forall f. Functor f => a -> f a) -> s');
  });

  test('record-field forall renders', () => {
    const sig = parseTypeSignature('{ run :: forall a. [a] -> Number } -> b');
    expect(schemeToString(sig)).toBe('{ run :: forall a. [a] -> Number } -> b');
  });

  test('prettyTypeToString letters bound vars with annotation names', () => {
    const sig = parseTypeSignature('(forall x. x -> x) -> b');
    expect(prettyTypeToString(sig.type)).toBe('(forall x. x -> x) -> b');
  });

  test('display round-trips through the parser', () => {
    const src = '(forall a. a -> a) -> (Number, String) -> (Number, String)';
    const sig = parseTypeSignature(src);
    const rendered = schemeToString(sig);
    const reparsed = parseTypeSignature(rendered);
    expect(schemeToString(reparsed)).toBe(rendered);
  });
});

describe('rank-N — traversal & substitution hygiene', () => {
  test('collectTVarIdsFromType excludes bound vars (free vars only)', () => {
    const sig = parseTypeSignature('(forall a. a -> b) -> b');
    const p = firstParam(sig.type) as TForall;
    const free = freeTypeVarsInType(sig.type);
    expect(free.has(p.vars[0])).toBe(false);
    expect(free.size).toBe(1); // just `b`
  });

  test('generalize never re-quantifies bound vars', () => {
    const sig = parseTypeSignature('(forall a. a -> a) -> b');
    const p = firstParam(sig.type) as TForall;
    const scheme = generalize(new TypeEnv(), sig.type);
    expect(scheme.vars).not.toContain(p.vars[0]);
  });

  test('instantiate keeps the TForall node intact (bound ids preserved)', () => {
    const sig = parseTypeSignature('(forall a. a -> a) -> b -> b');
    const inst = instantiate(sig);
    const p = firstParam(inst) as TForall;
    expect(p.tag).toBe('TForall');
    const orig = firstParam(sig.type) as TForall;
    // Bound ids are untouched by scheme instantiation (not scheme vars).
    expect(p.vars).toEqual(orig.vars);
  });

  test('Substitution.apply only touches FREE vars under the quantifier', () => {
    const sig = parseTypeSignature('(forall a. a -> b) -> b');
    const p = firstParam(sig.type) as TForall;
    const boundId = p.vars[0];
    const freeId = [...freeTypeVarsInType(sig.type)][0];
    const s = new Substitution();
    s.set(freeId, { tag: 'TCon', name: 'Number', args: [] });
    const applied = s.apply(sig.type);
    const ap = firstParam(applied) as TForall;
    expect(typeToString(ap.body)).toBe('a -> Number');
    expect(ap.vars[0]).toBe(boundId);
  });

  test('freshenType freshens binders and body consistently', () => {
    const sig = parseTypeSignature('(forall a. a -> a) -> b');
    const orig = firstParam(sig.type) as TForall;
    const fresh = freshenType(sig.type);
    const fp = firstParam(fresh) as TForall;
    expect(fp.tag).toBe('TForall');
    expect(fp.vars[0]).not.toBe(orig.vars[0]);
    // Binder id matches the body occurrences.
    const bodyIds = new Set<number>();
    collectTVarIdsFromType(fp.body, bodyIds);
    expect(bodyIds.has(fp.vars[0])).toBe(true);
  });

  test('mapType / someType reach into the forall body', () => {
    const sig = parseTypeSignature('(forall a. a -> Number) -> b');
    expect(someType(sig.type, t => t.tag === 'TCon' && t.name === 'Number')).toBe(true);
    const swapped = mapType(sig.type, t =>
      t.tag === 'TCon' && t.name === 'Number' ? { tag: 'TCon', name: 'String', args: [] } : undefined);
    expect(someType(swapped, t => t.tag === 'TCon' && t.name === 'String')).toBe(true);
  });
});

describe('rank-N — unification (phase-1 semantics)', () => {
  test('identical TForall references unify trivially', () => {
    const sig = parseTypeSignature('(forall a. a -> a) -> b');
    const p = firstParam(sig.type);
    expect(() => unify(p, p)).not.toThrow();
  });

  test('alpha-equivalent foralls from different annotations unify', () => {
    const p1 = firstParam(parseTypeSignature('(forall a. a -> a) -> b').type);
    const p2 = firstParam(parseTypeSignature('(forall x. x -> x) -> y').type);
    expect(() => unify(p1, p2)).not.toThrow();
  });

  test('forall vs LESS polymorphic forall body fails', () => {
    const p1 = firstParam(parseTypeSignature('(forall a. a -> a) -> b').type);
    const p2 = firstParam(parseTypeSignature('(forall x. x -> Number) -> y').type);
    expect(() => unify(p1, p2)).toThrow(UnificationError);
  });

  test('differing binder counts fail', () => {
    const p1 = firstParam(parseTypeSignature('(forall a. a -> a) -> r').type);
    const p2 = firstParam(parseTypeSignature('(forall a b. a -> b) -> r').type);
    expect(() => unify(p1, p2)).toThrow(UnificationError);
  });

  test('TVar binds to a TForall opaquely', () => {
    const p = firstParam(parseTypeSignature('(forall a. a -> a) -> b').type);
    const v: Type = { tag: 'TVar', id: 999999, name: 't999999' };
    const s = unify(v, p);
    expect(s.lookup(999999)).toBe(p);
  });

  test('TForall vs plain function degrades gracefully (fresh instantiation)', () => {
    const p = firstParam(parseTypeSignature('(forall a. a -> a) -> b').type);
    const numFn = parseType('Number -> Number');
    // Phase-1 leniency: outside subsumption contexts this unifies rank-1 style.
    expect(() => unify(p, numFn)).not.toThrow();
  });

  test('wildcard does not destroy the quantified body', () => {
    const sig = parseTypeSignature('(forall a. a -> a) -> b');
    const star = parseType('*');
    const s = unify(star, sig.type);
    const applied = s.apply(sig.type);
    const p = firstParam(applied) as TForall;
    expect(p.tag).toBe('TForall');
    expect(typeToString(p.body)).toBe('a -> a');
  });

  test('structuralEquals distinguishes different binder identities', () => {
    const p1 = firstParam(parseTypeSignature('(forall a. a -> a) -> b').type);
    const p2 = firstParam(parseTypeSignature('(forall a. a -> a) -> b').type);
    expect(structuralEquals(p1, p1)).toBe(true);
    expect(structuralEquals(p1, p2)).toBe(false); // fresh ids per parse
  });
});
