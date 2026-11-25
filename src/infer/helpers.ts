// ============================================================================
// Inference Engine — Module-level helper functions
//
// Plain language: small utilities shared across the inference modules.  The
// star of this file is *speculative inference*: sometimes the engine must
// TRY something that may fail — e.g. "does this argument fit overload #1?"
// — without leaving half-finished answers behind if it doesn't.  `speculate`
// runs a trial and always rolls the shared state back afterwards (like
// sketching in pencil and erasing); `tryCommit` keeps the result only when
// the trial succeeds.
// ============================================================================

import { Type, AstNode, tVar, tRecord } from '../hm/types';
import { Scheme } from '../hm/types';
import { instantiate } from '../hm/env';
import { getDataType, getParentTypeName } from '../registries/dataTypeRegistry';
import { tNamedWildcard, isWildcard, mono } from '../hm/types';
import { Substitution } from '../hm/substitution';
import { InferenceDiagnostic } from './types';

// ---------------------------------------------------------------------------
// Speculative inference — snapshot/rollback of substitution + diagnostics
// ---------------------------------------------------------------------------

/** The mutable engine state that speculative trials must snapshot. */
export interface SpeculativeState {
  subst: Substitution;
  diagnostics: InferenceDiagnostic[];
  /** When present (the engine itself is usually passed as the state),
   *  speculative trials also roll back pending type-class constraints
   *  appended during the trial.  Without this, every speculative overload
   *  branch leaks its instantiated constraints permanently — nested
   *  overloaded calls then grow the list multiplicatively and every
   *  subsequent constraint scan slows down (exponential blowup on e.g.
   *  `ap (ap (ap (map f x) y) z) …`). */
  pendingConstraints?: unknown[];
}

/**
 * Run `fn` as a speculative trial: the substitution and the diagnostics list
 * are ALWAYS rolled back afterwards, whether `fn` returns or throws.  When
 * `fn` throws, `onThrow` is returned instead.  Mutations of variables outside
 * the engine state (e.g. collecting ids into a Set) survive the rollback.
 */
export function speculate<T>(state: SpeculativeState, fn: () => T): T | undefined;
export function speculate<T, F>(state: SpeculativeState, fn: () => T, onThrow: F): T | F;
export function speculate<T, F>(state: SpeculativeState, fn: () => T, onThrow?: F): T | F | undefined {
  const snap = state.subst.snapshot();
  const diagsBefore = state.diagnostics.length;
  const pendingBefore = state.pendingConstraints?.length ?? 0;
  try {
    return fn();
  } catch {
    return onThrow;
  } finally {
    state.subst.restore(snap);
    state.diagnostics.length = diagsBefore;
    if (state.pendingConstraints) state.pendingConstraints.length = pendingBefore;
  }
}

/**
 * Commit-or-rollback: run `fn` and keep its effects on success; on throw,
 * roll back the substitution and diagnostics and return `undefined`.
 */
export function tryCommit<T>(state: SpeculativeState, fn: () => T): T | undefined {
  const snap = state.subst.snapshot();
  const diagsBefore = state.diagnostics.length;
  const pendingBefore = state.pendingConstraints?.length ?? 0;
  try {
    return fn();
  } catch {
    state.subst.restore(snap);
    state.diagnostics.length = diagsBefore;
    if (state.pendingConstraints) state.pendingConstraints.length = pendingBefore;
    return undefined;
  }
}

/**
 * Best-effort run: exceptions are swallowed and any diagnostics `fn` adds
 * are discarded.  The substitution is NOT rolled back — used for re-inference
 * passes whose type bindings should stick but whose errors should not.
 */
export function bestEffort(state: Pick<SpeculativeState, 'diagnostics'>, fn: () => void): void {
  const diagsBefore = state.diagnostics.length;
  try {
    fn();
  } catch { /* best-effort */ }
  state.diagnostics.length = diagsBefore;
}

/** Create an array of `n` fresh type variables. */
export function freshVars(n: number): Type[] {
  const vars: Type[] = [];
  for (let i = 0; i < n; i++) vars.push(tVar());
  return vars;
}

/**
 * Compute the rest type for `const { a, ...rest } = obj` patterns.
 * If the source is a TRecord, the rest type excludes the destructured keys.
 * Otherwise returns a fresh type variable.
 */
export function computeRestType(
  resolved: Type,
  properties: AstNode[],
): Type {
  if (resolved.tag === 'TRecord') {
    const destructuredKeys = new Set<string>();
    for (const p of properties) {
      if (p.type === 'Property' && p.key?.type === 'Identifier') {
        destructuredKeys.add(p.key.name as string);
      }
    }
    const restFields: Record<string, Type> = {};
    for (const k in resolved.fields) {
      if (!destructuredKeys.has(k)) restFields[k] = resolved.fields[k];
    }
    return tRecord(restFields);
  }
  return tVar();
}

/** Find the constructor MethodDefinition in a class body. */
export function findConstructor(classBody: AstNode[]): AstNode | undefined {
  return classBody.find((m: AstNode) =>
    m.type === 'MethodDefinition' && m.kind === 'constructor'
  );
}

/** Convert a map of exported schemes to an instantiated TRecord (the value
 *  of `import * as ns`).  Each field keeps its scheme in `fieldSchemes`, so
 *  every `ns.f` is instantiated afresh, as a named import would be: without
 *  it, `ns.identity (1)` fixed the type of a later `ns.identity ("x")`. */
export function exportsToRecord(exports: Map<string, Scheme>): Type {
  const fields: Record<string, Type> = {};
  const fieldSchemes: Record<string, Scheme> = {};
  for (const [name, s] of exports) {
    fields[name] = instantiate(s);
    fieldSchemes[name] = s;
  }
  const record = tRecord(fields);
  record.fieldSchemes = fieldSchemes;
  return record;
}

/**
 * Build a Scheme for a value (typically `this` or a narrowed variable) whose
 * runtime type is known to be a specific sumtype variant.
 *
 * If the variant declaration omits some of the parent type's type variables
 * (i.e. they are *phantom* for this variant — e.g. `Left e` does not carry
 * the `a` from `Either e a`), substitute the corresponding type-arg slots
 * of `thisType` with named wildcards.  Wildcards unify with anything without
 * producing a binding, so expressions like `return this` / `return f` in a
 * phantom-only branch don't pin the surrounding annotation TVars.
 *
 * The wildcards are inserted in the slot itself, regardless of whether that
 * slot is a TVar or a more complex type (e.g. `Either e (a -> b)` for the
 * second slot of Left).  Carried slots are left untouched so that field
 * accesses on the value preserve their proper types.
 *
 * Returns null if `typeName` is not a registered variant or `thisType`
 * doesn't match the parent type's shape, in which case callers should fall
 * back to a monomorphic scheme of `thisType` itself.
 */
export function variantThisScheme(typeName: string, thisType: Type): Scheme | null {
  const parentName = getParentTypeName(typeName);
  if (!parentName) return null;
  const parent = getDataType(parentName);
  if (!parent) return null;
  const variant = parent.variantMap.get(typeName);
  if (!variant) return null;
  if (thisType.tag !== 'TCon' || thisType.name !== parentName) return null;
  if (thisType.args.length !== parent.decl.typeVars.length) return null;

  const carriedFields = new Set(variant.fields);
  let changed = false;
  const newArgs: Type[] = thisType.args.map((arg, i) => {
    const tv = parent.decl.typeVars[i];
    if (carriedFields.has(tv)) return arg;
    changed = true;
    // Replace phantom slots with a wildcard so `return this`/`return f` in a
    // phantom-only branch never pins the surrounding annotation vars (and
    // never builds an infinite type when the slot held a complex type).
    //
    // If the slot ALREADY holds a wildcard (e.g. the parameter came in with a
    // trusted annotation `Either a b`, instantiated permissively to
    // `Either *:a *:b`), keep that wildcard verbatim: it already unifies with
    // anything *and* already carries the slot's own display name (`b`).
    // Renaming it to the parent declaration's variable (`a`) is what used to
    // collapse `Either a b` into a misleading `Either a a` on hover.
    if (isWildcard(arg)) return arg;
    // Otherwise wildcard the slot, naming it after the variable that occupied
    // it where possible so hover stays faithful to the annotation.
    const slotName = arg.tag === 'TVar' && arg.name ? arg.name
      : arg.tag === 'TCon' && arg.skolemName ? arg.skolemName
      : tv;
    return tNamedWildcard(slotName);
  });
  if (!changed) return null;
  return mono({ tag: 'TCon', name: thisType.name, args: newArgs });
}
