// A member name that several registered types own (`name` on Error,
// Function and the library's `Table`) says nothing about an unknown
// receiver: the receiver stays free and the access is a record field.
// Before, the owners' shared member type (`String`) was returned without
// pinning the receiver, so `p => p.name` was `a -> String` as soon as a
// sidecar declared `Table#name :: String`.
//
// Fixture: query-builder (the sqlkit sidecar declares `Table#name`).

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'scenarios', 'query-builder');
const ROOT = '/tmp/hm-scenarios-member-owners';

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const target = path.join(to, entry.name === '_node_modules' ? 'node_modules' : entry.name);
    if (entry.isDirectory()) copyTree(path.join(from, entry.name), target);
    else fs.copyFileSync(path.join(from, entry.name), target);
  }
}

function lint(name: string, body: string): string[] {
  const rel = `src/${name}.js`;
  fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), body);
  let stdout = '';
  runCli([rel], { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  return stdout.split('\n')
    .filter((l) => / (error|warning) /.test(l))
    .map((l) => l.replace(/^\S+?:(\d+):\d+ (error|warning) /, '$1 '));
}

const DB = `import SqlKit from "sqlkit";

const { sql } = SqlKit ({ querier: (_q, _v) => Promise.resolve ([]) });
`;
// The DB prelude is 4 lines; scenario bodies start on line 5.

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  copyTree(FIXTURE, ROOT);
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "member-owners" }');
});

describe('a member with several owners leaves an unknown receiver free', () => {
  test('an optional `name` filter of a raw query accepts null', () => {
    expect(lint('jobFilter', DB + `const selectJobs = sql\`
  SELECT id, name, status FROM jobs
  WHERE (\${p => p.name}::text IS NULL OR name = \${p => p.name}::text)
    AND (\${p => p.status}::text IS NULL OR status = \${p => p.status}::text)
\`;

// jobsByFilter :: { name :: String | Null, status :: String | Null } -> Promise Error [Any]
export const jobsByFilter = q => selectJobs ({ name: q.name, status: q.status });

// allJobs :: () -> Promise Error [Any]
export const allJobs = () => selectJobs ({ name: null, status: null });
`)).toEqual([]);
  });

  test('a plain accessor is not typed by the owners\' member type', () => {
    expect(lint('accessor', DB + `const nameOf = p => p.name;

// TeamCount :: { name :: Number, label :: String }

// countOf :: TeamCount -> Number
export const countOf = t => nameOf (t) + 1;
`)).toEqual([]);
  });

  test('a known receiver still uses its own member type', () => {
    const errors = lint('knownReceiver', DB + `// boom :: Error -> Number
export const boom = e => e.name;
`);
    expect(errors).toEqual(["5 HM1003 Type mismatch: 'boom' has type 'Error -> String' but annotation expects 'Error -> Number'"]);
  });
});
