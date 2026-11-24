// A call argument must fit its parameter, in that direction.
//
// The unifier is symmetric: it accepted a union argument as soon as ONE of
// its members fit (`Periods | Null` for `Periods`), and a plain `String`
// where a literal union is expected (`intent :: "none" | "danger"`),
// because a label and a string are interchangeable to it.  Every member of
// the argument now has to fit a member of the parameter, and a String fits
// a literal only when it is a `const` bound to that literal.  Type
// variables, overload sets and values with several faces (a table that is
// also callable) are not checked.

import { diags } from '../helpers/infer';

const KIT = `
// Intent :: "none" | "primary" | "success" | "warning" | "danger"
// Periods :: { from :: String, to :: String }

// paint :: Intent -> String
const paint = intent => intent;

// lengthOf :: Periods -> Number
const lengthOf = p => p.to.length;

// pick :: ['id' | 'name'] -> Number
const pick = columns => columns.length;
`;

describe('the direction of a call argument', () => {
  test('a nullable argument for a non-null parameter is rejected', () => {
    expect(diags(KIT + `
// span :: Periods | Null -> Number
const span = periods => lengthOf (periods);
`)).toEqual([
      "Type mismatch: Cannot unify 'Null | Periods' with 'Periods' ('Null' does not fit)",
    ]);
  });

  test('a narrowed argument is fine', () => {
    expect(diags(KIT + `
// span :: Periods | Null -> Number
const span = periods => periods == null ? 0 : lengthOf (periods);
`)).toEqual([]);
  });

  test('a wider union for a narrower union parameter is rejected', () => {
    expect(diags(`
// limitOf :: Number | Undefined -> Number
const limitOf = n => n == null ? 100 : n;

// fromQuery :: Number | Null | Undefined -> Number
const fromQuery = n => limitOf (n);
`).some(m => m.includes("'Null' does not fit"))).toBe(true);
  });

  test('a String for a literal union is rejected, a listed literal or const is fine', () => {
    expect(diags(KIT + `
// danger :: String
const danger = paint ("danger");

const level = "warning";
// warned :: String
const warned = paint (level);

// count :: Number
const count = pick (["id", level === "x" ? "id" : "name"]);

// verdict :: Boolean -> String
const verdict = ok => paint (ok ? "success" : "danger");
`)).toEqual([]);
    expect(diags(KIT + `
// paintAny :: String -> String
const paintAny = s => paint (s);
`).some(m => m.includes("'String' does not fit"))).toBe(true);
    expect(diags(KIT + `
// pickAny :: String -> Number
const pickAny = column => pick ([column]);
`).some(m => m.includes("'String' does not fit"))).toBe(true);
  });

  test('type variables are not checked', () => {
    expect(diags(`
// orElse :: a -> a | Null -> a
const orElse = d => v => (v == null ? d : v);

// firstOr :: [Number] -> Number | Null -> Number
const firstOr = xs => n => orElse (xs.length) (n);
`)).toEqual([]);
  });
});
