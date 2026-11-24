// Tests for ImportInferenceContext.findTypeDefinitions.
// Covers the dedup-on-raw behaviour and the comment-offset mapping used
// by go-to-definition.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ImportInferenceContext } from '../../src/services/importContext';

const tmpDir = '/tmp/hm-find-type-defs-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function makeCtx(): ImportInferenceContext {
  const docs = new TextDocuments<TextDocument>(TextDocument as any);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  ctx.setProjectConfig(tmpDir, {});
  return ctx;
}

beforeAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
});

describe('findTypeDefinitions', () => {
  test('returns a single entry when the same signature appears in multiple files (raw-dedup)', () => {
    // Both an `hm-types/<pkg>.hm` and a per-file sidecar declare the
    // same Prop signature.  After dedup the user should see ONE entry,
    // not the same line twice.
    writeFile('node_modules/duppkg/index.js', 'module.exports = {};');
    writeFile('hm-types/duppkg.hm', 'Prop :: (String, a) -> Prop b');
    writeFile('node_modules/duppkg/duppkg.hm', 'Prop :: (String, a) -> Prop b');
    // Make node resolution find the sidecar via package.json `hinmil.sidecars`:
    writeFile('node_modules/duppkg/package.json', JSON.stringify({
      name: 'duppkg', main: 'index.js', 'hinmil': { sidecars: './duppkg.hm' },
    }));

    const consumer = writeFile('consumer.js', 'import x from "duppkg";');

    const ctx = makeCtx();
    const fromUri = pathToFileURL(consumer).href;
    const source = fs.readFileSync(consumer, 'utf8');
    const defs = ctx.findTypeDefinitions('Prop', fromUri, source, null, null);
    expect(defs.length).toBe(1);
    expect(defs[0].raw).toBe('(String, a) -> Prop b');
  });

  test('returns multiple entries when signatures genuinely differ', () => {
    writeFile('node_modules/diffpkg/index.js', 'module.exports = {};');
    writeFile('hm-types/diffpkg.hm', 'Prop :: (Number, a) -> Prop b');
    writeFile('node_modules/diffpkg/diffpkg.hm', 'Prop :: (String, a) -> Prop b');
    writeFile('node_modules/diffpkg/package.json', JSON.stringify({
      name: 'diffpkg', main: 'index.js', 'hinmil': { sidecars: './diffpkg.hm' },
    }));

    const consumer = writeFile('consumer-diff.js', 'import x from "diffpkg";');

    const ctx = makeCtx();
    const fromUri = pathToFileURL(consumer).href;
    const source = fs.readFileSync(consumer, 'utf8');
    const defs = ctx.findTypeDefinitions('Prop', fromUri, source, null, null);
    expect(defs.length).toBe(2);
    const raws = defs.map(d => d.raw).sort();
    expect(raws).toEqual(['(Number, a) -> Prop b', '(String, a) -> Prop b']);
  });

  test('comment offsets map back to the original .hm file (used by go-to-definition)', () => {
    // Two preceding declarations + a header comment exercise the
    // line-by-line scan: the offset must point at the `Foo ::` line, not
    // at the file start or at the preceding annotation block.
    const sidecar = writeFile('hm-types/offsetpkg.hm', [
      '// header comment',
      '',
      'Bar :: a -> Bar a',
      'Baz :: a -> Baz a',
      'Foo :: a -> Foo a',
      '',
    ].join('\n'));
    writeFile('node_modules/offsetpkg/index.js', 'module.exports = {};');

    const consumer = writeFile('consumer-offset.js', 'import x from "offsetpkg";');

    const ctx = makeCtx();
    const fromUri = pathToFileURL(consumer).href;
    const source = fs.readFileSync(consumer, 'utf8');
    const defs = ctx.findTypeDefinitions('Foo', fromUri, source, null, null);
    expect(defs.length).toBe(1);

    const sidecarText = fs.readFileSync(sidecar, 'utf8');
    const slice = sidecarText.slice(defs[0].commentStart, defs[0].commentEnd);
    expect(slice).toBe('Foo :: a -> Foo a');
  });

  test('returns empty array when no definitions exist', () => {
    const consumer = writeFile('consumer-empty.js', 'const x = 1;');
    const ctx = makeCtx();
    const fromUri = pathToFileURL(consumer).href;
    const source = fs.readFileSync(consumer, 'utf8');
    const defs = ctx.findTypeDefinitions('NoSuchType', fromUri, source, null, null);
    expect(defs).toEqual([]);
  });

  test('// ::types <pkg> surfaces both the package sidecar AND the project override', () => {
    // Package's own sidecar declares `QueryTag :: ... -> QueryTag p a`.
    // The project override redefines it with a different signature.
    // Go-to-definition (which is fed by findTypeDefinitions) must
    // surface BOTH so the user can jump to either location.
    writeFile('node_modules/dirpkg/index.js', 'module.exports = {};');
    writeFile('node_modules/dirpkg/dirpkg.hm', 'QueryTag :: a -> QueryTag p a');
    writeFile('node_modules/dirpkg/package.json', JSON.stringify({
      name: 'dirpkg', main: 'index.js', 'hinmil': { sidecars: './dirpkg.hm' },
    }));
    writeFile('hm-types/dirpkg.hm', 'QueryTag :: b -> QueryTag q b');

    const consumer = writeFile('consumer-directive.js', [
      '// ::types dirpkg',
      'const x = 1;',
    ].join('\n'));

    const docs = new TextDocuments<TextDocument>(TextDocument as any);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpDir, { overrides: { dirpkg: './hm-types/dirpkg.hm' } });

    const fromUri = pathToFileURL(consumer).href;
    const source = fs.readFileSync(consumer, 'utf8');
    const defs = ctx.findTypeDefinitions('QueryTag', fromUri, source, null, null);
    // Two distinct signatures → two entries (one origin = override,
    // the other = the package).
    expect(defs.length).toBe(2);
    const origins = defs.map(d => d.origin).sort();
    expect(origins.some(o => o.includes('override'))).toBe(true);
    expect(origins.some(o => o === 'dirpkg')).toBe(true);
  });
});

describe('built-in types of hinmil itself', () => {
  // `ReactElement` (the type of every JSX expression) has no `Name ::`
  // declaration; the bundled react stub documents it with an anchor line
  // `// ::builtin ReactElement`.  A component file needs no `import React`
  // (automatic JSX runtime), so the anchor is found without an import.
  test('ReactElement resolves to its anchor in the bundled react stub', () => {
    const component = writeFile('src/Badge.jsx', [
      '// Badge :: { label :: String } -> ReactElement',
      'const Badge = ({ label }) => <span className="badge">{label}</span>;',
      'export default Badge;',
    ].join('\n'));
    const ctx = makeCtx();
    const defs = ctx.findTypeDefinitions(
      'ReactElement', pathToFileURL(component).href, fs.readFileSync(component, 'utf8'), null, null,
    );
    expect(defs).toHaveLength(1);
    expect(defs[0].sourcePath).toMatch(/hm-types-builtin[\\/]react\.hm$/);
    const text = fs.readFileSync(defs[0].sourcePath!, 'utf8');
    expect(text.slice(defs[0].commentStart, defs[0].commentEnd)).toBe('// ::builtin ReactElement');
  });

  test('a name without a declaration or anchor still resolves to nothing', () => {
    const component = writeFile('src/Plain.jsx', 'const Plain = () => <p />;');
    const ctx = makeCtx();
    expect(ctx.findTypeDefinitions(
      'ReactNodeLike', pathToFileURL(component).href, fs.readFileSync(component, 'utf8'), null, null,
    )).toEqual([]);
  });
});
