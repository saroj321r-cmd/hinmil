// Annotated functions: every return is checked, and abstract containers are
// not indexable.
//
// Only the final top-level `return` used to be inferred against the annotated
// return type.  Returns nested in an `if` were merged into a union afterwards,
// and `[Number]` with `[a]` became `[Number | a]` — whose element "matches"
// `a`.  A body could thus return the wrong element type, for rigid (plain)
// signatures and constrained ones alike.  Each nested return is now unified
// with the annotated return type, like the branches of a ternary.
// Separately, `xs[0]` on `xs :: f a` (an abstract constrained container) is
// reported like an unknown member (`xs.length`).

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-annotated-returns';

const PRELUDE = `"use strict";
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// ::narrow Array
// isArray :: a -> Boolean
const isArray = value => Array.isArray (value);
`;

function lint(name: string, body: string): string[] {
  const rel = `${name}.js`;
  fs.writeFileSync(path.join(ROOT, rel), PRELUDE + body);
  let stdout = '';
  runCli([rel], { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  const preludeLines = PRELUDE.split('\n').length - 1;
  return stdout.split('\n')
    .filter((l) => / error /.test(l))
    .map((l) => l.replace(/^\S+?:(\d+):\d+ error /, (_m, line) => `${Number(line) - preludeLines} `));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "annotated-returns" }');
});

test('a nested return of the wrong element type is reported (plain signature)', () => {
  expect(lint('plain', `
// ones :: Boolean -> [a] -> [a]
const ones = b => xs => { if (b) { return xs.map (x => 1); } return xs; };
`)).toEqual([expect.stringMatching(/^3 HM1001 Type mismatch: Cannot unify 'Number' with 'a'/)]);
});

test('… and with a constrained signature', () => {
  expect(lint('constrained', `
// ones :: Functor f => Boolean -> f a -> f a
const ones = b => xs => { if (b) { return xs.map (x => 1); } return xs; };
`)).toEqual([expect.stringMatching(/^3 HM1003 /)]);
});

test('… and inside a local Array guard', () => {
  expect(lint('guard', `
// firstOr :: Functor f => f a -> f a
const firstOr = xs => {
  if (isArray (xs)) { return [1]; }
  return xs;
};
`)).toEqual([expect.stringMatching(/^(3|4) HM100[13] /)]);
});

test('correct nested returns stay clean', () => {
  expect(lint('ok', `
// keepIf :: Boolean -> [a] -> [a]
const keepIf = b => xs => { if (b) { return xs.slice (1); } return xs; };
// pick :: Boolean -> a -> b -> a | b
const pick = flag => x => y => { if (flag) { return x; } return y; };
// half :: Functor f => f a -> f a
const half = xs => {
  if (isArray (xs)) { return xs.slice (0, 1); }
  return xs;
};
`)).toEqual([]);
});

test('index access on an abstract constrained container is reported', () => {
  expect(lint('index', `
// first :: Functor f => f Number -> Number
const first = xs => xs[0];
`)).toEqual(["3 HM1001 Index access does not exist on constraint 'Functor'"]);
});
