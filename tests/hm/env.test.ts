import { TypeEnv, instantiate, generalize, freeTypeVarsInType, applySubstToScheme } from '../../src/hm/env';
import {
  tVar,
  tNumber,
  tString,
  tFun,
  mono,
  scheme,
  typeToString,
  resetTypeVarCounter,
} from '../../src/hm/types';
import { Substitution } from '../../src/hm/substitution';

beforeEach(() => {
  resetTypeVarCounter();
});

describe('TypeEnv', () => {
  test('empty env has no bindings', () => {
    const env = new TypeEnv();
    expect(env.lookup('x')).toBeUndefined();
    expect(env.size).toBe(0);
  });

  test('non-empty env reports correct size', () => {
    const env = new TypeEnv()
      .extend('x', mono(tNumber))
      .extend('y', mono(tString));
    expect(env.size).toBe(2);
  });

  test('extend adds a binding', () => {
    const env = new TypeEnv();
    const env2 = env.extend('x', mono(tNumber));
    expect(env2.lookup('x')).toBeDefined();
    expect(typeToString(env2.lookup('x')!.type)).toBe('Number');
    // original env untouched
    expect(env.lookup('x')).toBeUndefined();
  });

  test('remove deletes a binding', () => {
    const env = new TypeEnv().extend('x', mono(tNumber));
    const env2 = env.remove('x');
    expect(env2.lookup('x')).toBeUndefined();
    // original env untouched
    expect(env.lookup('x')).toBeDefined();
  });

  test('freeTypeVars collects variables from all schemes', () => {
    const a = tVar('a');
    const b = tVar('b');
    const env = new TypeEnv()
      .extend('f', mono(tFun(a, b)))       // a, b are free
      .extend('x', scheme([a.id], a));      // a is bound => not free
    const free = env.freeTypeVars();
    expect(free.has(b.id)).toBe(true);
    // a is free in f's scheme but bound in x's scheme
    // freeTypeVars unions over all schemes
    expect(free.has(a.id)).toBe(true); // still free in f
  });
});

describe('freeTypeVarsInType', () => {
  test('concrete type has no free vars', () => {
    expect(freeTypeVarsInType(tNumber).size).toBe(0);
  });

  test('type variable is free', () => {
    const a = tVar('a');
    expect(freeTypeVarsInType(a).has(a.id)).toBe(true);
  });

  test('function type collects from both sides', () => {
    const a = tVar('a');
    const b = tVar('b');
    const free = freeTypeVarsInType(tFun(a, b));
    expect(free.has(a.id)).toBe(true);
    expect(free.has(b.id)).toBe(true);
  });
});

describe('instantiate', () => {
  test('monomorphic scheme returns same type structure', () => {
    const t = instantiate(mono(tNumber));
    expect(typeToString(t)).toBe('Number');
  });

  test('polymorphic scheme replaces bound vars with fresh ones', () => {
    const a = tVar('a');
    const s = scheme([a.id], tFun(a, a));
    const t = instantiate(s);
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun') {
      // Both sides should be the same fresh variable
      expect(t.param.tag).toBe('TVar');
      expect(typeToString(t.param)).toBe(typeToString(t.result));
      // Fresh var has a different id from the original but preserves the name
      expect((t.param as any).id).not.toBe(a.id);
      expect(typeToString(t.param)).toBe('a');
    }
  });
});

describe('generalize', () => {
  test('generalizes vars not in env', () => {
    const a = tVar('a');
    const env = new TypeEnv();
    const s = generalize(env, tFun(a, a));
    expect(s.vars).toContain(a.id);
  });

  test('does not generalize vars that are in env', () => {
    const a = tVar('a');
    const b = tVar('b');
    const env = new TypeEnv().extend('x', mono(a)); // a is in env
    const s = generalize(env, tFun(a, b));
    expect(s.vars).not.toContain(a.id);
    expect(s.vars).toContain(b.id);
  });
});
describe('applySubst', () => {
  test('applies substitution to all schemes in env', () => {
    const a = tVar('a');
    const env = new TypeEnv()
      .extend('x', mono(a))
      .extend('y', mono(tFun(a, tString)));
    const subst = new Substitution();
    subst.set(a.id, tNumber);
    const newEnv = env.applySubst(subst);
    expect(typeToString(newEnv.lookup('x')!.type)).toBe('Number');
    expect(typeToString(newEnv.lookup('y')!.type)).toBe('Number -> String');
  });
});

describe('entries', () => {
  test('iterates all bindings', () => {
    const env = new TypeEnv()
      .extend('x', mono(tNumber))
      .extend('y', mono(tString));
    const all = [...env.entries()];
    expect(all).toHaveLength(2);
    const names = all.map(([n]) => n);
    expect(names).toContain('x');
    expect(names).toContain('y');
  });
});

describe('applySubstToScheme', () => {
  test('does not substitute bound variables', () => {
    const a = tVar('a');
    const b = tVar('b');
    // a -> b — substitution {a→Number, b→String}
    // Only b should be replaced (a is bound)
    const s = scheme([a.id], tFun(a, b));
    const subst = new Substitution();
    subst.set(a.id, tNumber);
    subst.set(b.id, tString);
    const result = applySubstToScheme(subst, s);
    // a should still be a (bound var), b should become String
    expect(result.vars).toContain(a.id);
    if (result.type.tag === 'TFun') {
      expect(result.type.param.tag).toBe('TVar');
      expect(typeToString(result.type.result)).toBe('String');
    }
  });
});