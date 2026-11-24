// ============================================================================
// Import Inference Context — encapsulates cross-file caching & resolution
//
// Plain language: analysing one file often requires analysing the files it
// imports — which import files of their own.  This context object manages
// that chain: it analyses imported files on demand, caches their results so
// repeated requests are instant, detects cycles, and keeps the global
// registries consistent while switching between files.
// ============================================================================

import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../infer';
import {
  ImportResolver,
  TypeDirectiveResolver,
  ImportTypeAliasResolver,
  UNTYPED_MODULE,
  UntypedModule,
  markOpenWorldExports,
} from '../infer/types';
import { Scheme, Type, mono, tAnyType } from '../hm/types';
import { MethodRegistrySnapshot } from '../registries/methodRegistry';
import {
  GlobalStateSnapshot,
  snapshotGlobalState,
  restoreGlobalRegistries,
  mergeGlobalState,
  bumpTypeVarCounterTo,
} from '../registries/session';
import { resolveImportSpecifier, resolveTypeDirectiveSpecifier, parseHmSource, parseHmSourceRaw, parseHmTypeAliases, parseJsTypeAliases, findHmSidecarPaths, isBareSpecifier, getBarePackageName, conventionalStubRelPaths, hmCompanionPackageName, collectInlinePackageAnnotations, isInlineAnnotatedPackageModule, InlinePackageScan, runtimeExportNamesCache, findPackageGlobalsPaths, findPackageJson, isAssetImportSpecifier } from './files';
import { isFile, clearFsProbeCache } from './fsProbe';
import { timeSidecarStage } from './sidecarPerf';
import { getModuleReps, setModuleReps } from '../infer/moduleReps';
import { extractImportModuleSpecifiers, extractAnnotations, extractTypeDirectives, TYPE_DIRECTIVE_PART_BOUNDARY } from '../commentParser';
import * as path from 'path';

/** True when an absolute path lives under a `node_modules` directory. */
function isUnderNodeModules(absPath: string): boolean {
  const parts = absPath.split(path.sep);
  return parts.includes('node_modules');
}

// ---------------------------------------------------------------------------
// Built-in bundled typings (`hm-types-builtin/`)
// ---------------------------------------------------------------------------
// The extension ships `.hm` typings for a handful of popular packages
// (react, react-dom) so those work with ZERO configuration.  They form the
// weakest layer of the resolution chain: project overrides, conventional
// `hm-types/<pkg>.hm` stubs and package sidecars all merge ON TOP of them
// per export name.  Export maps that include a builtin layer are marked
// open-world (see {@link markOpenWorldExports}) so names missing from the
// bundled catalogue bind to `Any` instead of erroring.

let _builtinTypesDir: string | null | undefined;

/** Override the bundled-typings directory (tests, packaging).  `null` disables. */
export function setBuiltinTypesDir(dir: string | null): void {
  _builtinTypesDir = dir;
}

function getBuiltinTypesDir(): string | null {
  if (_builtinTypesDir !== undefined) return _builtinTypesDir;
  // Compiled layout (`dist/services/`) and source layout (`src/services/`)
  // both sit two levels below the package root that carries the folder.
  for (const candidate of [
    path.resolve(__dirname, '..', '..', 'hm-types-builtin'),
    path.resolve(__dirname, '..', '..', '..', 'hm-types-builtin'),
  ]) {
    try {
      if (fs.statSync(candidate).isDirectory()) return (_builtinTypesDir = candidate);
    } catch { /* try next */ }
  }
  return (_builtinTypesDir = null);
}

/** Absolute path of the bundled `<pkgName>.hm`, or null when not shipped. */
/** The `// ::builtin Name` anchor of a built-in type in the bundled stubs
 *  (`hm-types-builtin/*.hm`), with the range of the anchor line, or null. */
function findBuiltinTypeAnchor(name: string): { sourcePath: string; commentStart: number; commentEnd: number } | null {
  const dir = getBuiltinTypesDir();
  if (!dir || !/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  const re = new RegExp('^\\s*//\\s*::builtin\\s+' + name + '\\b');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.hm')).sort();
  } catch {
    return null;
  }
  for (const f of files) {
    const filePath = path.join(dir, f);
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    let cursor = 0;
    for (const line of text.split('\n')) {
      if (re.test(line)) return { sourcePath: filePath, commentStart: cursor, commentEnd: cursor + line.length };
      cursor += line.length + 1;
    }
  }
  return null;
}

function builtinHmPath(pkgName: string): string | null {
  const dir = getBuiltinTypesDir();
  // Node core modules may be imported with the `node:` scheme
  // (`import { join } from "node:path"`); both forms share one stub.
  if (pkgName.startsWith('node:')) pkgName = pkgName.slice('node:'.length);
  // Flat names only — refuses scoped names ('@a/b') and anything that could
  // escape the directory.
  if (!dir || !/^[\w.-]+$/.test(pkgName)) return null;
  const p = path.join(dir, pkgName + '.hm');
  try {
    return isFile(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Merge a project-level `.hm` override on top of a package-level export
 * map. Override entries win on name collision; absent names fall through
 * to the package map. Returns the package map unchanged when there is
 * no override.
 */
function mergeOverride(
  override: Map<string, Scheme> | null,
  base: Map<string, Scheme>,
): Map<string, Scheme> {
  if (!override || override.size === 0) return base;
  const merged = new Map(base);
  for (const [name, scheme] of override) merged.set(name, scheme);
  return merged;
}

/**
 * Merge two optional Scheme maps into one with `b` overriding `a` on
 * conflict.  Returns the unwrapped non-null side when only one is
 * present, or an empty map when both are absent.
 */
function mergeMaps(
  a: Map<string, Scheme> | null,
  b: Map<string, Scheme> | null,
): Map<string, Scheme> {
  if (!a && !b) return new Map();
  if (!a) return b!;
  if (!b) return a;
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, v);
  return out;
}

/**
 * Walk up from a node_modules entry path to the package root (the
 * directory containing the closest `package.json`). Returns the package
 * directory or null when none can be located.
 */
function findPackageRoot(entryPath: string): string | null {
  let dir = path.dirname(entryPath);
  while (true) {
    if (isFile(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Given a typed export map for an npm package, add an `Any`-typed entry
 * for every name that the package's runtime JS module actually exports
 * but that is not yet covered by the typed map.  Unlike a fresh tvar,
 * `Any` is opaque under unification — it does not pick up a type from
 * the way the import is *used*, which prevents plausible-looking but
 * hallucinated signatures (e.g. inferring `Limit :: Number -> QueryTag b`
 * from a single `Limit(5)` call site).
 *
 * Loading the JS module via `require` is best-effort — failures are
 * swallowed and the original map is returned unchanged.
 */
function supplementWithRuntimeExports(
  exports: Map<string, Scheme>,
  entryPath: string,
  logger: Logger,
): Map<string, Scheme> {
  const pkgRoot = findPackageRoot(entryPath);
  if (!pkgRoot) return exports;
  // Load the RESOLVED module, not the package root: for a subpath import
  // (`FP-library/RTask`) the root's names (`RTask`, `Future`, …) are not this
  // module's exports and must not be bound to `Any`.
  const target = entryPath.endsWith('.hm') ? pkgRoot : entryPath;
  let runtimeExports = runtimeExportNamesCache.get(target);
  if (runtimeExports === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(target) as Record<string, unknown>;
      runtimeExports = mod && typeof mod === 'object' ? Object.keys(mod) : [];
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[hinmil] could not load runtime exports of '${pkgRoot}': ${msg}`);
      runtimeExports = null;
    }
    runtimeExportNamesCache.set(target, runtimeExports);
  }
  if (!runtimeExports || runtimeExports.length === 0) return exports;
  const merged = new Map(exports);
  for (const name of runtimeExports) {
    if (!merged.has(name)) merged.set(name, mono(tAnyType));
  }
  setModuleReps(merged, getModuleReps(exports));
  return merged;
}

/** Minimal logger interface — decouples this module from vscode `connection`. */
export interface Logger {
  warn(message: string): void;
  log?(message: string): void;
}

// ---------------------------------------------------------------------------
// Per-sidecar parse artifacts
// ---------------------------------------------------------------------------

/**
 * Pre-parsed registration payload for one sidecar: everything
 * `registerAnnotationsFromSource` needs to (re-)register the sidecar's
 * declarations into the global registries, with all parsing and alias
 * expansion already done.  Registries are cleared per inference pass, so
 * registration re-runs constantly — but it degrades to cheap Map writes
 * when this payload is cached.
 */
interface PreparedRegistration {
  constraintDefs: import('../registries/constraintRegistry').ConstraintDef[];
  dataDecls: import('../commentParser').DataTypeDecl[];
  /** `Type#method` / `Type.method` annotations with aliases pre-expanded. */
  methodAnns: Array<{
    name: string;
    ann: import('../commentParser').TypeAnnotation;
    typeParams: string[] | undefined;
  }>;
}

/**
 * All derived artifacts of a single `.hm` (or annotation-bearing) file,
 * computed lazily and invalidated by a version stamp: the open document
 * version when the file is open in the editor, or `mtime:size` from disk
 * otherwise.  The stamp is re-checked on every access, so on-disk changes
 * (e.g. a regenerated introspect sidecar under `node_modules`) are picked
 * up without requiring a watcher event.
 */
interface SidecarArtifacts {
  stamp: string;
  source: string;
  /** `parseHmSource` result (export name → Scheme). */
  exports?: Map<string, Scheme>;
  /** `parseHmTypeAliases` result. */
  aliasData?: ReturnType<typeof parseHmTypeAliases>;
  /** `parseJsTypeAliases` result (type names of an imported JS module). */
  jsAliasData?: ReturnType<typeof parseHmTypeAliases>;
  /** `// ::types` specifiers of an imported JS module. */
  typeDirectives?: string[];
  /** Import/require specifiers of an imported JS module. */
  importSpecifiers?: string[];
  /** Raw signature texts (hover/completion). */
  rawMap?: Map<string, string>;
  /** `wrapHmSource(source)` — type-directive resolver payload. */
  wrapped?: string;
  /** Pre-parsed method/constraint/data registration payload. */
  registration?: PreparedRegistration;
}

/**
 * Manages the cross-file inference cache and dependency graph.
 *
 * Centralises the fragile snapshot/restore dance that was previously
 * spread across several loose functions: every import-file inference
 * must snapshot the global method/constraint registries and the
 * type-variable counter, run a *separate* engine, restore the
 * caller's registries, then merge in the import's registrations.
 *
 * By encapsulating this in a single class the logic is easier to
 * reason about, test, and extend (e.g. with parallel inference).
 */

export class ImportInferenceContext {
  /** Maximum number of cached files before LRU eviction kicks in. */
  private static readonly MAX_CACHE_SIZE = 1000;
  /** Maximum nested import depth.  A real project doesn't exceed ~20;
   *  beyond this we assume an accidental fan-out (or a pathological input)
   *  and bail out with a single warning rather than hanging the server. */
  private static readonly MAX_IMPORT_DEPTH = 64;

  /** Cached inference results per file URI — stores exports for import resolution. */
  private fileExports = new Map<string, Map<string, Scheme>>();
  /** Cached registry/counter state per file URI — re-merged on cache hit. */
  private fileStateSnapshots = new Map<string, GlobalStateSnapshot>();
  /** Reverse dependency map: importedFileUri → Set of fileUris that import it. */
  private fileDependents = new Map<string, Set<string>>();
  /** Forward dependency map: fileUri → Set of fileUris it imports. */
  private fileImports = new Map<string, Set<string>>();
  /** LRU order: Map insertion order tracks recency (oldest first). */
  private lruOrder = new Map<string, true>();
  /** Files currently being inferred — used for circular import detection. */
  private inferring = new Set<string>();
  /** Have we already warned the user about LRU evictions? */
  private hasWarnedAboutEviction = false;
  /** Have we already warned the user about exceeding import depth? */
  private hasWarnedAboutImportDepth = false;
  /** Phase K perf counters — reset by {@link resetPerfCounters} at the
   *  start of each top-level validate, read via {@link getPerfCounters}. */
  private perfInferCalls = 0;
  /**
   * Memo of {@link createImportTypeAliasResolver} results per resolved import
   * target (`b|`/`r|` + URI: a bare specifier also consults project
   * overrides).  The result depends only on the target and the files it
   * reaches, not on the importer, so every consumer of e.g. `FP-library/RTask`
   * shares one walk.  Cleared on any file invalidation and on a new project
   * configuration — the LSP routes every document and watched-file change
   * through {@link invalidateFileCache}.
   */
  private importTypeAliasCache = new Map<string, ReturnType<ImportTypeAliasResolver>>();
  private perfCacheHits = 0;
  private perfCacheMisses = 0;
  private perfCircular = 0;
  resetPerfCounters(): void {
    this.perfInferCalls = 0;
    this.perfCacheHits = 0;
    this.perfCacheMisses = 0;
    this.perfCircular = 0;
  }
  getPerfCounters(): { inferCalls: number; cacheHits: number; cacheMisses: number; circular: number } {
    return {
      inferCalls: this.perfInferCalls,
      cacheHits: this.perfCacheHits,
      cacheMisses: this.perfCacheMisses,
      circular: this.perfCircular,
    };
  }
  /**
   * Union of all package globals files (`package.json#hinmil.globals`)
   * ever encountered across any consumer.  Used by
   * {@link getAllPackageGlobalsAddendum} to compose the server's
   * effective globals source in one shot.
   */
  private allPackageGlobals = new Set<string>();

  /**
   * Per-sidecar parse artifact cache, keyed by absolute file path.  Each
   * entry is stamp-validated on access (open-doc version or disk
   * mtime:size), so edits AND out-of-band regeneration (e.g. re-running a
   * package's introspect script) invalidate automatically.
   */
  private sidecarArtifacts = new Map<string, SidecarArtifacts>();

  /** Project root used to resolve user-side `.hm` overrides + conventional `hm-types/` directory. */
  private projectRoot: string | null = null;
  /** Per-package `.hm` path overrides keyed by bare package name. */
  private packageOverrides: Record<string, string> = {};
  /** Project-relative directory checked for `<typesDir>/<pkgName>.hm` stubs. */
  private typesDir: string = 'hm-types';
  /** Project globals source (e.g. content of `globals.hm`).  Cached so the
   *  globals-level `// ::types <specifier>` directives can be resolved at
   *  any time without re-reading the file.  Set via {@link setProjectConfig}. */
  private globalsSource: string | null = null;
  /** Absolute path to the project globals file.  Used as the `from` location
   *  when resolving `// ::types` specifiers declared inside the globals. */
  private globalsFilePath: string | null = null;

  constructor(
    private documents: TextDocuments<TextDocument>,
    private logger: Logger,
  ) {}

  /**
   * Configure project-level `.hm` resolution: an `overrides` map, a
   * `typesDir` to scan for conventional `<pkgName>.hm` stub files, and
   * the current project globals source/path.  The globals are stored so
   * that {@link getProjectGlobalsAddendum} can resolve `// ::types`
   * directives declared inside `globals.hm` and so that methods declared
   * in the resolved sidecars can be eagerly registered.
   *
   * Call this whenever the workspace root, `hinmil` config, or globals
   * file changes.
   */
  setProjectConfig(
    root: string | null,
    cfg: { overrides?: Record<string, string>; typesDir?: string; globalsSource?: string | null; globalsFilePath?: string | null } = {},
  ): void {
    // A (new) project configuration starts from a fresh view of the disk:
    // memoised existence probes from an earlier configuration (e.g. a
    // conventional `hm-types/<pkg>.hm` stub that did not exist yet) must not
    // hide files created since.
    clearFsProbeCache();
    this.importTypeAliasCache.clear();
    this.projectRoot = root;
    this.packageOverrides = cfg.overrides ?? {};
    if (cfg.typesDir) this.typesDir = cfg.typesDir;
    this.globalsSource = cfg.globalsSource ?? null;
    this.globalsFilePath = cfg.globalsFilePath ?? null;
    // Eagerly register methods declared in every sidecar referenced by a
    // `// ::types <specifier>` directive in the project globals file, so
    // that `Type#m` annotations from those sidecars are available before
    // any individual file triggers their import.
    for (const sidecarPath of this.collectGlobalDirectiveSidecarPaths()) {
      this.registerSidecarMethods(sidecarPath);
    }
  }

  /**
   * Resolve every `// ::types <specifier>` directive in the project globals
   * file to its concrete sidecar `.hm` file path(s).  Each specifier is
   * resolved through the same chain used by per-file `::types`:
   *   - project-level `hinmil.overrides.<pkg>` (for bare specifiers);
   *   - conventional `<typesDir>/<pkg>.hm` stub (for bare specifiers);
   *   - the package's own `package.json#hinmil.sidecars` sidecar(s) (for bare specifiers);
   *   - or, for relative/absolute paths, the resolved file directly.
   * Returns an empty array when no globals file is configured.
   */
  private collectGlobalDirectiveSidecarPaths(): string[] {
    if (!this.globalsSource || !this.globalsFilePath) return [];
    const { extractTypeDirectives } = require('../commentParser') as typeof import('../commentParser');
    const fromUri = pathToFileURL(this.globalsFilePath).href;
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (p: string): void => {
      if (seen.has(p)) return;
      seen.add(p);
      out.push(p);
    };
    for (const specifier of extractTypeDirectives(this.globalsSource) as string[]) {
      if (this.projectRoot && isBareSpecifier(specifier)) {
        const pkgName = getBarePackageName(specifier);
        const overrideRel = this.packageOverrides[pkgName];
        if (overrideRel) {
          const op = path.resolve(this.projectRoot, overrideRel);
          try { if (isFile(op)) push(op); } catch { /* missing */ }
        }
        const conv = this.conventionalStubPath(specifier);
        if (conv) push(conv);
      }
      const targetPath = resolveTypeDirectiveSpecifier(specifier, fromUri);
      if (!targetPath) continue;
      if (isBareSpecifier(specifier)) {
        for (const sp of findHmSidecarPaths(targetPath)) push(sp);
      } else {
        // Relative / absolute path — use the resolved file directly.
        push(targetPath);
      }
    }
    return out;
  }

  /**
   * First existing conventional `<typesDir>/…` stub for a bare specifier,
   * subpath-aware (see `conventionalStubRelPaths`): a deep import like
   * `FP-library/RTask/index.js` prefers `<typesDir>/FP-library/RTask/index.hm`, then
   * `<typesDir>/FP-library/RTask.hm`, falling back to the package-level
   * `<typesDir>/FP-library.hm` stub.  Returns null when none exists.
   */
  private conventionalStubPath(specifier: string): string | null {
    if (!this.projectRoot) return null;
    for (const rel of conventionalStubRelPaths(specifier)) {
      const p = path.join(this.projectRoot, this.typesDir, rel);
      try { if (isFile(p)) return p; } catch { /* missing */ }
    }
    return null;
  }

  /**
   * If `fromUri` points at one of this project's `.hm` override files —
   * either a configured `package.json#hinmil.overrides.<pkg>` entry or a
   * conventional `<typesDir>/<pkg>.hm` stub — return that package's bare
   * specifier (e.g. `"query-builder"`).  Otherwise return null.
   *
   * Used so cross-file lookups originating from the override file can
   * still walk the underlying package's own sidecar(s) for peer
   * declarations like `Limit` / `Offset` / `Selector`.
   */
  private implicitSpecifierFromOverrideUri(fromUri: string): string | null {
    let fromPath: string;
    try { fromPath = fileURLToPath(fromUri); } catch { return null; }
    if (!fromPath.endsWith('.hm')) return null;
    const fromAbs = path.resolve(fromPath);
    // 0. Bundled builtin typings directory (`hm-types-builtin/react.hm` →
    //    "react") — recognised without a project root so cross-file lookups
    //    inside the bundled files resolve their peer declarations.
    const builtinDir = getBuiltinTypesDir();
    if (builtinDir && fromAbs.startsWith(path.resolve(builtinDir) + path.sep)) {
      const rel = path.relative(path.resolve(builtinDir), fromAbs);
      if (!rel.includes(path.sep) && rel.endsWith('.hm')) {
        return rel.slice(0, -'.hm'.length);
      }
    }
    if (!this.projectRoot) return null;
    // 1. Explicit override match.
    for (const [pkgName, rel] of Object.entries(this.packageOverrides)) {
      const overridePath = path.resolve(this.projectRoot, rel);
      if (path.resolve(fromPath) === overridePath) return pkgName;
    }
    // 2. Conventional `<typesDir>/…` stub — either the package-level
    //    `<pkgName>.hm` or a subpath stub like `<pkg>/<subpath>.hm`.  The
    //    relative path minus `.hm` doubles as the (extensionless) import
    //    specifier the stub serves.
    const typesRoot = path.resolve(this.projectRoot, this.typesDir);
    if (fromAbs.startsWith(typesRoot + path.sep)) {
      const rel = path.relative(typesRoot, fromAbs);
      if (rel.endsWith('.hm')) {
        return rel.slice(0, -'.hm'.length).split(path.sep).join('/');
      }
    }
    return null;
  }

  /**
   * Return additional `.hm`-wrapped source to be appended to the project
   * globals file.  Built by walking every `// ::types <specifier>`
   * directive in `globals.hm` and resolving it through the same chain as
   * per-file `::types` (project override + conventional `hm-types/<pkg>.hm`
   * + package `hinmil.sidecars` sidecars, or a relative/absolute path).  Returns
   * `null` when the globals file has no `::types` directives or no
   * sidecars resolved.  Consumers are expected to concatenate this with
   * the user-authored globals before assigning to `engine.globalsSource`.
   */
  getProjectGlobalsAddendum(): string | null {
    const sidecarPaths = this.collectGlobalDirectiveSidecarPaths();
    if (sidecarPaths.length === 0) return null;
    const { wrapHmSource } = require('./files') as typeof import('./files');
    const parts: string[] = [];
    for (const p of sidecarPaths) {
      try {
        const docUri = pathToFileURL(p).href;
        const doc = this.documents.get(docUri);
        const raw = doc ? doc.getText() : fs.readFileSync(p, 'utf-8');
        parts.push(wrapHmSource(raw));
      } catch { /* unreadable — skip */ }
    }
    if (parts.length === 0) return null;
    return parts.join('\n' + TYPE_DIRECTIVE_PART_BOUNDARY + '\n');
  }

  // ------- LRU cache management -------

  /** Move `uri` to the end of the LRU map (most recently used). */
  private touchLru(uri: string): void {
    this.lruOrder.delete(uri);
    this.lruOrder.set(uri, true);
  }

  /** Evict the least-recently-used entries until cache is within bounds. */
  private evictIfNeeded(): void {
    while (this.lruOrder.size > ImportInferenceContext.MAX_CACHE_SIZE) {
      const victim = this.lruOrder.keys().next().value;
      if (victim !== undefined) {
        this.lruOrder.delete(victim);
        this.evictEntry(victim);
        if (!this.hasWarnedAboutEviction) {
          this.hasWarnedAboutEviction = true;
          this.logger.warn(
            `[hinmil] Import cache exceeded ${ImportInferenceContext.MAX_CACHE_SIZE} files; ` +
            `least-recently-used entries will be re-inferred on demand. ` +
            `Cross-file features may be slower until the cache warms up again.`,
          );
        }
      }
    }
  }

  /** Remove all cached data for a single file without touching the LRU list. */
  private evictEntry(uri: string): void {
    this.fileExports.delete(uri);
    this.fileStateSnapshots.delete(uri);
  }

  // ------- dependency tracking -------

  /** Record that `fromUri` depends on `targetUri` (both forward and reverse). */
  trackDependency(fromUri: string, targetUri: string): void {
    if (!this.fileDependents.has(targetUri)) this.fileDependents.set(targetUri, new Set());
    this.fileDependents.get(targetUri)!.add(fromUri);
    if (!this.fileImports.has(fromUri)) this.fileImports.set(fromUri, new Set());
    this.fileImports.get(fromUri)!.add(targetUri);
  }

  getDependents(uri: string): Set<string> | undefined {
    return this.fileDependents.get(uri);
  }

  getImports(uri: string): Set<string> | undefined {
    return this.fileImports.get(uri);
  }

  /**
   * Record that `fromUri` (a consumer file) saw a package globals file
   * along the resolution chain.  Registers the globals path so it
   * contributes to {@link getAllPackageGlobalsAddendum}, and ties the
   * consumer's cache freshness to the globals file via
   * {@link trackDependency}.  No-op when the package has no globals.
   */
  recordPackageGlobals(fromUri: string, targetPath: string): void {
    const globalsPaths = findPackageGlobalsPaths(targetPath, this.logger);
    if (globalsPaths.length === 0) return;
    for (const globalsPath of globalsPaths) {
      this.allPackageGlobals.add(globalsPath);
      // Tie the consumer's freshness to changes in the globals file too.
      this.trackDependency(fromUri, pathToFileURL(globalsPath).href);
    }
  }

  /** Drop any cached package globals (used on full reload). */
  clearPackageGlobals(): void {
    this.allPackageGlobals.clear();
  }

  /**
   * Concatenated source of every package globals file ever seen across
   * all consumers, deduped by absolute path.  Returned in deterministic
   * (insertion) order.  `null` when none have been recorded.
   */
  getAllPackageGlobalsAddendum(): string | null {
    if (this.allPackageGlobals.size === 0) return null;
    const parts: string[] = [];
    for (const p of this.allPackageGlobals) {
      try {
        const docUri = pathToFileURL(p).href;
        const doc = this.documents.get(docUri);
        parts.push(doc ? doc.getText() : fs.readFileSync(p, 'utf-8'));
      } catch { /* unreadable — skip */ }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  /**
   * Eagerly scan `dependencies` + `devDependencies` of the workspace
   * `package.json` and pre-register any package-level globals declared
   * via `hinmil.globals`.  This ensures the very first inference of any
   * consumer file already sees those globals, instead of only after a
   * second re-validate triggers re-discovery.
   */
  preloadPackageGlobalsFromWorkspace(workspaceRoot: string): void {
    let manifest: any;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf-8'));
    } catch { return; }
    const deps = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    for (const pkgName of Object.keys(deps)) {
      try {
        const pkgJsonPath = require.resolve(path.posix.join(pkgName, 'package.json'), { paths: [workspaceRoot] });
        const pkgDir = path.dirname(pkgJsonPath);
        for (const globalsPath of findPackageGlobalsPaths(pkgDir, this.logger)) {
          this.allPackageGlobals.add(globalsPath);
        }
      } catch { /* unresolved — skip */ }
    }
  }

  /**
   * Warm the inline-annotation BFS cache for every direct workspace
   * dependency.  Each scan walks up to {@link INLINE_PACKAGE_MAX_FILES}
   * JS files inside a package; doing this synchronously inside
   * {@link createImportResolver} is the dominant factor in cold-hover
   * latency.  Pre-running the scans here moves that cost out of the
   * critical path so the first hover/validation lands on a warm cache.
   *
   * Safe to call from a background task ({@link setImmediate}) — the
   * underlying cache is keyed by `pkgRoot\0effectiveEntry`, so a later
   * resolver invocation that arrives mid-scan simply re-uses or
   * re-populates the same entry idempotently.
   *
   * Called from the server right after {@link setProjectConfig}.
   */
  preloadInlinePackageAnnotationsFromWorkspace(workspaceRoot: string): void {
    let manifest: any;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf-8'));
    } catch { return; }
    const deps = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    const pkgNames = Object.keys(deps);
    for (const pkgName of pkgNames) {
      try {
        const mainEntry = require.resolve(pkgName, { paths: [workspaceRoot] });
        collectInlinePackageAnnotations(mainEntry, this.logger);
      } catch { /* unresolved or no JS entry — skip */ }
    }
  }

  /**
   * Return the set of direct imports of `uri` that participate in a cycle
   * back to `uri`.  Works for both direct (A→B→A) and indirect (A→B→C→A)
   * cycles by doing a DFS from each import to see if it can reach `uri`.
   */
  getCircularImports(uri: string): Set<string> {
    const circular = new Set<string>();
    const imports = this.fileImports.get(uri);
    if (!imports) return circular;

    for (const dep of imports) {
      // DFS from `dep` following fileImports edges; if we reach `uri` it's a cycle
      const visited = new Set<string>();
      const stack = [dep];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === uri) { circular.add(dep); break; }
        if (visited.has(current)) continue;
        visited.add(current);
        const next = this.fileImports.get(current);
        if (next) for (const n of next) stack.push(n);
      }
    }
    return circular;
  }

  // ------- cache management -------

  /** Cache only the exports (used by validateTextDocument for the open file). */
  cacheExports(uri: string, exports: Map<string, Scheme>): void {
    this.fileExports.set(uri, exports);
  }

  /**
   * Cache exports plus the post-inference snapshot of the global
   * method/constraint/dataType registries and the tvar counter, so a
   * later cross-file import of this URI hits the cache in
   * {@link inferFileAndCacheExports} instead of re-running the engine.
   *
   * The snapshots are full registry dumps taken AFTER the open document
   * was inferred — a superset of "what this file added".  Merging a
   * superset back into a different engine is safe because every snapshot
   * entry is keyed by `(typeName, methodName)` / `(typeName, classKey)` /
   * `(typeName)`; identical keys overwrite identically, and extra keys
   * never affect inference of code that does not reference them.
   *
   * Called from {@link validateTextDocument} after every successful
   * `engine.infer` on the open file.
   */
  cacheExportsWithSnapshot(uri: string, exports: Map<string, Scheme>, methodSnapshot?: MethodRegistrySnapshot): void {
    this.fileExports.set(uri, exports);
    this.fileStateSnapshots.set(uri, snapshotGlobalState(methodSnapshot));
    this.touchLru(uri);
    this.evictIfNeeded();
  }

  /** Invalidate all cached data for a single file. */
  invalidateFileCache(uri: string): void {
    this.importTypeAliasCache.clear();
    this.evictEntry(uri);
    this.lruOrder.delete(uri);
  }

  // ------- import inference -------

  /**
   * Infer a file and cache its exports.  If the file is open in the
   * editor, use its current content; otherwise read from disk.
   *
   * Handles the full snapshot → infer → restore → merge cycle for
   * method/constraint registries and the type-variable counter.
   */
  inferFileAndCacheExports(fileUri: string): Map<string, Scheme> | null {
    // --- Circular import detection ---
    if (this.inferring.has(fileUri)) {
      this.perfCircular++;
      this.logger.warn(`[hinmil] Circular import detected: ${fileUri}`);
      // Return whatever partial exports we have cached, or empty
      return this.fileExports.get(fileUri) ?? new Map();
    }

    // --- Import-chain depth guard ---
    // The size of `this.inferring` reflects the current call-stack depth
    // through nested imports.  Bail out before recursion gets out of hand.
    if (this.inferring.size >= ImportInferenceContext.MAX_IMPORT_DEPTH) {
      if (!this.hasWarnedAboutImportDepth) {
        this.hasWarnedAboutImportDepth = true;
        this.logger.warn(
          `[hinmil] Import chain depth exceeded ${ImportInferenceContext.MAX_IMPORT_DEPTH}; ` +
          `further nested imports will be skipped.  Check for accidental fan-out or ` +
          `restructure deeply-nested module graphs.`,
        );
      }
      return this.fileExports.get(fileUri) ?? new Map();
    }

    // Check cache — only use if we have COMPLETE data (exports + registry
    // state snapshot). validateTextDocument may have cached only exports,
    // which would cause method registrations to be silently skipped.
    const cached = this.fileExports.get(fileUri);
    const stateSnap = this.fileStateSnapshots.get(fileUri);
    if (cached && stateSnap) {
      this.perfCacheHits++;
      this.touchLru(fileUri);
      mergeGlobalState(stateSnap);
      return cached;
    }

    // Get source: prefer open document, fall back to disk
    let source: string;
    const doc = this.documents.get(fileUri);
    if (doc) {
      source = doc.getText();
    } else {
      try {
        const filePath = fileURLToPath(fileUri);
        source = fs.readFileSync(filePath, 'utf-8');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`[hinmil] Failed to read import '${fileUri}': ${msg}`);
        return null;
      }
    }

    // Mark as in-progress for circular import detection
    this.inferring.add(fileUri);

    // Snapshot global state before the import's inference.
    //
    // Built-in override policy: a `// Array#every :: ...` declaration in an
    // imported file IS allowed to take effect for the duration of the
    // importer's inference pass — the LSP-level wrapper around engine.infer
    // (`safeEngineInfer` in server.ts) and the workspace scan wrapper in
    // `getWorkspaceExports` already snapshot+restore built-in original
    // entries at the request boundary, so the override stays scoped to the
    // request that explicitly required the file.
    const saved = snapshotGlobalState();

    try {
      // Run a separate engine so the caller's in-progress state is not corrupted
      const importEngine = new InferenceEngine();
      this.perfCacheMisses++;
      this.perfInferCalls++;
      // Forward project globals so imported files see the same globals
      // (e.g. query-builder sidecar tables, project-wide aliases, AND project-wide
      // `::constraint` definitions) as the entry file.  This MUST mirror the
      // composition the server builds for the main engine
      // (`globalsSource + ::types-addendum + package-addendum`): the
      // user-authored `globalsSource` carries `::constraint Foldable …`
      // declarations, and `infer()` calls `clearConstraints()` then
      // re-registers ONLY from `globalsSource`.  Forwarding just the sidecar
      // addendum (the old behavior) dropped those constraints, so a `::rep`
      // whose constraint lives in the project globals failed to bind during
      // any cache-cold cross-file inference (e.g. the re-inference a save
      // forces after invalidating the export cache), silently stripping the
      // rep from the imported scheme.
      const addendum = this.getProjectGlobalsAddendum();
      const pkgAddendum = this.getAllPackageGlobalsAddendum();
      let importGlobals = this.globalsSource ?? null;
      if (addendum) importGlobals = importGlobals ? `${importGlobals}\n${addendum}` : addendum;
      if (pkgAddendum) importGlobals = importGlobals ? `${importGlobals}\n${pkgAddendum}` : pkgAddendum;
      if (importGlobals) importEngine.globalsSource = importGlobals;
      const resolver = this.createImportResolver(fileUri);
      const typeResolver = this.createTypeDirectiveResolver(fileUri);
      const aliasResolver = this.createImportTypeAliasResolver(fileUri);
      const result = importEngine.infer(source, undefined, resolver, typeResolver, aliasResolver);

      // Counter reconciliation: never go backwards
      bumpTypeVarCounterTo(saved.tvarCounter);

      // Capture → restore → merge registries.  `mergeMethodRegistry` carries
      // any builtin override verbatim from the import snapshot into the host
      // registry (see the builtin-override policy note above).
      const imported = snapshotGlobalState();
      restoreGlobalRegistries(saved);
      mergeGlobalState(imported);

      // Persist in cache and update LRU
      this.fileExports.set(fileUri, result.exports);
      this.fileStateSnapshots.set(fileUri, imported);
      this.touchLru(fileUri);
      this.evictIfNeeded();
      return result.exports;
    } finally {
      this.inferring.delete(fileUri);
    }
  }

  // ------- resolver factories -------

  /**
   * Central stamp-validated accessor for {@link sidecarArtifacts}.  Returns
   * the cached entry when the stamp still matches (open-doc version or disk
   * mtime:size); otherwise reads the source and starts a fresh entry.
   * Returns `null` when the file is neither open nor readable.
   */
  private getSidecarArtifacts(filePath: string): SidecarArtifacts | null {
    const docUri = pathToFileURL(filePath).href;
    const doc = this.documents.get(docUri);
    let stamp: string;
    let readSource: () => string;
    if (doc) {
      stamp = `doc:${doc.version}`;
      readSource = () => doc.getText();
    } else {
      let st: fs.Stats;
      try {
        st = fs.statSync(filePath);
      } catch {
        this.sidecarArtifacts.delete(filePath);
        return null;
      }
      stamp = `disk:${st.mtimeMs}:${st.size}`;
      readSource = () => fs.readFileSync(filePath, 'utf-8');
    }
    const cached = this.sidecarArtifacts.get(filePath);
    if (cached && cached.stamp === stamp) return cached;
    let source: string;
    try {
      source = readSource();
    } catch {
      this.sidecarArtifacts.delete(filePath);
      return null;
    }
    const fresh: SidecarArtifacts = { stamp, source };
    this.sidecarArtifacts.set(filePath, fresh);
    return fresh;
  }

  /**
   * Load a `.hm` annotation file, preferring an open editor document over
   * the on-disk version so unsaved sidecar edits are reflected immediately.
   */
  private loadHmFileLive(filePath: string): Map<string, Scheme> | null {
    const art = this.getSidecarArtifacts(filePath);
    if (!art) return null;
    if (art.exports === undefined) {
      art.exports = timeSidecarStage('parse', () => parseHmSource(art.source));
    }
    return art.exports;
  }

  /** Sidecar variant: resolve `entryPath` → all `hinmil.sidecars` paths and load live, merging in declared order (later overrides earlier). */
  private loadHmSidecarLive(entryPath: string): Map<string, Scheme> | null {
    const paths = findHmSidecarPaths(entryPath);
    if (paths.length === 0) return null;
    const merged = new Map<string, Scheme>();
    let any = false;
    for (const p of paths) {
      const m = this.loadHmFileLive(p);
      if (!m) continue;
      any = true;
      for (const [k, v] of m) merged.set(k, v);
    }
    return any ? merged : null;
  }

  /**
   * Shared body of {@link registerSidecarMethods} and
   * {@link registerInlinePackageMethods}.  Registers `Type#method` /
   * `Type.method` annotations into the global method registry, plus
   * any `::constraint` / `data ...` directives found in the source.
   *
   * @param source       Raw source text.
   * @param sourceUri    `file://` URI used as the origin for constraint
   *                     directive locations.
   * @param wrapAliases  When `true`, alias parsing runs against the
   *                     wrapped (`// `-prefixed) `.hm` form.  When
   *                     `false`, the source is already JS (annotations
   *                     live inside real `// ` comments) and is parsed
   *                     as-is.
   */
  private registerAnnotationsFromSource(source: string, sourceUri: string, wrapAliases: boolean): void {
    const prepared = timeSidecarStage('register', () => this.prepareRegistration(source, wrapAliases));
    this.applyRegistration(prepared, sourceUri);
  }

  /**
   * Parsing half of {@link registerAnnotationsFromSource}: extract method /
   * constraint / data declarations and pre-expand sidecar-local aliases.
   * Pure with respect to global state — the result can be cached per
   * sidecar (see {@link registerSidecarMethods}) and re-applied cheaply.
   */
  private prepareRegistration(source: string, wrapAliases: boolean): PreparedRegistration {
    const { buildAnnotationMap, extractConstraintDirectives, extractDataDirectives } = require('../commentParser') as typeof import('../commentParser');
    const { expandAliases, buildDeclaredTypeParamMap } = require('../infer/annotations') as typeof import('../infer/annotations');
    const { wrapHmSource } = require('./files') as typeof import('./files');
    const { parseConstraintDirective } = require('../registries/constraintRegistry') as typeof import('../registries/constraintRegistry');
    const wrapped = wrapAliases ? wrapHmSource(source) : source;
    const annotations = buildAnnotationMap(wrapped);

    const constraintDefs: PreparedRegistration['constraintDefs'] = [];
    for (const directive of extractConstraintDirectives(wrapped)) {
      const def = parseConstraintDirective(directive.text);
      if (def) {
        def.commentStart = directive.start;
        def.commentEnd = directive.end;
        constraintDefs.push(def);
      }
    }

    const dataDecls = extractDataDirectives(wrapped);

    const { aliases: sidecarAliases, aliasVars: sidecarAliasVars } =
      parseHmTypeAliases(source, { wrap: wrapAliases });

    const declaredTypeParams = buildDeclaredTypeParamMap(annotations);
    const methodAnns: PreparedRegistration['methodAnns'] = [];
    for (const [name, ann] of annotations) {
      if (name.includes('#') || name.includes('.')) {
        if (sidecarAliases.size > 0 && ann.scheme) {
          ann.scheme = {
            ...ann.scheme,
            type: expandAliases(sidecarAliases, ann.scheme.type, undefined, sidecarAliasVars),
          };
          if (ann.receiver) {
            ann.receiver = expandAliases(sidecarAliases, ann.receiver, undefined, sidecarAliasVars);
          }
          if (ann.methodType) {
            ann.methodType = expandAliases(sidecarAliases, ann.methodType, undefined, sidecarAliasVars);
          }
        }
        const typeName = name.includes('#') ? name.split('#')[0] : undefined;
        methodAnns.push({ name, ann, typeParams: typeName ? declaredTypeParams.get(typeName) : undefined });
      }
    }
    return { constraintDefs, dataDecls, methodAnns };
  }

  /**
   * Registration half of {@link registerAnnotationsFromSource}: write a
   * prepared payload into the global registries.  Cheap (no parsing) —
   * safe to re-run on every inference pass.
   */
  private applyRegistration(prepared: PreparedRegistration, sourceUri: string): void {
    const { registerAnnotationMethod } = require('../infer/annotations') as typeof import('../infer/annotations');
    const { registerConstraint } = require('../registries/constraintRegistry') as typeof import('../registries/constraintRegistry');
    const { registerDataType } = require('../registries/dataTypeRegistry') as typeof import('../registries/dataTypeRegistry');
    for (const def of prepared.constraintDefs) {
      def.uri = sourceUri;
      registerConstraint(def);
    }
    for (const decl of prepared.dataDecls) {
      registerDataType(decl);
    }
    for (const { name, ann, typeParams } of prepared.methodAnns) {
      registerAnnotationMethod(name, ann, typeParams);
    }
  }

  /**
   * Extract `Type#method` / `Type.method` annotations from the given `.hm`
   * sidecar and register them in the global method registry, so that
   * property access on the sidecar's types resolves them.  Used for both
   * per-file and package-level sidecars.  Idempotent (re-registration is
   * harmless — same factory wins).
   */
  private registerSidecarMethods(sidecarPath: string): void {
    const art = this.getSidecarArtifacts(sidecarPath);
    if (!art) return;
    if (art.registration === undefined) {
      art.registration = timeSidecarStage('register', () =>
        this.prepareRegistration(art.source, /* wrapAliases */ true));
    }
    this.applyRegistration(art.registration, pathToFileURL(sidecarPath).href);
  }

  /**
   * Register `Type#method` / `Type.method` annotations and constraint /
   * data directives discovered inline in a package's JS source files.
   * Mirrors {@link registerSidecarMethods} but skips the `wrapHmSource`
   * step — the methodSource is already JavaScript with comment-embedded
   * annotations.
   */
  private registerInlinePackageMethods(scan: InlinePackageScan, targetUri: string): void {
    if (!scan.methodSource) return;
    this.registerAnnotationsFromSource(scan.methodSource, targetUri, /* wrapAliases */ false);
  }

  /**
   * Read a `.hm` source as a map of raw signature texts (preferring an open
   * editor doc), used by hover/completion to surface the user's verbatim
   * annotation rather than a re-printed scheme.
   */
  private readHmRawMap(filePath: string): Map<string, string> | null {
    const art = this.getSidecarArtifacts(filePath);
    if (!art) return null;
    if (art.rawMap === undefined) art.rawMap = parseHmSourceRaw(art.source);
    return art.rawMap;
  }

  /**
   * Read a JS source file's leading-comment annotations as a map of
   * `name → raw signature text`.  Used by {@link getImportedRawSignature}
   * to surface a user's verbatim `// name :: ...` comment when hovering
   * an imported binding whose providing module is a JS file (no `.hm`
   * sidecar present).  Prefers an open editor doc; falls back to disk.
   */
  private readJsRawAnnotationMap(filePath: string): Map<string, string> | null {
    let source: string;
    try {
      const docUri = pathToFileURL(filePath).href;
      const doc = this.documents.get(docUri);
      source = doc ? doc.getText() : fs.readFileSync(filePath, 'utf-8');
    } catch { return null; }
    const out = new Map<string, string>();
    for (const ann of extractAnnotations(source)) {
      if (!ann.name || !ann.raw) continue;
      const prev = out.get(ann.name);
      // Preserve overloads: when the same name has multiple `name :: ...`
      // comment annotations, join them with `\n${name} :: ` so hover renders
      // every overload (mirrors `parseHmSourceRaw` for `.hm` files).
      out.set(ann.name, prev ? `${prev}\n${ann.name} :: ${ann.raw}` : ann.raw);
    }
    return out;
  }

  /**
   * Look up the verbatim raw signature text (as written in a `.hm` file)
   * for `exportName` imported via `specifier` from `fromUri`.  Mirrors the
   * lookup chain in `createImportResolver` but only consults `.hm`
   * sources — never inferred JS — because only `.hm` files have a raw
   * user-written signature to preserve.
   */
  getImportedRawSignature(specifier: string, exportName: string, fromUri: string): string | null {
    // Bundled builtin typings — weakest layer, consulted when nothing
    // user-side or package-side yielded a raw signature.
    const builtinRaw = (): string | null => {
      const bp = isBareSpecifier(specifier) ? builtinHmPath(getBarePackageName(specifier)) : null;
      if (!bp) return null;
      return this.readHmRawMap(bp)?.get(exportName) ?? null;
    };
    // Project overrides + conventional `<typesDir>/` stubs (subpath-aware)
    if (this.projectRoot && isBareSpecifier(specifier)) {
      const pkgName = getBarePackageName(specifier);
      const overrideRel = this.packageOverrides[pkgName];
      if (overrideRel) {
        const overridePath = path.resolve(this.projectRoot, overrideRel);
        const raws = this.readHmRawMap(overridePath);
        const raw = raws?.get(exportName);
        if (raw) return raw;
      }
      for (const rel of conventionalStubRelPaths(specifier)) {
        const conventional = path.join(this.projectRoot, this.typesDir, rel);
        try {
          if (isFile(conventional)) {
            const raws = this.readHmRawMap(conventional);
            const raw = raws?.get(exportName);
            if (raw) return raw;
          }
        } catch { /* not present */ }
      }
    }

    const targetUri = resolveImportSpecifier(specifier, fromUri);
    if (!targetUri) return builtinRaw();
    const targetPath = fileURLToPath(targetUri);

    if (isUnderNodeModules(targetPath)) {
      // Package's own `hinmil.sidecars` sidecars (later entries override earlier).
      // Walk in reverse so the last-declared sidecar's raw text wins.
      const sidecarPaths = findHmSidecarPaths(targetPath);
      for (let i = sidecarPaths.length - 1; i >= 0; i--) {
        const raws = this.readHmRawMap(sidecarPaths[i]);
        const raw = raws?.get(exportName);
        if (raw) return raw;
      }
      // `@hm/<pkg>` companion sidecar
      if (isBareSpecifier(specifier)) {
        const companionSpec = hmCompanionPackageName(getBarePackageName(specifier));
        const companionUri = resolveImportSpecifier(companionSpec, fromUri);
        if (companionUri) {
          const companionPath = fileURLToPath(companionUri);
          const companionSidecars = findHmSidecarPaths(companionPath);
          for (let i = companionSidecars.length - 1; i >= 0; i--) {
            const raws = this.readHmRawMap(companionSidecars[i]);
            const raw = raws?.get(exportName);
            if (raw) return raw;
          }
        }
      }
      // Inline annotations (last fallback — sidecars win on conflict).
      const inlineScan = collectInlinePackageAnnotations(targetPath, this.logger);
      const inlineRaw = inlineScan?.inlineRawSignatures.get(exportName);
      if (inlineRaw) return inlineRaw;
    }
    // Project-local JS source: fall back to a leading `// name :: ...`
    // comment annotation in the providing module.  This lets hover show
    // the user's verbatim signature for an imported binding even when
    // the target is a regular .js file (no .hm sidecar).
    if (!isUnderNodeModules(targetPath) && /\.(?:m|c)?jsx?$/i.test(targetPath)) {
      const jsRaws = this.readJsRawAnnotationMap(targetPath);
      const jsRaw = jsRaws?.get(exportName);
      if (jsRaw) return jsRaw;
    }
    return builtinRaw();
  }

  /**
   * Find every `.hm` source reachable from `fromUri` that declares a
   * type/constructor named `name`, returning the raw signature(s) and an
   * `origin` label.  Used by hover to surface a definition for an
   * uppercase name appearing inside an annotation when the user has not
   * imported it locally (e.g. `Prop` from a project-globals or sidecar
   * file).  Multiple entries indicate ambiguity; the consumer can
   * disambiguate via a `// ::prefer Name from <specifier>` directive.
   *
   * Sources searched (in order):
   *   1. Project globals file (e.g. `globals.hm`).
   *   2. Sidecars referenced by `// ::types` directives in the project
   *      globals file (e.g. `// ::types query-builder` makes a query builder's sidecar
   *      declarations globally visible).
   *   3. For every `import` in `source`:
   *      a. Project override `<override>.hm` for the package.
   *      b. Conventional `<typesDir>/<pkg>.hm` stub.
   *      c. The package's own `hinmil.sidecars` sidecars.
   *      d. A per-file `<targetPath>.hm` sidecar.
   *   4. Last-resort project-wide scan: any `.js`/`.hm` file under the
   *      project root that declares the name as a top-level annotation.
   *      This catches types like `RTask` that live in a sibling source
   *      file but are not transitively imported from `fromUri`.
   */
  findTypeDefinitions(
    name: string,
    fromUri: string,
    source: string,
    globalsSource: string | null,
    globalsPath: string | null,
  ): Array<{ raw: string; origin: string; sourcePath: string | null; commentStart: number; commentEnd: number }> {
    const results: Array<{ raw: string; origin: string; sourcePath: string | null; commentStart: number; commentEnd: number }> = [];
    const seenRaw = new Set<string>();
    // Lazy require to avoid load-time cycles.
    const { extractAnnotations } = require('../commentParser') as typeof import('../commentParser');
    const { extractImportSpecifiers } = require('./files') as typeof import('./files');
    const { wrapHmSource } = require('./files') as typeof import('./files');

    const addFromText = (text: string, origin: string, sourcePath: string | null, isHm: boolean): void => {
      // For .hm files we wrap the source so the JS comment-parser can read
      // it; the wrapper prepends `// ` to every non-comment line.  Because
      // each non-comment line gains 3 characters, a uniform offset shift
      // (wrapped.length - text.length) cannot be used to translate offsets
      // back to the original file — the cumulative shift differs per line.
      // Instead, locate the declaration directly in the original `text` by
      // scanning for the matching `<name> ::` line.
      const wrapped = isHm ? wrapHmSource(text) : text;
      let raw: string | null = null;
      for (const ann of extractAnnotations(wrapped)) {
        if (ann.name === name && ann.raw && !ann.receiver) {
          raw = ann.raw;
          break;
        }
      }
      if (!raw) return;
      // Dedup on raw signature alone: two sidecar files containing the
      // bitwise-identical declaration represent the same definition (the
      // common case is an auto-generated mirror of a hand-written stub).
      if (seenRaw.has(raw)) return;
      seenRaw.add(raw);

      // Locate `<name> ::` in the original source by scanning lines.  This
      // gives an accurate range that points at the user's declaration line
      // (not at a preceding comment block, which is what extractAnnotations
      // returns when consecutive line-comments are grouped together).
      let commentStart = 0;
      let commentEnd = text.length;
      const declRe = new RegExp(
        '^[\\s/*]*' + name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\s*::',
      );
      let cursor = 0;
      for (const line of text.split('\n')) {
        if (declRe.test(line)) {
          commentStart = cursor;
          commentEnd = cursor + line.length;
          break;
        }
        cursor += line.length + 1;
      }
      results.push({ raw, origin, sourcePath, commentStart, commentEnd });
    };

    const readFileText = (filePath: string): string | null => {
      const docUri = pathToFileURL(filePath).href;
      const doc = this.documents.get(docUri);
      if (doc) return doc.getText();
      try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
    };

    // 1. Project globals
    if (globalsSource) {
      addFromText(globalsSource, '<globals>', globalsPath, true);
    }

    // 2. Sidecars referenced by `// ::types <specifier>` directives in
    //    the project globals file.  These declarations are visible to
    //    every file via `engine.globalsSource`, so go-to-definition
    //    should surface them just like the per-file directive case.
    for (const sidecarPath of this.collectGlobalDirectiveSidecarPaths()) {
      const text = readFileText(sidecarPath);
      if (text) addFromText(text, '<globals ::types>', sidecarPath, true);
    }

    // 3. Per-import sidecars + per-type-directive sidecars.
    //    `// ::types <pkg>` directives are treated the same way as bare
    //    imports here: project override (if any) + conventional
    //    `<typesDir>/<pkg>.hm` + the package's own `hinmil.sidecars` sidecars
    //    are all searched, so go-to-definition surfaces both the base
    //    sidecar declaration and any project override.
    const { extractTypeDirectives } = require('../commentParser') as typeof import('../commentParser');
    // When `fromUri` is itself a `.hm` sidecar, the source has bare
    // directive lines (no leading `// `) — wrap it so the comment-based
    // directive/import extractors pick them up.  JS sources are used
    // as-is.
    const fromIsHm = fromUri.endsWith('.hm');
    const sourceForExtraction = fromIsHm ? wrapHmSource(source) : source;
    const allSpecifiers: string[] = [
      ...extractImportSpecifiers(sourceForExtraction).values(),
      ...extractTypeDirectives(sourceForExtraction),
    ];
    // When `fromUri` itself IS a project override or conventional
    // `<typesDir>/<pkg>.hm` stub, that file has no `import`/`::types`
    // statements of its own — yet we still want references to peer
    // declarations in the *underlying* package sidecar (`Limit`,
    // `Offset`, `Selector`, …) to resolve.  Synthesise the package
    // specifier from the file path so the loop below loads the same
    // sidecars an importing JS file would see.
    const implicit = this.implicitSpecifierFromOverrideUri(fromUri);
    if (implicit) allSpecifiers.push(implicit);
    const seenSpecifiers = new Set<string>();
    for (const specifier of allSpecifiers) {
      if (seenSpecifiers.has(specifier)) continue;
      seenSpecifiers.add(specifier);

      // 3a/3b. Overrides for bare package specifiers
      if (this.projectRoot && isBareSpecifier(specifier)) {
        const pkgName = getBarePackageName(specifier);
        const overrideRel = this.packageOverrides[pkgName];
        if (overrideRel) {
          const overridePath = path.resolve(this.projectRoot, overrideRel);
          const t = readFileText(overridePath);
          if (t) addFromText(t, `${pkgName} (override)`, overridePath, true);
        }
        const conventional = this.conventionalStubPath(specifier);
        const tConv = conventional ? readFileText(conventional) : null;
        if (conventional && tConv) addFromText(tConv, `${pkgName} (${this.typesDir})`, conventional, true);
      }
      // Bundled builtin typings — weakest layer (dedup on raw signature
      // keeps user-side duplicates first).
      if (isBareSpecifier(specifier)) {
        const pkgName = getBarePackageName(specifier);
        const builtinPath = builtinHmPath(pkgName);
        if (builtinPath) {
          const t = readFileText(builtinPath);
          if (t) addFromText(t, `${pkgName} (builtin)`, builtinPath, true);
        }
      }

      // 3c. Package sidecar(s) under node_modules + 3d. per-file sidecar
      const targetUri = resolveImportSpecifier(specifier, fromUri);
      if (!targetUri) continue;
      const targetPath = fileURLToPath(targetUri);
      for (const sp of findHmSidecarPaths(targetPath)) {
        const t = readFileText(sp);
        if (t) addFromText(t, specifier, sp, true);
      }
      const perFile = targetPath + '.hm';
      const tPerFile = readFileText(perFile);
      if (tPerFile) addFromText(tPerFile, specifier, perFile, true);
    }

    // NOTE: cross-file type definitions are only surfaced when they are
    // reachable via an explicit `import` / `require`, a `// ::types`
    // directive, the project globals file, or per-import sidecars (steps
    // 1–3 above). A project-wide scan that resolved ANY matching `Name ::`
    // declaration anywhere in the workspace was removed on purpose: it made
    // types globally available without import and produced ambiguous results
    // when several modules declared the same name (e.g. multiple `Pair`s).

    // 4. Own-package inline annotations (library-author mode) — restricted
    //    to `.hm` sidecar files. A `.hm` sidecar that lives inside its own
    //    package may reference inline `// Name :: …` annotations declared in
    //    sibling JS files (the sidecar IS the package's opt-in type surface).
    //    Regular JS sources do NOT get this fallback: they must `import`
    //    a type to resolve it, so unimported names stay unresolved.
    if (results.length === 0 && fromUri.endsWith('.hm')) {
      try {
        const fromPath = fileURLToPath(fromUri);
        const pkgInfo = findPackageJson(fromPath);
        // Skip when the file is under node_modules — that's consumer view,
        // already covered by per-import sidecar/inline resolution above.
        if (pkgInfo && !/[\\/]node_modules[\\/]/.test(pkgInfo.pkgDir)) {
          const scan = collectInlinePackageAnnotations(fromPath, this.logger);
          const raw = scan?.inlineRawSignatures.get(name);
          if (scan && raw) {
            // Origin file is recorded during the BFS scan, so we can jump
            // straight to it instead of re-scanning every visited file.
            const sourcePath = scan.nameToSource.get(name) ?? null;
            const origin = sourcePath
              ? path.relative(pkgInfo.pkgDir, sourcePath)
              : '<own-package inline>';
            const text = sourcePath ? readFileText(sourcePath) : null;
            if (text) addFromText(text, origin, sourcePath, false);
          }
        }
      } catch { /* fromUri not a file URI or pkg lookup failed — ignore */ }
    }

    // 5. A built-in type of hinmil itself (`ReactElement`, the type of every
    //    JSX expression) has no `Name ::` declaration anywhere; a bundled
    //    stub documents it with an anchor line `// ::builtin Name`.  Found
    //    without an import (JSX needs no `import React`).
    if (results.length === 0) {
      const anchor = findBuiltinTypeAnchor(name);
      if (anchor) results.push({ raw: name, origin: '<builtin>', ...anchor });
    }

    return results;
  }

  /** Create an ImportResolver for a given file URI. */
  createImportResolver(fromUri: string): ImportResolver {
    return (specifier: string): Map<string, Scheme> | UntypedModule | null => {
      // ── Step 1: project-level `.hm` overrides + conventional hm-types/ ──
      // These let a user provide types for an npm package without modifying
      // the package itself, mirroring `@types/*` packages from TypeScript.
      // Names declared in the override take precedence; names absent from
      // the override fall back to the package's own `.hm` sidecar (if any),
      // and only if neither has them does a diagnostic surface.
      // The path to the project-level override sidecar (if any) — we
      // register its methods AFTER the package's own sidecar methods so
      // that override entries win for `Type#method` / `Type.method`
      // annotations.  Method registration is last-write-wins, so the
      // package's `Table#update :: Table p ~> [a] -> QueryTag b` would
      // otherwise overwrite an override's `Table#update :: Table ~> [Selector] -> QueryTag b`.
      let overrideExports: Map<string, Scheme> | null = null;
      let overrideSidecarPath: string | null = null;
      // Bundled builtin typings (react, react-dom, …) — the WEAKEST layer.
      // Loaded and method-registered FIRST so every user-side layer that
      // follows (override / hm-types / package sidecars) wins on collision.
      let builtinExports: Map<string, Scheme> | null = null;
      if (isBareSpecifier(specifier)) {
        const builtinPath = builtinHmPath(getBarePackageName(specifier));
        if (builtinPath) {
          builtinExports = this.loadHmFileLive(builtinPath);
          if (builtinExports) {
            this.registerSidecarMethods(builtinPath);
            this.trackDependency(fromUri, pathToFileURL(builtinPath).href);
          }
        }
      }
      const finish = (m: Map<string, Scheme>): Map<string, Scheme> =>
        builtinExports ? markOpenWorldExports(m) : m;
      if (this.projectRoot && isBareSpecifier(specifier)) {
        const pkgName = getBarePackageName(specifier);

        const overrideRel = this.packageOverrides[pkgName];
        if (overrideRel) {
          const overridePath = path.resolve(this.projectRoot, overrideRel);
          const exports = this.loadHmFileLive(overridePath);
          if (exports) {
            this.registerSidecarMethods(overridePath);
            overrideExports = exports;
            overrideSidecarPath = overridePath;
            // Track the override sidecar as a dependency of the consumer
            // so that editing it triggers selective revalidation of just
            // the importers (instead of falling back to all open docs).
            this.trackDependency(fromUri, pathToFileURL(overridePath).href);
          } else {
            this.logger.warn(`[hinmil] hm override for '${pkgName}' not found at '${overridePath}'`);
          }
        }

        if (!overrideExports) {
          const conventional = this.conventionalStubPath(specifier);
          if (conventional) {
            const exports = this.loadHmFileLive(conventional);
            if (exports) {
              this.registerSidecarMethods(conventional);
              overrideExports = exports;
              overrideSidecarPath = conventional;
              // Same as above — conventional `hm-types/` stubs (package-level
              // or subpath) must register a reverse-dep so the dep-graph is
              // not empty when the sidecar changes.
              this.trackDependency(fromUri, pathToFileURL(conventional).href);
            }
          }
        }
      }

      // Fold the builtin layer underneath the USER layer only (user wins
      // per export name).  `userPlusBuiltin` serves the paths where no
      // package-own sidecar participates; the node_modules paths below
      // fold builtin under the package sidecar instead, preserving the
      // full precedence chain: user > package sidecar > builtin.
      const userPlusBuiltin = builtinExports
        ? mergeOverride(overrideExports, builtinExports)
        : overrideExports;

      // Bundler-managed asset (`./hero.png`, `./App.css`): bind imported
      // names to `Any` instead of "Cannot resolve module" + unbound vars.
      // Checked before path resolution — the '' entry in jsExtensions
      // would otherwise resolve the asset as an exact file and route it
      // into (silently failing) module inference.
      if (isAssetImportSpecifier(specifier, fromUri)) return UNTYPED_MODULE;

      const targetUri = resolveImportSpecifier(specifier, fromUri);
      if (!targetUri) {
        // Only the override/builtin layer is available — return it as-is.
        // Names absent from a plain override produce a "not exported"
        // diagnostic; with a builtin layer the map is open-world and
        // unknown names bind to `Any` instead.
        return userPlusBuiltin ? finish(userPlusBuiltin) : null;
      }

      // For npm packages (anything resolved into node_modules) we do NOT
      // run inference on the compiled source — the signal-to-noise is too
      // poor (TypeScript-emitted CJS, no generics, internal diagnostics).
      // Lookup chain:
      //   2. Package's own `hinmil.sidecars` field in package.json
      //   3. `@hm/<derived>` companion package (à la `@types/*`)
      //   4. UNTYPED_MODULE — bind names to fresh type variables
      const targetPath = fileURLToPath(targetUri);
      if (isUnderNodeModules(targetPath)) {
        // Inline-annotated package WITHOUT `.hm` sidecars (e.g. a curried FP library, whose
        // build keeps every `// name :: Type` comment): the author opted
        // into hinmil in the JS itself, so infer the target module exactly
        // like local source.  That resolves the real CommonJS export shape
        // per module — `module.exports = _RTask` (default + dotted statics),
        // re-export barrels `module.exports = { RTask: require ("./RTask") }`
        // — for every import form (default, named, subpath with or without
        // `/index` / `.js`, require), instead of the name-based inline scan
        // which cannot see export structure.  Packages that ship sidecars
        // keep the sidecar path below (sidecars are authoritative there).
        if (findHmSidecarPaths(targetPath).length === 0
            && isInlineAnnotatedPackageModule(targetPath)) {
          this.recordPackageGlobals(fromUri, targetPath);
          this.trackDependency(fromUri, targetUri);
          const inferred = this.inferFileAndCacheExports(targetUri);
          if (inferred) {
            if (overrideSidecarPath) this.registerSidecarMethods(overrideSidecarPath);
            return finish(mergeOverride(overrideExports, mergeMaps(builtinExports, inferred)));
          }
        }

        // Inline annotations live directly in the JS source — collect
        // them BEFORE sidecars so sidecar entries win on name collision
        // (`inline < sidecar < companion < override`).  Register inline
        // methods FIRST so that any same-named `Type#method` declared in
        // a sidecar overrides the inline registration.
        const inlineScan = collectInlinePackageAnnotations(targetPath, this.logger);
        if (inlineScan) {
          this.registerInlinePackageMethods(inlineScan, targetUri);
          for (const f of inlineScan.visitedFiles) {
            this.trackDependency(fromUri, pathToFileURL(f).href);
          }
        }

        // Track package-level globals so the consumer's engine can pull
        // them into its globals env.
        this.recordPackageGlobals(fromUri, targetPath);

        const sidecarExports = this.loadHmSidecarLive(targetPath);
        if (sidecarExports || inlineScan) {
          if (sidecarExports) {
            for (const sp of findHmSidecarPaths(targetPath)) {
              this.registerSidecarMethods(sp);
              this.trackDependency(fromUri, pathToFileURL(sp).href);
            }
          }
          // Re-register override methods last so they win over the
          // package's same-named `Type#method` annotations.
          if (overrideSidecarPath) this.registerSidecarMethods(overrideSidecarPath);
          this.trackDependency(fromUri, targetUri);
          // builtin < inline < sidecar < user override.
          const merged = mergeMaps(builtinExports, mergeMaps(inlineScan?.exports ?? null, sidecarExports));
          return finish(supplementWithRuntimeExports(
            mergeOverride(overrideExports, merged),
            targetPath,
            this.logger,
          ));
        }

        if (isBareSpecifier(specifier)) {
          const companionSpec = hmCompanionPackageName(getBarePackageName(specifier));
          const companionUri = resolveImportSpecifier(companionSpec, fromUri);
          if (companionUri) {
            const companionPath = fileURLToPath(companionUri);
            const companionSidecar = this.loadHmSidecarLive(companionPath);
            if (companionSidecar) {
              for (const sp of findHmSidecarPaths(companionPath)) {
                this.registerSidecarMethods(sp);
                this.trackDependency(fromUri, pathToFileURL(sp).href);
              }
              if (overrideSidecarPath) this.registerSidecarMethods(overrideSidecarPath);
              this.trackDependency(fromUri, companionUri);
              return finish(supplementWithRuntimeExports(
                mergeOverride(overrideExports, mergeMaps(builtinExports, companionSidecar)),
                targetPath,
                this.logger,
              ));
            }
          }
        }

        // No package-level sidecar at all. If the user supplied an
        // override, supplement it with `Any`-typed entries for every
        // runtime-exported name that the override does not cover.  `Any`
        // is opaque under unification, so missing names remain usable
        // without producing a hallucinated signature from usage — and
        // names truly absent from the JS module still surface a
        // "not exported" diagnostic.  With no override at all, fall back
        // to UNTYPED_MODULE which binds whole-module imports to `Any`.
        if (userPlusBuiltin) {
          return finish(supplementWithRuntimeExports(userPlusBuiltin, targetPath, this.logger));
        }
        return UNTYPED_MODULE;
      }

      this.trackDependency(fromUri, targetUri);
      const inferred = this.inferFileAndCacheExports(targetUri);

      // Per-file `.hm` sidecar:  if `<targetPath>.hm` exists next to the
      // imported source file, merge its declarations on top of inferred
      // exports.  Sidecar names override inferred ones (e.g. an
      // auto-generated `tables :: { ... }` shadows a fresh-tvar inference).
      // Method/static annotations (`Type#m`, `Type.m`) inside the sidecar
      // are also registered into the global method registry so that
      // property access on the per-file sidecar's types resolves them.
      const perFileSidecar = targetPath + '.hm';
      try {
        if (isFile(perFileSidecar)) {
          const sidecarExports = this.loadHmFileLive(perFileSidecar);
          this.registerSidecarMethods(perFileSidecar);
          if (sidecarExports && sidecarExports.size > 0) {
            const merged = new Map(inferred ?? new Map());
            for (const [name, scheme] of sidecarExports) merged.set(name, scheme);
            this.trackDependency(fromUri, pathToFileURL(perFileSidecar).href);
            return merged;
          }
        }
      } catch { /* no per-file sidecar */ }

      return inferred;
    };
  }

  /**
   * Create a TypeDirectiveResolver for a given file URI.
   * Reads the target file's source code so the inference engine can
   * extract and register method annotations from it.
   *
   * For bare package specifiers (e.g. `// ::types query-builder`) this loads
   * EVERY `.hm` sidecar declared in the package's `package.json#hinmil.sidecars`
   * (which may be an array), then merges the project-level
   * `hinmil.overrides.<pkg>` file on top so user overrides win on name
   * collision.  All sources are wrapped and concatenated into a single
   * string the inference engine can consume.
   */
  createTypeDirectiveResolver(fromUri: string): TypeDirectiveResolver {
    return (specifier: string): string | null => {
      const { wrapHmSource } = require('./files') as typeof import('./files');

      const readFile = (filePath: string): string | null => {
        const fileUri = pathToFileURL(filePath).href;
        this.trackDependency(fromUri, fileUri);
        const doc = this.documents.get(fileUri);
        if (doc) return doc.getText();
        try {
          return fs.readFileSync(filePath, 'utf-8');
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.warn(`[hinmil] Failed to read type directive '${filePath}': ${msg}`);
          return null;
        }
      };

      // Bare package specifier — collect all sidecars + project override.
      // Order: package's own `hinmil.sidecars` (in declared order) first, then the
      // override last so its declarations win on name collision via the
      // overload-merge logic in `buildAnnotationMap`.
      if (isBareSpecifier(specifier)) {
        const sidecarPaths: string[] = [];
        // Bundled builtin typings first — weakest layer, so every later
        // entry (package sidecars, project override) wins on collision
        // via the overload-merge logic in `buildAnnotationMap`.
        const builtinPath = builtinHmPath(getBarePackageName(specifier));
        if (builtinPath) sidecarPaths.push(builtinPath);
        const entryPath = resolveTypeDirectiveSpecifier(specifier, fromUri);
        if (entryPath) {
          for (const p of findHmSidecarPaths(entryPath)) sidecarPaths.push(p);
        }

        let overridePath: string | null = null;
        if (this.projectRoot) {
          const pkgName = getBarePackageName(specifier);
          const overrideRel = this.packageOverrides[pkgName];
          if (overrideRel) {
            const candidate = path.resolve(this.projectRoot, overrideRel);
            try {
              if (isFile(candidate)) overridePath = candidate;
            } catch { /* missing override file */ }
          }
        }
        if (overridePath) sidecarPaths.push(overridePath);

        if (sidecarPaths.length === 0) {
          // No `.hm` sources for this package — fall through to the
          // legacy single-file path below (which may resolve a JS entry
          // and produce no annotations, but keeps backwards-compat).
        } else {
          const parts: string[] = [];
          for (const p of sidecarPaths) {
            const part = timeSidecarStage('directive', (): string | null => {
              if (!p.endsWith('.hm')) return readFile(p);
              // `.hm` file: serve the wrapped form from the artifact cache
              // (wrapping a 5000-line generated sidecar per resolution is
              // measurable).  Dependency tracking mirrors `readFile`.
              const art = this.getSidecarArtifacts(p);
              if (!art) { readFile(p); return null; } // unreadable — warn via readFile
              this.trackDependency(fromUri, pathToFileURL(p).href);
              if (art.wrapped === undefined) art.wrapped = wrapHmSource(art.source);
              return art.wrapped;
            });
            if (part != null) parts.push(part);
          }
          return parts.length > 0 ? parts.join('\n' + TYPE_DIRECTIVE_PART_BOUNDARY + '\n') : null;
        }
      }

      // Relative / absolute path specifier (or bare specifier with no
      // sidecars) — read the single resolved file.
      const filePath = resolveTypeDirectiveSpecifier(specifier, fromUri);
      if (!filePath) return null;

      if (filePath.endsWith('.hm')) {
        const art = this.getSidecarArtifacts(filePath);
        if (!art) { readFile(filePath); return null; } // unreadable — warn via readFile
        this.trackDependency(fromUri, pathToFileURL(filePath).href);
        if (art.wrapped === undefined) art.wrapped = wrapHmSource(art.source);
        return art.wrapped;
      }
      return readFile(filePath);
    };
  }

  /**
   * Create an `ImportTypeAliasResolver` for a given file URI.  Mirrors
   * `createImportResolver` but returns just the type aliases (e.g.
   * `Selector :: (String | Prop a | …)`) declared in the resolved
   * `.hm` sidecar / project override.  Aliases are needed by the
   * importing engine so that bare uppercase type names appearing inside
   * imported schemes get expanded to their full body at unification.
   *
   * Lookup chain mirrors `createImportResolver`: project-level override
   * (or conventional `hm-types/<pkg>.hm`), then the package's own sidecar.
   * Override aliases win on name collision with the sidecar.  Returns
   * `null` when neither source exists.
   */
  createImportTypeAliasResolver(fromUri: string): ImportTypeAliasResolver {
    return (specifier: string) => this.cachedImportTypeAliases(specifier, fromUri);
  }

  /**
   * Memoised {@link resolveImportTypeAliases}.  Also used for the nested
   * imports of an imported JS module, so overlapping closures (every FP-library
   * module imports `../RTask`, `../more/curry`, …) are walked once.  A cycle
   * sees `null` for the module still being resolved (its names are merged
   * by the outer call).
   */
  private cachedImportTypeAliases(specifier: string, fromUri: string): ReturnType<ImportTypeAliasResolver> {
    const rootUri = resolveImportSpecifier(specifier, fromUri);
    const cacheKey = rootUri ? (isBareSpecifier(specifier) ? 'b|' : 'r|') + rootUri : null;
    if (cacheKey) {
      const hit = this.importTypeAliasCache.get(cacheKey);
      if (hit !== undefined) return hit;
      this.importTypeAliasCache.set(cacheKey, null);
    }
    const result = this.resolveImportTypeAliases(specifier, fromUri);
    if (cacheKey) this.importTypeAliasCache.set(cacheKey, result);
    return result;
  }

  /** Uncached body of {@link createImportTypeAliasResolver}. */
  private resolveImportTypeAliases(specifier: string, fromUri: string): ReturnType<ImportTypeAliasResolver> {
    {
      const aliases = new Map<string, Type>();
      const aliasVars = new Map<string, string[]>();
      const constructors = new Map<string, import('../hm/types').Scheme>();
      const instanceCallables = new Map<string, import('../hm/types').Scheme[]>();
      const aliasExtensions: { name: string; raw: string; start: number; end: number }[] = [];
      // Dedup key for `::extend` directives — `(name, raw)`.  Multiple
      // sidecars (or transitive walks) frequently emit byte-identical
      // directives; without this guard the extension list grows linearly
      // with the number of sources and `applyAliasExtensions` ends up
      // appending the same branches over and over, ballooning the alias
      // union (observed: 7× duplication of every relation pair in query-builder
      // selectors, driving hover/diagnostic latency).
      const seenExtensionKeys = new Set<string>();
      let found = false;
      // Cycle / fan-out guard for transitive walks through project files.
      // We follow imports of imported project files so that aliases declared
      // in a deeply-imported package's sidecar (e.g. a query builder's `Tables`) are
      // accessible to a consumer that only imports them indirectly through
      // a project module like `db.js`.  Bare-package specifiers are not
      // walked transitively — we only inspect their direct sidecars.
      const visited = new Set<string>();
      const MAX_TRANSITIVE_DEPTH = 8;

      // JS modules whose own type names were already merged (see
      // `mergeJsModuleTypes`); separate from `visited`, which guards the
      // sidecar walk.
      const jsVisited = new Set<string>();

      const merge = (filePath: string, asOverride: boolean): void => {
        const art = this.getSidecarArtifacts(filePath);
        if (!art) return;
        if (art.aliasData === undefined) {
          art.aliasData = timeSidecarStage('alias', () => parseHmTypeAliases(art.source));
        }
        mergeParsed(art.aliasData, asOverride);
      };

      const mergeParsed = (parsed: ReturnType<typeof parseHmTypeAliases>, asOverride: boolean): void => {
        if (parsed.aliases.size === 0
            && parsed.constructors.size === 0
            && parsed.instanceCallables.size === 0
            && parsed.aliasExtensions.length === 0) return;
        found = true;
        for (const [name, type] of parsed.aliases) {
          // Override entries always win; sidecar entries fill in only what
          // the override didn't already provide.
          if (asOverride || !aliases.has(name)) aliases.set(name, type);
        }
        for (const [name, vars] of parsed.aliasVars) {
          if (asOverride || !aliasVars.has(name)) aliasVars.set(name, vars);
        }
        for (const [name, scheme] of parsed.constructors) {
          if (asOverride || !constructors.has(name)) constructors.set(name, scheme);
        }
        for (const [name, schemes] of parsed.instanceCallables) {
          if (asOverride || !instanceCallables.has(name)) {
            instanceCallables.set(name, [...schemes]);
          }
        }
        // Extensions stack additively across all sources; ordering is
        // preserved so override extensions appear after the sidecar's
        // own (if any).  Application happens once, after all merging.
        // Dedupe identical directives (same target name + same raw RHS)
        // so multiple sidecars or transitive walks don't push the same
        // branches multiple times into `applyAliasExtensions`.
        for (const ext of parsed.aliasExtensions) {
          const key = `${ext.name}\u0000${ext.raw}`;
          if (seenExtensionKeys.has(key)) continue;
          seenExtensionKeys.add(key);
          aliasExtensions.push(ext);
        }
      };

      // Type names visible in an imported JS module: its standalone
      // `// Name :: …` aliases plus, recursively, everything its own
      // `// ::types …` directives and imports bring in.  A module that names types from
      // another module in its signatures (FP-library `express/post` →
      // `::types ./Component`) thereby re-exports those type names, so a
      // consumer that imports `post` can write `ExpressApp`/`RouteFn` in
      // its own annotations without repeating the `::types` line.
      const mergeJsModuleTypes = (targetPath: string, targetUri: string, depth: number): void => {
        if (!/\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(targetPath)) return;
        if (jsVisited.has(targetUri)) return;
        jsVisited.add(targetUri);
        const art = this.getSidecarArtifacts(targetPath);
        if (!art) return;
        if (art.jsAliasData === undefined) {
          art.jsAliasData = timeSidecarStage('alias', () => parseJsTypeAliases(art.source));
        }
        mergeParsed(art.jsAliasData, false);
        if (art.typeDirectives === undefined) {
          art.typeDirectives = art.source.includes('::types') ? extractTypeDirectives(art.source) : [];
        }
        // Both edge kinds reuse the memoised closure of their target; a
        // `::types` specifier that only resolves as a package self-reference
        // (no import target) is walked directly.
        const mergeEdge = (spec: string): void => {
          if (!resolveImportSpecifier(spec, targetUri)) {
            // A relative `::types ./money` that only exists as `money.hm`
            // (the extensionless `.hm` fallback of `::types`): merge that
            // file's types like any other target of the closure.
            if (spec.startsWith('.')) {
              const hmPath = resolveTypeDirectiveSpecifier(spec, targetUri);
              if (hmPath && hmPath.endsWith('.hm')) {
                merge(hmPath, false);
                return;
              }
            }
            walk(spec, targetUri, depth + 1, true);
            return;
          }
          const sub = this.cachedImportTypeAliases(spec, targetUri);
          if (sub) {
            mergeParsed({
              aliases: sub.aliases,
              aliasVars: sub.aliasVars,
              constructors: sub.constructors ?? new Map(),
              instanceCallables: sub.instanceCallables ?? new Map(),
              aliasExtensions: [...(sub.aliasExtensions ?? [])],
            }, false);
          }
        };
        for (const directive of art.typeDirectives) mergeEdge(directive);
        // The module's own imports: a type name it uses in a signature may
        // come from a module it imports (FP-library `Result/parseReq` names
        // `Errors`, declared in `./Schema`, which it requires).
        if (art.importSpecifiers === undefined) {
          art.importSpecifiers = extractImportModuleSpecifiers(art.source);
        }
        for (const nested of art.importSpecifiers) mergeEdge(nested);
      };

      // Walk a single specifier from a given file.  Collects sidecars and
      // overrides for the immediate target; then, if the target resolves
      // to a project source file, recurses into THAT file's import
      // specifiers so transitively-reachable aliases are merged in too.
      // `typeNames`: also merge the JS target's type names (see
      // `mergeJsModuleTypes`): its own aliases, its `::types` closure and,
      // recursively, those of its imports (bounded by MAX_TRANSITIVE_DEPTH).
      // First wins on a name collision, so nearer modules take precedence
      // along a branch; local declarations always win in the consumer.
      const walk = (spec: string, originUri: string, depth: number, typeNames: boolean): void => {
        if (depth > MAX_TRANSITIVE_DEPTH) return;

        // Override (or hm-types/ convention, subpath-aware) for bare specifiers.
        if (this.projectRoot && isBareSpecifier(spec)) {
          const pkgName = getBarePackageName(spec);
          const overrideRel = this.packageOverrides[pkgName];
          let overridePath: string | null = null;
          if (overrideRel) {
            overridePath = path.resolve(this.projectRoot, overrideRel);
          } else {
            overridePath = this.conventionalStubPath(spec);
          }
          if (overridePath) {
            try { if (isFile(overridePath)) merge(overridePath, true); }
            catch { /* ignore */ }
          }
        }

        // Package sidecar(s) (npm) or per-file sidecar (project source).
        let targetUri = resolveImportSpecifier(spec, originUri);
        if (!targetUri && typeNames) {
          // `::types` specifiers also resolve to a package's own sidecar
          // (package self-reference), like the type-directive resolver.
          const directivePath = resolveTypeDirectiveSpecifier(spec, originUri);
          if (directivePath) targetUri = pathToFileURL(directivePath).href;
        }
        if (!targetUri) return;
        const targetPath = fileURLToPath(targetUri);
        if (typeNames) mergeJsModuleTypes(targetPath, targetUri, depth);
        if (visited.has(targetUri)) return;
        visited.add(targetUri);

        const sidecarPaths = findHmSidecarPaths(targetPath);
        // Within a single package's sidecar list, later entries override
        // earlier ones (e.g. an auto-generated introspect sidecar refines
        // the hand-written base sidecar).  The first sidecar still respects
        // any project-level override placed before this loop.
        for (let i = 0; i < sidecarPaths.length; i++) {
          const sidecarPath = sidecarPaths[i];
          try { if (isFile(sidecarPath)) merge(sidecarPath, i > 0); }
          catch { /* ignore */ }
        }
        // Companion @hm/<pkg> for bare specifiers without their own sidecar.
        if (sidecarPaths.length === 0 && isBareSpecifier(spec)) {
          const companionSpec = hmCompanionPackageName(getBarePackageName(spec));
          const companionUri = resolveImportSpecifier(companionSpec, originUri);
          if (companionUri) {
            const companionPath = fileURLToPath(companionUri);
            const companionSidecars = findHmSidecarPaths(companionPath);
            for (let i = 0; i < companionSidecars.length; i++) {
              const companionSidecar = companionSidecars[i];
              try { if (isFile(companionSidecar)) merge(companionSidecar, i > 0); }
              catch { /* ignore */ }
            }
          }
        }
        // Per-file sidecar for project sources: <target>.hm.
        const perFileSidecar = targetPath + '.hm';
        try {
          if (isFile(perFileSidecar)) merge(perFileSidecar, false);
        } catch { /* no per-file sidecar */ }

        // Transitive descent: only into project source files (relative
        // specifiers that resolve to a JS/TS file inside the workspace).
        // Never recurse through bare-package specifiers — their alias
        // surface is fully determined by their own sidecar(s) above.
        if (isBareSpecifier(spec)) return;
        let nestedSource: string;
        try {
          const doc = this.documents.get(targetUri);
          nestedSource = doc ? doc.getText() : fs.readFileSync(targetPath, 'utf-8');
        } catch { return; }
        for (const nestedSpec of extractImportModuleSpecifiers(nestedSource)) {
          walk(nestedSpec, targetUri, depth + 1, false);
        }
      };

      walk(specifier, fromUri, 0, true);

      if (!found) return null;
      return { aliases, aliasVars, constructors, instanceCallables, aliasExtensions };
    }
  }
}
