// Self-guarded constructors.
//
// `function T (x) { if (!(this instanceof T)) return new T (x); this.x = x; }`
// re-invokes itself with `new`, so calling `T (x)` without `new` is safe and
// idiomatic.  hinmil used to report "Constructor 'T' must be called with
// 'new'" (fpkit `test/laws/Traversable.js` needed `::ignore-function`).  A
// `this`-constructor WITHOUT the guard is still reported.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-self-guarded-constructor';

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
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "self-guarded-constructor" }');
});

test('a self-guarded constructor may be called without new', () => {
  expect(lint('guarded', `"use strict";
// Box :: a -> Box a
function Box (value) {
  if (!(this instanceof Box)) {
    return new Box (value);
  }
  // Box#value :: Box a ~> a
  this.value = value;
}
// b :: Box Number
const b = Box (1);
// c :: Box Number
const c = new Box (2);
`)).toEqual([]);
});

test('a constructor without the guard still requires new', () => {
  expect(lint('unguarded', `"use strict";
// Cell :: a -> Cell a
function Cell (value) {
  // Cell#value :: Cell a ~> a
  this.value = value;
}
// c :: Cell Number
const c = Cell (1);
`)).toEqual(["8 HM1001 Constructor 'Cell' must be called with 'new'"]);
});

test('a guard on a different name does not count', () => {
  expect(lint('otherGuard', `"use strict";
// Other :: a -> Other a
function Other (value) { this.value = value; }
// Cell :: a -> Cell a
function Cell (value) {
  if (!(this instanceof Other)) {
    return new Cell (value);
  }
  // Cell#value :: Cell a ~> a
  this.value = value;
}
// c :: Cell Number
const c = Cell (1);
`)).toEqual(["13 HM1001 Constructor 'Cell' must be called with 'new'"]);
});
