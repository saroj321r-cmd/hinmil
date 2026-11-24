// End-to-end scenarios on a real consumer project: the app server
// (fixture: tests/fixtures/scenarios/app-server, see its README).
//
// Runs the CLI as the app does (`hinmil src tests --project ..` from
// `server/`) over app code that reaches fpkit (inline-annotated
// CommonJS package) and sqlkit (sidecars + generated client) through
// `server/node_modules`.  Positive scenarios must be diagnostic-free; each
// negative scenario plants one realistic mistake and checks the code,
// message and location.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'scenarios', 'app-server');
const ROOT = '/tmp/hm-scenarios-app-server';
const SERVER = path.join(ROOT, 'server');

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const target = path.join(to, entry.name === '_node_modules' ? 'node_modules' : entry.name);
    if (entry.isDirectory()) copyTree(path.join(from, entry.name), target);
    else fs.copyFileSync(path.join(from, entry.name), target);
  }
}

function lint(...inputs: string[]): { code: number; lines: string[] } {
  let stdout = '';
  const code = runCli([...inputs, '--project', '..'], {
    cwd: SERVER,
    stdout: (t) => { stdout += t; },
    stderr: () => {},
  });
  return { code, lines: stdout.split('\n').filter((l) => / (error|warning) /.test(l)) };
}

/** Write one scenario module under `server/src/scenarios/` and lint it alone. */
function scenario(name: string, source: string) {
  const rel = `src/scenarios/${name}.js`;
  fs.mkdirSync(path.join(SERVER, 'src/scenarios'), { recursive: true });
  fs.writeFileSync(path.join(SERVER, rel), source);
  return lint(rel);
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  copyTree(FIXTURE, ROOT);
});

describe('app server as-is', () => {
  test('`hinmil src tests --project ..` reports nothing (as in the real repo)', () => {
    const { code, lines } = lint('src', 'tests');
    expect(lines).toEqual([]);
    expect(code).toBe(0);
  });
});

describe('RTask + Promise→RTask adapter + SqlKit results', () => {
  test('positive: query → RTask → map/chain over typed rows, env, fork-to-promise', () => {
    const { lines } = scenario('members', `// ::types sqlkit
import RTask from "fpkit/RTask";
import { forkToPromise, fromPromiseFn, withEnv } from "../lib/rtask";
import { selectMembers } from "../../tests/company/members";

// firstNames :: Number -> RTask r e [String]
export const firstNames = limit =>
  fromPromiseFn (selectMembers) ({ limit, offset: 0 })
    .map (rows => rows.map (row => row.firstName));

// departmentNames :: RTask { memberParams :: { limit :: Number, offset :: Number } } e [String]
export const departmentNames =
  withEnv (env => selectMembers (env.memberParams))
    .map (rows => rows.map (row => row.department.name));

// countBoth :: RTask r e Number
export const countBoth =
  firstNames (2).chain (a => firstNames (3).map (b => a.length + b.length));

// run :: () -> Promise e [String]
export const run = () => forkToPromise (undefined) (firstNames (1));

// greeting :: RTask r e String
export const greeting = RTask.of ("ok").chain (s => RTask.of (s + "!"));
`);
    expect(lines).toEqual([]);
  });

  test('negative: a String column mapped where Numbers are promised', () => {
    const { lines } = scenario('lengths', `// ::types sqlkit
import { fromPromiseFn } from "../lib/rtask";
import { selectMembers } from "../../tests/company/members";

// firstNameLengths :: Number -> RTask r e [Number]
export const firstNameLengths = limit =>
  fromPromiseFn (selectMembers) ({ limit, offset: 0 })
    .map (rows => rows.map (row => row.firstName));
`);
    expect(lines).toEqual([
      "server/src/scenarios/lengths.js:8:29 error HM1001 Type mismatch: Cannot unify 'String' with 'Number'",
    ]);
  });

  test('negative: a column-name typo on a SqlKit row lists the real columns', () => {
    const { lines } = scenario('typo', `// ::types sqlkit
import { fromPromiseFn } from "../lib/rtask";
import { selectMembers } from "../../tests/company/members";

// names :: Number -> RTask r e [String]
export const names = limit =>
  fromPromiseFn (selectMembers) ({ limit, offset: 0 })
    .map (rows => rows.map (row => row.firstname));
`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^server\/src\/scenarios\/typo\.js:8:40 error HM1005 Property 'firstname' does not exist on type '\{ id :: Number, firstName :: String/);
  });

  test('negative: chain callback returning a plain value instead of an RTask', () => {
    const { lines } = scenario('chain', `import RTask from "fpkit/RTask";

// next :: RTask r e Number
export const next = RTask.of (1).chain (n => n + 1);
`);
    expect(lines).toEqual([
      "server/src/scenarios/chain.js:4:41 error HM1001 Type mismatch: Cannot unify 'Number' with 'RTask r e Number'",
    ]);
  });

  test('negative: wrong type in the SqlKit params record (Limit callback)', () => {
    const { lines } = scenario('params', `// ::types sqlkit
import { selectMembers } from "../../tests/company/members";

// page :: () -> Promise e [{ id :: Number }]
export const page = () => selectMembers ({ limit: "ten", offset: 0 });
`);
    expect(lines).toEqual([
      "server/src/scenarios/params.js:5:42 error HM1001 Type mismatch: Cannot unify 'String' with 'Number'",
    ]);
  });

  test('negative: forkToPromise result type flows from the task', () => {
    const { lines } = scenario('fork', `import { forkToPromise } from "../lib/rtask";
import RTask from "fpkit/RTask";

// run :: () -> Promise e Number
export const run = () => forkToPromise (undefined) (RTask.of ("x"));
`);
    expect(lines).toEqual([
      "server/src/scenarios/fork.js:5:63 error HM1001 Type mismatch: Cannot unify 'String' with 'Number'",
    ]);
  });
});

describe('fpkit curry ((a, b, c) => d) through the package', () => {
  const CLAMP = `import curry from "fpkit/more/curry";

// clamp :: Number -> Number -> Number -> Number
const clamp = curry ((lo, hi, x) => Math.min (hi, Math.max (lo, x)));
`;

  test('positive: curried, grouped, full and partial application', () => {
    const { lines } = scenario('curry', `${CLAMP}
// a :: Number
export const a = clamp (0) (10) (42);
// b :: Number
export const b = clamp (0, 10) (42);
// c :: Number
export const c = clamp (0) (10, 42);
// d :: Number
export const d = clamp (0, 10, 42);
// percent :: Number -> Number
export const percent = clamp (0) (100);
// rates :: [Number]
export const rates = [1.2, 7.5, 1.01].map (x => clamp (1.01, 5) (x));
`);
    expect(lines).toEqual([]);
  });

  test('negative: wrong result annotation and a String argument', () => {
    const { lines } = scenario('curryWrong', `${CLAMP}
// label :: String
export const label = clamp (0) (10) (42);
// e :: Number
export const e = clamp (0) ("10") (42);
`);
    expect(lines).toEqual([
      "server/src/scenarios/curryWrong.js:7:14 error HM1003 Type mismatch: 'label' has type 'Number' but annotation expects 'String'",
      "server/src/scenarios/curryWrong.js:7:22 error HM1001 Type mismatch: Cannot unify 'Number' with 'String'",
      "server/src/scenarios/curryWrong.js:9:29 error HM1001 Type mismatch: Cannot unify 'String' with 'Number'",
    ]);
  });
});
