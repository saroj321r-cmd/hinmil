import { Substitution } from '../../src/hm/substitution';
import { tVar, tNumber, tString, tFun, tCon, tRecord, typeToString, resetTypeVarCounter } from '../../src/hm/types';

beforeEach(() => {
  resetTypeVarCounter();
});

describe('Substitution', () => {
  test('empty substitution returns same type', () => {
    const s = new Substitution();
    const t = tVar('a');
    expect(s.apply(t)).toBe(t);
  });

  test('substitution replaces variable', () => {
    const a = tVar('a');
    const s = new Substitution();
    s.set(a.id, tNumber);
    const result = s.apply(a);
    expect(typeToString(result)).toBe('Number');
  });

  test('substitution chases chains', () => {
    const a = tVar('a');
    const b = tVar('b');
    const s = new Substitution();
    s.set(a.id, b);
    s.set(b.id, tNumber);
    const result = s.apply(a);
    expect(typeToString(result)).toBe('Number');
  });

  test('substitution applies to function types', () => {
    const a = tVar('a');
    const b = tVar('b');
    const fn = tFun(a, b);
    const s = new Substitution();
    s.set(a.id, tNumber);
    s.set(b.id, tString);
    const result = s.apply(fn);
    expect(result.tag).toBe('TFun');
    if (result.tag === 'TFun') {
      expect(typeToString(result.param)).toBe('Number');
      expect(typeToString(result.result)).toBe('String');
    }
  });

  test('substitution applies to constructed types', () => {
    const a = tVar('a');
    const arr = tCon('Array', [a]);
    const s = new Substitution();
    s.set(a.id, tNumber);
    const result = s.apply(arr);
    expect(typeToString(result)).toBe('[Number]');
  });

  test('compose applies in correct order', () => {
    const a = tVar('a');
    const b = tVar('b');

    const s1 = new Substitution();
    s1.set(a.id, b);

    const s2 = new Substitution();
    s2.set(b.id, tNumber);

    // s2 after s1: a -> b -> Number
    const composed = s2.compose(s1);
    expect(typeToString(composed.apply(a))).toBe('Number');
  });

  test('size returns number of bindings', () => {
    const s = new Substitution();
    expect(s.size).toBe(0);
    s.set(0, tNumber);
    expect(s.size).toBe(1);
  });

  test('self-referencing TVar guard prevents loop', () => {
    const a = tVar('a');
    const s = new Substitution();
    s.set(a.id, a); // map a → a (direct self-reference)
    const result = s.apply(a);
    expect(result).toBe(a);
  });

  test('indirect TVar cycle guard prevents infinite loop', () => {
    // a → b, b → a  — cycle of length 2
    const a = tVar('a');
    const b = tVar('b');
    const s = new Substitution();
    s.set(a.id, b);
    s.set(b.id, a);
    // apply should terminate and return one of the cycle members, not hang
    const result = s.apply(a);
    expect(result.tag).toBe('TVar');
  });

  test('apply to TRecord preserves alias', () => {
    const a = tVar('a');
    const r = tRecord({ x: a });
    r.alias = 'Env';
    const s = new Substitution();
    s.set(a.id, tNumber);
    const result = s.apply(r);
    expect(result.tag).toBe('TRecord');
    if (result.tag === 'TRecord') {
      expect(result.alias).toBe('Env');
      expect(typeToString(result.fields['x'])).toBe('Number');
    }
  });

  test('compose merges non-overlapping', () => {
    const a = tVar('a');
    const b = tVar('b');
    const s1 = new Substitution();
    s1.set(a.id, tNumber);
    const s2 = new Substitution();
    s2.set(b.id, tString);
    const composed = s2.compose(s1);
    expect(typeToString(composed.apply(a))).toBe('Number');
    expect(typeToString(composed.apply(b))).toBe('String');
  });

  test('compose gives precedence to inner substitution', () => {
    const a = tVar('a');
    const s1 = new Substitution();
    s1.set(a.id, tNumber);
    const s2 = new Substitution();
    s2.set(a.id, tString);
    const composed = s2.compose(s1);
    // s1 (inner / other) maps a→Number, s2 (outer) maps a→String
    // compose keeps other's (s1) mapping
    expect(typeToString(composed.apply(a))).toBe('Number');
  });

  test('entries returns all bindings', () => {
    const a = tVar('a');
    const b = tVar('b');
    const s = new Substitution();
    s.set(a.id, tNumber);
    s.set(b.id, tString);
    const entries = [...s.entries()];
    expect(entries).toHaveLength(2);
  });

  test('toString produces readable output', () => {
    const a = tVar('a');
    const s = new Substitution();
    s.set(a.id, tNumber);
    const str = s.toString();
    expect(str).toContain('Number');
    expect(str).toContain('=>');
  });
});

describe('Substitution.apply — structural sharing & ground-type optimization', () => {
  test('ground TCon (zero args) returns the exact same reference', () => {
    const s = new Substitution();
    const a = tVar('a');
    s.set(a.id, tNumber);
    // Ground types with no TVars should be returned as-is
    expect(s.apply(tNumber)).toBe(tNumber);
    expect(s.apply(tString)).toBe(tString);
  });

  test('TCon with unchanged args returns the same reference', () => {
    // Array(Number) where subst has no bindings for Number
    const arr = tCon('Array', [tNumber]);
    const s = new Substitution();
    const result = s.apply(arr);
    expect(result).toBe(arr);
  });

  test('TFun with unchanged children returns the same reference', () => {
    const fn = tFun(tNumber, tString);
    const s = new Substitution();
    const result = s.apply(fn);
    expect(result).toBe(fn);
  });

  test('TCon with changed args creates new type', () => {
    const a = tVar('a');
    const arr = tCon('Array', [a]);
    const s = new Substitution();
    s.set(a.id, tNumber);
    const result = s.apply(arr);
    expect(result).not.toBe(arr);
    expect(typeToString(result)).toBe('[Number]');
  });

  test('TFun with changed children creates new type', () => {
    const a = tVar('a');
    const fn = tFun(a, tString);
    const s = new Substitution();
    s.set(a.id, tNumber);
    const result = s.apply(fn);
    expect(result).not.toBe(fn);
    expect(typeToString(result)).toBe('Number -> String');
  });

  test('deeply nested ground types are not reconstructed', () => {
    // Either Number String — both args are ground
    const either = tCon('Either', [tNumber, tString]);
    const s = new Substitution();
    expect(s.apply(either)).toBe(either);
  });

  // ---------------------------------------------------------------------------
  // Arity guard invariant: when a kv var resolves to a registered data type,
  // substitution must either produce a SATURATED TCon (covering all declared
  // type parameters) or keep the kv form unchanged.  It must NEVER yield an
  // under-saturated TCon (e.g. bare `m` resolved to unary `Either e`).
  // ---------------------------------------------------------------------------
  test('arity guard: kv resolved to partial Either keeps kv form', () => {
    const dtr = require('../../src/registries/dataTypeRegistry');
    const snap = dtr.snapshotDataTypeRegistry();
    try {
      // Register Either with two type variables (a, b).
      dtr.registerDataType({
        name: 'Either',
        typeVars: ['a', 'b'],
        variants: [],
        commentStart: 0,
        commentEnd: 0,
      });
      const m = tVar('m');
      // Bare kv `m` (no args) — represents an unsaturated higher-kinded var.
      const kv = tCon(`$kv:m:${m.id}`, []);
      const s = new Substitution();
      // Bind m -> Either e  (partial, only 1 of 2 args supplied).
      const e = tVar('e');
      s.set(m.id, tCon('Either', [e]));
      const result = s.apply(kv);
      // Invariant: must NOT produce under-saturated `Either e` (only 1 arg
      // when 2 declared).  Should keep the kv form.
      if (result.tag === 'TCon' && result.name === 'Either') {
        expect(result.args.length).toBeGreaterThanOrEqual(2);
      } else {
        // kv form preserved — also acceptable.
        expect(result.tag).toBe('TCon');
      }
    } finally {
      dtr.restoreDataTypeRegistry(snap);
    }
  });

  test('arity guard: kv with one positional arg + partial binding saturates fully', () => {
    const dtr = require('../../src/registries/dataTypeRegistry');
    const snap = dtr.snapshotDataTypeRegistry();
    try {
      dtr.registerDataType({
        name: 'Either',
        typeVars: ['a', 'b'],
        variants: [],
        commentStart: 0,
        commentEnd: 0,
      });
      const m = tVar('m');
      // kv `m a` (1 positional arg) — represents `m` applied to one type.
      const kv = tCon(`$kv:m:${m.id}`, [tString]);
      const s = new Substitution();
      // Bind m -> Either e  (1 extra arg) — combined arity = 2 ✓ saturates.
      const e = tVar('e');
      s.set(m.id, tCon('Either', [e]));
      const result = s.apply(kv);
      // Should produce saturated Either (extraArgs[e] + args[String]) = 2.
      expect(result.tag).toBe('TCon');
      if (result.tag === 'TCon') {
        expect(result.name).toBe('Either');
        expect(result.args.length).toBe(2);
      }
    } finally {
      dtr.restoreDataTypeRegistry(snap);
    }
  });
});
