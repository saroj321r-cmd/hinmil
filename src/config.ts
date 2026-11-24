// ============================================================================
// Configuration types & defaults for the HinMil language server
//
// Plain language: users can tune the checker's behaviour (which warnings to
// show, how much to trust hand-written annotations, …) via VS Code settings
// and per-project `hinmil.config.json` files.  This file defines the shape of
// those settings, their default values, and the routines that read, validate
// and merge them from the various sources.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';

/**
 * How aggressively to trust user-written `::` annotations.  Each level is a
 * cumulative superset of the previous one:
 *
 *  - `'off'`               — show every diagnostic.
 *  - `'signatures'`        — also drop annotation-vs-inferred mismatch
 *                            diagnostics (equivalent to the legacy
 *                            boolean `trustAnnotations: true`).
 *  - `'annotated-bodies'`  — also drop diagnostics whose source range falls
 *                            inside the body of a binding that carries a
 *                            `::` annotation.
 *  - `'all-bodies'`        — also drop diagnostics inside the body of any
 *                            binding, annotated or not.  `missingSignatures`
 *                            remains active so unsigned bindings still get
 *                            nudged.
 */
export type TrustAnnotationsLevel =
  | 'off'
  | 'signatures'
  | 'annotated-bodies'
  | 'all-bodies';

/** Set of valid `TrustAnnotationsLevel` strings, used for runtime validation. */
const TRUST_ANNOTATIONS_LEVELS: ReadonlySet<TrustAnnotationsLevel> = new Set([
  'off', 'signatures', 'annotated-bodies', 'all-bodies',
]);

/**
 * Coerce an arbitrary input into a {@link TrustAnnotationsLevel}.
 * Any unknown value → `'off'` (and a console warning is emitted).
 */
export function normalizeTrustAnnotations(
  input: unknown,
  warn: (msg: string) => void = (msg) => console.warn(msg),
): TrustAnnotationsLevel {
  if (typeof input === 'string' && TRUST_ANNOTATIONS_LEVELS.has(input as TrustAnnotationsLevel)) {
    return input as TrustAnnotationsLevel;
  }
  if (input !== undefined && input !== null) {
    warn(`[hinmil] Invalid trustAnnotations value ${JSON.stringify(input)}; falling back to 'off'.`);
  }
  return 'off';
}

/**
 * Severity-or-off level for a diagnostic category.
 *
 *  - `'off'` — the category is suppressed entirely.
 *  - Any other value maps to the corresponding LSP `DiagnosticSeverity`.
 */
export type DiagnosticLevel = 'off' | 'hint' | 'information' | 'warning' | 'error';

/** Set of valid `DiagnosticLevel` strings, used for runtime validation. */
export const DIAGNOSTIC_LEVELS: ReadonlySet<DiagnosticLevel> = new Set([
  'off', 'hint', 'information', 'warning', 'error',
]);

/** Who answers go-to-definition for code (imports, local names):
 *  `'auto'` — hinmil, unless VS Code's built-in TypeScript/JavaScript
 *  extension is active (which already does it); `'always'` — hinmil too;
 *  `'off'` — never (type and annotation navigation keeps working). */
export type DefinitionMode = 'auto' | 'always' | 'off';
export const DEFINITION_MODES: ReadonlySet<DefinitionMode> = new Set(['auto', 'always', 'off']);

export interface HinMilSettings {
  diagnostics: {
    /** Master switch for all diagnostics. */
    enabled: boolean;
    /** Delay (ms) before publishing diagnostics after a change.  Only
     *  affects diagnostics publication — hover / completion / signature
     *  help run on the request path and are never delayed by this. */
    debounceMs: number;
    trustAnnotations: TrustAnnotationsLevel;
    /** Type mismatch / unification errors (codes 1001-1004, 1009, 7001). */
    typeErrors: DiagnosticLevel;
    /** Property access on a type that doesn't declare it (1005, 1006). */
    unknownPropertyAccess: DiagnosticLevel;
    /** Returned record missing fields required by the annotation (1008). */
    missingRecordFields: DiagnosticLevel;
    /** Object literal argument with fields its named record type lacks (1010). */
    excessRecordFields: DiagnosticLevel;
    /** Concrete annotation narrows an inferred union (2009). */
    annotationNarrowing: DiagnosticLevel;
    /** Functions / methods without an HM annotation (6001). */
    missingSignatures: DiagnosticLevel;
    /** Non-function variables without an HM annotation (6001). */
    missingVariableSignatures: DiagnosticLevel;
  };
  hover: {
    enabled: boolean;
  };
  completion: {
    enabled: boolean;
    /** Suggest not-yet-imported workspace exports (with an auto-added
     *  import statement) in identifier completions, and warm the
     *  workspace-export cache in the background. */
    autoImports: boolean;
  };
  signatureHelp: {
    enabled: boolean;
  };
  navigation: {
    /** Go to definition for imports and local names (see DefinitionMode). */
    definitions: DefinitionMode;
  };
  display: {
    /** 'pretty' shows readable type variables (a, b, c); 'raw' shows
     *  internal ids (t0, t1, …). */
    typeVariables: 'pretty' | 'raw';
  };
  dom: {
    /** Typed browser globals: `document`/`window`/`navigator`/`localStorage`/
     *  `sessionStorage` get nominal types (Document, Window, …) with
     *  IntelliSense on the compact DOM catalogue, and Document/Element/…
     *  become valid annotation type names.  Off reverts them to `Any`
     *  (kill switch when a project defines its own `Element` type). */
    globalTypes: boolean;
    /** DOM lookups that can miss (getElementById, querySelector,
     *  getAttribute, Storage#getItem, …) return `T | Null` when true. */
    strictNulls: boolean;
  };
}

/** Deep-partial shape of {@link HinMilSettings}, as received from the client
 *  or from the `"settings"` key of a project config file. */
export type HinMilPartialSettings = {
  [K in keyof HinMilSettings]?: Partial<HinMilSettings[K]>;
};

/**
 * Project-level configuration loaded from `package.json` `"hinmil"` key
 * or a standalone `hinmil.config.js` / `hinmil.config.json` file.
 */
export interface HinMilProjectConfig {
  /** Run the language server for this project at all.  `false` disables
   *  HinMil for the project regardless of editor settings — handy to opt a
   *  single repository out from within the repository itself.  Default: true. */
  enable?: boolean;
  /** Paths to globals file(s) (relative to project root).  Each entry's
   *  contents are concatenated (in order) to form the project-wide globals.
   *  String values are rejected with a warning — use an array. */
  globals?: string[];
  /** Per-package `.hm` overrides keyed by bare package name (e.g. `"query-builder"`). */
  overrides?: Record<string, string>;
  /** Directory (relative to project root) for conventional `<typesDir>/<pkg>.hm` files. Default: `hm-types`. */
  typesDir?: string;
  /** Editor-settings overrides shared through the repo.  Same shape as the
   *  VS Code `hinmil.*` settings; merged ON TOP of the editor settings
   *  (project file wins where it specifies a value). */
  settings?: HinMilPartialSettings;
  /** Standalone source-file selection. Excluded files may still be inferred as dependencies. */
  files?: {
    extensions?: string[];
    include?: string[];
    exclude?: string[];
  };
}

/**
 * Package-level configuration declared by a *library author* under the
 * `"hinmil"` key of the package's `package.json`.  Read by consumers when
 * they import the package.
 *
 *   {
 *     "hinmil": {
 *       "sidecars": "./types.hm",         // or array of paths
 *       "globals":  "./types-globals.hm"  // constraints/aliases visible
 *                                         // to every consumer file that
 *                                         // imports this package
 *     }
 *   }
 *
 * Replaces the legacy top-level `"hinmil.sidecars"` field.
 */
export interface HinMilPackageConfig {
  /** `.hm` sidecar(s) declaring exports/methods. Single path or array. */
  sidecars?: string | string[];
  /** Package-level globals file(s) (aliases, constraints, `::types`
   *  directives).  Each entry is auto-appended to consumer engine globals
   *  whenever the package is imported, so inline signatures can reference
   *  shared constraints.  String values are rejected with a warning — use
   *  an array. */
  globals?: string[];
}

/** Default file names searched (in order) when no explicit config is found. */
export const PROJECT_CONFIG_FILES = ['hinmil.config.js', 'hinmil.config.json'] as const;

/** Conventional default globals file names, searched in order. */
export const DEFAULT_GLOBALS_FILES = ['globals.hm'] as const;

/** Default directory for project-level npm package type stubs. */
export const DEFAULT_TYPES_DIR = 'hm-types' as const;

/**
 * Load project-level configuration from `package.json` `"hinmil"` key,
 * or a standalone `hinmil.config.js` / `hinmil.config.json` file.
 *
 * Lives here (dependency-free apart from `fs`/`path`) so both the language
 * server and the extension client can read it without pulling in the
 * inference engine.
 */
export function loadProjectConfig(rootDir: string): HinMilProjectConfig {
  // 1. Try package.json "hinmil" key
  try {
    const pkgPath = path.join(rootDir, 'package.json');
    const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkgJson['hinmil'] && typeof pkgJson['hinmil'] === 'object') {
      return pkgJson['hinmil'] as HinMilProjectConfig;
    }
  } catch { /* no package.json or no hinmil key */ }

  // 2. Try standalone config files
  for (const configFile of PROJECT_CONFIG_FILES) {
    const cfgPath = path.join(rootDir, configFile);
    try {
      if (configFile.endsWith('.json')) {
        return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as HinMilProjectConfig;
      } else {
        // .js config - read and parse as JSON-like (we support simple object exports)
        const content = fs.readFileSync(cfgPath, 'utf-8');
        const match = /module\.exports\s*=\s*(\{[^]*\})/.exec(content);
        if (match) {
          return JSON.parse(match[1]) as HinMilProjectConfig;
        }
      }
    } catch { /* file not found or parse error */ }
  }

  return {};
}

/**
 * Does the given directory contain explicit hinmil project configuration?
 * True when a standalone config file (`hinmil.config.js` / `hinmil.config.json`)
 * exists, or when `package.json` carries a `"hinmil"` object key.
 *
 * Used by the extension client to decide whether to launch the language
 * server at all when `hinmil.requiresConfig` is enabled.  Deliberately
 * dependency-free (plain `fs`) so the extension host does not pull in the
 * inference engine just for this check.
 */
export function hasProjectConfig(rootDir: string): boolean {
  for (const configFile of PROJECT_CONFIG_FILES) {
    if (fs.existsSync(path.join(rootDir, configFile))) return true;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
    return pkg['hinmil'] !== undefined && typeof pkg['hinmil'] === 'object';
  } catch {
    return false;
  }
}

/**
 * The project scope of a file: the nearest directory, from the file's own
 * directory up to `boundary` (the workspace or `--project` root), that has
 * hinmil configuration.  A repository with several applications (`server/`,
 * `client/`) gives each its own `hinmil.config.json` with its own globals,
 * types directory and overrides.  Without a nested configuration the scope
 * is `boundary`.  Files under `node_modules` belong to `boundary` (a
 * package's own `hinmil` key describes its sidecars, not a scope).
 */
export function findScopeRoot(filePath: string, boundary: string): string {
  const root = path.resolve(boundary);
  let dir = path.dirname(path.resolve(filePath));
  if (dir.split(path.sep).includes('node_modules')) return root;
  while (dir.startsWith(root + path.sep)) {
    if (hasProjectConfig(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return root;
}

export const defaultSettings: HinMilSettings = {
  diagnostics: {
    enabled: true,
    debounceMs: 500,
    trustAnnotations: 'off',
    typeErrors: 'error',
    unknownPropertyAccess: 'error',
    missingRecordFields: 'error',
    excessRecordFields: 'error',
    annotationNarrowing: 'error',
    missingSignatures: 'information',
    missingVariableSignatures: 'off',
  },
  hover: {
    enabled: true,
  },
  completion: {
    enabled: true,
    autoImports: true,
  },
  signatureHelp: {
    enabled: true,
  },
  navigation: {
    definitions: 'auto',
  },
  display: {
    typeVariables: 'pretty',
  },
  dom: {
    globalTypes: true,
    strictNulls: false,
  },
};

// ---------------------------------------------------------------------------
// Settings merging & validation
// ---------------------------------------------------------------------------

/** Top-level `hinmil.*` groups that exist but are handled client-side only
 *  (never reach the server's settings object) — silently ignored. */
const CLIENT_ONLY_GROUPS: ReadonlySet<string> = new Set(['syntaxHighlighting', 'trace', 'files']);

type Warn = (msg: string) => void;

function pickBool(v: unknown, prev: boolean, key: string, warn: Warn): boolean {
  if (typeof v === 'boolean') return v;
  warn(`[hinmil] Invalid value for '${key}': ${JSON.stringify(v)} (expected boolean); keeping ${prev}.`);
  return prev;
}

function pickNumber(v: unknown, prev: number, key: string, warn: Warn): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  warn(`[hinmil] Invalid value for '${key}': ${JSON.stringify(v)} (expected non-negative number); keeping ${prev}.`);
  return prev;
}

function pickEnum<T extends string>(
  v: unknown, prev: T, valid: ReadonlySet<T>, key: string, warn: Warn,
): T {
  if (typeof v === 'string' && valid.has(v as T)) return v as T;
  warn(`[hinmil] Invalid value for '${key}': ${JSON.stringify(v)} (expected one of ${
    [...valid].map(x => `'${x}'`).join(' | ')}); keeping '${prev}'.`);
  return prev;
}

const TYPE_VARIABLE_STYLES: ReadonlySet<'pretty' | 'raw'> = new Set(['pretty', 'raw'] as const);

/** Apply one partial settings layer onto `s` in place, validating every
 *  value.  Unknown keys and invalid values produce a warning and are
 *  ignored (previous value kept). */
function applySettingsLayer(s: HinMilSettings, layer: Record<string, unknown>, warn: Warn): void {
  const group = (key: string): Record<string, unknown> | null => {
    const v = layer[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) {
      warn(`[hinmil] Invalid settings group '${key}': expected an object; ignoring.`);
      return null;
    }
    return v as Record<string, unknown>;
  };

  for (const key of Object.keys(layer)) {
    if (key === 'diagnostics' || key === 'hover' || key === 'completion'
        || key === 'signatureHelp' || key === 'navigation' || key === 'display' || key === 'dom'
        || CLIENT_ONLY_GROUPS.has(key)) continue;
    warn(`[hinmil] Unknown settings key '${key}'; ignoring.`);
  }

  const d = group('diagnostics');
  if (d) {
    for (const [k, v] of Object.entries(d)) {
      if (v === undefined || v === null) continue;
      switch (k) {
        case 'enabled':
          s.diagnostics.enabled = pickBool(v, s.diagnostics.enabled, 'diagnostics.enabled', warn); break;
        case 'debounceMs':
          s.diagnostics.debounceMs = pickNumber(v, s.diagnostics.debounceMs, 'diagnostics.debounceMs', warn); break;
        case 'trustAnnotations':
          s.diagnostics.trustAnnotations = pickEnum(v, s.diagnostics.trustAnnotations, TRUST_ANNOTATIONS_LEVELS, 'diagnostics.trustAnnotations', warn); break;
        case 'typeErrors':
        case 'unknownPropertyAccess':
        case 'missingRecordFields':
        case 'excessRecordFields':
        case 'annotationNarrowing':
        case 'missingSignatures':
        case 'missingVariableSignatures':
          s.diagnostics[k] = pickEnum(v, s.diagnostics[k], DIAGNOSTIC_LEVELS, `diagnostics.${k}`, warn); break;
        default:
          warn(`[hinmil] Unknown settings key 'diagnostics.${k}'; ignoring.`);
      }
    }
  }

  const h = group('hover');
  if (h) {
    for (const [k, v] of Object.entries(h)) {
      if (v === undefined || v === null) continue;
      if (k === 'enabled') s.hover.enabled = pickBool(v, s.hover.enabled, 'hover.enabled', warn);
      else warn(`[hinmil] Unknown settings key 'hover.${k}'; ignoring.`);
    }
  }

  const c = group('completion');
  if (c) {
    for (const [k, v] of Object.entries(c)) {
      if (v === undefined || v === null) continue;
      if (k === 'enabled') s.completion.enabled = pickBool(v, s.completion.enabled, 'completion.enabled', warn);
      else if (k === 'autoImports') s.completion.autoImports = pickBool(v, s.completion.autoImports, 'completion.autoImports', warn);
      else warn(`[hinmil] Unknown settings key 'completion.${k}'; ignoring.`);
    }
  }

  const sig = group('signatureHelp');
  if (sig) {
    for (const [k, v] of Object.entries(sig)) {
      if (v === undefined || v === null) continue;
      if (k === 'enabled') s.signatureHelp.enabled = pickBool(v, s.signatureHelp.enabled, 'signatureHelp.enabled', warn);
      else warn(`[hinmil] Unknown settings key 'signatureHelp.${k}'; ignoring.`);
    }
  }

  const nav = group('navigation');
  if (nav) {
    for (const [k, v] of Object.entries(nav)) {
      if (v === undefined || v === null) continue;
      if (k === 'definitions') s.navigation.definitions = pickEnum(v, s.navigation.definitions, DEFINITION_MODES, 'navigation.definitions', warn);
      else warn(`[hinmil] Unknown settings key 'navigation.${k}'; ignoring.`);
    }
  }

  const disp = group('display');
  if (disp) {
    for (const [k, v] of Object.entries(disp)) {
      if (v === undefined || v === null) continue;
      if (k === 'typeVariables') s.display.typeVariables = pickEnum(v, s.display.typeVariables, TYPE_VARIABLE_STYLES, 'display.typeVariables', warn);
      else warn(`[hinmil] Unknown settings key 'display.${k}'; ignoring.`);
    }
  }

  const dom = group('dom');
  if (dom) {
    for (const [k, v] of Object.entries(dom)) {
      if (v === undefined || v === null) continue;
      if (k === 'globalTypes') s.dom.globalTypes = pickBool(v, s.dom.globalTypes, 'dom.globalTypes', warn);
      else if (k === 'strictNulls') s.dom.strictNulls = pickBool(v, s.dom.strictNulls, 'dom.strictNulls', warn);
      else warn(`[hinmil] Unknown settings key 'dom.${k}'; ignoring.`);
    }
  }
}

/**
 * Merge zero or more partial settings layers onto {@link defaultSettings}.
 *
 * Later layers win over earlier ones (the server passes
 * `[vsCodeSettings, projectFileSettings]` so a project config file
 * overrides personal editor settings).  Every value is validated:
 * unknown keys and invalid values emit a warning and are skipped.
 */
export function mergeSettings(
  layers: ReadonlyArray<unknown>,
  warn: Warn = () => {},
): HinMilSettings {
  const s: HinMilSettings = {
    diagnostics: { ...defaultSettings.diagnostics },
    hover: { ...defaultSettings.hover },
    completion: { ...defaultSettings.completion },
    signatureHelp: { ...defaultSettings.signatureHelp },
    navigation: { ...defaultSettings.navigation },
    display: { ...defaultSettings.display },
    dom: { ...defaultSettings.dom },
  };
  for (const layer of layers) {
    if (layer === undefined || layer === null) continue;
    if (typeof layer !== 'object' || Array.isArray(layer)) {
      warn(`[hinmil] Ignoring non-object settings layer: ${JSON.stringify(layer)}.`);
      continue;
    }
    applySettingsLayer(s, layer as Record<string, unknown>, warn);
  }
  return s;
}
