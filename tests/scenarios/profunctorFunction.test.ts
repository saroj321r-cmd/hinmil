// Functions as a Profunctor: `p b c` ≡ `b -> c`.
//
// The binary counterpart of the reader functor (`f a` ≡ `x -> a`): a
// kind variable applied to TWO arguments unifies with a one-parameter function
// by binding `p := Function`; the application `p b c` then reads as
// `Function [b] c`.  Whether `Function` is a Profunctor is decided at
// discharge, through `::rep Profunctor Function#promap` — exactly like
// `::rep Functor Function#map`.  Before this rule fpkit's `promap` needed a
// separate function-only overload.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-profunctor-function';

const PRELUDE = `"use strict";
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Profunctor p { p :: Functor, p :: { promap :: p b c ~> (a -> b) -> (c -> d) -> p a d } }

let fnMap = {};
// ::rep Functor Function#map
// fnMap.Function :: Function [x] a ~> (a -> b) -> Function [x] b
fnMap.Function = function (fn) {
  return value => fn (this (value));
};

let fnPromap = {};
// ::rep Profunctor Function#promap
// fnPromap.Function :: Function [b] c ~> (a -> b) -> (c -> d) -> Function [a] d
fnPromap.Function = function (leftFn) {
  return rightFn => value => rightFn (this (leftFn (value)));
};

// promap :: Profunctor p => (a -> b) -> (c -> d) -> p b c -> p a d
const promap = left => right => pro => pro.promap (left) (right);

// trim :: String -> String
const trim = s => s.trim ();
// len :: String -> Number
const len = s => s.length;
// double :: Number -> Number
const double = n => n * 2;
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
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "profunctor-scenario" }');
});

test('a plain function is accepted where `Profunctor p => p b c` is expected', () => {
  expect(lint('accept', `
// result :: String -> Number
const result = promap (trim) (double) (len);
`)).toEqual([]);
});

test('the result is the composed function `a -> d`', () => {
  expect(lint('result', `
// result :: String -> String
const result = promap (trim) (double) (len);
`)).toEqual(['3 HM1001 Type mismatch: Cannot unify \'Number\' with \'String\'']);
});

test('the function parameter must match the left mapping', () => {
  // \`double\` produces a Number, but \`len\` takes a String.
  expect(lint('left', `
const bad = promap (double) (double) (len);
`)).toEqual([expect.stringMatching(/^2 HM1001 /)]);
});

test('an array parameter stays an array (`p [Number] c` is `[Number] -> c`)', () => {
  expect(lint('arrayParam', `
// total :: [Number] -> Number
const total = xs => xs.reduce ((a, b) => a + b, 0);
// result :: [Number] -> String
const result = promap (xs => xs) (n => String (n)) (total);
`)).toEqual([]);
});

test('a non-Profunctor value is still rejected', () => {
  expect(lint('notProfunctor', `
const bad = promap (trim) (double) (42);
`)).toEqual([expect.stringMatching(/^2 HM/)]);
});
