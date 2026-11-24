// Narrowing after a guard that assigns: `if (x == null) x = make ();`.
//
// A lazily created value (a toaster, a connection) is filled in when it is
// still null; after the `if` it holds either its old non-null value or the
// new one.  Before, `x` stayed `T | Null` after the `if` ("Property 'then'
// does not exist on type 'Null'").  The value must be non-null itself and
// the assignment unconditional, at the top level of the branch.

import { diags } from '../helpers/infer';

const MAKE = `
// connect :: () -> Promise Error Number
const connect = () => Promise.resolve (1);

// maybeConnect :: Boolean -> Promise Error Number | Null
const maybeConnect = ok => ok ? connect () : null;
`;

describe('a guard that assigns', () => {
  test('x == null, x === null and !x, with or without a block', () => {
    expect(diags(MAKE + `
// connection :: Promise Error Number | Null
let connection = null;

// opened :: () -> Promise Error Number
const opened = () => {
  if (connection === null) connection = connect ();
  return connection;
};

// reopened :: Promise Error Number | Null -> Promise Error Number
const reopened = cached => {
  let p = cached;
  if (!p) {
    p = connect ();
  }
  return p.then (n => n + 1);
};
`)).toEqual([]);
  });

  test('a value that may be null does not narrow', () => {
    expect(diags(MAKE + `
// opened :: Promise Error Number | Null -> Promise Error Number
const opened = cached => {
  let p = cached;
  if (p == null) p = maybeConnect (true);
  return p;
};
`).length).toBeGreaterThan(0);
  });

  test('a conditional assignment does not narrow', () => {
    expect(diags(MAKE + `
// opened :: (Boolean, Promise Error Number | Null) -> Promise Error Number
const opened = (ok, cached) => {
  let p = cached;
  if (p == null) {
    if (ok) p = connect ();
  }
  return p;
};
`).length).toBeGreaterThan(0);
  });
});
