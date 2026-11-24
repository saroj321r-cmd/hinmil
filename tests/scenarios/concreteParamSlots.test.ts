// A known parameter type is never widened by a call.
//
// When an argument did not fit the callee's parameter, auto-union used to
// widen the call-site slot to `String | Number` silently — unless the callee
// happened to carry an annotation IN THE SAME FILE.  So `toUpper (1)` with an
// imported `toUpper :: String -> String`, or a call through an alias
// (`const up = toUpper`), went unreported in unannotated code.  Auto-union may
// still widen the ARGUMENT side, but a slot that is concrete after decomposing
// the callee must be met.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-concrete-param-slots';

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
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "concrete-param-slots" }');
  fs.writeFileSync(path.join(ROOT, 'upper.js'), [
    '"use strict";',
    '// upper :: String -> String',
    'const upper = s => s.toUpperCase ();',
    'module.exports = upper;',
    '',
  ].join('\n'));
});

test('an imported annotated function rejects a wrong primitive argument', () => {
  expect(lint('imported', `"use strict";
const upper = require ("./upper");
const r = upper (1);
`)).toEqual(["3 HM1001 Type mismatch: Cannot unify 'Number' with 'String'"]);
});

test('… also through an alias', () => {
  expect(lint('alias', `"use strict";
// len :: String -> Number
const len = s => s.length;
const size = len;
const r = size (1);
`)).toEqual(["5 HM1001 Type mismatch: Cannot unify 'Number' with 'String'"]);
});

test('… also inside a type argument of a nominal type', () => {
  expect(lint('typeArg', `"use strict";
// settle :: Promise e String -> Number
const settle = p => 1;
const run = settle;
const r = run (Promise.resolve (1));
`)).toEqual([expect.stringMatching(/^5 HM1001 Type mismatch: Cannot unify 'Number' with 'String'/)]);
});

test('matching arguments and unannotated polymorphic callees stay clean', () => {
  expect(lint('clean', `"use strict";
const upper = require ("./upper");
const a = upper ("x");
const id = x => x;
const b = id (1);
const c = id ("y");
const mixed = [1, "two"];
`)).toEqual([]);
});
