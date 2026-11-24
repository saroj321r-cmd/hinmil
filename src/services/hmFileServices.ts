// ============================================================================
// hmFileServices — language services on standalone `.hm` declaration files
//
// `.hm` files are bare-syntax type-declaration sources consumed by other JS
// files via the sidecar / globals mechanism in `services/files.ts`.  Until
// now the language server provided no features *on* `.hm` files themselves
// (`validateTextDocument` early-returned, hover/definition were calling
// `engine.infer` on the raw source).
//
// This module is the small "declarations-only" pipeline used by the server
// when the active document is a `.hm` file.  It:
//
//   1. Wraps the source via the existing `wrapHmSource` so the JS comment
//      parser can extract annotations.
//   2. Builds a bidirectional offset map between the original `.hm` text
//      and the wrapped buffer (each non-comment line gains a 3-char `// `
//      prefix in the wrapped buffer; line numbers are preserved).
//   3. Surfaces parse errors as diagnostics, an `Name :: ...` hover, an
//      uppercase-type go-to-definition, and a flat document-symbol list.
//
// All cross-file resolution (globals, query-builder index, package `hinmil.sidecars`,
// project overrides, per-file sidecars, constraint directives) is reused
// from `services/importContext.ts` and `services/files.ts`; this module
// only owns offset translation and `.hm`-aware delegation.
// ============================================================================

import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
  Hover,
  Location,
  Range,
  SymbolKind,
} from 'vscode-languageserver/node';

import { extractAnnotations, TypeAnnotation, buildAnnotationMap, extractDataDirectives, extractTypeDirectives } from '../commentParser';
import {
  positionAt,
  wrapHmSource,
  parseHmSourceRaw,
  parseHmTypeAliases,
  resolveTypeDirectiveSpecifier,
} from './files';
import {
  annotationTypeParts,
  findArityMismatches,
  BUILTIN_TYPE_NAMES,
  BUILTIN_TYPE_ARITIES,
} from '../infer/annotations';
import { activeDomAnnotationTypeNames } from '../registries/domGlobals';
import {
  Type,
  findUnknownTCons,
  getReturnType,
} from '../hm/types';
import { eachType } from '../hm/typeUtils';
import { getDataType, getDataTypeNames, getVariantNames } from '../registries/dataTypeRegistry';
import { getTypeArity, getRegisteredTypeNames } from '../registries/methodRegistry';
import { getConstraintNames } from '../registries/constraintRegistry';

// ---------------------------------------------------------------------------
// Offset map between original `.hm` source and its wrapped buffer
// ---------------------------------------------------------------------------

/**
 * Bidirectional mapping for a single `.hm` source.  `wrapHmSource` either:
 *   - blanks a line to spaces of the same length (true comments, blanks,
 *     block-comment interiors), preserving every byte offset; or
 *   - prepends `// ` to a non-comment line, shifting every later byte on
 *     that line by exactly 3.
 *
 * Line numbers are preserved in either case, so we precompute per-line
 * starts in both buffers and translate within a line by adding/subtracting
 * 3 on wrapped lines (clamped at the start of the line).
 */
export interface HmOffsetMap {
  /** The `.hm` source as wrapped for the JS comment parser. */
  wrapped: string;
  /** Translate a byte offset in the wrapped buffer to the original. */
  toOriginal(wrappedOffset: number): number;
  /** Translate a byte offset in the original `.hm` source to the wrapped buffer. */
  toWrapped(originalOffset: number): number;
}

export function buildHmOffsetMap(source: string): HmOffsetMap {
  const wrapped = wrapHmSource(source);

  // Per-line starts in each buffer.
  const lines = source.split('\n');
  const wrappedLines = wrapped.split('\n');
  const origLineStart: number[] = new Array(lines.length);
  const wrapLineStart: number[] = new Array(wrappedLines.length);
  /** True when the wrapped line gained a `// ` prefix relative to the original. */
  const wrappedFlag: boolean[] = new Array(lines.length);

  let oAcc = 0;
  let wAcc = 0;
  for (let i = 0; i < lines.length; i++) {
    origLineStart[i] = oAcc;
    wrapLineStart[i] = wAcc;
    const origLen = lines[i].length;
    const wrapLen = wrappedLines[i] !== undefined ? wrappedLines[i].length : origLen;
    wrappedFlag[i] = wrapLen === origLen + 3;
    oAcc += origLen + 1; // include trailing '\n'
    wAcc += wrapLen + 1;
  }

  /** Find the line index containing `offset` using `lineStart[]`. */
  const findLine = (lineStart: number[], offset: number): number => {
    if (offset <= 0) return 0;
    // Binary search: greatest index whose start <= offset.
    let lo = 0;
    let hi = lineStart.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStart[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  return {
    wrapped,
    toOriginal(wOff: number): number {
      if (wOff <= 0) return 0;
      if (wOff >= wrapped.length) return source.length;
      const li = findLine(wrapLineStart, wOff);
      const col = wOff - wrapLineStart[li];
      const origCol = wrappedFlag[li] ? Math.max(0, col - 3) : col;
      const lineLen = lines[li].length;
      return origLineStart[li] + Math.min(origCol, lineLen);
    },
    toWrapped(oOff: number): number {
      if (oOff <= 0) return 0;
      if (oOff >= source.length) return wrapped.length;
      const li = findLine(origLineStart, oOff);
      const col = oOff - origLineStart[li];
      const wrappedCol = wrappedFlag[li] ? col + 3 : col;
      return wrapLineStart[li] + wrappedCol;
    },
  };
}

// ---------------------------------------------------------------------------
// Parse cache
// ---------------------------------------------------------------------------

/**
 * Result of parsing a `.hm` source: the wrapped buffer, the annotation list
 * extracted from it, and the offset map.  Cached per (uri, source) so the
 * four feature handlers don't re-parse on consecutive calls.
 */
export interface ParsedHm {
  source: string;
  map: HmOffsetMap;
  annotations: TypeAnnotation[];
}

const parseCache = new Map<string, { source: string; parsed: ParsedHm }>();
const PARSE_CACHE_MAX = 16;

export function parseHm(uri: string, source: string): ParsedHm {
  const cached = parseCache.get(uri);
  if (cached && cached.source === source) return cached.parsed;
  const map = buildHmOffsetMap(source);
  const annotations = extractAnnotations(map.wrapped);
  const parsed: ParsedHm = { source, map, annotations };
  parseCache.set(uri, { source, parsed });
  if (parseCache.size > PARSE_CACHE_MAX) {
    // Drop the oldest insertion order entry.
    const firstKey = parseCache.keys().next().value as string | undefined;
    if (firstKey && firstKey !== uri) parseCache.delete(firstKey);
  }
  return parsed;
}

export function clearHmParseCache(): void {
  parseCache.clear();
}

/**
 * Evict a single parsed `.hm` entry by its key (typically a `file://` URI
 * or absolute path — must match the key used at the corresponding
 * {@link parseHm} call site).  Used by the `.hm` watcher / change-content
 * handler so per-file invalidation does not nuke unrelated sidecars from
 * the small 16-slot LRU.
 */
export function clearHmParseCacheForFile(uri: string): void {
  parseCache.delete(uri);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Build diagnostics for a `.hm` file.  Three classes of errors are
 * surfaced:
 *
 *   1. **Parse errors** — the existing `TypeAnnotation.error` field
 *      already carries the relevant message from
 *      `parseTypeSignature` / `parseMethodTypeSignature`.
 *
 *   2. **Arity mismatches** — `QueryTag a` in a file that declares
 *      `QueryTag :: (a, b) -> QueryTag a b` (or whose registered arity is 2).
 *      Reuses the same `findArityMismatches` walker the JS pipeline uses.
 *
 *   3. **Unknown type-constructor references** — e.g. `Property` typo
 *      for `Prop`.  An identifier is considered unknown only after
 *      checking: builtins, locally declared annotations / sumtypes /
 *      aliases, the global registries, AND the cross-file sidecar +
 *      globals chain via `ctx.findTypeDefinitions`.  This avoids false
 *      positives on legitimate forward references in stubs like
 *      `node_modules/query-builder/query-builder.hm`.
 *
 * Severity is Error for all three — user explicitly wants typos caught.
 */
export function getHmDiagnostics(
  uri: string,
  source: string,
  ctx?: HmServiceContext,
): Diagnostic[] {
  const parsed = parseHm(uri, source);
  const diagnostics: Diagnostic[] = [];

  // --- 1. Parse errors ---
  for (const ann of parsed.annotations) {
    if (!ann.error) continue;
    const startOff = parsed.map.toOriginal(ann.commentStart);
    const endOff = parsed.map.toOriginal(ann.commentEnd);
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromOffsets(source, startOff, endOff),
      message: ann.error,
      source: 'hinmil',
    });
  }

  // --- Build local indices (shared by arity + unknown-type checks) ---
  const annotationMap = buildAnnotationMap(parsed.map.wrapped);
  const aliasResult = parseHmTypeAliases(source);
  const localTypeAliases = aliasResult.aliases;

  // --- 2. Arity mismatches ---
  const { arities: constructorArities, constructors: localConstructorNames } =
    collectLocalArities(annotationMap, localTypeAliases);
  const aliasNames = new Set(localTypeAliases.keys());
  const seenArityKeys = new Set<string>();
  const recordArity = (
    ann: TypeAnnotation,
    name: string,
    actual: number,
    expected: number,
    localKeys: Set<string>,
  ) => {
    const key = `${ann.commentStart}:${name}:${actual}:${expected}`;
    if (localKeys.has(key)) return;
    localKeys.add(key);
    if (seenArityKeys.has(key)) return;
    seenArityKeys.add(key);
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: annotationDiagnosticRange(source, parsed.map, ann),
      message: `Type constructor '${name}' expects ${expected} type argument(s) but got ${actual}`,
      source: 'hinmil',
    });
  };
  for (const ann of parsed.annotations) {
    if (!ann.scheme) continue;
    const localKeys = new Set<string>();
    for (const t of annotationTypeParts(ann)) {
      // Standard arity walker (mirrors JS pipeline).  Note: this walker
      // intentionally exempts zero-arg uses of names that look like type
      // aliases (so `[Selector]` works), so it does not catch bare uses
      // of real constructor annotations.  We handle those below.
      for (const m of findArityMismatches(t, constructorArities, aliasNames)) {
        recordArity(ann, m.name, m.actual, m.expected, localKeys);
      }
      // Real constructors (e.g. `Prop :: (String, a) -> Prop b`) require
      // their type arguments even when used bare — unlike aliases there
      // is no "instantiate with fresh vars" fallback for them at the use
      // site.  Emit a dedicated arity error for `Prop` (not `Prop a`).
      eachType(t, n => {
        if (n.tag !== 'TCon') return;
        if (n.args.length !== 0) return;
        if (!localConstructorNames.has(n.name)) return;
        const expected = constructorArities.get(n.name);
        if (expected === undefined || expected === 0) return;
        recordArity(ann, n.name, 0, expected, localKeys);
      });
    }
  }

  // --- 3. Unknown type-constructor references ---
  const known = buildKnownNames(annotationMap, localTypeAliases, parsed.map.wrapped, ctx);
  for (const name of namesFromTypeDirectives(uri, parsed.map.wrapped)) known.add(name);
  // Per-call resolution cache for cross-file fallback so we don't walk
  // the sidecar chain twice for the same identifier.
  const resolved = new Map<string, boolean>();
  const isResolvable = (name: string): boolean => {
    if (known.has(name)) return true;
    const cached = resolved.get(name);
    if (cached !== undefined) return cached;
    const ok = !!ctx && ctx.findTypeDefinitions(name).length > 0;
    resolved.set(name, ok);
    return ok;
  };

  for (const ann of parsed.annotations) {
    if (!ann.scheme) continue;
    const reported = new Set<string>();
    for (const t of annotationTypeParts(ann)) {
      const candidates = findUnknownTCons(t, known);
      for (const name of candidates) {
        if (reported.has(name)) continue;
        if (isResolvable(name)) continue;
        reported.add(name);
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: annotationDiagnosticRange(source, parsed.map, ann),
          message: `Unknown type constructor '${name}'`,
          source: 'hinmil',
        });
      }
    }
  }

  return diagnostics;
}

/**
 * Collect arity information for type constructors visible *to this file*.
 * Combines local constructor annotations / aliases / sumtypes with the
 * global data-type and method registries plus hardcoded builtins.  Mirrors
 * the lookup cascade in `findArityMismatches` so registry-only types
 * (e.g. `Array`, `Map`, `Promise`) participate too.
 */
function collectLocalArities(
  annotationMap: Map<string, TypeAnnotation>,
  typeAliases: Map<string, Type>,
): { arities: Map<string, number>; constructors: Set<string> } {
  const arities = new Map<string, number>();
  const constructors = new Set<string>();

  // Constructor annotations: `Pair :: (a, b) -> Pair a b` → arity 2.
  for (const [name, ann] of annotationMap) {
    if (!ann.scheme) continue;
    if (name.includes('#') || name.includes('.')) continue;
    const ret = getReturnType(ann.scheme.type);
    if (ret.tag === 'TCon' && ret.name === name && ret.args.length > 0) {
      arities.set(name, ret.args.length);
      constructors.add(name);
    }
  }

  // Type aliases: free-var count is the alias's arity.
  for (const [name, type] of typeAliases) {
    if (arities.has(name)) continue;
    const seen = new Set<string>();
    let count = 0;
    eachType(type, n => {
      if (n.tag === 'TVar' && !seen.has(n.name)) {
        seen.add(n.name);
        count++;
      }
    });
    if (count > 0) arities.set(name, count);
  }

  // Registered data types (from sumtype declarations across the workspace).
  for (const name of getDataTypeNames()) {
    if (arities.has(name)) continue;
    const dt = getDataType(name);
    if (dt && dt.decl.typeVars.length > 0) arities.set(name, dt.decl.typeVars.length);
  }

  // Method registry arities (Array, Map, Set, Promise, registered sidecars).
  for (const name of getRegisteredTypeNames()) {
    if (arities.has(name)) continue;
    const a = getTypeArity(name);
    if (a > 0) arities.set(name, a);
  }

  // Hardcoded builtins (StrMap etc.).
  for (const [name, a] of BUILTIN_TYPE_ARITIES) {
    if (!arities.has(name)) arities.set(name, a);
  }

  return { arities, constructors };
}

/**
 * Build the set of type-constructor names considered "known" for the
 * unknown-type check.  Anything not in this set falls through to the
 * cross-file `findTypeDefinitions` fallback before being reported.
 */
/**
 * Type names declared by the files a `.hm` file pulls in with `::types`
 * (followed transitively).  Without this, a sidecar that starts with
 * `::types query-builder` (a query builder's generated `src/generated/client/index.hm`) reported
 * every query-builder constructor as unknown whenever the target was not already
 * known through package sidecars — e.g. inside a query builder's own repository.
 */
function namesFromTypeDirectives(uri: string, wrappedSource: string): Set<string> {
  const names = new Set<string>();
  const seen = new Set<string>();
  const visit = (fromUri: string, wrapped: string) => {
    for (const spec of extractTypeDirectives(wrapped)) {
      let target: string | null = null;
      try { target = resolveTypeDirectiveSpecifier(spec, fromUri); } catch { target = null; }
      if (!target || seen.has(target)) continue;
      seen.add(target);
      let text: string;
      try { text = fs.readFileSync(target, 'utf-8'); } catch { continue; }
      const targetWrapped = target.endsWith('.hm') ? wrapHmSource(text) : text;
      for (const name of buildAnnotationMap(targetWrapped).keys()) {
        if (name.includes('#')) names.add(name.split('#')[0]);
        else if (name.includes('.')) names.add(name.split('.')[0]);
        else if (/^[A-Z]/.test(name)) names.add(name);
      }
      if (target.endsWith('.hm')) {
        for (const name of parseHmTypeAliases(text).aliases.keys()) names.add(name);
      }
      for (const decl of extractDataDirectives(targetWrapped)) {
        names.add(decl.name);
        for (const v of decl.variants) names.add(v.name);
      }
      visit(pathToFileURL(target).href, targetWrapped);
    }
  };
  visit(uri, wrappedSource);
  return names;
}

function buildKnownNames(
  annotationMap: Map<string, TypeAnnotation>,
  typeAliases: Map<string, Type>,
  wrappedSource: string,
  ctx: HmServiceContext | undefined,
): Set<string> {
  const known = new Set<string>(BUILTIN_TYPE_NAMES);
  // DOM/Fetch nominal types (Element, Event, Response, …) — valid in
  // annotations when typed globals are on; Response always (fetch API).
  for (const name of activeDomAnnotationTypeNames()) known.add(name);

  // Local annotations — every uppercase non-method name + every method
  // receiver type.  This handles forward references within the same file.
  for (const name of annotationMap.keys()) {
    if (name.includes('#')) {
      known.add(name.split('#')[0]);
    } else if (name.includes('.')) {
      known.add(name.split('.')[0]);
    } else if (/^[A-Z]/.test(name)) {
      known.add(name);
    }
  }

  // Local type aliases.
  for (const name of typeAliases.keys()) known.add(name);

  // Local sumtype declarations (with their variants).
  for (const decl of extractDataDirectives(wrappedSource)) {
    known.add(decl.name);
    for (const v of decl.variants) known.add(v.name);
  }

  // Global registries.
  for (const name of getDataTypeNames()) known.add(name);
  for (const name of getVariantNames()) known.add(name);
  for (const name of getRegisteredTypeNames()) known.add(name);
  for (const name of getConstraintNames()) known.add(name);

  // Names declared in the project globals file, when available.
  if (ctx?.globals) {
    const wrapped = wrapHmSource(ctx.globals.source);
    for (const name of buildAnnotationMap(wrapped).keys()) {
      if (name.includes('#')) known.add(name.split('#')[0]);
      else if (name.includes('.')) known.add(name.split('.')[0]);
      else if (/^[A-Z]/.test(name)) known.add(name);
    }
    for (const decl of extractDataDirectives(wrapped)) {
      known.add(decl.name);
      for (const v of decl.variants) known.add(v.name);
    }
  }

  return known;
}

/**
 * Translate an annotation's diagnostic range from the wrapped buffer back
 * to the original `.hm` source.  Prefers the signature-name span (so only
 * the LHS name is underlined) and falls back to the comment range.
 */
function annotationDiagnosticRange(
  source: string,
  map: HmOffsetMap,
  ann: TypeAnnotation,
): Range {
  if (typeof ann.signatureNameStart === 'number' && typeof ann.signatureNameEnd === 'number') {
    return rangeFromOffsets(
      source,
      map.toOriginal(ann.signatureNameStart),
      map.toOriginal(ann.signatureNameEnd),
    );
  }
  return rangeFromOffsets(
    source,
    map.toOriginal(ann.commentStart),
    map.toOriginal(ann.commentEnd),
  );
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

/**
 * Context the server passes through to the .hm-aware feature handlers so
 * this module never has to re-import the whole `ImportInferenceContext`.
 */
export interface HmServiceContext {
  /** Resolve a type/constructor name to its raw signature(s) across the
   *  globals + sidecar chain.  Same chain used by the JS hover handler. */
  findTypeDefinitions(name: string): Array<{
    raw: string;
    origin: string;
    sourcePath: string | null;
    commentStart: number;
    commentEnd: number;
  }>;
  /** Globals source/uri context, used by `findTypeDefinitionLocation` for
   *  the cross-file definition fallback chain. */
  globals: { source: string; uri: string } | null;
}

/**
 * Build a hover for a position inside a `.hm` file.
 *
 * Classification by token at `offset`:
 *   - Inside the LHS name span of an annotation → render the user-written
 *     raw signature (preserves overloads and original formatting).
 *   - On an uppercase identifier elsewhere → resolve via the cross-file
 *     `findTypeDefinitions` chain and render the raw signature.
 *   - Otherwise → no hover.
 */
export function getHmHover(
  uri: string,
  source: string,
  offset: number,
  ctx: HmServiceContext,
): Hover | null {
  const parsed = parseHm(uri, source);

  // Word boundaries in the ORIGINAL source.
  const word = scanWordAt(source, offset);
  if (!word) return null;
  const name = source.slice(word.start, word.end);

  // 1) LHS name → render annotation signature (overload-aware).
  for (const ann of parsed.annotations) {
    if (ann.signatureNameStart === undefined || ann.signatureNameEnd === undefined) continue;
    if (!ann.name) continue;
    const startOrig = parsed.map.toOriginal(ann.signatureNameStart);
    const endOrig = parsed.map.toOriginal(ann.signatureNameEnd);
    if (offset >= startOrig && offset <= endOrig) {
      const raws = parseHmSourceRaw(source);
      const raw = raws.get(ann.name) ?? ann.raw;
      return {
        contents: { kind: 'markdown', value: '```hm\n' + ann.name + ' :: ' + raw + '\n```' },
        range: rangeFromOffsets(source, startOrig, endOrig),
      };
    }
  }

  // 2) Uppercase identifier elsewhere → cross-file definition lookup.
  if (/^[A-Z]/.test(name)) {
    const defs = ctx.findTypeDefinitions(name);
    if (defs.length > 0) {
      const lines: string[] = ['```hm'];
      for (const def of defs) {
        lines.push(name + ' :: ' + def.raw);
      }
      lines.push('```');
      if (defs.length > 1) {
        const origins = defs.map(d => '`' + d.origin + '`').join(', ');
        lines.push('', '_Defined in: ' + origins + '_');
      } else {
        lines.push('', '_Defined in: `' + defs[0].origin + '`_');
      }
      return {
        contents: { kind: 'markdown', value: lines.join('\n') },
        range: rangeFromOffsets(source, word.start, word.end),
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Go-to-definition
// ---------------------------------------------------------------------------

/**
 * Resolve go-to-definition for a position inside a `.hm` file.  Only
 * meaningful for uppercase identifiers (type constructors, sumtypes,
 * constraints) — these are resolved by walking the same cross-file chain
 * used by hover.  When the identifier resolves to multiple sources they
 * are all returned; the editor picks how to present them.
 */
export function getHmDefinition(
  uri: string,
  source: string,
  offset: number,
  ctx: HmServiceContext,
): Location | Location[] | null {
  const word = scanWordAt(source, offset);
  if (!word) return null;
  const name = source.slice(word.start, word.end);
  if (!/^[A-Z]/.test(name)) return null;

  const defs = ctx.findTypeDefinitions(name);
  // Drop self-locations: when the cursor is on a declaration that lives in
  // this very file, `findTypeDefinitions` will surface it again — returning
  // it would be a no-op jump that hides results from other files.
  const selfPath = (() => {
    try { return fileURLToPath(uri); } catch { return null; }
  })();
  const filtered = defs.filter(d => d.sourcePath !== selfPath);
  const useDefs = filtered.length > 0 ? filtered : defs;
  if (useDefs.length === 0) return null;

  const locations: Location[] = [];
  for (const def of useDefs) {
    if (!def.sourcePath) continue;
    let text: string;
    try { text = fs.readFileSync(def.sourcePath, 'utf-8'); }
    catch { continue; }
    locations.push(Location.create(pathToFileURL(def.sourcePath).href, {
      start: positionAt(text, def.commentStart),
      end: positionAt(text, def.commentEnd),
    }));
  }
  if (locations.length === 0) return null;
  return locations.length === 1 ? locations[0] : locations;
}

// ---------------------------------------------------------------------------
// Document symbols
// ---------------------------------------------------------------------------

/**
 * A flat list of every named annotation in the file.  Method annotations
 * (`Type#method`) are marked as Method; uppercase-named annotations as
 * Class; everything else as Variable.  Directives (no `name`) and parse
 * failures are skipped.
 */
export function getHmDocumentSymbols(uri: string, source: string): DocumentSymbol[] {
  const parsed = parseHm(uri, source);
  const symbols: DocumentSymbol[] = [];

  for (const ann of parsed.annotations) {
    if (!ann.name) continue;
    const cStart = parsed.map.toOriginal(ann.commentStart);
    const cEnd = parsed.map.toOriginal(ann.commentEnd);
    const range = rangeFromOffsets(source, cStart, cEnd);
    let selectionRange = range;
    if (ann.signatureNameStart !== undefined && ann.signatureNameEnd !== undefined) {
      const nStart = parsed.map.toOriginal(ann.signatureNameStart);
      const nEnd = parsed.map.toOriginal(ann.signatureNameEnd);
      selectionRange = rangeFromOffsets(source, nStart, nEnd);
    }
    const kind: SymbolKind = ann.name.includes('#')
      ? SymbolKind.Method
      : ann.name.includes('.')
      ? SymbolKind.Method
      : /^[A-Z]/.test(ann.name)
      ? SymbolKind.Class
      : SymbolKind.Variable;
    const detail = ann.raw ? ':: ' + ann.raw : undefined;
    symbols.push({
      name: ann.name,
      detail,
      kind,
      range,
      selectionRange,
    });
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rangeFromOffsets(source: string, start: number, end: number): Range {
  return { start: positionAt(source, start), end: positionAt(source, end) };
}

function scanWordAt(source: string, offset: number): { start: number; end: number } | null {
  const isWord = (ch: string): boolean => /[A-Za-z0-9_$#]/.test(ch);
  let start = offset;
  while (start > 0 && isWord(source[start - 1])) start--;
  let end = offset;
  while (end < source.length && isWord(source[end])) end++;
  if (start >= end) return null;
  // Strip a trailing or leading '#': we want either `Foo` or `Foo#bar`,
  // not bare `#`.
  let s = start;
  let e = end;
  while (s < e && source[s] === '#') s++;
  while (e > s && source[e - 1] === '#') e--;
  return s < e ? { start: s, end: e } : null;
}
