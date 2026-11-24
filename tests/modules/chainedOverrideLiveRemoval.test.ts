import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { resetTypeVarCounter } from '../../src/hm/types';
import {
  snapshotBuiltinOriginalEntries,
  restoreBuiltinOriginalEntries,
  snapshotMethodRegistry,
} from '../../src/registries/methodRegistry';

// Regression: a chained builtin-method override declared in an imported file
// (e.g. `// natives.Array :: Array#reduce :: Array a ~> ...`) registers
// `Array#reduce` so consumers' `Foldable Array` constraints are satisfied.
// Removing that override on a live TYPE edit (no save) must immediately
// un-satisfy the constraint in importers.  Previously the override leaked into
// the global method registry and was re-baked into the open document's cached
// snapshot (because the snapshot was taken AFTER `safeEngineInfer` restored the
// pre-infer builtin entries), so importers kept seeing the stale override until
// a save re-populated the cache through the separate-engine path.
//
// The fix captures the method-registry snapshot inside `safeEngineInfer`,
// right after `engine.infer` and BEFORE the builtin-originals restore, and
// caches THAT.  This test mirrors the server's validate ordering.

const tmpRoot = '/tmp/hm-chained-override-live-removal';
const globalsSrc =
  '// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

const chainedReduce = [
  '"use strict";',
  'let natives = {};',
  '// natives.Array :: Array#reduce :: Array a ~> (b -> a -> b) -> b -> b',
  'natives.Array = function (fn) {',
  '  return init => this.reduce ((acc, value) => fn (acc) (value), init);',
  '};',
  '// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b',
  'const reduce = fn => init => foldable => natives.Array (fn) (init);',
  'module.exports = reduce;',
].join('\n');

const plainReduce = chainedReduce.replace(
  '// natives.Array :: Array#reduce :: Array a ~> (b -> a -> b) -> b -> b',
  '// natives.Array :: Array a ~> (b -> a -> b) -> b -> b',
);

const sizeSrc = [
  '"use strict";',
  'const reduce = require ("./reduce");',
  '// size :: Foldable f => f a -> Number',
  'const size = foldable => reduce (n => _i => n + 1) (0) (foldable);',
  'size ([1, 2, 3]);',
  'module.exports = size;',
].join('\n');

let reduceUri: string;
let sizeUri: string;
let engine: InferenceEngine;
let ctx: ImportInferenceContext;

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  reduceUri = pathToFileURL(writeFile('reduce.js', chainedReduce)).href;
  sizeUri = pathToFileURL(writeFile('size.js', sizeSrc)).href;
});

beforeEach(() => resetTypeVarCounter());

// Mirror server.validateTextDocument: pre-warm imports, run engine.infer
// guarded by builtin-originals snapshot/restore, capture the method snapshot
// BEFORE the restore (as the real safeEngineInfer now does), then cache it.
function validate(uri: string, src: string): string[] {
  if (uri === sizeUri) {
    ctx.inferFileAndCacheExports(reduceUri);
  }
  const snap = snapshotBuiltinOriginalEntries();
  let result;
  let methodSnap;
  try {
    result = engine.infer(
      src,
      undefined,
      ctx.createImportResolver(uri),
      ctx.createTypeDirectiveResolver(uri),
      ctx.createImportTypeAliasResolver(uri),
    );
    methodSnap = snapshotMethodRegistry();
  } finally {
    restoreBuiltinOriginalEntries(snap);
  }
  ctx.cacheExportsWithSnapshot(uri, result.exports, methodSnap);
  return result.diagnostics.map((d) => d.message);
}

test('removing a chained Array#reduce override un-satisfies Foldable in importers without a save', () => {
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  ctx = new ImportInferenceContext(docs, { warn: () => {} });
  ctx.setProjectConfig(tmpRoot, { globalsSource: globalsSrc });
  engine = new InferenceEngine();
  engine.globalsSource = globalsSrc;

  // STEP 1: reduce.js has the chained form.  size.js pulls it as a cache miss
  // (separate-engine path), registering the Array#reduce override → Foldable
  // is satisfied and size.js is clean.
  fs.writeFileSync(path.join(tmpRoot, 'reduce.js'), chainedReduce);
  ctx.invalidateFileCache(reduceUri);
  ctx.invalidateFileCache(sizeUri);
  const step1 = validate(sizeUri, sizeSrc);
  expect(step1.filter((m) => /Foldable|reduce/.test(m))).toEqual([]);

  // STEP 2: user removes the chained form via a live TYPE edit (no save).
  // Mirror the onDidChangeContent invalidation cascade; reduce.js re-validates
  // first (shorter debounce) through the open-document path.
  fs.writeFileSync(path.join(tmpRoot, 'reduce.js'), plainReduce);
  ctx.invalidateFileCache(reduceUri);
  ctx.invalidateFileCache(sizeUri);
  validate(reduceUri, plainReduce);

  // STEP 3: size.js re-validates.  The Foldable diagnostic must come back now,
  // not only after a save.
  const step3 = validate(sizeUri, sizeSrc);
  expect(step3.filter((m) => /Foldable|reduce/.test(m)).length).toBeGreaterThan(0);
});
