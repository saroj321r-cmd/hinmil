// A nested `hinmil.config.json` is its own project scope.
//
// A repository with two applications (`api/` and `web/`) gives each its own
// configuration with its own globals.  A file uses the nearest configuration
// above it: the web application's `Route` alias is known in `web/` without a
// `// ::types` line, and the API's `JobState` is NOT known there (and vice
// versa).  Files outside both use the root configuration.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';
import { findScopeRoot } from '../../src/config';

const ROOT = '/tmp/hm-scenarios-scoped-project-config';

function write(rel: string, body: string): void {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function lint(rels: string[]): string[] {
  let stdout = '';
  runCli(rels, { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  return stdout.split('\n')
    .filter((l) => / error /.test(l))
    .map((l) => l.replace(/:(\d+):\d+ error /, ':$1 '));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  write('package.json', '{ "name": "two-apps" }');
  write('hinmil.config.json', '{ "globals": ["./shared.hm"] }');
  write('shared.hm', 'Money :: { amount :: Number, currency :: String }\n');
  write('api/hinmil.config.json', '{ "globals": ["./globals.hm"] }');
  write('api/globals.hm', 'JobState :: { id :: Number, status :: String }\n');
  write('web/hinmil.config.json', '{ "globals": ["./src/types.hm"] }');
  write('web/src/types.hm', 'Route :: { path :: String, title :: String }\n');
});

describe('nested hinmil.config.json files', () => {
  test('each application sees its own globals', () => {
    write('api/src/jobs.js', `// statusOf :: JobState -> String
export const statusOf = job => job.status;
`);
    write('web/src/menu.js', `// titleOf :: Route -> String
export const titleOf = route => route.title;
`);
    expect(lint(['api/src/jobs.js', 'web/src/menu.js'])).toEqual([]);
  });

  test('a global of the other application is unknown', () => {
    write('web/src/wrong.js', `// statusOf :: JobState -> String
export const statusOf = job => job.status;
`);
    const errors = lint(['web/src/wrong.js']);
    expect(errors.some((e) => e.includes("Unknown type constructor 'JobState'"))).toBe(true);
  });

  test('a file outside both uses the root configuration', () => {
    write('scripts/report.js', `// amountOf :: Money -> Number
export const amountOf = money => money.amount;
`);
    expect(lint(['scripts/report.js'])).toEqual([]);
  });

  test('findScopeRoot picks the nearest configuration', () => {
    expect(findScopeRoot(path.join(ROOT, 'web/src/menu.js'), ROOT)).toBe(path.join(ROOT, 'web'));
    expect(findScopeRoot(path.join(ROOT, 'scripts/report.js'), ROOT)).toBe(ROOT);
    expect(findScopeRoot(path.join(ROOT, 'web/node_modules/kit/index.js'), ROOT)).toBe(ROOT);
  });
});
