// ============================================================================
// Substitution — mapping from type-variable ids to types
//
// WHAT THIS FILE DOES (in plain language)
// ---------------------------------------------------------------------------
// While the puzzle solver (unify.ts) works, it learns answers like
// "placeholder #12 must be Number".  A Substitution is the growing answer
// sheet holding all of those: a table from placeholder id to type.
//
// The two important operations:
//   • apply(t)      — rewrite type `t`, replacing every placeholder that has
//                     an answer with that answer (chasing chains: if #12 = #14
//                     and #14 = Number, then #12 becomes Number).
//   • compose(other) — combine two answer sheets into one, so the answers of
//                     a later unification step are merged with earlier ones.
//
// apply() also performs a handful of deferred rewrites that could not be
// finished during unification itself (row splicing into records, kv-name
// resolution, merge-row deep merging) — see the inline comments below.
// ============================================================================

import { Type, TCon, TRecord, tUnion, tCon, typeToString, parseKvName, kvName, T_UNION, T_FUNCTION, T_ARRAY, deepMergeTypes } from './types';
import { isUnionable, mergeUnion } from './typeUtils';
import { getDataType } from '../registries/dataTypeRegistry';

export class Substitution {
  private map: Map<number, Type>;
  /** Records currently being substituted on this call stack (cycle guard). */
  private recordsInProgress = new Set<TRecord>();

  constructor(entries?: Iterable<[number, Type]>) {
    this.map = new Map(entries);
  }

  /** Create a substitution with a single binding. */
  static singleton(id: number, type: Type): Substitution {
    const s = new Substitution();
    s.map.set(id, type);
    return s;
  }

  /** Look up a type variable id. */
  lookup(id: number): Type | undefined {
    return this.map.get(id);
  }

  /** Extend the substitution with a new binding. */
  set(id: number, type: Type): void {
    this.map.set(id, type);
  }

  /** Number of bindings. */
  get size(): number {
    return this.map.size;
  }

  /** Apply this substitution to a type, recursively resolving variables. */
  apply(t: Type, _visited?: Set<number>): Type {
    // Fast path: an empty substitution can never change anything.
    if (this.map.size === 0) return t;
    switch (t.tag) {
      case 'TVar': {
        const resolved = this.map.get(t.id);
        if (resolved) {
          // Guard against self-referencing substitutions
          if (resolved.tag === 'TVar' && resolved.id === t.id) {
            return t;
          }
          // Guard against indirect TVar cycles
          const visited = _visited ?? new Set<number>();
          if (visited.has(t.id)) return t;
          visited.add(t.id);
          // Chase the substitution chain
          return this.apply(resolved, visited);
        }
        return t;
      }
      case 'TCon': {
        // Short-circuit: ground types (zero args, no kv) have nothing to substitute
        const kv = parseKvName(t.name);
        if (t.args.length === 0 && !kv) return t;

        let name = t.name;
        // Resolve kind-variable TCon names through substitution
        let extraArgs: Type[] = [];
        if (kv) {
          const resolved = this.map.get(kv.varId);
          if (resolved) {
            // Guard against cycles through kind-variable resolution
            const visited = _visited ?? new Set<number>();
            if (visited.has(kv.varId)) return t;
            visited.add(kv.varId);
            // Chase the chain
            const final = this.apply(resolved, visited);
            if (final.tag === 'TCon') {
              // Kind/arity guard: a kv var that resolves to a registered
              // data type must produce a saturated TCon (`extraArgs +
              // t.args` covers all declared type parameters).  If we'd
              // produce an under-saturated TCon (e.g. bare `m` resolved
              // to `Either e` → unary `Either`), keep the kv form so
              // downstream rendering shows `m` rather than a malformed
              // type.  This protects against partial-application
              // leakage when intermediate unification left a bare kv.
              const decl = getDataType(final.name);
              if (decl) {
                const declaredArity = decl.decl.typeVars.length;
                if (final.args.length + t.args.length < declaredArity) {
                  return t;
                }
              }
              name = final.name;
              // Include args from partially applied constructors
              // (e.g. kv bound to `RTask r e` → extraArgs = [r, e]).
              // EXCEPT when the binding is itself a kv *application*
              // (`$kv:f(a)` — e.g. a pinned `TypeRep (f a)` param that bound
              // a callee's bare rep var): its args are one particular
              // APPLICATION of the constructor, not part of the
              // constructor's identity.  Absorbing them would double the
              // arity at every other usage site (`f c` → ill-kinded `f a c`).
              extraArgs = parseKvName(final.name) && t.args.length > 0 ? [] : final.args;
              // Over-saturation guard (mirror of the under-saturation check
              // above): a kv var bound to one SATURATED application
              // (`m := Either e a`, e.g. from a sumtype rep typed
              // `TypeRep (Either e a)`) that is RE-applied at a usage site
              // (`m c`) would otherwise produce the ill-kinded
              // `Either e a c`.  The binding's trailing type-VARIABLE args
              // are one particular element application — not part of the
              // constructor's identity — so drop them until the declared
              // arity fits.  Concrete trailing args are kept (and surface
              // a genuine arity error).  Bare usages (`m`, no args) keep
              // the full saturated binding.
              if (decl && t.args.length > 0) {
                const declaredArity = decl.decl.typeVars.length;
                while (extraArgs.length > 0
                    && extraArgs.length + t.args.length > declaredArity
                    && extraArgs[extraArgs.length - 1].tag === 'TVar') {
                  extraArgs = extraArgs.slice(0, -1);
                }
              }
            } else if (final.tag === 'TVar') {
              // When the kv var maps to another TVar, rename the kv to
              // track the new id so constraint lookups use the correct entry.
              name = kvName(kv.varName, final.id);
            }
          }
        }
        let newArgs = [...extraArgs, ...t.args.map((a) => this.apply(a, _visited))];
        // A kind variable bound to the bare `Function` constructor and applied
        // to two arguments is a function used as a binary constructor
        // (Profunctor, see unify): `p b c` is `Function [b] c`.
        if (kv && name === T_FUNCTION && extraArgs.length === 0 && t.args.length === 2) {
          newArgs = [tCon(T_ARRAY, [newArgs[0]]), newArgs[1]];
        }
        if (name === T_UNION) {
          // Nothing substituted: the union is returned as is.  Rebuilding it
          // re-sorts the members by their rendered text, the single largest
          // cost of `apply` on real projects.
          if (extraArgs.length === 0 && newArgs.length === t.args.length
              && newArgs.every((a, i) => a === t.args[i])) {
            return t;
          }
          return tUnion(newArgs, { overloadSet: t.overloadSet });
        }
        // Structural sharing: return original if nothing changed
        if (name === t.name && extraArgs.length === 0 &&
            newArgs.length === t.args.length &&
            newArgs.every((a, i) => a === t.args[i])) {
          return t;
        }
        const out: TCon = { tag: 'TCon', name, args: newArgs };
        // Preserve any display-only `paramHint` attached at call-site
        // post-processing (see `bindParamSlot` in `src/infer/calls.ts`).
        // Recursively apply the substitution so e.g. record-field types
        // inside the hint are kept up to date.
        if (t.paramHint) out.paramHint = this.apply(t.paramHint, _visited);
        // Preserve the strict-empty-array marker (`[]` in an annotation).
        if (t.strictEmpty) out.strictEmpty = t.strictEmpty;
        if (t.optionalFrom !== undefined) out.optionalFrom = t.optionalFrom;
        return out;
      }
      case 'TFun': {
        const newParam = this.apply(t.param, _visited);
        const newResult = this.apply(t.result, _visited);
        if (newParam === t.param && newResult === t.result) return t;
        return { tag: 'TFun', param: newParam, result: newResult };
      }
      case 'TRecord': {
        // Record types can participate in genuine object-reference cycles:
        // assigning a constructor function onto a namespace record (e.g.
        // `Ns.Make = (...) => Object.create(proto)` where `proto.constructor`
        // points back at `Ns`) mutates the type graph into a loop.  The TVar
        // `visited` guard above cannot see such cycles, so also guard on
        // object identity: re-entering a record that is already being
        // substituted on this call stack returns it unchanged, preserving
        // the cycle instead of recursing forever.
        if (this.recordsInProgress.has(t)) return t;
        this.recordsInProgress.add(t);
        try {
        const fields: Record<string, Type> = {};
        const src = t.fields;
        for (const k in src) {
          fields[k] = this.apply(src[k], _visited);
        }

        // Resolve label-keyed fields: when a label var resolves to a
        // literal, the entry migrates to the string-keyed `fields` map.
        // Entries whose label is still a variable stay in `labelFields`.
        let labelFields: Array<{ label: import('./types').TLabel; type: Type }> | undefined;
        if (t.labelFields && t.labelFields.length > 0) {
          // Track which string keys were materialised *by this label pass* so
          // that a later label resolving to the same key deep-merges with the
          // earlier label's value (e.g. `{ [k]::[String] }` ⊕ `{ [k]::[Number] }`
          // → `[String | Number]`) instead of first-wins dropping the second.
          // A collision with an *original* concrete field still keeps the
          // concrete value (caller-provided beats label-polymorphic placeholder).
          const fromLabel = new Set<string>();
          for (const lf of t.labelFields) {
            const lbl = this.apply(lf.label, _visited);
            const ty = this.apply(lf.type, _visited);
            if (lbl.tag === 'TLabel' && lbl.kind === 'lit') {
              if (!(lbl.value in fields)) {
                fields[lbl.value] = ty;
                fromLabel.add(lbl.value);
              } else if (fromLabel.has(lbl.value)) {
                fields[lbl.value] = deepMergeTypes(fields[lbl.value], ty);
              }
              // else: collides with an original concrete field → concrete wins.
            } else if (lbl.tag === 'TLabel') {
              if (!labelFields) labelFields = [];
              labelFields.push({ label: lbl, type: ty });
            }
          }
        }

        if (!t.rest) {
          // Structural sharing: closed record with no label resolution and
          // no changed field types → return the original.
          if (!labelFields && !(t.labelFields && t.labelFields.length > 0)) {
            let unchanged = true;
            for (const k in src) {
              if (fields[k] !== src[k]) { unchanged = false; break; }
            }
            if (unchanged) return t;
          }
          const out: TRecord = { tag: 'TRecord', fields };
          if (t.alias) out.alias = t.alias;
          if (t.strictEmpty) out.strictEmpty = t.strictEmpty;
          if (t.pickedFrom) out.pickedFrom = t.pickedFrom;
          if (t.defaultProjection) out.defaultProjection = true;
          if (t.fieldSchemes) out.fieldSchemes = t.fieldSchemes;
          if (t.fieldDisplays) out.fieldDisplays = t.fieldDisplays;
          if (t.hiddenFields) out.hiddenFields = t.hiddenFields;
          if (labelFields) out.labelFields = labelFields;
          return out;
        }
        // Open record: substitute the row variable.  The row may resolve
        // to another record (whose fields get spliced in alongside its
        // own row), or remain a TVar (still open), or be bound to a
        // TCon like Object/StrMap (treated as a closed tail).
        const restApplied = this.apply(t.rest, _visited);
        if (restApplied.tag === 'TVar' || restApplied.tag === 'TRow') {
          const same = restApplied === t.rest;
          if (same && !labelFields) {
            // No change at all → return original to preserve referential equality.
            const unchangedFields = Object.keys(fields).every(k => fields[k] === src[k]);
            const sameLabelCount = (t.labelFields?.length ?? 0) === 0;
            if (unchangedFields && sameLabelCount) return t;
          }
          const out: TRecord = { tag: 'TRecord', fields, rest: restApplied };
          if (t.alias) out.alias = t.alias;
          if (t.pickedFrom) out.pickedFrom = t.pickedFrom;
          if (t.defaultProjection) out.defaultProjection = true;
          if (t.fieldSchemes) out.fieldSchemes = t.fieldSchemes;
          if (t.fieldDisplays) out.fieldDisplays = t.fieldDisplays;
          if (t.hiddenFields) out.hiddenFields = t.hiddenFields;
          if (t.mergeRow) out.mergeRow = t.mergeRow;
          if (labelFields) out.labelFields = labelFields;
          return out;
        }
        if (restApplied.tag === 'TRecord') {
          // Splice: combine our fields with the inner record's fields,
          // and adopt its row variable (if any).  Conflicting keys keep
          // *our* binding — it represents the more constrained side — UNLESS
          // this row was flagged `mergeRow` (a label-group spread-merge such
          // as `({ [k]::a }, {...b}) -> { [k]::a, ...b }`), in which case
          // overlapping keys are DEEP-merged so the two contributions combine
          // (`likedTypes::[String]` ⊕ `likedTypes::[Number]` → `[String | Number]`).
          const merged: Record<string, Type> = { ...restApplied.fields };
          for (const k of Object.keys(fields)) {
            merged[k] = (t.mergeRow && k in merged)
              ? deepMergeTypes(merged[k], fields[k])
              : fields[k];
          }
          const mergedLabels = [
            ...(restApplied.labelFields ?? []),
            ...(labelFields ?? []),
          ];
          const out: TRecord = { tag: 'TRecord', fields: merged };
          if (restApplied.rest) {
            out.rest = restApplied.rest;
            // Keep deep-merging if the spliced tail is itself still open.
            if (t.mergeRow) out.mergeRow = true;
          }
          if (t.alias) out.alias = t.alias;
          if (t.pickedFrom) out.pickedFrom = t.pickedFrom;
          if (t.defaultProjection) out.defaultProjection = true;
          if (t.fieldSchemes || restApplied.fieldSchemes) {
            out.fieldSchemes = { ...(restApplied.fieldSchemes ?? {}), ...(t.fieldSchemes ?? {}) };
          }
          if (t.fieldDisplays || restApplied.fieldDisplays) {
            out.fieldDisplays = { ...(restApplied.fieldDisplays ?? {}), ...(t.fieldDisplays ?? {}) };
          }
          if (t.hiddenFields || restApplied.hiddenFields) {
            out.hiddenFields = new Set([
              ...(restApplied.hiddenFields ?? []),
              ...(t.hiddenFields ?? []),
            ]);
          }
          if (mergedLabels.length > 0) out.labelFields = mergedLabels;
          return out;
        }
        // TCon (e.g. Object) or TFun in row position: just close the row.
        const closed: TRecord = { tag: 'TRecord', fields };
        if (t.alias) closed.alias = t.alias;
        if (t.pickedFrom) closed.pickedFrom = t.pickedFrom;
        if (t.defaultProjection) closed.defaultProjection = true;
        if (t.fieldSchemes) closed.fieldSchemes = t.fieldSchemes;
        if (t.fieldDisplays) closed.fieldDisplays = t.fieldDisplays;
        if (t.hiddenFields) closed.hiddenFields = t.hiddenFields;
        if (labelFields) closed.labelFields = labelFields;
        return closed;
        } finally {
          this.recordsInProgress.delete(t);
        }
      }
      case 'TLabel': {
        if (t.kind === 'lit') return t;
        const resolved = this.map.get(t.id);
        if (!resolved) return t;
        if (resolved.tag === 'TLabel') {
          if (resolved.kind === 'lit') return resolved;
          // Chase label-var chain
          if (resolved.kind === 'var' && resolved.id === t.id) return t;
          const visited = _visited ?? new Set<number>();
          if (visited.has(t.id)) return t;
          visited.add(t.id);
          return this.apply(resolved, visited);
        }
        // Defensive: a non-label value bound to a label var → keep the label.
        return t;
      }
      case 'TRow': {
        // Row variables share the TVar id space; if a row binding exists,
        // follow the chain.  A row can resolve to another row, or to a
        // TRecord (carrying its own fields/rest), or remain free.
        const resolved = this.map.get(t.id);
        if (!resolved) return t;
        if (resolved.tag === 'TRow' && resolved.id === t.id) return t;
        const visited = _visited ?? new Set<number>();
        if (visited.has(t.id)) return t;
        visited.add(t.id);
        return this.apply(resolved, visited);
      }
      case 'TForall': {
        // Bound vars are globally fresh and never unified, so they can never
        // appear in the substitution — applying to the body only touches the
        // FREE (outer) variables occurring under the quantifier.
        const newBody = this.apply(t.body, _visited);
        if (newBody === t.body) return t;
        return { ...t, body: newBody };
      }
    }
  }

  /** Compose: apply `other` first, then `this`.
   *
   *  Uses lazy composition — TVar references in `other`'s entries are kept
   *  as-is instead of being eagerly resolved.  This allows retroactive
   *  updates to TVar bindings (e.g. auto-union) to propagate through all
   *  entries that still reference the updated TVar.  The `apply()` method
   *  follows chains dynamically, so the end result is identical.
   */
  compose(other: Substitution): Substitution {
    const result = new Substitution();
    // Keep other's mappings as-is (lazy — apply() chases chains on demand)
    for (const [id, type] of other.map) {
      result.map.set(id, type);
    }
    // Add our own mappings (these take precedence for ids not in other)
    for (const [id, type] of this.map) {
      if (!result.map.has(id)) {
        result.map.set(id, type);
      }
    }
    return result;
  }

  /**
   * In-place merge: absorb bindings from a (typically small) delta
   * substitution into this (typically large) substitution.
   *
   * Equivalent to `this = delta.compose(this)` but avoids copying the
   * entire map.  Only the new ids from `delta` are inserted.
   *
   * This is the hot-path optimisation for `unifyWithDiagnostic`: `unify`
   * returns a small delta (1-3 entries) while the engine substitution
   * can have hundreds of entries — copying all of them on every unify
   * call is unnecessary.
   */
  mergeFrom(delta: Substitution): void {
    for (const [id, type] of delta.map) {
      if (!this.map.has(id)) {
        this.map.set(id, type);
      }
    }
  }

  /** Get all entries. */
  entries(): IterableIterator<[number, Type]> {
    return this.map.entries();
  }

  toString(): string {
    const parts: string[] = [];
    for (const [id, type] of this.map) {
      parts.push(`t${id} => ${typeToString(type)}`);
    }
    return `{ ${parts.join(', ')} }`;
  }

  // -------------------------------------------------------------------------
  // Branch-isolated substitution helpers
  // -------------------------------------------------------------------------

  /** Snapshot the current substitution state (shallow copy of all bindings). */
  snapshot(): Map<number, Type> {
    return new Map(this.map);
  }

  /** Restore substitution to a previous snapshot, removing any bindings added since. */
  restore(snap: Map<number, Type>): void {
    this.map = new Map(snap);
  }

  /** Return bindings added or changed since the snapshot. */
  diff(snap: Map<number, Type>): Map<number, Type> {
    const diff = new Map<number, Type>();
    for (const [id, t] of this.map) {
      const old = snap.get(id);
      if (!old || old !== t) {
        // Skip TVar→TVar bindings: they represent "same type as"
        // relationships within a branch's context.  Carrying them across
        // branches would cause unrelated concrete constraints (e.g.
        // res("foemp") constraining a to String) to propagate backwards
        // through the TVar chain to variables that should stay free
        // (e.g. e.leader).
        if (t.tag === 'TVar') continue;
        diff.set(id, t);
      }
    }
    return diff;
  }

  /**
   * Merge bindings from two if/else branches.
   * - If only one branch bound a TVar, apply that binding.
   * - If both branches bound the same TVar to different concrete types,
   *   create a union.
   * - If both branches bound it to the same type, just apply it.
   */
  mergeBranches(
    consBindings: Map<number, Type>,
    altBindings: Map<number, Type>,
  ): void {
    // Apply bindings unique to each branch
    for (const [id, t] of consBindings) {
      if (!altBindings.has(id)) {
        this.map.set(id, t);
      }
    }
    for (const [id, t] of altBindings) {
      if (!consBindings.has(id)) {
        this.map.set(id, t);
      }
    }
    // For TVars bound in both branches, merge
    for (const [id, consT] of consBindings) {
      const altT = altBindings.get(id);
      if (!altT) continue; // already handled above
      const rCons = this.apply(consT);
      const rAlt = this.apply(altT);
      // Same resolved type — just apply either
      if (rCons.tag === rAlt.tag && rCons.tag === 'TCon' && rAlt.tag === 'TCon' &&
          rCons.name === rAlt.name && rCons.args.length === rAlt.args.length) {
        this.map.set(id, consT);
      } else if (isUnionable(rCons) && isUnionable(rAlt)) {
        // Different concrete types — create union
        this.map.set(id, mergeUnion(rCons, rAlt));
      } else {
        // One or both are TVars or complex — just apply the consequent's
        this.map.set(id, consT);
      }
    }
  }
}
