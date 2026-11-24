// Subpath-aware conventional `<typesDir>/` stubs.
//
// A CJS utility library (modeled on fpkit) is typically consumed via deep
// imports (`import RTask from "fpkit/RTask/index.js"`) because the package
// root would load hundreds of modules and — without an `exports` field —
// named ESM imports of object-literal exports fail under Node's
// cjs-module-lexer. The package-level stub `<typesDir>/fpkit.hm` describes
// the ROOT module's default export, which is the wrong shape for a deep
// import. These tests cover the subpath-aware stub lookup chain:
//
//   `fpkit/RTask/index.js` → 1. `<typesDir>/fpkit/RTask/index.hm` (exact)
//                           2. `<typesDir>/fpkit/RTask.hm`       (`/index` stripped)
//                           3. `<typesDir>/fpkit.hm`             (package stub — legacy fallback)

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';

const tmpRoot = '/tmp/hm-subpath-stub-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function inferConsumer(consumerRel: string) {
  const consumerPath = path.join(tmpRoot, consumerRel);
  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  ctx.setProjectConfig(tmpRoot, {});
  const resolver = ctx.createImportResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const eng = new InferenceEngine();
  return eng.infer(fs.readFileSync(consumerPath, 'utf8'), undefined, resolver, undefined, aliasResolver);
}

function exportType(result: ReturnType<typeof inferConsumer>, name: string): string {
  const scheme = result.exports.get(name);
  if (!scheme) return '<missing>';
  return (require('../../src') as typeof import('../../src')).schemeToString(scheme);
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  // Fake CJS utility package `fpkit` WITHOUT an `exports` field (deep
  // imports resolve as plain files) and without its own sidecars.
  writeFile('node_modules/fpkit/package.json', JSON.stringify({
    name: 'fpkit',
    main: './index.js',
  }));
  writeFile('node_modules/fpkit/index.js', [
    '"use strict";',
    'module.exports = {',
    '  RTask: require ("./RTask/index.js"),',
    '  serieRTask: require ("./RTask/serieRTask.js")',
    '};',
  ].join('\n'));
  writeFile('node_modules/fpkit/RTask/index.js', [
    '"use strict";',
    'function RTask(fork) { this.fork = fork; }',
    'RTask.of = function (x) { return new RTask ((rej, res, env) => res (x)); };',
    'module.exports = RTask;',
  ].join('\n'));
  writeFile('node_modules/fpkit/RTask/serieRTask.js', [
    '"use strict";',
    'module.exports = fn => xs => xs.reduce ((acc, x) => acc.chain (() => fn (x)), null);',
  ].join('\n'));

  // Package-level stub: types the ROOT module's default export.
  writeFile('hm-types/fpkit.hm', [
    'default :: { RTask :: { of :: a -> RTask r e a }, ...rest }',
    '',
    'RTask#map :: RTask r e a ~> (a -> b) -> RTask r e b',
    '',
  ].join('\n'));

  // Exact subpath stub for the deep import `fpkit/RTask/index.js`.
  writeFile('hm-types/fpkit/RTask/index.hm', [
    'default :: { of :: a2 -> RTask r2 e2 a2, reject :: e3 -> RTask r3 e3 a3 }',
    '',
    'RTask#chain :: RTask r e a ~> (a -> RTask r e b) -> RTask r e b',
    '',
  ].join('\n'));

  // `/index`-stripped stub for the deep import `fpkit/RTask/serieRTask.js`.
  writeFile('hm-types/fpkit/RTask/serieRTask.hm', [
    'default :: (a -> RTask r e b) -> [a] -> RTask r e b',
    '',
  ].join('\n'));
});

describe('subpath-aware conventional stubs', () => {
  test('deep import uses the exact `<typesDir>/<pkg>/<subpath>.hm` stub', () => {
    writeFile('src/deep.js', [
      'import RTask from "fpkit/RTask/index.js";',
      '',
      'export const t = RTask.of (1);',
      'export const u = RTask.reject ("boem");',
    ].join('\n'));
    const result = inferConsumer('src/deep.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
    expect(exportType(result, 't')).toMatch(/^RTask \S+ \S+ Number$/);
    expect(exportType(result, 'u')).toMatch(/^RTask \S+ String \S+$/);
  });

  test('deep import registers the subpath stub\u2019s Type#method annotations', () => {
    writeFile('src/deepMethod.js', [
      'import RTask from "fpkit/RTask/index.js";',
      '',
      'export const t = RTask.of (1).chain (x => RTask.of (x + 1));',
    ].join('\n'));
    const result = inferConsumer('src/deepMethod.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
    expect(exportType(result, 't')).toMatch(/^RTask \S+ \S+ Number$/);
  });

  test('`/index`-less stub matches an `/index.js`-suffixed specifier and vice versa', () => {
    // `fpkit/RTask/serieRTask.js` has no exact `serieRTask/index.hm`; the
    // extension-stripped `serieRTask.hm` candidate must match.
    writeFile('src/serie.js', [
      'import serieRTask from "fpkit/RTask/serieRTask.js";',
      'import RTask from "fpkit/RTask/index.js";',
      '',
      '// run :: [Number] -> RTask r e Number',
      'export const run = serieRTask (x => RTask.of (x));',
    ].join('\n'));
    const result = inferConsumer('src/serie.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('deep import without a subpath stub still falls back to the package stub', () => {
    writeFile('src/fallback.js', [
      'import util from "fpkit/RTask/unstubbed.js";',
      '',
      'export const t = util.RTask.of (1);',
    ].join('\n'));
    writeFile('node_modules/fpkit/RTask/unstubbed.js', [
      '"use strict";',
      'module.exports = { RTask: require ("./index.js") };',
    ].join('\n'));
    const result = inferConsumer('src/fallback.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
    expect(exportType(result, 't')).toMatch(/^RTask \S+ \S+ Number$/);
  });

  test('root import keeps using the package-level stub', () => {
    writeFile('src/root.js', [
      'import fpkit from "fpkit";',
      '',
      'const { RTask } = fpkit;',
      '',
      'export const t = RTask.of (1).map (x => x + 1);',
    ].join('\n'));
    const result = inferConsumer('src/root.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
    expect(exportType(result, 't')).toMatch(/^RTask \S+ \S+ Number$/);
  });
});
