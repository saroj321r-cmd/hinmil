// Coverage-gap tests for src/services/importContext.ts.
//
// Targets previously-uncovered regions:
//   - perf counters (resetPerfCounters / getPerfCounters)
//   - getImports / clearPackageGlobals / getCircularImports
//   - preloadPackageGlobalsFromWorkspace / preloadInlinePackageAnnotationsFromWorkspace
//   - circular import detection + unreadable/open-document sources in
//     inferFileAndCacheExports
//   - data directives in sidecars (registerAnnotationsFromSource)
//   - findPackageRoot walk-up (package `main` in a subdirectory)
//   - getImportedRawSignature: override / conventional / companion / local-JS
//     fallback / miss paths
//   - createImportResolver: missing override warning, override-only return,
//     `@hm/<pkg>` companion sidecar exports + runtime supplementation
//   - createTypeDirectiveResolver: non-`.hm` file passthrough, unreadable sidecar
//   - createImportTypeAliasResolver: companion sidecar aliases, unreadable
//     per-file sidecar, unreadable transitive source
//   - findTypeDefinitions: `<globals>` and `<globals ::types>` origins, and
//     the override branch of collectGlobalDirectiveSidecarPaths

import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { InferenceResult } from '../../src/infer/types';
import { ImportInferenceContext } from '../../src/services/importContext';
import { wrapHmSource, clearInlinePackageCache } from '../../src/services/files';
import { resetTypeVarCounter, typeToString } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import { TempProject } from '../helpers/project';

/** chmod-based unreadability tests are meaningless when running as root. */
const itNonRoot =
  typeof process.getuid === 'function' && process.getuid() === 0 ? it.skip : it;

/** Fresh ctx with captured warnings. */
function makeCtx(project: TempProject): { ctx: ImportInferenceContext; warns: string[] } {
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const warns: string[] = [];
  const ctx = new ImportInferenceContext(docs, { warn: (m) => warns.push(m) });
  ctx.setProjectConfig(project.root, project.projectConfig);
  return { ctx, warns };
}

/** Infer `source` as file `rel` reusing an existing ctx (unlike project.inferSource). */
function inferWith(
  ctx: ImportInferenceContext,
  project: TempProject,
  rel: string,
  source: string,
): InferenceResult {
  const uri = pathToFileURL(project.pathOf(rel)).href;
  clearCustomMethods();
  resetTypeVarCounter();
  const engine = new InferenceEngine();
  return engine.infer(
    source,
    undefined,
    ctx.createImportResolver(uri),
    ctx.createTypeDirectiveResolver(uri),
    ctx.createImportTypeAliasResolver(uri),
  );
}

// ---------------------------------------------------------------------------
// Perf counters, dependency accessors, cycle detection
// ---------------------------------------------------------------------------

describe('perf counters and dependency graph accessors', () => {
  const project = new TempProject('importctx-gaps-basic');

  beforeAll(() => {
    project.setup();
    project.write('lib.js', [
      '// double :: Number -> Number',
      'export const double = (x) => x * 2;',
    ].join('\n'));
  });
  afterAll(() => project.cleanup());

  it('tracks cache misses/hits and infer calls; resetPerfCounters zeroes them', () => {
    const { ctx } = makeCtx(project);
    const libUri = pathToFileURL(project.pathOf('lib.js')).href;

    expect(ctx.getPerfCounters()).toEqual({
      inferCalls: 0, cacheHits: 0, cacheMisses: 0, circular: 0,
    });

    clearCustomMethods();
    resetTypeVarCounter();
    const first = ctx.inferFileAndCacheExports(libUri);
    expect(first?.has('double')).toBe(true);
    let counters = ctx.getPerfCounters();
    expect(counters.inferCalls).toBe(1);
    expect(counters.cacheMisses).toBe(1);

    const second = ctx.inferFileAndCacheExports(libUri);
    expect(second?.has('double')).toBe(true);
    counters = ctx.getPerfCounters();
    expect(counters.cacheHits).toBe(1);
    expect(counters.inferCalls).toBe(1);

    ctx.resetPerfCounters();
    expect(ctx.getPerfCounters()).toEqual({
      inferCalls: 0, cacheHits: 0, cacheMisses: 0, circular: 0,
    });
  });

  it('getImports returns forward dependencies (and undefined for unknown uris)', () => {
    const { ctx } = makeCtx(project);
    ctx.trackDependency('file:///a.js', 'file:///b.js');
    expect(ctx.getImports('file:///a.js')?.has('file:///b.js')).toBe(true);
    expect(ctx.getImports('file:///unknown.js')).toBeUndefined();
    expect(ctx.getDependents('file:///b.js')?.has('file:///a.js')).toBe(true);
  });

  it('getCircularImports finds direct and indirect cycles but not acyclic deps', () => {
    const { ctx } = makeCtx(project);
    expect(ctx.getCircularImports('file:///nope.js').size).toBe(0);

    // a → b → c → a  (indirect cycle) and a → d (acyclic)
    ctx.trackDependency('file:///a.js', 'file:///b.js');
    ctx.trackDependency('file:///b.js', 'file:///c.js');
    ctx.trackDependency('file:///c.js', 'file:///a.js');
    ctx.trackDependency('file:///a.js', 'file:///d.js');

    const circular = ctx.getCircularImports('file:///a.js');
    expect(circular.has('file:///b.js')).toBe(true);
    expect(circular.has('file:///d.js')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Workspace preloading of package globals + inline annotations
// ---------------------------------------------------------------------------

describe('workspace preloading (globals + inline annotations)', () => {
  const project = new TempProject('importctx-gaps-preload');

  beforeAll(() => {
    project.setup();
    project.write('package.json', JSON.stringify({
      name: 'consumer-workspace',
      dependencies: { globpkg: '1.0.0' },
      'hinmil': { globals: ['./ws-globals.hm'] },
    }));
    project.write('ws-globals.hm', 'WS_MARKER :: Number\n');
    project.write('node_modules/globpkg/package.json', JSON.stringify({
      name: 'globpkg',
      main: 'index.js',
      'hinmil': { globals: ['./globals.hm'] },
    }));
    project.write('node_modules/globpkg/index.js', [
      '// inc :: Number -> Number',
      'exports.inc = (x) => x + 1;',
    ].join('\n'));
    project.write('node_modules/globpkg/globals.hm', 'GLOBAL_MARKER :: Number\n');
  });
  afterAll(() => project.cleanup());
  beforeEach(() => clearInlinePackageCache());

  it('preloadPackageGlobalsFromWorkspace registers globals found on the walk-up', () => {
    const { ctx } = makeCtx(project);
    expect(ctx.getAllPackageGlobalsAddendum()).toBeNull();
    // NOTE: findPackageGlobalsPaths starts its package.json walk at
    // dirname(entryPath); preload passes the package DIRECTORY, so the
    // dependency's own manifest is skipped and the walk lands on the
    // workspace manifest — whose `hinmil.globals` entries get registered.
    ctx.preloadPackageGlobalsFromWorkspace(project.root);
    const addendum = ctx.getAllPackageGlobalsAddendum();
    expect(addendum).not.toBeNull();
    expect(addendum).toContain('WS_MARKER :: Number');
  });

  it('recordPackageGlobals registers globals and clearPackageGlobals drops them', () => {
    const { ctx } = makeCtx(project);
    const fromUri = pathToFileURL(project.pathOf('consumer.js')).href;
    ctx.recordPackageGlobals(fromUri, project.pathOf('node_modules/globpkg/index.js'));
    const addendum = ctx.getAllPackageGlobalsAddendum();
    expect(addendum).not.toBeNull();
    expect(addendum).toContain('GLOBAL_MARKER :: Number');

    ctx.clearPackageGlobals();
    expect(ctx.getAllPackageGlobalsAddendum()).toBeNull();
  });

  it('preloadPackageGlobalsFromWorkspace is a no-op for a root without package.json', () => {
    const { ctx } = makeCtx(project);
    ctx.preloadPackageGlobalsFromWorkspace('/nonexistent-hm-root');
    expect(ctx.getAllPackageGlobalsAddendum()).toBeNull();
  });

  it('preloadInlinePackageAnnotationsFromWorkspace warms scans without throwing', () => {
    const { ctx } = makeCtx(project);
    expect(() => ctx.preloadInlinePackageAnnotationsFromWorkspace(project.root)).not.toThrow();
    expect(() => ctx.preloadInlinePackageAnnotationsFromWorkspace('/nonexistent-hm-root')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// inferFileAndCacheExports: circular imports, open documents, unreadable files
// ---------------------------------------------------------------------------

describe('inferFileAndCacheExports edge cases', () => {
  const project = new TempProject('importctx-gaps-infer');

  beforeAll(() => {
    project.setup();
    project.write('a.js', [
      "import { b } from './b.js';",
      'export const a = 1;',
    ].join('\n'));
    project.write('b.js', [
      "import { a } from './a.js';",
      'export const b = 2;',
    ].join('\n'));
  });
  afterAll(() => project.cleanup());

  it('detects circular imports and warns once per cycle hit', () => {
    const { ctx, warns } = makeCtx(project);
    const aUri = pathToFileURL(project.pathOf('a.js')).href;
    const source = fs.readFileSync(project.pathOf('a.js'), 'utf8');

    const result = inferWith(ctx, project, 'a.js', source);
    expect(result).toBeDefined();
    expect(warns.some((w) => w.includes('Circular import detected'))).toBe(true);
    expect(ctx.getPerfCounters().circular).toBeGreaterThan(0);
    // The dep graph reflects the a ↔ b cycle.
    expect(ctx.getCircularImports(aUri).size).toBeGreaterThan(0);
  });

  it('prefers an open editor document over the on-disk file', () => {
    const virtualUri = pathToFileURL(project.pathOf('virtual-only.js')).href;
    const docsMap = new Map<string, TextDocument>();
    docsMap.set(
      virtualUri,
      TextDocument.create(virtualUri, 'javascript', 1, 'export const fromDoc = 42;\n'),
    );
    const docsStub = { get: (uri: string) => docsMap.get(uri) } as unknown as TextDocuments<TextDocument>;
    const ctx = new ImportInferenceContext(docsStub, { warn: () => {} });

    clearCustomMethods();
    resetTypeVarCounter();
    // The file does not exist on disk — content must come from the document.
    const exports = ctx.inferFileAndCacheExports(virtualUri);
    expect(exports?.has('fromDoc')).toBe(true);
  });

  it('returns null and warns when the import cannot be read', () => {
    const { ctx, warns } = makeCtx(project);
    const missingUri = pathToFileURL(project.pathOf('does-not-exist.js')).href;
    expect(ctx.inferFileAndCacheExports(missingUri)).toBeNull();
    expect(warns.some((w) => w.includes('Failed to read import'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Import resolver: deep `main`, data directives, overrides, companion packages
// ---------------------------------------------------------------------------

describe('createImportResolver gap paths', () => {
  const project = new TempProject('importctx-gaps-resolver');

  beforeAll(() => {
    project.setup();

    // Package whose resolved entry (the sidecar — `resolveNodeModulePackage`
    // prefers `hinmil.sidecars`) lives in a subdirectory, so
    // supplementWithRuntimeExports' findPackageRoot must walk up to find
    // package.json.  The sidecar carries a `data` shorthand too.
    project.write('node_modules/deepmain/package.json', JSON.stringify({
      name: 'deepmain',
      main: './lib/index.js',
      'hinmil': { sidecars: './types/deep.hm' },
    }));
    project.write('node_modules/deepmain/lib/index.js',
      'module.exports = { deepFn: (x) => x, runtimeOnly: 7 };\n');
    project.write('node_modules/deepmain/types/deep.hm', [
      'deepFn :: Number -> Number',
      'Shape :: Circle Number | Square Number',
      '',
    ].join('\n'));

    // Package with NO sidecar and no inline annotations, but a `@hm/<pkg>`
    // companion package that carries the types.
    project.write('node_modules/bpkg/package.json', JSON.stringify({
      name: 'bpkg', main: 'index.js',
    }));
    project.write('node_modules/bpkg/index.js',
      'module.exports = { cfoo: (x) => x, rt: 2 };\n');
    project.write('node_modules/@hm/bpkg/package.json', JSON.stringify({
      name: '@hm/bpkg',
      main: 'index.js',
      'hinmil': { sidecars: './types.hm' },
    }));
    project.write('node_modules/@hm/bpkg/index.js', 'module.exports = {};\n');
    project.write('node_modules/@hm/bpkg/types.hm', 'cfoo :: Number -> Number\n');

    // Override-only "package" (not installed at all).
    project.write('hm-types/onlyovr.hm', 'solo :: Number\n');
  });
  afterAll(() => project.cleanup());
  beforeEach(() => clearInlinePackageCache());

  it('resolves a package whose main lives in a subdirectory and supplements runtime exports', () => {
    const result = project.inferSource('consumer.js', [
      "import { deepFn, runtimeOnly } from 'deepmain';",
      'const n = deepFn(2);',
      'const r = runtimeOnly;',
    ].join('\n'));
    expect(result.diagnostics).toEqual([]);

    // Direct resolver check: the sidecar name is typed, the runtime-only
    // name is supplemented as opaque Any (findPackageRoot walked up from
    // lib/index.js to the package root to require() the module).
    const { ctx } = makeCtx(project);
    const fromUri = pathToFileURL(project.pathOf('consumer.js')).href;
    const exports = ctx.createImportResolver(fromUri)('deepmain');
    expect(exports).toBeInstanceOf(Map);
    const map = exports as Map<string, { type: unknown }>;
    expect(map.has('deepFn')).toBe(true);
    expect(map.has('runtimeOnly')).toBe(true);
    expect(typeToString(map.get('runtimeOnly')!.type as never)).toBe('Any');
  });

  it('warns when a configured override file is missing and the package is unresolvable', () => {
    project.projectConfig = { overrides: { ghostpkg: 'nope.hm' } };
    const { ctx, warns } = makeCtx(project);
    const fromUri = pathToFileURL(project.pathOf('consumer.js')).href;
    const resolver = ctx.createImportResolver(fromUri);

    expect(resolver('ghostpkg')).toBeNull();
    expect(warns.some((w) => w.includes("hm override for 'ghostpkg' not found"))).toBe(true);
    project.projectConfig = {};
  });

  it('returns override exports as-is when the package itself cannot be resolved', () => {
    project.projectConfig = { overrides: { onlyovr: 'hm-types/onlyovr.hm' } };
    const { ctx } = makeCtx(project);
    const fromUri = pathToFileURL(project.pathOf('consumer.js')).href;
    const resolver = ctx.createImportResolver(fromUri);

    const exports = resolver('onlyovr');
    expect(exports).toBeInstanceOf(Map);
    expect((exports as Map<string, unknown>).has('solo')).toBe(true);
    project.projectConfig = {};
  });

  it('falls back to the `@hm/<pkg>` companion sidecar and supplements runtime exports', () => {
    const { ctx } = makeCtx(project);
    const fromUri = pathToFileURL(project.pathOf('consumer.js')).href;
    const resolver = ctx.createImportResolver(fromUri);

    const exports = resolver('bpkg');
    expect(exports).toBeInstanceOf(Map);
    const map = exports as Map<string, { type: unknown }>;
    expect(map.has('cfoo')).toBe(true);
    expect(typeToString(map.get('cfoo')!.type as never)).toContain('Number');
    // `rt` is only a runtime export — supplemented as opaque Any.
    expect(map.has('rt')).toBe(true);
    expect(typeToString(map.get('rt')!.type as never)).toBe('Any');
  });

  it('registerSidecarMethods silently ignores an unreadable sidecar path', () => {
    const { ctx } = makeCtx(project);
    expect(() =>
      (ctx as never as { registerSidecarMethods(p: string): void })
        .registerSidecarMethods(project.pathOf('missing-sidecar.hm')),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getImportedRawSignature
// ---------------------------------------------------------------------------

describe('getImportedRawSignature gap paths', () => {
  const project = new TempProject('importctx-gaps-rawsig');

  beforeAll(() => {
    project.setup();
    project.write('overrides/ovr.hm', 'magic :: Number -> Number\n');
    project.write('hm-types/conv.hm', 'convFn :: String -> String\n');
    project.write('plain.js', [
      '// plainFn :: Number -> Number',
      'export const plainFn = (x) => x;',
    ].join('\n'));

    // Companion-only package (raw signature must come from @hm/bpkg2).
    project.write('node_modules/bpkg2/package.json', JSON.stringify({
      name: 'bpkg2', main: 'index.js',
    }));
    project.write('node_modules/bpkg2/index.js', 'module.exports = { cfoo: 1 };\n');
    project.write('node_modules/@hm/bpkg2/package.json', JSON.stringify({
      name: '@hm/bpkg2',
      main: 'index.js',
      'hinmil': { sidecars: './types.hm' },
    }));
    project.write('node_modules/@hm/bpkg2/index.js', 'module.exports = {};\n');
    project.write('node_modules/@hm/bpkg2/types.hm', 'cfoo :: Number -> Number\n');
  });
  afterAll(() => project.cleanup());
  beforeEach(() => clearInlinePackageCache());

  const fromUri = (): string => pathToFileURL(project.pathOf('consumer.js')).href;

  it('returns the raw signature from a configured project override', () => {
    project.projectConfig = { overrides: { ovr: 'overrides/ovr.hm' } };
    const { ctx } = makeCtx(project);
    expect(ctx.getImportedRawSignature('ovr', 'magic', fromUri())).toBe('Number -> Number');
    project.projectConfig = {};
  });

  it('returns the raw signature from a conventional hm-types/<pkg>.hm stub', () => {
    const { ctx } = makeCtx(project);
    expect(ctx.getImportedRawSignature('conv', 'convFn', fromUri())).toBe('String -> String');
  });

  it('returns null when the configured override file is unreadable', () => {
    project.projectConfig = { overrides: { ghost: 'missing/ghost.hm' } };
    const { ctx } = makeCtx(project);
    expect(ctx.getImportedRawSignature('ghost', 'anything', fromUri())).toBeNull();
    project.projectConfig = {};
  });

  it('finds a raw signature in the `@hm/<pkg>` companion sidecar', () => {
    const { ctx } = makeCtx(project);
    expect(ctx.getImportedRawSignature('bpkg2', 'cfoo', fromUri())).toBe('Number -> Number');
  });

  it('falls back to a leading comment annotation in a project-local JS module', () => {
    const { ctx } = makeCtx(project);
    expect(ctx.getImportedRawSignature('./plain.js', 'plainFn', fromUri())).toBe('Number -> Number');
    // Name without any annotation anywhere → final null return.
    expect(ctx.getImportedRawSignature('./plain.js', 'nope', fromUri())).toBeNull();
  });

  it('readJsRawAnnotationMap returns null for an unreadable file', () => {
    const { ctx } = makeCtx(project);
    const result = (ctx as never as { readJsRawAnnotationMap(p: string): unknown })
      .readJsRawAnnotationMap(project.pathOf('missing.js'));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findTypeDefinitions: globals + `::types` directives in globals
// ---------------------------------------------------------------------------

describe('findTypeDefinitions globals origins', () => {
  const project = new TempProject('importctx-gaps-typedefs');

  beforeAll(() => {
    project.setup();
    project.write('node_modules/mylib/package.json', JSON.stringify({
      name: 'mylib',
      main: 'index.js',
      'hinmil': { sidecars: './types.hm' },
    }));
    project.write('node_modules/mylib/index.js', 'module.exports = {};\n');
    project.write('node_modules/mylib/types.hm', 'Gadget :: { g :: Number }\n');
    project.write('custom/mylib-types.hm', 'Widget :: { w :: Number }\n');
    project.write('globals.hm', '::types mylib\n');
  });
  afterAll(() => project.cleanup());

  it('surfaces a definition declared directly in the project globals', () => {
    const { ctx } = makeCtx(project);
    const fromUri = pathToFileURL(project.pathOf('consumer.js')).href;
    const results = ctx.findTypeDefinitions(
      'Money',
      fromUri,
      'const x = 1;',
      'Money :: { amount :: Number }',
      project.pathOf('globals.hm'),
    );
    expect(results.length).toBe(1);
    expect(results[0].origin).toBe('<globals>');
    expect(results[0].raw).toContain('amount');
  });

  it('surfaces definitions from sidecars referenced by `::types` in globals (incl. override)', () => {
    project.projectConfig = {
      overrides: { mylib: 'custom/mylib-types.hm' },
      globalsSource: wrapHmSource(fs.readFileSync(project.pathOf('globals.hm'), 'utf8')),
      globalsFilePath: project.pathOf('globals.hm'),
    };
    const { ctx } = makeCtx(project);
    const fromUri = pathToFileURL(project.pathOf('consumer.js')).href;

    const gadget = ctx.findTypeDefinitions('Gadget', fromUri, 'const y = 1;', null, null);
    expect(gadget.length).toBe(1);
    expect(gadget[0].origin).toBe('<globals ::types>');

    // The override configured for `mylib` is walked too.
    const widget = ctx.findTypeDefinitions('Widget', fromUri, 'const y = 1;', null, null);
    expect(widget.length).toBe(1);
    expect(widget[0].origin).toBe('<globals ::types>');
    project.projectConfig = {};
  });
});

// ---------------------------------------------------------------------------
// Type directive resolver
// ---------------------------------------------------------------------------

describe('createTypeDirectiveResolver gap paths', () => {
  const project = new TempProject('importctx-gaps-typedir');
  const helperSource = '// Box#unwrap :: Box a ~> () -> a\nexports.helper = 1;\n';

  beforeAll(() => {
    project.setup();
    project.write('helper.js', helperSource);

    // Package with a sidecar that exists but is unreadable.
    project.write('node_modules/permpkg/package.json', JSON.stringify({
      name: 'permpkg',
      main: 'index.js',
      'hinmil': { sidecars: './p.hm' },
    }));
    project.write('node_modules/permpkg/index.js', 'module.exports = {};\n');
    const sealed = project.write('node_modules/permpkg/p.hm', 'secret :: Number\n');
    fs.chmodSync(sealed, 0o000);
  });
  afterAll(() => {
    try { fs.chmodSync(project.pathOf('node_modules/permpkg/p.hm'), 0o644); } catch { /* gone */ }
    project.cleanup();
  });

  it('returns a non-.hm target file verbatim (no wrapping)', () => {
    const { ctx } = makeCtx(project);
    const fromUri = pathToFileURL(project.pathOf('consumer.js')).href;
    const resolver = ctx.createTypeDirectiveResolver(fromUri);
    expect(resolver('./helper.js')).toBe(helperSource);
  });

  it('wraps a relative `.hm` target so the comment parser can read it', () => {
    project.write('local.hm', 'LocalThing :: Number\n');
    const { ctx } = makeCtx(project);
    const fromUri = pathToFileURL(project.pathOf('consumer.js')).href;
    const resolver = ctx.createTypeDirectiveResolver(fromUri);
    const out = resolver('./local.hm');
    expect(out).toBe(wrapHmSource('LocalThing :: Number\n'));
    expect(out).toContain('// LocalThing :: Number');
  });

  itNonRoot('warns and returns null when a package sidecar exists but cannot be read', () => {
    const { ctx, warns } = makeCtx(project);
    const fromUri = pathToFileURL(project.pathOf('consumer.js')).href;
    const resolver = ctx.createTypeDirectiveResolver(fromUri);
    expect(resolver('permpkg')).toBeNull();
    expect(warns.some((w) => w.includes('Failed to read type directive'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Import type alias resolver
// ---------------------------------------------------------------------------

describe('createImportTypeAliasResolver gap paths', () => {
  const project = new TempProject('importctx-gaps-alias');

  beforeAll(() => {
    project.setup();

    // Companion-only aliases: cpkg itself has no sidecar.
    project.write('node_modules/cpkg/package.json', JSON.stringify({
      name: 'cpkg', main: 'index.js',
    }));
    project.write('node_modules/cpkg/index.js', 'module.exports = { p: 1 };\n');
    project.write('node_modules/@hm/cpkg/package.json', JSON.stringify({
      name: '@hm/cpkg',
      main: 'index.js',
      'hinmil': { sidecars: './types.hm' },
    }));
    project.write('node_modules/@hm/cpkg/index.js', 'module.exports = {};\n');
    project.write('node_modules/@hm/cpkg/types.hm',
      'Coord :: { x :: Number, y :: Number }\n');

    // Project file with an unreadable per-file sidecar.
    project.write('alib.js', 'exports.a = 1;\n');
    const sidecar = project.write('alib.js.hm', 'AliasA :: Number\n');
    fs.chmodSync(sidecar, 0o000);

    // Project file that itself cannot be read (transitive-descent guard).
    const sealed = project.write('sealed.js', 'exports.s = 1;\n');
    fs.chmodSync(sealed, 0o000);
  });
  afterAll(() => {
    for (const rel of ['alib.js.hm', 'sealed.js']) {
      try { fs.chmodSync(project.pathOf(rel), 0o644); } catch { /* gone */ }
    }
    project.cleanup();
  });
  beforeEach(() => clearInlinePackageCache());

  it('collects aliases from the `@hm/<pkg>` companion sidecar', () => {
    const { ctx } = makeCtx(project);
    const fromUri = pathToFileURL(project.pathOf('consumer.js')).href;
    const resolver = ctx.createImportTypeAliasResolver(fromUri);

    const result = resolver('cpkg');
    expect(result).not.toBeNull();
    expect(result!.aliases.has('Coord')).toBe(true);
  });

  itNonRoot('ignores an unreadable per-file sidecar (returns null, no throw)', () => {
    const { ctx } = makeCtx(project);
    const fromUri = pathToFileURL(project.pathOf('consumer.js')).href;
    const resolver = ctx.createImportTypeAliasResolver(fromUri);
    expect(resolver('./alib.js')).toBeNull();
  });

  itNonRoot('stops the transitive walk when a project source cannot be read', () => {
    const { ctx } = makeCtx(project);
    const fromUri = pathToFileURL(project.pathOf('consumer.js')).href;
    const resolver = ctx.createImportTypeAliasResolver(fromUri);
    expect(resolver('./sealed.js')).toBeNull();
  });
});
