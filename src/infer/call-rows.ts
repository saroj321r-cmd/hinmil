// ============================================================================
// Row/record projection & expansion subsystem for call inference — extracted
// from calls.ts
//
// Plain language: some libraries build queries from column lists, e.g.
// `Person(['id', 'name'])` meaning "select these fields".  This subsystem
// lets annotations describe that: a `Picked R sel` marker in a signature is
// replaced, at the call site, by a record built from the literal arguments
// ("project these fields out of row R"), and a `Merge a b` marker collapses
// two record shapes into one.  It is the machinery behind precise types for
// query-builder style APIs.
// ============================================================================

import type { TLabel, TRecord } from '../hm/types';
import { isAppliedObject, isAnyType, tAnyType, tString, T_OBJECT } from '../hm/types';
import type { InferenceEngine } from './index';
import {
  Type,
  tVar,
  tFun,
  tArray,
  tCon,
  tRecord,
  tUnion,
  deepMergeTypes,
  structuralEquals,
  AstNode,
  prettyTypeToString,
  T_TUPLE,
  T_UNION,
  T_ARRAY,
  T_PICKED,
  T_MERGE,
} from '../hm/types';
import { TypeEnv, instantiate } from '../hm/env';
import { unify} from '../hm/unify';
import {
  mapType,
  someType,
  eachType,
  findHostSlots,
  findOverloadSlots,
} from '../hm/typeUtils';
import { getMethodNames, lookupMethod } from '../registries/methodRegistry';
import { lookupConstraint } from '../registries/constraintRegistry';
import type * as estree from '../estree';

// ---------------------------------------------------------------------------
// Label-group row expansion — shared machinery
//
// Two call-site strategies expand a label group `{ [k] :: a }` into concrete
// per-key fields:
//   • `tryExpandRowMap`            — keys come from an object-literal argument
//                                    (`unwrap({ a: …, b: … })`).
//   • `tryExpandKeySetFromArrayArg`— keys come from an inline array-literal of
//                                    string keys (`omit(["a", "b"])`).
// They differ ONLY in where the key set comes from; the variable
// classification (Pass 1), per-group fresh-var planning (Pass 2) and the type
// rewrite (Pass 3) below are shared.
// ---------------------------------------------------------------------------

/** Per-group expansion plan: the concrete keys to materialise, a fresh-var
 *  map per key (so each key gets its own independent value vars), and the
 *  value vars that ALSO occur outside the group and must collapse into a union
 *  of the per-key fresh vars. */
type RowExpansionPlan = { keys: string[]; freshMaps: Array<Map<number, Type>>; outsideUnionIds: number[] };

/** The curried parameter-slot types of a resolved function type (the slots
 *  that line up with the supplied argument nodes). */
function curriedParamTypes(resolved: Type): Type[] {
  const argTypes: Type[] = [];
  if (resolved.tag === 'TFun' && resolved.param.tag === 'TCon' && resolved.param.name === T_TUPLE) {
    for (const a of resolved.param.args) argTypes.push(a);
  } else {
    let cur: Type = resolved;
    while (cur.tag === 'TFun') { argTypes.push(cur.param); cur = cur.result; }
  }
  return argTypes;
}

/** Pass 1 — classify every TVar / TLabel-var occurrence as living inside a
 *  label group (keyed by the group's label-var id) or outside every group. */
function classifyRowGroupVars(
  engine: InferenceEngine,
  resolved: Type,
): { groupValueVars: Map<number, Set<number>>; outsideVars: Set<number> } {
  const groupValueVars = new Map<number, Set<number>>();
  const outsideVars = new Set<number>();
  const noteInside = (kid: number, id: number) => {
    let s = groupValueVars.get(kid);
    if (!s) { s = new Set(); groupValueVars.set(kid, s); }
    s.add(id);
  };
  // `resolved` is already substituted, so composite nodes need no re-apply
  // (re-applying every subtree at every level was quadratic and showed up as
  // ~5% of the FP-library lint).  Leaves are still resolved — a cheap lookup.
  const visit = (t: Type, insideKid: number | null): void => {
    const r = t.tag === 'TVar' || t.tag === 'TLabel' ? engine.subst.apply(t) : t;
    if (r.tag === 'TVar') {
      if (insideKid === null) outsideVars.add(r.id);
      else noteInside(insideKid, r.id);
      return;
    }
    if (r.tag === 'TLabel') {
      if (r.kind === 'var') {
        if (insideKid === null) outsideVars.add(r.id);
        else noteInside(insideKid, r.id);
      }
      return;
    }
    if (r.tag === 'TCon') { for (const a of r.args) visit(a, insideKid); return; }
    if (r.tag === 'TFun') { visit(r.param, insideKid); visit(r.result, insideKid); return; }
    if (r.tag === 'TRecord') {
      for (const k in r.fields) visit(r.fields[k], insideKid);
      if (r.labelFields) {
        for (const lf of r.labelFields) {
          const lbl = engine.subst.apply(lf.label);
          if (lbl.tag === 'TLabel' && lbl.kind === 'var') visit(lf.type, lbl.id);
          else visit(lf.type, insideKid);
        }
      }
      if (r.rest) visit(r.rest, insideKid);
    }
  };
  visit(resolved, null);
  return { groupValueVars, outsideVars };
}

/** Pass 2 — build a fresh-var expansion plan for one group over `keys`.
 *
 *  Internal vars (live only inside this group) get a fresh var per key.  An
 *  "outside-union" var also appears outside any group (e.g. the return of
 *  `{ [k]::a } -> [a]`): each key gets its own fresh var so heterogeneous
 *  values are accepted, and the outside occurrence later becomes the union of
 *  those fresh vars (see {@link applyRowExpansionPlan}). */
function buildRowExpansionPlan(
  keys: string[],
  kid: number,
  groupValueVars: Map<number, Set<number>>,
  outsideVars: Set<number>,
): RowExpansionPlan {
  const valueVars = groupValueVars.get(kid) ?? new Set<number>();
  const internalIds = new Set<number>();
  const outsideUnionIds = new Set<number>();
  for (const v of valueVars) {
    let inOther = false;
    for (const [otherKid, otherSet] of groupValueVars) {
      if (otherKid !== kid && otherSet.has(v)) { inOther = true; break; }
    }
    if (inOther) continue;   // shared across groups → leave for cross-group merge
    if (outsideVars.has(v)) outsideUnionIds.add(v);
    else internalIds.add(v);
  }
  const allFreshIds = new Set<number>([...internalIds, ...outsideUnionIds]);
  const freshMaps: Array<Map<number, Type>> = keys.map(() => {
    const m = new Map<number, Type>();
    for (const id of allFreshIds) m.set(id, tVar());
    return m;
  });
  return { keys, freshMaps, outsideUnionIds: [...outsideUnionIds] };
}

/** Pass 3 — rewrite the type, expanding every planned label group into
 *  concrete per-key fields (preserving any row tail), then collapse each
 *  group's outside-union vars into a union of their per-key fresh vars. */
function applyRowExpansionPlan(
  engine: InferenceEngine,
  resolved: Type,
  planByKid: Map<number, RowExpansionPlan>,
): Type {
  const applyFresh = (t: Type, fresh: Map<number, Type>): Type =>
    mapType(t, n => {
      if (n.tag === 'TVar' && fresh.has(n.id)) return fresh.get(n.id);
      return undefined;
    });

  const rewrite = (t: Type): Type =>
    mapType(t, n => {
      if (n.tag !== 'TRecord' || !n.labelFields || n.labelFields.length === 0) return undefined;
      const newFields: Record<string, Type> = { ...n.fields };
      const remainingLabel: NonNullable<typeof n.labelFields> = [];
      // Keys materialised by an EARLIER label group in this same record: when a
      // later group expands to one of these keys, the contributions are
      // DEEP-merged (deferred to `applyMergeReduction` via a `Merge` marker)
      // rather than first-wins dropped.
      const fromGroup = new Set<string>();
      let changed = false;
      for (const lf of n.labelFields) {
        const lbl = engine.subst.apply(lf.label);
        if (lbl.tag === 'TLabel' && lbl.kind === 'var' && planByKid.has(lbl.id)) {
          const plan = planByKid.get(lbl.id)!;
          const innerRewritten = rewrite(lf.type);
          for (let i = 0; i < plan.keys.length; i++) {
            const k = plan.keys[i];
            const expanded = applyFresh(innerRewritten, plan.freshMaps[i]);
            if (fromGroup.has(k)) {
              const prior = newFields[k];
              newFields[k] = prior.tag === 'TCon' && prior.name === T_MERGE
                ? tCon(T_MERGE, [...prior.args, expanded])
                : tCon(T_MERGE, [prior, expanded]);
            } else if (k in newFields) {
              continue;   // overlap with a pre-existing static field → static wins
            } else {
              newFields[k] = expanded;
              fromGroup.add(k);
            }
          }
          changed = true;
        } else {
          remainingLabel.push({ label: lf.label, type: rewrite(lf.type) });
        }
      }
      // Recurse into static fields too.
      for (const k of Object.keys(newFields)) {
        if (n.fields[k] === newFields[k]) newFields[k] = rewrite(newFields[k]);
      }
      if (!changed) return undefined;
      const out: typeof n = { tag: 'TRecord', fields: newFields };
      if (remainingLabel.length > 0) out.labelFields = remainingLabel;
      if (n.rest) {
        out.rest = n.rest;
        // An open label-group row must deep-merge the fields the row var later
        // absorbs with the keys expanded here.
        out.mergeRow = true;
      }
      if (n.alias) out.alias = n.alias;
      return out;
    });

  let rewritten = rewrite(resolved);

  // Replace each group's outside-union var (the value var that also appears
  // outside any label group, e.g. the result `[a]` of `{ [k]::a } -> [a]`)
  // with the union of the per-key fresh vars it expanded to.
  for (const [, plan] of planByKid) {
    for (const uid of plan.outsideUnionIds) {
      const members = plan.freshMaps.map(m => m.get(uid)!).filter(Boolean);
      if (members.length === 0) continue;
      const unionT = members.length === 1 ? members[0] : tUnion(members);
      rewritten = mapType(rewritten, n =>
        (n.tag === 'TVar' && n.id === uid) ? unionT : undefined);
    }
  }

  return rewritten;
}

/**
 * Static key-set removal for `omit`-style signatures applied to an inline
 * array literal of string keys.
 * A curried signature such as
 *   omit :: Array String k => k -> { [k] :: a, ...r } -> {r}
 * (baked to `[String] -> { [k] :: a, ...r } -> {r}`) receives its two
 * arguments at SEPARATE curried call sites — the key array at `omit([...])`
 * and the record at the following `(obj)` — so ordinary row unification only
 * ever sees one of them and can remove at most the single label `[k]`.  That
 * is why `omit(["name", "age"])({ name, age, country })` previously kept `age`
 * (only the first key was dropped).
 *
 * When the argument supplied to a parameter typed `Array String` is an inline
 * array literal of string literals, the key set is known statically.  We then
 * expand the label group `{ [k] :: a, ...r }` found in a LATER curried
 * parameter into one concrete field per key (each with a fresh value var),
 * keeping the row tail `...r`.  Unifying the record argument afterwards binds
 * every listed key and leaves the remainder in `...r`, so the result `{r}` is
 * the record minus ALL listed keys.
 *
 * Only fires for inline array literals of string literals — a key array coming
 * from a variable carries no type-level key information and is left to ordinary
 * single-label row unification.  Guarded to the `omit` shape: the label group's
 * row tail must also flow to the function result (`… -> {r}`), and the group
 * must hold exactly one label variable.
 */
export function tryExpandKeySetFromArrayArg(
  engine: InferenceEngine,
  calleeType: Type,
  argNodes: ReadonlyArray<AstNode>,
): Type {
  const resolved = engine.subst.apply(calleeType);
  if (resolved.tag !== 'TFun') return calleeType;

  const { groupValueVars, outsideVars } = classifyRowGroupVars(engine, resolved);
  if (groupValueVars.size === 0) return calleeType;

  const argTypes = curriedParamTypes(resolved);

  // 1. Find an inline array literal of string literals whose parameter slot is
  //    `Array String` — the statically-known key set.
  let keys: string[] | null = null;
  for (let i = 0; i < argNodes.length && i < argTypes.length; i++) {
    const an = argNodes[i] as unknown as estree.ArrayExpression;
    if (!an || an.type !== 'ArrayExpression') continue;
    const pt = engine.subst.apply(argTypes[i]);
    const isStringArray =
      pt.tag === 'TCon' && pt.name === T_ARRAY && pt.args.length === 1 &&
      pt.args[0].tag === 'TCon' && pt.args[0].name === 'String';
    if (!isStringArray) continue;
    const ks: string[] = [];
    let ok = true;
    for (const el of an.elements) {
      if (el && el.type === 'Literal' && typeof (el as estree.Literal).value === 'string') {
        ks.push((el as estree.Literal).value as string);
      } else { ok = false; break; }
    }
    if (!ok || ks.length === 0) continue;
    keys = ks;
    break;
  }
  if (!keys) return calleeType;

  // 2. Restrict to the `omit` shape: a label group `{ [k] :: a, ...r }` whose
  //    row tail also flows to the function result (`… -> {r}`) and that holds
  //    exactly one label variable.  `restCount[id] >= 2` means the same row
  //    variable appears as a tail in two records (the parameter and `{r}`).
  const restCount = new Map<number, number>();
  eachType(resolved, n => {
    if (n.tag === 'TRecord' && n.rest && n.rest.tag === 'TRow') {
      restCount.set(n.rest.id, (restCount.get(n.rest.id) ?? 0) + 1);
    }
  });
  const groupIsOmitShape = (kid: number): boolean =>
    someType(resolved, n => {
      if (n.tag !== 'TRecord' || !n.labelFields || !n.rest || n.rest.tag !== 'TRow') return false;
      if ((restCount.get(n.rest.id) ?? 0) < 2) return false;
      const varLabels = n.labelFields.filter(lf => {
        const l = engine.subst.apply(lf.label);
        return l.tag === 'TLabel' && l.kind === 'var';
      });
      if (varLabels.length !== 1) return false;
      const l = engine.subst.apply(varLabels[0].label);
      return l.tag === 'TLabel' && l.kind === 'var' && l.id === kid;
    });

  // 3. Plan + rewrite via the shared row-expansion machinery, sourcing the
  //    keys from the array literal instead of an object literal.
  const planByKid = new Map<number, RowExpansionPlan>();
  for (const [kid] of groupValueVars) {
    if (!groupIsOmitShape(kid)) continue;
    planByKid.set(kid, buildRowExpansionPlan(keys, kid, groupValueVars, outsideVars));
  }
  if (planByKid.size === 0) return calleeType;

  return applyRowExpansionPlan(engine, resolved, planByKid);
}

/**
 * Row-map fan-out for label-polymorphic record parameters.
 *
 * When a function annotation has a single label-field `{ [k] :: T }` whose
 * label variable `k` cannot be inferred from any other parameter (i.e. `k`
 * is *closed over* by the label-field group only), expand it into concrete
 * fields based on the keys of the corresponding argument's object literal.
 *
 * Example:
 *   unwrap :: { [k] :: Pair a b } -> { [k] :: b }
 *   unwrap({ a: Pair(1, "x"), b: Pair(2, 3) })
 *
 * The label group `{k}` has internal type vars `{a, b}` (used only inside
 * label-field types).  The argument literal has keys `[a, b]`.  We rewrite
 * the function type to:
 *   { a :: Pair a1 b1, b :: Pair a2 b2 } -> { a :: b1, b :: b2 }
 * by freshening the internal vars per key.  Subsequent unification then
 * produces `{ a :: String, b :: Number }` for the result.
 *
 * Shares the variable classification, per-group planning and type rewrite with
 * {@link tryExpandKeySetFromArrayArg}; the only difference is that the keys
 * come from an object-literal argument here.
 *
 * Skipped when:
 *   • the label-var also appears outside any label-field (e.g. `pluck`'s
 *     `(k, [{ [k] :: v, ...r }]) -> [v]` where `k` is the first arg);
 *   • the matched parameter record has a row tail `{ [k] :: a, ...r }` (classic
 *     single-property row-polymorphism — expanding over every key would consume
 *     the whole object and leave `...r` empty);
 *   • the corresponding argument is not an object literal with static keys.
 */
export function tryExpandRowMap(
  engine: InferenceEngine,
  calleeType: Type,
  argNodes: ReadonlyArray<AstNode>,
): Type {
  const resolved = engine.subst.apply(calleeType);
  if (resolved.tag !== 'TFun') return calleeType;

  const { groupValueVars, outsideVars } = classifyRowGroupVars(engine, resolved);
  if (groupValueVars.size === 0) return calleeType;

  const argTypes = curriedParamTypes(resolved);

  const containsKid = (t: Type, kid: number): boolean =>
    someType(t, n => {
      if (n.tag !== 'TRecord' || !n.labelFields) return false;
      for (const lf of n.labelFields) {
        const lbl = engine.subst.apply(lf.label);
        if (lbl.tag === 'TLabel' && lbl.kind === 'var' && lbl.id === kid) return true;
      }
      return false;
    });

  // True when the label group `kid` lives in a record that ALSO carries an
  // explicit row tail (`{ [k] :: a, ...r }`) — classic single-property
  // row-polymorphism.  Only the matched PARAMETER record matters; a row tail in
  // the RESULT (e.g. `({ [k]::a }, {...b}) -> { [k]::a, ...b }`) must NOT
  // disable expansion.
  const groupRecordHasRest = (t: Type, kid: number): boolean =>
    someType(t, n => {
      if (n.tag !== 'TRecord' || !n.rest || !n.labelFields) return false;
      for (const lf of n.labelFields) {
        const lbl = engine.subst.apply(lf.label);
        if (lbl.tag === 'TLabel' && lbl.kind === 'var' && lbl.id === kid) return true;
      }
      return false;
    });

  const planByKid = new Map<number, RowExpansionPlan>();
  for (const [kid] of groupValueVars) {
    if (outsideVars.has(kid)) continue;            // label var bound elsewhere → skip
    // Find argument index containing this group.
    let argIndex = -1;
    for (let i = 0; i < argTypes.length; i++) {
      if (containsKid(argTypes[i], kid)) { argIndex = i; break; }
    }
    if (argIndex < 0 || argIndex >= argNodes.length) continue;
    if (groupRecordHasRest(argTypes[argIndex], kid)) continue;
    const argNode = argNodes[argIndex];
    if (!argNode || argNode.type !== 'ObjectExpression') continue;
    const props = (argNode as estree.ObjectExpression).properties;
    const keys: string[] = [];
    let ok = true;
    for (const prop of props) {
      if (prop.type !== 'Property' || (prop as estree.Property).computed) { ok = false; break; }
      const key = (prop as estree.Property).key;
      if (key.type === 'Identifier') keys.push((key as estree.Identifier).name);
      else if (key.type === 'Literal' && typeof (key as estree.Literal).value === 'string') {
        keys.push((key as estree.Literal).value as string);
      } else { ok = false; break; }
    }
    if (!ok || keys.length === 0) continue;

    planByKid.set(kid, buildRowExpansionPlan(keys, kid, groupValueVars, outsideVars));
  }

  if (planByKid.size === 0) return calleeType;

  return applyRowExpansionPlan(engine, resolved, planByKid);
}

/** Walk a (possibly union-of-overloads) type, recursing only into TFun
 *  RESULT sides plus union members, and return the first `Picked R _`
 *  row name found.  Skipping TFun param sides is essential: after
 *  unification with a parent's selector union, those params absorb
 *  unrelated rows that would otherwise mislead the relation check. */
export function findPickedInResultSides(engine: InferenceEngine, t: Type, depth = 0): string | null {
  if (depth > 20) return null;
  const a = engine.subst.apply(t);
  if (a.tag === 'TFun') {
    return findPickedInResultSides(engine, a.result, depth + 1);
  }
  if (a.tag === 'TCon') {
    if (a.name === T_PICKED && a.args.length >= 1) {
      const r = engine.subst.apply(a.args[0]);
      if (r.tag === 'TCon') return r.name;
      if (r.tag === 'TRecord' && r.alias) return r.alias;
    }
    if (a.name === T_UNION) {
      for (const arg of a.args) {
        const r = findPickedInResultSides(engine, arg, depth + 1);
        if (r) return r;
      }
      return null;
    }
    // Other TCons (e.g. Table FooRow, QueryTag (Picked …)): walk into
    // their args — they're "result-shaped" wrappers.
    for (const arg of a.args) {
      const r = findPickedInResultSides(engine, arg, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (a.tag === 'TRecord' && a.pickedFrom) return a.pickedFrom;
  return null;
}

/**
 * Walk the call's result type for `Picked R a` markers and replace each one
 * with a record built from the call's literal-array argument.
 *
 * Element handling, in order:
 *   1. String literal — looked up as a column in `R`; field gets the row's
 *      type for that column.  Unknown column literals are silently dropped.
 *   2. Identifier whose resolved type is `Prop T ...` — the identifier
 *      name becomes the field key, with value type `T`.  When the name
 *      matches an `R` field, the row's type wins.
 *   3. Expression of type `QueryTag X` / `Table X` (any unary TCon wrapping
 *      a row-shaped TRecord with an `alias`) — the parent row's
 *      method-shadow registry is searched for a method whose return type
 *      matches `[X]` (list-valued FK) or `X` (single-valued FK).  The
 *      shadow's name becomes the field key; its return type the value.
 *      No fallback to a name-mangling convention: missing shadows mean
 *      the relation isn't modelled and the element is skipped.
 *   4. Anything else (paging helpers, raw SQL fragments, …) is omitted.
 *
 * The projected record is intentionally *structural* (no `alias`) so that
 * hovers display the picked columns rather than the row alias name.
 *
 * Returns `result` unchanged when no `Picked` markers are present or when
 * the call has no literal-array argument.
 */
export function applyPickedProjection(
  engine: InferenceEngine,
  node: estree.CallExpression,
  env: TypeEnv,
  result: Type,
): Type {
  // Quick scan: any Picked node anywhere in the result tree?
  let hasMarker = false;
  const scan = (t: Type): void => {
    if (hasMarker) return;
    if (t.tag === 'TCon') {
      if (t.name === T_PICKED && t.args.length >= 1) { hasMarker = true; return; }
      for (const a of t.args) scan(a);
    } else if (t.tag === 'TFun') { scan(t.param); scan(t.result); }
    else if (t.tag === 'TRecord') {
      for (const k in t.fields) scan(t.fields[k]);
      if (t.rest) scan(t.rest);
    }
  };
  scan(result);
  if (!hasMarker) return result;

  // Locate the literal array argument.  Picked is a call-site primitive —
  // when the caller binds the selector array to a variable we don't try to
  // back-trace; the marker simply remains in the result type.
  const arrayArg = node.arguments.find(a => (a as AstNode).type === 'ArrayExpression') as estree.ArrayExpression | undefined;
  if (!arrayArg) return result;

  // Collect the row identifiers being projected at THIS call site so the
  // substitution sweep below only touches Picked markers belonging to
  // this call.  Without this scoping a nested call's projection would
  // greedily rewrite the parent call's `Picked OtherRow …` marker,
  // applying the inner array against the wrong row.
  //
  // Skip union members: a `Picked R …` occurrence inside a `T_UNION`
  // represents a slot expectation absorbed from a `*Selector` alias
  // during unification with the parent call's selector union, NOT a
  // value-result of THIS call.  Treating those as projection targets
  // would re-project this call's array against unrelated sibling rows
  // (e.g. an `Employee([Department])` call's array being projected
  // against `UserRow` because `EmployeeSelector` got unified through a
  // `UserSelector` slot).
  const projectedRows = new Set<string>();
  // Also remember the SOURCE row types (the `R` of each `Picked R …`)
  // so we can recover full column information for params-record
  // enrichment after `rewrite` has replaced the row with a (typically
  // narrower) projected record.
  const sourceRows: Type[] = [];
  const collectRows = (t: Type): void => {
    if (t.tag === 'TCon') {
      if (t.name === T_UNION) return;
      if (t.name === T_PICKED && t.args.length >= 1) {
        const r = engine.subst.apply(t.args[0]);
        if (r.tag === 'TCon') projectedRows.add(r.name);
        else if (r.tag === 'TRecord' && r.alias) projectedRows.add(r.alias);
        sourceRows.push(r);
      }
      for (const a of t.args) collectRows(a);
    } else if (t.tag === 'TFun') { collectRows(t.param); collectRows(t.result); }
    else if (t.tag === 'TRecord') {
      for (const k in t.fields) collectRows(t.fields[k]);
      if (t.rest) collectRows(t.rest);
    }
  };
  collectRows(result);

  const rewrite = (t: Type): Type => {
    if (t.tag === 'TCon') {
      if (t.name === T_UNION) return t; // see scoping rationale on collectRows
      if (t.name === T_PICKED && t.args.length >= 1) {
        const r = engine.subst.apply(t.args[0]);
        const rowName = r.tag === 'TCon' ? r.name
          : r.tag === 'TRecord' ? r.alias
          : undefined;
        if (rowName && !projectedRows.has(rowName)) return t;
        const projected = projectArrayAgainstRow(engine, arrayArg, t.args[0]);
        return projected ?? t;
      }
      const newArgs = t.args.map(rewrite);
      if (newArgs.every((a, i) => a === t.args[i])) return t;
      return { ...t, args: newArgs };
    }
    if (t.tag === 'TFun') {
      const p = rewrite(t.param);
      const r = rewrite(t.result);
      if (p === t.param && r === t.result) return t;
      return { ...t, param: p, result: r };
    }
    if (t.tag === 'TRecord') {
      const fields: Record<string, Type> = {};
      let changed = false;
      for (const k in t.fields) {
        const nv = rewrite(t.fields[k]);
        if (nv !== t.fields[k]) changed = true;
        fields[k] = nv;
      }
      if (!changed) return t;
      return { ...t, fields };
    }
    return t;
  };

  const rewritten = rewrite(result);

  // Propagate the projection into the substitution.  Earlier in this
  // call's inference, the result tvar may have been unified against an
  // outer parameter slot (e.g. `QueryTag b` of `one :: QueryTag b -> ...`),
  // binding `b` to the *unprojected* `Picked R Sel` form.  When the
  // outer call later re-unifies its argument with that slot, it sees
  // `QueryTag (Picked ...)` on one side and the now-projected record on
  // the other, and emits a spurious "Cannot unify" diagnostic.  Walk
  // the substitution and rewrite every binding that still references
  // `Picked R …` for the rows we just projected, so subsequent
  // unifications observe the projected record instead.
  //
  // CAVEAT: Skip rewrites inside union types.  Picked-occurrences inside
  // a `T_UNION` represent slot-expectations from a `…Selector` alias
  // (e.g. `QueryTag c (Picked LocationRow a)` as a branch of
  // `OrganisationSelector`), NOT a value-result.  Rewriting these
  // poisons the parent call's expected slot and produces cascading
  // "Cannot unify" diagnostics where one side has the Picked-branch and
  // the other has the projected record.
  if (rewritten !== result) {
    const rewriteSubstBound = (t: Type): Type => {
      if (t.tag === 'TCon') {
        if (t.name === T_UNION) return t; // do not project into selector unions
        if (t.name === T_PICKED && t.args.length >= 1) {
          const r = engine.subst.apply(t.args[0]);
          const rowName = r.tag === 'TCon' ? r.name
            : r.tag === 'TRecord' ? r.alias
            : undefined;
          if (rowName && !projectedRows.has(rowName)) return t;
          const projected = projectArrayAgainstRow(engine, arrayArg, t.args[0]);
          return projected ?? t;
        }
        const newArgs = t.args.map(rewriteSubstBound);
        if (newArgs.every((a, i) => a === t.args[i])) return t;
        return { ...t, args: newArgs };
      }
      if (t.tag === 'TFun') {
        const p = rewriteSubstBound(t.param);
        const r = rewriteSubstBound(t.result);
        if (p === t.param && r === t.result) return t;
        return { ...t, param: p, result: r };
      }
      if (t.tag === 'TRecord') {
        const fields: Record<string, Type> = {};
        let changed = false;
        for (const k in t.fields) {
          const nv = rewriteSubstBound(t.fields[k]);
          if (nv !== t.fields[k]) changed = true;
          fields[k] = nv;
        }
        if (!changed) return t;
        return { ...t, fields };
      }
      return t;
    };
    for (const [id, bound] of engine.subst.entries()) {
      const updated = rewriteSubstBound(bound);
      if (updated !== bound) engine.subst.set(id, updated);
    }
  }

  // Derive the parameter record `p` from helper calls in the selector
  // array (e.g. `Limit(p => p.limit)`, `Offset(p => p.offset)`, nested
  // sub-queries' own helpers) and bind it to the host TCon's parameter
  // slot.  This turns `QueryTag p {projected}` with `p` unbound into
  // `QueryTag {limit::Number, offset::Number} {projected}`, so the second
  // overload of `QueryTag()` displays the user's actual params record
  // instead of a bare TVar.
  const paramRec = gatherParamRecord(engine, env, arrayArg);
  if (paramRec) {
    // When a harvested param field has the same NAME as a column of the
    // row being projected (e.g. outer `id.eq(p => p.id)` against
    // `OrganisationRow { id :: Number, ... }`), unify the field's
    // (typically unbound) TVar with the row column's known type so the
    // params slot reflects the concrete column type instead of leaking a
    // free `a`.  This is purely an enrichment step — fields without a
    // matching row column keep their inferred type unchanged.
    enrichParamRecFromRow(engine, rewritten, paramRec);
    for (const sr of sourceRows) enrichParamRecFromRecord(engine, sr, paramRec);
    bindParamSlot(engine, rewritten, paramRec);
  }

  return rewritten;
}

/** Walk a selector-array literal and gather a parameter record from any
 *  helper invocation whose argument is a function `({...record...}) -> _`.
 *  Recurses into nested sub-queries (calls whose own argument is an
 *  array literal), so a `Variable(p => p.x)` inside an inner table call
 *  contributes to the outer host's param record.  Returns the merged
 *  TRecord (structural intersection — duplicate keys unify field types)
 *  or null when no helper contributed any field. */
function gatherParamRecord(
  engine: InferenceEngine,
  env: TypeEnv,
  arrayNode: estree.ArrayExpression,
): Type | null {
  const fields: Record<string, Type> = {};
  let foundAny = false;
  // Scalar contributions from helpers whose params are NOT a record
  // (e.g. `Limit :: Runnable Number r => r -> Limit r` called as
  // `Limit(p => p)` or `Limit(42)`).  When the selector list contains
  // only such helpers, the harvested "param record" is actually a
  // bare scalar of the helper's Runnable-payload type.  See Part 2 of
  // the scalar-params plan.
  const scalars: Type[] = [];
  let mixedShapeDiag = false;
  // Track already-visited AST nodes so callee-chain recursion (e.g.
  // `.iLike(...).or(.iLike(...))`) doesn't re-process the same call.
  const visited = new WeakSet<AstNode>();

  const consumeRecordType = (rec: Type): void => {
    const expanded = engine.maybeExpandAlias(engine.subst.apply(rec));
    if (expanded.tag !== 'TRecord') return;
    for (const k in expanded.fields) {
      const incoming = engine.subst.apply(expanded.fields[k]);
      if (k in fields) {
        try { engine.subst.mergeFrom(unify(fields[k], incoming)); } catch { /* skip conflict */ }
      } else {
        fields[k] = incoming;
        foundAny = true;
      }
    }
  };

  const visit = (elem: AstNode): void => {
    if (visited.has(elem)) return;
    visited.add(elem);
    // Identifier elements (e.g. `limit`, `offset` referenced as values
    // already constructed by helpers like `Limit(p => p.limit)`).
    // Their inferred type may be a wrapper TCon (`Limit r`) carrying
    // the captured callback in an arg slot — walk those for any
    // `({...record...}) -> _` shape.
    if (elem.type === 'Identifier') {
      const idName = (elem as estree.Identifier).name;
      // Prefer the env-resolved binding type — the per-node stored type
      // can be overwritten by the call-arg unification.  Use the scheme
      // type directly (without `instantiate`'s TVar-freshening) so any
      // `paramHint` carried on the bound TCon survives the lookup; then
      // walk both the type's own carrier args AND the paramHint shape.
      const envScheme = env.lookup(idName);
      const idType = envScheme
        ? envScheme.type
        : engine.subst.apply(engine.getNodeType(elem) ?? tVar());
      walkCarrierForRecords(engine, idType, consumeRecordType);
      if (idType.tag === 'TCon' && idType.paramHint) {
        const hint = engine.maybeExpandAlias(engine.subst.apply(idType.paramHint));
        if (hint.tag === 'TRecord') consumeRecordType(hint);
      }
      return;
    }
    if (elem.type !== 'CallExpression') return;
    const call = elem as estree.CallExpression;
    // Inspect the helper's callee type — its declared signature tells us
    // (independently of how the user passed the argument) which record
    // the parameter slot consumes.  Two shapes are recognised:
    //   1. `Helper :: ({...record...} -> X) -> Helper`   — callback form
    //      (most common in query-builder: `Limit(p => p.limit)`).
    //   2. `Helper :: {...record...} -> Helper`         — direct form
    //      (when the caller is expected to pass the record literal).
    // Union-typed helpers are walked branch-by-branch so the same name
    // can be both callback- and direct-form.
    const calleeNode = call.callee as AstNode;
    // Prefer the helper's *declared* signature (from local annotations
    // or imported constructors) over its per-call instantiated type:
    // call-site instantiation freshens the type's TVars, so even if the
    // signature constrains the param slot to a concrete record, the
    // node-stored type may still show bare TVars there.  The declared
    // scheme always carries the canonical record.
    const calleeName = calleeNode.type === 'Identifier'
      ? (calleeNode as estree.Identifier).name : null;
    let declaredScheme = calleeName
      ? (engine.annotationMap.get(calleeName)?.scheme
         ?? engine.importedConstructors.get(calleeName)
         ?? null)
      : null;
    // Method-call form: when the callee is `obj.method(...)`, the
    // method's declared scheme (with its `Runnable T r =>` prefix)
    // lives in the MethodRegistry under the receiver TCon's name —
    // not in `annotationMap`.  Resolve the receiver type, find its
    // TCon name, and look up the method scheme so the Runnable-payload
    // propagation below also fires for chained method calls like
    // `firstname.iLike(p => p.q)`.
    if (!declaredScheme && calleeNode.type === 'MemberExpression') {
      const memCallee = calleeNode as estree.MemberExpression;
      const propNode = memCallee.property as AstNode | undefined;
      if (propNode?.type === 'Identifier' && !memCallee.computed) {
        let recvType: Type = engine.subst.apply(
          engine.getNodeType(memCallee.object as AstNode) ?? tVar(),
        );
        if (recvType.tag === 'TVar'
            && (memCallee.object as AstNode).type === 'Identifier') {
          const objName = (memCallee.object as estree.Identifier).name;
          const objScheme = env.lookup(objName);
          if (objScheme) recvType = engine.subst.apply(instantiate(objScheme));
        }
        const recvCon = engine.maybeExpandAlias(recvType);
        if (recvCon.tag === 'TCon') {
          const entry = lookupMethod(recvCon.name, (propNode as estree.Identifier).name);
          if (entry?.scheme) declaredScheme = entry.scheme;
        }
      }
    }
    const declared = declaredScheme?.type ?? null;
    const calleeType = declared
      ?? engine.subst.apply(engine.getNodeType(calleeNode) ?? tVar());
    extractParamFromCallee(engine, calleeType, consumeRecordType);
    // Fix 3: when the declared scheme is `Runnable T r => r -> Result`
    // (the query-builder pattern for callback-or-direct slots like `Limit`),
    // the callback's expected return type is the constraint's payload
    // `T`.  Carry that payload (when concrete) so the body-walk below
    // can type freshly-harvested `p.field` MemberExpressions as `T`
    // instead of leaving them as opaque TVars.
    let runnablePayload: Type | null = null;
    if (declaredScheme && declared && declared.tag === 'TFun'
        && declared.param.tag === 'TVar' && declaredScheme.constraints) {
      const paramName = declared.param.name;
      for (const c of declaredScheme.constraints) {
        if (!paramName || c.typeVarName !== paramName) continue;
        // Standard Runnable shape: `Runnable T r` — payload is the
        // first positional arg.  Skip if no positional args (e.g.
        // nominal-only `Functor f`).
        const args = c.positionalArgs;
        if (!args || args.length < 1) continue;
        const payload = engine.maybeExpandAlias(engine.subst.apply(args[0]));
        // Only use concrete payloads — a still-polymorphic `a` adds no
        // information over the existing fresh-TVar default.
        if (payload.tag === 'TCon' || payload.tag === 'TRecord') {
          runnablePayload = payload;
          break;
        }
      }
    }
    // Scalar-param contribution: when the helper consumes a non-record
    // Runnable payload (e.g. `Limit :: Runnable Number r => r -> _`),
    // detect the ONE user shape where the entire param IS the scalar:
    //   Bare-body callback: `Limit(p => p)` — the callback returns
    //   its own param identifier verbatim, so the tag's param-record
    //   slot must accept the Runnable payload at tag-call time.
    //
    // The direct-value form `Limit(42)` is intentionally NOT a
    // contribution: the value is provided in-line at helper-call time,
    // so the surrounding tag does NOT need a parameter for it later.
    if (runnablePayload && declared && declared.tag === 'TFun') {
      for (const arg of call.arguments) {
        const argNode = arg as AstNode;
        if (argNode.type !== 'ArrowFunctionExpression'
            && argNode.type !== 'FunctionExpression') continue;
        const fn = argNode as estree.ArrowFunctionExpression | estree.FunctionExpression;
        const firstParam = fn.params?.[0];
        if (!firstParam || firstParam.type !== 'Identifier') continue;
        const paramName = (firstParam as estree.Identifier).name;
        if (fn.body?.type === 'Identifier'
            && (fn.body as estree.Identifier).name === paramName) {
          scalars.push(runnablePayload);
        }
      }
    }
    // Also walk the call's RESULT type for callback-carrier args (e.g.
    // an inline `Limit(p => p.limit)` whose result is `Limit r` where
    // `r` was unified with the callback's type at call-site).
    const callType = engine.subst.apply(engine.getNodeType(call) ?? tVar());
    walkCarrierForRecords(engine, callType, consumeRecordType);
    // Inline-callback arguments: when the user passes `(p => p.x)`
    // directly, the inferred parameter type of that arrow function
    // captures the params shape implied by its body.  This covers
    // method-call helpers like `applicationId.eq(p => p.applicationId)`
    // where the helper's callee union (`(p -> v) | v`) doesn't expose
    // a record at the param slot — the record only exists on the
    // user's callback.
    //
    // Inspect both the function-node's stored type AND its first
    // parameter's stored type: depending on how unification with the
    // helper's `Runnable` union proceeded, the engine may have stored
    // a TFun on the function (param type recoverable from `.param`),
    // a bare TRecord on the function (the param record was substituted
    // for the function-node TVar), or just a TVar on the function with
    // the actual record bound to the parameter Identifier's TVar.
    const consumeRecordOrTFunParam = (t: Type): void => {
      const a = engine.maybeExpandAlias(engine.subst.apply(t));
      if (a.tag === 'TRecord') consumeRecordType(a);
      else if (a.tag === 'TFun') {
        const fp = engine.maybeExpandAlias(engine.subst.apply(a.param));
        if (fp.tag === 'TRecord') consumeRecordType(fp);
      }
    };
    for (const arg of call.arguments) {
      const argNode = arg as AstNode;
      if (argNode.type !== 'ArrowFunctionExpression' && argNode.type !== 'FunctionExpression') continue;
      const fn = argNode as estree.ArrowFunctionExpression | estree.FunctionExpression;
      const firstParam = fn.params?.[0];
      if (firstParam) {
        const pType = engine.getNodeType(firstParam as AstNode);
        if (pType) consumeRecordOrTFunParam(pType);
      }
      const fnType = engine.getNodeType(fn);
      if (fnType) consumeRecordOrTFunParam(fnType);
      // Body-syntactic fallback: when the helper's `Runnable` constraint
      // unified the function value with `(a -> v) | v` without binding
      // the param's TVar to a concrete record, walk the function's body
      // for `paramName.fieldName` MemberExpressions and harvest a field
      // for each.  Field types come from each MemberExpression's
      // inferred node type — when still unbound, default to a fresh
      // TVar so the field name is at least surfaced in the params record.
      if (firstParam && firstParam.type === 'Identifier') {
        const paramName = (firstParam as estree.Identifier).name;
        // Runnable-payload sharpening is only valid when the field
        // access IS the callback's return value (e.g. `p => p.q`).
        // For bodies like `` `%${p.q}%` `` the template literal coerces
        // `p.q` to String regardless of its actual type, so we cannot
        // conclude `p.q :: payload` — fall back to a fresh TVar in
        // that case.  When the body is an Identifier-bodied arrow the
        // payload is also unsafe (the body is not `p.field`).
        const bodyIsDirectMemberOfParam =
          fn.body?.type === 'MemberExpression'
          && (fn.body as estree.MemberExpression).object?.type === 'Identifier'
          && ((fn.body as estree.MemberExpression).object as estree.Identifier).name === paramName
          && (fn.body as estree.MemberExpression).property?.type === 'Identifier'
          && !(fn.body as estree.MemberExpression).computed;
        const visitBody = (n: AstNode | null | undefined): void => {
          if (!n || typeof n !== 'object' || !('type' in n)) return;
          if (n.type === 'MemberExpression'
              && (n as estree.MemberExpression).object?.type === 'Identifier'
              && ((n as estree.MemberExpression).object as estree.Identifier).name === paramName
              && (n as estree.MemberExpression).property?.type === 'Identifier'
              && !(n as estree.MemberExpression).computed) {
            const fieldName = ((n as estree.MemberExpression).property as estree.Identifier).name;
            // Prefer the PROPERTY node's recorded type: member access on an
            // unresolved callback param records its result var on the
            // property Identifier only (`recordSuppressedProperty`), while
            // `getNodeType(member)` falls back to the *object* identifier's
            // type (the member start offset is claimed by `p` itself).
            // Harvesting that object var would bind the host's param slot to
            // a record whose fields reference the slot itself (occurs cycle
            // — `p := { limit :: p }`).  The property var, by contrast, was
            // threaded through the helper's callback signature by regular
            // unification (e.g. bound to `Number` via
            // `Limit :: ((p -> Number) | Number) -> Limit p`).
            const propNode = (n as estree.MemberExpression).property as AstNode;
            const memType = engine.getNodeType(propNode) ?? engine.getNodeType(n);
            let applied = memType ? engine.subst.apply(memType) : null;
            // Cycle guard: if the harvested type still resolves to the same
            // TVar as the callback's own param, treat it as opaque.
            if (applied && applied.tag === 'TVar' && firstParam) {
              const pT = engine.getNodeType(firstParam as AstNode);
              const appliedP = pT ? engine.subst.apply(pT) : null;
              if (appliedP && appliedP.tag === 'TVar' && appliedP.id === applied.id) {
                applied = null;
              }
            }
            // Only sharpen with the constraint payload when this very
            // MemberExpression IS the function body — then the
            // `Runnable T r` constraint pins the field to `T`.  In
            // any other context (template literals, binary ops,
            // nested calls, multiple field uses) the field type is
            // unconstrained — surface it as a fresh TVar.
            const isOpaque = !applied || applied.tag === 'TVar';
            const isReturnedDirectly = bodyIsDirectMemberOfParam && n === fn.body;
            const inferredField = (isOpaque && runnablePayload && isReturnedDirectly)
              ? runnablePayload
              : (applied ?? tVar());
            const existing = fields[fieldName];
            if (!existing) {
              fields[fieldName] = inferredField;
              foundAny = true;
            } else {
              // Chain-order quirk: outer callee callbacks are visited
              // first, so an earlier opaque harvest (e.g. from a
              // template-literal body) can shadow a later concrete
              // harvest (e.g. `p => p.q` proving `String`).  When the
              // stored field is still a bare TVar but a later harvest
              // produces a concrete type, upgrade in place.
              const existingApplied = engine.subst.apply(existing);
              const newApplied = engine.subst.apply(inferredField);
              if (existingApplied.tag === 'TVar' && newApplied.tag !== 'TVar') {
                fields[fieldName] = newApplied;
              } else {
                try { engine.subst.mergeFrom(unify(existingApplied, newApplied)); } catch { /* skip conflict */ }
              }
            }
          }
          // Recurse into all child AST nodes generically.
          for (const k of Object.keys(n)) {
            if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
            const child = (n as unknown as Record<string, unknown>)[k];
            if (Array.isArray(child)) {
              for (const c of child) visitBody(c as AstNode);
            } else if (child && typeof child === 'object') {
              visitBody(child as AstNode);
            }
          }
        };
        visitBody(fn.body as AstNode);
      }
    }
    // Recurse into nested array-literal arguments (sub-queries) and
    // into nested CallExpression arguments (e.g. when a helper is
    // passed another helper-call directly, no array wrapper).
    for (const arg of call.arguments) {
      const argNode = arg as AstNode;
      if (argNode.type === 'ArrayExpression') {
        for (const e of (argNode as estree.ArrayExpression).elements) {
          if (e) visit(e as AstNode);
        }
      } else if (argNode.type === 'CallExpression') {
        visit(argNode);
      }
    }
    // Recurse into the callee's own subtree for chained method calls
    // like `x.iLike(p => p.q).or(y.iLike(p => p.q))`: the outer `.or`
    // call has no callback args carrying `p.q`, but its callee chain
    // does.  Walk `callee.object` to reach those inner callbacks.
    if (calleeNode.type === 'MemberExpression') {
      const obj = (calleeNode as estree.MemberExpression).object as AstNode;
      if (obj && (obj.type === 'CallExpression' || obj.type === 'Identifier'
                  || obj.type === 'MemberExpression')) {
        visit(obj);
      }
    }
  };

  for (const elem of arrayNode.elements) {
    if (elem) visit(elem as AstNode);
  }

  // Shape-decision:
  //  - record fields only           → TRecord (legacy behaviour)
  //  - scalar contributions only    → unify all scalars, return that
  //                                   single Type (Number, String, …)
  //  - both kinds present           → ambiguous: emit a diagnostic and
  //                                   prefer the record (annotation-
  //                                   escape stays available)
  //  - none                         → null
  if (scalars.length > 0 && !foundAny) {
    let acc = engine.subst.apply(scalars[0]);
    for (let i = 1; i < scalars.length; i++) {
      const next = engine.subst.apply(scalars[i]);
      try { engine.subst.mergeFrom(unify(acc, next)); } catch { /* incompatible scalars — first one wins, diagnostic below if you extend */ }
      acc = engine.subst.apply(acc);
    }
    return acc;
  }
  if (scalars.length > 0 && foundAny && !mixedShapeDiag) {
    mixedShapeDiag = true;
    engine.addDiag(
      `Selector list mixes scalar and record parameters; annotate the tag explicitly`,
      arrayNode as AstNode,
    );
  }
  return foundAny ? tRecord(fields) : null;
}

/** Harvest params from a tagged-template's function interpolations
 *  (`sql\`... ${p => p.riziv} ...\``) and bind them into the result's
 *  parameter slot (`SQLTag p o` → `p`).  The synthesized CallExpression
 *  produced by `inferTaggedTemplateExpression` is wrapped in a fake
 *  one-element array so `gatherParamRecord`'s call-visitor (declared-
 *  signature extraction, callback body walk, nested-call recursion)
 *  applies unchanged.  No-op when the result carries no param slot or
 *  the template has no function interpolations. */
export function harvestTaggedTemplateParams(
  engine: InferenceEngine,
  env: TypeEnv,
  callNode: estree.CallExpression,
  result: Type,
): void {
  const applied = engine.subst.apply(result);
  if (applied.tag !== 'TCon' || applied.args.length < 2) return;
  const hasFnInterp = callNode.arguments.some((a) => {
    const t = (a as AstNode).type;
    return t === 'ArrowFunctionExpression' || t === 'FunctionExpression';
  });
  if (!hasFnInterp) return;
  const fakeArray = {
    type: 'ArrayExpression',
    elements: [callNode],
    start: callNode.start,
    end: callNode.end,
  } as unknown as estree.ArrayExpression;
  const paramRec = gatherParamRecord(engine, env, fakeArray);
  if (!paramRec) return;
  bindParamSlot(engine, applied, paramRec);
}

/** From a helper callee's signature, pump any TRecord seen at depth 1
 *  (direct form: `Helper :: {...} -> Helper`) or depth 2 inside a
 *  callback (`Helper :: ({...} -> _) -> Helper`) into `consume`.  Walks
 *  Union branches transparently so a helper with multiple overload
 *  shapes contributes from every branch that matches one of the two
 *  recognised forms. */
function extractParamFromCallee(
  engine: InferenceEngine,
  calleeType: Type,
  consume: (rec: Type) => void,
): void {
  const t = engine.subst.apply(calleeType);
  if (t.tag === 'TCon' && t.name === T_UNION) {
    for (const branch of t.args) extractParamFromCallee(engine, branch, consume);
    return;
  }
  if (t.tag !== 'TFun') return;
  const param = engine.maybeExpandAlias(engine.subst.apply(t.param));
  if (param.tag === 'TRecord') {
    consume(param);
    return;
  }
  if (param.tag === 'TFun') {
    const inner = engine.maybeExpandAlias(engine.subst.apply(param.param));
    if (inner.tag === 'TRecord') consume(inner);
  }
}

/** Walk a value's TCon args (recursively) and consume any TRecord found
 *  at a `TFun.param` position.  Used by `gatherParamRecord` to recover
 *  the original callback record from helper values like `Limit r` or
 *  `Offset r` whose `r` type slot was unified with the user's callback
 *  `({...} -> Number)` at construction time. */
function walkCarrierForRecords(
  engine: InferenceEngine,
  t: Type,
  consume: (rec: Type) => void,
): void {
  const rt = engine.subst.apply(t);
  if (rt.tag !== 'TCon') return;
  for (const arg of rt.args) {
    const a = engine.maybeExpandAlias(engine.subst.apply(arg));
    if (a.tag === 'TFun') {
      // Callback-form helper carrier: `Limit r` where `r` was unified
      // with `({...record...} -> Number)` at construction time.  The
      // record at the callback's *param* position is the params shape.
      const p = engine.maybeExpandAlias(engine.subst.apply(a.param));
      if (p.tag === 'TRecord') consume(p);
    } else if (a.tag === 'TCon') {
      // Recurse through wrapper TCons (e.g. `Limit r` whose r is itself
      // a TCon wrapping a callback).  Do NOT treat bare TRecord args as
      // params: nested sub-query carriers like `QueryTag p {projectedRow}`
      // expose their projected row as a TRecord arg, but that row is the
      // sub-query's RESULT, not a parameter contribution to the outer
      // host.  Bare-TRecord consumption here would leak the projected
      // row into the outer host's params record.
      walkCarrierForRecords(engine, a, consume);
    }
  }
}

// ---------------------------------------------------------------------------
// Merge reduction — structural union of two records
// ---------------------------------------------------------------------------

/**
 * Walk `result` and replace every `Merge a b` whose args resolve to two
 * TRecords with a single structural-union record (alias-stripped).
 * Conflicting field types are unified through the engine's substitution
 * — incompatibilities are surfaced via existing diagnostics elsewhere.
 *
 * `Merge` markers whose arguments aren't both records yet (e.g. an
 * unbound TVar from an earlier-stage call) are left in place so a later
 * pass can collapse them once the substitution catches up.  Nested
 * `Merge` is handled by recursing first via `mapType`.
 */
export function applyMergeReduction(engine: InferenceEngine, result: Type, node?: AstNode): Type {
  return mapType(result, n => {
    if (n.tag !== 'TCon' || n.name !== T_MERGE || n.args.length < 2) return undefined;
    // Recurse first so nested Merges collapse bottom-up.
    const reducedArgs = n.args.map(a => applyMergeReduction(engine, a, node));
    const expanded = reducedArgs.map(a => engine.maybeExpandAlias(engine.subst.apply(a)));
    // An `Any` operand (`Object.assign ({}, env, { querier })` with
    // `env :: Any`) has an unknown shape, so the merge has too: `Any`, not
    // a "non-record operand" error.
    if (expanded.some(isAnyType)) return tAnyType;
    // Dictionary merge: `Object k a` operands (an FP library's `Object String Any`)
    // plus closed record literals — `Object.assign ({}, dictA, dictB)`,
    // `Object.assign (withoutNulls (row), { id }, { at })` — merge to
    // `Object k (a ∪ fields)`.  A record's keys are strings, so a non-empty
    // record needs `k ≡ String`; its field types join the value (an `Any`
    // value absorbs them).  Without this the dictionaries counted as
    // non-record operands and the marker never reduced.
    {
      const dicts = expanded.filter(isAppliedObject);
      const closedRecord = (e: Type): e is TRecord =>
        e.tag === 'TRecord' && !(e.labelFields && e.labelFields.length) && !e.rest;
      // A record of computed keys (`{ [k] :: v }`, see inferObjectExpression)
      // is dictionary content too, and an operand of a type not known yet
      // (the accumulator of a `reduce`) takes the dictionary's type.
      const labelRecord = (e: Type): e is TRecord =>
        e.tag === 'TRecord' && !!(e.labelFields && e.labelFields.length) && !e.rest;
      const restAreRecords = expanded.every(e =>
        isAppliedObject(e) || closedRecord(e) || labelRecord(e) || e.tag === 'TVar' || e.tag === 'TRow');
      if (dicts.length > 0 && restAreRecords) {
        let key: Type = dicts[0].args[0];
        let value: Type = dicts[0].args[1];
        let ok = true;
        for (let i = 1; i < dicts.length && ok; i++) {
          try { engine.subst.mergeFrom(unify(engine.subst.apply(key), engine.subst.apply(dicts[i].args[0]))); }
          catch { ok = false; break; }
          value = deepMergeTypes(engine.subst.apply(value), engine.subst.apply(dicts[i].args[1]));
        }
        for (const e of expanded) {
          if (!ok || !(closedRecord(e) || labelRecord(e))) continue;
          const entries = Object.values(e.fields).concat((e.labelFields ?? []).map(lf => lf.type));
          if (entries.length === 0) continue;
          if (Object.keys(e.fields).length > 0) {
            try { engine.subst.mergeFrom(unify(engine.subst.apply(key), tString)); }
            catch { ok = false; break; }
          }
          for (const entry of entries) {
            const v = engine.subst.apply(value);
            value = isAnyType(v) ? v : deepMergeTypes(v, engine.subst.apply(entry));
          }
        }
        if (ok) {
          key = engine.subst.apply(key);
          return tCon(T_OBJECT, [key, value]);
        }
      }
    }
    const tvars: Type[] = [];
    const records: Array<{ tag: 'TRecord'; fields: Record<string, Type>; rest?: Type; alias?: string; labelFields?: unknown }> = [];
    const others: Type[] = [];
    for (const e of expanded) {
      // A bare row-variable (`TRow`) is an *open row* — i.e. record-like, not
      // a concrete non-record operand.  Treat it like an unresolved `TVar`:
      // defer the merge (keep the marker) until the row binds to a record at
      // a later position (e.g. once the call argument supplying `...b` is
      // unified).  Classifying it as `others` previously produced a spurious
      // "contains a non-record operand" error for `Merge { …a } b`.
      if (e.tag === 'TVar' || e.tag === 'TRow') tvars.push(e);
      else if (e.tag === 'TRecord') records.push(e as never);
      else others.push(e);
    }
    // A default projection ("all columns" because nothing was selected) is
    // the identity next to records that DID select fields: drop it.  Its
    // relation fields (nested queries) are kept.
    if (records.some(r => (r as TRecord).defaultProjection) && records.some(r => !(r as TRecord).defaultProjection)) {
      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i] as TRecord;
        if (!r.defaultProjection) continue;
        const relations: Record<string, Type> = {};
        const rowName = r.pickedFrom;
        const columns = rowName ? engine.maybeExpandAlias(tCon(rowName, [])) : null;
        for (const k in r.fields) {
          if (!(columns && columns.tag === 'TRecord' && k in columns.fields)) relations[k] = r.fields[k];
        }
        if (Object.keys(relations).length === 0) records.splice(i, 1);
        else records[i] = { tag: 'TRecord', fields: relations } as never;
      }
      if (records.length === 1 && tvars.length === 0 && others.length === 0) return records[0] as Type;
    }
    // Hard structural conflict: a concrete record alongside a concrete
    // non-record (e.g. `Merge {a::Number} Number` after Phase D
    // row-opening met a scalar at a polymorphic position).
    if (records.length > 0 && others.length > 0) {
      if (node) {
        engine.addDiag(
          `Cannot merge: '${prettyTypeToString(n)}' contains a non-record operand`,
          node,
        );
      }
      return { ...n, args: reducedArgs };
    }
    // All TVars (no concrete operands yet) — keep the marker so a later
    // projection pass can finish the job once the substitution catches up.
    if (records.length === 0 && others.length === 0) {
      return { ...n, args: reducedArgs };
    }
    // Scalar / container merge: TVars + one-or-more concrete non-record
    // operands.  These arise from deferred field-level `Merge` markers
    // emitted by `tryExpandRowMap` for label-group rows whose keys overlap
    // (`{ [k] :: a, [i] :: b }` where both cover `likedTypes`).  Combine the
    // concretes with the shared deep-merge primitive so `Merge [String]
    // [Number]` becomes `[String | Number]` and `Merge [{..}] [{..}]` deep-
    // merges element-wise, then bind any TVar siblings to the result.
    if (records.length === 0) {
      let target = others[0];
      for (let i = 1; i < others.length; i++) {
        target = deepMergeTypes(engine.subst.apply(target), others[i]);
      }
      for (const tv of tvars) {
        // Only bind genuine type-vars to the scalar/container result.  A
        // deferred row-variable must not be unified with a scalar target.
        if (tv.tag !== 'TVar') continue;
        try { engine.subst.mergeFrom(unify(tv, target)); } catch { /* leave unbound */ }
      }
      return engine.subst.apply(target);
    }
    // Record-bearing merge with TVar siblings: keep the marker.  The
    // TVars may yet be unified with concrete records downstream, and
    // prematurely binding them to the partial record-merge result would
    // close their shape too early (breaking structural row-opening of
    // sibling records via separate row-variables).
    if (records.length > 0 && tvars.length > 0) {
      return { ...n, args: reducedArgs };
    }
    // Record-only merge: structurally union the records.
    // Index signatures (`labelFields`, e.g. `Object String Any` →
    // `{ [String] :: Any }`) are carried over too; the same label from two
    // operands is combined once.  Dropping them turned
    // `Object.assign ({}, dictA, dictB)` into `{}`.
    const labelAcc: Array<{ label: TLabel; type: Type }> = [];
    const sameLabel = (x: TLabel, y: TLabel): boolean =>
      x.kind === 'lit' ? (y.kind === 'lit' && x.value === y.value) : (y.kind === 'var' && x.id === y.id);
    for (const e of records) {
      for (const lf of (e as { labelFields?: Array<{ label: TLabel; type: Type }> }).labelFields ?? []) {
        const label = engine.subst.apply(lf.label) as TLabel;
        const prior = labelAcc.find((l) => sameLabel(l.label, label));
        if (prior) prior.type = deepMergeTypes(engine.subst.apply(prior.type), engine.subst.apply(lf.type));
        else labelAcc.push({ label, type: engine.subst.apply(lf.type) });
      }
    }
    let acc: { tag: 'TRecord'; fields: Record<string, Type>; rest?: Type; alias?: string; labelFields?: Array<{ label: TLabel; type: Type }> } | null = null;
    for (const e of records) {
      if (acc === null) {
        acc = { tag: 'TRecord', fields: { ...e.fields }, rest: e.rest, alias: undefined };
        continue;
      }
      const merged: Record<string, Type> = { ...acc.fields };
      for (const k in e.fields) {
        const incoming = engine.subst.apply(e.fields[k]);
        if (k in merged) {
          // Overlapping field: combine the two types rather than unifying
          // them.  Two records deep-merge; same-constructor containers merge
          // arg-wise (`[String]` ⊕ `[Number]` → `[String | Number]`); anything
          // else unions (deduped), so `{a::Number}` ⊕ `{a::String}` becomes
          // `{ a :: Number | String }` instead of a "conflicting types" diag.
          const prior = engine.subst.apply(merged[k]);
          merged[k] = deepMergeTypes(prior, incoming);
        } else {
          merged[k] = incoming;
        }
      }
      // Preserve the row-var tail when both operands share the same
      // rest TVar (common after Phase D row-opening of the same source
      // variable).  When tails disagree we drop them.
      let rest: Type | undefined = undefined;
      if (acc.rest && e.rest) {
        if (acc.rest.tag === 'TVar' && e.rest.tag === 'TVar' && acc.rest.id === e.rest.id) {
          rest = acc.rest;
        }
      } else {
        rest = acc.rest ?? e.rest;
      }
      acc = { tag: 'TRecord', fields: merged, rest };
    }
    if (acc && labelAcc.length > 0) acc = { ...acc, labelFields: labelAcc };
    return (acc as Type | null) ?? n;
  });
}

/**
 * Plan v6.3 Phase D — structural row-opening at the call site.
 *
 * Looks at the (resolved) curried callee type and detects polymorphic
 * type-vars that occur at **two or more top-level positions** of the
 * TFun chain.  When at least one of the arguments supplied at THIS
 * call site lands on such a position AND its AST is a record literal
 * (`ObjectExpression`), the callee is rewritten so:
 *   - every top-level input occurrence of that TVar becomes a fresh
 *     independent TVar `αᵢ`;
 *   - the top-level result occurrence (if any) becomes `Merge α₁ … αₙ`
 *     (collapsed to `α₁` when n == 1).
 *
 * Any pending constraint on the original TVar is replicated to every
 * fresh `αᵢ`.  Phase C maps TRecord → 'Object' so user-declared
 * Object#method annotations satisfy these constraints uniformly,
 * without any class-name hardcoding in the core.
 *
 * The transform is intentionally restricted to top-level positions —
 * nested positions (`[a]`, `Maybe a`, …) keep classical rigid HM.
 */
export function maybeApplyRowOpening(
  engine: InferenceEngine,
  calleeType: Type,
  args: ReadonlyArray<AstNode>,
): Type {
  const resolved = engine.subst.apply(calleeType);
  if (resolved.tag !== 'TFun') return calleeType;

  // Flatten the curried TFun chain into [inputPositions..., finalResult].
  const inputPositions: Type[] = [];
  let cur: Type = resolved;
  while (cur.tag === 'TFun') {
    inputPositions.push(cur.param);
    cur = cur.result;
  }
  const finalResult = cur;

  // Count top-level TVar id occurrences across inputs + final result.
  const idCount = new Map<number, number>();
  const bump = (t: Type) => {
    if (t.tag === 'TVar') idCount.set(t.id, (idCount.get(t.id) ?? 0) + 1);
  };
  for (const p of inputPositions) bump(p);
  bump(finalResult);

  const polyIds = new Set<number>();
  for (const [id, n] of idCount) if (n >= 2) polyIds.add(id);
  if (polyIds.size === 0) return calleeType;

  // Trigger: at least one provided arg sits on a top-level polyId input
  // position AND its AST is a structural literal we know how to row-open
  // (ObjectExpression → record-merge, ArrayExpression → array-element union).
  let trigger = false;
  for (let i = 0; i < args.length && i < inputPositions.length; i++) {
    const slot = inputPositions[i];
    if (slot.tag !== 'TVar' || !polyIds.has(slot.id)) continue;
    const a = args[i] as { type?: string } | undefined;
    if (a && (a.type === 'ObjectExpression' || a.type === 'ArrayExpression')) {
      trigger = true;
      break;
    }
  }
  if (!trigger) return calleeType;

  // Classify each polyId by the AST kind(s) of structural literals supplied
  // at its top-level input positions.  Polymorphic vars receiving a mix of
  // record + array literals fall back to classical rigid HM (mode = null).
  // No engine-level hardcoding of class names: representative kinds are
  // derived purely from the AST node tags.
  type PolyMode = 'merge' | 'arrayUnion';
  const polyKinds = new Map<number, Set<string>>();
  for (let i = 0; i < args.length && i < inputPositions.length; i++) {
    const slot = inputPositions[i];
    if (slot.tag !== 'TVar' || !polyIds.has(slot.id)) continue;
    const a = args[i] as { type?: string } | undefined;
    if (!a) continue;
    if (a.type !== 'ObjectExpression' && a.type !== 'ArrayExpression') continue;
    if (!polyKinds.has(slot.id)) polyKinds.set(slot.id, new Set());
    polyKinds.get(slot.id)!.add(a.type);
  }
  const polyMode = new Map<number, PolyMode | null>();
  for (const id of polyIds) {
    const kinds = polyKinds.get(id);
    if (!kinds || kinds.size !== 1) { polyMode.set(id, null); continue; }
    if (kinds.has('ObjectExpression')) polyMode.set(id, 'merge');
    else if (kinds.has('ArrayExpression')) polyMode.set(id, 'arrayUnion');
    else polyMode.set(id, null);
  }

  // Plan v6.3 opt-in gate: row-opening only fires when the user has
  // explicitly declared a polymorphic combinator signature on some
  // `<Container>#<method>` required by one of the constraints attached
  // to the polymorphic TVars.  Without that annotation, structural args
  // keep classical rigid HM.  Per-container representative type ('Object'
  // for record literals, 'Array' for array literals) is derived from AST.
  const constraintNames = new Set<string>();
  for (const pc of engine.pendingConstraints) {
    if (polyIds.has(pc.varId)) constraintNames.add(pc.constraintName);
  }
  if (constraintNames.size === 0) return calleeType;

  const containsMerge = (t: Type): boolean =>
    someType(t, (n) => n.tag === 'TCon' && n.name === T_MERGE);

  // Detect `[Union ...]` (an Array whose element type contains a Union):
  // the signature shape that signals array-element widening at the call site.
  const containsArrayUnion = (t: Type): boolean =>
    someType(t, (n) =>
      n.tag === 'TCon' && n.name === T_ARRAY && n.args.length === 1 &&
      someType(n.args[0], (inner) => inner.tag === 'TCon' && inner.name === T_UNION),
    );

  const requiredMethodNames = (cdef: NonNullable<ReturnType<typeof lookupConstraint>>): string[] => {
    const names: string[] = [];
    for (const m of cdef.methods ?? []) names.push(m.name);
    for (const clause of cdef.selfClauses ?? []) {
      const body = clause.body;
      if (body.tag === 'TRecord') {
        for (const fname of Object.keys(body.fields)) {
          if (fname !== 'constructor') names.push(fname);
        }
      }
    }
    return names;
  };

  let optedInObject = false;
  let optedInArray = false;
  for (const cname of constraintNames) {
    const cdef = lookupConstraint(cname);
    if (!cdef) continue;
    for (const mname of requiredMethodNames(cdef)) {
      if (!optedInObject) {
        const oe = lookupMethod('Object', mname);
        if (oe) { try { if (containsMerge(oe.factory([]))) optedInObject = true; } catch { /* keep scanning */ } }
      }
      if (!optedInArray) {
        const ae = lookupMethod('Array', mname);
        if (ae) { try { if (containsArrayUnion(ae.factory([]))) optedInArray = true; } catch { /* keep scanning */ } }
      }
      if (optedInObject && optedInArray) break;
    }
    if (optedInObject && optedInArray) break;
  }

  // Strip modes that aren't opted-in via a registered instance method.
  for (const [id, m] of polyMode) {
    if (m === 'merge' && !optedInObject) polyMode.set(id, null);
    if (m === 'arrayUnion' && !optedInArray) polyMode.set(id, null);
  }
  let anyMode = false;
  for (const m of polyMode.values()) if (m) { anyMode = true; break; }
  if (!anyMode) return calleeType;

  // Allocate fresh TVars per (polyId, input position).  For arrayUnion
  // mode each αᵢ is immediately bound to `[γᵢ]` via the substitution so
  // Phase C sees TCon('Array', …) and dispatches to the Array instance,
  // while the result position becomes `[Union γ₁ … γₙ]`.
  const freshByOrigId = new Map<number, Type[]>();
  const elemByOrigId = new Map<number, Type[]>();
  for (const id of polyIds) {
    if (!polyMode.get(id)) continue;
    freshByOrigId.set(id, []);
    if (polyMode.get(id) === 'arrayUnion') elemByOrigId.set(id, []);
  }

  const newInputs: Type[] = inputPositions.map((p, i) => {
    if (p.tag === 'TVar' && polyIds.has(p.id) && polyMode.get(p.id)) {
      const mode = polyMode.get(p.id);
      const fv = tVar();
      freshByOrigId.get(p.id)!.push(fv);
      if (mode === 'arrayUnion') {
        const gv = tVar();
        elemByOrigId.get(p.id)!.push(gv);
        if (fv.tag === 'TVar') engine.subst.set(fv.id, tArray(gv));
        // Return the concrete Array type for this input slot so the arg
        // unifies directly with `[γᵢ]`.
        void i;
        return tArray(gv);
      }
      return fv;
    }
    return p;
  });

  // Rewrite top-level result occurrence (if any) into the appropriate
  // combinator for the polyId's mode.
  let newResult: Type = finalResult;
  if (finalResult.tag === 'TVar' && polyIds.has(finalResult.id) && polyMode.get(finalResult.id)) {
    const id = finalResult.id;
    const mode = polyMode.get(id);
    if (mode === 'merge') {
      const fresh = freshByOrigId.get(id) ?? [];
      if (fresh.length === 0) newResult = finalResult;
      else if (fresh.length === 1) newResult = fresh[0];
      else newResult = tCon(T_MERGE, fresh);
    } else if (mode === 'arrayUnion') {
      const elems = elemByOrigId.get(id) ?? [];
      if (elems.length === 0) newResult = finalResult;
      else if (elems.length === 1) newResult = tArray(elems[0]);
      else newResult = tArray(tUnion(elems));
    }
  }

  // Replicate pending constraints from each original poly TVar onto its
  // fresh αᵢ children so Phase C drives per-row container-instance lookup.
  // For arrayUnion mode the αᵢ already resolve to TCon('Array', …) via
  // the substitution above, so Phase C maps typeToCheck='Array'.
  const originalPending = engine.pendingConstraints.slice();
  for (const pc of originalPending) {
    if (!polyIds.has(pc.varId)) continue;
    const freshList = freshByOrigId.get(pc.varId) ?? [];
    for (const fv of freshList) {
      if (fv.tag !== 'TVar') continue;
      engine.pendingConstraints.push({
        varId: fv.id,
        constraintName: pc.constraintName,
        node: pc.node,
        reps: pc.reps,
      });
    }
  }

  // Rebuild the curried TFun chain right-to-left.
  let rebuilt: Type = newResult;
  for (let i = newInputs.length - 1; i >= 0; i--) {
    rebuilt = tFun(newInputs[i], rebuilt);
  }
  return rebuilt;
}

/** Bind the parameter-position arg of the host TCon to `paramRec`.  Uses
 *  `findHostSlots` to identify the slot — for a 2-arg `QueryTag p row` the
 *  slot is index 0; for the legacy 1-arg form there is no parameter slot
 *  and this is a no-op.  When the slot is already a concrete record we
 *  unify (so user-annotated forms still match); when it is a TVar we
 *  bind it directly via the engine's substitution.
 *
 *  When the host TCon's declared arity does NOT include a parameter arg
 *  (e.g. `QueryTag :: a -> QueryTag a` carries only the row), the record is
 *  instead attached as `hostType.paramHint` so hover and signature help
 *  can still substitute the parameter slot of any instance-callable
 *  overload (`QueryTag() :: p -> Promise [o]`) at display time. */
function bindParamSlot(
  engine: InferenceEngine,
  hostType: Type,
  paramRec: Type,
): void {
  const { paramArg } = findHostSlots(hostType);
  if (!paramArg) {
    if (hostType.tag === 'TCon') hostType.paramHint = paramRec;
    return;
  }
  const applied = engine.subst.apply(paramArg);
  if (applied.tag === 'TVar') {
    engine.subst.set(applied.id, paramRec);
    return;
  }
  // Slot already bound (e.g. a nested sub-query's own params threaded
  // through a shared `p` in the selector union, or a prior harvest).
  // Merge the harvested fields in FIELD-WISE — two closed records with
  // disjoint fields do not unify, so a plain record unify would silently
  // drop the new fields.  Write the merged record back through the slot's
  // TVar when there is one, otherwise directly into the host's arg slot.
  if (applied.tag === 'TRecord' && paramRec.tag === 'TRecord') {
    const fields: Record<string, Type> = { ...applied.fields };
    let changed = false;
    for (const k in paramRec.fields) {
      const incoming = engine.subst.apply(paramRec.fields[k]);
      if (k in fields) {
        try { engine.subst.mergeFrom(unify(fields[k], incoming)); } catch { /* skip conflict */ }
      } else {
        fields[k] = incoming;
        changed = true;
      }
    }
    if (changed) {
      const merged: Type = { ...applied, fields };
      if (paramArg.tag === 'TVar') {
        engine.subst.set(paramArg.id, merged);
      } else if (hostType.tag === 'TCon' && hostType.args.length >= 2) {
        hostType.args[hostType.args.length - 2] = merged;
        // The in-place write above only updates THIS host object.  Other
        // type-vars may already be bound to the stale pre-merge record —
        // e.g. a shared `p` pinned through the selector union, or an
        // outer combinator's slot (`QueryTag#concat`'s `p2`) unified
        // against it while this call was inferred as an inline argument.
        // Sweep the substitution and upgrade every binding that is
        // structurally the stale record so all aliases observe the merge
        // (same precedent as the Picked-projection subst sweep above).
        for (const [id, bound] of engine.subst.entries()) {
          const b = engine.subst.apply(bound);
          if (b.tag === 'TRecord' && structuralEquals(b, applied)) {
            engine.subst.set(id, merged);
          }
        }
      }
    }
    return;
  }
  try {
    engine.subst.mergeFrom(unify(applied, paramRec));
  } catch { /* incompatible — surface via existing unification diagnostics elsewhere */ }
}

/** Unify each field of `paramRec` whose name matches a column of the
 *  host's row record with that column's type.  Skips fields that are
 *  already bound to a concrete (non-TVar) type — those came from a
 *  helper's declared signature and must take precedence over the row.
 *  Used after `gatherParamRecord` so that, e.g., the body
 *  `p => p.id` against an `OrganisationRow { id :: Number }` projection
 *  yields `id :: Number` in the params slot instead of a free TVar. */
function enrichParamRecFromRow(
  engine: InferenceEngine,
  hostType: Type,
  paramRec: Type,
): void {
  if (paramRec.tag !== 'TRecord') return;
  const { rowArg } = findHostSlots(hostType);
  if (!rowArg) return;
  enrichParamRecFromRecord(engine, rowArg, paramRec);
}

/** Lower-level helper: unify each field of `paramRec` whose name matches
 *  a field in `rowSource` with that field's type, when the param field
 *  is still an unbound TVar.  `rowSource` may be a TRecord, a TCon
 *  alias, or anything that expands via `maybeExpandAlias`. */
function enrichParamRecFromRecord(
  engine: InferenceEngine,
  rowSource: Type,
  paramRec: Type,
): void {
  if (paramRec.tag !== 'TRecord') return;
  const row = engine.maybeExpandAlias(engine.subst.apply(rowSource));
  if (row.tag !== 'TRecord') return;
  for (const k in paramRec.fields) {
    if (!(k in row.fields)) continue;
    const v = engine.subst.apply(paramRec.fields[k]);
    if (v.tag !== 'TVar') continue;
    const colType = engine.subst.apply(row.fields[k]);
    try { engine.subst.mergeFrom(unify(v, colType)); } catch { /* skip conflict */ }
  }
}

/** Project an array-literal AST against a row type, building a structural
 *  TRecord.  Returns null when the row argument cannot be resolved to a
 *  TRecord with field information. */
function projectArrayAgainstRow(
  engine: InferenceEngine,
  arrayNode: estree.ArrayExpression,
  rowArg: Type,
): Type | null {
  const expanded = engine.maybeExpandAlias(engine.subst.apply(rowArg));
  if (expanded.tag !== 'TRecord') return null;
  const rowFields = expanded.fields;
  const rowAlias = expanded.alias;

  const projected: Record<string, Type> = {};
  let sawColumnSelector = false;

  for (const elem of arrayNode.elements) {
    if (!elem) continue;
    const elemNode = elem as AstNode;

    // 1. String literal — column reference into the row.
    if (elemNode.type === 'Literal' && typeof (elemNode as estree.Literal).value === 'string') {
      const key = (elemNode as estree.Literal).value as string;
      if (key in rowFields) {
        projected[key] = engine.subst.apply(rowFields[key]);
        sawColumnSelector = true;
      }
      continue;
    }

    const elemType = engine.subst.apply(engine.getNodeType(elemNode) ?? tVar());

    // 2. Identifier of `Prop T` type — name becomes the field key.
    if (elemNode.type === 'Identifier') {
      const idName = (elemNode as estree.Identifier).name;
      if (idName in rowFields) {
        projected[idName] = engine.subst.apply(rowFields[idName]);
        sawColumnSelector = true;
        continue;
      }
      // The query-builder convention is `Prop t v` (tag, value): the VALUE
      // type lives at the LAST arg slot.  Older single-arg `Prop v`
      // declarations also work because we still pick the last arg.
      if (elemType.tag === 'TCon' && elemType.name === 'Prop' && elemType.args.length >= 1) {
        projected[idName] = engine.subst.apply(elemType.args[elemType.args.length - 1]);
        continue;
      }
    }

    // 3. Nested call returning a related row — resolve the FK key via
    //    the parent row's method-shadows.  Try to recover the *source*
    //    row name from the callee's pre-projection signature (its
    //    Picked marker), since the call's stored result has already
    //    been projected and lost its alias.
    //
    //    Also handles bare identifier references to row constructors
    //    (e.g. `LocationType` listed without parentheses).  In that
    //    case `elemType` is the constructor's TFun signature; we
    //    extract the row name from its Picked marker and apply with
    //    no inner projection — meaning all of the child row's columns
    //    are selected (the query-builder convention for an unparenthesised
    //    relation).
    if (rowAlias) {
      const childRowName = extractChildRowName(engine, elemNode, elemType);
      if (childRowName) {
        // Bare-identifier vs nested-call paths use different sources
        // for the inner record:
        //
        // - Bare identifier (e.g. `LocationType` without parens): the
        //   element type is the constructor itself — typically a
        //   value-as-callable Union of `{ props :: {…} } | Table R |
        //   ([Sel] -> QueryTag p (Picked R Sel))`.  Walking that union
        //   for a TRecord would grab the `{ props :: {…} }` branch,
        //   which is the constructor's method-shadow surface, NOT the
        //   row's columns.  For a bare relation reference the query-builder
        //   convention is "select every column of the child row", so
        //   expand the row alias directly and skip
        //   `extractInnerProjectedRecord` entirely.
        //
        // - Nested call (e.g. `LocationType(["id"])`): the call's
        //   stored result type IS the projected row — recover it via
        //   `extractInnerProjectedRecord`.
        let innerProjected: Type | null;
        if (elemNode.type === 'Identifier') {
          innerProjected = expandRowAliasToRecord(engine, childRowName);
        } else {
          innerProjected = extractInnerProjectedRecord(engine, elemType);
        }
        const shape = nestedResultShape(engine, elemType);
        // A nested element whose call result does not carry its row (a
        // filter such as a query builder's `exists`) adds no field.
        if (shape === 'omit') continue;
        const match = findShadowKeyForChildRow(rowAlias, childRowName, innerProjected);
        if (match) {
          projected[match.key] = shape === null || shape === 'list'
            ? match.fieldType
            : singleFieldType(match.fieldType, shape === 'nullable');
          continue;
        }
        // No shadow found — element is silently dropped from the
        // projection.  An earlier attempt at emitting `'<X>' is not a
        // relation of '<Y>'` here proved unreliable (false positives on
        // valid relations whose shadow factory had been alias-expanded
        // beyond simple TCon recognition, plus duplicate diagnostics from
        // the rewrite-walker visiting each Picked occurrence).  Wrong-
        // relation cases must instead be caught upstream by unifying
        // each array element against the parent's `<Table>Selector`
        // union before the projection runs.
      }
    }

    // Anything else — skipped silently.
  }

  // query-builder convention: an array with no explicit column selectors
  // (only relations / calculated fields / paging helpers) implicitly
  // selects every column of the row.  Existing keys (e.g. relations
  // sharing a column name) are preserved and not overwritten.
  let defaultProjection = false;
  if (!sawColumnSelector) {
    for (const k in rowFields) {
      if (!(k in projected)) {
        projected[k] = engine.subst.apply(rowFields[k]);
        defaultProjection = true;
      }
    }
  }

  const out = tRecord(projected);
  if (defaultProjection) out.defaultProjection = true;
  // Tag the projected record with its source row name so downstream
  // unification against a `Picked R _` slot can match by row identity
  // (see `unifyPickedAgainstRecord` in src/hm/unify.ts).  This is the
  // generic Picked-projection bookkeeping — independent of any
  // particular library.
  if (rowAlias) out.pickedFrom = rowAlias;
  return out;
}

/**
 * How a nested element contributes to its parent's projection, read off the
 * element type's instance-callable annotation (`Name() :: p -> …`): a nested
 * query contributes what calling it would return.
 *   - `'list'`: the row sits in an array (`p -> Promise e [o]`);
 *   - `'single'` / `'nullable'`: the row itself (`p -> Promise e o`,
 *     `p -> RTask r e (o | Null)`);
 *   - `'omit'`: the row does not occur in the result (`p -> Promise e
 *     Boolean`): a filter, no field;
 *   - `null`: no callable annotation — keep the parent's relation shadow.
 * Library-agnostic: query-builder uses it for `one` (`QueryOne`) and `exists`
 * (`QueryExists`), any query builder can annotate its tags the same way.
 */
function nestedResultShape(engine: InferenceEngine, elemType: Type): 'list' | 'single' | 'nullable' | 'omit' | null {
  const t = engine.subst.apply(elemType);
  if (t.tag !== 'TCon') return null;
  const callables = engine.instanceCallables.get(t.name);
  if (!callables || callables.length === 0) return null;
  const branch = instantiate(callables[0]);
  if (branch.tag !== 'TFun') return null;
  const { carrierTVarId } = findOverloadSlots(branch);
  if (carrierTVarId === null) return 'omit';
  let inArray = false;
  let nullable = false;
  const walk = (x: Type, underArray: boolean, underUnion: boolean): void => {
    if (x.tag === 'TVar' && x.id === carrierTVarId) {
      if (underArray) inArray = true;
      return;
    }
    if (x.tag === 'TCon') {
      const isArray = x.name === T_ARRAY;
      const isUnion = x.name === 'Union';
      if (isUnion && x.args.some(a => a.tag === 'TVar' && a.id === carrierTVarId)
          && x.args.some(a => a.tag === 'TCon' && (a.name === 'Null' || a.name === 'Undefined'))) {
        nullable = true;
      }
      for (const a of x.args) walk(a, underArray || isArray, underUnion || isUnion);
    }
  };
  walk(branch.result, false, false);
  if (inArray) return 'list';
  return nullable ? 'nullable' : 'single';
}

/** The single-valued field type for a relation whose shadow may be a list:
 *  `[X]` → `X`, optionally `| Null`. */
function singleFieldType(fieldType: Type, nullable: boolean): Type {
  const one = fieldType.tag === 'TCon' && fieldType.name === T_ARRAY && fieldType.args.length === 1
    ? fieldType.args[0]
    : fieldType;
  return nullable ? tUnion([one, tCon('Null', [])]) : one;
}

/** Recover the source row name for a projected element.  We can't read
 *  it off `elemType.args[0]` directly when the element is a nested call,
 *  because by the time the outer projection runs the inner call's
 *  stored result has already been projected — its alias has been
 *  stripped on purpose.  Instead, when the element is a CallExpression
 *  inspect the callee Identifier's TFun signature for a `Picked R _`
 *  marker.  Falls back to reading the alias off `elemType` for the
 *  non-call (already-aliased value) case. */
function extractChildRowName(
  engine: InferenceEngine,
  elemNode: AstNode,
  elemType: Type,
): string | null {
  if (elemNode.type === 'CallExpression') {
    const callee = (elemNode as estree.CallExpression).callee as AstNode;
    const calleeType = engine.subst.apply(engine.getNodeType(callee) ?? tVar());
    const found = findPickedRowInType(engine, calleeType);
    if (found) return found;
  }
  // Bare identifier referencing a row constructor — e.g. `LocationType`
  // listed inside another selector array.  Its type is a TFun whose
  // result carries the `Picked R _` marker, or (for a query builder's value-as-
  // callable overloads) a Union containing such a TFun alongside a
  // `Table R` / `QueryTag R` branch.  Either way `findPickedRowInType`
  // recurses into the structure and surfaces the row alias.
  if (elemNode.type === 'Identifier') {
    const found = findPickedRowInType(engine, elemType);
    if (found) return found;
  }
  if (elemType.tag === 'TCon' && elemType.args.length >= 1) {
    for (const arg of elemType.args) {
      const inner = engine.maybeExpandAlias(engine.subst.apply(arg));
      if (inner.tag === 'TRecord' && inner.alias) return inner.alias;
      // Only treat a bare TCon as a row reference when it names a RECORD
      // alias (`DepartmentsRow :: { … }`, or `Department :: { … }` — no naming
      // convention required).  Without this guard the fallback misfires on
      // generic helpers like `Limit Number` or `Table SomeRecord`,
      // returning `Number` / `Table` as a "row" and triggering bogus
      // shadow lookups (and worse, sometimes successful matches).
      if (inner.tag === 'TCon' && inner.args.length === 0
          && engine.typeAliases.has(inner.name)
          && engine.maybeExpandAlias(inner).tag === 'TRecord') return inner.name;
    }
  }
  return null;
}

function findPickedRowInType(engine: InferenceEngine, t: Type): string | null {
  // Collect every distinct row name appearing in a `Picked R _` marker
  // anywhere in `t`.  When the type contains multiple different row
  // names (typical of a `*Selector` union branching across many related
  // tables) the element is ambiguous — returning any of them risks
  // mis-classifying e.g. an SQL fragment as a relation, so we surface
  // null and let the caller drop the element.  The caller only needs a
  // row name when the type unambiguously commits to a single one.
  const found = new Set<string>();
  const seen = new Set<Type>();
  const go = (x: Type): void => {
    if (seen.has(x)) return;
    seen.add(x);
    const a = engine.subst.apply(x);
    if (a.tag === 'TCon' && a.name === T_PICKED && a.args.length >= 1) {
      const r = engine.subst.apply(a.args[0]);
      if (r.tag === 'TCon') { found.add(r.name); return; }
      if (r.tag === 'TRecord' && r.alias) { found.add(r.alias); return; }
    }
    if (a.tag === 'TCon') {
      for (const arg of a.args) go(arg);
      return;
    }
    if (a.tag === 'TFun') {
      // Only walk the result side: a value-as-callable constructor
      // signature `[ChildSelector] -> QueryTag p (Picked ChildRow a)` has a
      // selector union in its param that legitimately mentions many
      // Picked rows from sibling tables.  Treating those as candidate
      // child rows would falsely flag the constructor as ambiguous.
      go(a.result);
      return;
    }
  };
  go(t);
  if (found.size === 1) return [...found][0];
  return null;
}

/** Extract the inner projected record from a nested call's element type.
 *  When the inner Picked projection has run, `elemType` is typically a
 *  callable wrapper (e.g. `QueryTag <record>`, `Table <record>`, or in
 *  multi-arg form `QueryTag <param> <record>`) wrapping the projected row
 *  TRecord.  Targets the ROW slot specifically via `findHostSlots` —
 *  for `QueryTag p row` the row lives at the last arg, and the param
 *  slot may itself have been substituted to a TRecord by an earlier
 *  `bindParamSlot` call.  Falling back to "first TRecord arg" would
 *  return the params record, conflating the projected row with the
 *  call's parameter shape. */
function extractInnerProjectedRecord(engine: InferenceEngine, elemType: Type): Type | null {
  const t = engine.subst.apply(elemType);
  if (t.tag !== 'TCon' || t.args.length === 0) return null;
  const { rowArg } = findHostSlots(t);
  const candidates: Type[] = rowArg ? [rowArg] : t.args;
  for (const arg of candidates) {
    const inner = engine.maybeExpandAlias(engine.subst.apply(arg));
    if (inner.tag === 'TRecord') {
      return inner.alias ? { ...inner, alias: undefined } : inner;
    }
  }
  return null;
}

/** Expand a row alias name (e.g. `LocationTypeRow`) to its structural
 *  TRecord, with the alias stripped so it inlines in hover output rather
 *  than showing as the bare alias.  Returns null when no alias is
 *  registered or when expansion doesn't yield a TRecord. */
function expandRowAliasToRecord(engine: InferenceEngine, rowName: string): Type | null {
  const expanded = engine.maybeExpandAlias({ tag: 'TCon', name: rowName, args: [] });
  if (expanded.tag !== 'TRecord') return null;
  if (!expanded.alias) return expanded;
  return { ...expanded, alias: undefined };
}

/** Search the parent row's registered method-shadows for one whose return
 *  type matches `[ChildRow]` (list-valued relation) or `ChildRow` (single).
 *  Returns the shadow's name as the projected key plus its return type.
 *  When `innerProjected` is supplied (the projected record from a nested
 *  call), the field type substitutes that record for the bare row alias. */
export function findShadowKeyForChildRow(
  parentRowName: string,
  childRowName: string,
  innerProjected: Type | null = null,
): { key: string; fieldType: Type } | null {
  const names = getMethodNames(parentRowName);
  for (const name of names) {
    const entry = lookupMethod(parentRowName, name);
    if (!entry) continue;
    let returnType: Type;
    try {
      returnType = entry.factory([]);
    } catch {
      continue;
    }
    // List-valued: [ChildRow]
    if (returnType.tag === 'TCon' && returnType.name === T_ARRAY && returnType.args.length === 1) {
      const inner = returnType.args[0];
      if (inner.tag === 'TCon' && inner.name === childRowName) {
        const fieldType = innerProjected ? { ...returnType, args: [innerProjected] } : returnType;
        return { key: name, fieldType };
      }
      if (inner.tag === 'TRecord' && inner.alias === childRowName) {
        const fieldType = innerProjected ? { ...returnType, args: [innerProjected] } : returnType;
        return { key: name, fieldType };
      }
    }
    // Single-valued: ChildRow directly.
    if (returnType.tag === 'TCon' && returnType.name === childRowName) {
      return { key: name, fieldType: innerProjected ?? returnType };
    }
    if (returnType.tag === 'TRecord' && returnType.alias === childRowName) {
      return { key: name, fieldType: innerProjected ?? returnType };
    }
  }
  return null;
}

/**
 * Reduce `Awaited a` markers in a call result: `Awaited (Promise e x)` → `x`
 * (repeatedly, a Promise never holds a Promise), anything else → itself.
 * Used by `Promise#then` so a callback that returns a Promise flattens.
 */
export function applyAwaitedReduction(engine: InferenceEngine, result: Type): Type {
  // `Awaited` only appears in a Promise result (Promise#then); skip the walk
  // for everything else.
  if (!(result.tag === 'TCon' && result.name === 'Promise')) return result;
  return mapType(result, n => {
    if (n.tag !== 'TCon' || n.name !== 'Awaited' || n.args.length !== 1) return undefined;
    let inner = engine.subst.apply(applyAwaitedReduction(engine, n.args[0]));
    while (inner.tag === 'TCon' && inner.name === 'Promise' && inner.args.length === 2) {
      inner = engine.subst.apply(inner.args[1]);
    }
    return inner;
  });
}
