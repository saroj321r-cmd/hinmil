// The direction of an argument also for `curry (…)` calls with one argument
// and for the fields of an object literal (and so JSX props).
//
//  - a `curry`-made function called with one argument used the symmetric
//    unifier: a `Number | Null` argument passed for `Number`;
//  - the fields of an object-literal argument were not checked by
//    direction: `{ intent: level }` with `level :: String` passed for
//    `intent :: Intent`;
//  - a nested ternary of literals (`a ? "x" : b ? "y" : "z"`) now meets an
//    expected literal union with its literals, like a flat one.

import { diags } from '../helpers/infer';

const KIT = `
// Intent :: "none" | "primary" | "success" | "warning" | "danger"
// TagProps :: { intent :: Intent | Undefined, label :: String }

// Tag :: TagProps -> ReactElement
const Tag = ({ label }) => <span>{label}</span>;
`;

describe('directional fields', () => {
  test('a String field for a literal union is rejected, also as a JSX prop', () => {
    expect(diags(KIT + `
// Badge :: { level :: String } -> ReactElement
const Badge = ({ level }) => <Tag intent={level} label="x" />;
`).some(m => m.includes("in field 'intent'") && m.includes("'String' does not fit"))).toBe(true);
  });

  test('a nullable field for a non-null one is rejected', () => {
    expect(diags(`
// Row :: { home :: Number, away :: Number }
// keep :: Row -> Number
const keep = row => row.home;
// fromSource :: Number | Null -> Number
const fromSource = home => keep ({ home, away: 1 });
`).some(m => m.includes("in field 'home'") && m.includes("'Null' does not fit"))).toBe(true);
  });

  test('listed literals, nested ternaries and narrowed values are fine', () => {
    expect(diags(KIT + `
// Status :: { status :: String } -> ReactElement
const Status = ({ status }) => <Tag intent={status === "ok" ? "success" : status === "fail" ? "danger" : "primary"} label={status} />;

// Plain :: () -> ReactElement
const Plain = () => <Tag intent="warning" label="let op" />;

// Row :: { home :: Number, away :: Number }
// keep :: Row -> Number
const keep = row => row.home;
// fromSource :: Number | Null -> Number
const fromSource = home => home == null ? 0 : keep ({ home, away: 1 });
`)).toEqual([]);
  });
});

test('a nested ternary of literals is a listed literal, also as an argument', () => {
  expect(diags(KIT + `
// paint :: Intent -> String
const paint = intent => intent;

// verdict :: String -> String
const verdict = status => paint (status === "ok" ? "success" : status === "fail" ? "danger" : "primary");
`)).toEqual([]);
});

describe('a curry-made function with one argument', () => {
  const CURRY = `
// curry :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curry = f => (...xs) => f (...xs);

// add :: (Number, Number) -> Number
const add = (a, b) => a + b;

const addTo = curry (add);
`;

  test('a nullable argument is rejected', () => {
    expect(diags(CURRY + `
// shift :: Number | Null -> Number -> Number
const shift = n => addTo (n);
`).some(m => m.includes("'Null' does not fit"))).toBe(true);
  });

  test('a plain argument is fine', () => {
    expect(diags(CURRY + `
// shift :: Number -> Number -> Number
const shift = n => addTo (n);
`)).toEqual([]);
  });
});
