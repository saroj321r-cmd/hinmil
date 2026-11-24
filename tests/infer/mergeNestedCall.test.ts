// Repro: nested `one(x.concat(y))` triggered
// "Cannot unify '{...}' with 'Merge {...} {...}'" because the Merge
// markers in `.concat`'s result row leaked past unification when the
// surrounding call's parameter slot was an unannotated TVar that
// later got unified against a concrete record.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

const tmpRoot = '/tmp/hm-merge-nested-call';

beforeEach(() => clearCustomMethods());

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  writeFile('sigs.hm', [
    'QueryTag :: (p, o) -> QueryTag p o',
    'QueryTag#concat :: QueryTag p1 r1 ~> QueryTag p2 r2 -> QueryTag (Merge p1 p2) (Merge r1 r2)',
    'RTask :: a -> RTask a',
    'mkA :: () -> QueryTag {} { id :: Number }',
    'mkB :: () -> QueryTag {} { name :: String }',
    'one :: QueryTag p a -> p -> RTask a',
    '',
  ].join('\n'));
});

describe('Merge reduction across nested calls', () => {
  test('one(x.concat(y)) does not produce a Merge-vs-record unification diagnostic', () => {
    const consumerPath = path.join(tmpRoot, 'consumer.js');
    fs.writeFileSync(consumerPath, [
      '// ::types ./sigs',
      'const a = mkA();',
      'const b = mkB();',
      'const readMe = one(a.concat(b));',
      '',
    ].join('\n'));
    const fileUri = pathToFileURL(consumerPath).href;
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpRoot, {});
    const importResolver = ctx.createImportResolver(fileUri);
    const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
    const typeDirResolver = ctx.createTypeDirectiveResolver(fileUri);
    const eng = new InferenceEngine();
    const source = fs.readFileSync(consumerPath, 'utf8');
    const result = eng.infer(source, undefined, importResolver, typeDirResolver, aliasResolver);
    const diagMessages = result.diagnostics.map(d => d.message).join('\n');
    expect(diagMessages).not.toMatch(/Cannot unify.*Merge/);
  });
});
