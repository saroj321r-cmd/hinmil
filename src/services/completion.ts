// ============================================================================
// Completion — LSP completion item builders
//
// Plain language: the suggestion list that pops up while typing.  Based on
// what stands before the cursor, this file assembles the relevant
// suggestions: after `obj.` the properties and methods of obj's type; inside
// a `::` annotation the known type names and constraints; after `import`
// the exports of the target file; etc.  Each suggestion carries its type so
// the list doubles as documentation.
// ============================================================================

import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  TextEdit,
} from 'vscode-languageserver/node';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { InferenceResult, ImportResolver, TypeDirectiveResolver, ImportTypeAliasResolver, InferenceEngine } from '../infer';
import { Scheme, Type } from '../hm/types';
import {
  typeToString,
  prettyTypeToString,
  parseKvName,
  constraintBaseName,
  getReturnType,
  T_ARRAY,
  T_TYPEREP,
  T_UNION,
  isErrorType,
} from '../hm/types';
import { extractParamList } from '../hm/typeUtils';
import { findHostSlots, findOverloadSlots, substTVar } from '../hm/typeUtils';
import { scrubSkolems, someType } from '../hm/typeUtils';
import { isSkolem } from '../hm/types';
import {
  instantiate,
  getMethodNames,
  isBuiltinType,
  lookupMethod,
  lookupStaticMethod,
  lookupConstraint,
  getConstraintNames,
  getEffectiveMethods,
  isDataType,
} from '../index';
import { getDataTypeNames, getParentTypeName, getDataType, getVariantRecordFields } from '../registries/dataTypeRegistry';
import {
  getRegisteredTypeNames, isMethodHidden, isMethodPrivate,
  snapshotBuiltinOriginalEntries, restoreBuiltinOriginalEntries,
} from '../registries/methodRegistry';
import { resolveKvConstraintNames, collectAllKvConstraintNames } from '../infer/expressions';
import { OBJECT_PROTOTYPE_METHOD_NAMES, objectPrototypeMethodType } from '../infer/expressions';
import { getIntrinsicAttrEntries, getCssPropertyEntries } from '../infer/jsx-dom';
import {
  resolveImportSpecifier,
  extractImportSpecifiers,
  patchArrayLiteralASI,
} from './files';
import { scanWord, isOffsetInComment } from './hover';
import { collectScopeBindings } from './references';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Instantiate a scheme for completion display purposes, falling back to raw type on error. */
function safeInstantiate(s: Scheme): Type {
  try { return instantiate(s); } catch { return s.type; }
}

// ---------------------------------------------------------------------------
// Server context — injected by the caller
// ---------------------------------------------------------------------------

/**
 * Opaque callbacks into the server layer.  Completion functions need access to
 * inference, caches, resolvers, and settings but should not depend on the
 * concrete server module.
 */
export interface CompletionContext {
  engine: InferenceEngine;
  createImportResolver: (fromUri: string) => ImportResolver;
  createTypeDirectiveResolver: (fromUri: string) => TypeDirectiveResolver;
  createImportTypeAliasResolver?: (fromUri: string) => ImportTypeAliasResolver;
  inferFileAndCacheExports: (fileUri: string) => Map<string, Scheme> | null;
  inferredTypeStyle: 'pretty' | 'raw';
  /** Suggest not-yet-imported workspace exports with an auto-added import
   *  statement in identifier completions.  Defaults to true when omitted. */
  autoImports?: boolean;
  /** Cached inference result from the last diagnostic pass (may be slightly stale). */
  cachedResult?: InferenceResult;
  /** Optional request-scoped inference (cached per exact source text): the
   *  several providers of one completion request — and repeated requests on
   *  an unchanged document — then pay for at most ONE inference per source
   *  version instead of one each. */
  inferSource?: (source: string) => InferenceResult;
  /** Optional: look up the verbatim raw signature text for an imported binding. */
  getImportedRawSignature?: (specifier: string, exportName: string, fromUri: string) => string | null;
}

// ---------------------------------------------------------------------------
// Shared helpers for object-literal completion
// ---------------------------------------------------------------------------

/** Scan backwards from `offset` to find the opening `{` of an object literal.
 *  Returns -1 if not found before hitting a `;`. */
function findOpenBrace(source: string, offset: number): number {
  let braceDepth = 0;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = source[i];
    if (ch === '}') braceDepth++;
    if (ch === '{') {
      if (braceDepth === 0) return i;
      braceDepth--;
    }
    if (ch === ';') break;
  }
  return -1;
}

/** Find the name of the enclosing function before `beforeOffset`. */
function findEnclosingFuncName(source: string, beforeOffset: number): string | undefined {
  const textBefore = source.substring(0, beforeOffset);

  const fnDeclRegex = /function\s+(\w+)\s*\(/g;
  let fnMatch;
  let lastFnMatch: RegExpExecArray | null = null;
  while ((fnMatch = fnDeclRegex.exec(textBefore)) !== null) lastFnMatch = fnMatch;

  const varDeclRegex = /(?:const|let|var)\s+(\w+)\s*=/g;
  let varMatch;
  let lastVarMatch: RegExpExecArray | null = null;
  while ((varMatch = varDeclRegex.exec(textBefore)) !== null) lastVarMatch = varMatch;

  if (lastFnMatch && lastVarMatch) {
    return lastFnMatch.index > lastVarMatch.index ? lastFnMatch[1] : lastVarMatch[1];
  }
  return lastFnMatch?.[1] ?? lastVarMatch?.[1];
}

/** Collect keys already present inside a `{ key :: ..., key2 :: ... }` literal. */
function getPresentKeys(source: string, openBraceOffset: number, offset: number): Set<string> {
  const closeBrace = source.indexOf('}', offset);
  const objectContent = source.substring(openBraceOffset + 1, closeBrace > 0 ? closeBrace : offset);
  return new Set(
    objectContent.match(/\b(\w+)\s*[,:}]/g)?.map(m => m.replace(/[\s,:}]/g, '')) ?? []
  );
}

/**
 * Resolve a Type to its record-field entries, following an alias TCon to its
 * underlying TRecord if necessary. Returns `null` when the type is not a record.
 */
function resolveRecordFields(
  t: Type,
  result: InferenceResult,
): Array<[string, Type]> | null {
  if (t.tag === 'TRecord') {
    const hidden = t.hiddenFields;
    const entries = Object.entries(t.fields);
    return hidden ? entries.filter(([k]) => !hidden.has(k)) : entries;
  }
  if (t.tag === 'TCon') {
    if (t.name === 'Union') {
      // Pick the first TRecord (or alias-to-TRecord) member of the union.
      // Useful for query-builder-style overloaded values whose record branch
      // carries the destructurable fields (e.g. `{ props :: …}`).
      for (const member of t.args) {
        const fields = resolveRecordFields(member, result);
        if (fields) return fields;
      }
      return null;
    }
    const alias = result.typeAliases.get(t.name);
    if (alias && alias.type.tag === 'TRecord') {
      const hidden = alias.type.hiddenFields;
      const entries = Object.entries(alias.type.fields);
      return hidden ? entries.filter(([k]) => !hidden.has(k)) : entries;
    }
  }
  return null;
}

/**
 * Walk backwards from `offset` to find the `(` of an enclosing call expression
 * along with the active argument index (number of top-level commas seen).
 * Returns null when no enclosing `(` exists at depth 0.
 */
function findEnclosingCallParen(source: string, offset: number): { parenOffset: number; activeParam: number } | null {
  let depth = 0;
  let activeParam = 0;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = source[i];
    if (ch === ')' || ch === ']' || ch === '}') depth++;
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth > 0) depth--;
      else if (ch === '(') return { parenOffset: i, activeParam };
      // unmatched '[' or '{' at depth 0 — keep scanning outward
    } else if (ch === ',' && depth === 0) activeParam++;
  }
  return null;
}

/**
 * When the cursor sits inside an object literal that is an argument to a call,
 * return the *expected* record type for that argument as inferred from the
 * callee's signature.  Useful for completion in `f(arg, { | })` where the
 * literal itself has no fields yet but the callee's parameter is a record.
 */
function getExpectedRecordTypeForCallArg(
  source: string,
  openBraceOffset: number,
  result: InferenceResult,
): Type | null {
  const found = findEnclosingCallParen(source, openBraceOffset);
  if (!found) return null;
  const { parenOffset, activeParam } = found;

  // Locate the callee identifier just before the '('.
  let calleeEnd = parenOffset - 1;
  while (calleeEnd >= 0 && /\s/.test(source[calleeEnd])) calleeEnd--;
  let calleeStart = calleeEnd;
  while (calleeStart >= 0 && /[A-Za-z0-9_$.]/.test(source[calleeStart])) calleeStart--;
  calleeStart++;
  if (calleeStart > calleeEnd) return null;

  // Find the recorded type whose start lies inside the callee identifier range.
  let bestType: Type | null = null;
  let bestStart = -1;
  for (const [start, { type }] of result.nodeTypes) {
    if (start >= calleeStart && start <= calleeEnd && start > bestStart) {
      bestType = result.substitution.apply(type);
      bestStart = start;
    }
  }
  if (!bestType) return null;

  // Direct TFun: classic case (`f({ | })` where `f :: { ... } -> ...`).
  if (bestType.tag === 'TFun') {
    const params = extractParamList(bestType);
    if (activeParam >= params.length) return null;
    return result.substitution.apply(params[activeParam]);
  }

  // Instance-callable TCon (`tag :: QueryTag p o` invoked as `tag({ | })`).
  // Resolve the callable scheme registered for the constructor name and
  // specialise it with the host TCon's row/param slots, mirroring the
  // logic in [hover.ts] `collectConstructorCallableOverloads`.
  if (bestType.tag === 'TCon' && /^[A-Z]/.test(bestType.name)) {
    const callables = result.instanceCallables?.get(bestType.name);
    if (!callables || callables.length === 0) return null;
    const slots = findHostSlots(bestType);
    const paramArg = slots.paramArg ?? bestType.paramHint ?? null;
    for (const scheme of callables) {
      let branch = safeInstantiate(scheme);
      if (branch.tag !== 'TFun') continue;
      const { paramTVarId, carrierTVarId } = findOverloadSlots(branch);
      if (slots.rowArg && carrierTVarId !== null) {
        branch = substTVar(branch, carrierTVarId, slots.rowArg);
      }
      if (paramArg && paramTVarId !== null) {
        branch = substTVar(branch, paramTVarId, paramArg);
      }
      const params = extractParamList(branch as Type);
      if (activeParam >= params.length) continue;
      return result.substitution.apply(params[activeParam]);
    }
  }

  return null;
}

/** Run inference on `source` and return the result (shared 3-line preamble).
 *  Prefers the request-scoped cache when the server provides one. */
function runInference(source: string, uri: string, ctx: CompletionContext) {
  if (ctx.inferSource) return ctx.inferSource(source);
  const resolver = ctx.createImportResolver(uri);
  const typeResolver = ctx.createTypeDirectiveResolver(uri);
  const aliasResolver = ctx.createImportTypeAliasResolver?.(uri);
  return ctx.engine.infer(source, undefined, resolver, typeResolver, aliasResolver);
}

// ---------------------------------------------------------------------------
// JSX completion — <Badge l| (prop names) and <Badg| (component names)
// ---------------------------------------------------------------------------

/** Result of locating the JSX opening tag the cursor sits inside. */
export interface JsxOpeningTagContext {
  /** Tag name as written (may be a member chain like `Ui.Badge`). */
  tagName: string;
  /** Offset of the first character of the tag name. */
  tagStart: number;
  /** Text between the end of the tag name and the cursor (attribute region). */
  attrText: string;
}

/**
 * Scan backwards from `offset` to determine whether the cursor sits inside a
 * JSX opening element's attribute region (`<Badge |`, `<Badge la|`,
 * `<Ui.Badge x={1} |`).  Purely textual so it works mid-typing when the
 * source does not parse.  Returns null when the cursor is:
 *   - not after a `<Tag` sequence,
 *   - inside an expression container (`{…}`) — normal completion applies,
 *   - past the tag's closing `>`,
 *   - inside a closing tag (`</Tag`).
 */
export function findJsxOpeningTagContext(source: string, offset: number): JsxOpeningTagContext | null {
  let braceDepth = 0;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = source[i];
    // Skip string attribute values ("…" / '…'); give up if the string spans
    // a newline (almost certainly not an attribute value).
    if (ch === '"' || ch === '\'') {
      let j = i - 1;
      while (j >= 0 && source[j] !== ch && source[j] !== '\n') j--;
      if (j < 0 || source[j] !== ch) return null;
      i = j;
      continue;
    }
    if (ch === '}') { braceDepth++; continue; }
    if (ch === '{') {
      // Unmatched `{` — cursor is inside an expression container.
      if (braceDepth === 0) return null;
      braceDepth--;
      continue;
    }
    // Characters that cannot occur in an attribute region outside strings
    // and braces — we are not inside an opening tag.
    if (ch === '>' || ch === ';' || ch === '(' || ch === ')' || ch === ',') return null;
    if (ch === '<') {
      if (source[i + 1] === '/') return null; // closing tag
      const m = /^[A-Za-z_$][\w$.]*/.exec(source.slice(i + 1, i + 200));
      if (!m) return null;
      const tagName = m[0];
      const nameEnd = i + 1 + tagName.length;
      if (offset < nameEnd) return null; // cursor still inside the tag name
      return { tagName, tagStart: i + 1, attrText: source.slice(nameEnd, offset) };
    }
  }
  return null;
}

/**
 * Result of locating the cursor inside an object literal nested in a JSX
 * attribute expression container (`<div style={{ col| }}`).
 */
export interface JsxAttrObjectContext {
  /** Tag name as written (may be a member chain like `Ui.Badge`). */
  tagName: string;
  /** The attribute whose container the object literal sits in (`style`). */
  attrName: string;
  /** Text inside the innermost object literal, up to the cursor. */
  innerText: string;
}

/**
 * Scan backwards from `offset` to determine whether the cursor sits inside
 * an object literal nested in a JSX attribute's expression container
 * (`style={{ … }`).  Purely textual so it works mid-typing.  Returns null
 * when the cursor is directly in the container (`attr={|`, no inner
 * object), inside a string, or not in a JSX opening tag at all.
 */
export function findJsxAttrObjectContext(source: string, offset: number): JsxAttrObjectContext | null {
  let closeDepth = 0;
  let innermostOpen = -1;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = source[i];
    // Skip string literals; bail when the opener is missing on the same
    // line (cursor almost certainly inside an unterminated string).
    if (ch === '"' || ch === '\'' || ch === '`') {
      let j = i - 1;
      while (j >= 0 && source[j] !== ch && source[j] !== '\n') j--;
      if (j < 0 || source[j] !== ch) return null;
      i = j;
      continue;
    }
    if (ch === '}') { closeDepth++; continue; }
    if (ch !== '{') continue;
    if (closeDepth > 0) { closeDepth--; continue; }
    // Unmatched `{` — the attribute container when directly preceded by
    // `attrName=`; otherwise a (possibly nested) object literal.
    const before = source.slice(0, i);
    const m = /([A-Za-z_$][\w$-]*)\s*=\s*$/.exec(before);
    if (!m) {
      if (innermostOpen < 0) innermostOpen = i;
      continue;
    }
    if (innermostOpen < 0) return null; // directly in `attr={|` — not an object
    const tag = findJsxOpeningTagContext(source, m.index);
    if (!tag) return null;
    return { tagName: tag.tagName, attrName: m[1], innerText: source.slice(innermostOpen + 1, offset) };
  }
  return null;
}

/**
 * CSS property-name completion inside `style={{ … }}`: on an object-literal
 * KEY position the catalogue names are offered (and the identifier fallback
 * suppressed — file bindings are meaningless there); on a VALUE position
 * null is returned so ordinary identifier completion applies.  Unknown keys
 * (CSS custom properties, vendor prefixes) stay diagnostic-free — this is
 * completion only.
 */
export function getJSXStyleKeyCompletions(
  source: string,
  offset: number,
  ctx: CompletionContext,
): CompletionItem[] | null {
  const objCtx = findJsxAttrObjectContext(source, offset);
  if (!objCtx || objCtx.attrName !== 'style') return null;

  const partial = /[\w$]*$/.exec(objCtx.innerText)?.[0] ?? '';
  const beforePartial = objCtx.innerText.slice(0, objCtx.innerText.length - partial.length);

  // Key vs value position: scrub strings + balanced groups, then compare the
  // last `:` against the last `,` — a trailing `:` means value position.
  let scrubbed = beforePartial.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, ' ');
  for (;;) {
    const next = scrubbed.replace(/\{[^{}]*\}|\[[^\]]*\]|\([^()]*\)/g, ' ');
    if (next === scrubbed) break;
    scrubbed = next;
  }
  if (scrubbed.lastIndexOf(':') > scrubbed.lastIndexOf(',')) return null; // value position

  const present = new Set<string>();
  const re = /([A-Za-z_$][\w$-]*)\s*:/g;
  let m;
  while ((m = re.exec(scrubbed)) !== null) present.add(m[1]);

  const formatType = ctx.inferredTypeStyle === 'pretty' ? prettyTypeToString : typeToString;
  const items: CompletionItem[] = [];
  for (const entry of getCssPropertyEntries()) {
    if (present.has(entry.name)) continue;
    if (partial && !entry.name.startsWith(partial)) continue;
    items.push({
      label: entry.name,
      kind: CompletionItemKind.Property,
      detail: formatType(entry.type),
      insertText: `${entry.name}: $1`,
      insertTextFormat: InsertTextFormat.Snippet,
      sortText: `0_${entry.name}`,
    });
  }
  // Always an array on a key position — even when empty — so the generic
  // identifier completion never floods an object-key slot.
  return items;
}

/** Resolve a JSX tag name (possibly a member chain) to its binding type. */
function resolveJsxTagType(tagName: string, result: InferenceResult): Type | null {
  const parts = tagName.split('.');
  const scheme = result.topLevelBindings.get(parts[0]);
  if (!scheme) return null;
  let t: Type = result.substitution.apply(safeInstantiate(scheme));
  for (const part of parts.slice(1)) {
    if (t.tag !== 'TRecord' || !(part in t.fields)) return null;
    t = result.substitution.apply(t.fields[part]);
  }
  return t;
}

/** Extract the props record of a component type (first parameter). */
function propsRecordOfComponent(t: Type, result: InferenceResult): Type | null {
  if (t.tag === 'TFun') {
    const params = extractParamList(t);
    if (params.length === 0) return null;
    return result.substitution.apply(params[0]);
  }
  // Instance-callable / constructor-annotated components (`Badge :: … -> Badge`
  // annotates the binding as a TFun already; class components without a
  // constructor annotation resolve to a TCon we cannot introspect).
  if (t.tag === 'TCon' && /^[A-Z]/.test(t.name)) {
    const callables = result.instanceCallables?.get(t.name);
    if (callables) {
      for (const scheme of callables) {
        const branch = safeInstantiate(scheme);
        if (branch.tag !== 'TFun') continue;
        const params = extractParamList(branch);
        if (params.length > 0) return result.substitution.apply(params[0]);
      }
    }
  }
  return null;
}

/** Attribute names already present in an opening tag's attribute text. */
function presentJsxAttrNames(attrText: string): Set<string> {
  const scrubbed = attrText
    .replace(/"[^"]*"|'[^']*'/g, ' ')     // string values
    .replace(/\{[^{}]*\}/g, ' ')          // simple expression containers
    .replace(/\.\.\.[\w$.]*/g, ' ');      // spread attributes
  const names = new Set<string>();
  const re = /([A-Za-z_$][\w$-]*)/g;
  let m;
  while ((m = re.exec(scrubbed)) !== null) names.add(m[1]);
  return names;
}

/** True when a (resolved) type accepts `undefined` — used to mark optional props. */
function typeHasUndefined(t: Type): boolean {
  if (t.tag === 'TCon' && t.name === 'Undefined') return true;
  if (t.tag === 'TCon' && t.name === T_UNION) return t.args.some(typeHasUndefined);
  return false;
}

/**
 * Prop-name completion inside a JSX opening tag: `<Badge l|` offers the
 * fields of the component's props record (first parameter), excluding
 * `children` and attributes already present.
 */
export function getJSXPropCompletions(
  source: string,
  offset: number,
  uri: string,
  ctx: CompletionContext,
): CompletionItem[] {
  const tag = findJsxOpeningTagContext(source, offset);
  if (!tag) return [];
  // Inside an unterminated attribute value (`label="…`) — not a name position.
  const quoteCount = (tag.attrText.match(/["']/g) ?? []).length;
  if (quoteCount % 2 !== 0) return [];

  const partial = /[\w$]*$/.exec(tag.attrText)?.[0] ?? '';
  const present = presentJsxAttrNames(tag.attrText.slice(0, tag.attrText.length - partial.length));
  const formatType = ctx.inferredTypeStyle === 'pretty' ? prettyTypeToString : typeToString;

  // Intrinsic (lowercase) tag — complete from the DOM attribute catalogue;
  // per-tag attributes sort above global ones.
  if (/^[a-z]/.test(tag.tagName) && !tag.tagName.includes('.')) {
    const items: CompletionItem[] = [];
    for (const entry of getIntrinsicAttrEntries(tag.tagName)) {
      if (present.has(entry.name)) continue;
      if (partial && !entry.name.startsWith(partial)) continue;
      const isString = entry.type.tag === 'TCon' && entry.type.name === 'String';
      items.push({
        label: entry.name,
        kind: CompletionItemKind.Property,
        detail: formatType(entry.type),
        insertText: isString ? `${entry.name}="$1"$0` : `${entry.name}={$1}$0`,
        insertTextFormat: InsertTextFormat.Snippet,
        sortText: `${entry.tagSpecific ? '0' : '1'}_${entry.name}`,
      });
    }
    return items;
  }

  // Mid-typing sources (`… = <Badge l`) do not parse — even loosely — so
  // resolve the component's type against the last good cached result when
  // available, and otherwise re-infer a patched source with the open tag
  // self-closed at the cursor (`… = <Badge l />`).
  let result = ctx.cachedResult;
  let tagType = result ? resolveJsxTagType(tag.tagName, result) : null;
  if (!tagType) {
    const patched = source.slice(0, offset) + ' />' + source.slice(offset);
    result = runInference(patched, uri, ctx);
    tagType = resolveJsxTagType(tag.tagName, result);
  }
  if (!result || !tagType) return [];
  const propsType = propsRecordOfComponent(tagType, result);
  if (!propsType) return [];
  const fields = resolveRecordFields(propsType, result);
  if (!fields || fields.length === 0) return [];

  const items: CompletionItem[] = [];
  for (const [name, rawType] of fields) {
    if (name === 'children') continue;
    if (present.has(name)) continue;
    if (partial && !name.startsWith(partial)) continue;
    const fieldType = result.substitution.apply(rawType);
    const isString = fieldType.tag === 'TCon' && fieldType.name === 'String';
    items.push({
      label: name,
      kind: CompletionItemKind.Field,
      detail: formatType(fieldType) + (typeHasUndefined(fieldType) ? '  (optional)' : ''),
      insertText: isString ? `${name}="$1"$0` : `${name}={$1}$0`,
      insertTextFormat: InsertTextFormat.Snippet,
      sortText: `0_${name}`,
    });
  }
  return items;
}

/**
 * Component-name completion right after `<`: `<Badg|` offers uppercase
 * bindings (and auto-import candidates) from the regular identifier
 * completion, since JSX component tags must start with a capital letter.
 */
export function getJSXComponentCompletions(
  source: string,
  offset: number,
  uri: string,
  ctx: CompletionContext,
): CompletionItem[] {
  const wordStart = scanWord(source, offset)?.start ?? offset;
  if (wordStart === 0 || source[wordStart - 1] !== '<') return [];
  // `a << b`, `a </ b` and friends are not JSX tags.
  if (wordStart >= 2 && /[<\/=!]/.test(source[wordStart - 2])) return [];
  const partial = source.slice(wordStart, offset);
  // Only fire for capitalised names — lowercase tags are host elements and
  // `a < b` comparisons; both should keep the default behaviour.
  if (!/^[A-Z]/.test(partial)) return [];

  // The open tag makes the source unparseable mid-typing; self-close it so
  // the identifier completions can see the file's bindings.
  const patched = source.slice(0, offset) + ' />' + source.slice(offset);
  return getIdentifierCompletions(patched, offset, uri, ctx)
    .filter(item => /^[A-Z]/.test(item.label));
}

// ---------------------------------------------------------------------------
// sumtype factory record completion — return { | }
// ---------------------------------------------------------------------------

/**
 * Shared prefix for record-completion providers: locate `{` of a return-object
 * literal inside a function body, infer the source, and resolve the function's
 * annotated return type.  Returns null if any precondition fails.
 */
function resolveReturnRecordContext(
  source: string,
  offset: number,
  uri: string,
  ctx: CompletionContext,
): { openBraceOffset: number; result: InferenceResult; retType: Type } | null {
  // 1. Find { of object literal
  const openBraceOffset = findOpenBrace(source, offset);
  if (openBraceOffset < 0) return null;

  // 2. Check that the { is preceded by `return` or `=> (`
  const beforeBrace = source.substring(0, openBraceOffset).trimEnd();
  const isReturn = beforeBrace.endsWith('return');
  const isArrowParen = /=>\s*\($/.test(beforeBrace);
  if (!isReturn && !isArrowParen) return null;

  // 3. Find the enclosing function's annotation
  const result = runInference(source, uri, ctx);
  const funcName = findEnclosingFuncName(source, openBraceOffset);
  if (!funcName) return null;

  // 4. Look up the annotation for this function
  const ann = result.annotations.get(funcName);
  if (!ann?.scheme) return null;

  return { openBraceOffset, result, retType: getReturnType(ann.scheme.type) };
}

/**
 * Detect if the cursor is inside a return object literal within a sumtype
 * factory function.  If so, offer the registered methods/properties as
 * completion items (e.g. `value`, `map`).
 *
 * Pattern: `return { | }` inside a function annotated with a sumtype return.
 */
export function getSumTypeRecordCompletions(
  source: string,
  offset: number,
  uri: string,
  ctx: CompletionContext,
): CompletionItem[] {
  if (offset > 0 && source[offset - 1] === '.') return [];
  const rc = resolveReturnRecordContext(source, offset, uri, ctx);
  if (!rc) return [];
  const { openBraceOffset, retType } = rc;

  // 5. Check if the return type is a TCon with registered methods (sumtype, class, ADT factory)
  if (retType.tag !== 'TCon') return [];
  if (!isDataType(retType.name) && (isBuiltinType(retType.name) || getMethodNames(retType.name).length === 0)) return [];

  const typeName = retType.name;
  const methodNames = getMethodNames(typeName);
  if (methodNames.length === 0) return [];

  // 6. Build completions with snippet text for each field
  const items: CompletionItem[] = [];
  const presentKeys = getPresentKeys(source, openBraceOffset, offset);

  for (const mn of methodNames) {
    if (presentKeys.has(mn)) continue; // already present
    const entry = lookupMethod(typeName, mn);
    if (entry && !entry.isStatic) {
      const methodType = entry.factory(retType.args);
      const display = prettyTypeToString(methodType);
      items.push({
        label: mn,
        kind: methodType.tag === 'TFun' ? CompletionItemKind.Method : CompletionItemKind.Field,
        detail: `${typeName}#${mn} :: ${display}`,
      });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Type alias record completion — return { | } or => ({ | })
// ---------------------------------------------------------------------------

/**
 * Detect if the cursor is inside a return object literal within a function
 * annotated to return a type alias that expands to a record.
 * If so, offer the missing record fields as completion items.
 *
 * Patterns:
 *   - `return { | }` in block-body functions
 *   - `=> ({ | })`  in expression-body arrow functions
 */
export function getTypeAliasRecordCompletions(
  source: string,
  offset: number,
  uri: string,
  ctx: CompletionContext,
): CompletionItem[] {
  if (offset > 0 && source[offset - 1] === '.') return [];
  const rc = resolveReturnRecordContext(source, offset, uri, ctx);
  if (!rc) return [];
  const { openBraceOffset, result, retType } = rc;

  // 5. Get the return type and check if it expands to a record via type alias
  let aliasName: string | undefined;
  let recordType: Type | undefined;

  if (retType.tag === 'TRecord' && retType.alias) {
    aliasName = retType.alias;
    recordType = retType;
  } else if (retType.tag === 'TCon') {
    aliasName = retType.name;
    const aliasEntry = result.typeAliases.get(aliasName);
    if (aliasEntry && aliasEntry.type.tag === 'TRecord') {
      recordType = aliasEntry.type;
    }
  }

  if (!aliasName || !recordType || recordType.tag !== 'TRecord') return [];

  // 6. Build completion items for missing fields
  const presentKeys = getPresentKeys(source, openBraceOffset, offset);
  const fmt = ctx.inferredTypeStyle === 'pretty' ? prettyTypeToString : typeToString;
  const items: CompletionItem[] = [];
  for (const [fieldName, fieldType] of Object.entries(recordType.fields)) {
    if (recordType.hiddenFields?.has(fieldName)) continue;
    if (presentKeys.has(fieldName)) continue;
    items.push({
      label: fieldName,
      kind: CompletionItemKind.Field,
      detail: `${aliasName}.${fieldName} :: ${fmt(fieldType)}`,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Destructuring completion — const { | } = expr
// ---------------------------------------------------------------------------

/**
 * Detect if the cursor is inside a destructuring pattern: `const { | } = expr`
 * If so, return completions based on the RHS expression's type.
 *
 * How it works, step by step (plain language):
 *   1. Walk backwards from the cursor to find the `{` that opened the
 *      pattern we are inside of.
 *   2. Look at the text just before that `{`:
 *      - `(`, `,` or `:` means we are inside a function PARAMETER pattern
 *        (e.g. `({ | }) => ...`) — ask the type checker what record type the
 *        function expects there and offer its field names.
 *      - `const` / `let` / `var` means a VARIABLE pattern — continue below.
 *   3. Walk forwards to find the matching `}`, the `=` sign, and the
 *      expression on the right-hand side (possibly a chain like `a.b.c()`).
 *   4. Ask the type checker what type that right-hand side has, and offer
 *      its record fields / module exports / methods as suggestions, minus
 *      any keys the user has already written inside the braces.
 */
export function getDestructuringCompletions(
  source: string,
  offset: number,
  uri: string,
  ctx: CompletionContext,
): CompletionItem[] {
  // If the character right before the cursor is a dot, this is a member-access
  // completion (e.g. `({ ...x, ...y.| })`), not a destructuring/property-key
  // completion.  Defer to the dot handler.
  if (offset > 0 && source[offset - 1] === '.') return [];

  // Scan backwards from cursor to find if we're inside { } that is part of a destructuring pattern
  let braceDepth = 0;
  let openBraceOffset = -1;

  for (let i = offset - 1; i >= 0; i--) {
    const ch = source[i];
    if (ch === '}') braceDepth++;
    if (ch === '{') {
      if (braceDepth === 0) {
        openBraceOffset = i;
        break;
      }
      braceDepth--;
    }
    if (ch === ';' || ch === '\n') {
      continue;
    }
  }

  if (openBraceOffset < 0) return [];

  const beforeBrace = source.substring(0, openBraceOffset).trimEnd();

  // --- Parameter destructuring: ({ | }) => ... or ({ | }, ...) => ...
  // Also covers nested object patterns: ({ address: { | } }) or
  // const { a: { | } } = obj. The ObjectPattern node's start offset is the `{`.
  // Lookup the recorded node type and offer record fields.
  if (/[(,:]$/.test(beforeBrace)) {
    const result = runInference(source, uri, ctx);
    const entry = result.nodeTypes.get(openBraceOffset);
    // Fields recorded on the literal itself (concrete property types).
    let literalFields: Array<[string, Type]> | null = null;
    if (entry) {
      const resolved = result.substitution.apply(entry.type);
      literalFields = resolveRecordFields(resolved, result);
    }
    // Expected record type from the enclosing call's parameter signature.
    // This is authoritative for available field names — it covers the
    // empty-literal case `f(..., { | })` and, more importantly, the
    // mid-typing case `f(..., { n| })` where the literal records a
    // partial/unbound shape that would otherwise hide the real fields.
    const expected = getExpectedRecordTypeForCallArg(source, openBraceOffset, result);
    const expectedFields = expected ? resolveRecordFields(expected, result) : null;

    // Prefer expected fields when available; merge in any literal fields
    // that the expected type didn't already cover (e.g. open-record rest
    // produced concrete extras on the literal).
    let fields: Array<[string, Type]> | null = null;
    if (expectedFields && expectedFields.length > 0) {
      const seen = new Set(expectedFields.map(([k]) => k));
      const extras = (literalFields || []).filter(([k]) => !seen.has(k));
      fields = [...expectedFields, ...extras];
    } else {
      fields = literalFields;
    }
    if (fields) {
      const presentKeys = getPresentKeys(source, openBraceOffset, offset);
      // Exclude the identifier currently being typed at the cursor *only* when
      // its inferred field type is an unbound type variable — the telltale
      // sign of a phantom row-variable artifact (e.g. typing `ad` against an
      // open record like `{ ...r }` produces `ad :: a`).  Real expected
      // fields keep their concrete name even while the user types them.
      const typedWord = scanWord(source, offset);
      const typedKey = typedWord ? source.slice(typedWord.start, typedWord.end) : '';
      const items: CompletionItem[] = [];
      for (const [fieldName, fieldType] of fields) {
        // Skip keys already written in the literal — but never skip the
        // key the user is *currently* typing, otherwise completing `n` to
        // `name` would be impossible because `n` itself appears in
        // `presentKeys` (it's a shorthand property at the cursor).
        if (presentKeys.has(fieldName) && fieldName !== typedKey) continue;
        if (typedKey && fieldName === typedKey) {
          const resolvedFieldType = result.substitution.apply(fieldType);
          if (resolvedFieldType.tag === 'TVar') continue;
        }
        // `T | Undefined` fields may be omitted: mark them, as for JSX props.
        const optional = typeHasUndefined(result.substitution.apply(fieldType)) ? '  (optional)' : '';
        items.push({
          label: fieldName,
          kind: fieldType.tag === 'TFun' ? CompletionItemKind.Method : CompletionItemKind.Field,
          detail: `${fieldName} :: ${prettyTypeToString(fieldType)}${optional}`,
          labelDetails: { description: prettyTypeToString(fieldType) + optional },
        });
      }
      if (items.length > 0) return items;
    }
    return [];
  }

  if (!/\b(const|let|var)$/.test(beforeBrace)) return [];

  // Find the closing } and then the = and the RHS expression
  let closeBraceOffset = -1;
  let depth = 1;
  for (let i = openBraceOffset + 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        closeBraceOffset = i;
        break;
      }
    }
  }
  if (closeBraceOffset < 0) return [];

  let eqOffset = -1;
  for (let i = closeBraceOffset + 1; i < source.length; i++) {
    if (/\s/.test(source[i])) continue;
    if (source[i] === '=') {
      eqOffset = i;
      break;
    }
    break;
  }
  if (eqOffset < 0) return [];

  let rhsStart = eqOffset + 1;
  while (rhsStart < source.length && /\s/.test(source[rhsStart])) rhsStart++;
  let rhsEnd = rhsStart;
  while (rhsEnd < source.length && /[A-Za-z0-9_$]/.test(source[rhsEnd])) rhsEnd++;
  const rhsName = source.slice(rhsStart, rhsEnd);
  if (!rhsName) return [];
  // Extend the RHS past chained member accesses and call expressions so
  // we can resolve full expressions like `Organisation.props` or
  // `Repo (Organisation)` (not just the first identifier).
  let rhsChainEnd = rhsEnd;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Skip whitespace between chain segments (e.g. `Repo (X)` with a space).
    let probe = rhsChainEnd;
    while (probe < source.length && /\s/.test(source[probe])) probe++;
    if (probe >= source.length) break;
    const ch = source[probe];
    if (ch === '.' && probe + 1 < source.length && /[A-Za-z_$]/.test(source[probe + 1])) {
      rhsChainEnd = probe + 1;
      while (rhsChainEnd < source.length && /[A-Za-z0-9_$]/.test(source[rhsChainEnd])) rhsChainEnd++;
      continue;
    }
    if (ch === '(') {
      // Skip a balanced parenthesised call argument list.  Track string
      // literals so parens inside strings don't throw off the depth count.
      let depth = 1;
      let i = probe + 1;
      let str: '"' | "'" | '`' | null = null;
      while (i < source.length && depth > 0) {
        const c = source[i];
        if (str) {
          if (c === '\\') { i += 2; continue; }
          if (c === str) str = null;
        } else {
          if (c === '"' || c === "'" || c === '`') str = c as any;
          else if (c === '(') depth++;
          else if (c === ')') depth--;
        }
        i++;
      }
      if (depth !== 0) break;
      rhsChainEnd = i;
      continue;
    }
    break;
  }

  const result = runInference(source, uri, ctx);

  const items: CompletionItem[] = [];

  // 0) Resolve the type of the full RHS expression (member chain ending at
  // `rhsChainEnd`).  When it's a record (or a Union containing a record
  // branch — e.g. query-builder tables), offer its fields.
  if (rhsChainEnd > rhsEnd) {
    const entry = result.nodeTypesByEnd.get(rhsChainEnd);
    if (entry) {
      const resolved = result.substitution.apply(entry.type);
      const fields = resolveRecordFields(resolved, result);
      if (fields) {
        for (const [fieldName, fieldType] of fields) {
          if (!items.some(i => i.label === fieldName)) {
            const ft = result.substitution.apply(fieldType);
            items.push({
              label: fieldName,
              kind: ft.tag === 'TFun' ? CompletionItemKind.Method : CompletionItemKind.Field,
              detail: `${fieldName} :: ${prettyTypeToString(ft)}`,
              labelDetails: { description: prettyTypeToString(ft) },
            });
          }
        }
        if (items.length > 0) return items;
      }
    }
  }

  // 1) Check if the RHS is a default-imported identifier → offer named module exports
  const importSpecifiers = extractImportSpecifiers(source);
  const defaultImportRegex = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  const defaultImports = new Map<string, string>();
  while ((m = defaultImportRegex.exec(source)) !== null) {
    defaultImports.set(m[1], m[2]);
  }

  const moduleSpecifier = defaultImports.get(rhsName);
  if (moduleSpecifier) {
    const targetUri = resolveImportSpecifier(moduleSpecifier, uri);
    if (targetUri) {
      const exports = ctx.inferFileAndCacheExports(targetUri);
      if (exports) {
        for (const [name, scheme] of exports) {
          if (name === 'default') continue;
          const instType = result.substitution.apply(
            safeInstantiate(scheme)
          );
          items.push({
            label: name,
            kind: instType.tag === 'TFun' ? CompletionItemKind.Function : CompletionItemKind.Field,
            detail: `${name} :: ${prettyTypeToString(instType)}`,
          });
        }
      }
    }
  }

  // 2) Check if the RHS has a record type → offer record fields
  for (const [start, { type, end }] of result.nodeTypes) {
    if (start >= rhsStart && start < rhsEnd) {
      const resolved = result.substitution.apply(type);
      if (resolved.tag === 'TRecord') {
        for (const [fieldName, fieldType] of Object.entries(resolved.fields)) {
          if (resolved.hiddenFields?.has(fieldName)) continue;
          if (!items.some(i => i.label === fieldName)) {
            items.push({
              label: fieldName,
              kind: fieldType.tag === 'TFun' ? CompletionItemKind.Method : CompletionItemKind.Field,
              detail: `${fieldName} :: ${prettyTypeToString(fieldType)}`,
              labelDetails: { description: prettyTypeToString(fieldType) },
            });
          }
        }
      }
      if (resolved.tag === 'TCon') {
        const alias = result.typeAliases.get(resolved.name);
        if (alias && alias.type.tag === 'TRecord') {
          for (const [fieldName, fieldType] of Object.entries(alias.type.fields)) {
            if (alias.type.hiddenFields?.has(fieldName)) continue;
            if (!items.some(i => i.label === fieldName)) {
              items.push({
                label: fieldName,
                kind: fieldType.tag === 'TFun' ? CompletionItemKind.Method : CompletionItemKind.Field,
                detail: `${fieldName} :: ${prettyTypeToString(fieldType)}`,
                labelDetails: { description: prettyTypeToString(fieldType) },
              });
            }
          }
        }

        const names = getMethodNames(resolved.name);
        for (const name of names) {
          if (!items.some(i => i.label === name)) {
            const entry = lookupMethod(resolved.name, name);
            if (entry) {
              const methodType = entry.factory(resolved.args);
              items.push({
                label: name,
                kind: CompletionItemKind.Method,
                detail: `${resolved.name}#${name} :: ${prettyTypeToString(resolved)} ~> ${prettyTypeToString(methodType)}`,
              });
            }
          }
        }
      }
      break;
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Import specifier completion — inside import { | } from './module'
// ---------------------------------------------------------------------------

/**
 * Detect if the cursor is inside an import specifier list: `import { | } from './module'`
 * If so, return completions of available exports from the target module.
 */
export function getImportSpecifierCompletions(
  source: string,
  offset: number,
  uri: string,
  ctx: CompletionContext,
): CompletionItem[] | null {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = source.indexOf('\n', offset);
  const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);

  let braceOpen = -1;
  for (let i = offset - 1; i >= lineStart; i--) {
    if (source[i] === '{') { braceOpen = i; break; }
    if (source[i] === '}') break;
  }
  if (braceOpen < 0) return null;

  const beforeBrace = source.substring(Math.max(0, braceOpen - 100), braceOpen).trimEnd();
  if (!/\bimport\s*$/.test(beforeBrace)) return null;

  const fromMatch = line.match(/from\s+['"]([^'"]+)['"]/);
  if (!fromMatch) return null;

  const specifier = fromMatch[1];

  // From here on the cursor is definitely inside an import-specifier list —
  // return [] (not null) on resolution failure so the caller does not fall
  // through to identifier completion, which would nonsensically suggest the
  // current file's own bindings inside `import { | } from '…'`.
  let exports: Map<string, Scheme> | null = null;
  const targetUri = resolveImportSpecifier(specifier, uri);
  if (targetUri) exports = ctx.inferFileAndCacheExports(targetUri);
  if (!exports || exports.size === 0) {
    // The full resolver additionally handles project `.hm` overrides,
    // conventional `hm-types/<pkg>.hm` stubs and package sidecars — the
    // only way to complete `import { useState } from 'react'` typed via
    // a `react.hm` override.
    const resolved = ctx.createImportResolver(uri)(specifier);
    if (resolved instanceof Map) exports = resolved;
  }
  if (!exports) return [];

  const alreadyImported = new Set<string>();
  const insideBraces = source.slice(braceOpen + 1, offset);
  for (const part of insideBraces.split(',')) {
    const name = part.trim().split(/\s+as\s+/)[0]?.trim();
    if (name) alreadyImported.add(name);
  }

  const items: CompletionItem[] = [];
  for (const [name, scheme] of exports) {
    if (name === 'default') continue;
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue; // skip Type#method entries
    if (alreadyImported.has(name)) continue;
    const instType = safeInstantiate(scheme);
    items.push({
      label: name,
      kind: scheme.type.tag === 'TFun' ? CompletionItemKind.Function : CompletionItemKind.Variable,
      detail: `${name} :: ${prettyTypeToString(instType)}`,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Import path completion — inside from '|' or from "./|"
// ---------------------------------------------------------------------------

/**
 * Detect if the cursor is inside a string in 'from' or 'require' — suggest relative file paths.
 */
export function getImportPathCompletions(
  source: string,
  offset: number,
  uri: string,
  ctx: CompletionContext,
): CompletionItem[] | null {
  let quoteChar: string | null = null;
  let quoteStart = -1;
  for (let i = offset - 1; i >= 0; i--) {
    if (source[i] === '\'' || source[i] === '"') {
      quoteChar = source[i];
      quoteStart = i;
      break;
    }
    if (source[i] === '\n') break;
  }
  if (!quoteChar || quoteStart < 0) return null;

  const beforeQuote = source.substring(Math.max(0, quoteStart - 50), quoteStart).trimEnd();
  if (!/\bfrom\s*$/.test(beforeQuote) && !/\brequire\s*\(\s*$/.test(beforeQuote)) return null;

  const partial = source.slice(quoteStart + 1, offset);

  const fromPath = fileURLToPath(uri);
  const fromDir = path.dirname(fromPath);

  let searchDir: string;
  let prefix: string;
  if (partial.includes('/')) {
    const lastSlash = partial.lastIndexOf('/');
    prefix = partial.slice(lastSlash + 1);
    const dirPart = partial.slice(0, lastSlash) || '.';
    searchDir = path.resolve(fromDir, dirPart);
  } else {
    prefix = partial;
    if (!partial.startsWith('.')) {
      return [
        { label: './', kind: CompletionItemKind.Folder, insertText: './' },
        { label: '../', kind: CompletionItemKind.Folder, insertText: '../' },
      ];
    }
    searchDir = path.resolve(fromDir, partial || '.');
    prefix = '';
  }

  try {
    const entries = fs.readdirSync(searchDir, { withFileTypes: true });
    const items: CompletionItem[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;

      if (entry.isDirectory()) {
        if (!prefix || entry.name.startsWith(prefix)) {
          items.push({
            label: entry.name + '/',
            kind: CompletionItemKind.Folder,
            insertText: entry.name + '/',
          });
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) continue;
        const nameWithoutExt = entry.name.replace(/\.(js|mjs|cjs|jsx)$/, '');
        if (!prefix || nameWithoutExt.startsWith(prefix) || entry.name.startsWith(prefix)) {
          const filePath = path.join(searchDir, entry.name);
          const fileUri = pathToFileURL(filePath).href;
          let detail: string | undefined;
          try {
            const exports = ctx.inferFileAndCacheExports(fileUri);
            if (exports) {
              const exportNames = [...exports.keys()].filter(n => n !== 'default');
              if (exportNames.length > 0) {
                detail = `exports: ${exportNames.join(', ')}`;
              }
            }
          } catch { /* inference failed — show file without export detail */ }

          items.push({
            label: nameWithoutExt,
            kind: CompletionItemKind.File,
            detail,
            insertText: nameWithoutExt,
          });
        }
      }
    }
    return items.length > 0 ? items : null;
  } catch { /* directory unreadable — no path completions */
    return null;
  }
}

// ---------------------------------------------------------------------------
// Type directive path completion — inside `// ::types <partial>`
// ---------------------------------------------------------------------------

/**
 * Suggest workspace-relative paths after a `::types` directive in a comment.
 * Triggered when the cursor sits on a line of the form
 * `// ::types <partial>` or `/* ::types <partial>`. Folders end with `/`,
 * JS files appear without their extension. Directories are also valid
 * targets (resolved to their `index.js`).
 */
export function getTypeDirectivePathCompletions(
  source: string,
  offset: number,
  uri: string,
): CompletionItem[] | null {
  if (!isOffsetInComment(source, offset)) return null;

  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const lineBefore = source.slice(lineStart, offset);

  // Match `// ::types ` (or with surrounding * for block comments) followed
  // by a partial path. We require at least one space after `::types`.
  const m = /(?:\/\/|\/\*|\*)\s*::types\s+(\S*)$/.exec(lineBefore);
  if (!m) return null;

  const partial = m[1];

  // Bare specifier (no leading `.` or `/`) — only suggest the leading
  // `./` and `../` prefixes; bare package paths are a separate concern.
  if (partial.length === 0 || (!partial.startsWith('.') && !partial.startsWith('/'))) {
    return [
      {
        label: './',
        kind: CompletionItemKind.Folder,
        insertText: './',
        command: { command: 'editor.action.triggerSuggest', title: 'Re-trigger completions' },
      },
      {
        label: '../',
        kind: CompletionItemKind.Folder,
        insertText: '../',
        command: { command: 'editor.action.triggerSuggest', title: 'Re-trigger completions' },
      },
    ];
  }

  const fromPath = fileURLToPath(uri);
  const fromDir = path.dirname(fromPath);

  let searchDir: string;
  let prefix: string;
  const lastSlash = partial.lastIndexOf('/');
  if (lastSlash >= 0) {
    prefix = partial.slice(lastSlash + 1);
    const dirPart = partial.slice(0, lastSlash) || '.';
    searchDir = path.resolve(fromDir, dirPart);
  } else {
    prefix = '';
    searchDir = path.resolve(fromDir, partial);
  }

  try {
    const entries = fs.readdirSync(searchDir, { withFileTypes: true });
    const items: CompletionItem[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) {
        if (!prefix || entry.name.startsWith(prefix)) {
          items.push({
            label: entry.name + '/',
            kind: CompletionItemKind.Folder,
            insertText: entry.name + '/',
            // Re-trigger completion after the trailing slash so the user can
            // immediately drill into the chosen folder without retyping.
            command: { command: 'editor.action.triggerSuggest', title: 'Re-trigger completions' },
            sortText: '0_' + entry.name,
          });
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) continue;
        const nameWithoutExt = entry.name.replace(/\.(js|mjs|cjs|jsx)$/, '');
        if (!prefix || nameWithoutExt.startsWith(prefix) || entry.name.startsWith(prefix)) {
          items.push({
            label: nameWithoutExt,
            kind: CompletionItemKind.File,
            insertText: nameWithoutExt,
            detail: ext,
            sortText: '1_' + nameWithoutExt,
          });
        }
      }
    }
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Workspace export scanning (for auto-import)
//
// Plain language: to suggest names the user has NOT imported yet, we need to
// know what every other file in the project exports.  Finding that out means
// reading and type-checking those files, which is expensive — so this section
// is mostly about caching: remember each file's exports until it changes on
// disk, warm the cache in the background between keystrokes, and put strict
// limits (file count, time budget) on how much work one request may do.
// ---------------------------------------------------------------------------

/** Maximum number of files to scan for workspace exports to avoid runaway I/O. */
const MAX_SCAN_FILES = 500;

/** Time budget (ms) a single direct {@link getWorkspaceExports} call may
 *  spend inferring not-yet-cached workspace files.  The identifier-
 *  completion request path passes `0` (cache-only): inference there is
 *  driven exclusively by {@link warmWorkspaceExports} in the background,
 *  because a single uncached file can recursively infer its whole import
 *  chain and stall the request for hundreds of ms. */
const WS_SCAN_BUDGET_MS = 40;

/** Per-file workspace-export cache keyed by file URI.  An entry is valid
 *  as long as the file's on-disk mtime is unchanged.  `exports === null`
 *  caches inference failures so broken files aren't re-inferred on every
 *  keystroke; `mtimeMs === null` records an unstattable (deleted) file. */
const fileExportCache = new Map<string, { mtimeMs: number | null; exports: Map<string, Scheme> | null }>();

/** Short-lived mtime cache so a single completion request doesn't issue
 *  one `statSync` per workspace file per keystroke. */
const statCache = new Map<string, { at: number; mtimeMs: number | null }>();
const STAT_TTL_MS = 2000;

/** Short-lived cache of the candidate-file listing per source directory
 *  (readdir of the dir, its subdirs and parent siblings is ~ms but adds
 *  up when repeated on every keystroke). */
const scanListCache = new Map<string, { at: number; files: ScanFile[] }>();
const SCAN_LIST_TTL_MS = 5000;

function statMtime(filePath: string): number | null {
  const now = Date.now();
  const cached = statCache.get(filePath);
  if (cached && now - cached.at < STAT_TTL_MS) return cached.mtimeMs;
  let mtimeMs: number | null = null;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch { /* unreadable/deleted */ }
  statCache.set(filePath, { at: now, mtimeMs });
  return mtimeMs;
}

/** Drop all cached workspace-export entries (tests / globals reload). */
export function clearWorkspaceExportCache(): void {
  fileExportCache.clear();
  statCache.clear();
  scanListCache.clear();
}

/** Evict a single file's cached workspace exports (e.g. on editor edits,
 *  which don't touch the on-disk mtime the cache is keyed by). */
export function invalidateWorkspaceExportEntry(uri: string): void {
  fileExportCache.delete(uri);
}

/** A candidate file discovered by the workspace scan. */
interface ScanFile {
  filePath: string;
  fileUri: string;
  /** Import specifier relative to the scanned-from directory. */
  rel: string;
}

/**
 * Enumerate the JS files the workspace-export scan considers for `uri`:
 * the file's own directory, its subdirectories, the parent directory and
 * the parent's sibling directories — capped at {@link MAX_SCAN_FILES}.
 */
function listWorkspaceScanFiles(uri: string): ScanFile[] {
  const fromPath = fileURLToPath(uri);
  const fromDir = path.dirname(fromPath);

  const listCached = scanListCache.get(fromPath);
  if (listCached && Date.now() - listCached.at < SCAN_LIST_TTL_MS) {
    return listCached.files;
  }

  const dirsToScan = [fromDir];

  const parentDir = path.dirname(fromDir);
  if (parentDir !== fromDir) {
    dirsToScan.push(parentDir);
  }

  try {
    for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        dirsToScan.push(path.join(fromDir, entry.name));
      }
    }
  } catch { /* directory unreadable — scan without subdirs */ }

  // Also scan sibling directories of the parent (one level up), so files in
  // e.g. `src/predicate/` can see exports from `src/more/`.
  if (parentDir !== fromDir) {
    try {
      for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const sibling = path.join(parentDir, entry.name);
        if (sibling === fromDir) continue;
        dirsToScan.push(sibling);
      }
    } catch { /* parent unreadable */ }
  }

  const seen = new Set<string>();
  const files: ScanFile[] = [];

  outer:
  for (const dir of dirsToScan) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { /* directory unreadable */ continue; }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (!['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) continue;
      if (seen.size >= MAX_SCAN_FILES) break outer;

      const filePath = path.join(dir, entry.name);
      if (filePath === fromPath) continue;
      const fileUri = pathToFileURL(filePath).href;
      if (seen.has(fileUri)) continue;
      seen.add(fileUri);

      let rel = path.relative(fromDir, filePath);
      rel = rel.replace(/\\/g, '/');
      rel = rel.replace(/\.(js|mjs|cjs|jsx)$/, '');
      if (!rel.startsWith('.')) rel = './' + rel;

      files.push({ filePath, fileUri, rel });
    }
  }

  scanListCache.set(fromPath, { at: Date.now(), files });
  return files;
}

/**
 * Look up (or compute and cache) the exports of a single scan candidate.
 * Returns `undefined` when the file cannot be stat'ed, `null` when
 * inference failed / produced no exports.
 */
function cachedFileExports(
  file: ScanFile,
  inferFileAndCacheExports: (fileUri: string) => Map<string, Scheme> | null,
): Map<string, Scheme> | null | undefined {
  const mtimeMs = statMtime(file.filePath);
  if (mtimeMs === null) {
    // Record the miss so warming loops don't retry a vanished file forever.
    fileExportCache.set(file.fileUri, { mtimeMs: null, exports: null });
    return undefined;
  }
  const cached = fileExportCache.get(file.fileUri);
  if (cached && cached.mtimeMs === mtimeMs) return cached.exports;

  let exports: Map<string, Scheme> | null = null;
  try {
    exports = inferFileAndCacheExports(file.fileUri);
  } catch { /* inference failure — cache the miss */ }
  fileExportCache.set(file.fileUri, { mtimeMs, exports });
  return exports;
}

/** True when `file` has a valid (mtime-fresh) cache entry. */
function isExportCacheFresh(file: ScanFile): boolean {
  const cached = fileExportCache.get(file.fileUri);
  if (!cached) return false;
  return statMtime(file.filePath) === cached.mtimeMs;
}

/** Cheap regex-based extraction of relative import/require specifiers. */
const RELATIVE_SPEC_RE =
  /require\s*\(\s*['"](\.[^'"]*)['"]\s*\)|from\s+['"](\.[^'"]*)['"]/g;

function relativeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(RELATIVE_SPEC_RE)) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

/** Resolve a relative specifier to an existing JS file path, or null. */
function resolveRelativeSpec(fromPath: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromPath), spec);
  const candidates = /\.(js|mjs|cjs|jsx)$/.test(base)
    ? [base]
    : [base + '.js', base + '.mjs', base + '.cjs', base + '.jsx', path.join(base, 'index.js'), path.join(base, 'index.jsx')];
  for (const cand of candidates) {
    if (statMtime(cand) !== null) return cand;
  }
  return null;
}

/**
 * Walk `file`'s not-yet-cached transitive dependencies and return the
 * "coldest leaf": an uncached file none of whose own deps are uncached.
 * Warming leaves first keeps each warm step roughly one file's inference
 * cost — inferring a barrel file with a cold import chain would otherwise
 * synchronously infer the whole chain (seconds in large repos).
 */
function findColdLeaf(file: ScanFile, visited: Set<string>): ScanFile {
  if (visited.has(file.filePath) || visited.size > 100) return file;
  visited.add(file.filePath);
  let source: string;
  try {
    source = fs.readFileSync(file.filePath, 'utf8');
  } catch {
    return file;
  }
  for (const spec of relativeSpecifiers(source)) {
    const depPath = resolveRelativeSpec(file.filePath, spec);
    if (!depPath || visited.has(depPath)) continue;
    const dep: ScanFile = {
      filePath: depPath,
      fileUri: pathToFileURL(depPath).href,
      rel: '',
    };
    if (isExportCacheFresh(dep)) continue;
    return findColdLeaf(dep, visited);
  }
  return file;
}

/**
 * Incrementally warm the workspace-export cache for `uri`: infer up to
 * `maxFiles` not-yet-cached candidate files (dependency-leaves first) and
 * cache their exports.  Returns `true` when every candidate is cached
 * (warming complete).
 *
 * The server calls this from a background timer loop after validation, so
 * the first identifier completion doesn't have to pay for a full workspace
 * scan (~seconds in large repos) on the request path.
 */
export function warmWorkspaceExports(
  uri: string,
  inferFileAndCacheExports: (fileUri: string) => Map<string, Scheme> | null,
  maxFiles: number = 2,
): boolean {
  const files = listWorkspaceScanFiles(uri);

  // Scan-triggered inference must not corrupt the built-in method registry
  // (see getWorkspaceExports below for the full rationale).
  const builtinSnap = snapshotBuiltinOriginalEntries();
  let warmed = 0;
  try {
    for (const file of files) {
      if (isExportCacheFresh(file)) continue;
      if (warmed >= maxFiles) return false;
      // Warm the coldest transitive dependency instead of `file` itself:
      // its own turn comes on a later call, by which time its chain is
      // cached and inferring it is cheap.
      const leaf = findColdLeaf(file, new Set());
      cachedFileExports(leaf, inferFileAndCacheExports);
      warmed++;
      if (leaf.filePath !== file.filePath) return false;
    }
    return true;
  } finally {
    restoreBuiltinOriginalEntries(builtinSnap);
  }
}

/**
 * Scan the workspace directory (same folder and common relatives) for JS files
 * that export symbols. Returns a map from export name to sources.
 *
 * Per-file results are cached by mtime, so only new/changed files pay for
 * inference.  Uncached files are inferred until `budgetMs` is exhausted;
 * the rest are skipped this round (their results appear on later requests
 * or via {@link warmWorkspaceExports}).  This keeps a single completion
 * request bounded instead of synchronously inferring hundreds of files.
 */
export function getWorkspaceExports(
  uri: string,
  inferFileAndCacheExports: (fileUri: string) => Map<string, Scheme> | null,
  budgetMs: number = WS_SCAN_BUDGET_MS,
): Map<string, { specifier: string; scheme: Scheme; fileUri: string; isDefault?: boolean }[]> {
  const start = Date.now();
  const files = listWorkspaceScanFiles(uri);
  const result = new Map<string, { specifier: string; scheme: Scheme; fileUri: string; isDefault?: boolean }[]>();

  // Scan-triggered inferences must NOT corrupt the global method registry:
  // a workspace-sibling file may contain a shorthand annotation like
  // `// Array.every :: (a -> Boolean) -> Array a -> Boolean` whose static
  // registration overwrites the built-in instance `Array.every` factory
  // (kept on the same key).  After completion finishes, the corrupted
  // entry would surface as bogus diagnostics on legitimate `arr.every(...)`
  // calls (e.g. `Cannot unify '[a] -> Boolean' with 'Boolean'`).
  // Snapshot the current original-key built-in entries before the scan and
  // restore them afterwards.  Custom additions on non-original keys are
  // preserved, so completion can still suggest workspace exports normally.
  const builtinSnap = snapshotBuiltinOriginalEntries();
  try {
    for (const file of files) {
      // Budget check only gates *uncached* files: assembling cached
      // entries is cheap and always allowed.  A zero budget makes the
      // scan cache-only (used by the completion request path).
      if (!isExportCacheFresh(file) && Date.now() - start >= budgetMs) continue;

      const exports = cachedFileExports(file, inferFileAndCacheExports);
      if (!exports) continue;

      for (const [name, scheme] of exports) {
        if (name === 'default') {
          const stem = path.basename(file.filePath, path.extname(file.filePath));
          if (!result.has(stem)) result.set(stem, []);
          result.get(stem)!.push({ specifier: file.rel, scheme, fileUri: file.fileUri, isDefault: true });
          continue;
        }
        if (!result.has(name)) result.set(name, []);
        result.get(name)!.push({ specifier: file.rel, scheme, fileUri: file.fileUri });
      }
    }
  } finally {
    restoreBuiltinOriginalEntries(builtinSnap);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Auto-import text edit builders
// ---------------------------------------------------------------------------

/**
 * Detect whether a JS source file uses ES module syntax or CommonJS.
 * Heuristic: a top-level `import`/`export` keyword => ESM; otherwise if it
 * contains `require(` or `module.exports` => CJS.  Defaults to ESM when
 * unclear.
 */
export function detectModuleStyle(source: string): 'esm' | 'cjs' {
  const lines = source.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue;
    if (/^(import\s|export\s)/.test(trimmed)) return 'esm';
  }
  if (/\brequire\s*\(/.test(source) || /\bmodule\.exports\b/.test(source) || /\bexports\.\w+\s*=/.test(source)) {
    return 'cjs';
  }
  return 'esm';
}

/**
 * Build a text edit that inserts an import line at the top of the file.
 * Tries to append to an existing import from the same specifier if present.
 * Emits an `import` statement for ESM files and a `require` statement for
 * CJS files (detected via {@link detectModuleStyle}).
 */
export function buildAutoImportEdit(
  source: string,
  name: string,
  specifier: string,
  isDefault?: boolean,
): TextEdit {
  const style = detectModuleStyle(source);
  const escapedSpecifier = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // For named imports, try to append to an existing braces-group with the
  // same specifier (works for both `import { X } from '…'` and
  // `const { X } = require('…')`).
  if (!isDefault) {
    const importRegex = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapedSpecifier}['"]`, 'g');
    const importMatch = importRegex.exec(source);
    if (importMatch) {
      return appendToNamedImportBraces(source, importMatch, name);
    }

    const requireRegex = new RegExp(`const\\s*\\{([^}]*)\\}\\s*=\\s*require\\s*\\(\\s*['"]${escapedSpecifier}['"]\\s*\\)`, 'g');
    const requireMatch = requireRegex.exec(source);
    if (requireMatch) {
      return appendToNamedImportBraces(source, requireMatch, name);
    }
  }

  let insertLine = 0;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(import\s|const\s.*=\s*require\s*\()/.test(lines[i])) {
      insertLine = i + 1;
    }
  }

  let newImportText: string;
  if (style === 'cjs') {
    newImportText = isDefault
      ? `const ${name} = require('${specifier}');\n`
      : `const { ${name} } = require('${specifier}');\n`;
  } else {
    newImportText = isDefault
      ? `import ${name} from '${specifier}';\n`
      : `import { ${name} } from '${specifier}';\n`;
  }
  return TextEdit.insert({ line: insertLine, character: 0 }, newImportText);
}

/**
 * Append a name to an existing named import's braces (works for both
 * `import { X } from '...'` and `const { X } = require('...')`).
 */
function appendToNamedImportBraces(
  source: string,
  match: RegExpExecArray,
  name: string,
): TextEdit {
  const bracePos = match.index! + match[0].indexOf('}');
  let nameEnd = bracePos;
  while (nameEnd > 0 && /\s/.test(source[nameEnd - 1])) nameEnd--;
  let startLine = 0;
  let startNl = -1;
  for (let i = 0; i < nameEnd; i++) {
    if (source[i] === '\n') { startLine++; startNl = i; }
  }
  const startChar = nameEnd - startNl - 1;
  let endLine = startLine;
  let endNl = startNl;
  for (let i = nameEnd; i <= bracePos; i++) {
    if (source[i] === '\n') { endLine++; endNl = i; }
  }
  const endChar = (bracePos + 1) - endNl - 1;
  const trailingComma = source[nameEnd - 1] === ',';
  const newText = trailingComma ? ` ${name} }` : `, ${name} }`;
  return TextEdit.replace(
    { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } },
    newText,
  );
}

// ---------------------------------------------------------------------------
// Identifier completion with type info + auto-import suggestions
// ---------------------------------------------------------------------------

/**
 * Get identifier completions: all in-scope variables with their types,
 * plus auto-import suggestions from nearby files.
 *
 * Plain language: the user is typing a bare name (not after a dot, not in a
 * string or comment).  We offer:
 *   1. every top-level binding in this file whose name starts with what has
 *      been typed so far, labelled with its type (preferring the user's own
 *      `::` annotation text over the machine-printed type);
 *   2. local variables in the enclosing scopes;
 *   3. optionally, exports from OTHER workspace files not yet imported —
 *      picking one of those also inserts the matching `import` line
 *      automatically (see `buildAutoImportEdit`).
 */
export function getIdentifierCompletions(
  source: string,
  offset: number,
  uri: string,
  ctx: CompletionContext,
): CompletionItem[] {
  const wordStart = scanWord(source, offset)?.start ?? offset;
  const partial = source.slice(wordStart, offset);

  if (wordStart > 0 && source[wordStart - 1] === '.') return [];

  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const lineBefore = source.slice(lineStart, wordStart);
  if (/\/\//.test(lineBefore)) return [];
  let singleQuotes = 0, doubleQuotes = 0, backticks = 0;
  for (const ch of lineBefore) {
    if (ch === '\'') singleQuotes++;
    if (ch === '"') doubleQuotes++;
    if (ch === '`') backticks++;
  }
  if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0 || backticks % 2 !== 0) return [];

  const result = ctx.cachedResult ?? runInference(source, uri, ctx);

  const items: CompletionItem[] = [];
  const addedNames = new Set<string>();
  const formatType = ctx.inferredTypeStyle === 'pretty' ? prettyTypeToString : typeToString;
  const importMap = extractImportSpecifiers(source);

  for (const [name, scheme] of result.topLevelBindings) {
    if (partial && !name.startsWith(partial)) continue;
    if (addedNames.has(name)) continue;
    addedNames.add(name);

    // Prefer the user's verbatim annotation text when available, so the
    // completion detail matches exactly what they wrote in their `::`
    // signature (parens, whitespace, ordering).  Lookup chain:
    //   1. local annotation in this file
    //   2. raw signature from a `.hm` sidecar of an imported binding
    //   3. fall back to pretty-printed inferred type
    const ann = result.annotations.get(name);
    const resolvedType = result.substitution.apply(scheme.type);
    let typeStr: string;
    if (ann?.raw && !ann.receiver) {
      typeStr = ann.raw;
    } else {
      const importSpec = importMap.get(name);
      const importedRaw = importSpec && ctx.getImportedRawSignature
        ? ctx.getImportedRawSignature(importSpec, name, uri)
        : null;
      typeStr = importedRaw ?? formatType(resolvedType);
    }
    const kind = resolvedType.tag === 'TFun'
      ? CompletionItemKind.Function
      : CompletionItemKind.Variable;

    items.push({
      label: name,
      kind,
      detail: typeStr,
      sortText: `0_${name}`,
    });
  }

  // Include local/scoped identifiers (function params, block-scoped vars)
  // that aren't in topLevelBindings.
  const scopeNames = collectScopeBindings(source, offset);
  for (const [name, declOffset] of scopeNames) {
    if (partial && !name.startsWith(partial)) continue;
    if (addedNames.has(name)) continue;
    addedNames.add(name);

    // Look up the inferred type from nodeTypes using the declaration offset
    let detail: string | undefined;
    const entry = result.nodeTypes.get(declOffset);
    if (entry) {
      detail = formatType(result.substitution.apply(entry.type));
    }

    const kind = entry && result.substitution.apply(entry.type).tag === 'TFun'
      ? CompletionItemKind.Function
      : CompletionItemKind.Variable;

    items.push({
      label: name,
      kind,
      detail,
      sortText: `0_${name}`,
    });
  }

  // Annotation names that don't yet have a binding (signature written, implementation pending).
  // Extract directly from comment text so this works even when the source has syntax errors
  // (e.g. the user is typing `const testN` and hasn't finished the declaration yet).
  const annNameRegex = /\/\/\s*([\w$]+)\s*::\s*(.+)/g;
  let annMatch;
  while ((annMatch = annNameRegex.exec(source)) !== null) {
    const name = annMatch[1];
    if (addedNames.has(name)) continue;
    if (name.includes('#') || name.includes('.')) continue;
    if (/^[A-Z]/.test(name)) continue; // skip type aliases / constructors
    if (partial && !name.startsWith(partial)) continue;
    addedNames.add(name);

    items.push({
      label: name,
      kind: CompletionItemKind.Function,
      detail: annMatch[2].trim(),
      sortText: `0_${name}`,
    });
  }

  if (partial.length >= 2 && ctx.autoImports !== false) {
    const alreadyImported = new Set(result.topLevelBindings.keys());
    // Cache-only (budget 0): auto-import suggestions come from the
    // background-warmed workspace-export cache.  Never infer on the
    // completion request path — in large repos that meant multi-second
    // freezes that also stalled queued diagnostics.
    const workspaceExports = getWorkspaceExports(uri, ctx.inferFileAndCacheExports, 0);

    for (const [name, sources] of workspaceExports) {
      if (!name.startsWith(partial)) continue;
      if (alreadyImported.has(name)) continue;
      if (addedNames.has(name)) continue;
      addedNames.add(name);

      const { specifier, scheme, isDefault } = sources[0];
      const instType = safeInstantiate(scheme);
      const typeStr = formatType(instType);
      const kind = instType.tag === 'TFun'
        ? CompletionItemKind.Function
        : CompletionItemKind.Variable;

      items.push({
        label: name,
        kind,
        detail: `${typeStr}  (from '${specifier}')`,
        sortText: `1_${name}`,
        additionalTextEdits: [buildAutoImportEdit(source, name, specifier, isDefault)],
      });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Dot completion — expr.|
// ---------------------------------------------------------------------------

/**
 * Build completion items for constraint methods.
 *
 * - `kind: 'static'` selects methods *without* `~>` (used for plain TVar /
 *   constructor-position completions). Constraint names may be applied
 *   forms like `"Monoid (f a)"` and are reduced to their base name.
 * - `kind: 'instance'` selects methods *with* `~>` (used for kv-TCon /
 *   value-position completions, e.g. `functor.map`). The signature is
 *   the part after `~>`.
 */
function buildConstraintCompletionItems(
  cNames: string[] | undefined,
  kind: 'static' | 'instance',
): CompletionItem[] {
  if (!cNames) return [];
  const items: CompletionItem[] = [];
  for (const cName of cNames) {
    const baseName = kind === 'static' ? constraintBaseName(cName) : cName;
    const def = lookupConstraint(baseName);
    if (!def) continue;
    const effectiveMethods = getEffectiveMethods(baseName);
    for (const req of effectiveMethods) {
      const hasInstanceArrow = req.signature.includes('~>');
      if (kind === 'static' && hasInstanceArrow) continue;
      if (kind === 'instance' && !hasInstanceArrow) continue;
      const methodSig = kind === 'instance'
        ? req.signature.split('~>')[1].trim()
        : req.signature;
      const isFunction = kind === 'instance' || req.signature.includes('->');
      items.push({
        label: req.name,
        kind: isFunction ? CompletionItemKind.Method : CompletionItemKind.Field,
        detail: `[${baseName}] ${req.name} :: ${methodSig}`,
      });
    }
  }
  return items;
}

const buildStaticConstraintCompletionItems = (cNames: string[] | undefined): CompletionItem[] =>
  buildConstraintCompletionItems(cNames, 'static');

const buildInstanceConstraintCompletionItems = (cNames: string[] | undefined): CompletionItem[] =>
  buildConstraintCompletionItems(cNames, 'instance');

/**
 * Build completion items for the registered methods of `typeName`, picking
 * either instance methods (`#`) or static methods (`.`) and formatting the
 * detail line as `Type#name :: ...` or `Type.name :: ...`.
 *
 * `selfType` is the concrete carrier type used in the receiver display.  For
 * static-only completions where the carrier is unused, pass the same TCon.
 */
function methodCompletionsForType(
  typeName: string,
  typeArgs: Type[],
  kind: 'instance' | 'static',
  selfDisplay?: string,
  includePrivate: boolean = false,
): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const name of getMethodNames(typeName)) {
    // Statics colliding with an instance of the same name live in the
    // parallel namespace and are reachable only via lookupStaticMethod.
    // For static completion we prefer the static side; for instance
    // completion we prefer the instance side.
    const entry = kind === 'static'
      ? (lookupStaticMethod(typeName, name) ?? lookupMethod(typeName, name))
      : lookupMethod(typeName, name);
    if (!entry) continue;
    const isPriv = !!entry.private || isMethodPrivate(typeName, name);
    // Hidden via ::hidden (not ::private) is always filtered.
    const hiddenByOther = (!!entry.hidden || isMethodHidden(typeName, name)) && !isPriv;
    if (hiddenByOther) continue;
    // Private members are filtered unless completing on `this.`.
    if (isPriv && !includePrivate) continue;
    // `constructor` is implicitly hidden — every JS object has one and
    // surfacing it as a completion entry is rarely what the user wants.
    if (name === 'constructor') continue;
    const isStatic = !!entry.isStatic;
    if (kind === 'instance' && isStatic) continue;
    if (kind === 'static' && !isStatic) continue;
    const methodType = entry.factory(typeArgs);
    const detail = kind === 'instance'
      ? `${typeName}#${name} :: ${selfDisplay} ~> ${prettyTypeToString(methodType)}`
      : `${typeName}.${name} :: ${prettyTypeToString(methodType)}`;
    items.push({
      label: name,
      kind: CompletionItemKind.Method,
      detail,
    });
  }
  // Record-style sumtype variants name the fields they carry
  // (`Component :: | Engine { ext :: String, ... }`).  A `Component ~>`
  // method reads those off `this`, so surface them as instance completions
  // even though they aren't registered methods.
  if (kind === 'instance') {
    for (const [fieldName, fieldTypeText] of getVariantRecordFields(typeName)) {
      if (items.some(i => i.label === fieldName)) continue;
      items.push({
        label: fieldName,
        kind: CompletionItemKind.Field,
        detail: `${typeName}#${fieldName} :: ${fieldTypeText}`,
      });
    }
  }
  return items;
}

/**
 * Provide completions for bracket string access: `obj["` or `obj['`.
 * Suggests record field names when the object has a known TRecord type.
 */
export function getBracketStringCompletions(
  source: string,
  offset: number,
  uri: string,
  ctx: CompletionContext,
): CompletionItem[] {
  // Detect pattern: identifier["  or identifier['
  // offset points right after the quote character
  const quoteIdx = offset - 1;
  if (quoteIdx < 1) return [];
  const quote = source[quoteIdx];
  if (quote !== '"' && quote !== "'") return [];
  const bracketIdx = quoteIdx - 1;
  if (source[bracketIdx] !== '[') return [];

  // Find the identifier before the bracket
  const identEnd = bracketIdx;
  const ident = scanWord(source, identEnd);
  if (!ident) return [];
  const objName = source.slice(ident.start, identEnd);
  if (!objName) return [];

  // Patch out the incomplete bracket expression so inference doesn't choke.
  // Replace from '[' to end-of-line (or next ']'/';') with spaces.
  let patchEnd = offset;
  while (patchEnd < source.length && source[patchEnd] !== '\n' && source[patchEnd] !== ';') patchEnd++;
  const patched = source.substring(0, bracketIdx) + ' '.repeat(patchEnd - bracketIdx) + source.substring(patchEnd);

  const result = runInference(patched, uri, ctx);

  // Find the type of the object identifier
  let bestType: Type | null = null;
  let bestStart = -1;
  for (const [start, { type }] of result.nodeTypes) {
    const nodeText = patched.substring(start, start + objName.length);
    if (nodeText === objName && start <= ident.start && start > bestStart) {
      bestType = result.substitution.apply(type);
      bestStart = start;
    }
  }

  if (!bestType || bestType.tag !== 'TRecord') return [];

  const items: CompletionItem[] = [];
  for (const [fieldName, fieldType] of Object.entries(bestType.fields)) {
    if (bestType.hiddenFields?.has(fieldName)) continue;
    items.push({
      label: fieldName,
      kind: fieldType.tag === 'TFun' ? CompletionItemKind.Method : CompletionItemKind.Field,
      detail: `${fieldName} :: ${prettyTypeToString(fieldType)}`,
      labelDetails: { description: prettyTypeToString(fieldType) },
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Table-selector completion: PascalCase(["| or PascalCase([ "x", | ])
// ---------------------------------------------------------------------------

/**
 * When the cursor sits inside an array literal that is the argument of a
 * PascalCase call (e.g. `User([ | ])` from a query-builder `Table` factory), suggest
 * the literal-string selector members of the callee's parameter type.
 *
 * Resolves the callee's annotated overloads, picks any branch whose param is
 * `[Selector]`, expands `Selector` through type-aliases / unions and collects
 * every TLabel-lit value as a completion item.  String selectors already
 * present in the literal are filtered out.
 */
export function getTableSelectorCompletions(
  source: string,
  offset: number,
  uri: string,
  ctx: CompletionContext,
): CompletionItem[] {
  // Skip dot-completion contexts.
  if (offset > 0 && source[offset - 1] === '.') return [];

  // 1. Find the enclosing `[` at depth 0 (treating ()/{}/[] as containers).
  let depth = 0;
  let openBracketOffset = -1;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = source[i];
    if (ch === ']' || ch === ')' || ch === '}') depth++;
    else if (ch === '[') {
      if (depth === 0) { openBracketOffset = i; break; }
      depth--;
    } else if (ch === '(' || ch === '{') {
      if (depth === 0) return [];
      depth--;
    } else if (ch === ';') return [];
  }
  if (openBracketOffset < 0) return [];

  // 2. The `[` must be directly preceded by `(` (modulo whitespace).
  let i = openBracketOffset - 1;
  while (i >= 0 && /\s/.test(source[i])) i--;
  if (i < 0 || source[i] !== '(') return [];

  // 3. Identifier directly before the `(`.
  let identEnd = i - 1;
  while (identEnd >= 0 && /\s/.test(source[identEnd])) identEnd--;
  const identInfo = scanWord(source, identEnd + 1);
  if (!identInfo) return [];
  const calleeName = source.slice(identInfo.start, identEnd + 1);
  if (!calleeName || !/^[A-Z]/.test(calleeName)) return [];

  // 4. Patch the array contents to spaces so inference doesn't choke on a
  //    half-typed literal at the cursor.
  let closeBracketOffset = -1;
  let d = 1;
  for (let j = openBracketOffset + 1; j < source.length; j++) {
    const ch = source[j];
    if (ch === '[') d++;
    else if (ch === ']') { d--; if (d === 0) { closeBracketOffset = j; break; } }
  }
  const patchEnd = closeBracketOffset > 0 ? closeBracketOffset : source.indexOf('\n', offset);
  if (patchEnd < openBracketOffset + 1) return [];
  const patched = source.substring(0, openBracketOffset + 1)
    + ' '.repeat(patchEnd - openBracketOffset - 1)
    + source.substring(patchEnd);

  const result = runInference(patched, uri, ctx);

  // 5. Locate the callee's recorded type.
  let calleeType: Type | null = null;
  for (const [start, { type, end }] of result.nodeTypes) {
    if (start === identInfo.start && end === identEnd + 1) {
      calleeType = result.substitution.apply(type);
      break;
    }
  }
  if (!calleeType) {
    // Fallback: any node starting at the identifier start.
    for (const [start, { type }] of result.nodeTypes) {
      if (start === identInfo.start) { calleeType = result.substitution.apply(type); break; }
    }
  }
  if (!calleeType) return [];

  // 6. Walk overload branches; collect param types of `[Selector]` shape.
  const selectorTypes: Type[] = [];
  const collectArrayParam = (t: Type): void => {
    const r = result.substitution.apply(t);
    if (r.tag === 'TCon' && r.name === T_UNION) {
      for (const b of r.args) collectArrayParam(b);
      return;
    }
    if (r.tag === 'TFun') {
      const p = result.substitution.apply(r.param);
      if (p.tag === 'TCon' && p.name === T_ARRAY && p.args.length === 1) {
        selectorTypes.push(p.args[0]);
      }
    }
  };
  collectArrayParam(calleeType);
  if (selectorTypes.length === 0) return [];

  // 7. Expand selector types: follow alias TCon -> Union -> TLabel-lit leaves.
  const labels = new Set<string>();
  const seen = new Set<string>();
  const expand = (t: Type): void => {
    const r = result.substitution.apply(t);
    if (r.tag === 'TLabel' && r.kind === 'lit') {
      labels.add(r.value);
      return;
    }
    if (r.tag === 'TCon') {
      if (r.name === T_UNION) {
        for (const b of r.args) expand(b);
        return;
      }
      if (seen.has(r.name)) return;
      seen.add(r.name);
      const alias = result.typeAliases.get(r.name);
      if (alias) expand(alias.type);
    }
  };
  for (const s of selectorTypes) expand(s);
  if (labels.size === 0) return [];

  // 8. Filter strings already present between `[` and the cursor.
  const present = new Set<string>();
  const before = source.substring(openBracketOffset + 1, offset);
  const stringRe = /["']([^"'\\]*)["']/g;
  let sm: RegExpExecArray | null;
  while ((sm = stringRe.exec(before)) !== null) present.add(sm[1]);

  // 9. Determine whether the cursor sits inside an unterminated quote.
  let inQuote = false;
  let quoteChar = '';
  for (let j = openBracketOffset + 1; j < offset; j++) {
    const ch = source[j];
    if (!inQuote && (ch === '"' || ch === "'")) { inQuote = true; quoteChar = ch; }
    else if (inQuote && ch === quoteChar && source[j - 1] !== '\\') { inQuote = false; }
  }

  const items: CompletionItem[] = [];
  for (const lbl of labels) {
    if (present.has(lbl)) continue;
    const insert = inQuote ? lbl : `"${lbl}"`;
    items.push({
      label: insert,
      kind: CompletionItemKind.Field,
      detail: `selector :: '${lbl}'`,
      filterText: lbl,
      insertText: insert,
      sortText: `0_${lbl}`,
    });
  }
  return items;
}

/** Result of resolving the type of the expression before a dot. */
interface DotTypeResolution {
  bestType: Type;
  rawBestType: Type | null;
  result: InferenceResult;
  objName: string;
  effectiveSource: string;
  objStart: number;
  objEnd: number;
}

/**
 * Determine the type of the expression just before the dot, using fallback
 * strategies (re-parsing with patched source) when direct lookup fails.
 *
 * Plain language: when the user types `something.` the file is momentarily
 * broken JavaScript (the dot has nothing after it), so the type checker may
 * fail to produce a type for `something`.  This function tries harder:
 *   1. First, run inference on the source as-is and look for a typed node
 *      that ends exactly at the dot.  Often this just works.
 *   2. If not, "patch" the source: blank out the dot and the half-typed
 *      member name with spaces, so the file parses cleanly again, then run
 *      inference on the patched copy and look up the expression's type at
 *      the same position.  Three patch flavours handle the receiver ending
 *      in `)`/`]` (a call or index), a literal (`"`, `'`, `` ` ``, `/`),
 *      or a plain identifier / dotted chain.
 */
function resolveTypeBeforeDot(
  source: string,
  offset: number,
  dotIdx: number,
  uri: string,
  ctx: CompletionContext,
): DotTypeResolution | null {
  // When the dot is on its own line (e.g. `arr\n.map`), scan backwards
  // past whitespace to collapse the newline.
  let effectiveSource = source;
  let effectiveDotIdx = dotIdx;
  let effectiveOffset = offset;
  {
    let exprEnd = dotIdx - 1;
    while (exprEnd >= 0 && /[\s]/.test(source[exprEnd])) exprEnd--;
    if (exprEnd >= 0 && exprEnd < dotIdx - 1) {
      const lastChar = source[exprEnd];
      if (/[A-Za-z0-9_$)\]'"`]/.test(lastChar)) {
        const gap = dotIdx - exprEnd - 1;
        effectiveSource = source.substring(0, exprEnd + 1) + source.substring(dotIdx);
        effectiveDotIdx = exprEnd + 1;
        effectiveOffset = offset - gap;
      }
    }
  }

  let result = ctx.engine.infer(effectiveSource, undefined, ctx.createImportResolver(uri), ctx.createTypeDirectiveResolver(uri), ctx.createImportTypeAliasResolver?.(uri));

  const objEnd = effectiveDotIdx;
  const objStart = scanWord(effectiveSource, objEnd)?.start ?? objEnd;
  const objName = effectiveSource.slice(objStart, objEnd);

  let bestType: Type | null = null;
  let rawBestType: Type | null = null;
  let bestStart = -1;
  for (const [start, { type, end }] of result.nodeTypes) {
    // The receiver of `expr.member` must end exactly at the dot.  Nodes
    // that extend past the dot are containers (the enclosing call, the
    // whole assignment, etc.) and accepting them would surface methods
    // for the wrong type — e.g. typing `orgs[0].` inside a `.map(...)`
    // callback would otherwise pick the outer `RTask` assignment.
    if (end !== effectiveDotIdx) continue;
    if (start > bestStart) {
      const resolved = result.substitution.apply(type);
      // Skip $error sentinels so the patched-source fallback cases below
      // get a chance to recover the real type (e.g. for `expr().` where
      // the trailing dot causes a parse/inference error on the assignment).
      if (isErrorType(resolved)) continue;
      bestType = resolved;
      rawBestType = type;
      bestStart = start;
    }
  }

  if (!bestType) {
    const charBeforeDot = effectiveDotIdx > 0 ? effectiveSource[effectiveDotIdx - 1] : '';

    // Case 1: expression ending with ')' or ']' before the dot
    if (charBeforeDot === ')' || charBeforeDot === ']') {
      let patchEnd = effectiveOffset;
      while (patchEnd < effectiveSource.length && /[A-Za-z0-9_$]/.test(effectiveSource[patchEnd])) patchEnd++;
      const patchLen = patchEnd - effectiveDotIdx;
      const patched = effectiveSource.substring(0, effectiveDotIdx) + ' '.repeat(patchLen) + effectiveSource.substring(patchEnd);
      result = ctx.engine.infer(patched, undefined, ctx.createImportResolver(uri), ctx.createTypeDirectiveResolver(uri), ctx.createImportTypeAliasResolver?.(uri));

      const entry = result.nodeTypesByEnd.get(effectiveDotIdx);
      if (entry) {
        const resolved = result.substitution.apply(entry.type);
        if (resolved.tag === 'TCon' || resolved.tag === 'TRecord' || resolved.tag === 'TFun' || resolved.tag === 'TVar') {
          bestType = resolved;
        }
      }

      if (charBeforeDot === ']' && (!bestType || bestType.tag === 'TVar' || (bestType.tag === 'TCon' && bestType.name !== T_ARRAY))) {
        const patch = patchArrayLiteralASI(effectiveSource, effectiveDotIdx - 1);
        if (patch) {
          const patched2 = patch.patched.substring(0, effectiveDotIdx + patch.shift) + ' '.repeat(patchLen)
            + patch.patched.substring(patchEnd + patch.shift);
          const result2 = ctx.engine.infer(patched2, undefined, ctx.createImportResolver(uri), ctx.createTypeDirectiveResolver(uri), ctx.createImportTypeAliasResolver?.(uri));
          const entry2 = result2.nodeTypesByEnd.get(effectiveDotIdx + patch.shift);
          if (entry2) {
            const resolved2 = result2.substitution.apply(entry2.type);
            if (resolved2.tag === 'TCon' && resolved2.name === T_ARRAY) {
              bestType = resolved2;
              result = result2;
            }
          }
        }
      }
    }

    // Case 2: literal expression ending with ", ', ` or / before the dot
    if (!bestType) {
      const litChar = effectiveDotIdx > 0 ? effectiveSource[effectiveDotIdx - 1] : '';
      if (litChar === '"' || litChar === "'" || litChar === '`' || litChar === '/') {
        let patchEnd = effectiveOffset;
        while (patchEnd < effectiveSource.length && /[A-Za-z0-9_$]/.test(effectiveSource[patchEnd])) patchEnd++;
        const patchLen = patchEnd - effectiveDotIdx;
        const patched = effectiveSource.substring(0, effectiveDotIdx) + ' '.repeat(patchLen) + effectiveSource.substring(patchEnd);
        result = ctx.engine.infer(patched, undefined, ctx.createImportResolver(uri), ctx.createTypeDirectiveResolver(uri), ctx.createImportTypeAliasResolver?.(uri));

        const entry = result.nodeTypesByEnd.get(effectiveDotIdx);
        if (entry) {
          const resolved = result.substitution.apply(entry.type);
          if (resolved.tag === 'TCon' || resolved.tag === 'TRecord' || resolved.tag === 'TFun' || resolved.tag === 'TVar') {
            bestType = resolved;
          }
        }
      }
    }

    // Case 3: identifier before the dot
    if (!bestType) {
    const identEnd = effectiveDotIdx;
    const identStart = scanWord(effectiveSource, identEnd)?.start ?? identEnd;
    const identName = effectiveSource.slice(identStart, identEnd);

    let chainStart = identStart;
    while (chainStart > 0 && effectiveSource[chainStart - 1] === '.') {
      chainStart--;
      chainStart = scanWord(effectiveSource, chainStart)?.start ?? chainStart;
    }
    const isChain = chainStart < identStart;

    let patchEnd = effectiveOffset;
    while (patchEnd < effectiveSource.length && /[A-Za-z0-9_$]/.test(effectiveSource[patchEnd])) patchEnd++;

    const patchLen = patchEnd - effectiveDotIdx;
    const patched = effectiveSource.substring(0, effectiveDotIdx) + ' '.repeat(patchLen) + effectiveSource.substring(patchEnd);
    result = ctx.engine.infer(patched, undefined, ctx.createImportResolver(uri), ctx.createTypeDirectiveResolver(uri), ctx.createImportTypeAliasResolver?.(uri));

    if (isChain) {
      for (const [start, { type, end }] of result.nodeTypes) {
        if (start >= chainStart && end >= effectiveDotIdx - 1 && end <= effectiveDotIdx + 1) {
          const resolved = result.substitution.apply(type);
          if (resolved.tag === 'TCon' || resolved.tag === 'TRecord' || resolved.tag === 'TFun' || resolved.tag === 'TVar') {
            if (start > bestStart) {
              bestType = resolved;
              rawBestType = type;
              bestStart = start;
            }
          }
        }
      }
    } else if (identName) {
      for (const [start, { type, end }] of result.nodeTypes) {
        const resolved = result.substitution.apply(type);
        if (resolved.tag === 'TCon' || resolved.tag === 'TRecord' || resolved.tag === 'TFun' || resolved.tag === 'TVar') {
          const nodeText = patched.substring(start, start + identName.length);
          if (nodeText === identName && start <= identStart && start > bestStart) {
            bestType = resolved;
            rawBestType = type;
            bestStart = start;
          }
        }
      }
    }
    } // end case 3
  }

  if (!bestType) return null;
  return { bestType, rawBestType, result, objName, effectiveSource, objStart, objEnd };
}

/**
 * Provide completions after a dot: methods, fields, and constraint methods.
 *
 * Plain language: first figure out the type of the thing before the dot
 * (see `resolveTypeBeforeDot`), then branch on what kind of type it is:
 *   - a type VARIABLE (unknown type) → only constraint methods we know it
 *     must support (e.g. `Semigroup s` guarantees `.concat`);
 *   - a NAMED type (`Array`, `Maybe`, a user class, …) → its registered
 *     instance methods, record-alias fields, and — when the receiver is the
 *     type name itself, like `Counter.` — its static methods too;
 *   - a FUNCTION → static methods hung on the function object plus the
 *     shared `Function` methods (`.call`, `.apply`, …);
 *   - a RECORD (plain object) → its fields plus the standard
 *     `Object.prototype` methods.
 */
export function getDotCompletions(
  source: string,
  offset: number,
  dotIdx: number,
  uri: string,
  ctx: CompletionContext,
): CompletionItem[] {
  const resolved = resolveTypeBeforeDot(source, offset, dotIdx, uri, ctx);
  if (!resolved) return [];
  const { rawBestType, result, objName, effectiveSource, objStart, objEnd } = resolved;
  // The receiver type can carry rigid skolem constants (`§N`) when the dot is
  // inside an annotated method body whose params/`this` were skolemized so the
  // signature stays authoritative.  Scrub them back to display letters so the
  // completion details (e.g. `Array#reduce :: [a] ~> (b -> a -> b) -> b -> b`)
  // never leak `§N`.
  const bestType = (result.skolemDisplayNames && someType(resolved.bestType, isSkolem))
    ? scrubSkolems(resolved.bestType, result.skolemDisplayNames)
    : resolved.bestType;
  const items: CompletionItem[] = [];

  // Bare TVars no longer offer static constraint completions — use TypeRep.
  // However, for kind * constraints (e.g. Semigroup s), instance methods
  // should still be offered since the TVar represents a concrete value.
  if (bestType.tag === 'TVar') {
    const cNames = result.kvConstraints.get(bestType.id);
    if (cNames && cNames.length > 0) {
      // Collect instance methods from kind * constraints only
      const kindStarNames = cNames.filter(cn => {
        const baseName = constraintBaseName(cn);
        const def = lookupConstraint(baseName);
        return def?.expectedKind === '*';
      });
      if (kindStarNames.length > 0) {
        return buildInstanceConstraintCompletionItems(kindStarNames);
      }
    }
    return [];
  }

  if (bestType.tag === 'TCon') {
    // TypeRep: offer static constraint methods from the inner type's constraints
    if (bestType.name === T_TYPEREP && bestType.args.length === 1) {
      // Prefer the raw (pre-substitution) inner type to preserve kv info
      // that may have been resolved away during patched inference.
      const rawInner = rawBestType?.tag === 'TCon' && rawBestType.name === T_TYPEREP && rawBestType.args.length === 1
        ? rawBestType.args[0] : null;
      const innerType = rawInner ?? bestType.args[0];
      if (innerType.tag === 'TCon') {
        const innerKv = parseKvName(innerType.name);
        if (innerKv) {
          const allNames = collectAllKvConstraintNames(
            result.kvConstraints, result.kvConstructorConstraints,
            result.substitution, innerKv.varId, innerType.name,
          );
          return buildStaticConstraintCompletionItems(allNames.length > 0 ? allNames : undefined);
        }
        // Concrete constructor representative (e.g. `TypeRep Array`):
        // the value IS the type constructor, so offer its registered static
        // methods (`Array.of`, `Array.from`, …) plus any static constraint
        // methods attached to the type.
        const staticItems = methodCompletionsForType(innerType.name, innerType.args, 'static');
        return staticItems;
      }
      if (innerType.tag === 'TVar') {
        const cNames = result.kvConstraints.get(innerType.id);
        const ctorCNames = result.kvConstructorConstraints.get(innerType.id);
        const allNames = [...new Set([...(cNames ?? []), ...(ctorCNames ?? [])])];
        return buildStaticConstraintCompletionItems(allNames.length > 0 ? allNames : undefined);
      }
    }

    const kv = parseKvName(bestType.name);
    if (kv) {
      const cNames = resolveKvConstraintNames(result.kvConstraints, result.substitution, kv.varId, bestType.name);
      // When the identifier before the dot is 'constructor', the user is
      // accessing the type constructor (e.g. this.run.constructor.of).
      // In that case only static methods (no `~>`) should be offered, even
      // though substitution may have resolved the TVar back to a kv TCon.
      if (objName === 'constructor') {
        const allCtorCNames = collectAllKvConstraintNames(
          result.kvConstraints, result.kvConstructorConstraints,
          result.substitution, kv.varId, bestType.name,
        );
        return buildStaticConstraintCompletionItems(allCtorCNames.length > 0 ? allCtorCNames : undefined);
      }
      // For applied kind * constraints (e.g. Semigroup (s a)), the constraint
      // is stored in kvConstructorConstraints. Instance methods should still
      // be offered since the value has a concrete Semigroup-like type.
      const ctorCNames = resolveKvConstraintNames(result.kvConstructorConstraints, result.substitution, kv.varId, bestType.name);
      const allCNames = [...new Set([...(cNames ?? []), ...(ctorCNames ?? [])])];
      // Filter: only include kvConstructorConstraints entries that are kind *
      // (instance methods make sense). Kind * -> * entries are constructor-level only.
      const instanceNames = allCNames.filter(cn => {
        const baseName = constraintBaseName(cn);
        const def = lookupConstraint(baseName);
        // From kvConstraints → always include; from kvConstructorConstraints → only kind *
        if (cNames?.includes(cn)) return true;
        return def?.expectedKind === '*';
      });
      return buildInstanceConstraintCompletionItems(instanceNames.length > 0 ? instanceNames : undefined);
    } else if (bestType.name === T_UNION) {
      // Variant union (e.g. `Just a | Nothing` from sumtype `.constructor`).
      // Offer the parent sumtype's static methods (`.of` etc.) when every
      // member is a variant of the same parent.
      const variantParents = bestType.args.map(a =>
        a.tag === 'TCon' ? getParentTypeName(a.name) : null,
      );
      const parent = variantParents[0];
      if (parent && variantParents.every(p => p === parent)) {
        const dt = getDataType(parent);
        const parentArgs = dt ? dt.decl.typeVars.map(() => ({ tag: 'TVar' as const, id: -1, name: '_' })) : [];
        items.push(...methodCompletionsForType(parent, parentArgs as Type[], 'static'));
        // Only also offer instance methods when the dotted receiver is NOT
        // the sumtype identifier itself (e.g. `Either.` should show only
        // statics, while `ctorRef.` from `x.constructor` shows both).
        if (objName !== parent) {
          items.push(...methodCompletionsForType(parent, parentArgs as Type[], 'instance', prettyTypeToString(bestType)));
        }
      }
    } else {
      const alias = result.typeAliases.get(bestType.name);
      if (alias && alias.type.tag === 'TRecord') {
        for (const [fieldName, fieldType] of Object.entries(alias.type.fields)) {
          if (alias.type.hiddenFields?.has(fieldName)) continue;
          items.push({
            label: fieldName,
            kind: fieldType.tag === 'TFun' ? CompletionItemKind.Method : CompletionItemKind.Field,
            detail: `${fieldName} :: ${prettyTypeToString(fieldType)}`,
            labelDetails: { description: prettyTypeToString(fieldType) },
          });
        }
      }

      items.push(...methodCompletionsForType(
        bestType.name, bestType.args, 'instance', prettyTypeToString(bestType),
        objName === 'this',
      ));

      // When the identifier before the dot *is* the class name itself
      // (e.g. typing `Counter.` rather than `instance.`), also offer the
      // class's static methods and properties.  Class declarations bind
      // the class symbol to a value of TCon `<ClassName>` so the only
      // signal we have here is that the textual identifier matches the
      // type-constructor name.
      if (objName && objName === bestType.name) {
        items.push(...methodCompletionsForType(
          bestType.name, bestType.args, 'static',
        ));
      }
    }
  }

  if (bestType.tag === 'TFun') {
    // Look up user-defined static methods on the identifier (e.g. Identity.of).
    const identName = effectiveSource.slice(objStart, objEnd);
    if (identName) {
      items.push(...methodCompletionsForType(identName, [], 'static'));
    }

    // When the function type is a constructor (returns a concrete TCon),
    // also offer static methods from that type.  This covers cases like
    // `building.constructor.create` where the constructor function type
    // is `(String, Number) -> Building` and `Building.create` is static.
    const retType = getReturnType(bestType);
    if (retType.tag === 'TCon' && retType.name !== identName) {
      items.push(...methodCompletionsForType(retType.name, retType.args, 'static'));
    }

    items.push(...methodCompletionsForType('Function', [], 'instance', 'Function'));
  }

  if (bestType.tag === 'TRecord') {
    for (const [fieldName, fieldType] of Object.entries(bestType.fields)) {
      if (bestType.hiddenFields?.has(fieldName)) continue;
      items.push({
        label: fieldName,
        kind: fieldType.tag === 'TFun' ? CompletionItemKind.Method : CompletionItemKind.Field,
        detail: `${fieldName} :: ${prettyTypeToString(fieldType)}`,
        labelDetails: { description: prettyTypeToString(fieldType) },
      });
    }
    for (const name of OBJECT_PROTOTYPE_METHOD_NAMES) {
      if (items.some(i => i.label === name)) continue;
      const t = objectPrototypeMethodType(name);
      if (!t) continue;
      items.push({
        label: name,
        kind: CompletionItemKind.Method,
        detail: `${name} :: ${prettyTypeToString(t)}`,
        labelDetails: { description: prettyTypeToString(t) },
      });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Annotation type completion — type names inside `// name :: |` comments
// ---------------------------------------------------------------------------

/** Built-in type names offered in annotation completions. */
const ANNOTATION_TYPE_NAMES: Array<{ name: string; detail: string }> = [
  { name: 'Number',  detail: 'Type' },
  { name: 'String',  detail: 'Type' },
  { name: 'Boolean', detail: 'Type' },
  { name: 'Array',   detail: 'Type' },
  { name: 'Object',  detail: 'Type' },
  { name: 'Null',    detail: 'Type' },
  { name: 'Undefined', detail: 'Type' },
  { name: 'Void',    detail: 'Type' },
  { name: 'Any',     detail: 'Type' },
  { name: 'Integer', detail: 'Type' },
  { name: 'Float',   detail: 'Type' },
  { name: 'Double',  detail: 'Type' },
  { name: 'NonNegativeInteger', detail: 'Type' },
  { name: 'NegativeInteger',    detail: 'Type' },
  { name: 'PositiveNumber',     detail: 'Type' },
  { name: 'NegativeNumber',     detail: 'Type' },
  { name: 'ValidNumber',        detail: 'Type' },
  { name: 'NonZeroValidNumber', detail: 'Type' },
  { name: 'FiniteNumber',       detail: 'Type' },
  { name: 'NonZeroFiniteNumber',detail: 'Type' },
  { name: 'PositiveFiniteNumber',detail: 'Type' },
  { name: 'NegativeFiniteNumber',detail: 'Type' },
  { name: 'NonZeroInteger',     detail: 'Type' },
  { name: 'PositiveInteger',    detail: 'Type' },
  { name: 'StrMap',  detail: 'Type' },
  { name: 'Buffer',  detail: 'Type' },
  { name: 'Process', detail: 'Type' },
  { name: 'Promise', detail: 'Type' },
  { name: 'Map',     detail: 'Type' },
  { name: 'Set',     detail: 'Type' },
  { name: 'Error',   detail: 'Type' },
  { name: 'RegExp',  detail: 'Type' },
  { name: 'Date',    detail: 'Type' },
  { name: 'Symbol',  detail: 'Type' },
  { name: 'BigInt',  detail: 'Type' },
  { name: 'TypeRep', detail: 'Type — type representative' },
  { name: 'Maybe',   detail: 'Type — Maybe a' },
  { name: 'Either',  detail: 'Type — Either a b' },
];

// ---------------------------------------------------------------------------
// Directive keyword completion — `// ::|` triggers directive suggestions
// ---------------------------------------------------------------------------

const DIRECTIVE_KEYWORDS: { label: string; detail: string; snippet?: string }[] = [
  { label: 'types',            detail: '::types — load types from another file',          snippet: 'types ./$1' },
  { label: 'constraint',       detail: '::constraint — define a type class',              snippet: 'constraint $1 $2 { $3 }' },
  { label: 'global',           detail: '::global — declare a method on a built-in type',  snippet: 'global $1#$2 :: $3' },
  { label: 'narrow',           detail: '::narrow — narrow a predicate return type',       snippet: 'narrow $1' },
  { label: 'extend',           detail: '::extend — append a branch to an existing union alias', snippet: 'extend ${1:AliasName} ${2:Branch}' },
  { label: 'prefer',           detail: '::prefer — pick a definition when a name is ambiguous', snippet: 'prefer ${1:Name} from ${2:source}' },
  { label: 'rep',              detail: '::rep — bind a local annotation as a constraint method representative' },
  { label: 'ignore',           detail: '::ignore — suppress diagnostics on next line' },
  { label: 'ignore-file',      detail: '::ignore-file — suppress all diagnostics in file' },
  { label: 'ignore-function',  detail: '::ignore-function — suppress diagnostics in next function' },
  { label: 'hidden',           detail: '::hidden — hide the following member/field from completion' },
  { label: 'private',          detail: '::private — mark the following member/field as private (implies hidden)' },
];

/**
 * Offer directive keyword completions when the cursor is right after `::` in a
 * comment and the user is typing a directive name (e.g. `// ::i|` → ignore).
 */
export function getDirectiveCompletions(
  source: string,
  offset: number,
): CompletionItem[] {
  if (!isOffsetInComment(source, offset)) return [];

  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const lineBefore = source.slice(lineStart, offset);

  // Match `// ::` optionally followed by a partial directive name.
  const m = /\/\/\s*::([a-z-]*)$/.exec(lineBefore);
  if (!m) return [];

  const partial = m[1]; // may be '' when cursor is right after '::'

  const items: CompletionItem[] = [];
  for (const kw of DIRECTIVE_KEYWORDS) {
    if (partial && !kw.label.startsWith(partial)) continue;
    items.push({
      label: `::${kw.label}`,
      kind: CompletionItemKind.Keyword,
      detail: kw.detail,
      sortText: `0_${kw.label}`,
      filterText: `::${kw.label}`,
      insertText: kw.snippet ?? kw.label,
      insertTextFormat: kw.snippet ? 2 : undefined, // 2 = Snippet
    });
  }

  return items;
}

/**
 * Offer type constructor names when the cursor is inside an annotation comment.
 * Returns non-empty array when applicable, empty array otherwise.
 */
export function getAnnotationTypeCompletions(
  source: string,
  offset: number,
  uri: string,
  ctx: CompletionContext,
): CompletionItem[] {
  if (!isOffsetInComment(source, offset)) return [];

  // Only complete if we're inside an annotation-like comment (has `::` or starts with `@`)
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const lineBefore = source.slice(lineStart, offset);
  if (!/::|::constraint|::narrow/.test(lineBefore)) return [];

  const wordInfo = scanWord(source, offset);
  const partial = wordInfo ? source.slice(wordInfo.start, offset) : '';

  const items: CompletionItem[] = [];
  const addedNames = new Set<string>();

  const addItem = (name: string, detail: string) => {
    if (addedNames.has(name)) return;
    if (partial && !name.startsWith(partial)) return;
    addedNames.add(name);
    items.push({
      label: name,
      // Use Class (not TypeParameter) so VS Code shows these even when
      // `editor.suggest.showTypeParameters` is false (TypeParameter is
      // intended for generic params like `T`, not concrete type names).
      kind: CompletionItemKind.Class,
      detail,
      sortText: `0_${name}`,
    });
  };

  // Built-in types
  for (const entry of ANNOTATION_TYPE_NAMES) {
    addItem(entry.name, entry.detail);
  }

  // Types from current file inference (type aliases, sumtypes, constructor annotations)
  const result = runInference(source, uri, ctx);

  for (const [name] of result.typeAliases) {
    addItem(name, 'Type alias');
  }

  for (const name of getDataTypeNames()) {
    addItem(name, 'sum type');
  }

  for (const name of getConstraintNames()) {
    addItem(name, '::constraint');
  }

  for (const name of getRegisteredTypeNames()) {
    addItem(name, 'Type');
  }

  return items;
}

/**
 * Offer JS binding names when the cursor is inside a comment line that
 * does not yet contain `::` — typical when the user is starting to write
 * an annotation for a binding they've already defined in JS:
 *
 *   const myFunc = (x) => x + 1;
 *   // myF|         ← suggest `myFunc`
 *
 * Only top-level bindings that don't already have an annotation are
 * offered, so existing annotations aren't duplicated.
 */
export function getAnnotationNameCompletions(
  source: string,
  offset: number,
  uri: string,
  ctx: CompletionContext,
): CompletionItem[] {
  if (!isOffsetInComment(source, offset)) return [];

  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const lineBefore = source.slice(lineStart, offset);

  // Match a `//` (or `/*`/`*`) comment line that has only an optional
  // partial word before the cursor.  Stop here if `::` is already present
  // — that's the type-name completion territory.
  if (lineBefore.includes('::')) return [];
  // Accept an optional dotted partial like `builtIn.Obj` so member-access
  // annotation names (e.g. `builtIn.Object`) can be filtered as the user
  // continues typing past the dot.
  const m = /^\s*(?:\/\/+|\/\*+|\*+)\s*([A-Za-z_$][\w$]*(?:\.[\w$]*)?)?$/.exec(lineBefore);
  if (!m) return [];
  const partial = m[1] ?? '';

  const result = runInference(source, uri, ctx);

  // Names that already have a `Name :: ...` annotation — skip them so the
  // user isn't offered duplicates.  Track bare and dotted names separately;
  // method (`Type#method`) entries never collide with these.
  const annotated = new Set<string>();
  for (const name of result.annotations.keys()) {
    if (name.includes('#')) continue;
    annotated.add(name);
  }

  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  for (const [name] of result.topLevelBindings) {
    if (annotated.has(name)) continue;
    if (partial && !name.startsWith(partial)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({
      label: name,
      kind: CompletionItemKind.Variable,
      detail: 'Annotate this binding',
      sortText: `0_${name}`,
      // Insert `Name :: ` so the user can immediately type the type.
      insertText: `${name} :: `,
    });
  }

  // Also offer member-assignment targets like `builtIn.Object` when the
  // source contains `builtIn.Object = ...`.  Without this the user can
  // only accept the bare `builtIn` suggestion, which inserts `builtIn :: `
  // and leaves them having to manually move the cursor back to append the
  // member name.
  const memberAssignRegex = /^[ \t]*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=(?!=)/gm;
  let am: RegExpExecArray | null;
  while ((am = memberAssignRegex.exec(source)) !== null) {
    if (isOffsetInComment(source, am.index)) continue;
    const full = `${am[1]}.${am[2]}`;
    if (annotated.has(full)) continue;
    if (seen.has(full)) continue;
    if (partial && !full.startsWith(partial)) continue;
    seen.add(full);
    items.push({
      label: full,
      kind: CompletionItemKind.Variable,
      detail: 'Annotate this member assignment',
      sortText: `0_${full}`,
      insertText: `${full} :: `,
    });
  }

  return items;
}
