// Tests for `// ::types <specifier>` directives declared inside the
// project globals file (`globals.hm`).  Such directives pull in the
// referenced sidecar(s) and append their declarations to the engine's
// `globalsSource`, making them visible to every file the engine infers
// without per-file imports or per-file `::types` directives.
//
// Replaces the old sqlkit-specific hardcoding (auto-loading of
// `node_modules/.sqlkit/client/index.hm`): users who want that behaviour
// now opt in by adding `// ::types sqlkit` (or a relative path) to their
// own `globals.hm`.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { wrapHmSource } from '../../src/services/files';

const tmpRoot = '/tmp/hm-globals-types-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function makeContext(globalsRel: string | null): {
  ctx: ImportInferenceContext;
  globalsSource: string | null;
  globalsFilePath: string | null;
} {
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  let globalsSource: string | null = null;
  let globalsFilePath: string | null = null;
  if (globalsRel) {
    globalsFilePath = path.join(tmpRoot, globalsRel);
    const raw = fs.readFileSync(globalsFilePath, 'utf-8');
    globalsSource = globalsFilePath.endsWith('.hm') ? wrapHmSource(raw) : raw;
  }
  ctx.setProjectConfig(tmpRoot, { globalsSource, globalsFilePath });
  return { ctx, globalsSource, globalsFilePath };
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  // A package whose sidecar declares Limit / Offset (mimics sqlkit).
  writeFile('node_modules/fakepkg/package.json', JSON.stringify({
    name: 'fakepkg',
    main: 'index.js',
    'hinmil': { sidecars: './fakepkg.hm' },
  }));
  writeFile('node_modules/fakepkg/index.js', [
    'exports.Limit = (n) => ({ kind: "limit", n });',
    'exports.Offset = (n) => ({ kind: "offset", n });',
  ].join('\n'));
  writeFile('node_modules/fakepkg/fakepkg.hm', [
    'Limit :: Number -> Limit l',
    'Offset :: Number -> Offset o',
    '',
  ].join('\n'));
});

describe('globals.hm `::types` directive', () => {
  it('makes a package sidecar visible globally (bare specifier)', () => {
    writeFile('globals.hm', '::types fakepkg\n');
    const { ctx, globalsSource } = makeContext('globals.hm');
    const addendum = ctx.getProjectGlobalsAddendum();
    expect(addendum).not.toBeNull();
    expect(addendum).toContain('Limit :: Number -> Limit l');
    expect(addendum).toContain('Offset :: Number -> Offset o');

    // Combine like server.ts does.
    const combined = `${globalsSource}\n${addendum}`;

    // A consumer file annotates a value as `Limit l`.  Without the global
    // `::types fakepkg` directive in globals.hm, `Limit` would be unknown
    // inside the annotation and the parser would reject the type.  With
    // it, the alias resolves and inference type-checks the file cleanly.
    const consumerPath = writeFile('useLimit.js', [
      '// myLimit :: Limit l',
      'const myLimit = { kind: "limit", n: 5 };',
      'module.exports = { myLimit };',
      '',
    ].join('\n'));
    const consumerUri = pathToFileURL(consumerPath).href;
    const eng = new InferenceEngine();
    eng.globalsSource = combined;
    const result = eng.infer(
      fs.readFileSync(consumerPath, 'utf-8'),
      undefined,
      ctx.createImportResolver(consumerUri),
      ctx.createTypeDirectiveResolver(consumerUri),
      ctx.createImportTypeAliasResolver(consumerUri),
    );
    // No diagnostic mentioning `Limit` (would appear if the alias were
    // unknown, e.g. "Unknown type alias 'Limit'" or similar).
    const limDiags = result.diagnostics.filter((d) => /\bLimit\b/.test(d.message));
    expect(limDiags).toEqual([]);
  });

  it('returns null when globals has no `::types` directives', () => {
    writeFile('globals2.hm', '// just comments, no directives\n::global Array.empty :: () -> [a]\n');
    const { ctx } = makeContext('globals2.hm');
    expect(ctx.getProjectGlobalsAddendum()).toBeNull();
  });

  it('returns null when no globals file is configured', () => {
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpRoot, {});
    expect(ctx.getProjectGlobalsAddendum()).toBeNull();
  });

  it('does NOT auto-load `node_modules/.sqlkit/client/index.hm` (no hardcoding)', () => {
    // Lay down a `.sqlkit/client/index.hm` to mimic the previous hardcoded path.
    writeFile('node_modules/.sqlkit/client/index.hm', 'AutoLoaded :: Number\n');
    // Globals with no ::types directive should NOT pull it in.
    writeFile('globals3.hm', '::global Array.empty :: () -> [a]\n');
    const { ctx } = makeContext('globals3.hm');
    const addendum = ctx.getProjectGlobalsAddendum();
    expect(addendum).toBeNull();
  });

  it('resolves a relative `::types ./path.hm` directive', () => {
    writeFile('extra/aux.hm', 'Aux :: Number\n');
    writeFile('globals4.hm', '::types ./extra/aux.hm\n');
    const { ctx } = makeContext('globals4.hm');
    const addendum = ctx.getProjectGlobalsAddendum();
    expect(addendum).not.toBeNull();
    expect(addendum).toContain('Aux :: Number');
  });
});
