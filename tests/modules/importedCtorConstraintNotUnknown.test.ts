// Regression: a type used as a constructor-constraint (`Pair p => …`) must
// not be reported as an "Unknown constraint" in a CONSUMER file when the type
// is known only through the method registry (populated by an import), rather
// than through the local `dataTypeRegistry`, `annotationMap`, or
// `importedConstructors`.
//
// Real case (fpkit): `Arrow/index.js` declares
//   // Arrow#second :: Pair p => Arrow a b ~> () -> Arrow (p c a) (p c b)
// and pulls in `Pair` via `// ::types ../Pair/index`.  In `Arrow/index.spec.js`
// calling `.second()` reported
//   "Unknown constraint 'Pair'. Define it with `// ::constraint Pair p { ... }`"
// because in the consumer engine `Pair` was registered in the method registry
// (arity 2, prototype methods) but not recognised by the four
// `namesKnownConstructor` checks.  Fix: also accept a type whose constructor
// arity is known (`typeConstructorArity(name) > 0`) — src/infer/index.ts.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { resetTypeVarCounter } from '../../src/hm/types';

const tmpRoot = '/tmp/hm-imported-ctor-constraint-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  // A `Pair`-like bifunctor type, exported from its own module.  Its
  // prototype method registers `Pair` (arity 2) in the METHOD REGISTRY —
  // the path the fix relies on (the consumer never sees `Pair` in its own
  // annotationMap / dataTypeRegistry / importedConstructors).
  writeFile('Pair.js', [
    '"use strict";',
    '// Pair :: (a, b) -> Pair a b',
    'function Pair(fst, snd) { this.fst = fst; this.snd = snd; }',
    '',
    '// Pair#bimap :: Pair a b ~> (a -> c) -> (b -> d) -> Pair c d',
    'Pair.prototype.bimap = function (f, g) { return new Pair(f(this.fst), g(this.snd)); };',
    '',
    'module.exports = { Pair };',
  ].join('\n'));

  // A `Box` type whose method uses `Pair p =>` as a constructor-constraint.
  // It imports Pair's declarations via a `::types` directive, exactly like
  // the fpkit `Arrow/index.js` does for `../Pair/index`.
  writeFile('Box.js', [
    '"use strict";',
    'const { Pair } = require("./Pair");',
    '// ::types ./Pair',
    '',
    '// Box :: a -> Box a',
    'function Box(value) { this.value = value; }',
    '',
    '// Box#pairUp :: Pair p => Box a ~> () -> Box (p a a)',
    'Box.prototype.pairUp = function () { return new Box(new Pair(this.value, this.value)); };',
    '',
    'module.exports = { Box };',
  ].join('\n'));
});

beforeEach(() => resetTypeVarCounter());

function inferConsumer(source: string): string[] {
  const consumerPath = writeFile('consumer.js', source);
  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  const eng = new InferenceEngine();
  const r = eng.infer(
    source,
    undefined,
    ctx.createImportResolver(fileUri),
    ctx.createTypeDirectiveResolver(fileUri),
    ctx.createImportTypeAliasResolver(fileUri),
  );
  return r.diagnostics.map((d) => d.message);
}

describe('imported constructor-constraint is not "unknown" in a consumer', () => {
  test('calling `.pairUp()` (whose signature uses `Pair p =>`) reports no Unknown-constraint diag', () => {
    const diags = inferConsumer([
      'const { Box } = require("./Box");',
      'const b = new Box(1);',
      'const p = b.pairUp();',
    ].join('\n'));
    const unknown = diags.filter((d) => /Unknown constraint 'Pair'/.test(d));
    expect(unknown).toEqual([]);
  });
});
