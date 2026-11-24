// Closed aliases inside an imported type are expanded at the import.
//
// A local annotation has its aliases expanded; an imported scheme from a
// package sidecar kept a name deep inside a type as a bare constructor
// (`makeToaster :: Options -> Promise Error (Toast -> ())`).  The two met
// as "Cannot unify 'Toast' with 'Toast'".  Closed aliases (no free type
// variables) are now expanded when the import is bound; aliases with free
// variables still get fresh variables per use site.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-imported-closed-aliases';

function write(rel: string, body: string): void {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function lint(rel: string, body: string): string[] {
  write(rel, body);
  let stdout = '';
  runCli([rel], { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  return stdout.split('\n')
    .filter((l) => / error /.test(l))
    .map((l) => l.replace(/^\S+?:(\d+):\d+ error /, '$1 '));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  write('package.json', '{ "name": "imported-closed-aliases" }');
  write('node_modules/uikit/package.json', '{ "name": "uikit", "version": "1.0.0", "main": "./index.js", "hinmil": { "sidecars": ["./uikit.hm"] } }');
  write('node_modules/uikit/index.js', '"use strict";\nexports.makeToaster = async (options) => (toast) => {};\nexports.Position = { TOP: "top", TOP_RIGHT: "top-right" };\n');
  write('node_modules/uikit/uikit.hm', `Intent :: "none" | "primary" | "success" | "warning" | "danger"
Toast :: { message :: String, title :: String | Undefined, intent :: Intent | Undefined }
ToasterOptions :: { position :: "top" | "top-right" | Undefined }
makeToaster :: ToasterOptions -> Promise Error (Toast -> ())
`);
});

describe('an imported type that names a closed alias', () => {
  test('matches a local annotation with the same alias', () => {
    expect(lint('src/toaster.js', `import { makeToaster } from "uikit";

// state :: { made :: Promise Error (Toast -> ()) | Null }
const state = { made: null };

// toaster :: () -> Promise Error (Toast -> ())
export const toaster = () => {
  const known = state.made;
  if (known != null) return known;
  const made = makeToaster ({ position: "top-right" });
  state.made = made;
  return made;
};
`)).toEqual([]);
  });

  test('a wrong toast is still rejected', () => {
    expect(lint('src/wrong.js', `import { makeToaster } from "uikit";

// notify :: String -> Promise Error ()
export const notify = text => makeToaster ({ position: "top" }).then (show => show ({ title: text }));
`).some((e) => e.includes("'message'"))).toBe(true);
  });
});
