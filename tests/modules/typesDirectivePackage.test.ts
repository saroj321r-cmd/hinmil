// Tests for `// ::types <package>` resolving to a bare package's full set
// of `.hm` sidecars (array form) PLUS the project-level
// `hinmil.overrides.<pkg>` file, merged on top.
//
// Regression: previously `createTypeDirectiveResolver` only loaded the
// resolved entry file (which for many packages is the `main` JS entry,
// not a `.hm` file), so `// ::types <pkg>` silently produced no
// annotations when `hinmil.sidecars` was an array.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';

const tmpRoot = '/tmp/hm-types-directive-package-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function inferConsumer(consumerRel: string, overrides: Record<string, string> = {}) {
  const consumerPath = path.join(tmpRoot, consumerRel);
  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  ctx.setProjectConfig(tmpRoot, { overrides });
  const importResolver = ctx.createImportResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const typeDirResolver = ctx.createTypeDirectiveResolver(fileUri);
  const eng = new InferenceEngine();
  const source = fs.readFileSync(consumerPath, 'utf8');
  return eng.infer(source, undefined, importResolver, typeDirResolver, aliasResolver);
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  // Package mimics sqlkit's layout: `hinmil.sidecars` is an ARRAY pointing at one
  // hand-written sidecar inside the package and one auto-generated one
  // outside it.  `main` points at a plain JS file (no annotations).
  writeFile('node_modules/qpkg/package.json', JSON.stringify({
    name: 'qpkg',
    main: 'build/index.js',
    'hinmil': { sidecars: ['./qpkg.hm', '../.qpkg/client/index.hm'] },
  }));
  writeFile('node_modules/qpkg/build/index.js', [
    'exports.mkTag = () => ({});',
  ].join('\n'));
  writeFile('node_modules/qpkg/qpkg.hm', [
    'QTag :: p -> r -> QTag p r',
    'QTag() :: p -> [r]',
    '',
  ].join('\n'));
  writeFile('node_modules/.qpkg/client/index.hm', [
    'UserRow :: { id :: Number, name :: String }',
    '',
  ].join('\n'));

  // Project-level override: extends qpkg with extra declarations.  Used
  // to verify that override is merged on top by `createTypeDirectiveResolver`.
  writeFile('hm-types/qpkg.hm', [
    'OverrideOnly :: a -> a',
    '',
  ].join('\n'));
});

describe('// ::types <pkg> with array `hinmil.sidecars`', () => {
  it('loads ALL sidecars declared in `hinmil.sidecars` (array form)', () => {
    writeFile('src/use1.js', [
      '// ::types qpkg',
      '// f :: QTag p r -> Number',
      'export const f = t => 0;',
      '',
      '// g :: UserRow -> Number',
      'export const g = u => u.id;',
    ].join('\n'));
    const result = inferConsumer('src/use1.js');
    // Both QTag (from qpkg.hm) and UserRow (from .qpkg/client/index.hm)
    // must be known.  No "Unknown type constructor" diagnostics.
    const unknowns = result.diagnostics.filter(d =>
      /Unknown type constructor/.test(d.message)
    );
    expect(unknowns.map(d => d.message)).toEqual([]);
  });

  it('also merges the project `hinmil.overrides.<pkg>` file', () => {
    writeFile('src/use2.js', [
      '// ::types qpkg',
      '// h :: OverrideOnly a -> a',
      'export const h = x => x;',
    ].join('\n'));
    const result = inferConsumer('src/use2.js', { qpkg: './hm-types/qpkg.hm' });
    const unknowns = result.diagnostics.filter(d =>
      /Unknown type constructor/.test(d.message)
    );
    expect(unknowns.map(d => d.message)).toEqual([]);
  });

  it('still works with relative-path specifiers (regression)', () => {
    writeFile('src/local.js', [
      '// Foo :: a -> Foo a',
      'export const Foo = x => ({ x });',
    ].join('\n'));
    writeFile('src/use3.js', [
      '// ::types ./local',
      '// j :: Foo a -> Number',
      'export const j = f => 0;',
    ].join('\n'));
    const result = inferConsumer('src/use3.js');
    const unknowns = result.diagnostics.filter(d =>
      /Unknown type constructor/.test(d.message)
    );
    expect(unknowns.map(d => d.message)).toEqual([]);
  });
});
