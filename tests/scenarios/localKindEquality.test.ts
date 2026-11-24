// Local type refinement under an Array guard.
//
// Inside `if (isArray (xs))` — a `::narrow Array` predicate, or the builtin
// `Array.isArray (xs)` — on a value `xs :: f a` of an abstract,
// constraint-bound constructor, the true branch knows `f ≡ Array`: `xs` reads
// as `[a]` (its own element type), and a `[x]` returned there counts as
// `f x`.  The equality is LOCAL: it never pins `f` for the whole function, so
// one generic signature covers an Array fast path.  Before, fpkit's
// `dropWhile` / `takeWhile` / `sortBy` needed an extra Array-first overload.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-local-kind-equality';

const PRELUDE = `"use strict";
// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }

let fold = {};
// ::rep Foldable Array#reduce
// fold.Array :: Array a ~> (b -> a -> b) -> b -> b
fold.Array = function (fn) { return acc => this.reduce ((b, a) => fn (b) (a), acc); };

// ::narrow Array
// isArray :: a -> Boolean
const isArray = value => Array.isArray (value);

// curry :: ((a, b) -> c) -> a -> b -> c
const curry = fn => a => b => fn (a, b);
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
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "local-kind-equality" }');
});

// The `curry (…)` binding form is where the inferred type is checked against
// the annotation, so a leaked `f := Array` would surface as HM1003 (this is
// how fpkit's `dropWhile` is written).
test('a ::narrow Array fast path returns `[a]` as `f a`', () => {
  expect(lint('narrowPredicate', `
// firstN :: Foldable f => Number -> f a -> f a
const firstN = curry ((n, xs) => {
  if (isArray (xs)) {
    return xs.slice (0, n);
  }
  return xs;
});
`)).toEqual([]);
});

test('the builtin Array.isArray guard works the same way', () => {
  expect(lint('builtinGuard', `
// firstN :: Foldable f => Number -> f a -> f a
const firstN = curry ((n, xs) => {
  if (Array.isArray (xs)) {
    return xs.slice (0, n);
  }
  return xs;
});
`)).toEqual([]);
});

test('inside the branch the elements keep their own type `a`', () => {
  expect(lint('elementType', `
// keepIf :: Foldable f => (a -> Boolean) -> f a -> f a
const keepIf = curry ((pred, xs) => {
  if (isArray (xs)) {
    return xs.filter (x => pred (x));
  }
  return xs;
});
`)).toEqual([]);
});

test('a non-array return in the branch is still an error', () => {
  expect(lint('wrongReturn', `
// firstHalf :: Foldable f => f a -> f a
const firstHalf = xs => {
  if (isArray (xs)) {
    return xs.length;
  }
  return xs;
};
`)).toEqual([expect.stringMatching(/^(3|5) HM100[13] /)]);
});

test('callers with an array still get an array back', () => {
  const errs = lint('caller', `
// firstHalf :: Foldable f => f a -> f a
const firstHalf = xs => {
  if (isArray (xs)) {
    return xs.slice (0, 1);
  }
  return xs;
};
// ns :: [Number]
const ns = firstHalf ([1, 2, 3]);
// bad :: [String]
const bad = firstHalf ([1, 2, 3]);
`);
  expect(errs.length).toBeGreaterThan(0);
  expect(errs.every((e) => /^12 HM100[13] /.test(e))).toBe(true);
});
