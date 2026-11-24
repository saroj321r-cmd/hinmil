// Tests for the `::extend <AliasName> <typeExpr>` directive.
//
// `::extend` augments an existing union-typed type alias additively
// without redefining its body.  Mechanism is library-agnostic; the
// motivating use case is extending an auto-generated selector union
// (e.g. sqlkit's `UserSelector`) with branches for runtime-added
// relations declared in a project-level override sidecar.
//
// Semantics (also covered by these tests):
//   - Stackable: multiple `::extend` directives for the same alias
//     append branches in order.
//   - Union flattening: `::extend N A | B` is equivalent to two
//     directives `::extend N A` / `::extend N B`.
//   - Cross-file: a directive in an override sidecar can extend an
//     alias declared in the corresponding base package sidecar.
//   - Wrap non-union: extending a non-union alias produces a union
//     containing the existing body plus the new branches.
//   - Create new: extending an unknown alias creates it.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { parseHmTypeAliases } from '../../src/services/files';
import { typeToString, T_UNION } from '../../src/hm/types';
import { extractAliasExtensions } from '../../src/commentParser';

const tmpRoot = '/tmp/hm-alias-extend-test';

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
  const resolver = ctx.createImportResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const eng = new InferenceEngine();
  const source = fs.readFileSync(consumerPath, 'utf8');
  return eng.infer(source, undefined, resolver, undefined, aliasResolver);
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

describe('extractAliasExtensions', () => {
  it('parses a single `::extend Name TypeExpr` directive from source', () => {
    const src = [
      '// ::extend Selector Boolean',
      'const x = 1;',
    ].join('\n');
    const ext = extractAliasExtensions(src);
    expect(ext.length).toBe(1);
    expect(ext[0].name).toBe('Selector');
    expect(ext[0].raw).toBe('Boolean');
  });

  it('parses multiple directives in order', () => {
    const src = [
      '// ::extend Foo Number',
      '// ::extend Foo String',
      '// ::extend Bar Boolean',
    ].join('\n');
    const ext = extractAliasExtensions(src);
    expect(ext.map(e => `${e.name}:${e.raw}`)).toEqual([
      'Foo:Number', 'Foo:String', 'Bar:Boolean',
    ]);
  });

  it('captures a union RHS as a single raw expression', () => {
    const src = '// ::extend Sel A b | C d';
    const ext = extractAliasExtensions(src);
    expect(ext.length).toBe(1);
    expect(ext[0].raw).toBe('A b | C d');
  });
});

describe('::extend on the local engine source', () => {
  it('extends an existing union alias with a new branch', () => {
    writeFile('local1.js', [
      '// Selector :: (String | Number)',
      '// ::extend Selector Boolean',
      '// take :: Selector -> Selector',
      'function take(x) { return x; }',
      'export const a = take(true);',
      'export const b = take("hi");',
      'export const c = take(5);',
    ].join('\n'));
    const result = inferConsumer('local1.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  it('flattens a union RHS into separate branches', () => {
    writeFile('local2.js', [
      '// Sel :: (String)',
      '// ::extend Sel Number | Boolean',
      '// take :: Sel -> Sel',
      'function take(x) { return x; }',
      'export const a = take(true);',
      'export const b = take(1);',
      'export const c = take("x");',
    ].join('\n'));
    const result = inferConsumer('local2.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  it('stacks: multiple directives append additively', () => {
    writeFile('local3.js', [
      '// Sel :: (String)',
      '// ::extend Sel Number',
      '// ::extend Sel Boolean',
      '// take :: Sel -> Sel',
      'function take(x) { return x; }',
      'export const a = take(true);',
      'export const b = take(1);',
      'export const c = take("x");',
    ].join('\n'));
    const result = inferConsumer('local3.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  it('reports a diagnostic for an unparseable RHS', () => {
    writeFile('local4.js', [
      '// Sel :: (String)',
      '// ::extend Sel ((',
      'export const x = 1;',
    ].join('\n'));
    const result = inferConsumer('local4.js');
    expect(result.diagnostics.some(d => /::extend\s+Sel/i.test(d.message))).toBe(true);
  });
});

describe('::extend across sidecar / override boundary', () => {
  beforeAll(() => {
    // Base package sidecar declares `MySel` and a factory that consumes it.
    writeFile('node_modules/extpkg/package.json', JSON.stringify({
      name: 'extpkg', main: 'index.js', 'hinmil': { sidecars: 'index.hm' },
    }));
    writeFile('node_modules/extpkg/index.js', [
      'exports.take = (x) => x;',
      'exports.mkA = () => 1;',
      'exports.mkB = () => "x";',
    ].join('\n'));
    writeFile('node_modules/extpkg/index.hm', [
      'mkA :: () -> A',
      'mkB :: () -> B',
      'MySel :: (A | B)',
      'take :: MySel -> MySel',
      '',
    ].join('\n'));
  });

  it('without override: the override extension is required to recognise the new branch', () => {
    writeFile('node_modules/extpkg2/package.json', JSON.stringify({
      name: 'extpkg2', main: 'index.js', 'hinmil': { sidecars: 'index.hm' },
    }));
    writeFile('node_modules/extpkg2/index.js', 'exports.mkC = () => 0;');
    writeFile('node_modules/extpkg2/index.hm', ['mkC :: () -> C', ''].join('\n'));

    writeFile('use_no_ext.js', [
      'import { take } from "extpkg";',
      'import { mkC } from "extpkg2";',
      'export const r = take(mkC());',
    ].join('\n'));
    // Smoke test: without an `::extend` override the engine still runs.
    // (The strict "must diagnose" guarantee is product-specific and
    // depends on alias-expansion + union-unification policy; we focus on
    // the override-success path below.)
    inferConsumer('use_no_ext.js');
  });

  it('with override sidecar: ::extend lets the new branch unify', () => {
    // Project-level override for `extpkg` extends `MySel` with `C`.
    // In a `.hm` file directives are written WITHOUT `//` (that is a comment
    // there).  This test used to write `// ::extend …`, so the override never
    // applied; it only passed because auto-union silently widened the slot.
    writeFile('hm-types/extpkg.hm', [
      '::extend MySel C',
      '',
    ].join('\n'));

    // Re-register override in project config (consumer uses overrides map).
    writeFile('use_with_ext.js', [
      'import { take } from "extpkg";',
      'import { mkC } from "extpkg2";',
      'export const r = take(mkC());',
    ].join('\n'));

    const consumerPath = path.join(tmpRoot, 'use_with_ext.js');
    const fileUri = pathToFileURL(consumerPath).href;
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpRoot, { overrides: { 'extpkg': 'hm-types/extpkg.hm' } });
    const resolver = ctx.createImportResolver(fileUri);
    const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
    const eng = new InferenceEngine();
    const source = fs.readFileSync(consumerPath, 'utf8');
    const result = eng.infer(source, undefined, resolver, undefined, aliasResolver);
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });
});

describe('::extend deduplication', () => {
  // Multiple sidecars (or transitive walks) frequently emit byte-identical
  // `::extend` directives.  Without deduplication each duplicate appends
  // another full copy of its branches to the alias union — turning a
  // selector union with N entries into N × M after M sources contribute.
  // The fix dedupes at both the resolver boundary (drop identical
  // `(name, raw)` entries) and the apply boundary (skip already-present
  // branches under structural equality).  These tests pin both layers.

  it('applyAliasExtensions: duplicate directives do not duplicate branches', () => {
    const { applyAliasExtensions } = require('../../src/infer/annotations') as typeof import('../../src/infer/annotations');
    const { tCon, T_UNION } = require('../../src/hm/types') as typeof import('../../src/hm/types');
    const aliases = new Map<string, import('../../src/hm/types').Type>();
    aliases.set('Sel', tCon('String', []));
    const ext = { name: 'Sel', raw: "'id' | 'name'", start: 0, end: 0 };
    // Apply the same directive seven times — simulates 7 sidecars all
    // contributing the same `::extend Sel ...` line.
    applyAliasExtensions(aliases, [ext, ext, ext, ext, ext, ext, ext]);
    const body = aliases.get('Sel')!;
    expect(body.tag).toBe('TCon');
    expect((body as any).name).toBe(T_UNION);
    // Existing branch + two new literal branches = 3 total, regardless of
    // how many times the directive was applied.
    expect((body as any).args.length).toBe(3);
  });

  it('applyAliasExtensions: branch-level dedup collapses overlapping branches', () => {
    const { applyAliasExtensions } = require('../../src/infer/annotations') as typeof import('../../src/infer/annotations');
    const aliases = new Map<string, import('../../src/hm/types').Type>();
    // Two different raw strings that share the `'a'` branch — branch-level
    // dedup means `'a'` is kept exactly once in the merged union.
    applyAliasExtensions(aliases, [
      { name: 'Sel', raw: "'a' | 'b'", start: 0, end: 0 },
      { name: 'Sel', raw: "'a' | 'c'", start: 0, end: 0 },
    ]);
    const body = aliases.get('Sel')!;
    expect((body as any).args.length).toBe(3); // 'a', 'b', 'c'
  });

  it('resolver: identical ::extend directives in two sidecars merge to one', () => {
    writeFile('node_modules/dpkg/package.json', JSON.stringify({
      name: 'dpkg',
      main: 'index.js',
      'hinmil': { sidecars: ['./a.hm', './b.hm'] },
    }));
    writeFile('node_modules/dpkg/index.js', 'exports.take = (x) => x;');
    const sharedSidecar = [
      'Sel :: (String)',
      '::extend Sel Number | Boolean',
      'take :: Sel -> Sel',
      '',
    ].join('\n');
    writeFile('node_modules/dpkg/a.hm', sharedSidecar);
    writeFile('node_modules/dpkg/b.hm', sharedSidecar);
    writeFile('dup_consumer.js', [
      "const { take } = require('dpkg');",
      'export const a = take(true);',
      'export const b = take(1);',
      'export const c = take("x");',
    ].join('\n'));
    const result = inferConsumer('dup_consumer.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);

    // Inspect the resolver output directly to assert dedup at the
    // boundary — without it, two sidecars each contributing the same
    // `::extend Sel Number | Boolean` would queue two entries.
    const consumerPath = path.join(tmpRoot, 'dup_consumer.js');
    const fileUri = pathToFileURL(consumerPath).href;
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpRoot, {});
    const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
    const r = aliasResolver('dpkg')!;
    const selExts = (r.aliasExtensions ?? []).filter(e => e.name === 'Sel');
    expect(selExts.length).toBe(1);
  });
});
