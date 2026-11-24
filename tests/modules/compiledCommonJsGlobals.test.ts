// `exports` and `module` as values in compiled CommonJS.
//
// TypeScript and Babel emit `Object.defineProperty (exports, "__esModule",
// { value: true })` at the top of every module.  `exports` was only known as
// the target of `exports.x = …`, so such a file reported "Unbound variable:
// 'exports'" (and `module` likewise).  The export sites keep their typing.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-modules-compiled-commonjs';

function write(rel: string, body: string): void {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function errorsOf(rel: string): string[] {
  let stdout = '';
  runCli([rel], { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  return stdout.split('\n').filter((l) => / error /.test(l)).map((l) => l.replace(/^\S+?:(\d+):\d+ error /, '$1 '));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  write('package.json', '{ "name": "compiled-commonjs" }');
  write('lib/tables.js', `"use strict";
Object.defineProperty (exports, "__esModule", { value: true });
exports.tableCount = void 0;

// tableCount :: [String] -> Number
const tableCount = names => names.length;
exports.tableCount = tableCount;
module.exports.version = "1.0.0";
`);
});

describe('compiled CommonJS', () => {
  test('exports and module as values are known', () => {
    expect(errorsOf('lib/tables.js')).toEqual([]);
  });

  test('an export keeps its type for a consumer', () => {
    write('src/report.js', `const { tableCount } = require ("../lib/tables");

// label :: [String] -> String
const label = names => tableCount (names);
module.exports = { label };
`);
    expect(errorsOf('src/report.js').some((e) => e.includes("'Number'") && e.includes("'String'"))).toBe(true);
  });
});
