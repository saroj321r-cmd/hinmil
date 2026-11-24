// Building database rows from a dictionary plus record literals, as a
// repository layer does: `Object.assign (withoutNulls (fields), key, extra)`.
// A dictionary `Object String Any` merged with closed records is a
// dictionary again (the records' keys are strings; `Any` absorbs their
// field types), so it fits a parameter typed `Object String Any`.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-row-building';

function lint(name: string, source: string): string[] {
  fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'src', `${name}.js`), source);
  let stdout = '';
  runCli([`src/${name}.js`, '--project', '.'], {
    cwd: ROOT,
    stdout: (t) => { stdout += t; },
    stderr: () => {},
  });
  return stdout.split('\n').filter((l) => / error /.test(l));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "row-building" }');
});

const PRELUDE = `// withoutNulls :: Object String Any -> Object String Any
const withoutNulls = obj => Object.keys (obj).reduce ((acc, k) => {
  if (obj[k] != null) acc[k] = obj[k];
  return acc;
}, {});

// insertRow :: Object String Any -> Number
const insertRow = row => Object.keys (row).length;
`;

test('positive: a dictionary merged with records is a dictionary', () => {
  expect(lint('rows', `${PRELUDE}
// saveDepartment :: Number -> { name :: String, country :: String | Null } -> Number
export const saveDepartment = sourceId => department =>
  insertRow (Object.assign (withoutNulls ({ name: department.name, country: department.country }), { sourceId }, { seenAt: new Date () }));
`)).toEqual([]);
});

test('negative: a record does not merge into a Number-keyed dictionary', () => {
  expect(lint('rowsBad', `// byId :: Object Number String -> Object Number String
export const byId = names => Object.assign ({}, names, { extra: "x" });
`)).toEqual([
    "src/rowsBad.js:2:30 error HM1001 Type mismatch: Cannot unify 'Merge {} { [Number] :: String } { extra :: String }' with '{ [Number] :: String }'",
  ]);
});

test('positive: a member of Any is Any (patching parsed JSON)', () => {
  expect(lint('anyMember', `// parseJson :: String -> Any
const parseJson = text => JSON.parse (text);

// patched :: String -> Object String Any -> Any
export const patched = text => extra => {
  const json = parseJson (text);
  json.data = Object.assign ({}, json.data, extra);
  return json;
};
`)).toEqual([]);
});
