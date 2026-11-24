// Regression tests for cross-module `::rep` propagation.
//
// A `::rep Foldable Array#reduce` directive declared in a module that exports
// a constrained function (`reduce :: Foldable f => ...`) must travel with that
// function's scheme across the import boundary — including via a CommonJS
// default export (`module.exports = reduce`).  An importing module that calls
// the imported function (or re-exports its own constrained wrapper) must be
// able to discharge the same constraint for the same container type without
// re-declaring the rep.
//
// Covers the two bugs fixed alongside the rep restoration:
//   1. The default-export branch of `buildExportMap` dropped `scheme.reps`.
//   2. Imported reps were not merged into the importing file's own rep set,
//      so the importer's *own* constraint (and re-export) could not see them.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { resetTypeVarCounter } from '../../src/hm/types';

const tmpRoot = '/tmp/hm-rep-cross-module-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  // `reduce` carries a `::rep` letting Array satisfy Foldable, and is
  // exported as a CommonJS default (`module.exports = reduce`).
  writeFile('fl/reduce.js', [
    '"use strict";',
    'let natives = {};',
    '// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }',
    '// ::rep Foldable Array#reduce',
    '// natives.Array :: Array a ~> (b -> a -> b) -> b -> b',
    'natives.Array = function (fn) {',
    '  return init => this.reduce ((acc, value) => fn (acc) (value), init);',
    '};',
    '// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b',
    'const reduce = fn => init => foldable => natives.Array (fn) (init);',
    'module.exports = reduce;',
  ].join('\n'));
});

beforeEach(() => resetTypeVarCounter());

function inferConsumer(rel: string, source: string): string[] {
  const consumerPath = writeFile(rel, source);
  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  const resolver = ctx.createImportResolver(fileUri);
  const typeResolver = ctx.createTypeDirectiveResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const eng = new InferenceEngine();
  return eng.infer(source, undefined, resolver, typeResolver, aliasResolver)
    .diagnostics.map(d => d.message);
}

describe('cross-module ::rep propagation', () => {
  test('imported reduce (default export) lets size run with an Array via its rep', () => {
    const diags = inferConsumer('lst/size.js', [
      '"use strict";',
      'const reduce = require ("../fl/reduce");',
      '// size :: Foldable f => f a -> Number',
      'const size = foldable => reduce (n => _item => n + 1) (0) (foldable);',
      'size([1, 2, 3]);',
      'module.exports = size;',
    ].join('\n'));
    expect(diags.filter(m => /Foldable/.test(m))).toEqual([]);
  });

  test('directly calling imported reduce with an Array literal is accepted', () => {
    const diags = inferConsumer('lst/direct.js', [
      '"use strict";',
      'const reduce = require ("../fl/reduce");',
      'reduce (n => _item => n + 1) (0) ([1, 2, 3]);',
    ].join('\n'));
    expect(diags.filter(m => /Foldable/.test(m))).toEqual([]);
  });

  test('a re-exported constrained wrapper further propagates the imported rep', () => {
    // size re-exports its own `Foldable f =>` wrapper; a third module importing
    // size must still be able to call it with an Array.
    writeFile('lst/size.js', [
      '"use strict";',
      'const reduce = require ("../fl/reduce");',
      '// size :: Foldable f => f a -> Number',
      'const size = foldable => reduce (n => _item => n + 1) (0) (foldable);',
      'module.exports = size;',
    ].join('\n'));
    const diags = inferConsumer('app/main.js', [
      '"use strict";',
      'const size = require ("../lst/size");',
      'size([1, 2, 3]);',
    ].join('\n'));
    expect(diags.filter(m => /Foldable/.test(m))).toEqual([]);
  });
});
