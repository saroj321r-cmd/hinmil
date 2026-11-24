// ============================================================================
// Type Utilities — higher-level operations on Type values
//
// WHAT THIS FILE DOES (in plain language)
// ---------------------------------------------------------------------------
// The building blocks of a type live in types.ts.  This file is the toolbox
// for *working with* whole type trees: walking through every part of a type,
// searching it, copying it with changes, merging two types into one, and
// recognising special shapes (like "a chain of functions" or "a variadic
// parameter list").
//
// The most important general-purpose tools are:
//   • mapType   — "walk the tree and rewrite the parts you care about"
//   • someType  — "does any part of this type satisfy a test?"
//   • eachType  — "visit every part of the tree once"
// Most other helpers here are built from these three.
//
// These are pure functions (no inference engine state) that perform
// structural transformations, pattern recognition, and traversal on the Type
// AST.  Primitive constructors and representations live in types.ts; this
// module holds the more complex algorithms that build on those primitives.
// ============================================================================

import {
  Type,
  TVar,
  TRow,
  tCon,
  tFun,
  tUnion,
  tVar,
  isWildcard,
  isSpread,
  isUnion,
  parseKvName,
  typeToString,
  structuralEquals,
  isSkolem,
  T_UNION,
  T_TUPLE,
  T_SPREAD_ARRAY,
  T_TYPEREP,
} from './types';

// Re-export for consumers that import from typeUtils
export { structuralEquals } from './types';

// ---------------------------------------------------------------------------
// Auto-union helpers
//
// Plain language: when the same variable can hold different types on
// different code paths (e.g. `x = 1` in one branch, `x = 'a'` in another),
// the checker combines them into a union (`Number | String`).  These helpers
// decide when that is allowed and perform the combining.
// ---------------------------------------------------------------------------

/** A type is unionable if it's a simple TCon (no higher-kinded args) or an
 *  existing Union type. */
export function isUnionable(t: Type): boolean {
  if (t.tag !== 'TCon') return false;
  if (t.name === T_UNION) return true;
  // Wildcards should not participate in union creation
  if (isWildcard(t)) return false;
  // Simple concrete type (String, Number, Boolean, …) — no args
  return t.args.length === 0;
}

/** Merge two unionable types into a single Union, flattening nested unions
 *  and deduplicating members. */
export function mergeUnion(a: Type, b: Type): Type {
  const members: Type[] = [];
  const addMember = (t: Type) => {
    if (t.tag === 'TCon' && t.name === T_UNION) {
      for (const m of t.args) addMember(m);
    } else {
      if (!members.some(m => structuralEquals(m, t))) {
        members.push(t);
      }
    }
  };
  addMember(a);
  addMember(b);
  return tUnion(members);
}

/**
 * Merge two TCon types with the same constructor name by unioning the
 * differing type arguments.  Returns the merged type, or null if the
 * types cannot be merged (different constructors, different arg counts,
 * or non-unionable differing args).
 *
 * Example: Either String Number + Either String String → Either String (String | Number)
 */
export function mergeSameConstructor(a: Type, b: Type): Type | null {
  if (a.tag !== 'TCon' || b.tag !== 'TCon') return null;
  if (a.name !== b.name || a.args.length !== b.args.length || a.args.length === 0) return null;
  const mergedArgs: Type[] = [];
  for (let i = 0; i < a.args.length; i++) {
    if (typeToString(a.args[i]) === typeToString(b.args[i])) {
      mergedArgs.push(a.args[i]);
    } else if (isUnionable(a.args[i]) && isUnionable(b.args[i])) {
      mergedArgs.push(mergeUnion(a.args[i], b.args[i]));
    } else {
      // Try recursively merging nested same-name constructors
      const nested = mergeSameConstructor(a.args[i], b.args[i]);
      if (nested) {
        mergedArgs.push(nested);
      } else {
        return null;
      }
    }
  }
  return tCon(a.name, mergedArgs);
}

// ---------------------------------------------------------------------------
// Generic type-tree traversal helpers
//
// Plain language: a type is a tree of parts (see types.ts).  These three
// functions are the standard ways to move through that tree — rewrite it
// (mapType), search it (someType), or just look at every part (eachType).
// ---------------------------------------------------------------------------

/**
 * Transform a type tree top-down with structural sharing.
 * `pre` is called on each node — if it returns a Type, that replaces the node
 * (no further recursion). If it returns `undefined`, children are recursed
 * and the node is reconstructed only when something changed.
 */
export function mapType(t: Type, pre: (t: Type) => Type | undefined): Type {
  const replaced = pre(t);
  if (replaced !== undefined) return replaced;
  switch (t.tag) {
    case 'TVar': return t;
    case 'TCon': {
      const newArgs = t.args.map(a => mapType(a, pre));
      if (newArgs.every((a, i) => a === t.args[i])) return t;
      return { ...t, args: newArgs };
    }
    case 'TFun': {
      const p = mapType(t.param, pre), r = mapType(t.result, pre);
      if (p === t.param && r === t.result) return t;
      return { ...t, param: p, result: r };
    }
    case 'TRecord': {
      const fields: Record<string, Type> = {};
      let changed = false;
      for (const k in t.fields) {
        const nv = mapType(t.fields[k], pre);
        if (nv !== t.fields[k]) changed = true;
        fields[k] = nv;
      }
      let newLabelFields = t.labelFields;
      if (t.labelFields) {
        const mapped = t.labelFields.map(lf => {
          const nl = mapType(lf.label, pre);
          const nt = mapType(lf.type, pre);
          if (nl === lf.label && nt === lf.type) return lf;
          changed = true;
          // Mapped label may have collapsed to a non-TLabel (defensive: keep original).
          return { label: nl.tag === 'TLabel' ? nl : lf.label, type: nt };
        });
        newLabelFields = mapped;
      }
      if (t.rest) {
        const newRest = mapType(t.rest, pre);
        if (newRest !== t.rest) changed = true;
        // Row position accepts TVar or TRow; anything else is dropped
        // (conservative — the caller's `pre` returned something that
        // can't sit in row position, so we close the record instead).
        if (changed) {
          const out: typeof t = { ...t, fields };
          if (newLabelFields !== t.labelFields) out.labelFields = newLabelFields;
          if (newRest.tag === 'TVar' || newRest.tag === 'TRow') out.rest = newRest;
          else delete (out as { rest?: TVar | TRow }).rest;
          return out;
        }
        return t;
      }
      if (!changed) return t;
      const out: typeof t = { ...t, fields };
      if (newLabelFields !== t.labelFields) out.labelFields = newLabelFields;
      return out;
    }
    case 'TLabel': return t;
    case 'TRow': return t;
    case 'TForall': {
      const b = mapType(t.body, pre);
      if (b === t.body) return t;
      return { ...t, body: b };
    }
  }
}

/**
 * Replace rigid skolem constants (`§N` TCons, produced by `instantiateSkolem`)
 * with fresh display type variables so a type can be shown to the user without
 * leaking internal skolem names.  Each distinct skolem maps to a single fresh
 * TVar (memoized per call) so shared skolems render with one consistent letter
 * (e.g. `§0 -> §1 -> §0` → `b -> a -> b`).  When `skolemToName` carries the
 * original annotation letter, that name is preserved on the display var.
 */
export function scrubSkolems(t: Type, skolemToName?: Map<string, string>): Type {
  const cache = new Map<string, Type>();
  return mapType(t, n => {
    if (!isSkolem(n)) return undefined;
    const name = (n as { name: string }).name;
    let v = cache.get(name);
    if (!v) {
      v = tVar(skolemToName?.get(name));
      cache.set(name, v);
    }
    return v;
  });
}

/** Returns true if `predicate` holds for any node in the type tree. */
export function someType(t: Type, predicate: (t: Type) => boolean): boolean {
  if (predicate(t)) return true;
  switch (t.tag) {
    case 'TVar': return false;
    case 'TCon': return t.args.some(a => someType(a, predicate));
    case 'TFun': return someType(t.param, predicate) || someType(t.result, predicate);
    case 'TRecord':
      for (const k in t.fields) { if (someType(t.fields[k], predicate)) return true; }
      if (t.labelFields) {
        for (const lf of t.labelFields) {
          if (someType(lf.label, predicate)) return true;
          if (someType(lf.type, predicate)) return true;
        }
      }
      if (t.rest && someType(t.rest, predicate)) return true;
      return false;
    case 'TLabel': return false;
    case 'TRow': return false;
    case 'TForall': return someType(t.body, predicate);
  }
}

/** Visit every node in a type tree. */
export function eachType(t: Type, visitor: (t: Type) => void): void {
  visitor(t);
  switch (t.tag) {
    case 'TVar': break;
    case 'TCon': t.args.forEach(a => eachType(a, visitor)); break;
    case 'TFun': eachType(t.param, visitor); eachType(t.result, visitor); break;
    case 'TRecord':
      for (const k in t.fields) eachType(t.fields[k], visitor);
      if (t.labelFields) {
        for (const lf of t.labelFields) {
          eachType(lf.label, visitor);
          eachType(lf.type, visitor);
        }
      }
      if (t.rest) eachType(t.rest, visitor);
      break;
    case 'TLabel':
    case 'TRow':
      break;
    case 'TForall':
      eachType(t.body, visitor);
      break;
  }
}

// ---------------------------------------------------------------------------
// Union replacement
// ---------------------------------------------------------------------------

/**
 * Replace occurrences of a specific union type in a type tree with a
 * replacement type.  Uses structural (string) comparison to match unions.
 */
export function replaceUnionInType(type: Type, union: Type, replacement: Type): Type {
  return mapType(type, t => isUnion(t) && structuralEquals(t, union) ? replacement : undefined);
}

// ---------------------------------------------------------------------------
// Spread / variadic chain helpers
//
// Plain language: some functions accept "any number of arguments" (variadic),
// written in signatures with a `...` marker, e.g. `(a, b, ...) -> z` or the
// curried chain `a -> b -> ... -> z`.  These helpers recognise those shapes
// and convert them to concrete forms once the real argument count is known.
// ---------------------------------------------------------------------------

/** Collect all TVar ids from a type into the given Set.  Also includes
 *  TLabel-variable ids — they live in the same id-space and need to be
 *  freshened/generalized alongside ordinary type variables.
 *
 *  Variables BOUND by a nested `TForall` are scoped to its body and are
 *  deliberately excluded — they are never free, so `generalize` must not
 *  re-quantify them and `instantiate` must not freshen them. */
export function collectTVarIdsFromType(t: Type, ids: Set<number>): void {
  switch (t.tag) {
    case 'TVar': ids.add(t.id); return;
    case 'TRow': ids.add(t.id); return;
    case 'TLabel':
      if (t.kind === 'var') ids.add(t.id);
      return;
    case 'TCon': {
      // Kind-variable TCon names (`$kv:p:376`) carry a type-variable id
      // embedded in the name string.  Without collecting it here, the kv
      // var is invisible to `generalize` (so it never gets quantified) and
      // to `instantiate` (so it never gets freshened) — letting a stale kv
      // id leak across an import boundary and collide with an unrelated
      // binding in the consumer (e.g. `p a c` resolving to `Arrow String a c`).
      const kv = parseKvName(t.name);
      if (kv) ids.add(kv.varId);
      for (const a of t.args) collectTVarIdsFromType(a, ids);
      return;
    }
    case 'TFun':
      collectTVarIdsFromType(t.param, ids);
      collectTVarIdsFromType(t.result, ids);
      return;
    case 'TRecord':
      for (const k in t.fields) collectTVarIdsFromType(t.fields[k], ids);
      if (t.labelFields) {
        for (const lf of t.labelFields) {
          collectTVarIdsFromType(lf.label, ids);
          collectTVarIdsFromType(lf.type, ids);
        }
      }
      if (t.rest) collectTVarIdsFromType(t.rest, ids);
      return;
    case 'TForall': {
      const inner = new Set<number>();
      collectTVarIdsFromType(t.body, inner);
      for (const v of t.vars) inner.delete(v);
      for (const id of inner) ids.add(id);
      return;
    }
  }
}

/**
 * Given a template type where `targetId` appears at some structural position,
 * return the type at the SAME position in `target`.  Returns null if the
 * structures don't match or if targetId isn't found in the template.
 */
export function extractCorresponding(template: Type, target: Type, targetId: number): Type | null {
  if (template.tag === 'TVar' && template.id === targetId) return target;
  if (template.tag === 'TCon' && target.tag === 'TCon' &&
      (template.name === target.name || !!parseKvName(template.name)) &&
      template.args.length === target.args.length) {
    for (let i = 0; i < template.args.length; i++) {
      const found = extractCorresponding(template.args[i], target.args[i], targetId);
      if (found) return found;
    }
  }
  if (template.tag === 'TFun' && target.tag === 'TFun') {
    const fromParam = extractCorresponding(template.param, target.param, targetId);
    if (fromParam) return fromParam;
    return extractCorresponding(template.result, target.result, targetId);
  }
  return null;
}

/** Create a fresh copy of a type, replacing all TVars (and TLabel-vars)
 *  with new fresh ones — keeping shared identity within `t`.
 *
 *  `pinned` (optional) is a set of variable ids that must NOT be freshened:
 *  vars that also occur outside the type being copied (e.g. a params var `p`
 *  threaded from an array-element union into the callee's result type) keep
 *  their identity so per-element freshening doesn't sever the link. */
export function freshenType(t: Type, pinned?: ReadonlySet<number>): Type {
  const mapping = new Map<number, Type>();
  const labelMapping = new Map<number, Type>();
  const pre = (n: Type): Type | undefined => {
    if (n.tag === 'TVar') {
      if (pinned?.has(n.id)) return undefined;
      if (!mapping.has(n.id)) mapping.set(n.id, tVar());
      return mapping.get(n.id)!;
    }
    if (n.tag === 'TLabel' && n.kind === 'var') {
      if (pinned?.has(n.id)) return undefined;
      if (!labelMapping.has(n.id)) labelMapping.set(n.id, { tag: 'TLabel', kind: 'var', id: tVar().id, name: n.name });
      return labelMapping.get(n.id)!;
    }
    if (n.tag === 'TForall') {
      // Freshen the bound vars too (through the SAME mapping so body
      // occurrences stay linked) and rewrite the vars list accordingly —
      // otherwise the quantifier would list stale ids that no longer occur
      // in the freshened body.
      const vars = n.vars.map(id => {
        if (pinned?.has(id)) return id;
        if (!mapping.has(id)) mapping.set(id, tVar());
        return (mapping.get(id) as TVar).id;
      });
      return { ...n, vars, body: mapType(n.body, pre) };
    }
    return undefined;
  };
  return mapType(t, pre);
}

/**
 * Replace Tuple nodes containing spread markers with concrete Tuple nodes
 * using the given concrete parameter list.  Used after spread-function wrapper
 * inference to strip the `...` from result types.
 *
 * Example: (String, Number, ...) -> String  →  (String, Number) -> String
 */
export function replaceSpreadTupleWithConcrete(type: Type, concreteParams: Type[]): Type {
  return mapType(type, n => {
    if (n.tag === 'TCon'
        && (n.name === T_TUPLE || n.name === T_SPREAD_ARRAY)
        && n.args.some(a => isSpread(a))) {
      if (concreteParams.length === 1) return concreteParams[0];
      return tCon(T_TUPLE, concreteParams);
    }
    return undefined;
  });
}

/**
 * Check if an arrow chain (TFun chain) contains a bare spread marker as a
 * param.  This distinguishes curry-style results (a -> b -> ... -> z) from
 * multi-param function results ((a, b, ...) -> z).
 */
export function hasSpreadInArrowChain(t: Type): boolean {
  if (t.tag !== 'TFun') return false;
  if (isSpread(t.param)) return true;
  return hasSpreadInArrowChain(t.result);
}

/** Check if a type is a Tuple or SpreadArray containing spread markers. */
export function isSpreadTupleOrArray(t: Type): boolean {
  return t.tag === 'TCon' &&
    (t.name === T_TUPLE || t.name === T_SPREAD_ARRAY) &&
    t.args.some(a => isSpread(a));
}

/**
 * Collapse a curried level that was written with multiple parameters
 * (`(x, dummy) => …`, typed with a Tuple param) down to its first parameter.
 * In a spread arrow chain each level consumes a SINGLE argument, so the
 * surplus parameters are `undefined` at runtime and the level behaves like
 * `x -> …`.  Spread tuples (variadic markers) and empty tuples are left
 * untouched.
 */
export function collapseMultiParamLevel(t: Type): Type {
  if (t.tag === 'TCon' && t.name === T_TUPLE) {
    const args = t.args;
    if (args.length > 0 && !args.some(a => isSpread(a))) {
      return args[0];
    }
  }
  return t;
}

/**
 * A spread tuple/array whose non-spread elements are ALL arrows — i.e. a
 * chained sequence of functions `(a -> b, b -> c, ..., y -> z)` (or the bracket
 * form).  This is how a container-wrapped chain `f (a->b,...,y->z)` stores its
 * element sequence.  Part of the chain-combinator subsystem's predicate surface
 * (re-exported via `src/infer/functionPatterns.ts`).
 */
export function isArrowChainTuple(t: Type): t is Type & { tag: 'TCon'; args: Type[] } {
  if (t.tag !== 'TCon') return false;
  if (t.name !== T_TUPLE && t.name !== T_SPREAD_ARRAY) return false;
  if (!t.args.some(a => isSpread(a))) return false;
  const nonSpread = t.args.filter(a => !isSpread(a));
  return nonSpread.length > 0 && nonSpread.every(a => a.tag === 'TFun');
}

/**
 * Collapse an arrow-chain tuple to its overall composed arrow
 * `first.param -> last.result` (e.g. `(a->b, b->c, ..., y->z)` → `a -> z`).
 */
export function collapseArrowChainTuple(t: Type & { tag: 'TCon'; args: Type[] }): Type | null {
  const nonSpread = t.args.filter(a => !isSpread(a));
  const first = nonSpread[0];
  const last = nonSpread[nonSpread.length - 1];
  if (first.tag !== 'TFun' || last.tag !== 'TFun') return null;
  return tFun(first.param, last.result);
}

/**
 * True when a curried arrow chain contains a bare spread marker (`...`) as a
 * TOP-LEVEL parameter — i.e. reachable by walking `.result` links without first
 * passing through a param that is itself a function type.  This is the genuine
 * variadic-chain shape (`a -> b -> ... -> z`) that `unifySpreadArrowChain` can
 * absorb.  A type whose spread is nested inside a higher-order parameter
 * (`(a -> b -> ... -> z) -> r`) is a plain function and returns `false`, so it
 * decomposes structurally instead.
 */
export function hasTopLevelSpreadChain(t: Type): boolean {
  let cur: Type = t;
  while (cur.tag === 'TFun') {
    if (isSpread(cur.param)) return true;
    // A function-typed parameter means this is a higher-order function, not a
    // flat variadic chain — stop before flattening across it.
    if (cur.param.tag === 'TFun') return false;
    cur = cur.result;
  }
  return false;
}

/**
 * Detect the chain link pattern in spread tuple elements.
 * Returns the direction (ltr/rtl), structural templates for result/param sides,
 * and the shared TVar id that forms the chain link.
 *
 * LTR example: (a->b), (b->c) — result of elem[i] links to param of elem[i+1]
 * RTL example: (b->c), (a->b) — param of elem[i] links to result of elem[i+1]
 * HK example:  (a->m b), (b->m c) — inner of result links to param (still LTR)
 */
export function detectSpreadChainLink(before: Type[], after: Type[]): {
  direction: 'ltr' | 'rtl';
  resultTemplate: Type;
  paramTemplate: Type;
  linkId: number;
} | null {
  function findInElements(elements: Type[]): ReturnType<typeof detectSpreadChainLink> {
    if (elements.length < 2) return null;
    for (let i = 0; i < elements.length - 1; i++) {
      const a = elements[i], b = elements[i + 1];
      if (a.tag !== 'TFun' || b.tag !== 'TFun') continue;

      // Check LTR: result(a) shares TVar with param(b)
      const resultAIds = new Set<number>();
      collectTVarIdsFromType(a.result, resultAIds);
      const paramBIds = new Set<number>();
      collectTVarIdsFromType(b.param, paramBIds);
      for (const id of resultAIds) {
        if (paramBIds.has(id)) {
          return { direction: 'ltr', resultTemplate: a.result, paramTemplate: b.param, linkId: id };
        }
      }

      // Check RTL: param(a) shares TVar with result(b)
      const paramAIds = new Set<number>();
      collectTVarIdsFromType(a.param, paramAIds);
      const resultBIds = new Set<number>();
      collectTVarIdsFromType(b.result, resultBIds);
      for (const id of paramAIds) {
        if (resultBIds.has(id)) {
          return { direction: 'rtl', resultTemplate: b.result, paramTemplate: a.param, linkId: id };
        }
      }
    }
    return null;
  }

  // Try before first (pipe patterns), then after (compose patterns)
  return findInElements(before) ?? findInElements(after);
}

/** Extract the TVar IDs from the parameter positions of a (possibly curried)
 *  function type.  Returns undefined for positions that are not plain TVars. */
export function extractParamTVarIds(t: Type, numParams: number): (number | undefined)[] {
  const result: (number | undefined)[] = [];
  let current = t;
  for (let i = 0; i < numParams; i++) {
    if (current.tag === 'TFun') {
      result.push(current.param.tag === 'TVar' ? current.param.id : undefined);
      current = current.result;
    } else if (current.tag === 'TCon' && current.name === '->') {
      const param = current.args[0];
      result.push(param.tag === 'TVar' ? param.id : undefined);
      current = current.args[1];
    } else {
      result.push(undefined);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Type structure helpers
// ---------------------------------------------------------------------------

/** Check whether a type contains any of the given quantified variable ids. */
export function containsQuantifiedVar(t: Type, vars: ReadonlySet<number>): boolean {
  return someType(t, n => n.tag === 'TVar' && vars.has(n.id));
}

// ---------------------------------------------------------------------------
// Carrier-TVar specialisation
// ---------------------------------------------------------------------------

/**
 * Locate the id of the "carrier" TVar in a result type — i.e. the
 * element-position TVar inside the innermost `[?]` (Array) wrapper,
 * recursing through any number of TCon wrappers (`Promise [a]`,
 * `RTask r e [a]`, `[a]` itself).
 *
 * Returns null when no Array-element TVar can be located.
 *
 * Used by both inference (`tryConstructorCallable` in `src/infer/index.ts`)
 * and hover (`collectConstructorCallableOverloads` in
 * `src/services/hover.ts`) to specialise an imported value-as-callable
 * overload like `QueryTag :: a -> RTask r e [b]` with the host TCon's row
 * arg, so calling/chaining/displaying the value all see the projected
 * row instead of a bare type variable.
 */
export function findCarrierTVarId(t: Type): number | null {
  if (t.tag === 'TCon') {
    if (t.name === 'Array' && t.args.length === 1) {
      const elem = t.args[0];
      if (elem.tag === 'TVar') return elem.id;
      return findCarrierTVarId(elem);
    }
    for (const a of t.args) {
      const found = findCarrierTVarId(a);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Locate the slots of a value-as-callable overload branch so the
 * surrounding host TCon's args can be substituted into them.
 *
 * - `paramTVarId`: id of the parameter TVar (the `a` in
 *   `a -> RTask r e [b]`).  Used to substitute the host's
 *   parameter-record arg (the `p` in `QueryTag p row`) into the overload's
 *   parameter slot.  Null when the parameter isn't a bare TVar (e.g.
 *   already a concrete record).
 * - `carrierTVarId`: as returned by `findCarrierTVarId` — the
 *   element-position TVar inside the innermost `[?]` wrapper of the
 *   result type.  Used to substitute the host's row arg into the
 *   overload's carrier slot.
 */
export function findOverloadSlots(branch: Type): {
  paramTVarId: number | null;
  carrierTVarId: number | null;
} {
  if (branch.tag !== 'TFun') return { paramTVarId: null, carrierTVarId: null };
  const paramTVarId = branch.param.tag === 'TVar' ? branch.param.id : null;
  const carrierTVarId = findCarrierTVarId(branch.result) ?? findTrailingTVarId(branch.result);
  return { paramTVarId, carrierTVarId };
}

/**
 * Fallback carrier for a result without an Array element: the LAST type
 * argument of the (innermost) wrapper, looking through a union.  A single-row
 * query `QueryOne() :: p -> Promise e (o | Null)` or a task
 * `p -> RTask r Error o` carries its row in that position, by the same
 * convention `findHostSlots` uses for the host (`row` is the last arg).
 */
function findTrailingTVarId(t: Type): number | null {
  if (t.tag === 'TVar') return t.id;
  if (t.tag !== 'TCon' || t.args.length === 0) return null;
  if (t.name === 'Union') {
    for (const member of t.args) {
      if (member.tag === 'TVar') return member.id;
    }
    return null;
  }
  return findTrailingTVarId(t.args[t.args.length - 1]);
}

/**
 * Identify the parameter and row args carried by a host TCon (e.g.
 * `QueryTag <param> <row>` or the legacy 1-arg `QueryTag <row>`).
 *
 * Convention: the trailing arg is always the row (the value the
 * container holds); when there are two or more args the second-to-last
 * is the parameter record.  Used by hover, signature help and the
 * unification bridge to pump these args into a value-as-callable
 * overload's slots.
 */
export function findHostSlots(host: Type): { paramArg: Type | null; rowArg: Type | null } {
  if (host.tag !== 'TCon' || host.args.length === 0) {
    return { paramArg: null, rowArg: null };
  }
  if (host.args.length === 1) return { paramArg: null, rowArg: host.args[0] };
  return {
    paramArg: host.args[host.args.length - 2],
    rowArg: host.args[host.args.length - 1],
  };
}

/** Substitute a single TVar id with `replacement` everywhere in `t`. */
export function substTVar(t: Type, id: number, replacement: Type): Type {
  if (t.tag === 'TVar') return t.id === id ? replacement : t;
  if (t.tag === 'TCon') {
    const newArgs = t.args.map(a => substTVar(a, id, replacement));
    if (newArgs.every((a, i) => a === t.args[i])) return t;
    return { ...t, args: newArgs };
  }
  if (t.tag === 'TFun') {
    const p = substTVar(t.param, id, replacement);
    const r = substTVar(t.result, id, replacement);
    if (p === t.param && r === t.result) return t;
    return { ...t, param: p, result: r };
  }
  if (t.tag === 'TRecord') {
    const fields: Record<string, Type> = {};
    let changed = false;
    for (const k in t.fields) {
      const nv = substTVar(t.fields[k], id, replacement);
      if (nv !== t.fields[k]) changed = true;
      fields[k] = nv;
    }
    if (!changed) return t;
    return { ...t, fields };
  }
  return t;
}

// ---------------------------------------------------------------------------
// Call-site union narrowing
// ---------------------------------------------------------------------------

/**
 * Narrow union parameter→result correlation at a call site.
 * When the actual argument is a single member of a union-typed parameter,
 * narrow the result type accordingly.
 *
 * Example: `(Number | null) -> Number | null` called with `Number`
 *        → result narrows to `Number` instead of `Number | null`.
 */
export function narrowCallResultByArgs(result: Type, paramTypes: Type[], argTypes: Type[]): Type {
  for (let i = 0; i < paramTypes.length && i < argTypes.length; i++) {
    const param = paramTypes[i];
    const arg = argTypes[i];

    // Only narrow if param is a union and arg is NOT a union
    if (!isUnion(param)) continue;
    if (isUnion(arg)) continue;

    // Check if the arg type is a member of the param union
    const isMember = param.args.some(m => structuralEquals(m, arg));
    if (!isMember) continue;

    // Only the result AS A WHOLE narrows (`(Number | Null) -> Number | Null`
    // called with a Number).  A union inside a declared result (a record
    // field `reason :: String | Null` of an annotated `S`) is a promise of
    // that type, not a copy of the argument: narrowing it there made two
    // calls `f ("x")` and `f (null)` disagree on `S`.
    if (structuralEquals(result, param)) result = arg;
  }
  return result;
}

/**
 * Replace `TCon('Union', [...])` nodes with fresh TVars throughout a type tree.
 * This prevents infinite-type errors when unifying variant-specific property
 * types (e.g. `e`) against their general union form (e.g. `a | e`).
 */
export function neutralizeUnions(type: Type): Type {
  return mapType(type, n => (n.tag === 'TCon' && n.name === T_UNION) ? tVar() : undefined);
}

// ---------------------------------------------------------------------------
// Kind-variable TypeRep fixup
// ---------------------------------------------------------------------------

/**
 * Collect kv-TCon applications in a type.  For each kv-TCon `$kv:m:ID(a)`,
 * maps the embedded varId to the full TCon node.
 * E.g. for `$kv:m:100(a)`, maps 100 → TCon('$kv:m:100', [TVar('a', 101)]).
 */
export function collectKvApplications(t: Type, out: Map<number, Type>): void {
  eachType(t, node => {
    if (node.tag === 'TCon') {
      const kv = parseKvName(node.name);
      if (kv && node.args.length > 0 && !out.has(kv.varId)) out.set(kv.varId, node);
    }
  });
}

/**
 * Replace bare TVars inside TypeRep nodes with their kv-applied form.
 * When an applied constraint like `Monoid (m a)` creates a kv-TCon `$kv:m:100(a)`
 * for the return/body type, but `TypeRep m` in the parameters uses a bare
 * TVar('m', 100), the shared varId creates circularity during unification.
 * This function fixes `TypeRep(TVar('m', 100))` → `TypeRep($kv:m:100(a))`.
 */
export function fixTypeRepKvVars(t: Type, kvApps: Map<number, Type>): Type {
  return mapType(t, node => {
    if (node.tag === 'TCon' && node.name === T_TYPEREP && node.args.length === 1 && node.args[0].tag === 'TVar') {
      const kvApp = kvApps.get(node.args[0].id);
      if (kvApp) return tCon(T_TYPEREP, [kvApp]);
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Function-type decomposition
// ---------------------------------------------------------------------------

/**
 * Extract individual parameter types from a function type.
 *   (a, b) -> c  →  [a, b]
 *   a -> b       →  [a]
 *   non-TFun     →  []
 */
export function extractParamList(t: Type): Type[] {
  if (t.tag !== 'TFun') return [];
  if (t.param.tag === 'TCon' && t.param.name === T_TUPLE) return t.param.args;
  return [t.param];
}

/**
 * Discriminate a single overloaded-branch parameter against a concrete
 * argument type, for the purpose of overload SELECTION and signature-help
 * filtering.  This is a *discriminator*, not a unifier: it answers "could
 * this argument plausibly have been meant for this parameter, and if so how
 * precisely does it match?" — without the lenient field-merging that ordinary
 * record unification performs (which would let `{ name }` silently satisfy a
 * `{ nam }` parameter and so make every record overload ambiguous).
 *
 *   'reject'  — provably the wrong branch: both sides are closed records and
 *               the parameter requires a field the argument does not provide.
 *   'exact'   — a precise match: equal closed-record field sets, or matching
 *               nominal record aliases.
 *   'neutral' — no discriminating signal (open records, label-keyed records,
 *               type variables, non-record types, or a structural superset);
 *               the caller should fall back to ordinary unification.
 */
export function discriminateRecordArg(
  argT: Type,
  paramT: Type,
): 'reject' | 'exact' | 'neutral' {
  if (argT.tag !== 'TRecord' || paramT.tag !== 'TRecord') return 'neutral';
  // Open or label-keyed records carry a row tail / wildcard key and are
  // intentionally lenient — never discriminate on them.
  if (argT.rest || paramT.rest) return 'neutral';
  if ((argT.labelFields && argT.labelFields.length) ||
      (paramT.labelFields && paramT.labelFields.length)) return 'neutral';

  const paramKeys = Object.keys(paramT.fields);
  // A closed parameter requires every one of its fields; if the argument is
  // missing one, it cannot have been meant for this branch.
  for (const pk of paramKeys) {
    if (!(pk in argT.fields)) return 'reject';
  }
  const argKeys = Object.keys(argT.fields);
  // Nominal match on a shared alias is the strongest precise signal.
  if (argT.alias && paramT.alias && argT.alias === paramT.alias) return 'exact';
  // Equal field-name sets → a precise structural match.
  if (argKeys.length === paramKeys.length) return 'exact';
  // Argument is a structural superset (has extra fields): compatible, but not
  // a precise discriminator on its own.
  return 'neutral';
}


/**
 * Rename kind-variable TCon names in a type tree.
 * Used during instantiation to give kv names fresh IDs.
 */
export function renameKvInType(t: Type, kvMap: Map<string, string>): Type {
  return mapType(t, n =>
    (n.tag === 'TCon' && kvMap.has(n.name))
      ? tCon(kvMap.get(n.name)!, n.args.map(a => renameKvInType(a, kvMap)))
      : undefined);
}
