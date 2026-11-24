// Consumer-side typing of a CommonJS package that ships INLINE annotations
// and no `.hm` sidecar — modeled on fpkit as installed in the app's
// `server/node_modules/fpkit` (buble build of `src/`, comments preserved):
//
//   index.js        module.exports = { RTask: require ("./RTask"), nil: … }   (barrel)
//   RTask/index.js  function RTask(fork) {…}; function rtask(fork) {…};
//                   rtask.of = RTask.of = …;  RTask.prototype.map = …;
//                   module.exports = rtask;
//   predicate/nil.js  module.exports = nil;
//   string/case.js    exports.upper = …;  exports.lower = …;
//
// Previously the consumer saw `RTask :: Any` (named import from the root:
// the name-based inline scan never modeled `module.exports`) or an
// "Unbound variable" (default/subpath import: no `default` export), so the
// app server needed a hand-written `hm-types/fpkit/RTask.hm` stub.  Such a
// package is now inferred like local source, for every import form.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { typeToString } from '../../src/hm/types';
import { ImportInferenceContext } from '../../src/services/importContext';
import { clearInlinePackageCache } from '../../src/services/files';

const tmpRoot = '/tmp/hm-inline-cjs-package-test';

function writeFile(rel: string, content: string): void {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function infer(consumerSource: string) {
  const consumerPath = path.join(tmpRoot, 'server/src/lib/rtask.js');
  fs.mkdirSync(path.dirname(consumerPath), { recursive: true });
  fs.writeFileSync(consumerPath, consumerSource);
  const fileUri = pathToFileURL(consumerPath).href;
  const ctx = new ImportInferenceContext(new TextDocuments<TextDocument>(TextDocument as never), { warn: () => {} });
  ctx.setProjectConfig(path.join(tmpRoot, 'server'), {});
  const result = new InferenceEngine().infer(
    consumerSource, undefined, ctx.createImportResolver(fileUri), undefined, ctx.createImportTypeAliasResolver(fileUri),
  );
  const typeOf = (name: string) => {
    const s = result.topLevelBindings.get(name);
    return s ? typeToString(result.substitution.apply(s.type)) : undefined;
  };
  return { diags: result.diagnostics.map(d => d.message), typeOf };
}

const PKG = 'server/node_modules/funclib';

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  clearInlinePackageCache();
  writeFile(`${PKG}/package.json`, JSON.stringify({ name: 'funclib', version: '1.0.6', main: './index.js' }));
  writeFile(`${PKG}/index.js`, [
    '"use strict";',
    '',
    'module.exports = {',
    '// RTask',
    '  RTask: require ("./RTask"),',
    '// predicate',
    '  nil: require ("./predicate/nil"),',
    '// string',
    '  upper: require ("./string/case").upper',
    '};',
  ].join('\n'));
  writeFile(`${PKG}/predicate/nil.js`, [
    '"use strict";',
    '',
    '// nil :: a -> Boolean',
    'const nil = x => x == null;',
    '',
    'module.exports = nil;',
  ].join('\n'));
  writeFile(`${PKG}/string/case.js`, [
    '"use strict";',
    '',
    '// upper :: String -> String',
    'exports.upper = s => s.toUpperCase ();',
    '',
    '// lower :: String -> String',
    'exports.lower = s => s.toLowerCase ();',
  ].join('\n'));
  writeFile(`${PKG}/RTask/index.js`, [
    '"use strict";',
    '',
    'const nil = require ("../predicate/nil");',
    '',
    '// Rej :: e -> ()',
    '// Res :: a -> ()',
    '// RTask :: ((Rej, Res, r) -> *) -> RTask r e a',
    'function RTask(fork) {',
    '  // RTask#fork :: RTask r e a ~> (e -> b, a -> b, r) -> * | (() -> ())',
    '  this.fork = fork;',
    '}',
    '',
    '// rtask :: ((Rej, Res, r) -> *) -> RTask r e a',
    'function rtask(fork) {',
    '  return new RTask (fork);',
    '}',
    '',
    '// rtask.of :: a -> RTask r e a',
    'rtask.of = RTask.of = function (a) {',
    '  return rtask ((_, res) => res (a));',
    '};',
    '',
    '// rtask.reject :: e -> RTask r e a',
    'rtask.reject = RTask.reject = function (e) {',
    '  return rtask (rej => rej (e));',
    '};',
    '',
    '// rtask.ask :: () -> RTask r e r',
    '// rtask.ask :: (r -> a) -> RTask r e a',
    'rtask.ask = RTask.ask = function (fn) {',
    '  return rtask ((_, res, env) => res (nil (fn) ? env : fn (env)));',
    '};',
    '',
    '// rtask.fromPromise :: (a -> Promise e b) -> a -> RTask r e b',
    'rtask.fromPromise = RTask.fromPromise = function (fn) {',
    '  return a => rtask ((rej, res) => { fn (a).then (res, rej); });',
    '};',
    '',
    '// RTask#map :: RTask r e a ~> (a -> b) -> RTask r e b',
    'RTask.prototype.map = function (fn) {',
    '  const self = this;',
    '  return rtask ((rej, res, env) => self.fork (rej, x => res (fn (x)), env));',
    '};',
    '',
    '// RTask#chain :: RTask r e a ~> (a -> RTask r e b) -> RTask r e b',
    'RTask.prototype.chain = function (fn) {',
    '  const self = this;',
    '  return rtask ((rej, res, env) => self.fork (rej, x => fn (x).fork (rej, res, env), env));',
    '};',
    '',
    'module.exports = rtask;',
  ].join('\n'));
});

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// The app adapter (server/src/lib/rtask.js), parameterised by import form.
const adapter = (importLine: string) => [
  importLine,
  '',
  'export const fromPromiseFn = RTask.fromPromise;',
  'export const withEnv = fn => RTask.ask ().chain (env => RTask.fromPromise (fn) (env));',
  'export const answer = RTask.of (41).map (n => n + 1);',
].join('\n');

const IMPORT_FORMS: [string, string][] = [
  ['named import from the package root', 'import { RTask } from "funclib";'],
  ['default import of the subpath', 'import RTask from "funclib/RTask";'],
  ['default import of the subpath /index', 'import RTask from "funclib/RTask/index";'],
  ['default import of the subpath /index.js', 'import RTask from "funclib/RTask/index.js";'],
  ['require of the subpath', 'const RTask = require ("funclib/RTask");'],
  ['destructured require of the root', 'const { RTask } = require ("funclib");'],
  ['property of the root default import', 'import funclib from "funclib";\nconst RTask = funclib.RTask;'],
];

describe.each(IMPORT_FORMS)('%s', (_label, importLine) => {
  test('statics, overloads and methods come from the inline annotations', () => {
    const { diags, typeOf } = infer(adapter(importLine));
    expect(diags).toEqual([]);
    expect(typeOf('fromPromiseFn')).toMatch(/^\(a -> Promise e b\) -> a -> RTask r e b$/);
    expect(typeOf('answer')).toMatch(/^RTask \w+ \w+ Number$/);
    expect(typeOf('withEnv')).toMatch(/RTask/);
  });

  test('a real type error in the consumer is reported', () => {
    const { diags } = infer(adapter(importLine) + '\nexport const bad = RTask.of (1).map (s => s.toUpperCase ());');
    expect(diags.join('\n')).toMatch(/toUpperCase|Number/);
  });
});

describe('other CommonJS export shapes', () => {
  test('`module.exports = nil` is the default; barrel property is typed', () => {
    const { diags, typeOf } = infer([
      'import nil from "funclib/predicate/nil";',
      'import { upper } from "funclib";',
      'export const missing = nil (undefined);',
      'export const shout = upper ("deliverable");',
    ].join('\n'));
    expect(diags).toEqual([]);
    expect(typeOf('missing')).toBe('Boolean');
    expect(typeOf('shout')).toBe('String');
  });

  test('`exports.X = …` module: named and default (exports object) imports', () => {
    const { diags, typeOf } = infer([
      'import { lower } from "funclib/string/case";',
      'import cases from "funclib/string/case";',
      'export const quiet = lower ("DONE");',
      'export const loud = cases.upper ("deliverable");',
    ].join('\n'));
    expect(diags).toEqual([]);
    expect(typeOf('quiet')).toBe('String');
    expect(typeOf('loud')).toBe('String');
  });

  test('importing a name the package does not export is reported', () => {
    const { diags } = infer('import { Future } from "funclib";\n');
    expect(diags).toEqual([expect.stringMatching(/'Future' is not exported from 'funclib'/)]);
  });

  test('a non-relative, non-package specifier reports "Cannot resolve module", not "Unbound variable: require"', () => {
    const { diags } = infer('const RTask = require ("src/RTask");\nconst probe = { RTask: require ("src/RTask") };\n');
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) expect(d).toMatch(/Cannot resolve module 'src\/RTask'/);
  });
});
