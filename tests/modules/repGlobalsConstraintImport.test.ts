// Regression: a `::rep` whose constraint is defined in the PROJECT GLOBALS
// (e.g. `src/globals.js` declaring `// ::constraint Foldable ...`) must still
// bind when the file is inferred through the cross-module import engine
// (`inferFileAndCacheExports`) — the cache-cold path a SAVE forces after the
// export cache is invalidated.
//
// `infer()` calls `clearConstraints()` and then re-registers constraints ONLY
// from `engine.globalsSource`.  The import engine previously received just the
// `::types`/package sidecar addendum, NOT the user-authored project globals, so
// `lookupConstraint('Foldable')` failed there and the rep was silently dropped
// from the exported scheme — surfacing the constraint diagnostic again on save
// even though typing (which hit the warm open-document cache) looked fine.
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ImportInferenceContext } from '../../src/services/importContext';
import { resetTypeVarCounter } from '../../src/hm/types';

const tmpRoot = '/tmp/hm-rep-save-cycle';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

const globalsSrc =
  '// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }';

const reduceSrc = [
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
].join('\n');

let reduceUri: string;

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  reduceUri = pathToFileURL(writeFile('fl/reduce.js', reduceSrc)).href;
});

beforeEach(() => resetTypeVarCounter());

describe('::rep with a globals-defined constraint survives the import (save) path', () => {
  test('inferFileAndCacheExports attaches reps when the constraint lives in project globals', () => {
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpRoot, { globalsSource: globalsSrc });
    const exp = ctx.inferFileAndCacheExports(reduceUri);
    const reps = exp?.get('default')?.reps ?? [];
    expect(reps.length).toBeGreaterThan(0);
    expect(reps[0].constraint).toBe('Foldable');
  });
});
