// Functions built by a call.
//
// `const f = curry ((a, b) => …)` or `const g = compose (h) (k)` defines a
// function just as much as an arrow does.  hinmil now:
//   - asks for a signature (HM6001) when the INFERRED type of such a binding
//     is a function — imports (`require (…)`), plain aliases and non-function
//     values are not asked;
//   - checks that signature as rigidly as an arrow's (the annotation must be
//     an instance of what the call produces), instead of unifying it away;
//   - accepts an empty call `f ()` on a curried `() -> r` step (the Void
//     marker), as the regular call path already did.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-call-built-functions';

const PRELUDE = `"use strict";
// curry :: ((a, b) -> c) -> a -> b -> c
const curry = fn => a => b => fn (a, b);
// compose :: (b -> c) -> (a -> b) -> a -> c
const compose = f => g => x => f (g (x));
// double :: Number -> Number
const double = n => n * 2;
`;

function lint(name: string, body: string, extra?: Record<string, string>): string[] {
  for (const [rel, src] of Object.entries(extra ?? {})) fs.writeFileSync(path.join(ROOT, rel), src);
  const rel = `${name}.js`;
  fs.writeFileSync(path.join(ROOT, rel), PRELUDE + body);
  let stdout = '';
  runCli([rel], { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  const preludeLines = PRELUDE.split('\n').length - 1;
  return stdout.split('\n')
    .filter((l) => / (error|information) /.test(l))
    .map((l) => l.replace(/^\S+?:(\d+):\d+ (error|information) /, (_m, line) => `${Number(line) - preludeLines} `));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "call-built-functions" }');
});

test('a curry-built function without signature is reported', () => {
  expect(lint('missing', `
const keep = curry ((a, b) => a);
const quadruple = compose (double) (double);
`)).toEqual([
    "2 HM6001 Function 'keep' has no HM annotation",
    "3 HM6001 Function 'quadruple' has no HM annotation",
  ]);
});

test('imports, aliases and non-function values are not asked for a signature', () => {
  expect(lint('notAsked', `
const helper = require ("./helper");
const alias = double;
const four = double (2);
`, { 'helper.js': '"use strict";\n// helper :: Number -> Number\nconst helper = n => n;\nmodule.exports = helper;\n' })).toEqual([]);
});

test('a correct signature is accepted', () => {
  expect(lint('correct', `
// keep :: a -> b -> a
const keep = curry ((a, b) => a);
// quadruple :: Number -> Number
const quadruple = compose (double) (double);
`)).toEqual([]);
});

test('a signature more general than the call produces is rejected', () => {
  expect(lint('tooGeneral', `
// keep :: a -> b -> b
const keep = curry ((a, b) => a);
`)).toEqual([expect.stringMatching(/^3 HM1003 Type mismatch: 'keep' has type/)]);
});

test('an empty call satisfies a curried `() -> r` step', () => {
  // `addThunk` is built by a call, so `addThunk (2) ()` takes the curried
  // call path (fpkit: `emptyFn (typeRep) ()`).
  expect(lint('nullaryStep', `
// mkThunk :: Number -> Number -> () -> Number
const mkThunk = a => b => () => a + b;
// addThunk :: Number -> () -> Number
const addThunk = mkThunk (1);
// n :: Number
const n = addThunk (2) ();
`)).toEqual([]);
});
