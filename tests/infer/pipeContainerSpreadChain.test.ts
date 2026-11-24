// Container-wrapped spread arrow-chain combinator (`pipe`) — a `Foldable`
// container `f (a -> b, b -> c, ..., y -> z)` must behave EXACTLY like the
// bare spread-array chain `[a -> b, ..., y -> z]` (demo2 ex3/ex8):
//
//   pipe :: Foldable f => f (a -> b, b -> c, ..., y -> z) -> a -> z
//   const pipe = foldable => value => reduce (applyTo) (value) (foldable);
//
// Two regressions are covered:
//   1. The `pipe` body (`reduce (applyTo) (value) (foldable)`) must not emit a
//      spurious chain-vs-arrow unification mismatch.
//   2. A consumer call `pipe([f, g])(x)` must not melt the two heterogeneous
//      element result types into a single `String`/`Number` clash.
//
// The fan-out combinator (`converge`) uses the SAME container-of-arrows shape
// but a multi-arity head; it must keep flowing through `matchFanOutCallee`.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { resetTypeVarCounter } from '../../src/hm/types';

const tmpRoot = path.join('/tmp', 'hm-pipe-container-spread-test');
const GLOBALS =
  '// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  writeFile('globals.js', GLOBALS);
  writeFile(
    'fl/reduce.js',
    [
      '"use strict";',
      'let natives = {};',
      '// ::rep Foldable Array#reduce',
      '// natives.Array :: Array a ~> (b -> a -> b) -> b -> b',
      'natives.Array = function (fn) {',
      '  return init => this.reduce ((acc, value) => fn (acc) (value), init);',
      '};',
      '// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b',
      'const reduce = fn => init => foldable => natives.Array (fn) (init);',
      'module.exports = reduce;',
    ].join('\n'),
  );
  writeFile(
    'combinator/applyTo.js',
    [
      '"use strict";',
      '// applyTo :: a -> (a -> b) -> b',
      'const applyTo = value => fn => fn (value);',
      'module.exports = applyTo;',
    ].join('\n'),
  );
  writeFile(
    'combinator/pipe.js',
    [
      '"use strict";',
      'const reduce = require ("../fl/reduce");',
      'const applyTo = require ("./applyTo");',
      '// pipe :: Foldable f => f (a -> b, b -> c, ..., y -> z) -> a -> z',
      'const pipe = foldable => value =>',
      '  reduce (applyTo) (value) (foldable);',
      'module.exports = pipe;',
    ].join('\n'),
  );
});

beforeEach(() => resetTypeVarCounter());

function diagsFor(rel: string, consumerSrc: string): string[] {
  const consumerPath = writeFile(rel, consumerSrc);
  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  ctx.setProjectConfig(tmpRoot, {
    globalsSource: GLOBALS,
    globalsFilePath: path.join(tmpRoot, 'globals.js'),
  });
  const resolver = ctx.createImportResolver(fileUri);
  const typeResolver = ctx.createTypeDirectiveResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const eng = new InferenceEngine();
  eng.globalsSource = GLOBALS;
  return eng
    .infer(consumerSrc, undefined, resolver, typeResolver, aliasResolver)
    .diagnostics.map(d => d.message);
}

test('pipe.js body infers cleanly against its chain-container annotation', () => {
  const src = [
    '"use strict";',
    'const reduce = require ("../fl/reduce");',
    'const applyTo = require ("./applyTo");',
    '// pipe :: Foldable f => f (a -> b, b -> c, ..., y -> z) -> a -> z',
    'const pipe = foldable => value =>',
    '  reduce (applyTo) (value) (foldable);',
    'module.exports = pipe;',
  ].join('\n');
  expect(diagsFor('combinator/pipeBody.js', src)).toEqual([]);
});

test('a heterogeneous pipe call does not melt element results together', () => {
  const src = [
    '"use strict";',
    'const pipe = require ("./pipe");',
    'const res = pipe ([x => x + 1, x => "x"]) (3);',
  ].join('\n');
  expect(diagsFor('combinator/pipeCall.js', src)).toEqual([]);
});
