// Regression: destructuring an UNANNOTATED static factory off a CommonJS
// default-imported value must resolve the source module's inferred static
// signature — not fall back to a fresh type variable.
//
// A module assigns `Response.Redirect = _Redirect;` WITHOUT a
// `// Response.Redirect :: ...` annotation.  `_Redirect` is annotated
// (`// _Redirect :: Number -> String -> Response a`).  A consumer that does
// `const Response = require("./Response")` followed by
// `const { Redirect } = Response` must see
// `Redirect :: Number -> String -> Response a`, inferred transitively from
// `_Redirect`'s type.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { resetTypeVarCounter, prettyTypeToString } from '../../src/hm/types';

const tmpRoot = '/tmp/hm-unannotated-static-destructure-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  writeFile('express/Response.js', [
    '"use strict";',
    '// Response :: Redirect Number String | Render String Number',
    'function Response(){ throw TypeError ("nope"); }',
    '// Redirect :: (Number, String) -> Response a',
    'function Redirect(status, url) { this.status = status; this.url = url; }',
    '// Render :: (String, Number) -> Response a',
    'function Render(view, code) { this.view = view; this.code = code; }',
    'Redirect.prototype = Object.create (Response.prototype);',
    'Render.prototype = Object.create (Response.prototype);',
    '// _Redirect :: Number -> String -> Response a',
    'function _Redirect(status) { return url => new Redirect (status, url); }',
    '// _Render :: String -> Number -> Response a',
    'function _Render(view) { return code => new Render (view, code); }',
    // NO `// Response.Redirect :: ...` / `// Response.Render :: ...` annotations
    'Response.Redirect = _Redirect;',
    'Response.Render = _Render;',
    'module.exports = Response;',
  ].join('\n'));
});

beforeEach(() => resetTypeVarCounter());

function nodeTypeOf(source: string, needle: string): string | undefined {
  const consumerPath = writeFile('express/Response.spec.js', source);
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

describe('destructuring UNANNOTATED static members off a plain-require default import', () => {
  test('const { Redirect } = Response resolves inferred factory signature', () => {
    const source = [
      '"use strict";',
      'const Response = require ("./Response");',
      'const { Redirect, Render } = Response;',
      'Redirect;',
    ].join('\n');
    expect(nodeTypeOf(source, 'Redirect, Render')).toBe('Number -> String -> Response a');
  });

  test('const { Render } = Response resolves inferred factory signature', () => {
    const source = [
      '"use strict";',
      'const Response = require ("./Response");',
      'const { Redirect, Render } = Response;',
      'Render;',
    ].join('\n');
    expect(nodeTypeOf(source, 'Render } =')).toBe('String -> Number -> Response a');
  });
});
