// Local `const`s with the same name in different functions each keep their
// own annotation.  The annotation map is keyed by name, so the second
// function's `// rate :: Number` was matched to the first declaration,
// failed the range check, and was then not found by declaration either
// (its key is the initializer's offset): the second binding was silently
// unannotated — no check of its value, and its inferred type flowed on.

import { diags } from '../helpers/infer';

describe('same-named local annotations in different functions', () => {
  test('each declaration is checked against its own annotation', () => {
    const errors = diags(`
// netOf :: Number -> Number
const netOf = (gross) => {
  // rate :: Number
  const rate = 0.21;
  return gross / (1 + rate);
};

// labelOf :: Number -> String
const labelOf = (gross) => {
  // rate :: Number
  const rate = "21%";
  return String (gross) + " incl. " + String (rate);
};
`);
    expect(errors).toEqual([expect.stringMatching(/'rate' has type 'String' but annotation expects 'Number'/)]);
  });

  test('the second binding gets its annotated type', () => {
    expect(diags(`
// Totals :: { net :: Number, vat :: Number }

// totalsOf :: Number -> Totals
const totalsOf = (gross) => {
  // totals :: Totals
  const totals = { net: gross / 1.21, vat: gross - gross / 1.21 };
  return totals;
};

// vatOf :: Number -> Number
const vatOf = (gross) => {
  // totals :: Totals
  const totals = totalsOf (gross);
  return totals.vat;
};
`)).toEqual([]);
  });
});
