// A namespace import (`import * as list from "./list"`) keeps every export
// polymorphic, exactly like a named import.  The namespace used to be a
// record of types instantiated once at the import, so the first use of
// `list.first` fixed its type: `list.first (prices)` followed by
// `list.first (names)` was "Cannot unify 'String' with 'Number'".

import { TempProject } from '../helpers/project';
import { typeToString } from '../../src/hm/types';

const project = new TempProject('namespace-import-polymorphism');

beforeAll(() => {
  project.setup();
  project.write('list.js', `
// first :: [a] -> a | Undefined
export const first = xs => xs[0];

// pluck :: k -> [{ [k] :: a }] -> [a]
export const pluck = key => rows => rows.map(row => row[key]);
`);
  project.write('node_modules/text-tools/package.json', JSON.stringify({
    name: 'text-tools', main: 'index.js', hinmil: { sidecars: ['./text-tools.hm'] },
  }));
  project.write('node_modules/text-tools/index.js', `
exports.surround = (left, right) => value => left + value + right;
exports.identity = value => value;
`);
  project.write('node_modules/text-tools/text-tools.hm', `
surround :: (String, String) -> a -> String
identity :: a -> a
`);
});
afterAll(() => project.cleanup());

function check(source: string) {
  const r = project.inferSource('report.js', source);
  return {
    errors: r.diagnostics.filter(d => d.severity !== 3).map(d => d.message),
    typeOf: (name: string) => {
      const s = r.topLevelBindings.get(name);
      return s ? typeToString(r.substitution.apply(s.type)) : undefined;
    },
  };
}

describe('namespace imports keep exports polymorphic', () => {
  test('a local module: one function used at two types', () => {
    const r = check(`
import * as list from "./list";

const prices = [12.5, 9.95];
const names = ["Ada", "Alan"];
const cheapest = list.first (prices);
const firstName = list.first (names);
`);
    expect(r.errors).toEqual([]);
    expect(r.typeOf('cheapest')).toBe('Number | Undefined');
    expect(r.typeOf('firstName')).toBe('String | Undefined');
  });

  test('a curried function: each use binds its own type variables', () => {
    const r = check(`
import * as list from "./list";

const orders = [{ id: 1, total: 20 }, { id: 2, total: 35 }];
const ids = list.pluck ("id") (orders);
const labels = list.pluck ("label") ([{ label: "open" }]);
`);
    expect(r.errors).toEqual([]);
    expect(r.typeOf('ids')).toBe('[Number]');
    expect(r.typeOf('labels')).toBe('[String]');
  });

  test('a package with a sidecar', () => {
    const r = check(`
import * as text from "text-tools";

const count = text.identity (3);
const title = text.identity ("Invoice");
const quoted = text.surround ("«", "»") (title);
`);
    expect(r.errors).toEqual([]);
    expect(r.typeOf('count')).toBe('Number');
    expect(r.typeOf('title')).toBe('String');
  });

  test('a wrong argument is still reported', () => {
    const r = check(`
import * as list from "./list";

const totals = list.pluck ("total") (42);
`);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
