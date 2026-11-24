// Regression: kind variables encoded as TCon name strings (`$kv:p:376`)
// must participate in generalization and instantiation just like ordinary
// type variables.
//
// The bug: `collectTVarIdsFromType` only collected ids for TVar / TRow /
// TLabel nodes, so the id embedded in a kv-encoded TCon name was invisible
// to `generalize` (never quantified) and to `instantiate` (never freshened).
// A stale kv id then leaked across an import boundary and collided with an
// unrelated binding in the consumer — surfacing as a non-deterministic
// "Type constructor 'Arrow' expects 3 type arguments but got 2" that
// appeared or vanished depending on which unrelated file happened to be
// open (i.e. on inference/caching order).
//
// See src/hm/typeUtils.ts `collectTVarIdsFromType` and
// /memories/repo/kv-var-generalization-hygiene.md.

import { tCon, tVar, tFun, tBool, kvName, parseKvName, Type } from '../../src/hm/types';

import { freeTypeVarsInType, generalize, instantiate, TypeEnv } from '../../src/hm/env';

/** Collect every kv-encoded var id present in a type tree. */
function collectKvIds(t: Type, out: number[] = []): number[] {
  if (t.tag === 'TCon') {
    const kv = parseKvName(t.name);
    if (kv) out.push(kv.varId);
    t.args.forEach((a) => collectKvIds(a, out));
  } else if (t.tag === 'TFun') {
    collectKvIds(t.param, out);
    collectKvIds(t.result, out);
  } else if (t.tag === 'TRecord') {
    for (const k in t.fields) collectKvIds(t.fields[k], out);
  }
  return out;
}

describe('kv-encoded kind vars participate in generalize/instantiate', () => {
  const KV_ID = 376;
  // `identity :: $kv:p:376 [a, c] -> Boolean` — a profunctor law shape where
  // `p` is a kind variable applied to two type args.
  const buildType = (): Type =>
    tFun(
      tCon(kvName('p', KV_ID), [tVar('a'), tVar('c')]),
      tBool,
    );

  test('freeTypeVarsInType collects the id embedded in a kv-encoded TCon name', () => {
    const ids = freeTypeVarsInType(buildType());
    expect(ids.has(KV_ID)).toBe(true);
  });

  test('generalize quantifies the kv var (it is not free in the env)', () => {
    const scheme = generalize(new TypeEnv(), buildType());
    expect(scheme.vars).toContain(KV_ID);
  });

  test('instantiate freshens the kv var so it never leaks its original id', () => {
    const scheme = generalize(new TypeEnv(), buildType());

    const inst1 = instantiate(scheme);
    const inst2 = instantiate(scheme);

    const kv1 = collectKvIds(inst1);
    const kv2 = collectKvIds(inst2);

    // Each instantiation still carries exactly one kv var...
    expect(kv1).toHaveLength(1);
    expect(kv2).toHaveLength(1);
    // ...but freshened to a NEW id (never the original 376)...
    expect(kv1[0]).not.toBe(KV_ID);
    expect(kv2[0]).not.toBe(KV_ID);
    // ...and distinct per instantiation, proving no shared/leaking var.
    expect(kv1[0]).not.toBe(kv2[0]);
  });

  test('the kv var name (`p`) is preserved across instantiation', () => {
    const scheme = generalize(new TypeEnv(), buildType());
    const inst = instantiate(scheme);
    // Reach the freshened kv TCon: (param of the top-level TFun).
    expect(inst.tag).toBe('TFun');
    const param = (inst as Extract<Type, { tag: 'TFun' }>).param;
    expect(param.tag).toBe('TCon');
    const kv = parseKvName((param as Extract<Type, { tag: 'TCon' }>).name);
    expect(kv).not.toBeNull();
    expect(kv!.varName).toBe('p');
    expect(kv!.varId).not.toBe(KV_ID);
  });
});
