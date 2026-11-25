// Reading a field of an open record whose row is still free adds the field
// to the row, as row-polymorphic inference does.  The common case: a
// library function `prop :: k -> { [k] :: a, ...r } -> a` combined with a
// callback before any data is known (`both (prop ("paid"), o => o.total > 10)`):
// the callback's parameter is `{ paid :: Boolean, ...r }`, and `o.total`
// extends it.  It used to be "Property 'total' does not exist".
//
// A parameter checked against its OWN annotation keeps a rigid row: there
// a field outside the annotation is still an error.

import { InferenceEngine } from '../../src/infer';
import { typeToString } from '../../src/hm/types';

function check(source: string) {
  const r = new InferenceEngine().infer(source);
  return {
    errors: r.diagnostics.filter(d => d.severity !== 3 && d.severity !== 4).map(d => d.message),
    typeOf: (name: string) => {
      const s = r.topLevelBindings.get(name);
      return s ? typeToString(r.substitution.apply(s.type)) : undefined;
    },
  };
}

const PRELUDE = `
// prop :: k -> { [k] :: a, ...r } -> a
const prop = key => record => record[key];

// both :: (a -> Boolean) -> (a -> Boolean) -> a -> Boolean
const both = f => g => x => f (x) && g (x);
`;

describe('a free row gains the fields that are read', () => {
  test('a callback next to a field accessor', () => {
    const r = check(`${PRELUDE}
const bigAndPaid = both (prop ("paid")) (order => order.total > 100);
const ok = bigAndPaid ({ id: "o1", paid: true, total: 250 });
`);
    expect(r.errors).toEqual([]);
    expect(r.typeOf('bigAndPaid')).toBe('{ total :: Number, paid :: Boolean, ...r } -> Boolean');
  });

  test('the added field is checked at the call', () => {
    const r = check(`${PRELUDE}
const bigAndPaid = both (prop ("paid")) (order => order.total > 100);
const wrong = bigAndPaid ({ id: "o1", paid: true, total: "250" });
`);
    expect(r.errors).toEqual(["Type mismatch: Cannot unify 'String' with 'Number'"]);
  });
});

describe("a row from the function's own annotation stays rigid", () => {
  test('an arrow function', () => {
    const r = check(`
// label :: { name :: String, ...r } -> String
const label = (person) => person.title;
`);
    expect(r.errors).toEqual(["Property 'title' does not exist on type '{ name :: String, ...r }'"]);
  });

  test('a function declaration', () => {
    const r = check(`
// label :: { name :: String, ...r } -> String
function label (person) { return person.title; }
`);
    expect(r.errors).toEqual(["Property 'title' does not exist on type '{ name :: String, ...r }'"]);
  });

  test('an inner callback inside the annotated function', () => {
    const r = check(`
// titles :: [{ name :: String, ...r }] -> [String]
const titles = (people) => people.map (person => person.title);
`);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test('a field of the annotation is fine', () => {
    const r = check(`
// label :: { name :: String, ...r } -> String
const label = (person) => person.name;
const ada = label ({ name: "Ada", born: 1815 });
`);
    expect(r.errors).toEqual([]);
  });
});
