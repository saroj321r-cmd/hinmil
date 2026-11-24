// hinmil changes for a typical API + job-queue server:
//  - builtins: `Date.UTC` takes 2–7 arguments; the `Intl` namespace
//    (DateTimeFormat / NumberFormat); `Error#code` (Node / driver errors);
//    bundled `crypto`, `os` and `http` stubs;
//  - a dictionary `Object String a` indexed by a non-literal key yields `a`
//    (it yielded a fresh variable, hiding every check on the result);
//  - every `return` is typed from its own inference: looking a return's type
//    up by end offset confused `(await x) === "PONG"` with `"PONG"`.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-server-builtins';

/** Every error is on `line`, and there is at least one. */
function onlyOnLine(errors: string[], line: number): void {
  expect(errors.length).toBeGreaterThan(0);
  for (const e of errors) expect(e.startsWith(line + ' HM')).toBe(true);
}

function lint(name: string, body: string): string[] {
  const rel = `${name}.js`;
  fs.writeFileSync(path.join(ROOT, rel), body);
  let stdout = '';
  runCli([rel], { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  return stdout.split('\n')
    .filter((l) => / error /.test(l))
    .map((l) => l.replace(/^\S+?:(\d+):\d+ error /, '$1 '));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "server-builtins" }');
});

test('Date.UTC with up to seven components', () => {
  expect(lint('dateUtc', `
// ms :: Number
const ms = Date.UTC (2026, 7, 1, 20, 45, 0, 0);
// short :: Number
const short = Date.UTC (2026, 7);
`)).toEqual([]);
  expect(lint('dateUtcBad', `
const bad = Date.UTC (2026, "aug");
`)).toEqual([expect.stringMatching(/^2 HM1001 /)]);
});

test('Intl.DateTimeFormat and NumberFormat', () => {
  expect(lint('intl', `
const fmt = new Intl.DateTimeFormat ("en-US", { timeZone: "Europe/Amsterdam", hour: "2-digit" });
// parts :: [{ type :: String, value :: String }]
const parts = fmt.formatToParts (new Date ());
// text :: String
const text = fmt.format (new Date ());
// money :: String
const money = new Intl.NumberFormat ("nl-NL").format (12.5);
`)).toEqual([]);
  onlyOnLine(lint('intlBad', `
// n :: Number
const n = new Intl.DateTimeFormat ("en-US").format (new Date ());
`), 3);
});

test('Error#code is an optional string', () => {
  expect(lint('errorCode', `
// isFkViolation :: Error -> Boolean
const isFkViolation = err => err.code === "23503";
`)).toEqual([]);
  expect(lint('errorCodeBad', `
// codeLength :: Error -> Number
const codeLength = err => err.code.length;
`)).toEqual([expect.stringMatching(/^3 HM1005 .*Undefined/)]);
});

test('bundled crypto and os stubs', () => {
  expect(lint('cryptoOs', `
import { createHash, randomUUID } from "crypto";
import { hostname } from "os";
// digest :: String -> String
const digest = text => createHash ("sha256").update (text).digest ("hex");
// workerId :: () -> String
const workerId = () => hostname () + "-" + randomUUID ();
`)).toEqual([]);
  onlyOnLine(lint('cryptoBad', `
import { createHash } from "crypto";
// n :: Number
const n = createHash ("sha256").update ("x").digest ("hex");
`), 4);
});

test('bundled http stub', () => {
  expect(lint('http', `
import { createServer } from "http";
const server = createServer ((req, res) => res.end ("ok"));
server.listen (0, () => {});
// port :: Number
const port = server.address ().port;
`)).toEqual([]);
  onlyOnLine(lint('httpBad', `
import { createServer } from "http";
// port :: String
const port = createServer (null).address ().port;
`), 4);
});

test('a dictionary indexed by a String key yields its value type', () => {
  expect(lint('dictionary', `
// handlers :: Object String (Number -> String)
const handlers = { a: n => String (n) };
// run :: String -> String
const run = name => handlers[name] (1);
`)).toEqual([]);
  // The value is checked: a curried function called with two arguments.
  expect(lint('dictionaryBad', `
// handlers :: Object String (Number -> Number -> Number)
const handlers = { add: a => b => a + b };
// run :: String -> Number
const run = name => handlers[name] (1, 2);
`)).toEqual([expect.stringMatching(/^5 HM100[13] /)]);
});

test('a return inside try is typed as the whole expression', () => {
  expect(lint('asyncTry', `
// ping :: Any -> Promise Error Boolean
const ping = async x => {
  try {
    return (await x) === "PONG";
  } catch (_e) {
    return false;
  }
};
`)).toEqual([]);
});
