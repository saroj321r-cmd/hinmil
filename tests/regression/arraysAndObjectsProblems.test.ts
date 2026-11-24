// Regression coverage for the ArraysAndObjects.js problem set:
//   P-A  overloaded function parameters hover as a union of their per-overload types
//   P-D  call-site Merge results dedup conflicting keys into a single field union
//   P-E  spreading / merging a *bare* type-variable parameter is rejected
//   P-G  a literal `{}` in an annotation is a strict, closed, exactly-empty object
//   P-I  `::rep` accepts a record receiver (`{ [k] :: a } ~> ...`) for `Object`

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import { scrubSkolems } from '../../src/hm/typeUtils';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

function infer(src: string) {
  return engine.infer(src);
}

function diagsOf(src: string): string[] {
  return infer(src).diagnostics.map(d => d.message);
}

/** Inferred (substituted) type string for the first occurrence of `token`. */
function typeAtToken(
  src: string,
  result: ReturnType<InferenceEngine['infer']>,
  token: string,
): string | null {
  const off = src.indexOf(token);
  if (off < 0) return null;
  let best: { type: import('../../src/hm/types').Type } | null = null;
  let bestStart = -1;
  for (const [start, entry] of result.nodeTypes.entries()) {
    const end = (entry as { end?: number }).end ?? start;
    if (start <= off && off < end && start > bestStart) {
      bestStart = start;
      best = entry as { type: import('../../src/hm/types').Type };
    }
  }
  if (!best) return null;
  // Mirror server.ts hover: rigid skolems render with their annotation letters.
  const applied = result.substitution.apply(best.type);
  return prettyTypeToString(result.skolemDisplayNames ? scrubSkolems(applied, result.skolemDisplayNames) : applied);
}

describe('overloaded parameter hover (P-A)', () => {
  test('parameters display as the union of their type across overloads', () => {
    const src = `
// concat :: ([a], [b]) -> [a | b]
// concat :: ({a}, {...b}) -> { ...a, ...b }
const concat = (arr, arr2) => {
  if (isArray(arr)) { return arr.concat(arr2); }
  return {...arr, ...arr2};
};
// ::narrow Array
// isArray :: a -> Boolean
const isArray = a => Array.isArray(a);
`;
    const r = infer(src);
    const arr = typeAtToken(src, r, 'arr');
    const arr2 = typeAtToken(src, r, 'arr2');
    // `arr` is a union of a list `[a]` and an open record `{ a }`.  Both
    // overload branches name the slot `a`, so the SAME source name must show
    // in both members (display-canonicalized) — `[a] | { a }`, never
    // `[a] | { b }`.
    expect(arr).toBe('[a] | { a }');
    expect(arr2).toBe('[b] | { b }');
  });
});

describe('empty-array element dedup (P-B)', () => {
  test('records differing only in a fresh empty-array element collapse to one', () => {
    const src = `
// concat :: ([a], [a]) -> [a]
const concat = (a, b) => a;
const c10 = concat([{ name: "test", cars: [] }], [{ name: "foemp", cars: [] }]);
`;
    const r = infer(src);
    const c10 = typeAtToken(src, r, 'c10');
    // Both empty `cars: []` literals carry information-free element vars, so
    // the two record members are equivalent and dedup to a single member.
    expect(c10).toBe('[{ name :: String, cars :: [a] }]');
  });
});

describe('call-site Merge dedup (P-D)', () => {
  test('overlapping keys collapse to a single field with a union value', () => {
    const src = `
// concat :: ([a], [b]) -> [a | b]
// concat :: ({a}, {...b}) -> { ...a, ...b }
const concat = (arr, arr2) => {
  if (isArray(arr)) { return arr.concat(arr2); }
  return {...arr, ...arr2};
};
// ::narrow Array
// isArray :: a -> Boolean
const isArray = a => Array.isArray(a);
const cs = concat({a: 1}, {a: "2", b: 2});
`;
    const r = infer(src);
    const cs = typeAtToken(src, r, 'cs ');
    // `a` appears exactly once, as a union; `b` retained.
    expect(cs).toMatch(/a :: (Number \| String|String \| Number)/);
    expect(cs).toMatch(/b :: Number/);
    expect((cs!.match(/a ::/g) || []).length).toBe(1);
  });
});

describe('bare-parameter merge is rejected (P-E)', () => {
  test('record spread over bare params reports a record-form diagnostic', () => {
    const diags = diagsOf(`
// mergeBare :: (a, b) -> { ...a, ...b }
const mergeBare = (a, b) => ({...a, ...b});
`);
    expect(diags.some(m => /bare type variable/.test(m) && /\{a\}/.test(m) && /\{\[k\] :: a\}/.test(m))).toBe(true);
  });

  test('explicit Merge over bare params reports the same diagnostic', () => {
    const diags = diagsOf(`
// mergeBare :: (a, b) -> Merge a b
const mergeBare = (a, b) => ({...a, ...b});
`);
    expect(diags.some(m => /bare type variable 'a'/.test(m))).toBe(true);
    expect(diags.some(m => /bare type variable 'b'/.test(m))).toBe(true);
  });

  test('record-typed parameters do NOT trigger the diagnostic', () => {
    const diags = diagsOf(`
// mergeRec :: ({a}, {...b}) -> { ...a, ...b }
const mergeRec = (a, b) => ({...a, ...b});
`);
    expect(diags.some(m => /bare type variable/.test(m))).toBe(false);
  });
});

describe('strict empty record (P-G)', () => {
  test('`{}` parameter rejects an argument with extra fields', () => {
    const diags = diagsOf(`
// testEmpty :: {} -> {}
const testEmpty = o => ({});
const te = testEmpty({ a: 1 });
`);
    expect(diags.some(m => /Cannot unify/.test(m) && /\{\}/.test(m))).toBe(true);
  });

  test('`{}` parameter accepts an empty-object argument', () => {
    const diags = diagsOf(`
// testEmpty :: {} -> {}
const testEmpty = o => ({});
const te = testEmpty({});
`);
    expect(diags).toHaveLength(0);
  });

  test('inferred empty object literals stay lenient (omit-style body)', () => {
    const diags = diagsOf(`
// omit :: (k, { [k] :: a, ...r }) -> { ...r }
const omit = (k, obj) => {
  const out = {};
  for (const key in obj) if (key !== k) out[key] = obj[key];
  return out;
};
const stripped = omit("x", { x: 1, y: 2, z: "hi" });
`);
    expect(diags).toHaveLength(0);
  });
});

describe('strict empty array (P-H)', () => {
  test('`[]` parameter rejects a non-empty array argument', () => {
    const diags = diagsOf(`
// testEmpty :: [] -> Number
const testEmpty = a => 1;
const te = testEmpty([1, 2, 3]);
`);
    expect(diags.some(m => /Cannot unify/.test(m) && /\[\]/.test(m))).toBe(true);
  });

  test('`[]` parameter accepts an empty-array argument', () => {
    const diags = diagsOf(`
// testEmpty :: [] -> Number
const testEmpty = a => 1;
const te = testEmpty([]);
`);
    expect(diags).toHaveLength(0);
  });

  test('inferred empty array literals stay polymorphic', () => {
    const diags = diagsOf(`
const xs = [];
xs.push(1);
xs.push(2);
`);
    expect(diags).toHaveLength(0);
  });
});

describe('::rep record receiver (P-I)', () => {
  test('`{ [k] :: a } ~> ...` satisfies an Object rep without a "no signature" error', () => {
    const diags = diagsOf(`
// ::constraint Foldable f { f :: { reduce :: f a ~> ((b, a) -> b, b) -> b } }
let natives = {}
// ::rep Foldable Object#reduce
// natives.Object :: { [k] :: a } ~> ((b, a) -> b, b) -> b
natives.Object = function (fn, init) {
  return Object.keys(this).reduce((acc, key) => fn(acc, this[key]), init);
};
`);
    expect(diags.some(m => /no following 'Object .* ~> .* signature found/.test(m))).toBe(false);
  });
});

describe('object-merge annotation forms (cluster)', () => {
  test('prototype `{...a} ~> {...b} -> {...a,...b}` is a clean merge (no spurious mismatch)', () => {
    const diags = diagsOf(`
// Object#concat2 :: {...a} ~> {...b} -> {...a, ...b}
Object.prototype.concat2 = function (obj) {
  return {...this, ...obj};
};
`);
    expect(diags.some(m => /Type mismatch/.test(m))).toBe(false);
  });

  test('prototype `{a} ~> {...b} -> {...a,...b}` is a clean merge (no spurious mismatch)', () => {
    const diags = diagsOf(`
// Object#concat3 :: {a} ~> {...b} -> {...a, ...b}
Object.prototype.concat3 = function (obj) {
  return {...this, ...obj};
};
`);
    expect(diags.some(m => /Type mismatch/.test(m))).toBe(false);
  });

  test('prototype-method parameter renders as `{ b }`, not the empty `{}`', () => {
    const src = `
// Object#concat2 :: {...a} ~> {...b} -> {...a, ...b}
Object.prototype.concat2 = function (obj) {
  return {...this, ...obj};
};
`;
    const r = infer(src);
    const obj = typeAtToken(src, r, 'obj');
    expect(obj).toMatch(/\{\s*b\s*\}/);
  });

  test('annotated `({a},{b}) -> {...a,...b}` with a non-object body IS diagnosed', () => {
    const diags = diagsOf(`
// concatObjExpectDiagnostic :: ({a}, {b}) -> { ...a, ...b }
const concatObjExpectDiagnostic = (obj1, obj2) => {
  return "diagnostic";
};
`);
    expect(diags.some(m => /Type mismatch/.test(m) && /String/.test(m))).toBe(true);
  });

  test('annotated `({a},{b}) -> {...a,...b}` renders params as `{ a }` / `{ b }`', () => {
    const src = `
// concatObjExpectDiagnostic :: ({a}, {b}) -> { ...a, ...b }
const concatObjExpectDiagnostic = (obj1, obj2) => {
  return "diagnostic";
};
`;
    const r = infer(src);
    const o1 = typeAtToken(src, r, 'obj1');
    expect(o1).toMatch(/\{\s*a\s*\}/);
  });
});

describe('deterministic union member ordering', () => {
  test('union members are emitted in lexicographic order', () => {
    const src = `
const mixed = [1, "two", true];
`;
    const r = infer(src);
    const mixed = typeAtToken(src, r, 'mixed');
    // Element union sorted lexicographically: Boolean < Number < String.
    expect(mixed).toContain('Boolean | Number | String');
  });
});

describe('user-defined Object#method on any record form (label↔row bridge)', () => {
  test('`Object#concat` (label form) resolves on a spread-form caller with no diagnostic', () => {
    const diags = diagsOf(`
// Object#concat :: {[j]:: a} ~> {[i]:: b} -> { [j]:: a, [i]:: b}
Object.prototype.concat = (obj) => { return {...this, ...obj}; };
// concatObjSpread :: ({...a}, {...b}) -> { ...a, ...b }
const concatObjSpread = (obj, obj2) => { return obj.concat(obj2); };
`);
    expect(diags).toEqual([]);
  });

  test('row-form receiver `{ a } ~> { b } -> {...a,...b}` works via a spread caller', () => {
    // The result `Merge a b` carries a bare row-variable operand until the
    // argument binds it; this must NOT raise "contains a non-record operand".
    const diags = diagsOf(`
// Object#concat :: { a } ~> { b } -> {...a, ...b}
Object.prototype.concat = (obj) => { return {...this, ...obj}; };
// concatObjSpread :: ({...a}, {...b}) -> { ...a, ...b }
const concatObjSpread = (obj, obj2) => { return obj.concat(obj2); };
`);
    expect(diags).toEqual([]);
  });

  test('spread-caller parameter hover keeps its annotation name (`{ a }`, not `{ r16 }`)', () => {
    const src = `
// Object#concat :: { a } ~> { b } -> {...a, ...b}
Object.prototype.concat = (obj) => { return {...this, ...obj}; };
// concatObjSpread :: ({...a}, {...b}) -> { ...a, ...b }
const concatObjSpread = (param1, param2) => { return param1.concat(param2); };
`;
    const r = infer(src);
    const p1 = typeAtToken(src, r, 'param1');
    // Must show the named open row, not a fresh internal row name like `r16`.
    expect(p1).toBe('{ a }');
  });

  test('spread-form receiver `{...a} ~> {...b} -> {...a,...b}` works via a spread caller', () => {
    const diags = diagsOf(`
// Object#concat2 :: {...a} ~> {...b} -> {...a, ...b}
Object.prototype.concat2 = (obj) => { return {...this, ...obj}; };
// concatObjSpread :: ({...a}, {...b}) -> { ...a, ...b }
const concatObjSpread = (obj, obj2) => { return obj.concat2(obj2); };
`);
    expect(diags).toEqual([]);
  });

  test('`Object#concat` resolves on a strict-empty `{}` receiver', () => {
    const diags = diagsOf(`
// Object#concat :: {[j]:: a} ~> {[i]:: b} -> { [j]:: a, [i]:: b}
Object.prototype.concat = (obj) => { return {...this, ...obj}; };
const r1 = ({}).concat({});
`);
    expect(diags.some(m => /does not exist/.test(m))).toBe(false);
  });

  test('`Object#concat` on concrete-field records merges both field sets', () => {
    const src = `
// Object#concat :: {[j]:: a} ~> {[i]:: b} -> { [j]:: a, [i]:: b}
Object.prototype.concat = (obj) => { return {...this, ...obj}; };
const merged = ({x: 1}).concat({y: "s"});
`;
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    const merged = typeAtToken(src, r, 'merged');
    expect(merged).toMatch(/x :: Number/);
    expect(merged).toMatch(/y :: String/);
  });

  test('`{a}` (open-row) receiver form also resolves the method without diagnostic', () => {
    const diags = diagsOf(`
// Object#concat3 :: {a} ~> {...b} -> {...a, ...b}
Object.prototype.concat3 = (obj) => { return {...this, ...obj}; };
const callConcat3 = (x, y) => { return x.concat3(y); };
`);
    expect(diags.some(m => /does not exist/.test(m))).toBe(false);
  });

  test('the bridge does NOT rescue a bare-variable merge', () => {
    const diags = diagsOf(`
// concatBare :: (a, b) -> { ...a, ...b }
const concatBare = (a, b) => { return {...a, ...b}; };
`);
    expect(diags.some(m => /Cannot merge bare type variable/.test(m))).toBe(true);
  });
});

describe('homogeneous label-value var `{ [k]::a } -> [a]`', () => {
  test('a heterogeneous object unions the value types instead of conflicting', () => {
    const src = `
// values :: { [k]:: a } -> [a]
const values = obj => Object.values(obj);
const vals = values({ a: 2, b: "str"});
`;
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    const vals = typeAtToken(src, r, 'vals');
    expect(vals).toBe('[Number | String]');
  });

  test('a homogeneous object stays a single element type', () => {
    const src = `
// values :: { [k]:: a } -> [a]
const values = obj => Object.values(obj);
const vals = values({ a: 2, b: 3});
`;
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    const vals = typeAtToken(src, r, 'vals');
    expect(vals).toBe('[Number]');
  });
});

describe('annotated parameter hover always shows the signature object form', () => {
  /** Frozen (annotation) type string for the parameter named `token`. */
  function frozenParamAt(
    src: string,
    result: ReturnType<InferenceEngine['infer']>,
    token: string,
  ): string | null {
    const off = src.indexOf(token);
    const frozen = result.frozenParamType?.get(off);
    return frozen ? prettyTypeToString(frozen) : null;
  }

  // Body closes the open row of `obj1` to `{}` via `Object.keys`, which used
  // to poison the live-substituted hover type to `{}`.  The declared type is
  // the annotation, so hover must keep showing it.
  const mergeBody = (sig: string) => `
${sig}
const merge = (obj1, obj2) => Object.keys(obj1).reduce((acc, k) => ({ ...acc, [k]: obj2[k] }), obj1);
`;

  test('open-row shorthand `{ a }` stays `{ a }` (not `{}`)', () => {
    const src = mergeBody('// merge :: ({a}, {b}) -> { ...a, ...b }');
    const r = infer(src);
    expect(frozenParamAt(src, r, 'obj1')).toBe('{ a }');
    expect(frozenParamAt(src, r, 'obj2')).toBe('{ b }');
  });

  test('spread-row `{ ...a }` keeps its open-row signature form', () => {
    const src = mergeBody('// merge :: ({...a}, {...b}) -> { ...a, ...b }');
    const r = infer(src);
    expect(frozenParamAt(src, r, 'obj1')).toBe('{ a }');
    expect(frozenParamAt(src, r, 'obj2')).toBe('{ b }');
  });

  test('label-polymorphic `{ [k]::a }` keeps its signature form', () => {
    const src = mergeBody('// merge :: ({[k]::a}, {[j]::b}) -> { [k]::a, [j]::b }');
    const r = infer(src);
    expect(frozenParamAt(src, r, 'obj1')).toBe('{ [k] :: a }');
    expect(frozenParamAt(src, r, 'obj2')).toBe('{ [j] :: b }');
  });

  test('concrete-field `{ x::Number }` keeps its signature form', () => {
    const src = mergeBody('// merge :: ({x::Number}, {y::String}) -> { x::Number, y::String }');
    const r = infer(src);
    expect(frozenParamAt(src, r, 'obj1')).toBe('{ x :: Number }');
    expect(frozenParamAt(src, r, 'obj2')).toBe('{ y :: String }');
  });

  test('a body that never touches the params shows the same form (parity)', () => {
    const src = `
// concatObjExpectDiagnostic :: ({a}, {b}) -> { ...a, ...b }
const concatObjExpectDiagnostic = (obj1, obj2) => {
  return "diagnostic";
};
`;
    const r = infer(src);
    expect(frozenParamAt(src, r, 'obj1')).toBe('{ a }');
    expect(frozenParamAt(src, r, 'obj2')).toBe('{ b }');
  });

  /** Frozen type string at the Nth (0-based) occurrence of `token`. */
  function frozenAtOccurrence(
    src: string,
    result: ReturnType<InferenceEngine['infer']>,
    token: string,
    occurrence: number,
  ): string | null {
    let off = -1;
    for (let n = 0; n <= occurrence; n++) off = src.indexOf(token, off + 1);
    const frozen = result.frozenParamType?.get(off);
    return frozen ? prettyTypeToString(frozen) : null;
  }

  /** Mirrors server.ts onHover: frozen annotation wins, else live substitution. */
  function hoverAtOccurrence(
    src: string,
    result: ReturnType<InferenceEngine['infer']>,
    token: string,
    occurrence: number,
  ): string | null {
    let off = -1;
    for (let n = 0; n <= occurrence; n++) off = src.indexOf(token, off + 1);
    const frozen = result.frozenParamType?.get(off);
    if (frozen) return prettyTypeToString(frozen);
    let best: { type: import('../../src/hm/types').Type } | null = null;
    let bestStart = -1;
    for (const [start, entry] of result.nodeTypes.entries()) {
      const end = (entry as { end?: number }).end ?? start;
      if (start <= off && off < end && start > bestStart) {
        bestStart = start;
        best = entry as { type: import('../../src/hm/types').Type };
      }
    }
    return best ? prettyTypeToString(result.substitution.apply(best.type)) : null;
  }

  test('a body REFERENCE of an annotated param still shows the signature', () => {
    // `obj1` is referenced in `Object.keys(obj1)` (closes the open row) and in
    // the reduce seed; both references must still hover as `{ a }`.
    const src = mergeBody('// merge :: ({a}, {b}) -> { ...a, ...b }');
    // occurrence 0 is the param decl, 1 and 2 are the body references.
    expect(frozenAtOccurrence(src, infer(src), 'obj1', 1)).toBe('{ a }');
    expect(frozenAtOccurrence(src, infer(src), 'obj1', 2)).toBe('{ a }');
  });

  test('default-valued annotated param keeps signature at decl and in body', () => {
    const src = `
// g :: (Number) -> Number
const g = (x = 1) => x + 1;
`;
    const r = infer(src);
    expect(frozenParamAt(src, r, 'x')).toBe('Number');
    // body reference `x + 1`
    expect(frozenAtOccurrence(src, r, 'x', 1)).toBe('Number');
  });

  test('destructured-leaf annotated param shows its field type in the body', () => {
    const src = `
// f :: ({ x::Number, y::String }) -> Number
const f = ({ x, y }) => x;
`;
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    // occurrence 0 is in the comment, 1 the pattern leaf, 2 the body ref.
    expect(frozenAtOccurrence(src, r, 'x', 1)).toBe('Number');
    expect(frozenAtOccurrence(src, r, 'x', 2)).toBe('Number');
    expect(frozenAtOccurrence(src, r, 'y', 1)).toBe('String');
  });

  test('an accepted narrow shows the NARROWED type inside the guarded block', () => {
    // Outside the guard the signature wins; inside `typeof v === "number"`
    // the narrowing rebinds `v` with a plain `mono`, dropping the frozen
    // display so the narrowed `Number` shows through.
    const src = `
// h :: (Number | String) -> Number
const h = (v) => {
  if (typeof v === "number") { return v; }
  return 0;
};
`;
    const r = infer(src);
    // occurrence: 0 param decl, 1 typeof test, 2 narrowed return.
    expect(hoverAtOccurrence(src, r, 'v', 0)).toBe('Number | String');
    expect(hoverAtOccurrence(src, r, 'v', 1)).toBe('Number | String');
    // The narrowed reference is no longer frozen; it resolves to `Number`.
    let narrowOff = -1;
    for (let n = 0; n <= 2; n++) narrowOff = src.indexOf('v', narrowOff + 1);
    expect(r.frozenParamType?.get(narrowOff)).toBeUndefined();
    expect(hoverAtOccurrence(src, r, 'v', 2)).toBe('Number');
  });
});

describe('merge-shape signature: open-row param is not poisoned by the body', () => {
  // `obj1`'s annotated type `{ a }` (open row) used to be poisoned to `{}` by
  // the body (`Object.keys(obj1).reduce(..., obj1)` unified against the merge
  // return `{ ...a, ...b }`), and a spurious `Cannot unify '{ a }' with
  // '{ ...a, ...b }'` was emitted.  The annotation is authoritative: the LIVE
  // (substituted) param type must stay `{ a }` and no diagnostic must appear.
  test('reduce-seed body keeps `{ a }` live and emits no diagnostic', () => {
    const src = `
// merge :: ({a}, {b}) -> { ...a, ...b }
const merge = (obj1, obj2) => Object.keys(obj1).reduce((acc, k) => ({ ...acc, [k]: obj2[k] }), obj1);
`;
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    // typeAtToken applies the substitution — i.e. the LIVE type, not the frozen
    // display.  It must be the un-poisoned annotation form.
    expect(typeAtToken(src, r, 'obj1')).toBe('{ a }');
    expect(typeAtToken(src, r, 'obj2')).toBe('{ b }');
  });

  test('a trivial merge body behaves identically (parity)', () => {
    const src = `
// keep :: ({a}, {b}) -> { ...a, ...b }
const keep = (obj1, obj2) => ({ ...obj1, ...obj2 });
`;
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(typeAtToken(src, r, 'obj1')).toBe('{ a }');
  });

  test('a single open-row param is unaffected (no merge return)', () => {
    const src = `
// q :: ({a}) -> [String]
const q = (o) => Object.keys(o);
`;
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(typeAtToken(src, r, 'o) => Object')).toBe('{ a }');
  });
});

describe('merge-shape return accepts any record body (unify-level)', () => {
  // Decision: a merge-shape return type (`{ ...a, ...b }`, the label form
  // `{ [i] :: a, [k] :: [b] }`, or a `Merge` marker) is satisfied by ANY
  // record-ish body.  Accepting `obj1` / `{...obj1}` / a reduce seed while
  // still rejecting non-records (Number/String) is enforced deep in `unify`
  // via `mergeShapeAccepts`, replacing the former open-row-only `protectRows`
  // suppression.

  test('label/kv merge reduce-seed body emits no diagnostic and keeps `{ [i] :: a }`', () => {
    const src = `
// merge :: ({[i] :: a}, {[k] :: b}) -> { [i] :: a, [k] :: [b] }
const merge = (obj1, obj2) => Object.keys(obj1).reduce((acc, k) => ({ ...acc, [k]: obj2[k] }), obj1);
`;
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(typeAtToken(src, r, 'obj1')).toBe('{ [i] :: a }');
    expect(typeAtToken(src, r, 'obj2')).toBe('{ [k] :: b }');
  });

  test('a body that returns `obj1` (a subset record) is accepted', () => {
    const src = `
// f :: ({a}, {b}) -> { ...a, ...b }
const f = (obj1, obj2) => {
  return obj1;
};
`;
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(typeAtToken(src, r, 'obj1')).toBe('{ a }');
  });

  test('a body that spreads `{ ...obj1 }` is accepted', () => {
    const src = `
// f :: ({a}, {b}) -> { ...a, ...b }
const f = (obj1, obj2) => ({ ...obj1 });
`;
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    expect(typeAtToken(src, r, 'obj1')).toBe('{ a }');
  });

  test('a non-record body (Number/String) is still rejected', () => {
    const num = diagsOf(`
// f :: ({a}, {b}) -> { ...a, ...b }
const f = (obj1, obj2) => 42;
`);
    expect(num.some(m => /Number.*annotation expects.*\{ \.\.\.a, \.\.\.b \}/.test(m))).toBe(true);

    const str = diagsOf(`
// g :: ({a}, {b}) -> { ...a, ...b }
const g = (obj1, obj2) => "x";
`);
    expect(str.some(m => /String.*annotation expects.*\{ \.\.\.a, \.\.\.b \}/.test(m))).toBe(true);
  });

  test('the label/kv return form ALSO rejects a non-record body', () => {
    const str = diagsOf(`
// merge :: ({[i] :: a}, {[k] :: b}) -> { [i] :: a, [k] :: [b] }
const merge = (obj1, obj2) => "2";
`);
    expect(str.some(m => /String.*annotation expects.*\{ \[i\] :: a, \[k\] :: \[b\] \}/.test(m))).toBe(true);

    const num = diagsOf(`
// merge :: ({[i] :: a}, {[k] :: b}) -> { [i] :: a, [k] :: [b] }
const merge = (obj1, obj2) => 42;
`);
    expect(num.some(m => /Number.*annotation expects/.test(m))).toBe(true);

    const arr = diagsOf(`
// merge :: ({[i] :: a}, {[k] :: b}) -> { [i] :: a, [k] :: [b] }
const merge = (obj1, obj2) => [1, 2];
`);
    expect(arr.some(m => /\[Number\].*annotation expects/.test(m))).toBe(true);
  });
});

describe('unannotated `X.prototype.method = …` (no signature)', () => {
  test('does NOT emit "Property \'prototype\' does not exist"', () => {
    const diags = diagsOf(`
Object.prototype.concat = (obj) => {
  return {...this, ...obj};
};
`);
    expect(diags.some(m => /prototype/.test(m))).toBe(false);
  });

  test('does NOT couple the method to the type (no implicit registration)', () => {
    // Without a user signature the method must stay unregistered, so a later
    // call site still reports the property as missing.
    const diags = diagsOf(`
Object.prototype.concat = (obj) => {
  return {...this, ...obj};
};
const x = ({a: 1}).concat({b: 2});
`);
    expect(diags.some(m => /Property 'concat' does not exist/.test(m))).toBe(true);
    expect(diags.some(m => /prototype/.test(m))).toBe(false);
  });

  test('an annotated prototype assignment still couples the method', () => {
    const diags = diagsOf(`
// Object#concat :: {[j]:: a} ~> {[i]:: b} -> { [j]:: a, [i]:: b}
Object.prototype.concat = (obj) => {
  return {...this, ...obj};
};
const x = ({a: 1}).concat({b: 2});
`);
    expect(diags).toEqual([]);
  });
});



