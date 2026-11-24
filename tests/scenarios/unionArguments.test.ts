// A narrower union as the argument of a wider union parameter.
//
// Query parameters arrive as `Number | Undefined`; defaulting helpers
// accept `a | Null | Undefined`.  Unifying the two unions used to require
// the parameter's members to be a subset of the argument's, so the
// NARROWER argument was rejected ("Cannot unify 'Number | Undefined' with
// 'Null | Number | Undefined'") and a type variable in the parameter was
// never bound.  Now every argument member may meet a parameter member, and
// the bindings (`a := Number`) are kept.

import { diags } from '../helpers/infer';

const DEFAULTS = `
// valueOr :: a -> a | Null | Undefined -> a
const valueOr = fallback => value => (value == null ? fallback : value);
`;

describe('a narrower union argument', () => {
  test('fits a defaulting helper and binds its type variable', () => {
    expect(diags(DEFAULTS + `
// Page :: { limit :: Number, offset :: Number }

// pageOf :: { limit :: Number | Undefined, offset :: Number | Undefined, ...r } -> Page
const pageOf = q => ({ limit: valueOr (100) (q.limit), offset: valueOr (0) (q.offset) });
`)).toEqual([]);
  });

  test('the bound type flows into the result', () => {
    expect(diags(DEFAULTS + `
// titleOf :: { title :: String | Undefined } -> Number
const titleOf = q => valueOr ("untitled") (q.title);
`)).toEqual([
      "Type mismatch: Cannot unify 'String' with 'Number'",
      "Type mismatch: 'titleOf' has type '{ title :: String | Undefined } -> String' but annotation expects '{ title :: String | Undefined } -> Number'",
    ]);
  });

  test('fits a concrete wider union parameter', () => {
    expect(diags(`
// formatLimit :: Number | Null | Undefined -> String
const formatLimit = n => (n == null ? "all" : String (n));

// describe :: { limit :: Number | Undefined } -> String
const describe = q => formatLimit (q.limit);
`)).toEqual([]);
  });

  test('a member that fits nowhere is still rejected', () => {
    expect(diags(`
// formatLimit :: Number | Null | Undefined -> String
const formatLimit = n => (n == null ? "all" : String (n));

// describe :: { limit :: String | Undefined } -> String
const describe = q => formatLimit (q.limit);
`).length).toBeGreaterThan(0);
  });
});
