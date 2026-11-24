// Tests for the four issues raised in
// `fpkit/src/more/getType.js` comments:
//   1. `@@`-prefixed record field keys are preserved by the type parser
//      and round-trip through the pretty-printer (the LSP previously
//      stripped the `@@` and showed only `type`).
//   2. `value && X` / `value || X` narrow `value` on the right-hand side
//      so a `{ @@type :: String } | Undefined` parameter does not produce
//      a "field on Undefined" diagnostic at `value["@@type"]`.
//   3. `String.prototype.slice` and `Array.prototype.slice` accept both
//      one-arg `(begin)` and two-arg `(begin, end)` forms.
//   4. `::private` / `::hidden` field declarations on a class don't
//      cause diagnostics when the value is consumed by a function whose
//      parameter annotation declares the field as a public obligation
//      (the annotation acts as a capability grant).

import { InferenceEngine } from '../../src/index';
import { parseTypeSignature } from '../../src/hm/typeParser';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';

beforeEach(() => resetTypeVarCounter());

const newEngine = () => new InferenceEngine();

// ---------------------------------------------------------------------------
// Phase 1 — `@@` / `@` field keys
// ---------------------------------------------------------------------------

describe('@@-prefixed record field keys', () => {
  test('parser preserves `@@type` as a record field name', () => {
    const sch = parseTypeSignature('{ @@type :: String } -> String');
    // sch.type :: TFun ({ @@type :: String }) -> String
    expect(sch.type.tag).toBe('TFun');
    const param: any = (sch.type as any).param;
    expect(param.tag).toBe('TRecord');
    expect(Object.keys(param.fields)).toEqual(['@@type']);
    expect(param.fields['@@type'].tag).toBe('TCon');
    expect(param.fields['@@type'].name).toBe('String');
  });

  test('parser accepts single `@`-prefixed keys too', () => {
    const sch = parseTypeSignature('{ @iterator :: a } -> a');
    const param: any = (sch.type as any).param;
    expect(Object.keys(param.fields)).toEqual(['@iterator']);
  });

  test('pretty-print round-trip preserves `@@type`', () => {
    const sch = parseTypeSignature('{ @@type :: String } -> String');
    expect(typeToString(sch.type)).toBe('{ @@type :: String } -> String');
  });

  test('inference: function annotated with `@@type` field types correctly', () => {
    const r = newEngine().infer(`
      // getTag :: { @@type :: String } -> String
      const getTag = obj => obj["@@type"];
    `);
    expect(r.diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — `&&` / `||` narrowing on RHS
// ---------------------------------------------------------------------------

describe('Truthy narrowing on logical && / ||', () => {
  test('`value && value.foo` narrows away Undefined arm', () => {
    const r = newEngine().infer(`
      // peek :: { foo :: String } | Undefined -> String | Undefined
      const peek = value => value && value.foo;
    `);
    expect(r.diagnostics).toEqual([]);
  });

  test('`value && value["@@type"]` works on the getType pattern', () => {
    const r = newEngine().infer(`
      // tagOf :: { @@type :: String } | Undefined -> String | Undefined
      const tagOf = value => value && value["@@type"];
    `);
    expect(r.diagnostics).toEqual([]);
  });

  test('`value || fallback` does not error on union with Undefined', () => {
    const r = newEngine().infer(`
      // orElse :: String | Undefined -> String
      const orElse = value => value || "default";
    `);
    expect(r.diagnostics).toEqual([]);
  });

  test('narrowing is restricted to Identifier LHS (typeof + null chain still ok)', () => {
    // Regression guard from sample/demo2.js: `typeof x === "object" && x !== null`
    // must NOT trigger "Cannot unify Object with Null".
    const r = newEngine().infer(`
      const isObj = x => typeof x === "object" && x !== null;
    `);
    expect(r.diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — `slice` accepts 1 or 2 args
// ---------------------------------------------------------------------------

describe('slice accepts 1 or 2 args', () => {
  test('String.slice with 1 arg', () => {
    const r = newEngine().infer(`const a = "hello".slice(1);`);
    expect(r.diagnostics).toEqual([]);
  });

  test('String.slice with 2 args', () => {
    const r = newEngine().infer(`const a = "hello".slice(1, 3);`);
    expect(r.diagnostics).toEqual([]);
  });

  test('String.slice with negative end (the getType case)', () => {
    const r = newEngine().infer(`const a = "[object Foo]".slice(8, -1);`);
    expect(r.diagnostics).toEqual([]);
  });

  test('Array.slice with 1 arg', () => {
    const r = newEngine().infer(`const a = [1,2,3].slice(1);`);
    expect(r.diagnostics).toEqual([]);
  });

  test('Array.slice with 2 args', () => {
    const r = newEngine().infer(`const a = [1,2,3].slice(0, 2);`);
    expect(r.diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — privacy / hidden field semantics.
//
// The conceptual question raised in the getType comments was: if a callee
// declares `@@type` as `::private` / `::hidden`, will the call site still
// type-check?  In the getType body itself the access is structural
// (`value["@@type"]` where `value :: { @@type :: String } | Undefined`),
// so no class-level privacy check runs and there is nothing to suppress.
// Passing a real class instance into a structurally-annotated function is
// a separate (TCon ↔ TRecord) sub-typing gap, out of scope here.
// ---------------------------------------------------------------------------

describe('::private / ::hidden — structural callee does not trigger class privacy', () => {
  test('structural access on a record literal with ::hidden field is OK', () => {
    const r = newEngine().infer(`
      class Foo { constructor() { this.tag = "Foo"; } }
      // ::hidden
      // Foo#tag :: String

      // getTag :: { tag :: String } -> String
      const getTag = obj => obj.tag;
      const t = getTag({ tag: "Foo" });
    `);
    expect(r.diagnostics).toEqual([]);
  });

  test('structural access on a record literal with ::private field is OK', () => {
    const r = newEngine().infer(`
      class Foo { constructor() { this.tag = "Foo"; } }
      // ::private
      // Foo#tag :: String

      // getTag :: { tag :: String } -> String
      const getTag = obj => obj.tag;
      const t = getTag({ tag: "Foo" });
    `);
    expect(r.diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration — the full getType.js body
// ---------------------------------------------------------------------------

describe('integration: getType.js inferred cleanly', () => {
  test('full getType body types as `{ @@type :: String } | Undefined -> String`', () => {
    const r = newEngine().infer(`
      // getType :: { @@type :: String } | Undefined -> String
      const getType = value => {
        return value && value["@@type"] || {}.toString.call(value).slice(8, -1);
      };
    `);
    expect(r.diagnostics).toEqual([]);
  });

  test('passing `{}` to a `{ @@type :: String } | Undefined` parameter emits a diagnostic', () => {
    // The `{}` literal lacks the required `@@type` field.  Historically
    // closed-vs-closed record unification was lenient and let this through;
    // the directional call-arg check surfaces it now.
    const r = newEngine().infer(`
      // getType :: { @@type :: String } | Undefined -> String
      const getType = value => value && value["@@type"] || {}.toString.call(value).slice(8, -1);
      const obj = {};
      const tObj = getType(obj);
    `);
    const missing = r.diagnostics.filter(d => /Missing required field/i.test(d.message));
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain("'@@type'");
  });

  test('field whose declared type accepts Undefined is optional in `{}` arg', () => {
    // `Default :: Function | Undefined` means the caller is permitted to
    // omit the field entirely (passing `{}` is fine — the field reads as
    // `Undefined`).  Historically this emitted a "Missing required field"
    // diagnostic; the fix skips the check when the field type accepts
    // Undefined.
    const r = newEngine().infer(`
      // hasDefault :: { Default :: Function | Undefined } -> Boolean
      const hasDefault = obj => typeof obj["Default"] === "function";
      hasDefault({});
    `);
    expect(r.diagnostics.filter(d => /Missing required field/i.test(d.message))).toEqual([]);
  });

  test('field whose declared type does NOT accept Undefined is still required', () => {
    const r = newEngine().infer(`
      // needsDefault :: { Default :: Function } -> Boolean
      const needsDefault = obj => typeof obj["Default"] === "function";
      needsDefault({});
    `);
    const missing = r.diagnostics.filter(d => /Missing required field/i.test(d.message));
    expect(missing.length).toBeGreaterThanOrEqual(1);
    expect(missing[0].message).toContain("'Default'");
  });
});
