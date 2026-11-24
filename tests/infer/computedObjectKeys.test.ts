// A computed key in an object literal (`{ [key]: value }`) is the VALUE of
// `key`, not the text "key".  Before, an identifier key was read by its
// name, so `Object.keys (totals).map (key => ({ [key]: 0 }))` gave
// `[{ key :: Number }]` and a record rebuilt per key failed against
// `{ [k] :: b }`.  A key with a literal type names that field, a label
// variable makes a label field, any other string is a key known only at
// runtime.

import { diags } from '../helpers/infer';

describe('computed keys in object literals', () => {
  test('a String key builds a dictionary, not a field named after the variable', () => {
    expect(diags(`
// zeroes :: Object String Number -> [Object String Number]
const zeroes = (totals) => Object.keys (totals).map (key => ({ [key]: 0 }));
`)).toEqual([]);
    const errors = diags(`
// labels :: Object String Number -> [Object String String]
const labels = (totals) => Object.keys (totals).map (key => ({ [key]: totals[key] }));
`);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('rebuilding a record per key with Object.assign', () => {
    expect(diags(`
// doubled :: Object String Number -> Object String Number
const doubled = (totals) => Object.keys (totals).reduce (
  (acc, key) => Object.assign ({}, acc, { [key]: totals[key] * 2 }), {});
`)).toEqual([]);
  });

  test('a key of a type not known yet (from destructuring) also builds a dictionary', () => {
    expect(diags(`
// datesBySlot :: [[String, String | Null]] -> Object String (String | Null)
const datesBySlot = (pairs) => pairs.reduce ((acc, [slot, date]) => Object.assign (acc, { [slot]: date }), {});
`)).toEqual([]);
  });

  test('the accumulator of a reduce takes the dictionary type', () => {
    expect(diags(`
// problemsOf :: Object String Any -> Object String [String]
const problemsOf = (payload) => {
  const required = { invoice: ["number", "total"] };
  const missing = required[payload.kind].filter (field => payload[field] == null);
  return missing.reduce ((acc, field) => Object.assign ({}, acc, { [field]: [field + " is required"] }), {});
};
`)).toEqual([]);
  });

  test('a label variable key makes a label field', () => {
    expect(diags(`
// single :: k -> a -> { [k] :: a }
const single = (key) => (value) => ({ [key]: value });

// invoice :: { number :: String }
const invoice = single ("number") ("2026-0042");
`)).toEqual([]);
  });

  test('a literal key names the field', () => {
    expect(diags(`
const field = "currency";

// price :: { currency :: String, cents :: Number }
const price = { [field]: "EUR", ["cents"]: 1250 };
`)).toEqual([]);
    const errors = diags(`
// price :: { currency :: Number }
const price = { ["currency"]: "EUR" };
`);
    expect(errors.length).toBeGreaterThan(0);
  });
});
