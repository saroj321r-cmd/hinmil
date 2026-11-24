// More guards that narrow, and `concat` with a single value.
//
//  - `if (input.localTime == null) return …;` narrows the member after the
//    guard, as the ternary `input.localTime == null ? … : …` already did;
//  - `if (refit || model == null) { model = fit (…); }` leaves `model`
//    non-null: the branch runs whenever it was null and assigns it;
//  - `[].concat (x)` appends a list's elements or a single value.
// With the directional argument check these patterns were reported
// although the code is sound.

import { diags } from '../helpers/infer';

describe('guards and concat', () => {
  test('a guard clause on a member narrows the member', () => {
    expect(diags(`
// parseLocal :: String -> Number
const parseLocal = s => s.length;

// TimeInput :: { localTime :: String | Undefined, timezone :: String | Undefined }

// minutesOf :: TimeInput -> Number
const minutesOf = input => {
  if (input.localTime == null) return 0;
  return parseLocal (input.localTime);
};
`)).toEqual([]);
  });

  test('a guard that only checks another member does not narrow this one', () => {
    expect(diags(`
// parseLocal :: String -> Number
const parseLocal = s => s.length;

// TimeInput :: { localTime :: String | Undefined, timezone :: String | Undefined }

// minutesOf :: TimeInput -> Number
const minutesOf = input => {
  if (input.timezone == null) return 0;
  return parseLocal (input.localTime);
};
`).some(m => m.includes("'Undefined' does not fit"))).toBe(true);
  });

  test('a refit when stale or missing leaves the model non-null', () => {
    expect(diags(`
// Model :: { weight :: Number }

// fit :: [Number] -> Model
const fit = xs => ({ weight: xs.length });

// weightOf :: Model -> Number
const weightOf = m => m.weight;

// replay :: [[Number]] -> [Number]
const replay = weeks => {
  let model = null;
  return weeks.map ((week, i) => {
    if (i % 4 === 0 || model == null) {
      model = fit (week);
    }
    return weightOf (model);
  });
};
`)).toEqual([]);
  });

  test('concat takes a list or a single value', () => {
    expect(diags(`
// Action :: { type :: String }

// toList :: (Action | [Action]) -> [Action]
const toList = result => [].concat (result);

// more :: [Number] -> [Number]
const more = xs => xs.concat ([1, 2]).concat (3);
`)).toEqual([]);
  });
});
