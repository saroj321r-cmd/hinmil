// A recursive alias inside a union.
//
// `Node :: String | Number | Null | Undefined | [Node]` (what a UI library
// renders: text, a number, nothing, or a list of those, nested) keeps the
// inner `Node` as a name to break the cycle.  Unify has no alias table, so
// `[Node]` never matched `[String]`: every list of children was rejected.
// The engine now lets unify expand a bare alias name when it would
// otherwise fail.

import { diags } from '../helpers/infer';

const NODE = `
// Node :: String | Number | Null | Undefined | [Node]

// render :: Node -> String
const render = node => (Array.isArray (node) ? node.map (render).join ("") : String (node));
`;

describe('a recursive alias', () => {
  test('accepts a list and nested lists', () => {
    expect(diags(NODE + `
// title :: String
const title = render (["Wedstrijden ", 12]);

// table :: String
const table = render ([["thuis", ["uit", null]], 3]);
`)).toEqual([]);
  });

  test('rejects a member that is not a Node', () => {
    expect(diags(NODE + `
// flags :: String
const flags = render ([true, false]);
`).length).toBeGreaterThan(0);
  });

  test('a non-recursive alias still has to match', () => {
    expect(diags(`
// Cell :: String | Number

// show :: Cell -> String
const show = c => String (c);

// bad :: String
const bad = show (true);
`).length).toBeGreaterThan(0);
  });
});
