// ============================================================================
// Type Environment — maps variable names to type schemes
//
// WHAT THIS FILE DOES (in plain language)
// ---------------------------------------------------------------------------
// The environment is the checker's phone book: "which names are currently in
// scope, and what is the type of each?".  Entering a new scope (a function
// body, a block) adds a new page that can shadow the previous one —
// implemented cheaply as a child node with a pointer back to its parent.
//
// This file also hosts the two operations that make polymorphism work:
//   • generalize   — seal a finished definition's leftover placeholders into
//                    a reusable template (Scheme): `x => x` becomes `a -> a`.
//   • instantiate  — stamp out a fresh copy of such a template for one
//                    particular use site, with brand-new placeholders.
// Plus the seeding of the global scope (built-in globals like console, JSON).
// ============================================================================

import { Scheme, Type, Constraint, tVar, tRow, tCon, tAny, tAnyType, tNamedWildcard, tUnion, tUndefined, mono, scheme, tFun, tString, tNumber, tBool, tVoid, tRecord, tArray, tTuple, tSpread, collectVarNames, setActiveAllocator, TypeVarAllocator, SKOLEM_PREFIX, AUTO_TVAR_NAME_RE } from './types';
import { isDomGlobalTypesEnabled } from '../registries/domGlobals';
import { Substitution } from './substitution';
import { collectTVarIdsFromType } from './typeUtils';

export class TypeEnv {
  private bindings: Map<string, Scheme>;
  private parent?: TypeEnv;

  constructor(entries?: Iterable<[string, Scheme]>) {
    this.bindings = new Map(entries);
  }

  /** Traverse the parent chain, yielding each TypeEnv node. */
  private *chain(): Generator<TypeEnv> {
    let current: TypeEnv | undefined = this;
    while (current) {
      yield current;
      current = current.parent;
    }
  }

  /** Look up a variable. */
  lookup(name: string): Scheme | undefined {
    const local = this.bindings.get(name);
    if (local !== undefined) return local;
    return this.parent?.lookup(name);
  }

  /**
   * Extend environment with a new binding (returns a new env).
   *
   * O(1) — creates a lightweight child node with a single-entry map and a
   * parent pointer back to `this`.  The previous implementation copied the
   * *entire* bindings map (O(n)) on every call, which dominated bind-time
   * costs for environments with 30-50+ entries.
   */
  extend(name: string, scheme: Scheme): TypeEnv {
    const child = new TypeEnv();
    child.parent = this;
    child.bindings.set(name, scheme);
    return child;
  }

  /** Remove a binding (returns a new env). */
  remove(name: string): TypeEnv {
    const flat = new TypeEnv();
    for (const [n, s] of this.entries()) {
      if (n !== name) flat.bindings.set(n, s);
    }
    return flat;
  }

  /** Apply a substitution to every scheme in the environment. */
  applySubst(subst: Substitution): TypeEnv {
    const newEntries: [string, Scheme][] = [];
    for (const [name, scheme] of this.entries()) {
      newEntries.push([name, applySubstToScheme(subst, scheme)]);
    }
    return new TypeEnv(newEntries);
  }

  /**
   * Collect all free type-variable ids across the environment.
   *
   * When `subst` is supplied, each scheme's free variables are resolved
   * THROUGH the current substitution first.  This matters for generalization:
   * an environment binding stored as `mono(t_f)` may have had `t_f` unified to
   * `t_arg -> t_r` during body inference; without resolving through `subst`,
   * `t_r` would be invisible here and a `const` sharing it (e.g.
   * `const result = f(arg)`) would be WRONGLY generalized to `∀. t_r`.
   */
  freeTypeVars(subst?: Substitution): Set<number> {
    const result = new Set<number>();
    const seen = new Set<string>();
    for (const env of this.chain()) {
      for (const [name, scheme] of env.bindings) {
        if (!seen.has(name)) {
          seen.add(name);
          for (const v of freeTypeVarsInScheme(scheme, subst)) {
            result.add(v);
          }
        }
      }
    }
    return result;
  }

  /** Get all bindings (respects shadowing — child bindings win). */
  *entries(): Generator<[string, Scheme]> {
    const seen = new Set<string>();
    for (const env of this.chain()) {
      for (const [name, scheme] of env.bindings) {
        if (!seen.has(name)) {
          seen.add(name);
          yield [name, scheme];
        }
      }
    }
  }

  get size(): number {
    const seen = new Set<string>();
    for (const env of this.chain()) {
      for (const name of env.bindings.keys()) {
        seen.add(name);
      }
    }
    return seen.size;
  }
}

// ---------------------------------------------------------------------------
// Helpers for free variables & substitution on schemes
// ---------------------------------------------------------------------------

export function freeTypeVarsInType(t: Type): Set<number> {
  const ids = new Set<number>();
  collectTVarIdsFromType(t, ids);
  return ids;
}

/**
 * Resolve a set of type-variable ids through a substitution, returning the
 * ids that remain FREE (unbound) once every binding is followed.  A bound id
 * is replaced by the free variables of the type it resolves to (transitively).
 * `visited` guards against cyclic (recursive-type) substitutions.
 */
function resolveFreeVarsUnderSubst(roots: Iterable<number>, subst: Substitution): Set<number> {
  const out = new Set<number>();
  const visited = new Set<number>();
  const stack: number[] = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const bound = subst.lookup(id);
    if (bound === undefined) {
      out.add(id);
    } else {
      for (const v of freeTypeVarsInType(bound)) stack.push(v);
    }
  }
  return out;
}

export function freeTypeVarsInScheme(scheme: Scheme, subst?: Substitution): Set<number> {
  const free = freeTypeVarsInType(scheme.type);
  for (const v of scheme.vars) {
    free.delete(v);
  }
  return subst ? resolveFreeVarsUnderSubst(free, subst) : free;
}

export function applySubstToScheme(subst: Substitution, scheme: Scheme): Scheme {
  // Substitute only free variables — skip bound vars
  const cleanSubst = new Substitution();
  for (const [id, type] of subst.entries()) {
    if (!scheme.vars.includes(id)) {
      cleanSubst.set(id, type);
    }
  }
  return {
    ...scheme,
    type: cleanSubst.apply(scheme.type),
  };
}

/**
 * Instantiate a scheme: replace all bound variables with fresh type variables.
 */
export function instantiate(scheme: Scheme): Type {
  // Collect original var names from the scheme type so fresh vars
  // carry the same names (e.g. 'a', 'c' instead of 't39', 't40').
  const varNames = new Map<number, string>();
  collectVarNames(scheme.type, varNames);

  // Determine which scheme ids appear as TLabel-vars (so they get
  // freshened as labels, not ordinary type variables).
  const labelIds = new Set<number>();
  collectLabelVarIds(scheme.type, labelIds);

  // Determine which scheme ids appear as TRow vars (so they get freshened
  // as rows, preserving the disjoint sort across instantiation).
  const rowIds = new Set<number>();
  collectRowVarIds(scheme.type, rowIds);

  const subst = new Substitution();
  const schemeVarSet = new Set(scheme.vars);
  for (const v of scheme.vars) {
    if (labelIds.has(v)) {
      const name = varNames.get(v);
      // Allocate via tVar() for a fresh id, then wrap as TLabel-var.
      let fresh = tVar(name);
      while (schemeVarSet.has(fresh.id)) fresh = tVar(name);
      subst.set(v, { tag: 'TLabel', kind: 'var', id: fresh.id, name: name ?? fresh.name });
      continue;
    }
    if (rowIds.has(v)) {
      const name = varNames.get(v);
      let freshRow = tRow(name);
      while (schemeVarSet.has(freshRow.id)) freshRow = tRow(name);
      subst.set(v, freshRow);
      continue;
    }
    let fresh = tVar(varNames.get(v));
    // Avoid allocating a TVar whose id collides with one of the scheme's
    // own bound variables — otherwise the substitution becomes a no-op and
    // the original (shared) TVar leaks into the engine's unification.
    while (schemeVarSet.has(fresh.id)) {
      fresh = tVar(varNames.get(v));
    }
    subst.set(v, fresh);
  }
  return subst.apply(scheme.type);
}

export function collectLabelVarIds(t: Type, out: Set<number>): void {
  switch (t.tag) {
    case 'TLabel': if (t.kind === 'var') out.add(t.id); return;
    case 'TFun': collectLabelVarIds(t.param, out); collectLabelVarIds(t.result, out); return;
    case 'TCon': t.args.forEach(a => collectLabelVarIds(a, out)); return;
    case 'TRecord':
      for (const k in t.fields) collectLabelVarIds(t.fields[k], out);
      if (t.labelFields) for (const lf of t.labelFields) {
        collectLabelVarIds(lf.label, out);
        collectLabelVarIds(lf.type, out);
      }
      return;
    case 'TVar': return;
    case 'TRow': return;
    case 'TForall': collectLabelVarIds(t.body, out); return;
  }
}

/** Walk a type tree collecting ids of any TRow nodes encountered.  Used by
 *  {@link instantiate} so quantified row-vars get freshened as rows (not
 *  TVars) and the disjoint TRow sort survives instantiation. */
export function collectRowVarIds(t: Type, out: Set<number>): void {
  switch (t.tag) {
    case 'TRow': out.add(t.id); return;
    case 'TFun': collectRowVarIds(t.param, out); collectRowVarIds(t.result, out); return;
    case 'TCon': t.args.forEach(a => collectRowVarIds(a, out)); return;
    case 'TRecord':
      for (const k in t.fields) collectRowVarIds(t.fields[k], out);
      if (t.labelFields) for (const lf of t.labelFields) collectRowVarIds(lf.type, out);
      if (t.rest && t.rest.tag === 'TRow') out.add(t.rest.id);
      return;
    case 'TVar': return;
    case 'TLabel': return;
    case 'TForall': collectRowVarIds(t.body, out); return;
  }
}

/**
 * Instantiate a scheme replacing quantified variables with the wildcard type `*`.
 * Used for expectedType when the annotation has free type variables — concrete
 * parts (like Boolean) are preserved and enforced, while free vars become `*`
 * which unifies with anything without producing bindings.
 */
export function instantiateWithAny(scheme: Scheme): Type {
  // Collect original var names so each free var gets a named wildcard
  // (e.g. '*:e', '*:a') that displays with the annotation name.
  const varNames = new Map<number, string>();
  collectVarNames(scheme.type, varNames);

  // Row- and label-variables must NOT degrade to wildcard `*` TCons:
  // a row variable models "an open record of unknown extra fields", and
  // collapsing it to a wildcard would (a) make an open record `{...a}`
  // render as the empty `{}` and (b) let unrelated types (e.g. `String`)
  // unify permissively with what should be a record, silently swallowing
  // genuine body-vs-annotation mismatches.  So we freshen them just like
  // {@link instantiate} does — as TRow / TLabel-var — and only the ordinary
  // type variables become named wildcards.
  const labelIds = new Set<number>();
  collectLabelVarIds(scheme.type, labelIds);
  const rowIds = new Set<number>();
  collectRowVarIds(scheme.type, rowIds);

  const subst = new Substitution();
  const schemeVarSet = new Set(scheme.vars);
  for (const v of scheme.vars) {
    if (labelIds.has(v)) {
      const name = varNames.get(v);
      let fresh = tVar(name);
      while (schemeVarSet.has(fresh.id)) fresh = tVar(name);
      subst.set(v, { tag: 'TLabel', kind: 'var', id: fresh.id, name: name ?? fresh.name });
      continue;
    }
    if (rowIds.has(v)) {
      const name = varNames.get(v);
      let freshRow = tRow(name);
      while (schemeVarSet.has(freshRow.id)) freshRow = tRow(name);
      subst.set(v, freshRow);
      continue;
    }
    const name = varNames.get(v);
    subst.set(v, name ? tNamedWildcard(name) : tAny);
  }
  const result = subst.apply(scheme.type);
  return result;
}

/**
 * Instantiate a scheme with rigid (skolem) type constants instead of fresh
 * unifiable variables.  Two distinct quantified variables become two distinct
 * TCon names (e.g. `§0`, `§1`), so unification will fail if the implementation
 * forces them to be equal.
 *
 * Returns the rigid type, the set of skolem names used, and a map from each
 * skolem name back to the original variable letter (e.g. `§0` → `b`) so the
 * skolems can be scrubbed back to readable names for display / diagnostics.
 */
let skolemCounter = 0;

/**
 * Collect the ids of every quantified variable that appears in a *parameter*
 * position of an arrow chain (recursing into nested function-typed params).
 * Variables that appear ONLY in the final return position are deliberately
 * excluded.
 *
 * Rationale: a variable shared with a parameter (or `this`) is *fixed by the
 * caller* — the body must preserve it, so it is skolemized (rigid + display
 * frozen).  A variable that occurs only in the return is *chosen by the body*
 * (e.g. `f :: a -> [b]` with `return [1,2,3]`), so it stays a flexible TVar
 * and a concrete return value is accepted while the annotation still drives
 * the displayed return type.
 */
function collectParamPositionVarIds(type: Type, into: Set<number>): void {
  let t = type;
  while (t.tag === 'TFun') {
    const m = new Map<number, string>();
    collectVarNames(t.param, m);
    for (const id of m.keys()) into.add(id);
    t = t.result;
  }
}

export function instantiateSkolem(scheme: Scheme): { type: Type; skolems: Set<string>; skolemToName: Map<string, string> } {
  // Original variable names so each skolem can be displayed with the
  // annotation's letter (e.g. `§0` represents `b`).
  const varNames = new Map<number, string>();
  collectVarNames(scheme.type, varNames);

  // Only freeze variables that appear in a parameter position; return-only
  // variables remain flexible so the body may return a concrete instance.
  const paramVarIds = new Set<number>();
  collectParamPositionVarIds(scheme.type, paramVarIds);

  // Row- and label-variables stay rows/labels: skolemizing them to an opaque
  // TCon would make an open record `{...a}` unify-incompatible with the
  // structurally-identical inferred record, producing a spurious self-mismatch.
  const labelIds = new Set<number>();
  collectLabelVarIds(scheme.type, labelIds);
  const rowIds = new Set<number>();
  collectRowVarIds(scheme.type, rowIds);

  const subst = new Substitution();
  const skolems = new Set<string>();
  const skolemToName = new Map<string, string>();
  for (const v of scheme.vars) {
    if (labelIds.has(v)) {
      const name = varNames.get(v);
      const fresh = tVar(name);
      subst.set(v, { tag: 'TLabel', kind: 'var', id: fresh.id, name: name ?? fresh.name });
      continue;
    }
    if (rowIds.has(v)) {
      subst.set(v, tRow(varNames.get(v)));
      continue;
    }
    if (paramVarIds.has(v)) {
      const name = `${SKOLEM_PREFIX}${skolemCounter++}`;
      skolems.add(name);
      const orig = varNames.get(v);
      const named = !!orig && !AUTO_TVAR_NAME_RE.test(orig);
      if (named) skolemToName.set(name, orig!);
      subst.set(v, named ? { ...tCon(name), skolemName: orig } as Type : tCon(name));
    } else {
      // Return-only variable: fresh flexible TVar, keeping the annotation's
      // display name so hover still shows the original letter.
      subst.set(v, tVar(varNames.get(v)));
    }
  }
  return { type: subst.apply(scheme.type), skolems, skolemToName };
}

export function instantiateRigid(scheme: Scheme): { type: Type; skolems: Set<string> } {
  // Fully rigid: every quantified variable becomes a skolem.  Used by the
  // post-hoc annotation rigid check (checkAnnotationRigid), which compares an
  // already-scrubbed inferred type against the annotation and therefore wants
  // maximal rigidity to surface genuine mismatches.
  const varNames = new Map<number, string>();
  collectVarNames(scheme.type, varNames);
  // Row- and label-variables stay rows/labels even under full rigidity, so an
  // open record compares structurally rather than as an opaque skolem TCon.
  const labelIds = new Set<number>();
  collectLabelVarIds(scheme.type, labelIds);
  const rowIds = new Set<number>();
  collectRowVarIds(scheme.type, rowIds);
  const subst = new Substitution();
  const skolems = new Set<string>();
  for (const v of scheme.vars) {
    if (labelIds.has(v)) {
      const name = varNames.get(v);
      const fresh = tVar(name);
      subst.set(v, { tag: 'TLabel', kind: 'var', id: fresh.id, name: name ?? fresh.name });
      continue;
    }
    if (rowIds.has(v)) {
      subst.set(v, tRow(varNames.get(v)));
      continue;
    }
    const name = `${SKOLEM_PREFIX}${skolemCounter++}`;
    skolems.add(name);
    subst.set(v, tCon(name));
  }
  return { type: subst.apply(scheme.type), skolems };
}

/**
 * Skolemize a rank-N `forall` type for call-site subsumption: every bound
 * variable becomes a fresh rigid skolem constant.  The argument supplied for
 * a `forall` parameter slot must type-check against the skolemized body —
 * only a genuinely polymorphic argument can do so, because the skolems unify
 * with nothing concrete.  Returns the skolemized body plus the skolem names
 * (for failure detection and escape checking) and a skolem→letter map for
 * readable diagnostics.
 */
export function skolemizeForall(f: Extract<Type, { tag: 'TForall' }>): { body: Type; skolems: Set<string>; skolemToName: Map<string, string>; varToSkolem: Map<number, string> } {
  const subst = new Substitution();
  const skolems = new Set<string>();
  const skolemToName = new Map<string, string>();
  const varToSkolem = new Map<number, string>();
  for (let i = 0; i < f.vars.length; i++) {
    const name = `${SKOLEM_PREFIX}${skolemCounter++}`;
    skolems.add(name);
    skolemToName.set(name, f.varNames[i] ?? `t${f.vars[i]}`);
    varToSkolem.set(f.vars[i], name);
    subst.set(f.vars[i], tCon(name));
  }
  return { body: subst.apply(f.body), skolems, skolemToName, varToSkolem };
}

/**
 * Build a skolem substitution for a scheme's quantified variables, collecting
 * display names from one or more type "shapes" (e.g. a method annotation's
 * receiver *and* method type) so the skolems can later be scrubbed back to the
 * annotation's letters.  Returns the substitution plus the skolem→name map.
 *
 * Apply the returned substitution to each shape separately to obtain rigid
 * receiver / method types that share the same skolems (mirrors how
 * `coordinateInstantiate` shares fresh TVars across receiver + methodType).
 *
 * `preBindings` (scheme var id → type) pins selected variables to
 * caller-supplied types INSTEAD of minting fresh skolems — used to link a
 * nested method annotation's receiver variables to the enclosing annotated
 * factory's own signature variables (which may themselves be skolems).
 */
export function skolemSubstForScheme(
  scheme: Scheme,
  receiver: Type,
  methodType: Type,
  preBindings?: Map<number, Type>,
): { subst: Substitution; skolems: Set<string>; skolemToName: Map<string, string> } {
  const varNames = new Map<number, string>();
  collectVarNames(receiver, varNames);
  collectVarNames(methodType, varNames);

  // Freeze only the variables fixed by the caller: every variable in the
  // receiver (`this`) plus every variable in a parameter position of the
  // method type.  Variables that occur only in the method's return position
  // stay flexible so the body may return a concrete instance (matching the
  // plain-`::` behaviour in instantiateSkolem).
  const paramVarIds = new Set<number>();
  const recvVars = new Map<number, string>();
  collectVarNames(receiver, recvVars);
  for (const id of recvVars.keys()) paramVarIds.add(id);
  collectParamPositionVarIds(methodType, paramVarIds);

  // Row- and label-variables must stay rows/labels (never degrade to a skolem
  // TCon): an open record `{...b}` in `this`/param position must remain open
  // so a spread body `{...this, ...obj}` reconstructs the annotated merge and
  // the rendered parameter is `{ b }` rather than the closed `{}`.
  const labelIds = new Set<number>();
  collectLabelVarIds(receiver, labelIds);
  collectLabelVarIds(methodType, labelIds);
  const rowIds = new Set<number>();
  collectRowVarIds(receiver, rowIds);
  collectRowVarIds(methodType, rowIds);

  const subst = new Substitution();
  const skolems = new Set<string>();
  const skolemToName = new Map<string, string>();
  for (const v of scheme.vars) {
    const pre = preBindings?.get(v);
    if (pre !== undefined) {
      subst.set(v, pre);
      continue;
    }
    if (labelIds.has(v)) {
      const name = varNames.get(v);
      const fresh = tVar(name);
      subst.set(v, { tag: 'TLabel', kind: 'var', id: fresh.id, name: name ?? fresh.name });
      continue;
    }
    if (rowIds.has(v)) {
      subst.set(v, tRow(varNames.get(v)));
      continue;
    }
    if (paramVarIds.has(v)) {
      const name = `${SKOLEM_PREFIX}${skolemCounter++}`;
      skolems.add(name);
      const orig = varNames.get(v);
      const named = !!orig && !AUTO_TVAR_NAME_RE.test(orig);
      if (named) skolemToName.set(name, orig!);
      subst.set(v, named ? { ...tCon(name), skolemName: orig } as Type : tCon(name));
    } else {
      subst.set(v, tVar(varNames.get(v)));
    }
  }
  return { subst, skolems, skolemToName };
}

/**
 * Generalize a type over all variables not free in the environment.
 *
 * When `subst` is supplied it MUST already have been applied to `type`, and
 * the environment's free variables are resolved through it as well.  This
 * prevents over-generalizing a `const` whose type shares a variable with an
 * enclosing binding that has since been unified (see `freeTypeVars`).
 */
export function generalize(env: TypeEnv, type: Type, subst?: Substitution): Scheme {
  const rawTypeFree = freeTypeVarsInType(type);
  const typeFree = subst ? resolveFreeVarsUnderSubst(rawTypeFree, subst) : rawTypeFree;
  // A type without free variables quantifies nothing: skip the walk over
  // every binding in scope (the expensive half of generalization).
  if (typeFree.size === 0) return { vars: [], type };
  const envFree = env.freeTypeVars(subst);
  const vars: number[] = [];
  for (const v of typeFree) {
    if (!envFree.has(v)) {
      vars.push(v);
    }
  }
  return { vars, type };
}

/**
 * Combine two schemes for the SAME name into a single overloaded scheme.
 *
 * Used when a `.hm` annotation is repeated (e.g. two `Table :: ...` lines)
 * to model "overloaded" / "intersection" function types. The resulting
 * scheme's type is a `Union` of the input branches; call-site unification
 * already supports `Union` and will pick the first branch whose parameter
 * shape matches the actual arguments.
 *
 * Both inputs are first instantiated to fresh type variables so their
 * bound vars never collide. The new scheme quantifies over the union of
 * the freshly-allocated var IDs.
 */
export function mergeOverloadSchemes(a: Scheme, b: Scheme): Scheme {
  const refresh = (s: Scheme): { vars: number[]; type: Type; constraints?: Constraint[] } => {
    const subst = new Substitution();
    const fresh: number[] = [];
    const names = new Map<number, string>();
    collectVarNames(s.type, names);
    // Preserve the disjoint sort of each quantified id: label-var ids must be
    // refreshed as fresh TLabel-vars and row-var ids as fresh TRow-vars.
    // Mapping a label/row id to a plain TVar is a no-op in `Substitution.apply`
    // (it defensively keeps the original label/row node), which would leave the
    // original id FREE in the merged union — unquantified and therefore shared
    // across every call site, breaking per-call freshening of label keys.
    const labelIds = new Set<number>();
    collectLabelVarIds(s.type, labelIds);
    const rowIds = new Set<number>();
    collectRowVarIds(s.type, rowIds);
    for (const id of s.vars) {
      if (labelIds.has(id)) {
        const name = names.get(id);
        const seed = tVar(name);
        subst.set(id, { tag: 'TLabel', kind: 'var', id: seed.id, name: name ?? seed.name });
        fresh.push(seed.id);
        continue;
      }
      if (rowIds.has(id)) {
        const freshRow = tRow(names.get(id));
        subst.set(id, freshRow);
        fresh.push(freshRow.id);
        continue;
      }
      const v = tVar(names.get(id));
      subst.set(id, v);
      fresh.push(v.id);
    }
    // Refresh any types embedded in the branch's constraints so their bound
    // vars track the freshly-allocated ids.  Constraints reference their
    // primary var by NAME (`typeVarName`), which is preserved by `collectVarNames`
    // above, so nominal-class constraints survive unchanged; only the embedded
    // alternative/positional types need remapping.
    //
    // Also record the branch-specific fresh var id (`varId`) for the primary
    // constrained var.  Two overload branches may independently use the same
    // letter (e.g. `Semigroupoid c` in one branch and `Function [b] c` in
    // another); resolving the constraint by NAME at instantiation time would
    // collapse both `c`s onto a single id and mis-attach the constraint to the
    // wrong branch.  Carrying the id makes the attachment branch-precise.
    const nameToId = new Map<string, number>();
    for (const [id, name] of names) {
      if (!nameToId.has(name)) nameToId.set(name, id);
    }
    const constraints = s.constraints?.map(c => {
      const originalId = nameToId.get(c.typeVarName);
      const refreshedVar = originalId !== undefined
        ? subst.apply({ tag: 'TVar', id: originalId, name: c.typeVarName })
        : undefined;
      return {
        ...c,
        varId: refreshedVar && refreshedVar.tag === 'TVar' ? refreshedVar.id : c.varId,
        unionAlternatives: c.unionAlternatives?.map(t => subst.apply(t)),
        positionalArgs: c.positionalArgs?.map(t => subst.apply(t)),
      };
    });
    return { vars: fresh, type: subst.apply(s.type), constraints };
  };

  const ra = refresh(a);
  const rb = refresh(b);

  // If `a` was already a union of overload branches, flatten so we don't
  // build a deeply nested union as more overloads accumulate.
  const aBranches = ra.type.tag === 'TCon' && ra.type.name === 'Union'
    ? ra.type.args
    : [ra.type];
  const bBranches = rb.type.tag === 'TCon' && rb.type.name === 'Union'
    ? rb.type.args
    : [rb.type];

  // Preserve each branch's type-class constraints so a constrained overload
  // (e.g. `Foldable f => … -> f a -> b`) still registers its pending
  // constraint when the merged binding is instantiated.  When the constrained
  // branch is the one selected at a call site, its var binds to the concrete
  // argument type and the constraint is validated; when a different branch is
  // selected, the constrained var stays free and the check is skipped.
  const mergedConstraints = [...(ra.constraints ?? []), ...(rb.constraints ?? [])];

  return {
    vars: [...ra.vars, ...rb.vars],
    type: tUnion([...aBranches, ...bBranches], { overloadSet: true }),
    constraints: mergedConstraints.length > 0 ? mergedConstraints : undefined,
  };
}

// ---------------------------------------------------------------------------
// Default environment with JS built-ins
// ---------------------------------------------------------------------------

/**
 * Build a TypeEnv pre-populated with common JS globals (console, Math,
 * parseInt, Promise, Map, Set, …).  This is the starting environment for
 * every inference run.
 *
 * The result is cached after the first call.  The cached environment is built
 * inside a RESERVED high type-variable ID range ({@link BUILTIN_ENV_VAR_BASE})
 * so its baked-in free vars (e.g. `String :: * -> String`, `Array`) can never
 * collide with the per-run fresh vars allocated from 0 during inference.  This
 * keeps inference deterministic regardless of how many type variables the
 * current file consumes — previously the counter was restored *after*
 * annotation processing, which could move it backwards and alias unrelated
 * variables, producing intermittent spurious unification errors.
 */
let _cachedDefaultEnv: TypeEnv | null = null;

/**
 * High base offset for the type-variable IDs baked into the cached builtin
 * environment.  Per-run inference allocates IDs starting from 0 and is never
 * expected to reach this magnitude, so builtin free vars stay in their own
 * non-overlapping namespace.
 */
const BUILTIN_ENV_VAR_BASE = 1_000_000_000;

/**
 * Invalidate the cached default environment.  Called when settings that
 * shape the global scope change (e.g. `hinmil.dom.globalTypes` toggles the
 * `document`/`window`/… bindings between typed TCons and `Any`).
 */
export function resetDefaultEnvCache(): void {
  _cachedDefaultEnv = null;
}

export function defaultEnv(): TypeEnv {
  if (_cachedDefaultEnv) {
    return _cachedDefaultEnv;
  }

  // Build the builtin environment in a reserved type-variable ID range so its
  // free vars never collide with per-run fresh vars.  Restore the caller's
  // allocator afterwards so normal inference continues from where it was.
  const prevAllocator = setActiveAllocator(new TypeVarAllocator(BUILTIN_ENV_VAR_BASE));
  try {
    return _cachedDefaultEnv = buildDefaultEnv();
  } finally {
    setActiveAllocator(prevAllocator);
  }
}

function buildDefaultEnv(): TypeEnv {
  let env = new TypeEnv();

  // console.log : a -> Undefined
  env = env.extend('console', mono(tCon('Console')));

  // Math.floor etc — simplified
  env = env.extend('Math', mono(tCon('Math')));

  // Built-in functions
  // parseInt (string, radix?) — the radix is optional; a 1-argument call is
  // padded with `Undefined` by the arity check.
  env = env.extend('parseInt', mono(tFun(tTuple([tString, tUnion([tNumber, tUndefined])]), tNumber)));
  env = env.extend('parseFloat', mono(tFun(tString, tNumber)));
  env = env.extend('isNaN', mono(tFun(tNumber, tBool)));

  // Object — like `Date`, the VALUE is the constructor: `Object (v)` /
  // `new Object (v)` wraps a value in an object.  Statics (`Object.keys`, …)
  // still resolve through the MethodRegistry (objectMethods).
  const objArg = tVar('a');
  const objKey = tVar('k');
  const objVal = tVar('b');
  env = env.extend('Object', scheme(
    [objArg.id, objKey.id, objVal.id],
    tFun(tTuple([objArg, tSpread]), tCon('Object', [objKey, objVal])),
  ));

  // Date constructor: `new Date ()`, `new Date (ms | isoString | date)`,
  // `new Date (year, month, …)`.  Previously the VALUE `Date` was typed as
  // the instance type, so `new Date (2020, 0, 1)` was "not callable" and
  // `Date` did not satisfy `TypeRep f` (FP-library `is (Date)`).  Statics
  // (`Date.now`) are unaffected: they resolve through the method registry.
  const dateArg = tVar('a');
  env = env.extend('Date', scheme([dateArg.id], tFun(tTuple([dateArg, tSpread]), tCon('Date'))));
  env = env.extend('TypeError', mono(tFun(tString, tCon('TypeError'))));

  // Promise — constructor TFun; statics (resolve/reject/all/race/…) live
  // in MethodRegistry (promiseMethods).  `new Promise(executor)` typed as
  // executor: ((a -> ()), (e -> ())) -> x returning Promise e a, where `e`
  // is the rejection (error) channel and `a` the resolution value.  The
  // executor's return value is IGNORED at runtime, so it stays a free
  // variable — `new Promise (res => setTimeout (res, ms))` is idiomatic.
  const promVal = tVar('a');
  const promErr = tVar('e');
  const promExecRet = tVar('x');
  env = env.extend('Promise', scheme(
    [promVal.id, promErr.id, promExecRet.id],
    tFun(
      tFun(tTuple([tFun(promVal, tVoid), tFun(promErr, tVoid)]), promExecRet),
      tCon('Promise', [promErr, promVal]),
    ),
  ));

  // Error constructors
  env = env.extend('Error', mono(tFun(tString, tCon('Error'))));
  env = env.extend('RangeError', mono(tFun(tString, tCon('RangeError'))));
  env = env.extend('ReferenceError', mono(tFun(tString, tCon('ReferenceError'))));
  env = env.extend('SyntaxError', mono(tFun(tString, tCon('SyntaxError'))));
  env = env.extend('URIError', mono(tFun(tString, tCon('URIError'))));
  env = env.extend('EvalError', mono(tFun(tString, tCon('EvalError'))));

  // JSON — namespace TCon; statics (parse/stringify) live in
  // MethodRegistry (jsonMethods).
  env = env.extend('JSON', mono(tCon('JSON')));

  // Reflect — namespace TCon; statics live in MethodRegistry (reflectMethods).
  env = env.extend('Reflect', mono(tCon('Reflect')));

  // Browser globals.  With `dom.globalTypes` on (the default) these are
  // TYPED via the compact DOM catalogue in registries/domGlobals.ts —
  // members complete, hover and get argument checking, while anything not
  // catalogued silently resolves to `Any` (open-world fallback).  With the
  // setting off they revert to plain `Any` (kill switch for projects that
  // define their own `Element`/`Document` types).  Either way, projects can
  // shadow these names via `globals.hm`.
  if (isDomGlobalTypesEnabled()) {
    env = env.extend('document', mono(tCon('Document')));
    env = env.extend('window', mono(tCon('Window')));
    env = env.extend('navigator', mono(tCon('Navigator')));
    env = env.extend('localStorage', mono(tCon('Storage')));
    env = env.extend('sessionStorage', mono(tCon('Storage')));
  } else {
    env = env.extend('document', mono(tAny));
    env = env.extend('window', mono(tAny));
    env = env.extend('navigator', mono(tAny));
    env = env.extend('localStorage', mono(tAny));
    env = env.extend('sessionStorage', mono(tAny));
  }

  // Timers — universal across browsers and Node, independent of
  // `dom.globalTypes`.  The returned handle is an opaque TCon consumed only
  // by the matching clear* function (Node returns a Timeout object, browsers
  // a Number — the opaque type hides that split).  The callback's return
  // value is ignored at runtime, so it stays a free variable.  The delay is
  // optional (defaults to 0): `setTimeout (() => res (value))`.
  const timeoutRet = tVar('a');
  env = env.extend('setTimeout', scheme(
    [timeoutRet.id],
    tFun(tTuple([tFun(tVoid, timeoutRet), tUnion([tNumber, tUndefined])]), tCon('TimeoutId')),
  ));
  env = env.extend('clearTimeout', mono(tFun(tCon('TimeoutId'), tVoid)));
  const intervalRet = tVar('a');
  env = env.extend('setInterval', scheme(
    [intervalRet.id],
    tFun(tTuple([tFun(tVoid, intervalRet), tUnion([tNumber, tUndefined])]), tCon('IntervalId')),
  ));
  env = env.extend('clearInterval', mono(tFun(tCon('IntervalId'), tVoid)));

  // Fetch API — always available (browser, node ≥18, workers), independent
  // of `dom.globalTypes`.  Loose in its arguments (URL string, Request or
  // URL object; optional init), typed in its return: `Promise e Response`.
  const fetchUrl = tVar('u');
  const fetchOpts = tVar('o');
  const fetchErr = tVar('e');
  env = env.extend('fetch', scheme(
    [fetchUrl.id, fetchOpts.id, fetchErr.id],
    tFun(
      tTuple([fetchUrl, tUnion([fetchOpts, tUndefined])]),
      tCon('Promise', [fetchErr, tCon('Response')]),
    ),
  ));

  // `AbortSignal` (the value): its static factories, e.g.
  // `fetch (url, { signal: AbortSignal.timeout (5000) })`.  The instance type
  // `AbortSignal` lives in the Fetch catalogue (domGlobals.ts).
  env = env.extend('AbortSignal', mono(tCon('AbortSignalStatics')));

  // `new AbortController ()` (WHATWG DOM, a Node and browser global): its
  // `signal` goes into `fetch`, `abort ()` cancels.
  env = env.extend('AbortController', mono(tFun(tVoid, tCon('AbortController'))));

  // `new URLSearchParams (init)` — init is a query string, a record of
  // strings or a list of pairs; loose in its argument, typed in its result.
  const uspInit = tVar('a');
  env = env.extend('URLSearchParams', scheme(
    [uspInit.id],
    tFun(tUnion([uspInit, tUndefined]), tCon('URLSearchParams')),
  ));

  // `new URL (input, base?)` (WHATWG URL, a Node and browser global).
  // Without a binding `URL` was an unbound variable.
  env = env.extend('URL', mono(tFun(
    tTuple([tString, tUnion([tString, tCon('URL'), tUndefined])]),
    tCon('URL'),
  )));

  // Conversion functions — polymorphic in their argument so each call site
  // instantiates a FRESH parameter variable.  A `mono` scheme would share one
  // cached type variable across the whole program, so two calls like
  // `String(nullVal)` then `String(undefinedVal)` would pin the param to `Null`
  // and then fail to unify with `Undefined`.
  const strArg = tVar();
  env = env.extend('String', scheme([strArg.id], tFun(strArg, tString)));
  const numArg = tVar();
  env = env.extend('Number', scheme([numArg.id], tFun(numArg, tNumber)));
  const boolArg = tVar();
  env = env.extend('Boolean', scheme([boolArg.id], tFun(boolArg, tBool)));

  // Bare `Object.prototype.toString` exposed as a global identifier — the
  // `toString.call(value)` idiom (used by isObject-style predicates) references
  // it without a receiver.  Typed as a function so `.call`/`.apply` (Function
  // methods) resolve on it.
  env = env.extend('toString', mono(tFun(tVoid, tString)));

  // Array constructor / TypeRep witness — polymorphic so each reference
  // instantiates FRESH variables.  A `mono` scheme (as `String`/`Number`
  // above once were) shares one cached element variable across the whole
  // program, so `const t = of (Array)` could not generalize and a later
  // `of (Array) (1)` would retro-pin `t` to `Number -> [Number]`.
  const arrParam = tVar();
  const arrElem = tVar();
  env = env.extend('Array', scheme([arrParam.id, arrElem.id], tFun(arrParam, tArray(arrElem))));

  // RegExp constructor: `new RegExp (pattern, flags?)` / `RegExp (pattern)`.
  // Without a binding the identifier fell back to the `TypeRep RegExp`
  // witness, which is not callable.  A TFun still satisfies `TypeRep f`
  // (unifyTypeRep reads the constructor off the return type).
  env = env.extend('RegExp', mono(tFun(
    tTuple([tUnion([tString, tCon('RegExp')]), tUnion([tString, tUndefined])]),
    tCon('RegExp'),
  )));
  env = env.extend('Symbol', mono(tFun(tString, tCon('Symbol'))));
  const bigIntArg = tVar();
  env = env.extend('BigInt', scheme([bigIntArg.id], tFun(bigIntArg, tCon('BigInt'))));
  // `globalThis` is the global object: any property may be read or set
  // (`globalThis.ResizeObserver = globalThis.ResizeObserver || Stub`).
  env = env.extend('globalThis', mono(tAnyType));

  // Map/Set/WeakMap/WeakSet constructors: `new Set ()` and `new Set (xs)`.
  // These were bound to the instance type itself (`Set a`), which only worked
  // without arguments: `new Set ([1, 2])` reported "Type 'Set a' is not
  // callable".  Like RegExp above, a TFun still satisfies `TypeRep f`.  The
  // optional initial value is an array (or another collection); Map entries
  // stay loose (`[[e]]`), as for Object.fromEntries.
  const mapK = tVar('k');
  const mapV = tVar('v');
  const mapE = tVar('e');
  env = env.extend('Map', scheme(
    [mapK.id, mapV.id, mapE.id],
    tFun(tUnion([tArray(tArray(mapE)), tCon('Map', [mapK, mapV]), tUndefined]), tCon('Map', [mapK, mapV])),
  ));

  const setA = tVar('a');
  env = env.extend('Set', scheme(
    [setA.id],
    tFun(tUnion([tArray(setA), tCon('Set', [setA]), tUndefined]), tCon('Set', [setA])),
  ));

  const wmK = tVar('k');
  const wmV = tVar('v');
  const wmE = tVar('e');
  env = env.extend('WeakMap', scheme(
    [wmK.id, wmV.id, wmE.id],
    tFun(tUnion([tArray(tArray(wmE)), tUndefined]), tCon('WeakMap', [wmK, wmV])),
  ));

  const wsA = tVar('a');
  env = env.extend('WeakSet', scheme(
    [wsA.id],
    tFun(tUnion([tArray(wsA), tUndefined]), tCon('WeakSet', [wsA])),
  ));

  // -------------------------------------------------------------------------
  // Node.js globals (Plan v6.4 Werkstroom 5)
  // -------------------------------------------------------------------------

  // process — singleton TCon('Process'); properties/methods live in
  // MethodRegistry (processMethods).
  env = env.extend('process', mono(tCon('Process')));
  env = env.extend('performance', mono(tCon('Performance')));
  // Intl — ECMA-402 namespace (formatters in methodRegistry `intlMethods`).
  env = env.extend('Intl', mono(tCon('Intl')));

  // Standard (ECMAScript) global functions missing so far.
  // eval :: String -> a — the result is unknowable; a fresh var per use.
  const evalRet = tVar('a');
  env = env.extend('eval', scheme([evalRet.id], tFun(tString, evalRet)));
  // structuredClone :: a -> a
  const cloneArg = tVar('a');
  env = env.extend('structuredClone', scheme([cloneArg.id], tFun(cloneArg, cloneArg)));
  for (const uriFn of ['encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI']) {
    env = env.extend(uriFn, mono(tFun(tString, tString)));
  }
  // Global isFinite coerces its argument (unlike Number.isFinite).
  const finiteArg = tVar('a');
  env = env.extend('isFinite', scheme([finiteArg.id], tFun(finiteArg, tBool)));

  // Buffer — namespace TCon for statics (from/alloc/isBuffer/concat/…);
  // statics live in MethodRegistry (bufferMethods, isStatic: true).
  env = env.extend('Buffer', mono(tCon('Buffer')));

  // Typed-array views + binary buffers — constructors are arity-0; `new
  // Uint8Array(len)` / `new ArrayBuffer(len)` accept a length (or source) and
  // return the view.  Statics (of/from/isView) live in MethodRegistry.
  for (const taName of [
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
    'BigInt64Array', 'BigUint64Array', 'ArrayBuffer', 'DataView',
  ]) {
    const taArg = tVar();
    env = env.extend(taName, scheme([taArg.id], tFun(taArg, tCon(taName))));
  }

  // CommonJS file/dir constants
  env = env.extend('__dirname', mono(tString));
  env = env.extend('__filename', mono(tString));
  // `module` and `exports` as values (`Object.defineProperty (exports,
  // "__esModule", …)` in compiled CommonJS).  Their content is the module's
  // own exports, so `Any`; `module.exports = …` and `exports.x = …` keep
  // their syntactic handling as export sites.
  env = env.extend('module', mono(tAnyType));
  env = env.extend('exports', mono(tAnyType));

  // Global object — loosely typed for compatibility
  env = env.extend('global', mono(tCon('Object')));

  // Microtask / immediate scheduling
  env = env.extend('setImmediate',
    mono(tFun(tFun(tVoid, tVoid), tCon('Object'))));
  env = env.extend('clearImmediate',
    mono(tFun(tCon('Object'), tVoid)));
  env = env.extend('queueMicrotask',
    mono(tFun(tFun(tVoid, tVoid), tVoid)));

  return env;
}
