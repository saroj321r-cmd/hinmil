// SqlKit query typing on the real sidecars (fixture: query-builder, the
// generated client).  Covers hinmil rules that are library-agnostic but are exercised here through sqlkit:
//  - a value-as-callable whose result carries the row WITHOUT an array
//    (`QueryOne() :: p -> Promise e (o | Null)`) gets the host's row
//    (`findTrailingTVarId` fallback in `findOverloadSlots`);
//  - a nested query contributes what calling it returns
//    (`nestedResultShape`): `[o]` → list relation, `o | Null` → single
//    (nullable) relation, a result without the row (`Boolean`) → no field;
//  - a project override (`hm-types/<pkg>.hm`) replaces the callable, e.g.
//    to make queries return a task instead of a Promise.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'scenarios', 'query-builder');
const ROOT = '/tmp/hm-scenarios-query-builder';

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const target = path.join(to, entry.name === '_node_modules' ? 'node_modules' : entry.name);
    if (entry.isDirectory()) copyTree(path.join(from, entry.name), target);
    else fs.copyFileSync(path.join(from, entry.name), target);
  }
}

function lintIn(root: string, name: string, body: string): string[] {
  const rel = `src/${name}.js`;
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
  let stdout = '';
  runCli([rel], { cwd: root, stdout: (t) => { stdout += t; }, stderr: () => {} });
  return stdout.split('\n')
    .filter((l) => / error /.test(l))
    .map((l) => l.replace(/^\S+?:(\d+):\d+ error /, '$1 '));
}

const DB = `import SqlKit from "sqlkit";

const { tables } = SqlKit ({ querier: (_q, _v) => Promise.resolve ([]) });

const { Departments } = tables.core;
const { Events } = tables.events;
`;

const lint = (name: string, body: string) => lintIn(ROOT, name, DB + body);

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  copyTree(FIXTURE, ROOT);
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "query-builder" }');
});

describe('root queries', () => {
  test('one: the projected row or null', () => {
    const body = (use: string) => `const { id } = Departments.props;
const byId = Departments.one (["id", "name", id.eq (p => p.departmentId)], false);

// departmentName :: Number -> Promise Error String
export const departmentName = departmentId => byId ({ departmentId }).then (department => ${use});
`;
    expect(lint('one', body('department == null ? "" : department.name'))).toEqual([]);
    // Null must be handled; `countryId` was not selected.
    expect(lint('oneNull', body('department.name')).join('\n')).toMatch(/HM1005 .*Null/);
    expect(lint('oneUnselected', body('department == null ? "" : department.countryId'))).toEqual([
      expect.stringMatching(/^11 HM1005 .*countryId/),
    ]);
  });

  test('exists: a Boolean, with the selectors\' params', () => {
    expect(lint('exists', `const { id } = Departments.props;
const known = Departments.exists ([id.eq (p => p.departmentId)]);

// isKnown :: Number -> Promise Error Boolean
export const isKnown = departmentId => known ({ departmentId });
`)).toEqual([]);
    expect(lint('existsParams', `const { id } = Departments.props;
const known = Departments.exists ([id.eq (p => p.departmentId)]);

export const isKnown = known ({ department: 1 });
`).join('\n')).toMatch(/HM1008 .*departmentId/);
  });

  test('insert carries the table row', () => {
    expect(lint('insert', `const insertDepartment = Departments.insert ([]);

// newId :: String -> Promise Error Number
export const newId = name => insertDepartment ({ data: [{ name }] }).then (rows => rows[0].id);

// typo :: String -> Promise Error Number
export const typo = name => insertDepartment ({ data: [{ name }] }).then (rows => rows[0].idd);
`)).toEqual([expect.stringMatching(/^13 HM1005 .*idd/)]);
  });
});

describe('nested queries contribute what calling them returns', () => {
  const shape = (selector: string, use: string) => `const query = Departments (["id", ${selector}]);

// use :: Number -> Promise Error Any
export const use = n => query ({}).then (departments => ${use});
`;

  test('a plain relation is a list', () => {
    expect(lint('nestedList', shape('Events (["id"])', 'departments[0].events.length'))).toEqual([]);
  });

  test('one is a single, nullable relation', () => {
    expect(lint('nestedOne', shape('Events.one (["id"], false)',
      '{ const fixture = departments[0].events; return fixture == null ? 0 : fixture.id; }'))).toEqual([]);
    expect(lint('nestedOneList', shape('Events.one (["id"], false)', 'departments[0].events.length'))
      .join('\n')).toMatch(/HM1005/);
  });

  test('exists adds no field (a filter)', () => {
    expect(lint('nestedExists', shape('Events.exists (["id"])', 'departments[0].id'))).toEqual([]);
    expect(lint('nestedExistsField', shape('Events.exists (["id"])', 'departments[0].events'))
      .join('\n')).toMatch(/HM1005 .*events/);
  });
});

describe('project override: queries return a task', () => {
  const OVR = ROOT + '-override';

  beforeAll(() => {
    fs.rmSync(OVR, { recursive: true, force: true });
    copyTree(FIXTURE, OVR);
    fs.writeFileSync(path.join(OVR, 'package.json'), '{ "name": "query-builder-override" }');
    fs.mkdirSync(path.join(OVR, 'hm-types'), { recursive: true });
    fs.writeFileSync(path.join(OVR, 'hm-types', 'sqlkit.hm'), [
      'Task :: a -> Task e a',
      'Task#map :: Task e a ~> (a -> b) -> Task e b',
      'QueryTag() :: p -> Task Error [o]',
      'QueryOne() :: p -> Task Error (o | Null)',
      'QueryExists() :: p -> Task Error Boolean',
      '',
    ].join('\n'));
  });

  test('calling a query yields the override\'s task, rows still projected', () => {
    const body = (use: string) => DB + `const query = Departments (["id", "name"]);

// names :: Task Error [String]
export const names = query ({}).${use};
`;
    expect(lintIn(OVR, 'task', body('map (departments => departments.map (t => t.name))'))).toEqual([]);
    expect(lintIn(OVR, 'taskThen', body('then (departments => departments)')).join('\n')).toMatch(/HM1005 .*then/);
  });
});
