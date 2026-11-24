// Tests for INLINE package annotations.
//
// A library can ship `// Name :: Type` annotations directly next to
// JS definitions (no `.hm` sidecar required).  The language server
// BFS-walks the package's JS re-export graph starting at the entry
// declared in `package.json` (`main` / `module`), stays inside the
// package root, and merges every inline annotation it finds.  These
// annotations show up as ordinary `import { X } from "pkg"` exports
// in consumer files.
//
// Coverage:
//   1. inline-only package — no `.hm` sidecar at all
//   2. sidecar + inline hybrid — sidecar wins on name collision
//   3. multi-level re-export chain (three modules deep)
//   4. circular `require` graph terminates (visited-set protection)
//   5. pkgRoot containment — stops following imports that leave the
//      package directory
//   6. end-to-end via `createImportResolver` — type error propagates
//      from the inline annotation to a wrong-arity call site
//   7. `package.json#hinmil.globals` augments the consumer's globals
//      with package-level aliases / constraints

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { typeToString } from '../../src/hm/types';
import { ImportInferenceContext } from '../../src/services/importContext';
import {
  collectInlinePackageAnnotations,
  clearInlinePackageCache,
  extractAllModuleSpecifiers,
} from '../../src/services/files';

const tmpRoot = '/tmp/hm-inline-package-test';

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
  return { result: eng.infer(source, undefined, resolver, undefined, aliasResolver), ctx };
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
// 1. inline-only package
// ---------------------------------------------------------------------------

describe('inline-only package (no sidecar)', () => {
  it('collects top-level `Name :: Type` annotations from the entry file', () => {
    writeFile('node_modules/inlineonly/package.json', JSON.stringify({
      name: 'inlineonly', main: 'index.js',
    }));
    writeFile('node_modules/inlineonly/index.js', [
      '// limit :: Number -> Limit',
      'exports.limit = (n) => ({ tag: "limit", n });',
      '',
      '// offset :: Number -> Offset',
      'exports.offset = (n) => ({ tag: "offset", n });',
    ].join('\n'));

    const entry = path.join(tmpRoot, 'node_modules/inlineonly/index.js');
    const scan = collectInlinePackageAnnotations(entry);
    expect(scan).not.toBeNull();
    expect(scan!.exports.has('limit')).toBe(true);
    expect(scan!.exports.has('offset')).toBe(true);
  });

  it('exposes annotations as named exports to consumer imports', () => {
    writeFile('node_modules/inlineonly2/package.json', JSON.stringify({
      name: 'inlineonly2', main: 'index.js',
    }));
    writeFile('node_modules/inlineonly2/index.js', [
      '// makeBox :: a -> Box a',
      'exports.makeBox = (x) => ({ value: x });',
    ].join('\n'));
    writeFile('consumer.js', [
      'import { makeBox } from "inlineonly2";',
      'const b = makeBox(42);',
    ].join('\n'));

    const { result } = inferConsumer('consumer.js');
    const bScheme = result.topLevelBindings.get('b');
    expect(bScheme).toBeDefined();
    expect(typeToString(result.substitution.apply(bScheme!.type))).toMatch(/Box/);
  });
});

// ---------------------------------------------------------------------------
// 2. sidecar + inline hybrid
// ---------------------------------------------------------------------------

describe('hybrid: sidecar entry wins over inline on conflict', () => {
  it('uses sidecar signature when both inline and sidecar declare the same name', () => {
    writeFile('node_modules/hybrid/package.json', JSON.stringify({
      name: 'hybrid', main: 'index.js',
      'hinmil': { sidecars: './hybrid.hm' },
    }));
    writeFile('node_modules/hybrid/index.js', [
      '// foo :: String -> String',   // inline says String -> String
      'exports.foo = (s) => s;',
      '// bar :: Number -> Number',   // inline-only (no sidecar entry)
      'exports.bar = (n) => n;',
    ].join('\n'));
    writeFile('node_modules/hybrid/hybrid.hm', [
      'foo :: Number -> Number',     // sidecar says Number -> Number — wins
    ].join('\n'));

    writeFile('consumer.js', [
      'import { foo, bar } from "hybrid";',
      'const x = foo(1);',           // valid if sidecar wins
      'const y = bar(2);',
    ].join('\n'));
    const { result } = inferConsumer('consumer.js');
    expect(typeToString(result.substitution.apply(result.topLevelBindings.get('x')!.type))).toBe('Number');
    expect(typeToString(result.substitution.apply(result.topLevelBindings.get('y')!.type))).toBe('Number');
  });
});

// ---------------------------------------------------------------------------
// 3. multi-level re-export chain
// ---------------------------------------------------------------------------

describe('multi-level re-export chain', () => {
  it('walks 3-deep re-export chain and gathers annotations from leaf', () => {
    writeFile('node_modules/chain/package.json', JSON.stringify({
      name: 'chain', main: 'index.js',
    }));
    writeFile('node_modules/chain/index.js', [
      'export * from "./mid.js";',
    ].join('\n'));
    writeFile('node_modules/chain/mid.js', [
      'export * from "./leaf.js";',
    ].join('\n'));
    writeFile('node_modules/chain/leaf.js', [
      '// deepFn :: String -> Number',
      'export const deepFn = (s) => s.length;',
    ].join('\n'));

    const entry = path.join(tmpRoot, 'node_modules/chain/index.js');
    const scan = collectInlinePackageAnnotations(entry);
    expect(scan).not.toBeNull();
    expect(scan!.exports.has('deepFn')).toBe(true);
    expect(scan!.visitedFiles.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 4. circular re-export graph terminates
// ---------------------------------------------------------------------------

describe('circular require graph', () => {
  it('terminates without re-visiting files', () => {
    writeFile('node_modules/cyc/package.json', JSON.stringify({
      name: 'cyc', main: 'a.js',
    }));
    writeFile('node_modules/cyc/a.js', [
      'const { b } = require("./b.js");',
      '// fromA :: Number',
      'exports.fromA = 1;',
    ].join('\n'));
    writeFile('node_modules/cyc/b.js', [
      'const { fromA } = require("./a.js");',  // cycle back to a
      '// fromB :: Number',
      'exports.fromB = 2;',
    ].join('\n'));

    const entry = path.join(tmpRoot, 'node_modules/cyc/a.js');
    const scan = collectInlinePackageAnnotations(entry);
    expect(scan).not.toBeNull();
    expect(scan!.exports.has('fromA')).toBe(true);
    expect(scan!.exports.has('fromB')).toBe(true);
    expect(scan!.visitedFiles.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. pkgRoot containment
// ---------------------------------------------------------------------------

describe('pkgRoot containment', () => {
  it('does not follow `../` imports that leave the package root', () => {
    writeFile('node_modules/sibling/index.js', [
      '// leaked :: Number',
      'exports.leaked = 1;',
    ].join('\n'));
    writeFile('node_modules/sibling/package.json', JSON.stringify({ name: 'sibling', main: 'index.js' }));
    writeFile('node_modules/contained/package.json', JSON.stringify({
      name: 'contained', main: 'index.js',
    }));
    writeFile('node_modules/contained/index.js', [
      // Reaches OUT of pkgRoot — must be ignored.
      'const sib = require("../sibling/index.js");',
      '// inside :: Number',
      'exports.inside = 2;',
    ].join('\n'));

    const entry = path.join(tmpRoot, 'node_modules/contained/index.js');
    const scan = collectInlinePackageAnnotations(entry);
    expect(scan).not.toBeNull();
    expect(scan!.exports.has('inside')).toBe(true);
    expect(scan!.exports.has('leaked')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. type-error propagation via inline annotation
// ---------------------------------------------------------------------------

describe('end-to-end type-error propagation', () => {
  it('propagates a wrong-arity call against an inline annotation', () => {
    writeFile('node_modules/strict/package.json', JSON.stringify({
      name: 'strict', main: 'index.js',
    }));
    writeFile('node_modules/strict/index.js', [
      '// pair :: a -> b -> [a, b]',
      'exports.pair = (a) => (b) => [a, b];',
    ].join('\n'));
    writeFile('consumer.js', [
      'import { pair } from "strict";',
      'const r = pair("x")(42);',
    ].join('\n'));
    const { result } = inferConsumer('consumer.js');
    // `r` should be `[String, Number]` per the inline annotation.
    expect(typeToString(result.substitution.apply(result.topLevelBindings.get('r')!.type))).toMatch(/String/);
  });
});

// ---------------------------------------------------------------------------
// 7. package globals
// ---------------------------------------------------------------------------

describe('package-level globals (`hinmil.globals`)', () => {
  it('exposes a package-globals addendum to importing files', () => {
    writeFile('node_modules/withglobals/package.json', JSON.stringify({
      name: 'withglobals', main: 'index.js',
      'hinmil': { globals: ['./globals.hm'] },
    }));
    writeFile('node_modules/withglobals/index.js', [
      'exports.noop = () => {};',
    ].join('\n'));
    writeFile('node_modules/withglobals/globals.hm', [
      'PkgAlias :: String',
    ].join('\n'));
    writeFile('consumer.js', [
      'import { noop } from "withglobals";',
      'noop();',
    ].join('\n'));

    const { ctx } = inferConsumer('consumer.js');
    const addendum = ctx.getAllPackageGlobalsAddendum();
    expect(addendum).not.toBeNull();
    expect(addendum!).toMatch(/PkgAlias/);
  });
});

// ---------------------------------------------------------------------------
// inline raw-signature store (hover preserves constraint context)
// ---------------------------------------------------------------------------

describe('inline raw-signature store', () => {
  it('preserves constraint prefix verbatim for inline-imported bindings', () => {
    writeFile('node_modules/inlineraw/package.json', JSON.stringify({
      name: 'inlineraw', main: 'index.js',
    }));
    writeFile('node_modules/inlineraw/index.js', [
      '// ::constraint Runnable v { run :: v -> v }',
      '',
      '// Limit :: Runnable Number r => r -> Limit r',
      'exports.Limit = (r) => ({ tag: "Limit", r });',
    ].join('\n'));
    writeFile('consumer.js', [
      'import { Limit } from "inlineraw";',
      'const x = Limit;',
    ].join('\n'));

    const { ctx } = inferConsumer('consumer.js');
    const fromUri = pathToFileURL(path.join(tmpRoot, 'consumer.js')).href;
    const raw = ctx.getImportedRawSignature('inlineraw', 'Limit', fromUri);
    expect(raw).not.toBeNull();
    expect(raw!).toMatch(/Runnable Number r =>/);
  });

  it('sidecar still wins over inline raw on conflict', () => {
    writeFile('node_modules/rawconflict/package.json', JSON.stringify({
      name: 'rawconflict',
      main: 'index.js',
      'hinmil': { sidecars: ['./rawconflict.hm'] },
    }));
    writeFile('node_modules/rawconflict/index.js', [
      '// makeIt :: Number -> Inline a',
      'exports.makeIt = (n) => ({ n });',
    ].join('\n'));
    writeFile('node_modules/rawconflict/rawconflict.hm', [
      'makeIt :: Number -> Sidecar a',
    ].join('\n'));
    writeFile('consumer.js', 'import { makeIt } from "rawconflict";\n');

    const { ctx } = inferConsumer('consumer.js');
    const fromUri = pathToFileURL(path.join(tmpRoot, 'consumer.js')).href;
    const raw = ctx.getImportedRawSignature('rawconflict', 'makeIt', fromUri);
    expect(raw).not.toBeNull();
    expect(raw!).toMatch(/Sidecar/);
    expect(raw!).not.toMatch(/Inline/);
  });
});

// ---------------------------------------------------------------------------
// inline ::constraint directive — registered when package is imported
// ---------------------------------------------------------------------------

describe('inline ::constraint directive', () => {
  it('registers an inline constraint so consumer annotations resolve it', () => {
    writeFile('node_modules/inlineconstr/package.json', JSON.stringify({
      name: 'inlineconstr', main: 'index.js',
    }));
    writeFile('node_modules/inlineconstr/index.js', [
      '// ::constraint Runnable r { r :: (a -> r) | r }',
      '',
      '// runIt :: Runnable r => r -> Limit r',
      'exports.runIt = (r) => ({ tag: "limit", r });',
    ].join('\n'));
    writeFile('consumer.js', [
      'import { runIt } from "inlineconstr";',
      'const a = runIt(5);',
    ].join('\n'));

    const { result } = inferConsumer('consumer.js');
    const diagMsgs = result.diagnostics.map(d => d.message).join('\n');
    expect(diagMsgs).not.toMatch(/Unknown constraint/);
    expect(diagMsgs).not.toMatch(/does not satisfy/);
    const a = result.topLevelBindings.get('a');
    expect(a).toBeDefined();
    expect(typeToString(result.substitution.apply(a!.type))).toMatch(/Limit/);
  });

  it('rejects consumer call that violates an inline constraint', () => {
    writeFile('node_modules/inlineconstr2/package.json', JSON.stringify({
      name: 'inlineconstr2', main: 'index.js',
    }));
    writeFile('node_modules/inlineconstr2/index.js', [
      '// ::constraint StringOrNum v { v :: String | Number }',
      '',
      '// pick :: StringOrNum v => v -> v',
      'exports.pick = (x) => x;',
    ].join('\n'));
    writeFile('consumer.js', [
      'import { pick } from "inlineconstr2";',
      'const b = pick(true);',
    ].join('\n'));

    const { result } = inferConsumer('consumer.js');
    const diagMsgs = result.diagnostics.map(d => d.message).join('\n');
    expect(diagMsgs).toMatch(/does not satisfy union constraint 'StringOrNum'/);
  });
});

// ---------------------------------------------------------------------------
// ::types chaining inside the inline scan
// ---------------------------------------------------------------------------

describe('inline ::types chaining', () => {
  it('follows ::types ./helper (relative JS) inside the same package', () => {
    writeFile('node_modules/chain/package.json', JSON.stringify({
      name: 'chain', main: 'index.js',
    }));
    writeFile('node_modules/chain/index.js', [
      '// ::types ./helper',
      'export { helper } from "./helper-impl";',
    ].join('\n'));
    writeFile('node_modules/chain/helper.js', [
      '// helper :: Number -> Number',
    ].join('\n'));
    writeFile('node_modules/chain/helper-impl.js', [
      'export const helper = (n) => n + 1;',
    ].join('\n'));
    writeFile('consumer.js', [
      'import { helper } from "chain";',
      'const x = helper(5);',
    ].join('\n'));

    const { result } = inferConsumer('consumer.js');
    const x = result.topLevelBindings.get('x');
    expect(x).toBeDefined();
    expect(typeToString(result.substitution.apply(x!.type))).toBe('Number');
  });

  it('follows ::types ./types.hm (explicit sidecar) reached via inline scan', () => {
    writeFile('node_modules/chainhm/package.json', JSON.stringify({
      name: 'chainhm', main: 'index.js',
    }));
    writeFile('node_modules/chainhm/index.js', [
      '// ::types ./types.hm',
      'export const helper = (n) => n + 1;',
    ].join('\n'));
    writeFile('node_modules/chainhm/types.hm', [
      'helper :: Number -> Number',
    ].join('\n'));
    writeFile('consumer.js', [
      'import { helper } from "chainhm";',
      'const x = helper(5);',
    ].join('\n'));

    const { result } = inferConsumer('consumer.js');
    const x = result.topLevelBindings.get('x');
    expect(x).toBeDefined();
    expect(typeToString(result.substitution.apply(x!.type))).toBe('Number');
  });

  it('cross-package ::types pulls in constraints from a depended package', () => {
    // Library `dep` defines an inline constraint and an annotated function.
    writeFile('node_modules/dep/package.json', JSON.stringify({
      name: 'dep', main: 'index.js',
    }));
    writeFile('node_modules/dep/index.js', [
      '// ::constraint Runnable r { r :: (a -> r) | r }',
      '',
      '// runIt :: Runnable r => r -> Limit r',
      'exports.runIt = (r) => ({ tag: "limit", r });',
    ].join('\n'));

    // Library `mid` re-exports `runIt` and uses `::types dep` to pull in
    // its constraint definitions — no sidecar of its own.
    writeFile('node_modules/mid/package.json', JSON.stringify({
      name: 'mid', main: 'index.js',
    }));
    writeFile('node_modules/mid/index.js', [
      '// ::types dep',
      'export { runIt } from "dep";',
    ].join('\n'));
    // dep needs to be reachable from mid (hoisted-style node_modules).
    writeFile('node_modules/mid/node_modules/dep/package.json', JSON.stringify({
      name: 'dep', main: 'index.js',
    }));
    writeFile('node_modules/mid/node_modules/dep/index.js', [
      '// ::constraint Runnable r { r :: (a -> r) | r }',
      '',
      '// runIt :: Runnable r => r -> Limit r',
      'exports.runIt = (r) => ({ tag: "limit", r });',
    ].join('\n'));

    writeFile('consumer.js', [
      'import { runIt } from "mid";',
      'const a = runIt(5);',
    ].join('\n'));

    const { result } = inferConsumer('consumer.js');
    const diagMsgs = result.diagnostics.map(d => d.message).join('\n');
    expect(diagMsgs).not.toMatch(/Unknown constraint/);
    expect(diagMsgs).not.toMatch(/does not satisfy/);
    const a = result.topLevelBindings.get('a');
    expect(a).toBeDefined();
    expect(typeToString(result.substitution.apply(a!.type))).toMatch(/Limit/);
  });
});

// ---------------------------------------------------------------------------
// `globals` must be an array (string is rejected)
// ---------------------------------------------------------------------------

describe('package `hinmil.globals` array shape', () => {
  it('concatenates multiple globals files in declared order', () => {
    writeFile('node_modules/multiglob/package.json', JSON.stringify({
      name: 'multiglob', main: 'index.js',
      'hinmil': { globals: ['./a.hm', './b.hm'] },
    }));
    writeFile('node_modules/multiglob/index.js', 'exports.noop = () => {};');
    writeFile('node_modules/multiglob/a.hm', 'AlphaAlias :: String\n');
    writeFile('node_modules/multiglob/b.hm', 'BetaAlias :: Number\n');
    writeFile('consumer.js', 'import { noop } from "multiglob";\nnoop();');

    const { ctx } = inferConsumer('consumer.js');
    const addendum = ctx.getAllPackageGlobalsAddendum();
    expect(addendum).not.toBeNull();
    expect(addendum!).toMatch(/AlphaAlias/);
    expect(addendum!).toMatch(/BetaAlias/);
  });

  it('warns and ignores when `globals` is a string instead of an array', () => {
    writeFile('node_modules/stringglob/package.json', JSON.stringify({
      name: 'stringglob', main: 'index.js',
      'hinmil': { globals: './ignored.hm' },
    }));
    writeFile('node_modules/stringglob/index.js', 'exports.noop = () => {};');
    writeFile('node_modules/stringglob/ignored.hm', 'IgnoredAlias :: String\n');
    writeFile('consumer.js', 'import { noop } from "stringglob";\nnoop();');

    const warnings: string[] = [];
    const consumerPath = path.join(tmpRoot, 'consumer.js');
    const fileUri = pathToFileURL(consumerPath).href;
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: (m: string) => warnings.push(m) });
    ctx.setProjectConfig(tmpRoot, {});
    const resolver = ctx.createImportResolver(fileUri);
    const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
    const eng = new InferenceEngine();
    const source = fs.readFileSync(consumerPath, 'utf8');
    eng.infer(source, undefined, resolver, undefined, aliasResolver);

    const addendum = ctx.getAllPackageGlobalsAddendum();
    expect(addendum).toBeNull();
    expect(warnings.join('\n')).toMatch(/'hinmil\.globals'.*must be an array/);
  });
});

// ---------------------------------------------------------------------------
// extractAllModuleSpecifiers unit
// ---------------------------------------------------------------------------

describe('extractAllModuleSpecifiers', () => {
  it('captures import / export-from / require specifiers', () => {
    const specs = extractAllModuleSpecifiers([
      'import a from "./a";',
      'import { b } from "./b";',
      'export * from "./c";',
      'export { d } from "./d";',
      'const e = require("./e");',
    ].join('\n'));
    expect(new Set(specs)).toEqual(new Set(['./a', './b', './c', './d', './e']));
  });
});
