// A fresh row variable gets an internal name with its id (`r246`).  Hovers
// and messages show it as `r` (then `r1`, `r2`, …), the way type variables
// get letters; a row the user named (`...rest`) keeps its name.  Before, a
// Ramda pipeline hovered as `[{ total :: Number, paid :: Boolean, ...r246 }] -> Number`.

import { prettyTypeToString, tFun, tNumber, tString, tBool, tArray, tOpenRecord, tRow } from '../../src/hm/types';
import { TempProject } from '../helpers/project';

describe('fresh rows in printed types', () => {
  test('one fresh row is shown as r', () => {
    const order = tOpenRecord({ total: tNumber, paid: tBool }, tRow());
    expect(prettyTypeToString(tFun(tArray(order), tNumber)))
      .toBe('[{ total :: Number, paid :: Boolean, ...r }] -> Number');
  });

  test('two fresh rows are r and r1', () => {
    const customer = tOpenRecord({ name: tString }, tRow());
    const order = tOpenRecord({ total: tNumber }, tRow());
    expect(prettyTypeToString(tFun(customer, order)))
      .toBe('{ name :: String, ...r } -> { total :: Number, ...r1 }');
  });

  test('a row named by the user keeps its name', () => {
    const order = tOpenRecord({ total: tNumber }, tRow('rest'));
    expect(prettyTypeToString(tFun(order, tNumber))).toBe('{ total :: Number, ...rest } -> Number');
  });

  test('a fresh row does not take the name of a user row', () => {
    const customer = tOpenRecord({ name: tString }, tRow('r'));
    const order = tOpenRecord({ total: tNumber }, tRow());
    expect(prettyTypeToString(tFun(customer, order)))
      .toBe('{ name :: String, ...r } -> { total :: Number, ...r1 }');
  });
});

describe('a pipeline over records with a curried library', () => {
  const project = new TempProject('fresh-row-names');
  beforeAll(() => {
    project.setup();
    project.write('node_modules/fnkit/package.json', JSON.stringify({
      name: 'fnkit', main: 'index.js', hinmil: { sidecars: ['./fnkit.hm'] },
    }));
    project.write('node_modules/fnkit/index.js', 'module.exports = {};\n');
    project.write('node_modules/fnkit/fnkit.hm', [
      'pipe :: ((a -> b), (b -> c), ..., (y -> z)) -> a -> z',
      '::curried',
      'filter :: (a -> t) -> [a] -> [a]',
      '::curried',
      'map :: (a -> b) -> [a] -> [b]',
      '::curried',
      'prop :: k -> { [k] :: a, ...r } -> a',
      '::curried',
      'propEq :: a -> k -> { [k] :: a, ...r } -> Boolean',
      'sum :: [Number] -> Number',
      '',
    ].join('\n'));
  });
  afterAll(() => project.cleanup());

  test('the merged row of two field accessors is shown as r in a message', () => {
    const r = project.inferSource('report.js', `
import { pipe, filter, map, prop, propEq, sum } from "fnkit";
const outstanding = pipe (filter (propEq (false, "paid")), map (prop ("total")), sum);
const wrong = outstanding (42);
`);
    expect(r.diagnostics.filter(d => d.severity !== 3).map(d => d.message)).toEqual([
      "Type mismatch: Cannot unify 'Number' with '[{ total :: Number, paid :: Boolean, ...r }]'",
    ]);
  });
});
