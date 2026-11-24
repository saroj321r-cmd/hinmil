// ============================================================================
// Signature Help — show parameter info when typing function arguments
//
// Plain language: the little hint that appears while typing a function call
// (`f(…`), showing the parameters and highlighting the one being typed.
// This file works out which call the cursor is inside, fetches the callee's
// signature (picking the right overload where applicable), and marks the
// active parameter — including for curried calls like `f(a)(b)`.
// ============================================================================

import { SignatureHelp, SignatureInformation, ParameterInformation } from 'vscode-languageserver/node';
import {
  InferenceEngine,
  InferenceResult,
  ImportResolver,
  TypeDirectiveResolver,
  ImportTypeAliasResolver,
  prettyTypeToString,
} from '../index';
import { Type, generateCurriedOverloads, flattenCurriedType } from '../hm/types';
import { instantiate } from '../hm/env';
import { extractParamList, findHostSlots, findOverloadSlots, substTVar, scrubSkolems, someType, discriminateRecordArg } from '../hm/typeUtils';
import { isSkolem, tCon, isTuple, isKindVariable } from '../hm/types';
import { unify } from '../hm/unify';
import { Substitution } from '../hm/substitution';
import { normalizeArrayLiteralASI, mapOffset, unmapOffset } from './files';

export interface SignatureHelpContext {
  source: string;
  offset: number;
  engine: InferenceEngine;
  resolver: ImportResolver;
  typeResolver: TypeDirectiveResolver;
  /** Optional: resolves an import specifier to its `.hm` sidecar's type
   *  aliases AND constructor-callable annotations.  Required for the
   *  constructor-as-callable signature help branch to surface overloads
   *  declared in imported sidecars / project overrides. */
  importTypeAliasResolver?: ImportTypeAliasResolver;
  /** Callback that re-infers with `;` inserted before a `[` to break ASI on array-method member access. */
  reinferWithArrayASI: (
    source: string,
    closeBracketIdx: number,
    resolver: ImportResolver,
    typeResolver: TypeDirectiveResolver,
  ) => { result: InferenceResult; shift: number; patched: string } | null;
  /** Optional request-scoped inference (cached per exact source text).
   *  When provided it replaces the direct `engine.infer` call — repeated
   *  signature-help requests while the popup is open then cost at most one
   *  inference per document version instead of one per keystroke. */
  inferSource?: (source: string) => InferenceResult;
}

/**
 * Walk backwards from `offset` to find the enclosing `(`, then compute the
 * active parameter index by a FORWARD scan from just after that `(` up to the
 * cursor, counting only depth-0 commas.
 *
 * The forward scan is essential: a backward comma count is wrong when the
 * cursor sits inside an *unclosed* nested literal (e.g. `f({ a: 1, b: 2`),
 * because going backwards the commas inside the `{ … }` are seen at depth 0
 * (the opening brace has not been matched yet) and wrongly advance the active
 * parameter.  Scanning forward, the nested `{`/`[`/`(` raise the depth first,
 * so their inner commas are correctly ignored.
 * Returns the offset of '(' or -1 if not found.
 */
function findOpenParen(source: string, offset: number): { parenOffset: number; activeParam: number } {
  let depth = 0;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = source[i];
    if (ch === ')' || ch === ']' || ch === '}') {
      depth++;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth > 0) {
        depth--;
      } else if (ch === '(') {
        // A depth-0 '(' is only an argument list if it belongs to a CALL —
        // i.e. it is immediately preceded by a callee expression.  When the
        // user starts building a callback argument (e.g. `sort((` while typing
        // `sort((a, b) => …)`) the innermost '(' is a *grouping* / arrow
        // parameter paren with no callee before it.  Skip past it and keep
        // scanning outward for the enclosing call's '(' so the popup keeps
        // showing that call's signature instead of vanishing.
        if (isCallParen(source, i)) {
          return { parenOffset: i, activeParam: countActiveParam(source, i, offset) };
        }
        continue;
      } else {
        // Unmatched '[' or '{' at depth 0 — the user is typing inside
        // a nested array/object literal that is an argument. Keep searching
        // backwards to find the enclosing '('.
        continue;
      }
    }
  }
  return { parenOffset: -1, activeParam: 0 };
}

/**
 * Is the '(' at `parenOffset` a *call* argument list (as opposed to a grouping
 * or arrow-parameter paren)?  A call paren is immediately preceded — ignoring
 * whitespace — by a callee expression, which ends in an identifier character,
 * a ')' (chained/curried call) or a ']' (computed member access).  Grouping and
 * arrow-parameter parens are preceded by '(', ',', operators, '=>', '{', '[',
 * ':', ';' or the start of input.
 */
function isCallParen(source: string, parenOffset: number): boolean {
  let i = parenOffset - 1;
  while (i >= 0 && /\s/.test(source[i])) i--;
  if (i < 0) return false;
  return /[A-Za-z0-9_$)\]]/.test(source[i]);
}

/**
 * Offset of the INNERMOST depth-0 open '(' enclosing the cursor — whether it is
 * a call argument list OR a grouping / arrow-parameter paren.  Unlike
 * `findOpenParen` (which skips grouping parens to reach the enclosing call),
 * this returns the closest '(' so we can detect when the cursor sits inside a
 * callback argument's own parentheses.  Returns -1 when none is open.
 */
function innermostOpenParen(source: string, offset: number): number {
  let depth = 0;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = source[i];
    if (ch === ')' || ch === ']' || ch === '}') {
      depth++;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth > 0) depth--;
      else if (ch === '(') return i;
      else continue; // unmatched '[' or '{' at depth 0 — keep scanning
    }
  }
  return -1;
}

/**
 * Narrow a type to its callable branch(es): a `TFun` is returned unchanged; a
 * union (`opt()`-style `fn | Undefined`, or a set of overloaded callbacks)
 * yields its function branches — the sole `TFun` when there is exactly one, or
 * a `Union` of the function branches otherwise.  Non-callable members (e.g. the
 * `Undefined` that marks an optional callback) are dropped.  Returns `null`
 * when the type carries no function branch at all.
 */
function functionBranchesOf(t: Type): Type | null {
  if (t.tag === 'TFun') return t;
  if (t.tag === 'TCon' && t.name === 'Union') {
    const fns = t.args.filter(a => a.tag === 'TFun');
    if (fns.length === 1) return fns[0];
    if (fns.length > 1) return tCon('Union', fns);
  }
  return null;
}

/** The type of the `index`-th parameter slot of a (tuple or curried) function. */
function activeParamSlot(t: Type, index: number): Type | null {
  if (t.tag !== 'TFun') return null;
  const params = extractParamList(t);
  return params[index] ?? null;
}

/**
 * Count depth-0 commas in `source` between the argument list opened at
 * `parenOffset` and `cursor` — i.e. the 0-indexed active parameter.
 */
function countActiveParam(source: string, parenOffset: number, cursor: number): number {
  let depth = 0;
  let activeParam = 0;
  for (let i = parenOffset + 1; i < cursor && i < source.length; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break; // closing paren of this call's argument list
      depth--;
    } else if (ch === ',' && depth === 0) {
      activeParam++;
    }
  }
  return activeParam;
}

/**
 * Decompose a function type into a list of parameter types and return type.
 * For curried: a -> b -> c  =>  params=[a], returnType=b -> c
 * For tuple:   (a, b) -> c  =>  params=[a, b], returnType=c
 * Only decomposes ONE call level (single param or multi-param via Tuple).
 */
function decomposeFunctionType(t: Type): {
  params: { label: string; type: Type }[];
  returnType: Type;
} | null {
  if (t.tag !== 'TFun') return null;
  const params = extractParamList(t).map(p => ({ label: prettyTypeToString(p), type: p }));
  return { params, returnType: t.result };
}

/**
 * Find the inferred type of the outermost expression spanning a source range,
 * looked up from the inference result's nodeTypes table.
 */
function argTypeInRange(start: number, end: number, result: InferenceResult): Type | null {
  // Prefer the OUTERMOST expression that ends exactly at the range boundary.
  // For a call argument like `Left("2")` this is the CallExpression — whose
  // type is the CONSTRUCTED value (`Either String a`) — not the callee
  // Identifier `Left` (`String -> Either String a`).  `nodeTypes` is keyed by
  // START and drops a CallExpression that shares its start offset with the
  // callee identifier, so a by-start scan would wrongly surface the callee's
  // function type; `nodeTypesByEnd` (keyed by END, smallest span) still holds
  // the call.  Used for overload narrowing, where the callee's TFun type would
  // unify with the wrong branches (or, against a polymorphic `a`, none).
  // Require the candidate to span the WHOLE range (start AND end), so it is the
  // outermost expression — not an inner node that merely happens to end at the
  // boundary.  E.g. for an incomplete active record `{ a: 1` the `1` literal
  // ends at the cursor too, but starts later, so it is rejected and the by-start
  // scan below recovers the record type.
  const byEnd = result.nodeTypesByEnd.get(end);
  if (byEnd && byEnd.start === start) {
    return result.substitution.apply(byEnd.type);
  }
  let best: { type: Type; end: number; start: number } | null = null;
  for (const [s, info] of result.nodeTypes) {
    if (s >= start && s < end && info.end <= end) {
      if (!best || s < best.start || (s === best.start && info.end > best.end)) {
        best = { type: info.type, end: info.end, start: s };
      }
    }
  }
  return best ? result.substitution.apply(best.type) : null;
}

/**
 * Collect the inferred types of the top-level arguments up to (and including)
 * the one the cursor currently sits in.  Each argument is measured to its real
 * end — the next depth-0 comma or the closing paren — so an argument the cursor
 * is *inside* (e.g. `concat("|")`) is still resolved to its full type.
 * Arguments that lie entirely after the cursor are ignored.
 */
function collectTypedArgTypes(
  src: string,
  parenOffset: number,
  cursor: number,
  result: InferenceResult,
): (Type | null)[] {
  // Split the whole argument list into depth-0 comma-separated segments,
  // scanning past the cursor so the current argument is measured to its end.
  const segments: { start: number; end: number }[] = [];
  let depth = 0;
  let segStart = parenOffset + 1;
  let i = parenOffset + 1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break; // closing paren of this call's argument list
      depth--;
    } else if (ch === ',' && depth === 0) {
      segments.push({ start: segStart, end: i });
      segStart = i + 1;
    }
  }
  segments.push({ start: segStart, end: i });

  const types: (Type | null)[] = [];
  for (const seg of segments) {
    // Stop once we reach an argument that begins after the cursor — the user
    // has not started typing it yet, so it must not constrain the overloads.
    if (seg.start > cursor) break;
    // An argument that is (or begins with) an unbound identifier is still
    // being typed (e.g. `te` on its way to `testje`).  Inference may have
    // provisionally bound its fresh type variable to the FIRST overload's
    // parameter, so its recorded type is unreliable — treat it as unresolved
    // so every overload stays visible until the identifier resolves.
    let head = seg.start;
    while (head < seg.end && /\s/.test(src[head])) head++;
    if (result.unboundIdentifiers?.has(head)) {
      types.push(null);
      continue;
    }
    types.push(argTypeInRange(seg.start, seg.end, result));
  }
  return types;
}

/**
 * Does an overload branch accept the argument types typed so far?  A branch is
 * rejected only when a concrete already-typed argument cannot unify with the
 * corresponding parameter (e.g. a `String` argument against an `[a]` param).
 */
function branchAcceptsArgs(branch: Type, argTypes: (Type | null)[]): boolean {
  if (branch.tag !== 'TFun') return true;
  const decomposed = decomposeFunctionType(branch);
  if (!decomposed) return true;
  const params = decomposed.params;
  for (let k = 0; k < argTypes.length; k++) {
    const at = argTypes[k];
    const pt = params[k]?.type;
    if (!at || !pt) continue;
    // Record discrimination first: closed records whose required fields the
    // argument lacks identify the wrong branch even though lenient record
    // unification would merge the differing field names and wrongly succeed.
    if (discriminateRecordArg(at, pt) === 'reject') return false;
    try {
      unify(at, pt);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Collect the inferred argument types of a CURRIED call chain, one per applied
 * frame.  For `reduce(fn)(init)({…})` the result is `[typeof fn, typeof init,
 * typeof {…}]`, aligned with the branch's flattened parameters so a later
 * application can discriminate the overloads.  `cursor` bounds the active
 * (cursor-containing) frame: narrowing passes the caret, display passes the
 * end of source.  `activeText` is the raw text typed into the active frame
 * (e.g. `"{"`), used for the syntactic narrowing hint.
 */
function collectCurriedArgTypes(
  src: string,
  idEnd: number,
  parenOffset: number,
  cursor: number,
  result: InferenceResult,
): { types: (Type | null)[]; activeText: string } {
  const types: (Type | null)[] = [];
  let i = idEnd;
  while (i < parenOffset && /\s/.test(src[i])) i++;
  // Walk every completed curried application `( … )` up to the active paren.
  while (i < parenOffset && src[i] === '(') {
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
    }
    if (j >= src.length || j > parenOffset) break;
    types.push(argTypeInRange(i + 1, j, result));
    i = j + 1;
    while (i < parenOffset && /\s/.test(src[i])) i++;
  }
  // Active frame: the paren the cursor sits in.  A curried frame has a single
  // argument, so take the first of whatever `collectTypedArgTypes` resolves.
  const activeArgs = collectTypedArgTypes(src, parenOffset, cursor, result);
  types.push(activeArgs.length > 0 ? activeArgs[0] : null);
  let a = parenOffset + 1;
  while (a < cursor && /\s/.test(src[a])) a++;
  return { types, activeText: src.slice(a, cursor) };
}

/** Does a (substitution-applied) parameter type admit an OBJECT/record
 *  argument?  Drives the `({` syntactic narrowing hint: a concrete non-object
 *  parameter (e.g. `Array a`, `Number`) rejects an object argument, while a
 *  record, `Object`, a bare variable, or a higher-kinded `f a` admits it. */
function paramAdmitsObject(pt: Type): boolean {
  if (pt.tag === 'TVar' || pt.tag === 'TRow' || pt.tag === 'TRecord') return true;
  if (pt.tag === 'TCon') {
    if (isKindVariable(pt.name)) return true; // `f a` — `f` could be an object
    return pt.name === 'Object';
  }
  return false;
}

/** Mirror of {@link paramAdmitsObject} for array/list arguments (`[`). */
function paramAdmitsList(pt: Type): boolean {
  if (pt.tag === 'TVar' || pt.tag === 'TRow') return true;
  if (pt.tag === 'TCon') {
    if (isKindVariable(pt.name)) return true; // `f a` — `f` could be a list
    return pt.name === 'Array' || pt.name === 'List';
  }
  return false; // TRecord, TFun, … reject a list argument
}

/** A *concrete* record/Object parameter (as opposed to a bare variable or a
 *  higher-kinded `f a`).  Such a parameter accepts any object literal that is
 *  still being typed, even before its required fields are present. */
function isConcreteObjectParam(pt: Type): boolean {
  return pt.tag === 'TRecord' || (pt.tag === 'TCon' && pt.name === 'Object');
}

/** A *concrete* list parameter (`Array a` / `List a`). */
function isConcreteListParam(pt: Type): boolean {
  return pt.tag === 'TCon' && (pt.name === 'Array' || pt.name === 'List');
}

/**
 * Cross-frame variant of {@link branchAcceptsArgs} for curried callees: match
 * the i-th already-applied curried argument against the branch's i-th
 * FLATTENED parameter so a discriminating argument in a LATER application
 * narrows the overload set.  The active (last) frame additionally honours a
 * syntactic hint — `{` rejects non-object parameters, `[` rejects non-list
 * parameters — so an empty `({` immediately drops the incompatible overloads.
 */
function branchAcceptsCurriedArgs(branch: Type, args: (Type | null)[], activeText: string): boolean {
  const { params } = flattenCurriedType(branch);
  for (let k = 0; k < args.length; k++) {
    const pt = params[k];
    if (!pt) return false; // branch has fewer curried params than supplied
    if (k === args.length - 1 && activeText) {
      const hint = activeText[0];
      // The active frame is an object/array literal STILL BEING TYPED.  Apply
      // the syntactic kind hint, then — for a parameter that is a concrete
      // container of that kind — accept it without unifying the (necessarily
      // incomplete) literal against it.  This keeps every matching object
      // overload (`{ [k] :: a }`, `{ k :: a }`, `Object`) live while the user
      // is still inside `({`, while higher-kinded `f a` (which can't be a
      // record) and the wrong container kind are still dropped.
      if (hint === '{') {
        if (!paramAdmitsObject(pt)) return false;
        if (isConcreteObjectParam(pt)) continue;
      } else if (hint === '[') {
        if (!paramAdmitsList(pt)) return false;
        if (isConcreteListParam(pt)) continue;
      }
    }
    const at = args[k];
    if (!at) continue;
    if (discriminateRecordArg(at, pt) === 'reject') return false;
    try {
      unify(at, pt);
    } catch {
      return false;
    }
  }
  return true;
}

/** Under a `{` / `[` container hint, drop higher-kinded `f a` branches when at
 *  least one surviving branch has a CONCRETE container parameter of the same
 *  kind in the active slot.  Unification now lets `f a` accept an object (via a
 *  `::rep Foldable Object#reduce` bridge) or an array, so the abstract branch
 *  would otherwise linger in the menu beside the strictly more informative
 *  record / `Object` / `Array a` overloads.  When NO concrete container branch
 *  survives (e.g. a lone `Foldable f => f a` overload), the abstract branch is
 *  kept so signature help still appears. */
function preferConcreteContainer(branches: Type[], activeSlot: number, activeText: string): Type[] {
  const hint = activeText[0];
  if (hint !== '{' && hint !== '[') return branches;
  const activeParam = (b: Type): Type | undefined => flattenCurriedType(b).params[activeSlot];
  const isConcrete = hint === '{' ? isConcreteObjectParam : isConcreteListParam;
  const isAbstract = (pt: Type | undefined): boolean =>
    !!pt && pt.tag === 'TCon' && isKindVariable(pt.name);
  const hasConcrete = branches.some(b => { const p = activeParam(b); return p ? isConcrete(p) : false; });
  if (!hasConcrete) return branches;
  const filtered = branches.filter(b => !isAbstract(activeParam(b)));
  return filtered.length > 0 ? filtered : branches;
}

/** A genuinely curried function: ≥2 nested single-argument arrows whose
 *  parameters are NOT tuples.  Tuple parameters (`(a, b) -> c`) indicate an
 *  uncurried/multi-arg call shape (e.g. the `concat` overloads) and keep the
 *  comma-separated rendering.  Purely shape-based, so it also covers ANNOTATED
 *  curried functions/overloads like `reduce` (which `curriedNodes` does not
 *  flag, as inference only populates that for AUTO-detected curried bindings). */
function isPureCurriedType(t: Type): boolean {
  const { params } = flattenCurriedType(t);
  return params.length >= 2 && params.every(p => !isTuple(p));
}

export function provideSignatureHelp(ctx: SignatureHelpContext): SignatureHelp | null {
  const { source, offset, engine, resolver, typeResolver, importTypeAliasResolver, reinferWithArrayASI } = ctx;

  // Normalize ASI for array literals
  const { patched: normSource, insertions: sigInsertions } = normalizeArrayLiteralASI(source);
  const normOffset = mapOffset(offset, sigInsertions);

  // Find the opening paren and active parameter index
  const { parenOffset, activeParam } = findOpenParen(normSource, normOffset);
  if (parenOffset < 0) return null;

  // Infer the source to get types (via the request-scoped cache when the
  // server provides one — signature help re-fires on every keystroke).
  let result = ctx.inferSource
    ? ctx.inferSource(normSource)
    : engine.infer(normSource, undefined, resolver, typeResolver, importTypeAliasResolver);

  // Find the callee: the expression immediately before the '('
  // Walk back from parenOffset to find the callee's start offset
  const calleeEnd = parenOffset;
  let calleeStart = calleeEnd - 1;

  // Skip whitespace before '('
  while (calleeStart >= 0 && /\s/.test(normSource[calleeStart])) calleeStart--;

  // Handle chained calls: f(x)(y) — the char before '(' is ')'.
  // Skip balanced parenthesized sub-expressions to find the root callee name,
  // and use nodeTypesByEnd to get the return type of the inner call.
  let isChainedCall = false;
  let chainEndPos = -1;
  // How many complete curried applications precede the active paren.
  // For `f(` it is 0, `f(x)(` it is 1, `f(x)(y)(` it is 2 — this is the
  // curry-frame depth used to advance the highlighted parameter for curried
  // callees (each curried application consumes exactly one parameter).
  let curryDepth = 0;

  if (calleeStart >= 0 && normSource[calleeStart] === ')') {
    isChainedCall = true;
    chainEndPos = calleeStart + 1; // exclusive end of the inner call expression

    // Skip balanced parens (possibly multiple levels: f(x)(y)(z))
    while (calleeStart >= 0 && normSource[calleeStart] === ')') {
      let depth = 1;
      calleeStart--;
      while (calleeStart >= 0 && depth > 0) {
        if (normSource[calleeStart] === ')') depth++;
        else if (normSource[calleeStart] === '(') depth--;
        calleeStart--;
      }
      curryDepth++;
      // Skip whitespace between chained calls
      while (calleeStart >= 0 && /\s/.test(normSource[calleeStart])) calleeStart--;
    }
  }

  // Walk back through identifier chars (including '.' for member access)
  const idEnd = calleeStart + 1;
  while (calleeStart >= 0 && /[A-Za-z0-9_$.]/.test(normSource[calleeStart])) calleeStart--;
  calleeStart++;

  if (calleeStart >= idEnd) return null;

  // Find the best type for the callee in nodeTypes
  let bestType: Type | null = null;
  let bestRawType: Type | null = null;
  let bestStart = -1;

  if (isChainedCall) {
    // For chained calls, look up the return type of the inner call via nodeTypesByEnd.
    // The inner call expression's node.end equals the position of the outer '('.
    const chainEntry = result.nodeTypesByEnd.get(chainEndPos);
    if (chainEntry) {
      bestType = result.substitution.apply(chainEntry.type);
      bestRawType = chainEntry.type;
      bestStart = chainEntry.start;
    }
  }

  if (!bestType) {
    for (const [start, { type }] of result.nodeTypes) {
      if (start >= calleeStart && start < parenOffset && start > bestStart) {
        bestType = result.substitution.apply(type);
        bestRawType = type;
        bestStart = start;
      }
    }
  }

  // Fallback: if the callee starts with '.' and is preceded by ']', the parser
  // may have treated `[...].method(` as a computed member access on the previous
  // expression. Re-infer with ';' inserted before the matching '[' so it parses
  // as an array literal.
  if ((!bestType || bestType.tag === 'TVar') && calleeStart > 0 && normSource[calleeStart - 1] === ']') {
    const origCalleeStart = unmapOffset(calleeStart, sigInsertions);
    const fix = reinferWithArrayASI(source, origCalleeStart - 1, resolver, typeResolver);
    if (fix) {
      let bestType2: Type | null = null;
      let bestStart2 = -1;
      for (const [start, { type }] of fix.result.nodeTypes) {
        if (start >= calleeStart + fix.shift && start < parenOffset + fix.shift && start > bestStart2) {
          bestType2 = fix.result.substitution.apply(type);
          bestStart2 = start;
        }
      }
      if (bestType2 && bestType2.tag === 'TFun') {
        bestType = bestType2;
        bestStart = bestStart2 - fix.shift;
        result = fix.result;
      }
    }
  }

  if (!bestType) return null;

  // The resolved type can carry rigid skolem constants (`§N`) when the call
  // appears inside an annotated method body whose params/`this` were
  // skolemized to keep the signature authoritative.  Scrub them to display
  // letters so parameter hints never leak `§N` (e.g. `this.reduce(b -> a ->
  // b) -> b -> b`).
  if (result.skolemDisplayNames) {
    if (someType(bestType, isSkolem)) bestType = scrubSkolems(bestType, result.skolemDisplayNames);
    if (bestRawType && someType(bestRawType, isSkolem)) bestRawType = scrubSkolems(bestRawType, result.skolemDisplayNames);
  }

  // displayType is just bestType now — factory produces the full signature
  let displayType = bestType;
  const calleeName = normSource.slice(calleeStart, idEnd);

  // Chained curried call (`f(x)(y)(`): the `bestType` resolved above is the
  // REMAINDER type of the inner call (from `nodeTypesByEnd`), which has already
  // consumed the applied arguments and therefore HIDES them — signature help
  // would collapse `equals(Left("2"))(` to `equals(Either String _) -> Boolean`,
  // losing the first, already-supplied argument.  Recover the ROOT callee's
  // full curried type (recorded at its identifier start offset) so the curried
  // renderer can show the COMPLETE form `f(p0)(p1)... -> ret` with the
  // already-applied arguments substituted in and the active (current) frame
  // highlighted — matching annotated curried overloads (e.g. `reduce`).  This
  // runs BEFORE the annotation-Union block below so an annotated overload still
  // wins and narrows its menu; it only rescues UN-annotated / single curried
  // callees whose remainder would otherwise drop the applied frames.
  if (isChainedCall && curryDepth > 0) {
    const rootEntry = result.nodeTypes.get(calleeStart);
    if (rootEntry) {
      let rootType = result.substitution.apply(rootEntry.type);
      if (result.skolemDisplayNames && someType(rootType, isSkolem)) {
        rootType = scrubSkolems(rootType, result.skolemDisplayNames);
      }
      const rootIsCurriedFun = rootType.tag === 'TFun' && isPureCurriedType(rootType);
      const rootIsCurriedUnion = rootType.tag === 'TCon' && rootType.name === 'Union'
        && rootType.args.length > 1
        && rootType.args.every(a => a.tag === 'TFun' && isPureCurriedType(a));
      if (rootIsCurriedFun || rootIsCurriedUnion) {
        // Arity sanity: the root must still carry MORE curried frames than the
        // ones already applied, i.e. it genuinely retains the consumed frames.
        const rootArity = rootType.tag === 'TCon'
          ? Math.max(...rootType.args.map(a => flattenCurriedType(a).params.length))
          : flattenCurriedType(rootType).params.length;
        if (rootArity > curryDepth) {
          if (rootType.tag === 'TCon') {
            // Overloaded callee (Union of curried branches) reached WITHOUT a
            // local annotation (e.g. imported / global / aliased `equals`):
            // the annotation-Union block below is keyed on
            // `result.annotations` and would be skipped, so narrow the menu
            // HERE by the already-applied curried arguments — otherwise a
            // chained call would list every overload (and prefer an unrelated
            // first branch) even after the first argument already discriminates
            // them.  Mirrors the annotation block's curried narrowing.
            const branches = rootType.args;
            const { types: curriedArgs, activeText } =
              collectCurriedArgTypes(normSource, idEnd, parenOffset, normOffset, result);
            const compatible = preferConcreteContainer(
              branches.filter(b => branchAcceptsCurriedArgs(b, curriedArgs, activeText)),
              curriedArgs.length - 1, activeText,
            );
            if (compatible.length === 1) {
              displayType = compatible[0];
            } else if (compatible.length > 1 && compatible.length < branches.length) {
              displayType = tCon('Union', compatible);
            } else {
              displayType = rootType;
            }
          } else {
            displayType = rootType;
          }
        }
      }
    }
  }

  // When the call has no actual arguments yet (user just opened the paren),
  // polymorphic functions like `identity :: a -> a` would show as
  // `identity(Undefined) -> Undefined` because the inference fills in
  // undefined for missing args.  Use the raw (pre-substitution) type from
  // nodeTypes which still has the original type variables intact.
  const textBeforeCursor = normSource.substring(parenOffset + 1, normOffset).trim();
  if (textBeforeCursor === '' && !isChainedCall && bestRawType && bestRawType.tag === 'TFun') {
    displayType = bestRawType;
  }

  // Overloaded callee: when the binding's annotation is a Union of TFun
  // branches (e.g. `add :: (Number, Number) -> Number` plus
  // `add :: (String, String) -> String`), surface every overload that is
  // still compatible with the arguments typed so far.  We deliberately do
  // NOT trust inference's recorded `callSiteOverloadIndex` here: lenient
  // record unification can make it commit to the first structurally-loose
  // branch (e.g. `{ nam }` accepting a `{ name }` argument), which would hide
  // the genuinely-matching overload.  Filtering with `branchAcceptsArgs`
  // (which rejects record arguments that lack a branch's required fields)
  // selects the right branch when the user has committed to one and keeps all
  // overloads visible while the argument is still ambiguous or unresolved.
  if (calleeName) {
    const ann = result.annotations.get(calleeName);
    if (ann?.scheme) {
      const inst = instantiate(ann.scheme);
      if (inst.tag === 'TCon' && inst.name === 'Union'
          && inst.args.length > 1
          && inst.args.every(a => a.tag === 'TFun')) {
        // Curried overloaded callee (`reduce(fn)(init)({…})`): discriminate
        // across ALL applied frames so a later argument narrows the menu.
        // Each frame's argument is matched against the branch's flattened
        // parameter at the same index, plus a syntactic hint on the active
        // frame (`{`/`[`) for an as-yet-untyped literal.
        if (inst.args.every(isPureCurriedType)) {
          const { types: curriedArgs, activeText } =
            collectCurriedArgTypes(normSource, idEnd, parenOffset, normOffset, result);
          const compatible = preferConcreteContainer(
            inst.args.filter(b => branchAcceptsCurriedArgs(b, curriedArgs, activeText)),
            curriedArgs.length - 1, activeText,
          );
          if (compatible.length === 1) {
            displayType = compatible[0];
          } else if (compatible.length > 1 && compatible.length < inst.args.length) {
            displayType = tCon('Union', compatible);
          } else {
            displayType = inst;
          }
        } else {
          const argTypes = collectTypedArgTypes(normSource, parenOffset, normOffset, result);
          const compatible = inst.args.filter(branch => branchAcceptsArgs(branch, argTypes));
          if (compatible.length === 1) {
            displayType = compatible[0];
          } else if (compatible.length > 1 && compatible.length < inst.args.length) {
            displayType = tCon('Union', compatible);
          } else {
            // None compatible (still typing) or all compatible (ambiguous /
            // no arguments yet) → show every overload.
            displayType = inst;
          }
        }
      }
    }
  }

  // Level 2 — nested callback signature help.  When the cursor sits inside a
  // callback argument's OWN parentheses (a grouping / arrow-parameter paren
  // nested inside the call, e.g. `sort((a, b|))`), show the EXPECTED CALLBACK
  // signature — `(String, String) -> Number` — with the active callback
  // parameter highlighted, instead of the enclosing call's signature.  This is
  // both narrower (drops the optional `| Undefined`) and points the user at the
  // parameter they are actually typing.
  if (displayType.tag === 'TFun') {
    const innerParen = innermostOpenParen(normSource, normOffset);
    if (innerParen > parenOffset && !isCallParen(normSource, innerParen)) {
      const slot = activeParamSlot(displayType, activeParam);
      const fn = slot ? functionBranchesOf(result.substitution.apply(slot)) : null;
      const decomposed = fn ? decomposeFunctionType(fn) : null;
      if (decomposed && decomposed.params.length > 0) {
        const innerActive = countActiveParam(normSource, innerParen, normOffset);
        let cbLabel = '(';
        const cbParams: ParameterInformation[] = [];
        for (let i = 0; i < decomposed.params.length; i++) {
          if (i > 0) cbLabel += ', ';
          const start = cbLabel.length;
          cbLabel += decomposed.params[i].label;
          cbParams.push({ label: [start, cbLabel.length] });
        }
        cbLabel += `) -> ${prettyTypeToString(decomposed.returnType)}`;
        return {
          signatures: [{ label: cbLabel, parameters: cbParams }],
          activeSignature: 0,
          activeParameter: Math.min(innerActive, decomposed.params.length - 1),
        };
      }
    }
  }

  // Collect all overload types to present as signatures.
  // For auto-detected curried functions, generate all curried overloads; otherwise just the type itself.
  // Check both bestStart (the node whose type we resolved) and calleeStart (the root
  // identifier, relevant for chained calls like curriedAdd(1)(2) where the root callee
  // is the one marked in curriedNodes).
  let overloadTypes: Type[] = [];
  // When set, each overloadType is rendered as a single curried signature
  // (`name(p0)(p1)(p2) -> ret`) with EVERY curried parameter as its own
  // highlightable segment, and the active parameter advances with the curry
  // depth.  This is clearer than the old `generateCurriedOverloads` expansion
  // (which produced 2^(n-1) tuple/curry partitions and only ever highlighted
  // the first parameter for a chained call).
  let curriedDisplay = false;
  const isPureCurried = isPureCurriedType;
  const autoCurried = result.curriedNodes.has(bestStart) || result.curriedNodes.has(calleeStart);
  if (displayType.tag === 'TFun') {
    if (isPureCurried(displayType)) {
      overloadTypes = [displayType];
      curriedDisplay = true;
    } else if (autoCurried) {
      const { params: flatParams, result: resultType } = flattenCurriedType(displayType);
      overloadTypes = flatParams.length > 1
        ? generateCurriedOverloads(flatParams, resultType)
        : [displayType];
    } else {
      overloadTypes = [displayType];
    }
  } else if (displayType.tag === 'TCon' && displayType.name === 'Union'
             && displayType.args.some(a => a.tag === 'TFun')) {
    // Overloaded function: surface every TFun branch as its own
    // signature so the user can see all available shapes (e.g.
    // `add(Number, Number) -> Number` AND `add(String, String) -> String`).
    // For a curried overloaded callee (e.g. `reduce`), render each branch as
    // a single fully-curried signature so every parameter is highlightable.
    const branches = displayType.args.filter(a => a.tag === 'TFun');
    if (branches.every(isPureCurried)) {
      overloadTypes = branches;
      curriedDisplay = true;
    } else if (autoCurried) {
      // Mixed/tuple arity under an auto-detected curried binding: fall back to
      // the per-branch curry-partition expansion.
      overloadTypes = branches.flatMap(branch => {
        const { params: flatParams, result: resultType } = flattenCurriedType(branch);
        return flatParams.length > 1
          ? generateCurriedOverloads(flatParams, resultType)
          : [branch];
      });
    } else {
      overloadTypes = branches;
    }
  } else if (displayType.tag === 'TCon' && /^[A-Z]/.test(displayType.name)) {
    // Constructor-as-callable: when the callee resolves to an uppercase
    // TCon (e.g. `QueryTag b`), only an instance-callable annotation
    // (`QueryTag() :: a -> RTask r e [b]`) provides callable signatures.
    // The bare constructor scheme (`QueryTag :: ...`) describes how to
    // construct an `QueryTag`, never how to call one, so it is not
    // surfaced here as a signature of an instance.
    const tconName = displayType.name;
    const callables = result.instanceCallables?.get(tconName);
    let rawBranches: Type[];
    if (callables && callables.length > 0) {
      rawBranches = callables.map(s => instantiate(s)).filter(t => t.tag === 'TFun');
    } else {
      rawBranches = [];
    }
    if (rawBranches.length > 0) {
      // Specialise each branch's carrier TVar with the host TCon's row
      // arg so e.g. `QueryTag {projected}` shown in signature help renders
      // as `({}) -> RTask r e [{projected}]` instead of leaving a bare
      // `[b]`.  When the host is a multi-arg container (`QueryTag p row`),
      // also substitute the parameter TVar in the overload's parameter
      // slot.  Mirrors the substitution applied in
      // `tryConstructorCallable` (`src/infer/index.ts`) and
      // `collectConstructorCallableOverloads` (`src/services/hover.ts`).
      const slots = findHostSlots(displayType);
      // Display-only fallback: if the host has no parameter slot in its
      // declared arity, fall back to a `paramHint` attached during
      // call-site post-processing (see `bindParamSlot` in
      // `src/infer/calls.ts`).
      const paramArg = slots.paramArg
        ?? (displayType.tag === 'TCon' ? displayType.paramHint ?? null : null);
      const branches = rawBranches.map(b => {
        if (b.tag !== 'TFun') return b;
        let out: Type = b;
        const { paramTVarId, carrierTVarId } = findOverloadSlots(out);
        if (slots.rowArg && carrierTVarId !== null) {
          out = substTVar(out, carrierTVarId, slots.rowArg);
        }
        if (paramArg && paramTVarId !== null) {
          out = substTVar(out, paramTVarId, paramArg);
        }
        return out;
      });
      overloadTypes = branches;
    } else {
      overloadTypes = [displayType];
    }
  } else {
    overloadTypes = [displayType];
  }

  const signatures: SignatureInformation[] = [];

  // Types of the arguments the user has actually typed, for DISPLAY: used to
  // (a) show each typed param with the user's concrete argument type instead
  // of the abstract one, and (b) specialise the return type by unifying the
  // typed args against the overload's abstract parameters.  Unlike the
  // overload-filtering scan above, this collects EVERY already-typed argument
  // (passing the end of the source as the cursor), not just those before the
  // caret — so editing the first argument still shows the later, already-typed
  // arguments specialised rather than reverting them to their abstract form.
  const typedArgs = collectTypedArgTypes(normSource, parenOffset, normSource.length, result);

  // For a curried callee, also collect one argument per applied frame so each
  // curried parameter (and the return type) can be specialised to what the
  // user has supplied so far (P4).
  const curriedArgs = curriedDisplay
    ? collectCurriedArgTypes(normSource, idEnd, parenOffset, normSource.length, result).types
    : [];

  for (const overloadType of overloadTypes) {
    if (curriedDisplay) {
      // Render the whole curried signature `name(p0)(p1)(p2) -> ret` with each
      // curried parameter as its own highlightable segment.  Parameters and the
      // return type are SPECIALISED by unifying each already-applied argument
      // against the corresponding flattened parameter — so `reduce(fn)(1)` shows
      // the seed/return as `Number` — while still rendering the parameter SHAPE
      // (`sub.apply(param)`), never the raw argument, so a partial lambda never
      // collapses the `(b -> a -> b)` callback to a bare variable.
      const { params: flatParams, result: resultType } = flattenCurriedType(overloadType);
      if (flatParams.length === 0) continue;

      let sub = new Substitution();
      for (let i = 0; i < flatParams.length; i++) {
        const at = curriedArgs[i];
        if (!at) continue;
        try {
          const s = unify(sub.apply(flatParams[i]), sub.apply(at));
          sub = s.compose(sub);
        } catch {
          // Incompatible (still typing / wrong branch) — keep what we have.
        }
      }

      let label = calleeName;
      const paramInfos: ParameterInformation[] = [];
      for (let i = 0; i < flatParams.length; i++) {
        label += '(';
        const start = label.length;
        label += prettyTypeToString(sub.apply(flatParams[i]));
        const end = label.length;
        label += ')';
        paramInfos.push({ label: [start, end] });
      }
      label += ` -> ${prettyTypeToString(sub.apply(resultType))}`;

      signatures.push({ label, parameters: paramInfos });
      continue;
    }

    const decomposed = decomposeFunctionType(overloadType);
    if (!decomposed) continue;
    const { params: paramTypes, returnType } = decomposed;
    if (paramTypes.length === 0) continue;

    // Specialise the signature to the user's input: unify each typed argument
    // against the corresponding abstract parameter so the accumulated
    // substitution can both refine later params and the return type.
    let sub = new Substitution();
    for (let i = 0; i < paramTypes.length; i++) {
      const at = typedArgs[i];
      if (!at) continue;
      try {
        const s = unify(sub.apply(paramTypes[i].type), sub.apply(at));
        sub = s.compose(sub);
      } catch {
        // Incompatible (still typing / wrong branch) — keep what we have.
      }
    }

    // Param labels: show the user's concrete argument type for slots already
    // typed, the (substitution-refined) abstract type otherwise.
    const paramLabels = paramTypes.map((p, i) => {
      const at = typedArgs[i];
      // Callback / function-typed slots: once the user has begun an argument in
      // the slot but it does NOT yet resolve to a function (an in-progress
      // `(a, b)` arrow still parses as a sequence expression, so `at` is a bare
      // variable — rendering `.sort(a) -> [String]`), show the expected
      // FUNCTION SHAPE instead — narrowed to its callable branch, dropping the
      // optional `| Undefined`.  A completed function argument (`at` is a
      // `TFun`) keeps its concrete inferred type; an empty slot keeps the full
      // union so the optional callback stays visible.
      if (at != null && at.tag !== 'TFun') {
        const fn = functionBranchesOf(sub.apply(p.type));
        if (fn) return prettyTypeToString(fn);
      }
      return prettyTypeToString(at ?? sub.apply(p.type));
    });
    const sigLabel = `${calleeName}(${paramLabels.join(', ')}) -> ${prettyTypeToString(sub.apply(returnType))}`;


    // Build parameter information with offsets for highlighting
    const paramInfos: ParameterInformation[] = [];
    let labelOffset = calleeName.length + 1; // after 'name('
    for (let i = 0; i < paramLabels.length; i++) {
      const start = labelOffset;
      const end = start + paramLabels[i].length;
      paramInfos.push({
        label: [start, end],
      });
      labelOffset = end + 2; // skip ', '
    }

    signatures.push({
      label: sigLabel,
      parameters: paramInfos,
    });
  }

  if (signatures.length === 0) return null;

  // Two overloads can specialise to the SAME rendered signature once the
  // already-applied curried arguments are substituted in (e.g. `Array a` and a
  // `Foldable f => f a` branch both collapse to `[a]` when the user opens an
  // array literal).  Collapse exact-label duplicates so the menu never shows
  // the same signature twice.
  const dedupedSignatures: typeof signatures = [];
  const seenLabels = new Set<string>();
  for (const sig of signatures) {
    if (seenLabels.has(sig.label)) continue;
    seenLabels.add(sig.label);
    dedupedSignatures.push(sig);
  }
  signatures.length = 0;
  signatures.push(...dedupedSignatures);

  // Pick the best active signature: prefer one whose param count matches the
  // number of arguments being typed (activeParam is 0-indexed, so activeParam+1
  // is the number of args so far). Fall back to the first signature.
  //
  // For a curried callee the active parameter is the curry-frame depth (each
  // curried application consumes exactly one parameter), not the comma index
  // within a single paren; the best signature is the first overload that still
  // has a parameter at that depth.
  const effectiveActiveParam = curriedDisplay ? curryDepth : activeParam;
  let bestSig = 0;
  const argCount = effectiveActiveParam + 1;
  for (let i = 0; i < signatures.length; i++) {
    const paramCount = signatures[i].parameters?.length ?? 0;
    if (paramCount >= argCount) {
      bestSig = i;
      break;
    }
  }

  return {
    signatures,
    activeSignature: bestSig,
    activeParameter: Math.min(effectiveActiveParam, (signatures[bestSig].parameters?.length ?? 1) - 1),
  };
}
