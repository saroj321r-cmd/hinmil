// Numeric literal (singleton) types.
//
// A number in type position is a literal type: `2` unifies only with `2`.  A
// number literal EXPRESSION takes that type where it is expected (an
// overload branch `2 -> …`), so a value-dependent arity becomes typeable
// per literal; a branch with a literal parameter beats a rival that merely
// accepted a `Number` (the fallback for an `n` whose value is unknown).
// Real code: fpkit `Tuple/_Tuple (n)` and `Tuple/nmap (n)`, which were
// `Number -> Any`.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';
import { parseType } from '../../src/hm/typeParser';
import { typeToString } from '../../src/hm/types';

const ROOT = '/tmp/hm-scenarios-numeric-literal-types';

const PRELUDE = `"use strict";
// pair :: a -> b -> [a, b]
const pair = a => b => [a, b];
// triple :: a -> b -> c -> [a, b, c]
const triple = a => b => c => [a, b, c];

// tuple :: 2 -> a -> b -> [a, b]
// tuple :: 3 -> a -> b -> c -> [a, b, c]
// tuple :: Number -> Any
const tuple = n => n === 2 ? pair : triple;
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
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "numeric-literal-types" }');
});

test('a number in type position is a literal type', () => {
  expect(typeToString(parseType('2 -> Number'))).toBe('2 -> Number');
});

test('a literal argument selects its branch', () => {
  expect(lint('select2', `
// p :: [Number, String]
const p = tuple (2) (1) ("a");
// t :: [Number, String, Boolean]
const t = tuple (3) (1) ("a") (true);
`)).toEqual([]);
});

test('the selected branch is checked', () => {
  expect(lint('wrongResult', `
// p :: [Number, String, Boolean]
const p = tuple (2) (1) ("a");
`)).toEqual([expect.stringMatching(/^3 HM100[13] /)]);
});

test('a Number of unknown value falls back to the Number branch', () => {
  expect(lint('fallback', `
// pick :: Number -> Any
const pick = n => tuple (n);
`)).toEqual([]);
});

test('a literal type is not a Number (and vice versa)', () => {
  expect(lint('notNumber', `
// two :: 2 -> Number
const two = n => n;
// n :: Number
const n = 5;
const r = two (n);
`)).toEqual([expect.stringMatching(/^3 HM100[13] /), expect.stringMatching(/^6 HM1001 /)]);
});

test('a different literal is rejected', () => {
  expect(lint('otherLiteral', `
// two :: 2 -> String
const two = n => "two";
// s :: String
const s = two (3);
`)).toEqual([expect.stringMatching(/^5 HM1001 /)]);
});
