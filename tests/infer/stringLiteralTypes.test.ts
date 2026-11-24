// String-literal types in type position + literal-to-label promotion in unions.
//
// Background
// ----------
// As of this change, a quoted string in type position parses as a TLabelLit
// (a singleton string-literal type), not as the wide `String` type.  This
// enables per-key validation patterns like:
//
//     Selector :: 'id' | 'name' | Prop t a | QueryTag a | ...
//     Foo      :: [Selector] -> QueryTag b
//
// where a JS call `Foo(["id"])` succeeds and `Foo(["naame"])` is rejected.
//
// `inferLiteral` promotes a JS string-literal expression to its matching
// TLabelLit when the expected position is either a TLabel directly OR a
// Union containing a matching TLabelLit member.  TLabelLit remains
// silently unify-compatible with the wide `String` (so existing single-
// literal callsites still type-check).

import { parseType, parseTypeSignature } from '../../src/hm/typeParser';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';
import { InferenceEngine } from '../../src/infer';

beforeEach(() => {
  resetTypeVarCounter();
});

describe('parser — string-literal types', () => {
  test("'foo' parses as label-literal", () => {
    const t = parseType("'foo'");
    expect(t.tag).toBe('TLabel');
    if (t.tag === 'TLabel') {
      expect(t.kind).toBe('lit');
      if (t.kind === 'lit') expect(t.value).toBe('foo');
    }
    expect(typeToString(t)).toBe("'foo'");
  });

  test('union of string literals parses and pretty-prints', () => {
    const t = parseType("'id' | 'name' | 'createdAt'");
    expect(typeToString(t)).toContain("'id'");
    expect(typeToString(t)).toContain("'name'");
    expect(typeToString(t)).toContain("'createdAt'");
  });

  test('mixed union: string literals + record/Prop type', () => {
    const t = parseType("'id' | 'name' | Prop a");
    const s = typeToString(t);
    expect(s).toContain("'id'");
    expect(s).toContain("'name'");
    expect(s).toContain('Prop');
  });
});

describe('inference — literal-to-label promotion in array elements', () => {
  test('matching string literal accepted in selector union', () => {
    const src = `
// Foo :: ['id' | 'name' | 'created'] -> Boolean
const Foo = (xs) => true;
const r = Foo(["id", "name"]);
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('non-matching string literal is rejected', () => {
    const src = `
// Foo :: ['id' | 'name'] -> Boolean
const Foo = (xs) => true;
const r = Foo(["naame"]);
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('string literal in mixed-type selector union (sqlkit-style)', () => {
    const src = `
// Foo :: ['id' | 'name' | Number] -> Boolean
const Foo = (xs) => true;
const r = Foo(["id", 42, "name"]);
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('a const bound to a listed literal is accepted in a literal list', () => {
    const src = `
// Foo :: ['id' | 'name'] -> Boolean
const Foo = (xs) => true;
const k = "id";
const r = Foo([k]);
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('a plain String is rejected in a literal list (argument direction)', () => {
    // A label may be used as a String, but not every String is one of the
    // listed labels.  The argument check of a call is directional.
    const src = `
// Foo :: ['id' | 'name'] -> Boolean
const Foo = (xs) => true;
// pick :: String -> Boolean
const pick = column => Foo([column]);
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics.some(d => d.message.includes("'String' does not fit"))).toBe(true);
  });

  test('singleton literal type accepts matching literal, rejects others', () => {
    const src = `
// greet :: 'hello' -> String
const greet = (msg) => msg;
const a = greet("hello");
const b = greet("world");
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    // 'hello' matches → no diagnostic; 'world' is a different singleton
    // and DOES get a diagnostic (the new strict semantics).
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].message).toContain("'world'");
  });

  test('a plain String is rejected in a singleton position', () => {
    // A String may hold any text, so it does not fit the singleton
    // 'hello' (the argument check of a call is directional).
    const src = `
// greet :: 'hello' -> String
const greet = (msg) => msg;
// welcome :: String -> String
const welcome = text => greet(text);
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    expect(r.diagnostics.some(d => d.message.includes("'String' does not fit"))).toBe(true);
  });
});
