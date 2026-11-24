// A guard clause inside a loop body narrows the rest of the body, as it
// does in a function body: after `if (a == null || b == null) continue;`
// both are present.  Before, only a function body's statements were
// narrowed after a guard; a `for`/`while` body (a nested block) was not.

import { diags } from '../helpers/infer';

const DAYS = `
// Fixture :: { id :: Number, home :: Number, away :: Number, day :: Number }
`;

describe('guard clauses in loop bodies', () => {
  test('continue after a null check', () => {
    expect(diags(DAYS + `
// sharedDays :: (Map Number (Set Number), [Number], [Number]) -> Number
const sharedDays = (daysOf, left, right) => {
  let shared = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = daysOf.get (left[i]);
    const b = daysOf.get (right[i]);
    if (a == null || b == null) continue;
    a.forEach (day => {
      if (b.has (day)) shared += 1;
    });
  }
  return shared;
};
`)).toEqual([]);
  });

  test('break and throw leave the block too', () => {
    expect(diags(DAYS + `
// firstHome :: (Map Number Fixture, [Number]) -> Number
const firstHome = (byId, ids) => {
  let home = -1;
  for (const id of ids) {
    const fixture = byId.get (id);
    if (!fixture) break;
    home = fixture.home;
  }
  while (home < 0) {
    const fixture = byId.get (home);
    if (fixture == null) throw new Error ("no fixture");
    home = fixture.away;
  }
  return home;
};
`)).toEqual([]);
  });

  test('without the guard the miss is still reported', () => {
    const errors = diags(DAYS + `
// firstHome :: (Map Number Fixture, [Number]) -> Number
const firstHome = (byId, ids) => {
  let home = -1;
  for (const id of ids) {
    const fixture = byId.get (id);
    home = fixture.home;
  }
  return home;
};
`);
    expect(errors.length).toBeGreaterThan(0);
  });
});
