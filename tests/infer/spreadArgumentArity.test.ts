// A spread argument supplies an unknown number of values, so it may fill
// every remaining parameter.  Modeled on fpkit's `more/curry.js`, which passes
// surplus arguments through:
//
//   // curriedA :: … ; fn :: (a, b, c) -> z
//   default: return fn (a, ...ys);
//
// Previously the spread counted as exactly ONE argument and hinmil reported
// "Expected 3 arguments but got 2", then padded the "missing" slot with
// `Undefined`.  Positional arguments before the spread must still be checked,
// and calls without a spread keep their arity diagnostics.

import { InferenceEngine } from '../../src/infer';

const diags = (src: string) => new InferenceEngine().infer(src).diagnostics.map(d => d.message);

const ADD3 = [
  '// add3 :: (Number, Number, Number) -> Number',
  'const add3 = (a, b, c) => a + b + c;',
  '// rest :: Array Number',
  'const rest = [2, 3];',
].join('\n');

describe('spread arguments and arity', () => {
  test('a spread after a positional argument may fill the remaining parameters (fpkit curry pass-through)', () => {
    expect(diags(`${ADD3}\nconst total = add3 (1, ...rest);`)).toEqual([]);
  });

  test('positional arguments before the spread are still type-checked', () => {
    expect(diags(`${ADD3}\nconst total = add3 ("1", ...rest);`))
      .toEqual([expect.stringMatching(/Cannot unify 'String' with 'Number'/)]);
  });

  test('without a spread, too few arguments is still reported', () => {
    expect(diags(`${ADD3}\nconst total = add3 (1);`))
      .toEqual([expect.stringMatching(/Expected 3 arguments but got 1/)]);
  });

  test('curry-style surplus pass-through inside a variadic closure', () => {
    const src = [
      '// curriedA :: ((a, b, c) -> z) -> a -> Array b -> z',
      'const curriedA = fn => a => ys => fn (a, ...ys);',
    ].join('\n');
    expect(diags(src)).toEqual([]);
  });
});
