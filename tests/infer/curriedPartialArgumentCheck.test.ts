// A function built with `curry (…)` checks the argument of a one-argument
// application like any other call.  The single-argument path unified the
// callee with a fresh `slot -> result` and then compared the argument with
// that slot: still a type variable, so the lenient auto-union widened it to
// `Number | String` instead of reporting the String — `curriedTotal ("2")`
// passed silently, while `curriedTotal ("2", 50)` and a hand-curried
// `plus ("2")` were reported.

import { diags } from '../helpers/infer';

const KIT = `
// curry :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curry = fn => {
  const collect = (...args) => args.length >= fn.length ? fn (...args) : (...next) => collect (...args, ...next);
  return collect;
};

// lineTotal :: (Number, Number) -> Number
const lineTotal = (quantity, unitPrice) => quantity * unitPrice;

const curriedTotal = curry (lineTotal);
`;

describe('one-argument application of a curry (…) result', () => {
  test('a wrong first argument is reported', () => {
    expect(diags(KIT + `
const forTwo = curriedTotal ("2");
`)).toEqual([expect.stringMatching(/String.*Number|Number.*String/)]);
    expect(diags(KIT + `
curriedTotal ("2") (1250);
`)).toEqual([expect.stringMatching(/String.*Number|Number.*String/)]);
  });

  test('right arguments in every grouping stay fine', () => {
    expect(diags(KIT + `
const a = curriedTotal (2) (1250);
const b = curriedTotal (2, 1250);
const forTwo = curriedTotal (2);
const c = forTwo (1250);
`)).toEqual([]);
  });

  test('a polymorphic curried function still takes any argument', () => {
    expect(diags(`
// curry :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curry = fn => {
  const collect = (...args) => args.length >= fn.length ? fn (...args) : (...next) => collect (...args, ...next);
  return collect;
};

// pairWith :: (a, b) -> [a, b]
const pairWith = (x, y) => [x, y];

const curriedPair = curry (pairWith);
const label = curriedPair ("total");
const count = curriedPair (3);
`)).toEqual([]);
  });
});
