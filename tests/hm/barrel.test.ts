// src/hm/index.ts — the barrel must re-export the full public type-system
// surface so external consumers can `import { … } from 'src/hm'`.

import * as hm from '../../src/hm';

describe('src/hm barrel re-exports', () => {
  test('types', () => {
    expect(typeof hm.typeToString).toBe('function');
    expect(typeof hm.prettyTypeToString).toBe('function');
    expect(typeof hm.tCon).toBe('function');
    expect(typeof hm.tFun).toBe('function');
    expect(typeof hm.resetTypeVarCounter).toBe('function');
  });

  test('typeUtils / typeParser', () => {
    expect(typeof hm.parseType).toBe('function');
    expect(typeof hm.parseTypeSignature).toBe('function');
  });

  test('substitution / unify / env', () => {
    expect(typeof hm.Substitution).toBe('function');
    expect(typeof hm.unify).toBe('function');
    expect(typeof hm.TypeEnv).toBe('function');
  });

  test('a parse → unify → print round-trip works through the barrel alone', () => {
    hm.resetTypeVarCounter();
    const t1 = hm.parseType('Number -> Number');
    const t2 = hm.tFun(hm.tVar(), hm.tNumber);
    const subst = hm.unify(t1, t2);
    expect(hm.typeToString(subst.apply(t2))).toBe('Number -> Number');
  });
});
