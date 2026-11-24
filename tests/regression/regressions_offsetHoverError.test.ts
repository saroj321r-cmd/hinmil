// Quick reproduction tests for the three reported regressions:
// 1. RTask hover returns null
// 2. Prop hover shows a phantom `Prop $error` overload
// (Test 3 — go-to-definition offset — is exercised manually for now.)

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { buildHover } from '../../src/services/hover';
import { extractImportSpecifiers } from '../../src/services/files';

const tmpDir = '/tmp/hm-regression-three';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

beforeAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
});

describe('RTask hover regression', () => {
  test('hovering RTask in an annotation returns the imported declaration', () => {
    // Use the actual sample/RTask.js to repro the user's scenario.
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const consumerPath = path.join(sampleDir, 'demo2.js');
    const consumerSource = fs.readFileSync(consumerPath, 'utf8');
    const consumerUri = pathToFileURL(consumerPath).href;

    const docs = new TextDocuments<TextDocument>(TextDocument as any);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(path.resolve(__dirname, '..', '..'), {});
    const resolver = ctx.createImportResolver(consumerUri);

    const eng = new InferenceEngine();
    const result = eng.infer(consumerSource, undefined, resolver);

    // Hover RTask inside `// task :: RTask {leader :: Person} ...`
    const taskAnn = consumerSource.indexOf('// task :: RTask');
    const offset = consumerSource.indexOf('RTask', taskAnn) + 1;
    expect(offset).toBeGreaterThan(0);

    const hover = buildHover({
      source: consumerSource,
      offset,
      result,
      bestType: null,
      bestStart: -1,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: consumerUri,
      resolveImportSpecifier: (spec: string, _from: string) => {
        const target = path.resolve(sampleDir, spec.replace(/^\.\//, '') + '.js');
        return fs.existsSync(target) ? pathToFileURL(target).href : null;
      },
      extractImportSpecifiers,
      findTypeDefinitions: (name: string) =>
        ctx.findTypeDefinitions(name, consumerUri, consumerSource, null, null),
      positionAt: (o: number) => ({ line: 0, character: o }),
    });

    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value as string;
    expect(value).toContain('RTask :: ((e -> (), a -> (), r) -> *) -> RTask r e a');
  });
});

describe('Prop hover phantom $error overload', () => {
  test('hover shows only the genuine sidecar declaration, no $error overload', () => {
    // Mimic the real layout: sqlkit-style sidecar declares Prop, consumer
    // calls a function annotated with Prop.
    writeFile('node_modules/sqlkittest/index.js', 'module.exports = {};');
    writeFile('node_modules/sqlkittest/package.json', JSON.stringify({
      name: 'sqlkittest', main: 'index.js', 'hinmil': { sidecars: './index.hm' },
    }));
    writeFile('node_modules/sqlkittest/index.hm', 'Prop :: (String, a) -> Prop b');

    const consumerPath = writeFile('repo.js', [
      'import x from "sqlkittest";',
      '// updateBy :: Prop String',
      'const updateBy = null;',
    ].join('\n'));
    const consumerSource = fs.readFileSync(consumerPath, 'utf8');
    const consumerUri = pathToFileURL(consumerPath).href;

    const docs = new TextDocuments<TextDocument>(TextDocument as any);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpDir, {});
    const resolver = ctx.createImportResolver(consumerUri);

    const eng = new InferenceEngine();
    const result = eng.infer(consumerSource, undefined, resolver);

    const offset = consumerSource.indexOf('Prop String') + 1;
    expect(offset).toBeGreaterThan(0);

    const hover = buildHover({
      source: consumerSource,
      offset,
      result,
      bestType: null,
      bestStart: -1,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: consumerUri,
      resolveImportSpecifier: (_spec: string, _from: string) => null,
      extractImportSpecifiers,
      findTypeDefinitions: (name: string) =>
        ctx.findTypeDefinitions(name, consumerUri, consumerSource, null, null),
      positionAt: (o: number) => ({ line: 0, character: o }),
    });

    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value as string;
    expect(value).not.toContain('$error');
  });
});

describe('cross-file type definitions require an import', () => {
  test('a type in a sibling file that is never imported is NOT resolved', () => {
    // `consumer.js` annotates a type `Widget` that lives in a sibling
    // file but is never imported from consumer.js.  Cross-file type
    // resolution is import-gated: without an import, the name must stay
    // unresolved (no project-wide global scan).
    writeFile('src/Widget.js', [
      '// Widget :: a -> Widget a',
      'function Widget(x) { return { value: x }; }',
      'module.exports = Widget;',
    ].join('\n'));
    const consumerPath = writeFile('src/consumer.js', [
      '// build :: a -> Widget a',
      'const build = x => x;',
    ].join('\n'));

    const consumerUri = pathToFileURL(consumerPath).href;
    const consumerSource = fs.readFileSync(consumerPath, 'utf8');
    const docs = new TextDocuments<TextDocument>(TextDocument as any);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpDir, {});

    const defs = ctx.findTypeDefinitions('Widget', consumerUri, consumerSource, null, null);
    expect(defs.length).toBe(0);
  });
});

describe('nested $error suppression in unify diagnostics', () => {
  test('does not emit `Type mismatch` when one side contains a nested $error', () => {
    // Trigger a property-access failure followed by a unification that
    // touches the poisoned variable.  The cascade diagnostic must NOT
    // surface — only the originating diagnostic counts.
    writeFile('src/cascade.js', [
      '// foo :: a -> a',
      'const foo = x => x;',
      '// use :: { name :: String } -> Number',
      'const use = obj => {',
      '  const broken = obj.nonExistent.thing;', // $error injected
      '  return foo(broken) + 1;',                  // would cascade
      '};',
    ].join('\n'));

    const filePath = path.join(tmpDir, 'src/cascade.js');
    const fileSource = fs.readFileSync(filePath, 'utf8');
    const docs = new TextDocuments<TextDocument>(TextDocument as any);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpDir, {});
    const resolver = ctx.createImportResolver(pathToFileURL(filePath).href);

    const eng = new InferenceEngine();
    const result = eng.infer(fileSource, undefined, resolver);
    const cascades = result.diagnostics.filter(d =>
      d.message.includes('$error') || d.message.includes('Cannot unify'),
    );
    // No diagnostic message should mention the `$error` sentinel.
    for (const d of cascades) {
      expect(d.message).not.toContain('$error');
    }
  });

  test('does not emit `annotation expects` cascade when inferred type is poisoned', () => {
    // Mirror the user's real scenario: a sidecar declares `Prop`, the
    // consumer's annotation references it, and an inner expression
    // produces a `$error` that pollutes the inferred value type.
    writeFile('node_modules/sqlkitcase/index.js', 'module.exports = {};');
    writeFile('node_modules/sqlkitcase/package.json', JSON.stringify({
      name: 'sqlkitcase', main: 'index.js', 'hinmil': { sidecars: './index.hm' },
    }));
    writeFile('node_modules/sqlkitcase/index.hm', 'Prop :: (String, a) -> Prop b');

    writeFile('src/repo.js', [
      'import x from "sqlkitcase";',
      '// updateBy :: Prop a -> b -> Prop b',
      'const updateBy = prop => data => {',
      '  const v = data[prop.nonExistent];', // $error in prop.nonExistent
      '  return v;',
      '};',
    ].join('\n'));

    const filePath = path.join(tmpDir, 'src/repo.js');
    const fileSource = fs.readFileSync(filePath, 'utf8');
    const docs = new TextDocuments<TextDocument>(TextDocument as any);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpDir, {});
    const resolver = ctx.createImportResolver(pathToFileURL(filePath).href);

    const eng = new InferenceEngine();
    const result = eng.infer(fileSource, undefined, resolver);
    for (const d of result.diagnostics) {
      expect(d.message).not.toContain('$error');
    }
  });
});
