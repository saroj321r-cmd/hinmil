// A returned union must fit the declared union, member by member.
//
// `b ? "ja" : b ? 2 : null` against `String | Null` returns
// `Null | Number | String`.  The symmetric unifier accepts two unions as
// soon as one contains the other, so the stray `Number` passed.  A
// non-nested `b ? 2 : null` was already rejected (neither union contains
// the other).

import { diags } from '../helpers/infer';

describe('a returned union against a declared union', () => {
  test('a nested ternary with a stray member is rejected', () => {
    expect(diags(`
// statusLabel :: Boolean -> String | Null
const statusLabel = settled => settled ? "afgerekend" : settled ? 2 : null;
`)).toEqual([
      "Type mismatch: 'statusLabel' has type 'Boolean -> Null | Number | String' but annotation expects 'Boolean -> Null | String'",
    ]);
  });

  test('also with return statements in a block', () => {
    expect(diags(`
// statusLabel :: Boolean -> String | Null
const statusLabel = settled => {
  if (settled) return "afgerekend";
  return settled ? 2 : null;
};
`).length).toBeGreaterThan(0);
  });

  test('a returned union inside the declared union is fine', () => {
    expect(diags(`
// statusLabel :: Number -> String | Number | Null
const statusLabel = n => n > 1 ? "veel" : n > 0 ? 1 : null;

// shortLabel :: Boolean -> String | Null
const shortLabel = settled => settled ? "afgerekend" : settled ? "open" : null;
`)).toEqual([]);
  });

  test('a type variable in the declared union accepts any member', () => {
    expect(diags(`
// orNull :: Boolean -> a -> a | Null
const orNull = keep => x => keep ? x : null;
`)).toEqual([]);
  });
});
