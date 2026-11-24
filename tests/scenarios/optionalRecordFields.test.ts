// A record field typed `T | Undefined` may be left out of an object literal.
//
// Reading an absent property gives `undefined`, so an object literal that
// leaves such a field out has the declared type.  Arguments already
// followed that rule (`findMissingRecordFields`); an annotated `const`
// and an annotated return did not: `// changes :: Patch` on
// `const changes = {}` gave HM1008 "Missing record fields" for every
// optional field of the patch that is filled in step by step.

import { diags } from '../helpers/infer';

const PATCH = `
// FixturePatch :: { homeScore :: Number | Null | Undefined, awayScore :: Number | Null | Undefined, timePrecision :: String | Undefined }
`;

describe('optional record fields in object literals', () => {
  test('an empty patch that is filled step by step', () => {
    expect(diags(PATCH + `
// changesOf :: Number | Null -> FixturePatch
const changesOf = score => {
  // changes :: FixturePatch
  const changes = {};
  if (score != null) {
    changes.homeScore = score;
    changes.awayScore = score;
  }
  return changes;
};
`)).toEqual([]);
  });

  test('a returned literal without the optional fields', () => {
    expect(diags(PATCH + `
// timeOnly :: String -> FixturePatch
const timeOnly = precision => ({ timePrecision: precision });
`)).toEqual([]);
  });

  test('a required field is still required', () => {
    expect(diags(`
// Kickoff :: { date :: String, time :: String | Undefined }

// kickoffOf :: String -> Kickoff
const kickoffOf = time => ({ time });
`)).toEqual([
      "Missing record fields: 'date' required by Kickoff",
    ]);
  });

  test('a required field of an annotated const is still required', () => {
    expect(diags(`
// Kickoff :: { date :: String, time :: String | Undefined }

// noon :: Kickoff
const noon = { time: "12:00" };
`).some((d) => d.includes("'date'"))).toBe(true);
  });
});
