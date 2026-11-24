// Regression: destructuring static members off a CommonJS default-imported
// value must resolve the source module's static-member export types.
//
// A module exports a callable default (`module.exports = List`) whose static
// props are annotated (`// List.Cons :: a -> List a -> List a`).  A consumer
// that does `const List = require("../List")` followed by
// `const { Nil, Cons } = List` must see `Cons :: a -> List a -> List a`.
//
// Bug: the plain-require handler bound `List` to the default-export scheme but
// (unlike the ES `import List from '...'` path) never registered the source
// specifier in `defaultImportSources`.  So `inferObjectDestructuring` could
// not look up the module's static exports and fell back to a fresh `a`,
// making hover show `Cons :: a`.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { resetTypeVarCounter, prettyTypeToString } from '../../src/hm/types';

const tmpRoot = '/tmp/hm-cons-destructure-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  writeFile('List/index.js', [
    '"use strict";',
    '// List :: Nil | Cons a',
    'function List(){ throw TypeError ("nope"); };',
    '// Nil :: () -> List a',
    'function Nil() {}',
    '// Cons :: (a, List a) -> List a',
    'function Cons(head, tail) { this.head = head; this.tail = tail; }',
    'Nil.prototype = Object.create (List.prototype);',
    'Cons.prototype = Object.create (List.prototype);',
    '// _Cons :: a -> List a -> List a',
    'function _Cons(head) { return tail => new Cons (head, tail); }',
    '// List.Nil :: List a',
    'List.Nil = new Nil ();',
    '// List.Cons :: a -> List a -> List a',
    'List.Cons = _Cons;',
    '// List.of :: a -> List a',
    'List.of = function (value) { return _Cons (value) (List.Nil); };',
    'module.exports = List;',
  ].join('\n'));
});

beforeEach(() => resetTypeVarCounter());

function nodeTypeOf(source: string, needle: string): string | undefined {
  const consumerPath = writeFile('lst/reverse.spec.js', source);
  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  const resolver = ctx.createImportResolver(fileUri);
  const typeResolver = ctx.createTypeDirectiveResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const eng = new InferenceEngine();
  eng.infer(source, undefined, resolver, typeResolver, aliasResolver);
  const offset = source.indexOf(needle);
  const entry = eng.nodeTypes.get(offset);
  return entry ? prettyTypeToString(entry.type) : undefined;
}

describe('destructuring static members off a plain-require default import', () => {
  test('const { Nil, Cons } = List resolves Cons full signature', () => {
    const source = [
      '"use strict";',
      'const List = require ("../List");',
      'const { Nil, Cons } = List;',
      'Cons;',
    ].join('\n');
    expect(nodeTypeOf(source, 'Cons }')).toBe('a -> List a -> List a');
  });

  test('const { Nil } = List resolves Nil type', () => {
    const source = [
      '"use strict";',
      'const List = require ("../List");',
      'const { Nil } = List;',
      'Nil;',
    ].join('\n');
    expect(nodeTypeOf(source, 'Nil }')).toBe('List a');
  });
});
