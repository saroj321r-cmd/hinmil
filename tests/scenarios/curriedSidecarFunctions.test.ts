// `::curried` directly above a function in a `.hm` file: that function
// accepts its arguments in any grouping, as in a curried FP library (Ramda
// and its relatives): `map (f, xs)`, `map (f) (xs)`, also through a namespace
// import (`F.map (f, xs)`).  One `::curried` covers the overload lines of the
// name below it.  A placeholder argument of type `Placeholder`
// (`subtract (__, 10)`) leaves its parameter open.  Without the directive a
// curried signature `a -> b -> c` only accepts one argument per call, as a
// plain `a => b => c` does.

import { TempProject } from '../helpers/project';
import { typeToString } from '../../src/hm/types';

const project = new TempProject('curried-sidecar-functions');

beforeAll(() => {
  project.setup();
  project.write('node_modules/fnkit/package.json', JSON.stringify({
    name: 'fnkit', main: 'index.js', hinmil: { sidecars: ['./fnkit.hm'] },
  }));
  // The runtime is not what is checked here; only its exports matter.
  project.write('node_modules/fnkit/index.js', `
const __ = { "@@functional/placeholder": true };
const curry2 = fn => function curried (a, b) {
  if (arguments.length >= 2) return a === __ ? x => fn (x, b) : fn (a, b);
  return b2 => fn (a, b2);
};
exports.__ = __;
exports.tap = (fn, x) => { fn (x); return x; };
exports.map = curry2 ((fn, xs) => xs.map (fn));
exports.prop = curry2 ((key, obj) => obj[key]);
exports.subtract = curry2 ((a, b) => a - b);
exports.join = curry2 ((sep, xs) => xs.join (sep));
exports.concat = curry2 ((a, b) => a.concat (b));
exports.propEq = curry2 ((value, key) => obj => obj[key] === value);
exports.filter = curry2 ((pred, xs) => xs.filter (pred));
exports.pipe = (...fns) => x => fns.reduce ((acc, fn) => fn (acc), x);
exports.curry = fn => function curried (...args) { return args.length >= fn.length ? fn (...args) : (...more) => curried (...args, ...more); };
`);
  project.write('node_modules/fnkit/fnkit.hm', `
Placeholder :: Placeholder
__ :: Placeholder

// Not curried: no directive.
tap :: (a -> b) -> a -> a
pipe :: ((a -> b), (b -> c), ..., (y -> z)) -> a -> z
curry :: ((a, b, ...) -> z) -> a -> b -> ... -> z

::curried
map :: (a -> b) -> [a] -> [b]
::curried
prop :: k -> { [k] :: a, ...r } -> a
::curried
propEq :: a -> k -> { [k] :: a, ...r } -> Boolean
::curried
filter :: (a -> t) -> [a] -> [a]
::curried
subtract :: Number -> Number -> Number
::curried
join :: String -> [String] -> String
::curried
concat :: String -> String -> String
concat :: [a] -> [a] -> [a]
`);
});
afterAll(() => project.cleanup());

function check(source: string) {
  const r = project.inferSource('orders.js', source);
  return {
    errors: r.diagnostics.filter(d => d.severity !== 3).map(d => d.message),
    typeOf: (name: string) => {
      const s = r.topLevelBindings.get(name);
      return s ? typeToString(r.substitution.apply(s.type)) : undefined;
    },
  };
}

const ORDERS = `const orders = [{ id: 1, customer: "Ada", total: 20 }, { id: 2, customer: "Alan", total: 35 }];`;

describe('::curried — every grouping of the arguments', () => {
  test('all at once, one by one, and partially applied', () => {
    const r = check(`
import { map, prop, join } from "fnkit";
${ORDERS}
const totals = map (prop ("total"), orders);
const customers = map (prop ("customer")) (orders);
const customerOf = map (prop ("customer"));
const line = join (", ", customers);
`);
    expect(r.errors).toEqual([]);
    expect(r.typeOf('totals')).toBe('[Number]');
    expect(r.typeOf('customers')).toBe('[String]');
    expect(r.typeOf('line')).toBe('String');
  });

  test('partially applied steps in a pipeline', () => {
    const r = check(`
import { pipe, map, prop, join } from "fnkit";
${ORDERS}
const customerLine = pipe (map (prop ("customer")), join (", "));
const line = customerLine (orders);
const totalLine = pipe (map (prop ("total")), join (", "));
const broken = totalLine (orders);
`);
    expect(r.typeOf('line')).toBe('String');
    // totalLine needs records whose total is a String (join wants [String]);
    // the orders' totals are Numbers.
    expect(r.errors).toEqual(["Type mismatch: Cannot unify 'Number' with 'String'"]);
  });

  test('two field accessors inline in a pipeline', () => {
    // prop ("total") meets the record of propEq (…, "paid") before its own
    // key is known; the key must not be guessed as 'paid'.
    const r = check(`
import { pipe, filter, map, prop, propEq } from "fnkit";
const orders = [{ id: 1, total: 20, paid: true }, { id: 2, total: 35, paid: false }];
const unpaidTotals = pipe (filter (propEq (false, "paid")), map (prop ("total")));
const totals = unpaidTotals (orders);
`);
    expect(r.errors).toEqual([]);
    expect(r.typeOf('totals')).toBe('[Number]');
  });

  test('through a namespace import', () => {
    const r = check(`
import * as F from "fnkit";
${ORDERS}
const totals = F.map (F.prop ("total"), orders);
const customers = F.map (F.prop ("customer")) (orders);
`);
    expect(r.errors).toEqual([]);
    expect(r.typeOf('totals')).toBe('[Number]');
    expect(r.typeOf('customers')).toBe('[String]');
  });

  test('an overloaded curried function, in both forms', () => {
    const r = check(`
import { concat } from "fnkit";

const code = concat ("INV-", "2041");
const ids = concat ([1, 2]) ([3]);
`);
    expect(r.errors).toEqual([]);
    expect(r.typeOf('code')).toBe('String');
    expect(r.typeOf('ids')).toBe('[Number]');
  });

  test('a wrong argument in the uncurried form is reported', () => {
    const r = check(`
import { join } from "fnkit";

const line = join (", ", [1, 2, 3]);
`);
    // One report per element of the list literal.
    expect(r.errors.length).toBeGreaterThan(0);
    expect(new Set(r.errors)).toEqual(new Set(["Type mismatch: Cannot unify 'Number' with 'String'"]));
  });

  test('too many arguments are reported', () => {
    const r = check(`
import { subtract } from "fnkit";

const change = subtract (50, 20, 5);
`);
    expect(r.errors).toEqual(['Curried function called with 3 arguments, but only accepts up to 2']);
  });

  test('a function without the directive keeps its one-argument-per-call signature', () => {
    const r = check(`
import { tap } from "fnkit";

const logged = tap (value => value, 3);
`);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('placeholder', () => {
  test('a named and a namespaced placeholder leave the parameter open', () => {
    const r = check(`
import * as F from "fnkit";
import { subtract, __ } from "fnkit";

const lessDiscount = subtract (__, 10);
const lessFee = F.subtract (F.__, 2.5);
const net = lessDiscount (120);
`);
    expect(r.errors).toEqual([]);
    expect(r.typeOf('lessDiscount')).toBe('Number -> Number');
    expect(r.typeOf('lessFee')).toBe('Number -> Number');
    expect(r.typeOf('net')).toBe('Number');
  });

  test('the open parameter is still checked', () => {
    const r = check(`
import { subtract, __ } from "fnkit";

const lessDiscount = subtract (__, 10);
const net = lessDiscount ("120");
`);
    expect(r.errors).toEqual(["Type mismatch: Cannot unify 'String' with 'Number'"]);
  });

  test('an argument named __ that is not a placeholder is an ordinary argument', () => {
    const r = check(`
import { subtract } from "fnkit";

const __ = 100;
const change = subtract (__, 10);
`);
    expect(r.errors).toEqual([]);
    expect(r.typeOf('change')).toBe('Number');
  });
});

describe('::curried in the .hm file itself', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getHmDiagnostics } = require('../../src/services/hmFileServices');
  const messages = (source: string): string[] =>
    getHmDiagnostics('file:///project/fnkit.hm', source).map((d: { message: string }) => d.message);

  test('directly above a function of several arguments: no remark', () => {
    expect(messages('::curried\nadd :: Number -> Number -> Number\n')).toEqual([]);
  });

  test('above a function of one argument', () => {
    expect(messages('::curried\nnegate :: Number -> Number\n')).toEqual([
      "::curried has no effect: 'negate' is not a function of several arguments (a -> b -> c)",
    ]);
  });

  test('not directly above a declaration', () => {
    expect(messages('::curried\n\nadd :: Number -> Number -> Number\n')).toEqual([
      '::curried must stand directly above the declaration of a function',
    ]);
  });

  test('a function separated from the directive by a blank line is not curried', () => {
    project.write('node_modules/spaced/package.json', JSON.stringify({
      name: 'spaced', main: 'index.js', hinmil: { sidecars: ['./spaced.hm'] },
    }));
    project.write('node_modules/spaced/index.js', 'exports.add = a => b => a + b;\n');
    project.write('node_modules/spaced/spaced.hm', '::curried\n\nadd :: Number -> Number -> Number\n');
    const r = check(`
import { add } from "spaced";

const three = add (1, 2);
`);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('a curry helper declared in a .hm file', () => {
  test('an annotated function built with it accepts any grouping', () => {
    const r = check(`
import { curry } from "fnkit";

// discounted :: Number -> Number -> Number
const discounted = curry ((pct, price) => price * (1 - pct / 100));
const a = discounted (10, 250);
const b = discounted (10) (250);
`);
    expect(r.errors).toEqual([]);
    expect(r.typeOf('a')).toBe('Number');
    expect(r.typeOf('b')).toBe('Number');
  });

  test('also through a namespace import', () => {
    const r = check(`
import * as F from "fnkit";

// discounted :: Number -> Number -> Number
const discounted = F.curry ((pct, price) => price * (1 - pct / 100));
const a = discounted (10, 250);
`);
    expect(r.errors).toEqual([]);
    expect(r.typeOf('a')).toBe('Number');
  });

  test('an annotation that does not match the function is still reported', () => {
    const r = check(`
import { curry } from "fnkit";

// label :: Number -> Number -> Number
const label = curry ((pct, price) => price + " (-" + pct + "%)");
`);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test('a hand-written curried arrow is not curried à la Ramda', () => {
    const r = check(`
// discounted :: Number -> Number -> Number
const discounted = (pct) => (price) => price * (1 - pct / 100);
const a = discounted (10, 250);
`);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('::curried in a JavaScript file', () => {
  test('is reported: it only works in .hm files', () => {
    const r = project.inferSource('orders.js', `
// ::curried
// discounted :: Number -> Number -> Number
const discounted = (pct) => (price) => price * (1 - pct / 100);
`);
    const warnings = r.diagnostics.filter(d => d.severity === 2).map(d => d.message);
    expect(warnings).toEqual([expect.stringMatching(/^::curried only works in \.hm files\./)]);
  });
});
