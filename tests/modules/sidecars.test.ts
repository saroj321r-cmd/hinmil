// `.hm` sidecar resolution — consolidated suite.
//
//   1. Multi-sidecar — `package.json` `hinmil.sidecars` may be a string or an
//      array; all listed `.hm` files load and merge in declared order (later
//      entries override earlier ones for exports AND type aliases), plus
//      imported constructor-as-callable annotations.
//   2. Per-file sidecars — `foo.js.hm` alongside a relatively-imported
//      `foo.js` overrides/augments its inferred exports.
//   3. Hot reload — editing an imported file's annotation comments must be
//      picked up on the next inference via (transitive) dependent-cache
//      invalidation, without an LSP restart.
//   4. Shorthand field alignment — imported `Pair#fst :: a` annotations align
//      their type variable to the receiver's actual type argument.
//   5. Override `.hm` resolution — override files (config `overrides.<pkg>`
//      or `<typesDir>/<pkg>.hm`) resolve peer types from the underlying
//      package's own sidecar(s).

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { findHmSidecarPaths, findHmSidecarPath, loadHmSidecar } from '../../src/services/files';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import {
  getHmDiagnostics,
  getHmDefinition,
  HmServiceContext,
  clearHmParseCache,
} from '../../src/services/hmFileServices';
import { TempProject } from '../helpers/project';

// ---------------------------------------------------------------------------
// From tests/modules/multiSidecar.test.ts
// ---------------------------------------------------------------------------
// Tests for multi-sidecar support: a package's `package.json` `hinmil.sidecars`
// field may be either a single string or an array of strings.  When an
// array, all listed `.hm` files are loaded and merged in declared order
// — later entries override earlier ones, both for value-level exports
// and for type aliases.
//
// This enables a package to ship a hand-written base sidecar alongside
// an auto-generated extension sidecar (e.g. an introspect output that
// lives outside the package directory) without manual user wiring.

describe('multi-sidecar (`hinmil.sidecars` string or array)', () => {
  const project = new TempProject('sidecars-multi');

  beforeAll(() => {
    project.setup();

    // Package `pkgArr` declares two sidecars: a hand-written base and an
    // auto-generated extension that lives OUTSIDE the package directory
    // (`../.pkgArr/index.hm`).  Both should be discovered.
    project.write('node_modules/pkgArr/package.json', JSON.stringify({
      name: 'pkgArr',
      main: 'index.js',
      'hinmil': { sidecars: ['./base.hm', '../.pkgArr/extra.hm'] },
    }));
    project.write('node_modules/pkgArr/index.js', [
      'exports.makeThing = (xs) => ({ items: xs });',
      'exports.tables = {};',
    ].join('\n'));
    project.write('node_modules/pkgArr/base.hm', [
      'Schema :: a',
      'makeThing :: a -> Thing a',
      'tables :: Schema',
      '',
    ].join('\n'));
    project.write('node_modules/.pkgArr/extra.hm', [
      'Schema :: { users :: { id :: Number, name :: String }, posts :: { title :: String } }',
      '',
    ].join('\n'));

    // Single-string form still works (regression check).
    project.write('node_modules/pkgSingle/package.json', JSON.stringify({
      name: 'pkgSingle',
      main: 'index.js',
      'hinmil': { sidecars: './only.hm' },
    }));
    project.write('node_modules/pkgSingle/index.js', 'exports.x = 1;');
    project.write('node_modules/pkgSingle/only.hm', 'x :: Number\n');
  });

  afterAll(() => project.cleanup());

  describe('findHmSidecarPaths', () => {
    it('returns all paths declared in an `hinmil.sidecars` array', () => {
      const entry = project.pathOf('node_modules/pkgArr/index.js');
      const paths = findHmSidecarPaths(entry);
      expect(paths).toHaveLength(2);
      expect(paths[0]).toBe(project.pathOf('node_modules/pkgArr/base.hm'));
      expect(paths[1]).toBe(project.pathOf('node_modules/.pkgArr/extra.hm'));
    });

    it('still returns a single path for the legacy string form', () => {
      const entry = project.pathOf('node_modules/pkgSingle/index.js');
      const paths = findHmSidecarPaths(entry);
      expect(paths).toEqual([project.pathOf('node_modules/pkgSingle/only.hm')]);
    });

    it('skips entries whose target file does not exist', () => {
      const dir = project.pathOf('node_modules/pkgGap');
      project.write('node_modules/pkgGap/package.json', JSON.stringify({
        name: 'pkgGap', main: 'index.js',
        'hinmil': { sidecars: ['./present.hm', './missing.hm'] },
      }));
      project.write('node_modules/pkgGap/index.js', 'exports.y = 2;');
      project.write('node_modules/pkgGap/present.hm', 'y :: Number\n');
      const paths = findHmSidecarPaths(path.join(dir, 'index.js'));
      expect(paths).toEqual([path.join(dir, 'present.hm')]);
    });
  });

  describe('findHmSidecarPath (legacy single-result)', () => {
    it('returns the first sidecar from an array', () => {
      const entry = project.pathOf('node_modules/pkgArr/index.js');
      expect(findHmSidecarPath(entry)).toBe(
        project.pathOf('node_modules/pkgArr/base.hm'),
      );
    });
  });

  describe('loadHmSidecar with multiple files', () => {
    it('merges all sidecars; later entries override earlier ones', () => {
      const entry = project.pathOf('node_modules/pkgArr/index.js');
      const exports = loadHmSidecar(entry);
      expect(exports).not.toBeNull();
      // `Schema` defined in BOTH sidecars; extra.hm (last) must win.
      // We can't easily inspect Scheme shape directly here; verify by
      // checking that `tables` (from base.hm) survives merging too.
      expect(exports!.has('makeThing')).toBe(true);
      expect(exports!.has('tables')).toBe(true);
      expect(exports!.has('Schema')).toBe(true);
    });
  });

  describe('alias resolver merges aliases across sidecars (later wins)', () => {
    it('Schema alias from extra.hm overrides the placeholder in base.hm', () => {
      project.write('src/m1.js', [
        'import { tables } from "pkgArr";',
        'export const u = tables.users;',
      ].join('\n'));
      const result = project.inferFile('src/m1.js');
      // No diagnostics: `tables :: Schema`, Schema expands to the rich record
      // declared in extra.hm, and `.users` is a valid field.
      expect(result.diagnostics.map(d => d.message)).toEqual([]);
    });

    it('accessing a field NOT in the extended Schema produces a diagnostic', () => {
      project.write('src/m2.js', [
        'import { tables } from "pkgArr";',
        'export const z = tables.bogus;',
      ].join('\n'));
      const result = project.inferFile('src/m2.js');
      const msgs = result.diagnostics.map(d => d.message);
      expect(msgs.some(m => m.includes("'bogus'"))).toBe(true);
    });
  });

  describe('imported constructor-as-callable annotation', () => {
    beforeAll(() => {
      // Package `pkgCallable` exports `mkBox(x)` returning a `Box a`.  The
      // sidecar declares `Box` BOTH as a bare value type and as a callable
      // overload `Box :: a -> Wrapped a`.  Calling a value of type `Box a`
      // should yield `Wrapped a` — even with zero arguments — by consulting
      // the imported callable scheme.
      project.write('node_modules/pkgCallable/package.json', JSON.stringify({
        name: 'pkgCallable',
        main: 'index.js',
        'hinmil': { sidecars: './pkgCallable.hm' },
      }));
      project.write('node_modules/pkgCallable/index.js', [
        'exports.mkBox = (x) => ({ value: x });',
      ].join('\n'));
      project.write('node_modules/pkgCallable/pkgCallable.hm', [
        'mkBox :: a -> Box a',
        'Box :: a -> Wrapped a',
        'Box :: a',
        'Wrapped :: a',
        '',
      ].join('\n'));
    });

    it('zero-arg call on a TCon-typed value uses the imported callable overload', () => {
      project.write('src/cb.js', [
        'import { mkBox } from "pkgCallable";',
        'const b = mkBox(1);',
        'export const w = b();',
      ].join('\n'));
      const result = project.inferFile('src/cb.js');
      expect(result.diagnostics.map(d => d.message)).toEqual([]);
      const wScheme = result.exports?.get('w');
      expect(wScheme).toBeDefined();
      // The exact rendering depends on the engine; just check the head ctor.
      const t = wScheme!.type;
      // Walk through any TVar binding via no substitution context here; the
      // engine generalizes exports, so the surface type is what we want.
      expect(t.tag === 'TCon' && t.name === 'Wrapped').toBe(true);
    });

    it('exposes the imported callable scheme on the inference result', () => {
      project.write('src/cb2.js', [
        'import { mkBox } from "pkgCallable";',
        'export const b = mkBox(1);',
      ].join('\n'));
      const result = project.inferFile('src/cb2.js');
      const boxScheme = result.importedConstructors?.get('Box');
      expect(boxScheme).toBeDefined();
      // The two `Box ::` declarations merge into a Union containing the
      // callable overload (a -> Wrapped a) and the bare value form (a).
      const t = boxScheme!.type;
      if (t.tag === 'TFun') {
        // Single callable overload form
        // (acceptable if merging changes in future)
      } else {
        expect(t.tag === 'TCon' && t.name === 'Union').toBe(true);
        const branches = (t as any).args as { tag: string }[];
        expect(branches.some(a => a.tag === 'TFun')).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// From tests/modules/perFileSidecar.test.ts
// ---------------------------------------------------------------------------
// Tests for per-file `.hm` sidecars on relative imports.
// When a file `foo.js` is imported from another project file and `foo.js.hm`
// exists alongside it, the sidecar declarations override (or augment) the
// inferred exports of `foo.js`.

describe('per-file `.hm` sidecar', () => {
  const project = new TempProject('sidecars-perfile');

  beforeAll(() => project.setup());
  afterAll(() => project.cleanup());

  test('sidecar declaration overrides inferred export', () => {
    // Source export `tables` would otherwise infer as Object/{} — sidecar
    // pins it to a known record shape.
    project.write('src/db/index.js', [
      'export const tables = {};',
      'export const querier = (s, p) => Promise.resolve([]);',
    ].join('\n'));
    project.write('src/db/index.js.hm', [
      'tables :: { organisation :: { Organisation :: Table, Member :: Table } }',
      '',
    ].join('\n'));

    project.write('src/repo.js', [
      'import { tables, querier } from "./db";',
      'const { Organisation, Member } = tables.organisation;',
      'export const t = Organisation;',
      'export const m = Member;',
    ].join('\n'));

    const result = project.inferFile('src/repo.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('inferred exports survive when sidecar only covers some names', () => {
    project.write('src/mixed/index.js', [
      'export const tables = {};',
      'export const helper = x => x + 1;',
    ].join('\n'));
    project.write('src/mixed/index.js.hm', [
      'tables :: { foo :: Number }',
      '',
    ].join('\n'));

    project.write('src/mixedConsumer.js', [
      'import { tables, helper } from "./mixed";',
      'export const a = tables.foo;       // from sidecar',
      'export const b = helper(1);        // from inference',
    ].join('\n'));

    const result = project.inferFile('src/mixedConsumer.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('absent sidecar leaves inferred exports untouched', () => {
    project.write('src/plain/index.js', [
      'export const x = 42;',
    ].join('\n'));

    project.write('src/plainConsumer.js', [
      'import { x } from "./plain";',
      'export const y = x + 1;',
    ].join('\n'));

    const result = project.inferFile('src/plainConsumer.js');
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// From tests/modules/sidecarHotReload.test.ts
// ---------------------------------------------------------------------------
// Regression: when an imported JS file's annotation comment is edited
// (e.g. adding `// RTask#map :: ...`), the consumer must see the new
// method on the next inference — without requiring an LSP restart.

describe('imported method annotation edit is picked up without restart', () => {
  const project = new TempProject('sidecars-hot-reload');
  let rtaskPath: string;
  let consumerPath: string;
  let ctx: ImportInferenceContext;

  function inferConsumer(context: ImportInferenceContext, consumer: string) {
    const fileUri = pathToFileURL(consumer).href;
    const resolver = context.createImportResolver(fileUri);
    const aliasResolver = context.createImportTypeAliasResolver(fileUri);
    const eng = new InferenceEngine();
    const source = fs.readFileSync(consumer, 'utf8');
    return eng.infer(source, undefined, resolver, undefined, aliasResolver);
  }

  beforeEach(() => {
    project.setup();
    rtaskPath = project.pathOf('src/lib/RTask/RTask.js');
    consumerPath = project.pathOf('src/db/Repo.js');

    // Initial RTask.js — no `map` annotation, opaque body.
    project.write('src/lib/RTask/RTask.js', [
      '// RTask :: ((e -> (), a -> (), r) -> *) -> RTask r e a',
      'function RTask(fork) { this.fork = fork; }',
      'module.exports = { RTask };',
    ].join('\n'));

    // Re-export barrel (the same shape as the user's lib/RTask/index.js).
    project.write('src/lib/RTask/index.js', [
      'const { RTask } = require("./RTask");',
      'module.exports = { RTask };',
    ].join('\n'));

    project.write('src/db/Repo.js', [
      'const { RTask } = require("../lib/RTask");',
      '// makeTask :: () -> RTask r e a',
      'function makeTask() { return RTask(() => {}); }',
      'const t = makeTask();',
      'const r = t.map(x => x + 1);',
      'module.exports = { r };',
    ].join('\n'));

    ctx = project.createContext();
  });

  afterEach(() => project.cleanup());

  test('only-direct invalidation is NOT enough when re-export barrel sits in between', () => {
    // First inference: prime the import cache (no `map` annotation present).
    inferConsumer(ctx, consumerPath);

    // User adds the method annotation to RTask.js, simulating an editor save.
    project.write('src/lib/RTask/RTask.js', [
      '// RTask :: ((e -> (), a -> (), r) -> *) -> RTask r e a',
      '// RTask#map :: RTask r e a ~> (a -> b) -> RTask r e b',
      'function RTask(fork) { this.fork = fork; }',
      'module.exports = { RTask };',
    ].join('\n'));

    // Invalidate ONLY the changed file and the consumer (the broken
    // shallow-invalidation behaviour).  The barrel `index.js` keeps its
    // cached method-snapshot — which lacks the new RTask#map.
    const rtaskUri = pathToFileURL(rtaskPath).href;
    const consumerUri = pathToFileURL(consumerPath).href;
    ctx.invalidateFileCache(rtaskUri);
    ctx.invalidateFileCache(consumerUri);

    inferConsumer(ctx, consumerPath);
    const { lookupMethod } = require('../../src/registries/methodRegistry');
    expect(lookupMethod('RTask', 'map')).toBeNull();
  });

  test('transitive dependency invalidation: editing a re-exported file is picked up by the consumer', () => {
    // Models the user's real case: `db/Repo.js` imports `lib/RTask`,
    // which is a barrel re-export of `lib/RTask/RTask.js`.  Editing
    // RTask.js to add `// RTask#map :: ...` must invalidate Repo.js's
    // cache too — even though Repo.js does NOT directly import RTask.js
    // (it imports the barrel index.js).  This is what `server.ts`
    // `invalidateFileAndDependents` does by walking the dependents
    // graph transitively.
    inferConsumer(ctx, consumerPath);

    // Add the annotation to the deeply-imported RTask.js.
    project.write('src/lib/RTask/RTask.js', [
      '// RTask :: ((e -> (), a -> (), r) -> *) -> RTask r e a',
      '// RTask#map :: RTask r e a ~> (a -> b) -> RTask r e b',
      'function RTask(fork) { this.fork = fork; }',
      'module.exports = { RTask };',
    ].join('\n'));

    // Simulate server.ts `invalidateFileAndDependents(rtaskUri)` which
    // walks the dependent chain transitively.
    const rtaskUri = pathToFileURL(rtaskPath).href;
    const visited = new Set<string>([rtaskUri]);
    const queue: string[] = [rtaskUri];
    ctx.invalidateFileCache(rtaskUri);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const dependents = ctx.getDependents(cur);
      if (!dependents) continue;
      for (const depUri of dependents) {
        if (visited.has(depUri)) continue;
        visited.add(depUri);
        queue.push(depUri);
        ctx.invalidateFileCache(depUri);
      }
    }

    // The transitive walk must have invalidated the consumer too.
    const consumerUri = pathToFileURL(consumerPath).href;
    expect(visited.has(consumerUri)).toBe(true);

    // Re-infer the consumer: the new method must now be visible.
    inferConsumer(ctx, consumerPath);
    const { lookupMethod } = require('../../src/registries/methodRegistry');
    expect(lookupMethod('RTask', 'map')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// From tests/modules/sidecarShorthandFieldAlignment.test.ts
// ---------------------------------------------------------------------------
// Regression (Wave 3, sidecar/import path): shorthand field annotations
// (`Pair#fst :: a`) imported from another module must align their type
// variable to the receiver's actual type argument, so that `p.fst` on a
// `Pair Number String` resolves to `Number` (its first component) — not a
// fresh, freely-unifying variable.
//
// Previously the import-side registration path called
// registerAnnotationMethod WITHOUT the constructor's declared type-param
// names, so the shorthand factory fell back to a fresh disconnected
// variable: `p.fst` would silently unify with anything (no diagnostic on
// misuse).

describe('imported shorthand field alignment (Wave 3)', () => {
  const project = new TempProject('sidecars-shorthand-field');

  beforeEach(() => clearCustomMethods());

  beforeAll(() => {
    project.setup();
    project.write('pair.js', [
      '// Pair :: (a, b) -> Pair a b',
      '// Pair#fst :: a',
      '// Pair#snd :: b',
      'function Pair(a, b) { this.fst = a; this.snd = b; }',
      'module.exports = { Pair };',
      '',
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  function inferConsumer(body: string): string[] {
    const source = ["const { Pair } = require('./pair');", body, ''].join('\n');
    project.write('consumer.js', source);
    const result = project.inferSource('consumer.js', source);
    return result.diagnostics.map(d => d.message);
  }

  test('p.fst on `Pair Number String` matches a `Number` annotation', () => {
    const diags = inferConsumer('// good :: Pair Number String -> Number\nconst good = p => p.fst;');
    expect(diags).toEqual([]);
  });

  test('p.fst on `Pair Number String` mismatches a `String` annotation', () => {
    // `fst` is the FIRST component (Number); annotating the result as String
    // must raise a diagnostic.  Without alignment, `p.fst` is a fresh var and
    // would silently unify with String (no error).
    const diags = inferConsumer('// bad :: Pair Number String -> String\nconst bad = p => p.fst;');
    expect(diags.join('\n')).toMatch(/Cannot unify|Type mismatch/);
  });

  test('p.snd on `Pair Number String` matches a `String` annotation', () => {
    const diags = inferConsumer('// good :: Pair Number String -> String\nconst good = p => p.snd;');
    expect(diags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// From tests/modules/overrideSidecarResolve.test.ts
// ---------------------------------------------------------------------------
// Override `.hm` files (configured via package.json#hinmil.overrides.<pkg>
// or placed under `<typesDir>/<pkg>.hm`) should resolve peer types from
// the underlying package's own sidecar(s).  Without this, declarations
// like `Limit / Offset / Selector` referenced in the override get
// flagged as "Unknown type constructor".

describe('Override .hm files resolve peer declarations from underlying sidecar', () => {
  const project = new TempProject('sidecars-override-resolve');

  function makeCtx(overrideRel: string): { source: string; uri: string; ctx: HmServiceContext } {
    const overridePath = project.pathOf(overrideRel);
    const uri = pathToFileURL(overridePath).href;
    const source = fs.readFileSync(overridePath, 'utf8');
    const importCtx = project.createContext();
    const ctx: HmServiceContext = {
      findTypeDefinitions: (n) => importCtx.findTypeDefinitions(n, uri, source, null, null),
      globals: null,
    };
    return { source, uri, ctx };
  }

  beforeAll(() => {
    project.setup();
    project.projectConfig = { overrides: { sqlkit: 'hm-types/sqlkit.hm' } };

    // Underlying package sidecar — declares Limit / Offset / Selector.
    project.write('node_modules/sqlkit/package.json', JSON.stringify({
      name: 'sqlkit', main: 'index.js', 'hinmil': { sidecars: './sqlkit.hm' },
    }));
    project.write('node_modules/sqlkit/index.js', 'module.exports = {};\n');
    project.write('node_modules/sqlkit/sqlkit.hm', [
      'Limit  :: a -> Limit a',
      'Offset :: a -> Offset a',
      'Selector :: (String | Limit a | Offset b)',
      'Table :: [a] -> QueryTag p o',
      'QueryTag :: a -> QueryTag a',
      '',
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  beforeEach(() => clearHmParseCache());

  test('explicit packageOverrides entry surfaces sibling types as known', () => {
    project.write('hm-types/sqlkit.hm', [
      '// Override that references peer declarations from sqlkit.hm.',
      'Table() :: [Limit a | Offset b | Selector] -> QueryTag p o',
      '',
    ].join('\n'));
    const { source, uri, ctx } = makeCtx('hm-types/sqlkit.hm');
    const diags = getHmDiagnostics(uri, source, ctx);
    const unknown = diags.filter(d => /Unknown type constructor/.test(d.message));
    expect(unknown).toEqual([]);
  });

  test('go-to-definition jumps from override into node_modules sidecar', () => {
    project.write('hm-types/sqlkit.hm', [
      'Table() :: [Limit a] -> QueryTag p o',
      '',
    ].join('\n'));
    const { source, uri, ctx } = makeCtx('hm-types/sqlkit.hm');
    const offset = source.indexOf('Limit');
    const def = getHmDefinition(uri, source, offset, ctx);
    expect(def).not.toBeNull();
    const loc = Array.isArray(def) ? def[0] : def!;
    expect(loc.uri).toMatch(/node_modules\/sqlkit\/sqlkit\.hm$/);
  });

  test('conventional <typesDir>/<pkg>.hm stub also pulls in package sidecar', () => {
    // No `overrides` config — rely on the conventional path.
    project.write('hm-types/another.hm', '');
    fs.rmSync(project.pathOf('hm-types/sqlkit.hm'), { force: true });
    project.write('hm-types/sqlkit.hm', [
      'helper :: Limit a -> Offset a',
      '',
    ].join('\n'));
    const overridePath = project.pathOf('hm-types/sqlkit.hm');
    const uri = pathToFileURL(overridePath).href;
    const source = fs.readFileSync(overridePath, 'utf8');
    // No overrides config — only typesDir defaults.
    project.projectConfig = {};
    const importCtx = project.createContext();
    const ctx: HmServiceContext = {
      findTypeDefinitions: (n) => importCtx.findTypeDefinitions(n, uri, source, null, null),
      globals: null,
    };
    const diags = getHmDiagnostics(uri, source, ctx);
    const unknown = diags.filter(d => /Unknown type constructor/.test(d.message));
    expect(unknown).toEqual([]);
  });
});
