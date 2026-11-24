// Phase 2 of presence/absence row polymorphism: parser support
// for `[k] :: a` label-keyed record fields.
//
// The "lacks-ness" — i.e. the row variable `r` does not contain `k` —
// is implicit in the syntax `{ [k] :: a, ...r }`, just like `r` does not
// contain `x` in `{ x :: a, ...r }`.  No explicit `Lacks` constraint is
// needed: unification binds `k` to one concrete field name and `r` to the
// remaining fields automatically.

import { parseTypeSignature, parseType, TypeParseError } from '../../src/hm/typeParser';
import { typeToString, resetTypeVarCounter, TRecord } from '../../src/hm/types';
import { InferenceEngine } from '../../src/infer';

beforeEach(() => {
  resetTypeVarCounter();
});

describe('parser — bracketed record-field keys', () => {
  test('label variable in field key', () => {
    const t = parseType('{ [k] :: a }') as TRecord;
    expect(t.tag).toBe('TRecord');
    expect(t.labelFields).toBeDefined();
    expect(t.labelFields).toHaveLength(1);
    expect(t.labelFields![0].label.kind).toBe('var');
    if (t.labelFields![0].label.kind === 'var') {
      expect(t.labelFields![0].label.name).toBe('k');
    }
  });

  test('string literal in field key is rejected', () => {
    expect(() => parseType('{ ["foo"] :: Number }')).toThrow(TypeParseError);
  });

  test('mixed concrete and label-var fields', () => {
    const t = parseType('{ x :: Number, [k] :: a }') as TRecord;
    expect(Object.keys(t.fields)).toEqual(['x']);
    expect(t.labelFields).toHaveLength(1);
  });

  test('label-var field plus row var', () => {
    const t = parseType('{ [k] :: a, ...r }') as TRecord;
    expect(t.tag).toBe('TRecord');
    expect(t.labelFields).toHaveLength(1);
    expect(t.rest).toBeDefined();
    expect(t.rest!.name).toBe('r');
  });

  test('multiple label-var fields', () => {
    const t = parseType('{ [k1] :: a, [k2] :: b, ...r }') as TRecord;
    expect(t.labelFields).toHaveLength(2);
    expect(t.labelFields!.map(lf => lf.label.kind === 'var' ? lf.label.name : '').sort())
      .toEqual(['k1', 'k2']);
  });

  test('pretty-prints with bracket form', () => {
    expect(typeToString(parseType('{ [k] :: a }'))).toBe('{ [k] :: a }');
    expect(typeToString(parseType('{ x :: Number, [k] :: a }')))
      .toBe('{ x :: Number, [k] :: a }');
    expect(typeToString(parseType('{ [k] :: a, ...r }')))
      .toBe('{ [k] :: a, ...r }');
  });

  test('uppercase ident inside brackets is rejected', () => {
    expect(() => parseType('{ [K] :: a }')).toThrow(TypeParseError);
  });

  test('missing :: after bracketed key', () => {
    expect(() => parseType('{ [k] : a }')).toThrow(TypeParseError);
  });

  test('full signature parses without explicit constraints', () => {
    const s = parseTypeSignature('k -> { [k] :: a, ...r } -> { ...r }');
    // No explicit constraint apparatus required; the lack-ness is implicit
    // in the syntactic form — exactly like `{ x :: a, ...r } -> { ...r }`.
    expect(s.constraints ?? []).toHaveLength(0);
  });

  test('identifier appearing as bracketed key is shared across signature', () => {
    // The first `k` in `k -> ...` and the `[k]` inside the record must be
    // the *same* label variable, not two independent type vars.
    const s = parseTypeSignature('k -> { [k] :: a, ...r } -> { ...r }');
    // Walk into the function: param `k` should be a TLabel-var named "k".
    expect(s.type.tag).toBe('TFun');
    if (s.type.tag === 'TFun') {
      expect(s.type.param.tag).toBe('TLabel');
      if (s.type.param.tag === 'TLabel' && s.type.param.kind === 'var') {
        expect(s.type.param.name).toBe('k');
        const labelId = s.type.param.id;
        // Now drill into the second-position record's labelFields
        const inner = s.type.result;
        expect(inner.tag).toBe('TFun');
        if (inner.tag === 'TFun' && inner.param.tag === 'TRecord') {
          const lf = inner.param.labelFields![0].label;
          expect(lf.kind).toBe('var');
          if (lf.kind === 'var') {
            expect(lf.id).toBe(labelId);
          }
        }
      }
    }
  });
});

// ===========================================================================
// End-to-end inference: bracketed-key signatures behave as expected at call
// sites.  String-literal arguments get promoted to label literals when the
// expected parameter type is a label, and the row-tail collapses to the
// remaining concrete fields.
// ===========================================================================

describe('inference — label-polymorphic call sites', () => {
  test('drop2 :: (k, { [k] :: a, ...r }) -> { ...r } drops the named field', () => {
    const src = `
// drop2 :: (k, { [k] :: a, ...r }) -> { ...r }
const drop2 = (k, obj) => obj
drop2("x", { x: 1, y: 2, z: "hi" })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    // After unifying with { x:Number, y:Number, z:String }:
    //   k    := 'x' (label literal)
    //   a    := Number
    //   r    := { y :: Number, z :: String }
    // Result of the call: { ...r } = { y :: Number, z :: String }
    const ts = typeToString(r.type);
    expect(ts).toContain('y :: Number');
    expect(ts).toContain('z :: String');
    expect(ts).not.toContain('x :: ');
  });

  test('getField :: (k, { [k] :: a, ...r }) -> a returns the field type', () => {
    const src = `
// getField :: (k, { [k] :: a, ...r }) -> a
const getField = (k, obj) => obj[k]
getField("name", { name: "Ada", age: 36 })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(typeToString(r.type)).toBe('String');
  });

  test('label-polymorphism is independent of other concrete fields (Number arg)', () => {
    const src = `
// getField :: (k, { [k] :: a, ...r }) -> a
const getField = (k, obj) => obj[k]
getField("age", { name: "Ada", age: 36 })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(typeToString(r.type)).toBe('Number');
  });

  test('label literal mismatch with concrete field types unifies value type', () => {
    const src = `
// getField :: (k, { [k] :: a, ...r }) -> a
const getField = (k, obj) => obj[k]
const v = getField("flag", { flag: true, count: 0 })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    // v should be Bool/Boolean because flag :: Bool
    const v = (() => {
      for (const [, entry] of r.nodeTypes) {
        const ts = typeToString(r.substitution.apply(entry.type));
        if (ts === 'Bool' || ts === 'Boolean') return true;
      }
      return false;
    })();
    expect(v).toBe(true);
  });

  test('non-string argument for label parameter is rejected', () => {
    const src = `
// getField :: (k, { [k] :: a, ...r }) -> a
const getField = (k, obj) => obj[k]
getField(42, { x: 1 })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    // Number does not unify with TLabel → at least one diagnostic
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('curried application: drop2("x") then apply to record', () => {
    const src = `
// drop2 :: k -> { [k] :: a, ...r } -> { ...r }
const drop2 = (k) => (obj) => obj
const dropX = drop2("x")
dropX({ x: 1, y: 2 })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('y :: Number');
    expect(ts).not.toContain('x :: ');
  });

  test('two label parameters: rename :: (k1, k2, { [k1] :: a, ...r }) -> { [k2] :: a, ...r }', () => {
    const src = `
// rename :: (k1, k2, { [k1] :: a, ...r }) -> { [k2] :: a, ...r }
const rename = (oldK, newK, obj) => obj
const renamed = rename("uid", "id", { uid: 7, name: "Ada" })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const ts = typeToString(r.type);
    // Result row keeps `name`, and `id` is materialised from the second label arg.
    expect(ts).toContain('name :: String');
    expect(ts).toContain('id :: Number');
    expect(ts).not.toContain('uid :: ');
  });

  test('setField :: (k, a, { ...r }) -> { [k] :: a, ...r } adds a field', () => {
    const src = `
// setField :: (k, a, { ...r }) -> { [k] :: a, ...r }
const setField = (k, v, obj) => obj
const out = setField("email", "ada@example.com", { name: "Ada" })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const ts = typeToString(r.type);
    expect(ts).toContain('name :: String');
    expect(ts).toContain('email :: String');
  });

  test('label-polymorphic functions are properly re-instantiated per call', () => {
    const src = `
// pluck :: (k, { [k] :: a, ...r }) -> a
const pluck = (k, obj) => obj[k]
const a = pluck("name", { name: "Ada", age: 36 })
const b = pluck("age",  { name: "Ada", age: 36 })
const c = pluck("flag", { flag: true, count: 0 })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('label var compares with String inside function body without diagnostic', () => {
    const src = `
// omit :: (k, { [k] :: a, ...r }) -> { ...r }
const omit = (k, obj) => {
  const out = {};
  for (const key in obj) if (key !== k) out[key] = obj[key];
  return out;
};
omit("x", { x: 1, y: 2 })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });
});

describe('inference — computed-key destructuring (Phase 3)', () => {
  test('const { [k]: value } = obj — value type comes from row-poly source', () => {
    const src = `
const obj = { x: 42, y: "hi" };
const k = "x";
const { [k]: value } = obj;
value
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    // No "Property does not exist" diagnostics expected.
    expect(r.diagnostics).toHaveLength(0);
  });

  test('function param: const { [k]: value } = obj infers label-polymorphism', () => {
    const src = `
const pluck = (k, obj) => {
  const { [k]: value } = obj;
  return value;
};
pluck("name", { name: "Ada", age: 36 })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const ts = typeToString(r.type);
    expect(ts).toBe('String');
  });

  test('function param: const { [k]: value, ...rest } = obj infers row-poly remainder', () => {
    const src = `
const omit = (k, obj) => {
  const { [k]: dropped, ...rest } = obj;
  return rest;
};
omit("x", { x: 1, y: 2, z: "hi" })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const ts = typeToString(r.type);
    expect(ts).toContain('y :: Number');
    expect(ts).toContain('z :: String');
    expect(ts).not.toContain('x :: ');
  });

  test('inferred label-polymorphic pluck is re-instantiated per call', () => {
    const src = `
const pluck = (k, obj) => {
  const { [k]: value } = obj;
  return value;
};
const a = pluck("name", { name: "Ada", age: 36 });
const b = pluck("age",  { name: "Ada", age: 36 });
const c = pluck("flag", { flag: true,  count: 0 });
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('mixed static + computed keys destructure correctly', () => {
    const src = `
const obj = { id: 7, name: "Ada", age: 36 };
const k = "name";
const { id, [k]: who, ...rest } = obj;
who
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('non-string key argument is rejected at call site', () => {
    const src = `
const pluck = (k, obj) => {
  const { [k]: value } = obj;
  return value;
};
pluck(123, { x: 1 })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    // Calling with a Number for a label-typed parameter should diagnose.
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('inference — row-map fan-out for free label vars', () => {
  // When `[k]` in `{ [k] :: T }` is NOT bound by another parameter, the
  // engine treats it as quantifying over every key of the actual argument
  // record (each key gets a fresh instantiation of the internal type vars).

  test('unwrap :: { [k] :: Pair a b } -> { [k] :: b } projects every key', () => {
    const src = `
// Pair :: (a, b) -> Pair a b
const Pair = null;
// unwrap :: { [k] :: Pair a b } -> { [k] :: b }
const unwrap = obj => obj
const out = unwrap({ a: Pair(1, "x"), b: Pair(2, 3) })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const ts = typeToString(r.type);
    expect(ts).toContain('a :: String');
    expect(ts).toContain('b :: Number');
  });

  test('row-map fan-out is skipped when label var is bound by another param', () => {
    // `pluck` binds `k` from its first arg — fan-out must NOT fire,
    // otherwise `pluck("name", users)` would pick up every user field.
    const src = `
// pluck :: (k, { [k] :: a, ...r }) -> a
const pluck = (k, obj) => obj[k]
const v = pluck("name", { name: "Ada", age: 36 })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('String');
  });

  test('each fanned-out key gets independently freshened internal vars', () => {
    // Different value types per key must not be unified together.
    const src = `
// Pair :: (a, b) -> Pair a b
const Pair = null;
// snd :: { [k] :: Pair a b } -> { [k] :: b }
const snd = obj => obj
const out = snd({ x: Pair(1, true), y: Pair("hi", 99) })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const ts = typeToString(r.type);
    // x's b1 binds to Bool, y's b2 binds to Number — independently.
    expect(ts).toContain('x :: Bool');
    expect(ts).toContain('y :: Number');
  });

  test('fan-out preserves existing static fields', () => {
    const src = `
// withTag :: { tag :: String, [k] :: a } -> { tag :: String, [k] :: a }
const withTag = obj => obj
const out = withTag({ tag: "ok", x: 1, y: "hi" })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const ts = typeToString(r.type);
    expect(ts).toContain('tag :: String');
    expect(ts).toContain('x :: Number');
    expect(ts).toContain('y :: String');
  });
});

describe('inference — computed access on label-polymorphic record', () => {
  // `obj[k]` on a `{ [k] :: T }` value must return `T` (not a fresh TVar)
  // so completion / hover / chained access work inside the function body.

  test('obj[k] in body of label-poly fn is typed as the labelField value', () => {
    const src = `
// Pair :: (a, b) -> Pair a b
// Pair#fst :: Pair a b ~> a
// Pair#snd :: Pair a b ~> () -> b
const Pair = null;
// unwrap :: { [k] :: Pair a b } -> { [k] :: b }
const unwrap = obj => Object.keys(obj).reduce((acc, k) => ({ ...acc, [k]: obj[k] }), {});
unwrap({ a: Pair(1, "x") })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    // Find a node whose source spans `obj[k]` and check its inferred type.
    let found: string | null = null;
    for (const [, entry] of r.nodeTypes) {
      const ts = typeToString(r.substitution.apply(entry.type));
      if (ts.startsWith('Pair ')) { found = ts; break; }
    }
    expect(found).not.toBeNull();
    expect(found!).toMatch(/^Pair /);
  });

  test('chained method on obj[k] resolves through labelField type', () => {
    const src = `
// Pair :: (a, b) -> Pair a b
// Pair#snd :: Pair a b ~> b
const Pair = null;
// values :: { [k] :: Pair a b } -> [b]
const values = obj => Object.keys(obj).map(k => obj[k].snd())
values({ a: Pair(1, "x"), b: Pair(2, "y") })
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    // Result should be [String]
    expect(typeToString(r.type)).toBe('[String]');
  });
});

describe('label-poly record with explicit row tail `{ [k] :: a, ...r }`', () => {
  const bindingType = (src: string, name: string): string => {
    const r = new InferenceEngine().infer(src);
    const sch = r.topLevelBindings.get(name);
    return sch ? typeToString(sch.type) : '<none>';
  };

  test('inline object-literal arg keeps the rest row (not collapsed to `{}`)', () => {
    // Regression: `tryExpandRowMap` used to expand `[k]` over EVERY key of the
    // inline literal, consuming the whole record and leaving `...r` empty, so
    // `omitted` came out as `{}`.  With a row tail present, `[k]` matches one
    // property and `...r` keeps the remainder.
    const src = `
// f :: { [k] :: a, ...r } -> {r}
const f = obj => obj;
const out = f({ name: "dd", age: 1, country: "BE" });
`;
    const t = bindingType(src, 'out');
    expect(t).not.toBe('{}');
    expect(t).toContain('age :: Number');
    expect(t).toContain('country :: String');
  });

  test('inline-literal and variable arguments agree', () => {
    const inline = bindingType(`
// f :: { [k] :: a, ...r } -> {r}
const f = obj => obj;
const out = f({ name: "dd", age: 1, country: "BE" });
`, 'out');
    const viaVar = bindingType(`
// f :: { [k] :: a, ...r } -> {r}
const f = obj => obj;
const rec = { name: "dd", age: 1, country: "BE" };
const out = f(rec);
`, 'out');
    expect(inline).toBe(viaVar);
  });

  test('pure label group `{ [k] :: a }` (no row tail) still expands over all keys', () => {
    // The fix must NOT disable the legitimate map-over-all-keys expansion.
    const src = `
// Pair :: (a, b) -> Pair a b
// Pair#snd :: Pair a b ~> b
const Pair = null;
// values :: { [k] :: Pair a b } -> [b]
const values = obj => Object.keys(obj).map(k => obj[k].snd())
const out = values({ a: Pair(1, "x"), b: Pair(2, "y") })
`;
    expect(bindingType(src, 'out')).toBe('[String]');
  });
});

describe('omit — static key-set removal from an inline array literal', () => {
  const omitPrelude = `
// concat :: a -> a -> a
const concat = x => y => y;
// reduce :: (b -> a -> b) -> b -> [a] -> b
const reduce = f => init => xs => init;
// reducer :: { [k] :: a, ...r } -> String -> {r}
const reducer = acc => prop => acc;
// omit :: Array String k => k -> { [k] :: a, ...r } -> {r}
const omit = props => obj => reduce (reducer) (concat ({}) (obj)) (props);
`;
  const out = (call: string, prefix = ''): { t: string; diags: string[] } => {
    const r = new InferenceEngine().infer(`${omitPrelude}\n${prefix}const out = ${call};`);
    const sch = r.topLevelBindings.get('out');
    return { t: sch ? typeToString(sch.type) : '<none>', diags: r.diagnostics.map(d => d.message) };
  };

  test('removes ALL listed keys, not just the first', () => {
    const { t, diags } = out(`omit(["name", "age"])({ name: "dd", age: 1, country: "BE" })`);
    expect(diags).toHaveLength(0);
    expect(t).toBe('{ country :: String }');
  });

  test('single-key array removes one key', () => {
    const { t } = out(`omit(["name"])({ name: "dd", age: 1, country: "BE" })`);
    expect(t).toContain('age :: Number');
    expect(t).toContain('country :: String');
    expect(t).not.toContain('name');
  });

  test('removing every key yields the empty record', () => {
    const { t } = out(`omit(["name", "age", "country"])({ name: "dd", age: 1, country: "BE" })`);
    expect(t).toBe('{}');
  });

  test('a key array from a variable falls back gracefully (no crash)', () => {
    // A non-literal key array carries no type-level key info, so the static
    // key-set expansion does not fire; ordinary single-label row unification
    // still applies and inference stays sound.
    const { t, diags } = out(`omit(ks)({ name: "dd", age: 1, country: "BE" })`,
      `const ks = ["name", "age"];\n`);
    expect(diags).toHaveLength(0);
    expect(t).toContain('country :: String');
  });
});

describe('occurs check covers label-poly record value types', () => {
  test('self-referential `a = { [k] :: a }` reports a type error, not a crash', () => {
    // Regression: `occursIn` skipped `labelFields`, so an infinite type built
    // through a label-poly record escaped the occurs check and blew the stack
    // in `Substitution.apply` ("Internal inference error: Maximum call stack
    // size exceeded").  The mutual recursion below forces `a = { [k] :: a }`.
    const src = `
// chain :: (a -> Maybe b) -> Maybe a -> Maybe b
const chain = f => m => m;
// reduce :: (b -> a -> b) -> b -> [a] -> b
const reduce = f => init => xs => init;
// Just :: a -> Maybe a
const Just = x => x;
// isArray :: a -> Boolean
const isArray = x => true;
const reducer = maybe => key => chain (prop (key)) (maybe);
const getPath = keys => obj => reduce (reducer) (Just (obj)) (keys);
// prop :: k -> { [k] :: a } -> Maybe a
const prop = key => obj => getPath (key) (obj);
`;
    const r = new InferenceEngine().infer(src);
    const msgs = r.diagnostics.map(d => d.message).join('\n');
    expect(msgs).not.toMatch(/Maximum call stack/);
    expect(msgs).not.toMatch(/Internal inference error/);
  });
});

