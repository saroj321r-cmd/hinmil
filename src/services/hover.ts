// ============================================================================
// Hover — build LSP Hover responses from inference results
//
// Plain language: the popup shown when the mouse rests on code.  This file
// finds which expression sits under the cursor, asks the inference result
// for its type, applies all solved placeholder answers, and renders a neat
// annotation-style string (plus documentation where available).  Much of the
// code deals with showing the *most helpful* form: parameter types live from
// the current call, constraint prefixes, curried signatures, etc.
// ============================================================================

import { Hover, Range, Position } from 'vscode-languageserver/node';
import { InferenceResult, ImportResolver, TypeDirectiveResolver } from '../infer';
import { TypeEnv, instantiate } from '../hm/env';
import { Substitution } from '../hm/substitution';
import {
  Type,
  typeToString,
  prettyTypeToString,
  prettyTypeToStringWithContext,
  buildVarDisplayNameMap,
  generateCurriedOverloads,
  flattenCurriedType,
  parseKvName,
  constraintBaseName,
  containsErrorType,
  canonicalizeDisplayVarsByName,
  T_TYPEREP,
  tCon,
  collectAllVarIds,
} from '../hm/types';
import { buildAnnotationMap, extractAnnotations, extractPreferDirectives, isLocalAnnotation } from '../commentParser';
import { getDataTypeDisplayString, getParentTypeName, getDataType } from '../registries/dataTypeRegistry';
import { lookupConstraint } from '../registries/constraintRegistry';
import { findHostSlots, findOverloadSlots, substTVar } from '../hm/typeUtils';
import { positionAt as positionAtFromFiles } from './files';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// JS keyword set — identifiers that should not produce hover
// ---------------------------------------------------------------------------

const jsKeywords = new Set([
  'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof',
  'new', 'return', 'switch', 'throw', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'class', 'const', 'enum', 'export', 'extends', 'import',
  'super', 'implements', 'interface', 'let', 'package', 'private',
  'protected', 'public', 'static', 'yield', 'async', 'await',
  'get', 'set', 'from', 'as', 'true', 'false', 'null', 'undefined',
]);

// ---------------------------------------------------------------------------
// Multi-line record wrapping
// ---------------------------------------------------------------------------

/**
 * Reflow a single-line type string so that long top-level records render
 * across multiple lines.  Records with delimiter-balanced field bodies
 * exceeding `maxLen` characters are broken at every top-level `,` inside
 * the outermost `{ ... }` block, preserving nested record formatting.
 *
 * Applied per-line to hover output so that wide tables (`Table { 15
 * columns }`) become readable in the popover without affecting types
 * that already fit on one line.
 */
export function wrapLongRecord(line: string, maxLen: number = 80, indent: string = ''): string {
  if (line.length <= maxLen) return line;
  // Find a balanced `{ ... }` block whose body has more than one
  // top-level comma-separated field and wrap it.  If the first
  // top-level `{ ... }` has only a single field (e.g. a one-key params
  // record like `{ applicationId :: Number }`), skip past it and try
  // the next one — otherwise we'd leave a long sibling record entirely
  // unwrapped.  Bracket kinds are still tracked to balance correctly.
  let searchFrom = 0;
  while (searchFrom < line.length) {
    let depth = 0;
    let braceStart = -1;
    let braceInnerDepth = 0;
    let braceEnd = -1;
    let body = '';
    for (let i = searchFrom; i < line.length; i++) {
      const ch = line[i];
      const isOpen = ch === '(' || ch === '[' || ch === '{';
      const isClose = ch === ')' || ch === ']' || ch === '}';
      if (braceStart < 0) {
        if (ch === '{') {
          braceStart = i;
          braceInnerDepth = 0;
          continue;
        }
        if (isOpen) depth++;
        else if (isClose) depth--;
        continue;
      }
      if (isOpen) braceInnerDepth++;
      else if (isClose) {
        if (braceInnerDepth === 0 && ch === '}') {
          braceEnd = i;
          body = line.slice(braceStart + 1, i).trim();
          break;
        }
        braceInnerDepth--;
      }
    }
    if (braceStart < 0 || braceEnd < 0) return line;
    // Split body at top-level commas
    const fields: string[] = [];
    let last = 0;
    let inner = 0;
    for (let j = 0; j < body.length; j++) {
      const c = body[j];
      if (c === '(' || c === '[' || c === '{') inner++;
      else if (c === ')' || c === ']' || c === '}') inner--;
      else if (c === ',' && inner === 0) {
        fields.push(body.slice(last, j).trim());
        last = j + 1;
      }
    }
    fields.push(body.slice(last).trim());
    if (fields.length <= 1) {
      // Skip this short record and look for a bigger one further along.
      searchFrom = braceEnd + 1;
      continue;
    }
    const before = line.slice(0, braceStart);
    const after = line.slice(braceEnd + 1);
    const inner2 = indent + '  ';
    const wrappedFields = fields.map(f => inner2 + wrapLongRecord(f, maxLen, inner2));
    return `${before}{\n${wrappedFields.join(',\n')}\n${indent}}${after}`;
  }
  return line;
}

/**
 * Apply `wrapLongRecord` to every line inside `\`\`\`hm` fenced blocks of
 * a markdown string.  Lines outside fenced blocks are kept verbatim so
 * documentation prose isn't reflowed.
 */
export function wrapHmBlocks(md: string): string {
  const lines = md.split('\n');
  let inHm = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith('```')) {
      inHm = ln.startsWith('```hm');
      continue;
    }
    if (inHm) lines[i] = wrapLongRecord(ln);
  }
  return lines.join('\n');
}

/** Re-wrap the markdown contents of a hover through `wrapHmBlocks`. */
export function reflowHover(h: Hover | null): Hover | null {
  if (!h || !h.contents) return h;
  const c: any = h.contents;
  if (typeof c === 'object' && c.kind === 'markdown' && typeof c.value === 'string') {
    return { ...h, contents: { kind: 'markdown' as const, value: wrapHmBlocks(c.value) } };
  }
  return h;
}

// ---------------------------------------------------------------------------
// Identifier extraction
// ---------------------------------------------------------------------------

/**
 * Scan the boundaries of an identifier-like word at `offset`.
 * Returns start/end indices, or null if no word at offset.
 */
export function scanWord(source: string, offset: number): { start: number; end: number } | null {
  let start = offset;
  while (start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1])) start--;
  // Include leading `@` / `@@` prefix (e.g. `@@type` record-field keys
  // appearing inside string literals or annotation comments). `@` is not
  // a valid JS identifier character elsewhere, so this is safe.
  if (start > 0 && source[start - 1] === '@') {
    start--;
    if (start > 0 && source[start - 1] === '@') start--;
  }
  let end = offset;
  while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end++;
  return start < end ? { start, end } : null;
}

/**
 * Extract the identifier name at a given offset in the source, including
 * dot-prefix for properties (e.g. `Box.map`).
 */
export function getIdentifierAt(source: string, offset: number): string | null {
  const word = scanWord(source, offset);
  if (!word) return null;
  let name = source.slice(word.start, word.end);
  // Check if preceded by '.' to include container name (e.g. Box.map)
  if (word.start > 0 && source[word.start - 1] === '.') {
    const obj = scanWord(source, word.start - 2);
    if (obj) {
      name = `${source.slice(obj.start, obj.end)}.${name}`;
    }
  }
  return name;
}

/**
 * Resolve the identifier at `offset` to a valid non-keyword name, or `null`.
 */
export function resolveValidIdent(source: string, offset: number): string | null {
  const identName = getIdentifierAt(source, offset);
  if (!identName) return null;
  // Property access (e.g. "M.of") — don't reject based on keyword
  if (identName.includes('.')) return identName;
  return jsKeywords.has(identName) ? null : identName;
}

// ---------------------------------------------------------------------------
// Prototype naming helpers
// ---------------------------------------------------------------------------

/**
 * Convert a `X$prototype$Y` JS identifier name to the annotation-style
 * `X#Y` form.  Returns `null` when the name doesn't match the convention.
 */
export function prototypeToHashName(name: string): string | null {
  const idx = name.indexOf('$prototype$');
  if (idx <= 0) return null;
  const typeName = name.slice(0, idx);
  const methodName = name.slice(idx + '$prototype$'.length);
  if (!typeName || !methodName) return null;
  return `${typeName}#${methodName}`;
}

/**
 * Lightweight structural compatibility check between an annotation's
 * declared method type and an inferred bestType.  Used to disambiguate
 * the bare-method-name fallback (see `buildHover`) so we don't pick up
 * an unrelated `Type#method` annotation that just happens to share a
 * method name with a locally inferred binding.
 *
 * The check is intentionally permissive: TVars on either side match
 * anything, but concrete TCon names at corresponding positions must
 * agree (so `[a] -> QueryTag b` won't match `Organisation -> RTask r e c`).
 * Function arity must also agree.
 */
function methodTypeMatchesShape(declared: Type, inferred: Type): boolean {
  if (declared.tag === 'TVar' || inferred.tag === 'TVar') return true;
  if (declared.tag === 'TFun' && inferred.tag === 'TFun') {
    return methodTypeMatchesShape(declared.param, inferred.param)
        && methodTypeMatchesShape(declared.result, inferred.result);
  }
  if (declared.tag === 'TCon' && inferred.tag === 'TCon') {
    if (declared.name !== inferred.name) return false;
    const da = declared.args ?? [];
    const ia = inferred.args ?? [];
    if (da.length !== ia.length) return false;
    for (let i = 0; i < da.length; i++) {
      if (!methodTypeMatchesShape(da[i], ia[i])) return false;
    }
    return true;
  }
  if (declared.tag === 'TRecord' && inferred.tag === 'TRecord') return true;
  // Mismatched tags (e.g. TFun vs TCon) — treat as incompatible.
  return declared.tag === inferred.tag;
}

// ---------------------------------------------------------------------------
// Constraint info collection
// ---------------------------------------------------------------------------

/**
 * Collect constraint annotations for kind variables found in a type.
 * Returns strings like `"Functor f"` for display in hover.
 *
 * When `substitution` is supplied, a TVar whose own id carries no
 * `kvConstraints` entry is resolved through the substitution chain to its
 * representative variable, and constraints registered under that
 * representative are used instead.  This matters when a parameter's raw type
 * var (the id recorded on its AST node) was unified with a constrained var
 * during inference: the constraint is keyed under the representative id, not
 * the raw node id.  Following only this variable's own binding never
 * introduces a foreign constraint — a bound var and its representative are the
 * same variable.
 */
export function collectConstraintInfo(
  t: Type,
  kvConstraints: Map<number, string[]>,
  kvConstructorConstraints?: Map<number, string[]>,
  substitution?: Substitution,
  varNames?: Map<number, string>,
): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  collectKvIds(t, kvConstraints, kvConstructorConstraints, seen, results, substitution, varNames);
  return results;
}

/**
 * Resolve a type variable id to the id of its representative variable by
 * chasing var→var links in the substitution.  Returns the input id when there
 * is no substitution, no binding, or the binding resolves to a non-variable.
 */
function resolveVarId(id: number, substitution: Substitution | undefined): number {
  if (!substitution) return id;
  let current = id;
  const seen = new Set<number>();
  for (;;) {
    if (seen.has(current)) return id;
    seen.add(current);
    const bound = substitution.lookup(current);
    if (!bound || bound.tag !== 'TVar' || bound.id === current) return current;
    current = bound.id;
  }
}

/**
 * Build the seed "context" type whose variable order drives display-letter
 * assignment for a hover.
 *
 * The tightest arrow/function-expression node that STRICTLY encloses the
 * hovered node establishes the scope.  Its own type is seeded first (so a
 * parameter and its uses share a letter), then every recorded node inside the
 * scope span is appended in SOURCE order.
 *
 * Seeding is GATED BY VARIABLE SHARING: a context component (the enclosing
 * function signature or a sibling node) is included only when it genuinely
 * shares a type variable with the hovered type.  Without this gate an
 * unrelated sibling binding (e.g. `const other = Just (0)` next to
 * `const laws = monoidLaws (Maybe)`) would consume the letter `a` and bump the
 * hovered type's own sole variable to `b` (`TypeRep (Maybe b) -> …`).  Sharing
 * keeps the useful alignment — a parameter `a -> b` still pins its result var
 * `b` when hovering `result` — while letting a self-contained hovered type
 * start its lettering at `a`.
 *
 * Returns `null` when no enclosing function scope is found OR no context
 * component shares a variable with the hovered type (the caller then falls
 * back to standalone per-node lettering).
 */
export function buildScopeSeedType(
  result: Pick<InferenceResult, 'nodeTypes' | 'functionNodeTypes'>,
  substitution: Substitution,
  bestStart: number,
  bestEnd: number,
): Type | null {
  let scopeType: Type | null = null;
  let scopeStart = -1;
  let scopeEnd = -1;
  let bestSpan = Infinity;
  for (const [start, { type, end }] of result.functionNodeTypes) {
    if (start <= bestStart && end >= bestEnd && (start < bestStart || end > bestEnd)) {
      const span = end - start;
      if (span < bestSpan) {
        bestSpan = span;
        scopeStart = start;
        scopeEnd = end;
        scopeType = substitution.apply(type);
      }
    }
  }
  if (!scopeType) return null;

  // The hovered type itself — its variables decide which context is relevant.
  let hoveredType: Type | null = null;
  for (const [start, { type, end }] of result.nodeTypes) {
    if (start === bestStart && end === bestEnd) {
      hoveredType = substitution.apply(type);
      break;
    }
  }
  const hoveredVars = hoveredType ? collectAllVarIds(hoveredType) : null;
  const sharesHovered = (t: Type): boolean => {
    if (!hoveredVars) return true; // no hovered type found: fall back to old behavior
    if (hoveredVars.size === 0) return false;
    for (const id of collectAllVarIds(t)) {
      if (hoveredVars.has(id)) return true;
    }
    return false;
  };

  const inScope: Array<{ start: number; end: number; type: Type }> = [];
  for (const [start, { type, end }] of result.nodeTypes) {
    if (start >= scopeStart && end <= scopeEnd) {
      const applied = substitution.apply(type);
      if (sharesHovered(applied)) inScope.push({ start, end, type: applied });
    }
  }
  // Source order; on ties the wider span first so an enclosing expression's
  // variables are seeded before the narrower children it contains.
  inScope.sort((a, b) => a.start - b.start || b.end - a.end);

  const components: Type[] = [];
  if (sharesHovered(scopeType)) components.push(scopeType);
  components.push(...inScope.map(e => e.type));
  if (components.length === 0) return null;
  return tCon('$scope', components);
}

function collectKvIds(
  t: Type,
  kvConstraints: Map<number, string[]>,
  kvConstructorConstraints: Map<number, string[]> | undefined,
  seen: Set<string>,
  results: string[],
  substitution?: Substitution,
  varNames?: Map<number, string>,
): void {
  switch (t.tag) {
    case 'TVar': {
      // Plain TVar with kvConstraints (e.g. M :: m with Monad constraint).
      // Fall back to the representative var id when the raw id has none: the
      // AST node's var may have been unified with a constrained var whose
      // constraint is keyed under the representative id.
      let cNames = kvConstraints.get(t.id);
      let repId = t.id;
      if (!cNames) {
        const resolved = resolveVarId(t.id, substitution);
        if (resolved !== t.id) {
          const rc = kvConstraints.get(resolved);
          if (rc) { cNames = rc; repId = resolved; }
        }
      }
      if (cNames) {
        // Label with the SAME letter the type body shows for this variable
        // (the pretty-printer renames auto-generated ids like `t144` to `a`);
        // fall back to the raw name when no display map is available.
        const displayName = varNames?.get(repId) ?? varNames?.get(t.id) ?? t.name;
        for (const cName of cNames) {
          // Applied constraints stored as "Monoid (f a)" — use as-is
          const key = cName.includes('(') ? cName : `${cName} ${displayName}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push(key);
          }
        }
      }
      break;
    }
    case 'TCon': {
      const kv = parseKvName(t.name);
      if (kv) {
        // Label the constraint with the SAME letter the type body shows for
        // this kind variable (the pretty-printer renames auto-generated ids
        // like `$kv:c:144` to a display letter such as `b`); fall back to the
        // raw annotation name when no display map is available.  Without this,
        // a higher-kinded constraint like `Category c => c a a` would render
        // its prefix with the raw `c` while the body shows `b` (`Category c =>
        // b d d`), leaving the constraint variable disconnected from the body.
        const displayName = varNames?.get(kv.varId) ?? kv.varName;
        const cNames = kvConstraints.get(kv.varId);
        if (cNames) {
          for (const cName of cNames) {
            const key = `${cName} ${displayName}`;
            if (!seen.has(key)) {
              seen.add(key);
              results.push(key);
            }
          }
        }
        // For applied kind * constraints (e.g. Semigroup (s a)), the constraint
        // is in kvConstructorConstraints. Include for hover display.
        if (kvConstructorConstraints) {
          const ctorCNames = kvConstructorConstraints.get(kv.varId);
          if (ctorCNames) {
            for (const cName of ctorCNames) {
              const baseName = constraintBaseName(cName);
              const def = lookupConstraint(baseName);
              if (def?.expectedKind === '*') {
                const key = `${cName} (${displayName} ${t.args.map(a => prettyTypeToString(a)).join(' ')})`;
                if (!seen.has(key)) {
                  seen.add(key);
                  results.push(key);
                }
              }
            }
          }
        }
      }
      t.args.forEach(a => collectKvIds(a, kvConstraints, kvConstructorConstraints, seen, results, substitution, varNames));
      break;
    }
    case 'TFun':
      collectKvIds(t.param, kvConstraints, kvConstructorConstraints, seen, results, substitution, varNames);
      collectKvIds(t.result, kvConstraints, kvConstructorConstraints, seen, results, substitution, varNames);
      break;
    case 'TRecord':
      Object.values(t.fields).forEach(f => collectKvIds(f, kvConstraints, kvConstructorConstraints, seen, results, substitution, varNames));
      break;
  }
}

// ---------------------------------------------------------------------------
// Per-field record constraint formatting
// ---------------------------------------------------------------------------

/**
 * Format a TRecord type with constraints displayed per-field rather than
 * hoisted to the top level.  Each field gets its own constraint prefix and
 * its type variables are pretty-printed independently.
 */
export function formatRecordWithFieldConstraints(
  bestType: Type & { tag: 'TRecord' },
  rawType: Type,
  kvConstraints: Map<number, string[]>,
  kvConstructorConstraints: Map<number, string[]> | undefined,
  formatType: (t: Type) => string,
): string {
  const entries = Object.entries(bestType.fields);
  if (entries.length === 0) return '{}';

  const rawFields = rawType.tag === 'TRecord' ? rawType.fields : bestType.fields;

  const fieldStrs = entries.map(([k, v]) => {
    const rawField = rawFields[k] ?? v;
    const fieldConstraints = collectConstraintInfo(rawField, kvConstraints, kvConstructorConstraints);
    const constraintPrefix = fieldConstraints.length > 0
      ? (fieldConstraints.length === 1
          ? `${fieldConstraints[0]} => `
          : `(${fieldConstraints.join(', ')}) => `)
      : '';
    const typeStr = formatType(v);
    return `${k} :: ${constraintPrefix}${typeStr}`;
  });

  return `{ ${fieldStrs.join(', ')} }`;
}

// ---------------------------------------------------------------------------
// Array literal method detection
// ---------------------------------------------------------------------------

/**
 * Check whether the cursor is on an identifier preceded by `].`
 * (i.e. likely a method call on an array literal like `[1, 2].map`).
 */
export function validIdentLooksLikeArrayMethod(source: string, offset: number): boolean {
  const word = scanWord(source, offset);
  const idStart = word?.start ?? offset;
  if (idStart <= 0 || source[idStart - 1] !== '.') return false;
  const dotPos = idStart - 1;
  if (dotPos <= 0 || source[dotPos - 1] !== ']') return false;
  return true;
}

/**
 * Re-infer with ASI fix for hover on `[...].method`.
 * Returns the new best type and result, or null.
 */
export function tryArrayLiteralReinfer(
  source: string,
  offset: number,
  resolver: ImportResolver,
  typeResolver: TypeDirectiveResolver,
  engine: { infer: (s: string, e?: TypeEnv, r?: ImportResolver, t?: TypeDirectiveResolver) => InferenceResult },
  reinferWithArrayASI: (source: string, closeBracketIdx: number, resolver: ImportResolver, typeResolver: TypeDirectiveResolver) => { result: InferenceResult; shift: number; patched: string } | null,
): { result: InferenceResult; bestType: Type; bestStart: number; shift: number } | null {
  // Walk backwards: identifier → '.' → ']'
  const word = scanWord(source, offset);
  const idStart = word?.start ?? offset;
  const closeBracket = idStart - 2; // skip '.' at idStart-1

  const fix = reinferWithArrayASI(source, closeBracket, resolver, typeResolver);
  if (!fix) return null;

  // Find best type at shifted offset
  let bestType2: Type | null = null;
  let bestStart2 = -1;
  const shiftedOffset = offset + fix.shift;
  for (const [start, { type, end }] of fix.result.nodeTypes) {
    if (start <= shiftedOffset && shiftedOffset < end && start > bestStart2) {
      bestType2 = fix.result.substitution.apply(type);
      bestStart2 = start;
    }
  }
  if (bestType2 && bestType2.tag !== 'TVar') {
    return { result: fix.result, bestType: bestType2, bestStart: bestStart2 - fix.shift, shift: fix.shift };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Built-in type names
// ---------------------------------------------------------------------------

const builtInTypes = new Map<string, string>([
  ['Number',  'Type'],
  ['String',  'Type'],
  ['Boolean', 'Type'],
  ['Null',    'Type'],
  ['Undefined','Type'],
  ['Void',    'Type'],
  ['Array',   'Type'],
  ['Object',  'Type'],
  ['Promise', 'Type'],
  ['RegExp',  'Type'],
  ['Date',    'Type'],
  ['Error',   'Type'],
  ['Map',     'Type'],
  ['Set',     'Type'],
  ['Symbol',  'Type'],
  ['BigInt',  'Type'],
  ['Any',     'Type'],
  ['StrMap',  'Type'],
  ['Buffer',  'Type'],
  ['Process', 'Type'],
  // Typed-array views + binary buffers.
  ['Int8Array',        'Type'],
  ['Uint8Array',       'Type'],
  ['Uint8ClampedArray','Type'],
  ['Int16Array',       'Type'],
  ['Uint16Array',      'Type'],
  ['Int32Array',       'Type'],
  ['Uint32Array',      'Type'],
  ['Float32Array',     'Type'],
  ['Float64Array',     'Type'],
  ['BigInt64Array',    'Type'],
  ['BigUint64Array',   'Type'],
  ['ArrayBuffer',      'Type'],
  ['DataView',         'Type'],
  ['Integer', 'Type'],
  ['Float',   'Type'],
  ['Double',  'Type'],
  ['NonNegativeInteger', 'Type'],
  ['NegativeInteger',    'Type'],
  ['PositiveNumber',     'Type'],
  ['NegativeNumber',     'Type'],
  ['ValidNumber',        'Type'],
  ['NonZeroValidNumber', 'Type'],
  ['FiniteNumber',       'Type'],
  ['NonZeroFiniteNumber','Type'],
  ['PositiveFiniteNumber','Type'],
  ['NegativeFiniteNumber','Type'],
  ['NonZeroInteger',     'Type'],
  ['PositiveInteger',    'Type'],
]);

// ---------------------------------------------------------------------------
// Alias hover (type alias / constructor hover in annotation comments)
// ---------------------------------------------------------------------------

/** Get the word (identifier) at a given offset. */
export function getWordAt(source: string, offset: number): string | null {
  const word = scanWord(source, offset);
  return word ? source.slice(word.start, word.end) : null;
}

/** Check if an offset falls inside any annotation comment (named annotations only). */
export function isOffsetInAnnotation(annotations: Map<string, { commentStart: number; commentEnd: number }>, offset: number): boolean {
  for (const [, ann] of annotations) {
    if (offset >= ann.commentStart && offset <= ann.commentEnd) return true;
  }
  return false;
}

/**
 * Check if an offset falls inside any annotation comment, including anonymous
 * annotations (inline annotations without a name, stored only by offset).
 */
export function isOffsetInAnyAnnotation(
  annotations: Map<string, { commentStart: number; commentEnd: number }>,
  annotationsByOffset: Map<number, { commentStart: number; commentEnd: number }>,
  offset: number,
): boolean {
  if (isOffsetInAnnotation(annotations, offset)) return true;
  for (const [, ann] of annotationsByOffset) {
    if (offset >= ann.commentStart && offset <= ann.commentEnd) return true;
  }
  return false;
}

/**
 * Check if an offset is inside a line comment (`// ...`) or block comment in
 * the source text.  This is a source-level check that doesn't depend on
 * annotation maps and also works for anonymous annotation comments.
 */
export function isOffsetInComment(source: string, offset: number): boolean {
  // Find the start of the current line
  let lineStart = offset;
  while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;

  // Check for `//` line comment on this line before the offset
  const linePrefix = source.slice(lineStart, offset);
  const slashSlash = linePrefix.indexOf('//');
  if (slashSlash >= 0) return true;

  // Check for block comment: scan backwards for `/*` without a closing `*/`
  let i = offset - 1;
  while (i >= 1) {
    if (source[i] === '/' && source[i - 1] === '*') return false; // exited block comment before offset
    if (source[i] === '*' && source[i - 1] === '/') return true;  // inside block comment
    i--;
  }
  return false;
}

/**
 * Check if the cursor offset falls inside a `// ::narrow <Type>` directive comment.
 * If so, returns the type name referenced. Otherwise returns null.
 */
export function getNarrowDirectiveTypeAtOffset(source: string, offset: number): string | null {
  // Match all `// ::narrow <Type>` directives
  const re = /\/\/\s*::narrow\s+(\S+)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length;
    if (offset >= matchStart && offset <= matchEnd) {
      return m[1].trim();
    }
  }
  return null;
}

/**
 * Check if the cursor offset falls inside a `// ::constraint <Name> ...` directive.
 * Returns true when the offset is within such a comment.
 */
export function isOffsetInConstraintDirective(source: string, offset: number): boolean {
  const re = /\/\/\s*::constraint\s+.+/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (offset >= m.index && offset <= m.index + m[0].length) return true;
  }
  return false;
}

/**
 * Check if the cursor is on a type alias name inside a comment annotation
 * and return a hover with the alias definition.
 */
export function getAliasHoverAtOffset(
  source: string,
  offset: number,
  result: InferenceResult,
  fromUri: string,
  resolveImportSpecifier: (specifier: string, fromUri: string) => string | null,
  extractImportSpecifiers: (source: string) => Map<string, string>,
  findTypeDefinitions?: (name: string) => Array<{ raw: string; origin: string; sourcePath: string | null; commentStart: number; commentEnd: number }>,
): Hover | null {
  const word = getWordAt(source, offset);
  if (!word || !/^[A-Z]/.test(word)) return null;

  // Verify the cursor is actually inside a comment annotation
  // (check named annotations, offset-keyed annotations, or source-level comment detection)
  if (!isOffsetInAnyAnnotation(result.annotations, result.annotationsByOffset, offset)
      && !isOffsetInComment(source, offset)) return null;

  // Check type aliases first
  const alias = result.typeAliases.get(word);
  if (alias) {
    const typeStr = prettyTypeToString(alias.type);
    return {
      contents: {
        kind: 'markdown',
        value: `\`\`\`hm\ntype ${word} :: ${typeStr}\n\`\`\``,
      },
    };
  }

  // Check sumtype sum type declarations
  const dataDisplay = getDataTypeDisplayString(word);
  if (dataDisplay) {
    // Suppress hover when cursor is inside the very comment that declares this type
    const dt = getDataType(word);
    if (dt && offset >= dt.decl.commentStart && offset <= dt.decl.commentEnd) return null;
    return {
      contents: {
        kind: 'markdown',
        value: `\`\`\`hm\n${dataDisplay}\n\`\`\``,
      },
    };
  }

  // Check if this is a variant name — show the parent sumtype declaration
  const parentName = getParentTypeName(word);
  if (parentName) {
    // Suppress hover when cursor is inside the declaration comment of the parent type
    const dt = getDataType(parentName);
    if (dt && offset >= dt.decl.commentStart && offset <= dt.decl.commentEnd) return null;
    const parentDisplay = getDataTypeDisplayString(parentName);
    if (parentDisplay) {
      return {
        contents: {
          kind: 'markdown',
          value: `\`\`\`hm\n${parentDisplay}\n\`\`\``,
        },
      };
    }
  }

  // Check constructor annotations in current file
  const ann = result.annotations.get(word);
  if (ann?.scheme) {
    return {
      contents: {
        kind: 'markdown',
        value: `\`\`\`hm\n${word} :: ${ann.raw}\n\`\`\``,
      },
    };
  }

  // Check constraint definitions (e.g. Functor, Chain)
  const constraintHover = buildConstraintHover(word);
  if (constraintHover) return constraintHover;

  // Check imported files for constructor annotations
  const imports = extractImportSpecifiers(source);
  const specifier = imports.get(word);
  if (specifier) {
    const targetUri = resolveImportSpecifier(specifier, fromUri);
    if (targetUri) {
      try {
        const targetPath = fileURLToPath(targetUri);
        const targetSource = fs.readFileSync(targetPath, 'utf-8');
        const targetAnns = buildAnnotationMap(targetSource);
        const targetAnn = targetAnns.get(word);
        if (targetAnn) {
          return {
            contents: {
              kind: 'markdown',
              value: `\`\`\`hm\n${word} :: ${targetAnn.raw}\n\`\`\``,
            },
          };
        }
      } catch {
        // file not readable
      }
    }
  }

  // `TypeRep` is special: show the "type representative" explanation rather
  // than a bare `:: Type` line.  Try to recover the inner type constructor
  // (`TypeRep f`) from the source immediately after the hovered token.
  if (word === 'TypeRep') {
    let inner = 'f';
    const idx = source.indexOf('TypeRep', Math.max(0, offset - 'TypeRep'.length));
    if (idx !== -1) {
      const after = source.slice(idx + 'TypeRep'.length);
      const m = /^\s+([A-Za-z][\w']*)/.exec(after);
      if (m) inner = m[1];
    }
    return {
      contents: {
        kind: 'markdown',
        value:
          `**Type representative** for \`${inner}\`  \n` +
          `A witness for the type constructor \`${inner}\`. Pass it to a polymorphic ` +
          `function (e.g. an \`Applicative\`/\`Monoid\` \`of\`/\`empty\`) to select which ` +
          `instance to use; static constructor methods are accessed through it.`,
      },
    };
  }

  // Show info for built-in types (Number, String, Boolean, etc.)
  const builtInDesc = builtInTypes.get(word);
  if (builtInDesc) {
    return {
      contents: {
        kind: 'markdown',
        value: `\`\`\`hm\n${word} :: ${builtInDesc}\n\`\`\``,
      },
    };
  }

  // Final fallback: search project globals + imported sidecars for a
  // definition.  This surfaces uppercase names (e.g. `Prop` from query-builder)
  // that are visible to inference but not present in `result.annotations`
  // because they live in a sidecar/override loaded only via the import
  // resolver.  When multiple definitions exist, honour any
  // `// ::prefer Name from <specifier>` directive in the current file.
  if (findTypeDefinitions) {
    const defs = findTypeDefinitions(word);
    if (defs.length > 0) {
      const prefer = extractPreferDirectives(source).get(word);
      const matchesPrefer = (origin: string): boolean => {
        if (!prefer) return false;
        if (origin === prefer) return true;
        // Tolerant match: prefer 'query-builder' should match origin 'query-builder (override)' etc.
        return origin.startsWith(prefer + ' ') || origin === `<${prefer}>`;
      };
      const preferred = prefer ? defs.find(d => matchesPrefer(d.origin)) : null;
      const primary = preferred ?? defs[0];
      const lines: string[] = [`\`\`\`hm\n${word} :: ${primary.raw}\n\`\`\``];
      const others = defs.filter(d => d !== primary);
      if (others.length > 0) {
        const list = others.map(d => `- \`${word} :: ${d.raw}\` *(from ${d.origin})*`).join('\n');
        const tip = prefer
          ? `_(active preference: \`::prefer ${word} from ${prefer}\`)_`
          : `_Multiple definitions found. Add \`// ::prefer ${word} from <source>\` to choose one._`;
        lines.push(`**Also defined as:**\n${list}\n\n${tip}`);
      } else {
        lines.push(`*from ${primary.origin}*`);
      }
      return {
        contents: { kind: 'markdown', value: lines.join('\n\n') },
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Constraint hover helper
// ---------------------------------------------------------------------------

/**
 * Build a hover for a constraint name (e.g. `Functor`, `Chain`).
 * Shows the constraint definition including required methods.
 */
export function buildConstraintHover(name: string): Hover | null {
  const def = lookupConstraint(name);
  if (!def) return null;

  const display = formatConstraintDirective(def);
  const link = formatConstraintDefinitionLink(def);
  const lines = [`\`\`\`hm\n${display}\n\`\`\``];
  if (link) lines.push(link);

  return {
    contents: {
      kind: 'markdown',
      value: lines.join('\n\n'),
    },
  };
}

/**
 * Render a `ConstraintDef` back into its `::constraint Name … { … }` form
 * for hover display.  Prefers the original `bodyText` when available so
 * the user's whitespace and formatting are preserved; falls back to a
 * synthesised body built from `methods` (nominal classes).
 */
function formatConstraintDirective(def: import('../registries/constraintRegistry').ConstraintDef): string {
  const header = (def.headerParams && def.headerParams.length > 0)
    ? `${def.name} ${def.headerParams.join(' ')}`
    : `${def.name} ${def.typeVar}`;
  const body = def.bodyText && def.bodyText.length > 0
    ? def.bodyText
    : def.methods.map(m => `${m.name} :: ${m.signature}`).join(', ');
  return `::constraint ${header} { ${body} }`;
}

/**
 * Build a markdown link pointing at the originating `::constraint`
 * directive.  Returns `null` when the def carries no source location, the
 * URI is not a `file://` URI, or the file can no longer be read.
 *
 * Format: `_defined in [query-builder.hm:42](file:///…/query-builder.hm#L42)_`
 */
function formatConstraintDefinitionLink(
  def: import('../registries/constraintRegistry').ConstraintDef,
): string | null {
  const uri = def.uri;
  const start = def.commentStart;
  if (!uri || start === undefined) return null;
  if (!uri.startsWith('file://')) return null;
  let line = 1;
  try {
    const filePath = fileURLToPath(uri);
    const src = fs.readFileSync(filePath, 'utf-8');
    line = positionAtFromFiles(src, start).line + 1;
  } catch {
    // Fall back to no line anchor.
  }
  // Derive a friendly basename for the link text.
  const slash = uri.lastIndexOf('/');
  const base = slash >= 0 ? uri.slice(slash + 1) : uri;
  return `_defined in [${base}:${line}](${uri}#L${line})_`;
}

/**
 * Build a multi-line markdown block summarising every constraint named
 * in `constraintInfo` (as collected by {@link collectConstraintInfo}).
 * Each constraint is rendered with its full directive body and, when
 * available, a clickable link to the source `::constraint` declaration.
 *
 * Returns `null` when none of the named constraints resolve to a known
 * `ConstraintDef`, so callers can simply skip appending an empty section.
 */
export function formatConstraintInfoSection(constraintInfo: string[]): string | null {
  if (constraintInfo.length === 0) return null;
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const entry of constraintInfo) {
    // entry is like "Source s" or "Monoid (f a)" — first token is the name.
    const m = /^([A-Z]\w*)/.exec(entry);
    if (!m) continue;
    const cname = m[1];
    if (seen.has(cname)) continue;
    seen.add(cname);
    const def = lookupConstraint(cname);
    if (!def) continue;
    const directive = formatConstraintDirective(def);
    const link = formatConstraintDefinitionLink(def);
    blocks.push(`\`\`\`hm\n${directive}\n\`\`\`` + (link ? `\n\n${link}` : ''));
  }
  if (blocks.length === 0) return null;
  return `**Constraints**\n\n${blocks.join('\n\n')}`;
}

/**
 * Pull the constraint *header* tokens out of a raw `::` signature string
 * — i.e. everything left of the first `=>` arrow.  A header like
 * `(Source s, Monoid (f a))` yields `["Source s", "Monoid (f a)"]`; a
 * single header like `Source s` yields `["Source s"]`; a signature with
 * no header yields `[]`.
 *
 * We only need the constraint *names* to drive
 * {@link formatConstraintInfoSection}, but returning the same shape as
 * {@link collectConstraintInfo} keeps the call sites uniform.
 */
export function extractConstraintNamesFromRaw(raw: string): string[] {
  // Find the first `=>` that is not enclosed in parentheses (so we don't
  // confuse a record-arrow inside a parameter type with the constraint
  // arrow).  Tracking parens is enough — `=>` cannot appear inside a
  // record literal, and we strip anything to the right anyway.
  let depth = 0;
  let arrowAt = -1;
  for (let i = 0; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '=' && raw[i + 1] === '>') { arrowAt = i; break; }
  }
  if (arrowAt < 0) return [];
  let header = raw.slice(0, arrowAt).trim();
  // Strip the outer parens of a `(C1, C2)` group.
  if (header.startsWith('(') && header.endsWith(')')) {
    header = header.slice(1, -1).trim();
  }
  if (!header) return [];
  // Split on top-level commas.
  const out: string[] = [];
  let buf = '';
  depth = 0;
  for (const c of header) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = '';
    } else {
      buf += c;
    }
  }
  const last = buf.trim();
  if (last) out.push(last);
  return out;
}

// ---------------------------------------------------------------------------
// Core hover response builder
// ---------------------------------------------------------------------------

/**
 * When the inferred type is an uppercase TCon (e.g. `QueryTag b`), gather any
 * callable overloads declared for that constructor name — either via a
 * local annotation or via the `importedConstructors` map populated from
 * sidecars / project overrides.  Returns an array of `Name :: ...` lines
 * (one per TFun branch) ready to be wrapped in a fenced `hm` block, or an
 * empty array when no callable overloads exist.
 */
function collectConstructorCallableOverloads(
  bestType: Type,
  result: InferenceResult,
  formatType: (t: Type) => string,
  displayName: string,
): string[] {
  if (bestType.tag !== 'TCon') return [];
  if (!/^[A-Z]/.test(bestType.name)) return [];
  const tconName = bestType.name;
  // Instance-callable annotations (`Name() :: T`) are the ONLY way to
  // describe how a value of an uppercase TCon is invoked.  The bare
  // constructor scheme (`Name :: ...`) describes how to construct a
  // `Name`, never how to call one — so it is intentionally not
  // surfaced here as an overload of an instance.
  const callables = result.instanceCallables?.get(tconName);
  if (!callables || callables.length === 0) return [];
  const branches: Type[] = callables.map(s => s.type);
  if (branches.length === 0) return [];
  // Render each callable overload under the binding's own name (e.g.
  // `readRandomOrganisations :: a -> RTask r e [b]`) rather than the
  // constructor name — at the call site the user thinks of the value
  // they're invoking, not of the type behind it.  When the binding name
  // and the constructor name coincide (`Organisation`) they are the same
  // anyway, so this is purely a clarity win.
  //
  // For container-shaped constructors (whose overload returns a wrapper
  // around `[carrier]` — e.g. `Promise [b]`, `RTask r e [b]`), specialise
  // the carrier TVar in the result with the host's row arg.  This turns
  // `QueryTag {projected} :: a -> RTask r e [b]` (uninformative `b`) into
  // `QueryTag {projected} :: a -> RTask r e [{projected}]`, mirroring what
  // an actual call site would produce.  When the host is a multi-arg
  // container (`QueryTag p row`), also substitute the parameter TVar in
  // the overload's parameter slot with the host's parameter arg, so
  // `p -> RTask r e [{projected}]` reflects both pieces of information.
  // No-op when the host has no row arg or no carrier-shaped TVar exists.
  const slots = findHostSlots(bestType);
  // Display-only fallback: if the host TCon's declared arity has no
  // parameter slot but a `paramHint` was attached during call-site
  // post-processing (see `bindParamSlot` in `src/infer/calls.ts`), use
  // it as the parameter substitution so the second overload still
  // shows the user's actual params record.
  const paramArg = slots.paramArg ?? bestType.paramHint ?? null;
  const specialise = (branch: Type): Type => {
    if (branch.tag !== 'TFun') return branch;
    let out: Type = branch;
    const { paramTVarId, carrierTVarId } = findOverloadSlots(out);
    if (slots.rowArg && carrierTVarId !== null) {
      out = substTVar(out, carrierTVarId, slots.rowArg);
    }
    if (paramArg && paramTVarId !== null) {
      out = substTVar(out, paramTVarId, paramArg);
    }
    return out;
  };
  return branches.map(branch => `${displayName} :: ${formatType(specialise(branch))}`);
}

/**
 * Declaration-site display type selection (shared with the server's onHover).
 *
 * At the declaration of a polymorphic top-level binding, hover should show the
 * binding's GENERIC scheme (freshly instantiated + display-var canonicalised)
 * rather than the live substitution-applied node type, which a downstream call
 * site may have specialized.
 *
 * Crucially, only `bestType` (the rendered type) is replaced.  `rawBestType`
 * is the CONSTRAINT SOURCE: `kvConstraints` entries are keyed under the raw
 * node type's var ids, and a freshly instantiated generic has brand-new ids
 * with no constraint entries.  Overwriting `rawBestType` with the generic
 * silently dropped constraint prefixes (FP-library `altLaws :: (Alt f, Setoid (f a),
 * Functor f) => () -> { … }` rendered without its constraints).
 */
export function applyDeclaredSchemeDisplay(
  result: InferenceResult,
  bestStart: number,
  bestType: Type | null,
  rawBestType: Type | null,
): { bestType: Type | null; rawBestType: Type | null } {
  if (bestStart >= 0 && result.declaredSchemes?.has(bestStart)) {
    // Collapse distinct-but-same-named display vars (ordinary AND higher-kinded
    // `$kv:f:id`) onto one id so a repeated kind-variable across overload
    // branches (e.g. `f a | (a -> f a)`) renders with the same letter in every
    // branch instead of re-lettering the second to `b` (`… | b a`).
    const generic = canonicalizeDisplayVarsByName(instantiate(result.declaredSchemes.get(bestStart)!));
    return { bestType: generic, rawBestType };
  }
  return { bestType, rawBestType };
}

export interface HoverContext {
  /** The original (unpatched) source code. */
  source: string;
  /** The cursor offset in the original source. */
  offset: number;
  /** Inference result (from the normalised/patched source). */
  result: InferenceResult;
  /** Best-matching type at the cursor position (after substitution). */
  bestType: Type | null;
  /** Raw (unsubstituted) type — used for constraint lookup so kv varIds
   *  match the ids under which constraints were originally registered. */
  rawBestType?: Type | null;
  /** Start offset of the best-matching node. */
  bestStart: number;
  /** Optional: the type of the smallest function enclosing the cursor.  When
   *  present, inferred-type rendering seeds its variable letters from this so
   *  a variable shared with the enclosing scope (e.g. `f :: a -> b` and its
   *  `result`) renders with the SAME letter everywhere in the body. */
  scopeType?: Type | null;
  /** Shift introduced by array-literal ASI re-inference (0 if none). */
  arrayShift: number;
  /** Type formatting style preference. */
  inferredTypeStyle: 'pretty' | 'raw';
  /** File URI — passed through to alias hover lookups. */
  uri: string;
  /** Resolver callbacks (supplied by the server). */
  resolveImportSpecifier: (specifier: string, fromUri: string) => string | null;
  extractImportSpecifiers: (source: string) => Map<string, string>;
  /** Optional: look up the verbatim raw signature text for an imported binding
   *  (for `.hm` sidecar / project override files). Returns null if the
   *  import doesn't resolve to a `.hm` source or has no entry for the name. */
  getImportedRawSignature?: (specifier: string, exportName: string, fromUri: string) => string | null;
  /** Optional: find every type/constructor definition (across globals and
   *  imported sidecars) for an uppercase name appearing in an annotation
   *  comment.  Used to surface a hover for names that are visible to
   *  inference but not present in `result.annotations`. */
  findTypeDefinitions?: (name: string) => Array<{ raw: string; origin: string; sourcePath: string | null; commentStart: number; commentEnd: number }>;
  /** Optional: convert a 0-based offset to an LSP Position. Supplied by the server (TextDocument.positionAt). */
  positionAt?: (offset: number) => Position;
}

/**
 * Build the LSP `Hover` response for a given cursor position.
 *
 * This is a pure function — all server-level concerns (document lookup,
 * inference invocation, ASI normalisation) are handled by the caller.
 *
 * Plain language: this is the decision tree that picks WHAT to show in the
 * hover box.  Reading top to bottom, the checks are ordered from most to
 * least specific:
 *   1. A registered method signature at this exact spot (e.g. hovering
 *      `.map` in `xs.map(...)`) → show that signature and stop.
 *   2. An identifier the type checker flagged as unknown → show nothing
 *      (the "Unbound variable" error already covers it).
 *   3. A `::` annotation the user wrote for this binding → show their text
 *      VERBATIM, never re-formatted (their parentheses and spacing win).
 *   4. An imported name → look up the original signature text in the file
 *      it came from, for the same verbatim treatment.
 *   5. Otherwise, print the INFERRED type, with many careful special cases:
 *      curried functions expand into all their call shapes, records list
 *      per-field constraints, unions of sumtype variants render on one
 *      line, error-poisoned types are suppressed, and so on.
 *   6. Extra info blocks are appended when relevant: constructor call
 *      overloads, a "where" section explaining constraints, `::narrow`
 *      predicate notes, and an explanation for `TypeRep` witnesses.
 *   7. Finally, if the cursor is inside a comment, try alias and
 *      constraint-directive hovers instead.
 */
export function buildHover(ctx: HoverContext): Hover | null {
  const {
    source, offset, result, bestType, bestStart, arrayShift,
    inferredTypeStyle, uri,
    resolveImportSpecifier, extractImportSpecifiers,
  } = ctx;

  const validIdent = resolveValidIdent(source, offset);

  // Compute the range of the word under the cursor (used for Hover.range)
  const wordBounds = scanWord(source, offset);
  const hoverRange = wordBounds ? computeHoverRange(source, wordBounds.start, wordBounds.end, ctx.positionAt) : undefined;

  // Check if cursor is on a method/property that has a registered signature.
  // When we re-inferred with `;` inserted, methodSignatures uses shifted offsets.
  const methodSig = result.methodSignatures.get(bestStart + arrayShift);
  if (methodSig && validIdent) {
    // Safety net: scrub any residual `§N` skolem tokens to their display
    // letters in case the signature was built before all skolems were
    // registered. Signatures are normally scrubbed at construction time.
    const names = result.skolemDisplayNames;
    const scrubbed = (names && methodSig.includes('§'))
      ? methodSig.replace(/§\d+/g, tok => names.get(tok) ?? '_')
      : methodSig;
    return {
      contents: {
        kind: 'markdown',
        value: `\`\`\`hm\n${scrubbed}\n\`\`\``,
      },
      range: hoverRange,
    };
  }

  // Unbound identifier suppression.  When the cursor is on an identifier
  // whose start offset is recorded in `unboundIdentifiers` (i.e.
  // `inferIdentifier` raised an `Unbound variable: '...'` diagnostic and
  // never recorded a node-type), the bestType selected above must have
  // come from a surrounding parent expression (ArrayExpression,
  // CallExpression, ...) — rendering that parent's type under the
  // identifier's name is nonsense (e.g. `wrong :: Prop UserTag a | Limit |
  // Offset | SQLTag | ...` for a typo in a selector array).  Return null
  // so only the `Unbound variable` diagnostic surfaces.
  if (validIdent && wordBounds && result.unboundIdentifiers?.has(wordBounds.start)) {
    return null;
  }

  // Check if there is an HM annotation for the node at this offset.
  // Fallback: when the offset-based lookup misses (e.g. `export const`
  // declarations where the annotation nodeStart differs from the
  // identifier's nodeType start), try a name-based lookup.
  let annotation = result.annotationsByOffset.get(bestStart);
  if (!annotation && validIdent) {
    // When the identifier appears in a `X.prototype.Y` context (e.g. hovering
    // on `Left` in `Left.prototype.map`), don't pick up the constructor
    // annotation — it belongs to the constructor declaration, not the
    // prototype method assignment.
    const identEnd = bestStart + validIdent.length;
    const isPrototypeCtx = source.slice(identEnd, identEnd + 11) === '.prototype.';
    if (!isPrototypeCtx) {
      // Name-based lookup must honour file-locality: a globals / sidecar /
      // `::types` entry that merely shares this identifier's name must not
      // hijack a user's own same-named binding.  A local `const test = ...`
      // shadows an ambient `test` global, so its hover should show the
      // inferred type — not the global's declared signature.  (The
      // offset-based lookup above is already consumer-local by construction.)
      const named = result.annotations.get(validIdent)
        ?? result.annotations.get(prototypeToHashName(validIdent) ?? '')
        ?? undefined;
      if (isLocalAnnotation(named)) annotation = named;
    }
    // Fallback: search for ClassName#method annotations by offset (class methods)
    if (!annotation && bestStart >= 0) {
      annotation = result.annotationsByOffset.get(bestStart) ?? undefined;
    }
    // Fallback: when hovering a bare method name (e.g. `map`) that lives
    // inside a constructor function body, look for a `Type#method`
    // annotation whose method-name part matches the identifier.
    // The offset-based lookup can miss because the annotation's nodeStart
    // points at the init expression (arrow fn) rather than the declarator.
    //
    // CAREFUL: matching purely by method name is ambiguous — many unrelated
    // types may declare a method called `insert`/`map`/etc.  When we *do*
    // have an inferred type for this identifier (`bestType`), only accept
    // a candidate annotation whose declared method type is structurally
    // compatible with the inferred type.  This prevents picking up an
    // unrelated sidecar annotation (e.g. `DpiTemplate#insert`) for a
    // locally destructured binding (`const { insert } = Repo (Organisation)`).
    if (!annotation && !isPrototypeCtx) {
      for (const [annName, ann] of result.annotations) {
        if (!annName.includes('#')) continue;
        const methodPart = annName.split('#')[1];
        if (methodPart !== validIdent || !ann.receiver) continue;
        // Restrict the bare-method-name fallback to *method* annotations
        // (i.e. the declared method type is a function).  Property/getter
        // annotations like `Param#rules :: Param a b c ~> [b]` declare a
        // bare TCon (`Array b`) and would falsely match any local binding
        // of the same name with a similarly-shaped Array type — e.g.
        // `const rules = [1, "2"]` would erroneously hover as
        // `Param#rules`.  Methods always have a TFun shape, so requiring
        // it here keeps the genuine "Type#method" fallback (used for
        // bindings inside constructor bodies) without over-matching
        // unrelated property annotations.
        const declared = ann.methodType ?? ann.scheme?.type;
        if (!declared || declared.tag !== 'TFun') continue;
        if (bestType && ann.methodType && !methodTypeMatchesShape(ann.methodType, bestType)) {
          continue;
        }
        annotation = ann;
        break;
      }
    }
  }

  // An annotation keyed at the enclosing arrow-function's start offset is
  // also found when the cursor is on the function's FIRST PARAMETER
  // (`fn => …` — the arrow node and `fn` share the same start offset).  The
  // annotation describes the enclosing function, not the hovered identifier:
  // when the hovered name matches neither the annotation's name nor its
  // method (`Type#m`) / static (`Type.m`) part, drop it so the parameter's
  // own inferred type renders instead of e.g. `Either2#map :: …`.
  if (annotation?.name && validIdent && annotation.name !== validIdent) {
    const hashPart = annotation.name.includes('#') ? annotation.name.split('#')[1] : null;
    const dotPart = !hashPart && annotation.name.includes('.') ? annotation.name.split('.')[1] : null;
    const protoName = prototypeToHashName(validIdent);
    if (hashPart !== validIdent && dotPart !== validIdent && (!protoName || protoName !== annotation.name)) {
      annotation = undefined;
    }
  }

  // Determine the display name for the hover.  When the JS identifier uses
  // the `X$prototype$Y` naming convention and the annotation is written as
  // `X#Y`, prefer the shorter `X#Y` form.
  let displayName = validIdent;
  if (validIdent && annotation?.name && annotation.name !== validIdent) {
    displayName = annotation.name;
  }

  // When the cursor is inside an annotation comment, skip the inferred
  // bestType and fall through to the alias hover logic below.
  const inAnnotation = isOffsetInComment(source, offset);

  if ((bestType || annotation) && validIdent && !inAnnotation) {
    let parts: string[] = [];
    // When a `scopeType` (the enclosing function's type) is available, seed
    // the pretty-printer's variable letters from it so a variable shared with
    // the enclosing scope renders with the same letter here (e.g. `result`
    // showing `b` because `f :: a -> b`).  Only applies to the `pretty` style.
    const formatType = inferredTypeStyle === 'pretty'
      ? (ctx.scopeType
          ? (t: Type) => prettyTypeToStringWithContext(t, ctx.scopeType!)
          : prettyTypeToString)
      : typeToString;

    // Render the outermost TCon as bare (no args) when it is registered
    // as instance-callable (`Name() :: ...`).  The full row + param info
    // surfaces inside the constructor-callable overload block below
    // (`RTask r e [<row>]` etc.), so showing the args here is just noise.
    // Only the OUTERMOST TCon is suppressed; nested types (record fields,
    // function results, list elements) keep full rendering via formatType.
    const formatBareType = (t: Type): string => {
      if (
        t.tag === 'TCon'
        && Array.isArray(t.args) && t.args.length > 0
        && result.instanceCallables?.has(t.name)
      ) {
        return t.name;
      }
      return formatType(t);
    };

    // ── User-written annotation: show verbatim ───────────────────────────
    // When the user provided an explicit type signature, the LSP must NEVER
    // re-format it.  Two signatures may parse to the same AST yet read very
    // differently (e.g. `Number | (p -> Number) -> Limit` vs the redundant
    // `(Number | (p -> Number)) -> Limit`); preserve exactly what the user
    // typed.  Only use the raw text when this hover targets the annotated
    // declaration itself (not a parameter inside its body, not a nested
    // identifier) — i.e. the binding name matches the annotation name.
    // When the inferred type is an auto-detected curried function we MUST
    // fall through to the inferred-type branch below so every overload
    // partition is rendered.  A freestanding `// name :: ...` comment
    // (often written as documentation alongside a `curry(...)` call) would
    // otherwise be matched here purely by name and short-circuit the
    // overload expansion at every usage site of the curried binding.
    // The same applies to user-overloaded curried bindings whose inferred
    // type is a Union of TFuns (one per `// name :: ...` line) — we still
    // want the LSP to surface the tuple partitions alongside the user's
    // chained forms so every callable shape is visible at a glance.
    const isAutoCurriedHere = !!bestType
      && result.curriedNodes.has(bestStart)
      && (
        bestType.tag === 'TFun'
        || (bestType.tag === 'TCon' && bestType.name === 'Union'
            && bestType.args.some(a => a.tag === 'TFun'))
      );
    if (
      annotation?.raw
      && !annotation.receiver  // method (~>) annotations have their own branch below
      && annotation.name
      && annotation.name === validIdent
      && bestStart === (annotation.nameStart ?? annotation.nodeStart ?? bestStart)
      && !isAutoCurriedHere
    ) {
      // Collect every raw signature for this name so overloaded local
      // bindings (e.g. `// add :: (Number, Number) -> Number` followed by
      // `// add :: (String, String) -> String`) render every branch on
      // its own line, not just the first.
      const rawLines: string[] = [];
      for (const a of extractAnnotations(source)) {
        if (a.name === annotation.name && a.raw && !a.receiver) {
          rawLines.push(`${displayName} :: ${a.raw}`);
        }
      }
      // At an overloaded CALL SITE, narrow to only the overload branch that
      // matched the actual arguments (recorded during inference).  Hovering
      // the declaration itself has no recorded match, so every overload is
      // still shown there.
      const matchedIdx = result.callSiteOverloadIndex?.get(bestStart);
      if (matchedIdx !== undefined && matchedIdx >= 0 && matchedIdx < rawLines.length) {
        rawLines.splice(0, rawLines.length, rawLines[matchedIdx]);
      }
      let body: string;
      if (rawLines.length > 0) {
        body = rawLines.join('\n');
      } else if (
        // Annotation came from outside this source (e.g. a globals/sidecar
        // file); `annotation.raw` only carries the FIRST overload.  Render
        // every branch from the merged scheme so all overloads surface.
        annotation.scheme?.type.tag === 'TCon'
        && annotation.scheme.type.name === 'Union'
        && Array.isArray((annotation.scheme.type as any).args)
        && (annotation.scheme.type as any).args.length > 1
      ) {
        const formatType = inferredTypeStyle === 'pretty' ? prettyTypeToString : typeToString;
        body = (annotation.scheme.type as any).args
          .map((b: Type) => `${displayName} :: ${formatType(b)}`)
          .join('\n');
      } else {
        body = `${displayName} :: ${annotation.raw}`;
      }
      parts.push(`\`\`\`hm\n${body}\n\`\`\``);
      return {
        contents: { kind: 'markdown', value: parts.join('\n\n') },
        range: hoverRange,
      };
    }

    // ── Imported binding: prefer the raw signature from the .hm source ───
    // For names imported from another module we look up the original
    // (verbatim) signature in the providing `.hm` file so the user's
    // exact formatting is preserved here too.
    //
    // Exception: when the imported binding is auto-detected as curried
    // (e.g. produced by `curry(...)` in the source module), fall through
    // so the inferred-type branch can expand every overload partition.
    // Showing only the raw chained form hides the equivalent tuple-style
    // call shape; both are valid call sites and both should be visible.
    const isAutoCurriedHereEarly = !!bestType
      && result.curriedNodes.has(bestStart)
      && (
        bestType.tag === 'TFun'
        || (bestType.tag === 'TCon' && bestType.name === 'Union'
            && bestType.args.some(a => a.tag === 'TFun'))
      );
    if (ctx.getImportedRawSignature && validIdent && !isAutoCurriedHereEarly) {
      const importSpecifier = extractImportSpecifiers(source).get(validIdent);
      if (importSpecifier) {
        const importedRaw = ctx.getImportedRawSignature(importSpecifier, validIdent, uri);
        if (importedRaw) {
          parts.push(`\`\`\`hm\n${displayName} :: ${importedRaw}\n\`\`\``);
          // Surface the body + source link of every constraint named in
          // the imported signature.  We extract names directly from the
          // raw signature text (everything left of `=>`) since the
          // imported binding doesn't always have a typed bestType from
          // which we could collect kv constraints.
          const csec = formatConstraintInfoSection(extractConstraintNamesFromRaw(importedRaw));
          if (csec) parts.push(csec);
          return {
            contents: { kind: 'markdown', value: parts.join('\n\n') },
            range: hoverRange,
          };
        }
      }
    }

    // Inline anonymous annotations (no name) are attached by offset to the
    // function node. When hovering a parameter inside that function, we only
    // want the identifier's own type (e.g. x :: Number), not the function
    // annotation itself.
    if (bestType) {
      // Suppress the bestType-driven hover line when the inferred type
      // contains the `$error` sentinel.  Free type variables in a failed
      // unification are bound to `$error` to stop diagnostic cascades
      // (see `poisonFreeVars`); leaking that sentinel into hover text
      // (e.g. `updateBy :: Prop $error`) is noise — any real overload
      // signature appended below is far more useful.
      const bestTypeIsErrorPolluted = containsErrorType(bestType);

      // Collect constraint info using the raw (unsubstituted) type so
      // kv varIds match the ids under which constraints were registered.
      // The substituted bestType may have different kv varIds after
      // unification with inner function calls.
      const constraintSource = ctx.rawBestType ?? bestType;

      // Track the constraint names surfaced in the rendered signature
      // (TFun branches) so we can append a "where … defined in …"
      // section at the end of the hover content.
      let bestTypeConstraintInfo: string[] = [];

      // For TRecord types, display constraints per-field rather than
      // hoisting them to the top level.  Each field is also independently
      // pretty-printed so type variables don't collide across fields.
      if (bestTypeIsErrorPolluted) {
        // Skip the bestType-driven line — but if we have a frozen
        // pretty-printed snapshot captured at inference time (e.g. the
        // sumtype `.constructor` union before a failed `new` call
        // poisoned its TVars), use it so hover still shows
        // `nothing.constructor :: Just a | Nothing`.
        const frozen = result.frozenPropertyTypeStr?.get(bestStart);
        if (frozen) {
          parts.push(`\`\`\`hm\n${displayName} :: ${frozen}\n\`\`\``);
        }
      } else if (bestType.tag === 'TRecord' && !bestType.alias) {
        const hasFieldConstraints = Object.values(
          constraintSource.tag === 'TRecord' ? constraintSource.fields : bestType.fields
        ).some(f => collectConstraintInfo(f, result.kvConstraints, result.kvConstructorConstraints).length > 0);

        if (hasFieldConstraints) {
          const recordStr = formatRecordWithFieldConstraints(
            bestType, constraintSource, result.kvConstraints, result.kvConstructorConstraints, formatType,
          );
          parts.push(`\`\`\`hm\n${displayName} :: ${recordStr}\n\`\`\``);
        } else {
          parts.push(`\`\`\`hm\n${displayName} :: ${formatBareType(bestType)}\n\`\`\``);
        }
      } else {
        const typeStr = formatBareType(bestType);
        // Label constrained variables with the same letters the body uses.
        const constraintVarNames = buildVarDisplayNameMap(bestType, ctx.scopeType ?? undefined);
        const constraintInfo = collectConstraintInfo(constraintSource, result.kvConstraints, result.kvConstructorConstraints, result.substitution, constraintVarNames);
        bestTypeConstraintInfo = constraintInfo;
        const constraintPrefix = constraintInfo.length > 0
          ? (constraintInfo.length === 1
              ? `${constraintInfo[0]} => `
              : `(${constraintInfo.join(', ')}) => `)
          : '';

        // Check if this is a curried function (auto-detected) — show all overloads
        if (result.curriedNodes.has(bestStart) && bestType.tag === 'TFun') {
          const { params, result: resultType } = flattenCurriedType(bestType);
          if (params.length > 1) {
            const overloads = generateCurriedOverloads(params, resultType);
            const overloadLines = overloads.map(o => `${displayName} :: ${constraintPrefix}${formatType(o)}`).join('\n');
            parts.push(`\`\`\`hm\n${overloadLines}\n\`\`\``);
          } else {
            parts.push(`\`\`\`hm\n${displayName} :: ${constraintPrefix}${typeStr}\n\`\`\``);
          }
        } else if (bestType.tag === 'TCon' && bestType.name === 'Union'
                   && !result.curriedNodes.has(bestStart)) {
          // When every union member is a variant of the same sumtype
          // (e.g. `Just a | Nothing`), render the union inline as a single
          // line.  This is the shape produced by sumtype `.constructor`
          // access — we want the user to see the variant union directly,
          // not one annotation line per variant.
          const variantParents = bestType.args.map(a =>
            a.tag === 'TCon' ? getParentTypeName(a.name) : null,
          );
          const allVariants = variantParents.length > 0
            && variantParents[0] !== null
            && variantParents.every(p => p === variantParents[0]);
          if (allVariants) {
            parts.push(`\`\`\`hm\n${displayName} :: ${constraintPrefix}${formatBareType(bestType)}\n\`\`\``);
          } else {
            // Non-curried non-variant Union.  In real-world code this is
            // produced by inference (auto-union of conditional branches,
            // value-position type slots that accept a union of legal
            // shapes, etc.) — NOT by user-written overloads.  Genuine
            // multi-annotation overloads (`// name :: T1` + `// name :: T2`)
            // are handled earlier by the raw-annotation branch; imported
            // sidecar overloads are handled by its Union-scheme fallback;
            // curried overloads use the dedicated curried-Union branch
            // below.  So we render this Union inline as a single value
            // type rather than as a misleading list of "overloads".
            // De-duplicate arms first so structurally identical TCons
            // (`Table`, `QueryTag`, ...) don't appear multiple times.
            const seen = new Set<string>();
            const dedupedArgs = bestType.args.filter(a => {
              const key = formatBareType(a);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            const inlineType: Type = dedupedArgs.length === 1
              ? dedupedArgs[0]
              : { ...bestType, args: dedupedArgs };
            parts.push(`\`\`\`hm\n${displayName} :: ${constraintPrefix}${formatBareType(inlineType)}\n\`\`\``);
          }
        } else if (result.curriedNodes.has(bestStart)
                   && bestType.tag === 'TCon' && bestType.name === 'Union'
                   && bestType.args.some(a => a.tag === 'TFun')) {
          // Curried overloaded function (e.g. `curry(add)` where `add` has
          // multiple `Name :: ...` annotations).  Expand every TFun branch
          // into its curry partitions so the reader sees every available
          // shape — both the tuple-style and the fully chained form for
          // every overload.
          const branches = bestType.args.filter(a => a.tag === 'TFun');
          const overloadLines = branches.flatMap(branch => {
            const { params, result: resultType } = flattenCurriedType(branch);
            const overloads = params.length > 1
              ? generateCurriedOverloads(params, resultType)
              : [branch];
            return overloads.map(o => `${displayName} :: ${constraintPrefix}${formatType(o)}`);
          }).join('\n');
          parts.push(`\`\`\`hm\n${overloadLines}\n\`\`\``);
        } else {
          // For method annotations with a receiver (~>), show the declared
          // annotation signature rather than the inferred type.  The inferred
          // type may have been distorted by unification (e.g. Nothing.map
          // returns `this` which is `Maybe a`, unifying `b` with `a` and
          // turning `(a -> b)` into `(b -> b)`).  The annotation represents
          // the intended contract; mismatches are reported separately.
          if (annotation?.receiver && annotation?.raw) {
            parts.push(`\`\`\`hm\n${displayName} :: ${annotation.raw}\n\`\`\``);
          } else {
            parts.push(`\`\`\`hm\n${displayName} :: ${constraintPrefix}${typeStr}\n\`\`\``);
          }
        }
      }

      // ── Constructor-as-callable overloads ────────────────────────────
      // When the inferred type is an uppercase TCon (e.g. `QueryTag b`) and
      // the local annotation map or an imported sidecar/override declares
      // callable overloads for that constructor (e.g. `QueryTag :: a -> RTask r e [b]`),
      // append those overloads — rendered under the binding's own name —
      // so the user sees the call signatures available on the value, not
      // just its bare type.
      const overloadLines = collectConstructorCallableOverloads(
        bestType, result, formatType, displayName ?? '',
      );
      if (overloadLines.length > 0) {
        // When the inferred bestType is just the bare constructor name
        // with no args (e.g. `Organisation :: Organisation`), the previous
        // line carries no information beyond what's already in
        // `displayName`.  Drop it so the overload block isn't preceded by
        // a redundant noise line.
        if (
          parts.length > 0
          && bestType?.tag === 'TCon'
          && (!bestType.args || bestType.args.length === 0)
          && parts[parts.length - 1] === `\`\`\`hm\n${displayName} :: ${bestType.name}\n\`\`\``
        ) {
          parts.pop();
        }
        parts.push(`\`\`\`hm\n${overloadLines.join('\n')}\n\`\`\``);
      }

      // Append a "where" section showing the body and source location of
      // every constraint named in the rendered signature.  Skipped when
      // none of the constraints resolve to a known `ConstraintDef` (e.g.
      // an unrecognised name, or a constraint with no source location).
      const constraintSection = formatConstraintInfoSection(bestTypeConstraintInfo);
      if (constraintSection) {
        parts.push(constraintSection);
      }

      // ── `::narrow` type-predicate info ───────────────────────────────
      // For a Boolean-returning predicate carrying a `::narrow` directive,
      // surface which type its argument is narrowed to when it returns true
      // (e.g. `isArray` narrows to `[a]`).  Without this the hover only shows
      // the bare `a -> Boolean` signature with no hint of the narrowing.
      const narrowPred = annotation?.scheme?.typePredicate;
      if (narrowPred) {
        const narrowedStr = formatBareType(narrowPred.narrowedType);
        const subject = narrowPred.paramName ? `\`${narrowPred.paramName}\`` : 'its argument';
        parts.push(
          `**Narrows** ${subject} to \`${narrowedStr}\` when this returns \`true\`  \n_via \`::narrow\` type predicate_`,
        );
      } else if (annotation?.narrowVariant) {
        parts.push(
          `**Narrows** to the \`${annotation.narrowVariant}\` variant when this returns \`true\`  \n_via \`::narrow\` type predicate_`,
        );
      }

      // ── TypeRep info ─────────────────────────────────────────────────
      // A value typed `TypeRep m` is a *type representative*: the type
      // constructor itself passed as a runtime witness so polymorphic
      // functions (Applicative/Monoid `of`/`empty`, …) can dispatch on it.
      // Plain hover only shows `TypeRep m`, which is opaque — explain it.
      if (bestType.tag === 'TCon' && bestType.name === T_TYPEREP) {
        const inner = bestType.args.length > 0 ? formatBareType(bestType.args[0]) : 'm';
        parts.push(
          `**Type representative** for \`${inner}\`  \n` +
          `A witness for the type constructor \`${inner}\`. Pass it to a polymorphic ` +
          `function (e.g. an \`Applicative\`/\`Monoid\` \`of\`/\`empty\`) to select which ` +
          `instance to use; static constructor methods are accessed through it.`,
        );
      }
    }
    return {
      contents: {
        kind: 'markdown',
        value: wrapHmBlocks(parts.join('\n\n')),
      },
      range: hoverRange,
    };
  }

  // Check if cursor is on a type alias name inside a comment annotation
  const aliasHover = getAliasHoverAtOffset(
    source, offset, result, uri, resolveImportSpecifier, extractImportSpecifiers,
    ctx.findTypeDefinitions,
  );
  if (aliasHover) {
    if (hoverRange) aliasHover.range = hoverRange;
    return aliasHover;
  }

  // Check if cursor is on a constraint name inside a ::constraint directive
  if (isOffsetInConstraintDirective(source, offset)) {
    const word = getWordAt(source, offset);
    if (word && /^[A-Z]/.test(word)) {
      const constraintHover = buildConstraintHover(word);
      if (constraintHover) {
        if (hoverRange) constraintHover.range = hoverRange;
        return constraintHover;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Hover range helper
// ---------------------------------------------------------------------------

/**
 * Compute an LSP Range for a token span.  When `positionAt` is supplied
 * (from TextDocument), it is used directly.  Otherwise a simple line/col
 * counter is used.
 */
function computeHoverRange(
  source: string,
  start: number,
  end: number,
  positionAt?: (offset: number) => Position,
): Range {
  const at = positionAt ?? ((offset: number) => positionAtFromFiles(source, offset));
  return { start: at(start), end: at(end) };
}
