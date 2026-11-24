// Query parameters on the sqlkit sidecars (fixture: query-builder).  Library-agnostic hinmil changes:
//  - 4a `l ?? r` / `l || r`: an unknown FIELD on the left becomes optional
//    (`r | Undefined`) and the default must fit; `p => p.from || 2` no longer
//    hides the `2`;
//  - 4b excess-property check (HM1010) for object literals against a NAMED
//    record type, with a "did you mean" hint; setting `excessRecordFields`;
//  - 4c an annotation on a projected query is checked exactly against the
//    projection (`// q :: QueryTag Params Row`);
//  - 4d `concat` with a selection that names no columns keeps the other
//    operand's projection (default projection is the Merge identity).

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'scenarios', 'query-builder');
const ROOT = '/tmp/hm-scenarios-query-parameters';

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
    .filter((l) => / (error|warning) /.test(l))
    .map((l) => l.replace(/^\S+?:(\d+):\d+ (error|warning) /, '$1 '));
}

const DB = `import SqlKit from "sqlkit";

const { tables } = SqlKit ({ querier: (_q, _v) => Promise.resolve ([]) });

const { Events } = tables.events;
const { startsAt } = Events.props;
`;
// The DB prelude is 6 lines; scenario bodies start on line 7.
const lint = (name: string, body: string) => lintIn(ROOT, name, DB + body);

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  copyTree(FIXTURE, ROOT);
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "query-parameters" }');
});

describe('4a: defaults in parameter callbacks', () => {
  test('`?? default` makes the field optional and keeps its type', () => {
    const body = (call: string) => `const q = Events (["id", startsAt.gte (p => p.from ?? new Date ()), startsAt.lte (p => p.to)]);

export const run = q (${call});
`;
    expect(lint('defaultOk', body('{ to: new Date () }'))).toEqual([]);
    expect(lint('defaultBad', body('{ from: 3, to: new Date () }'))).toEqual([
      expect.stringMatching(/^9 HM1001 .*Date \| Undefined.*Number/),
    ]);
  });

  test('`|| 2` where a Date is required is an error', () => {
    expect(lint('orNumber', `const q = Events (["id", startsAt.gte (p => p.from || 2)]);
`)).toEqual([expect.stringMatching(/^7 HM1001 .*Number/)]);
  });

  test('`x || y` returns either operand', () => {
    expect(lintIn(ROOT, 'orUnion', `// label :: String | Undefined -> Number -> String
export const label = name => fallback => name || fallback;
`).join('\n')).toMatch(/HM100[13] .*String \| Number|Number \| String/);
  });
});

describe('4b: unknown fields on a named record type', () => {
  const body = (arg: string) => `// RangeParams :: { from :: Date | Undefined, to :: Date }

// run :: RangeParams -> Number
const run = _p => 1;

export const r = run (${arg});
`;

  test('a typo in an optional field is reported, with a suggestion', () => {
    expect(lintIn(ROOT, 'excessTypo', body('{ form: new Date (), to: new Date () }'))).toEqual([
      expect.stringMatching(/^6 HM1010 Unknown field 'form' .*did you mean 'from'/),
    ]);
    expect(lintIn(ROOT, 'excessOk', body('{ to: new Date () }'))).toEqual([]);
  });

  test('inline and inferred records keep JavaScript\'s lenience', () => {
    expect(lintIn(ROOT, 'excessInline', `// run :: { to :: Date } -> Number
const run = _p => 1;

const takeX = ({ x }) => x;

export const r = run ({ to: new Date (), extra: 1 });
export const s = takeX ({ x: 1, y: 2 });
`)).toEqual([]);
  });

  test('the check has its own severity setting', () => {
    const root = ROOT + '-lenient';
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "lenient" }');
    fs.writeFileSync(path.join(root, 'hinmil.config.json'),
      '{ "settings": { "diagnostics": { "excessRecordFields": "warning" } } }');
    expect(lintIn(root, 'excessWarning', body('{ form: new Date (), to: new Date () }'))).toEqual([
      expect.stringMatching(/^6 HM1010 /),
    ]);
    let stdout = '';
    runCli(['src/excessWarning.js'], { cwd: root, stdout: (t) => { stdout += t; }, stderr: () => {} });
    expect(stdout).toMatch(/ warning HM1010 /);
  });
});

describe('4c: annotated queries are checked against their projection', () => {
  const query = (annotation: string, reads: string) => `// RangeParams :: { from :: Date, to :: Date }

// q :: ${annotation}
const q = Events (["id", "startsAt", startsAt.gte (p => p.from), startsAt.lte (p => p.${reads})]);
`;

  test('a matching annotation is accepted and becomes the contract', () => {
    expect(lint('annOk', query('QueryTag RangeParams { id :: Number, startsAt :: Date | Null }', 'to')
      + 'export const r = q ({ form: new Date (), to: new Date () });\n')).toEqual([
      expect.stringMatching(/^11 HM1008 .*'from'/),
      expect.stringMatching(/^11 HM1010 .*'form'/),
    ]);
  });

  test('a parameter the contract lacks', () => {
    expect(lint('annParam', query('QueryTag RangeParams { id :: Number, startsAt :: Date | Null }', 'until'))).toEqual([
      expect.stringMatching(/^10 HM1001 .*'until' not in 'RangeParams'/),
    ]);
  });

  test('a row field the query does not select', () => {
    expect(lint('annRow', query('QueryTag RangeParams { id :: Number, startsAt :: Date | Null, hostDepartmentId :: Number }', 'to'))).toEqual([
      expect.stringMatching(/^10 HM1001 .*'hostDepartmentId' missing/),
    ]);
  });

  test('optional contract fields may go unread', () => {
    expect(lint('annOptional', `// Filter :: { from :: Date, to :: Date, departmentId :: Number | Undefined }

// q :: QueryTag Filter { id :: Number }
const q = Events (["id", startsAt.gte (p => p.from), startsAt.lte (p => p.to)]);
`)).toEqual([]);
  });
});

describe('4d: concat with a filter-only selection', () => {
  test('keeps the projection of the selecting operand', () => {
    const body = (use: string) => `const base = Events (["id", "startsAt"]);
const fromFilter = Events ([startsAt.gte (p => p.from)]);
const q = base.concat (fromFilter);

// use :: Date -> Promise Error Any
export const use = from => q ({ from }).then (rows => ${use});
`;
    expect(lint('concatOk', body('rows[0].startsAt'))).toEqual([]);
    expect(lint('concatDropped', body('rows[0].hostDepartmentId')).join('\n')).toMatch(/HM1005 .*hostDepartmentId/);
  });

  test('a filter-only query by itself still selects every column', () => {
    expect(lint('filterAlone', `const q = Events ([startsAt.gte (p => p.from)]);

// use :: Date -> Promise Error Any
export const use = from => q ({ from }).then (rows => rows[0].hostDepartmentId);
`)).toEqual([]);
  });
});
