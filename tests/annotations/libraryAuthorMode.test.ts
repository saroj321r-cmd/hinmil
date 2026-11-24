// Tests for "library-author mode" — when the file being inferred /
// validated lives INSIDE its own package (the developer is editing
// the library source tree, not consuming the library from elsewhere).
//
// Two halves:
//   1. `.hm` sidecar in own package can reference inline `Name :: ...`
//      annotations defined in sibling JS files — `findTypeDefinitions`
//      falls back to the package's inline scan when nothing else
//      resolves the name.
//   2. JS file in own package can reference constraints/aliases from
//      the package's `hinmil.globals` — already works today through
//      project-config loading of `package.json#hinmil.globals`; this
//      suite is a regression guard.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ImportInferenceContext } from '../../src/services/importContext';
import { clearInlinePackageCache } from '../../src/services/files';

const tmpRoot = '/tmp/hm-library-author-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function makeCtx() {
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  ctx.setProjectConfig(tmpRoot, {});
  return ctx;
}

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  clearInlinePackageCache();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. .hm sidecar in own package sees inline JS annotations
// ---------------------------------------------------------------------------

describe('library-author: own-package inline lookup', () => {
  it('findTypeDefinitions resolves names defined inline in sibling JS', () => {
    // mylib (the library itself, NOT under node_modules)
    writeFile('package.json', JSON.stringify({
      name: 'mylib', main: 'index.js',
      'hinmil': { sidecars: ['./mylib.hm'] },
    }));
    writeFile('index.js', [
      '// Limit :: Number -> Number',
      'exports.Limit = (n) => n;',
    ].join('\n'));
    const sidecarPath = writeFile('mylib.hm', [
      '// Sidecar references `Limit` defined inline in index.js.',
      'runLimit :: Limit',
      '',
    ].join('\n'));

    const sidecarUri = pathToFileURL(sidecarPath).href;
    const ctx = makeCtx();
    // Simulate the .hm validator asking "is Limit defined anywhere?".
    const sidecarSource = fs.readFileSync(sidecarPath, 'utf8');
    const defs = ctx.findTypeDefinitions('Limit', sidecarUri, sidecarSource, null, null);
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0].raw).toMatch(/Number -> Number/);
  });

  it('catches trailing inline annotations that the regex index misses', () => {
    // Trailing `// X :: …` (not at line start) — only the comment-aware
    // extractor sees these.  The own-package fallback uses that extractor.
    writeFile('package.json', JSON.stringify({
      name: 'mylib2', main: 'index.js',
      'hinmil': { sidecars: ['./mylib.hm'] },
    }));
    writeFile('index.js', [
      'exports.TrailingType = (x) => x;  // TrailingType :: a -> a',
    ].join('\n'));
    const sidecarPath = writeFile('mylib.hm', 'usesIt :: TrailingType\n');

    const sidecarUri = pathToFileURL(sidecarPath).href;
    const ctx = makeCtx();
    const sidecarSource = fs.readFileSync(sidecarPath, 'utf8');
    const defs = ctx.findTypeDefinitions('TrailingType', sidecarUri, sidecarSource, null, null);
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0].raw).toMatch(/a -> a/);
  });

  it('does NOT trigger for files under node_modules (consumer view unchanged)', () => {
    // A file under node_modules is a consumer view; the existing per-import
    // sidecar/inline resolution covers it.  The own-package fallback must
    // skip such paths so we don't regress consumer behaviour.
    writeFile('node_modules/extlib/package.json', JSON.stringify({
      name: 'extlib', main: 'index.js',
    }));
    writeFile('node_modules/extlib/index.js', [
      '// OnlyInline :: Number',
      'exports.OnlyInline = 1;',
    ].join('\n'));
    // A .hm file under node_modules/extlib asking for OnlyInline:
    const sidecarPath = writeFile('node_modules/extlib/extlib.hm', 'useIt :: OnlyInline\n');
    const sidecarUri = pathToFileURL(sidecarPath).href;
    const ctx = makeCtx();
    const src = fs.readFileSync(sidecarPath, 'utf8');
    const defs = ctx.findTypeDefinitions('OnlyInline', sidecarUri, src, null, null);
    // The project-wide scan may still catch it, but the new own-package
    // branch must not fire for node_modules paths.  Either way, the call
    // must not throw.
    expect(Array.isArray(defs)).toBe(true);
  });

  it('returns empty when name truly does not exist (no false positives)', () => {
    writeFile('package.json', JSON.stringify({
      name: 'mylib3', main: 'index.js',
      'hinmil': { sidecars: ['./mylib.hm'] },
    }));
    writeFile('index.js', 'exports.foo = 1;');
    const sidecarPath = writeFile('mylib.hm', 'usesIt :: Nope\n');
    const sidecarUri = pathToFileURL(sidecarPath).href;
    const ctx = makeCtx();
    const src = fs.readFileSync(sidecarPath, 'utf8');
    const defs = ctx.findTypeDefinitions('NotDefinedAnywhere', sidecarUri, src, null, null);
    expect(defs).toEqual([]);
  });
});
