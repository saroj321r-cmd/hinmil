import * as fs from 'fs';
import * as path from 'path';
import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { ImportInferenceContext } from '../../src/services/importContext';
import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

beforeEach(() => resetTypeVarCounter());

/**
 * Regression: `// ::types ./demo2.js` resolves a file containing a
 * recursive alias (`Person :: { ..., friends :: [Person] }`).  Prior to
 * the fix in `expandAnnotationAliases`, repeated `infer()` calls
 * mutated the cached annotation objects returned by `extractAnnotations`,
 * doubling the depth of the expanded `Person` body on every pass.
 * After ~10 iterations the resulting type tree exceeded the V8 stack and
 * surfaced as `"Inference aborted: Maximum call stack size exceeded"` in
 * the language server (e.g. when the user requested hover on `Either`
 * after typing `Either.` 10+ times in `eitherExtends.js`).
 */
test('repeated infer of eitherExtends.js with ::types directive stays stable', () => {
  const file = path.join(__dirname, '../../sample/eitherExtends.js');
  const uri = 'file://' + file;
  const src = fs.readFileSync(file, 'utf8');
  const docs = new TextDocuments(TextDocument);
  const importCtx = new ImportInferenceContext(docs as never, { warn: () => {} });
  const resolver = importCtx.createImportResolver(uri);
  const typeResolver = importCtx.createTypeDirectiveResolver(uri);
  const aliasResolver = importCtx.createImportTypeAliasResolver(uri);

  for (let i = 0; i < 25; i++) {
    const engine = new InferenceEngine();
    expect(() =>
      engine.infer(src, undefined, resolver, typeResolver, aliasResolver),
    ).not.toThrow();
  }
});
