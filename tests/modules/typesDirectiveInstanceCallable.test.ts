// P5/P6 — `// ::types <pkg>` should make instance-callable annotations
// (`Name() :: ...`) from the loaded sidecar callable in the consumer
// file, AND must not surface validator diagnostics for sidecar
// annotations (those should be reported against the sidecar itself,
// not against the consumer).

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';

const tmpRoot = '/tmp/hm-types-directive-instance-callable';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function inferConsumer(consumerRel: string) {
  const consumerPath = path.join(tmpRoot, consumerRel);
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
  return { eng, result };
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  // A package with an instance-callable for its `QueryTag` constructor and
  // also some constructor annotations whose return-type vars are NOT
  // derivable from the parameter types.  The latter would normally
  // trigger the "is not derivable from the parameter types" diagnostic;
  // because they live in a sidecar the diagnostic must NOT surface
  // against the consumer file.
  writeFile('node_modules/qpkg/package.json', JSON.stringify({
    name: 'qpkg',
    main: 'build/index.js',
    'hinmil': { sidecars: ['./qpkg.hm'] },
  }));
  writeFile('node_modules/qpkg/build/index.js', 'exports.x = 1;');
  writeFile('node_modules/qpkg/qpkg.hm', [
    'QueryTag :: p -> a -> QueryTag p a',
    'QueryTag() :: p -> [a]',
    // Constructor whose return type uses a var `b` not present in any param —
    // representative of sqlkit's `Eq`, `Value`, `Prop`, etc.  The validator
    // would normally flag this; we want it suppressed here because the
    // declaration originates from the sidecar.
    'Sneaky :: a -> Sneaky a b',
    '',
  ].join('\n'));
});

describe('::types directive — instance-callable + sidecar diagnostic suppression', () => {
  it('makes a value typed as QueryTag callable via the sidecar Name() :: ... declaration', () => {
    writeFile('src/one.js', [
      '// ::types qpkg',
      '// one :: QueryTag p a -> p -> a',
      'const one = t => p => t (p) [0];',
      'export default one;',
      '',
    ].join('\n'));
    const { result } = inferConsumer('src/one.js');
    const messages = result.diagnostics.map(d => d.message);
    // Must NOT see "is not callable" — sidecar's `QueryTag()` declaration
    // makes `t (p)` a valid invocation against the `QueryTag p a` type.
    expect(messages.some(m => /is not callable/.test(m))).toBe(false);
  });

  it('does NOT surface "not derivable from parameter types" diagnostics for sidecar annotations', () => {
    writeFile('src/two.js', [
      '// ::types qpkg',
      'export const dummy = 1;',
      '',
    ].join('\n'));
    const { result } = inferConsumer('src/two.js');
    const messages = result.diagnostics.map(d => d.message);
    // The sidecar's `Sneaky :: a -> Sneaky a b` would normally trigger
    // the derivability validator; ensure it stays inside the sidecar.
    expect(messages.some(m => /not derivable from the parameter types/.test(m))).toBe(false);
  });

  it('project-level override REPLACES the base sidecar instance-callable', () => {
    // Add a project-level override that redefines QueryTag()'s callable
    // signature.  The base sidecar declares `QueryTag() :: p -> [a]`;
    // the override declares `QueryTag() :: p -> Wrapped a`.  After the
    // override loads, only the override's signature should be active —
    // the base's `[a]` form should NOT remain as an extra overload.
    writeFile('hm-types/qpkg.hm', [
      'Wrapped :: a -> Wrapped a',
      'QueryTag() :: p -> Wrapped a',
      '',
    ].join('\n'));
    writeFile('package.json', JSON.stringify({
      'hinmil': { overrides: { qpkg: './hm-types/qpkg.hm' } },
    }));
    writeFile('src/three.js', [
      '// ::types qpkg',
      '// run :: QueryTag p a -> p -> a',
      'const run = t => p => t (p);',
      'export default run;',
      '',
    ].join('\n'));
    const consumerPath = path.join(tmpRoot, 'src/three.js');
    const fileUri = pathToFileURL(consumerPath).href;
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpRoot, { overrides: { qpkg: './hm-types/qpkg.hm' } });
    const importResolver = ctx.createImportResolver(fileUri);
    const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
    const typeDirResolver = ctx.createTypeDirectiveResolver(fileUri);
    const eng = new InferenceEngine();
    const source = fs.readFileSync(consumerPath, 'utf8');
    eng.infer(source, undefined, importResolver, typeDirResolver, aliasResolver);
    // Inspect the engine's instance-callables map: only the override's
    // entry should remain for `QueryTag`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callables: Map<string, unknown[]> | undefined = (eng as any).instanceCallables;
    expect(callables).toBeDefined();
    const queryTag = callables!.get('QueryTag');
    expect(queryTag).toBeDefined();
    expect(queryTag!.length).toBe(1);
  });
});
