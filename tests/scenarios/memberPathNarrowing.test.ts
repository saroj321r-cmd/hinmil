// Narrowing a member of a NON-record object, as in a job runner that reads
// an optional field a project added to the built-in `Error`
// (`::global Error#retryAt :: Date | Undefined`):
//   const at = err.retryAt == null ? fallback : err.retryAt;
// A record object is narrowed by rewriting its field; a built-in or nominal
// object has no record to rewrite, so the branch marks the member PATH as
// non-null and member access on exactly that path drops Null/Undefined.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-member-path-narrowing';

function lint(name: string, source: string): string[] {
  fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'src', `${name}.js`), source);
  let stdout = '';
  runCli([`src/${name}.js`, '--project', '.'], {
    cwd: ROOT,
    stdout: (t) => { stdout += t; },
    stderr: () => {},
  });
  return stdout.split('\n').filter((l) => / error /.test(l));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "member-path-narrowing" }');
  fs.writeFileSync(path.join(ROOT, 'globals.hm'), [
    '::global Error#retryAt :: Date | Undefined',
    'Box :: { at :: Date | Undefined }',
    '',
  ].join('\n'));
});

test('positive: a null check on a global member of Error narrows it in the other branch', () => {
  expect(lint('errorMember', `
// retryLabel :: Error -> String
export const retryLabel = err => {
  const at = err.retryAt == null ? new Date (0) : err.retryAt;
  return at.toISOString ();
};

// retryOrNow :: Error -> Number
export const retryOrNow = err => err.retryAt != null ? err.retryAt.getTime () : 0;
`)).toEqual([]);
});

test('positive: record fields still narrow as before', () => {
  expect(lint('recordMember', `
// label :: Box -> String
export const label = box => {
  const at = box.at == null ? new Date (0) : box.at;
  return at.toISOString ();
};
`)).toEqual([]);
});

test('negative: without the check, or in the null branch, the member stays nullable', () => {
  const errors = lint('unchecked', `
// raw :: Error -> String
export const raw = err => err.retryAt.toISOString ();

// wrongBranch :: Error -> String
export const wrongBranch = err => err.retryAt == null ? err.retryAt.toISOString () : "";

// otherPath :: Error -> Error -> String
export const otherPath = a => b => a.retryAt == null ? "" : b.retryAt.toISOString ();
`);
  expect(errors).toHaveLength(3);
  expect(errors.every((e) => /toISOString/.test(e))).toBe(true);
});
