// Deferring an overload choice across a call boundary.
//
// A partial application of an overloaded function can stay ambiguous — its
// type is an overload-set union of the surviving tails — and the next
// application picks the branch.  That already worked for DIRECT application.
// When the ambiguous value (or a bare overloaded function value such as
// `size`) is the ARGUMENT of another overloaded call (`compose (…)`,
// `contramap (size)`), hinmil used to re-infer it against the first parameter
// shape and so committed the inner choice too early.  The outer call is now
// resolved once per argument branch and the surviving results stay an
// overload-set union until the next application.
//
// Real code: fpkit `more/fanout.spec.js` (`compose (merge (lift3 f)) (fanout
// ([…3]))`, was `::ignore`) and `fl/contramap.spec.js` (`contramap (size)`,
// needed a pinned `textSize` helper).

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-deferred-overload-arg';

const PRELUDE = `"use strict";
// merge :: (a -> b -> z) -> [a, b] -> z
// merge :: (a -> b -> c -> z) -> [a, b, c] -> z
const merge = fn => t => t.reduce ((f, x) => f (x), fn);

// compose :: (b -> c) -> (a -> b) -> a -> c
// compose :: { run :: b -> c } -> { run :: a -> b } -> a -> c
const compose = f => g => x => f (g (x));

// pipe2 :: (a -> b) -> (b -> c) -> a -> c
const pipe2 = g => f => x => f (g (x));

// size :: [a] -> Number
// size :: String -> Number
const size = xs => xs.length;

// contramap :: (a -> b) -> (b -> c) -> a -> c
// contramap :: { run :: a -> b } -> (b -> c) -> a -> c
const contramap = f => g => x => g (f (x));

// double :: Number -> Number
const double = n => n * 2;
// volume :: Number -> Number -> Number -> Number
const volume = l => w => d => l * w * d;
// toTriple :: { l :: Number } -> [Number, Number, Number]
const toTriple = o => [o.l, o.l, o.l];
// toPair :: { l :: Number } -> [Number, Number]
const toPair = o => [o.l, o.l];
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
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "deferred-overload-scenario" }');
});

test('an ambiguous partial application flows through compose until the Triple arrives', () => {
  expect(lint('composeTriple', `
// dims :: { l :: Number } -> Number
const dims = compose (merge (volume)) (toTriple);
`)).toEqual([]);
});

test('the binary branch is still chosen for a Pair', () => {
  // merge (volume) on a Pair leaves a function waiting for the third value.
  expect(lint('composePair', `
// dims :: { l :: Number } -> Number -> Number
const dims = compose (merge (volume)) (toPair);
`)).toEqual([]);
});

test('the deferred result type is still checked', () => {
  expect(lint('composeWrongResult', `
// dims :: { l :: Number } -> String
const dims = compose (merge (volume)) (toTriple);
`)).toEqual([expect.stringMatching(/^3 HM100[13] /)]);
});

test('the deferral also works when the outer function is not overloaded', () => {
  expect(lint('pipeTriple', `
// dims :: { l :: Number } -> Number
const dims = pipe2 (toTriple) (merge (volume));
`)).toEqual([]);
});

test('a bare overloaded function value is resolved by the later argument', () => {
  expect(lint('contramapSize', `
// n :: Number
const n = contramap (size) (double) ("abc");
`)).toEqual([]);
});

test('a later argument that fits no branch is reported', () => {
  expect(lint('contramapWrongArg', `
const n = contramap (size) (double) (42);
`)).toEqual([expect.stringMatching(/^2 HM/)]);
});
