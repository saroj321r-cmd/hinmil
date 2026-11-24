// A repository layer (`Repo`/`tx`/`Schema`) on sqlkit:
//  - an overloaded value union passed where a nominal type is expected binds
//    through the member with the SAME type constructor first: sqlkit's
//    generated `Departments :: ({ props :: … } | Table DepartmentsRow | ([Sel] -> …))`
//    matched `Table r` structurally through `{ props }` (via `Table#props`)
//    and left `r` unbound, so `Repo (Departments)` lost the row type;
//  - `Object.assign ({}, env, { querier })` with `env :: Any` is `Any`, not a
//    "non-record operand" error (`tx` extends an unknown RTask env);
//  - `::global` members from the globals file are re-registered with the
//    project's aliases expanded (`Error#errors :: Errors | Undefined`
//    rejected `err.errors = { … }`).

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-repository-layer';

function write(rel: string, body: string): void {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function lint(name: string, body: string): string[] {
  const rel = `src/${name}.js`;
  write(rel, body);
  let stdout = '';
  runCli([rel], { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  return stdout.split('\n')
    .filter((l) => / error /.test(l))
    .map((l) => l.replace(/^\S+?:(\d+):\d+ error /, '$1 '));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  write('package.json', '{ "name": "repository-layer" }');
  write('hinmil.config.json', '{ "globals": ["./globals.hm"] }');
  write('globals.hm', `Errors :: Object String [String]
::global Error#errors :: Errors | Undefined
`);
  // A trimmed sqlkit: a nominal `Table r` with methods, and a generated
  // client whose table values are the three-faced union sqlkit emits.
  write('node_modules/miniorm/package.json', JSON.stringify({
    name: 'miniorm', version: '1.0.0', main: 'index.js',
    'hinmil': { sidecars: ['./miniorm.hm'] },
  }));
  write('node_modules/miniorm/index.js', 'module.exports = { tables: {} };\n');
  write('node_modules/miniorm/miniorm.hm', `makeTable :: String -> Table r
Table#props  :: Table a ~> b
Table#insert :: Table r ~> [a] -> QueryTag p r
QueryTag#run   :: QueryTag p o ~> (p, a) -> Promise e [o]

DepartmentsRow :: { id :: Number, name :: String, countryId :: Number }
EventsRow :: { id :: Number, hostDepartmentId :: Number }

tables :: { core :: { Departments :: ({ props :: { id :: Number, name :: String } } | Table DepartmentsRow | ([String] -> QueryTag p DepartmentsRow)) } }
`);
});

test('a union value binds a nominal parameter through its same-constructor member', () => {
  write('src/repo.js', `// Repo-like helper, a generic CRUD repository.
// insertOne :: Table r -> Object String Any -> Promise Error [r]
export const insertOne = table => data => table.insert ([]).run ({ data: [data] }, undefined);
`);
  const body = (field: string) => `import { tables } from "miniorm";
import { insertOne } from "./repo";

const { Departments } = tables.core;

// savedName :: Object String Any -> Promise Error String
export const savedName = data => insertOne (Departments) (data).then (rows => rows[0].${field});
`;
  expect(lint('repoDepartments', body('name'))).toEqual([]);
  // \`id\` is a Number: only an error when the row type is bound.
  expect(lint('repoDepartmentsBad', body('id')).length).toBeGreaterThan(0);
});

test('Object.assign with an Any operand is Any', () => {
  expect(lint('txEnv', `// Querier :: (String, [Any]) -> Promise Error [Any]

// withQuerier :: (Any, Querier) -> Any
export const withQuerier = (env, querier) =>
  Object.assign ({}, env, { querier, depth: 1 });
`)).toEqual([]);
  // A concrete non-record operand is still an error.
  expect(lint('txEnvBad', `// withDepth :: Number -> Any
export const withDepth = n =>
  Object.assign ({}, { depth: 1 }, n);
`).length).toBeGreaterThan(0);
});

test('a ::global member may name a globals alias', () => {
  expect(lint('invalidInput', `// invalidInput :: Errors -> Error
export const invalidInput = errors => {
  const err = new Error ("ongeldige invoer");
  err.errors = errors;
  return err;
};

// fieldErrors :: Error -> Errors | Undefined
export const fieldErrors = err => err.errors;
`)).toEqual([]);
  expect(lint('invalidInputBad', `// invalidInput :: Number -> Error
export const invalidInput = code => {
  const err = new Error ("ongeldige invoer");
  err.errors = code;
  return err;
};
`)).toEqual([expect.stringMatching(/^4 HM1001 /)]);
});
