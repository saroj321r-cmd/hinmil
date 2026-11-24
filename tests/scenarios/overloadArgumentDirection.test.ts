// The direction of a call argument also decides between overloads.
//
// A plain `String` does not fit a union of string literals, and a union
// argument only fits when every member does — for an ordinary function and,
// equally, for each branch of an overloaded one.  Before, a branch trial
// unified symmetrically, so `sortRows (direction)` with `direction ::
// String` was accepted by the `'asc' | 'desc'` branch.  A branch whose
// parameter the argument does not fit now drops out; when no branch is left
// the call is reported, and another branch that does fit still wins.

import { diags } from '../helpers/infer';

const KIT = `
// SortDirection :: 'asc' | 'desc'
// Row :: { name :: String, total :: Number }

// sortRows :: SortDirection -> [Row] -> [Row]
// sortRows :: (SortDirection, String) -> [Row] -> [Row]
const sortRows = (...args) => (rows) => rows;

// formatCell :: Number | Null -> String
// formatCell :: Boolean -> String
const formatCell = (value) => String (value);

// paddingOf :: 'compact' | 'regular' -> Number
// paddingOf :: Number -> Number
const paddingOf = (size) => typeof size === 'number' ? size : size === 'compact' ? 4 : 8;
`;

const errorsOf = (source: string): string[] => diags(KIT + source);

describe('overload branches respect the direction of the argument', () => {
  test('a literal of the union picks the branch', () => {
    expect(errorsOf(`
// byNameAscending :: [Row] -> [Row]
const byNameAscending = sortRows ("asc");

// byColumn :: [Row] -> [Row]
const byColumn = sortRows ("desc", "total");
`)).toEqual([]);
  });

  test('a const bound to an allowed literal fits', () => {
    expect(errorsOf(`
const defaultDirection = "desc";

// newestFirst :: [Row] -> [Row]
const newestFirst = sortRows (defaultDirection);
`)).toEqual([]);
  });

  test('a plain String fits no branch with a literal union', () => {
    const errors = errorsOf(`
// fromQuery :: String -> [Row] -> [Row]
const fromQuery = (direction) => sortRows (direction);
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/No overload matches arguments \(String\)/);
  });

  test('a plain String in a multi-argument branch fits no branch either', () => {
    const errors = errorsOf(`
// fromQuery :: String -> [Row] -> [Row]
const fromQuery = (direction) => sortRows (direction, "name");
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/No overload matches/);
  });

  test('a narrowed String fits', () => {
    expect(errorsOf(`
// fromToggle :: Boolean -> [Row] -> [Row]
const fromToggle = (descending) => sortRows (descending ? "desc" : "asc");
`)).toEqual([]);
  });

  test('a union argument with a member outside every branch is rejected', () => {
    const errors = errorsOf(`
// cellOf :: Number | Undefined -> String
const cellOf = (value) => formatCell (value);
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/No overload matches/);
  });

  test('a union argument that fits one branch is accepted', () => {
    expect(errorsOf(`
// cellOf :: Number | Null -> String
const cellOf = (value) => formatCell (value);
`)).toEqual([]);
  });

  test('a String is not taken by the literal branch while another branch fits a Number', () => {
    expect(errorsOf(`
// paddingFor :: Number -> Number
const paddingFor = (width) => paddingOf (width);
`)).toEqual([]);
    const errors = errorsOf(`
// paddingFor :: String -> Number
const paddingFor = (size) => paddingOf (size);
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/No overload matches arguments \(String\)/);
  });
});

// A union argument whose members fit DIFFERENT branches is resolved per
// member, as it runs: a rule result that is either an outcome or a promise
// of one becomes a promise of an outcome.  Without this, the direction check
// would leave only the generic branch and the promise would wrap the whole
// union (`Promise e (Outcome | Promise e Outcome)`).
const RULES = `
// Outcome :: { ok :: Boolean, field :: String }
// RuleResult :: Outcome | Promise Error Outcome

// toPromise :: Promise e a -> Promise e a
// toPromise :: a -> Promise e a
const toPromise = (x) => x instanceof Promise ? x : Promise.resolve (x);
`;

describe('a union argument across overload branches', () => {
  test('each member takes its own branch and the results agree', () => {
    expect(diags(RULES + `
// passed :: RuleResult -> Promise Error Boolean
const passed = (result) => toPromise (result).then (outcome => outcome.ok);
`)).toEqual([]);
  });

  test('the common result is still checked', () => {
    const errors = diags(RULES + `
// fieldOf :: RuleResult -> Promise Error Number
const fieldOf = (result) => toPromise (result).then (outcome => outcome.field);
`);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('a member that fits no branch is still reported', () => {
    const errors = diags(KIT + `
// cellOf :: Number | Undefined -> String
const cellOf = (value) => formatCell (value);
`);
    expect(errors).toHaveLength(1);
  });
});
