// ============================================================================
// Constraint-aware instantiation & validation
//
// Plain language: when a constrained template like `Functor f => (a -> b) ->
// f a -> f b` is used, the requirement "f must support mapping" cannot be
// checked immediately — f may still be a placeholder.  So the requirement is
// parked on a pending list, and once inference has filled the placeholders
// in, this file checks each parked requirement: does the concrete type have
// the methods the constraint demands?  Unsatisfied requirements become
// diagnostics.
//
// Extracted from the InferenceEngine class.  Implements constrained-scheme
// instantiation (pending-constraint registration, kv bookkeeping, structural
// and constructor-style constraints) plus the post-inference validation
// passes over pending (union) constraints.
// ============================================================================

import type { InferenceEngine } from './index';
import {
  Type,
  Scheme,
  Constraint,
  TVar,
  TCon,
  tVar,
  tCon,
  tRecord,
  typeToString,
  prettyTypeToString,
  parseKvName,
  kvName,
  getReturnType,
  collectVarNames,
  AstNode,
  containsErrorType,
  T_TYPEREP,
  T_SPREAD_ARRAY,
  tUnion,
  isSkolem,
} from '../hm/types';
import { isAnyType } from '../hm/types';
import { Substitution } from '../hm/substitution';
import { instantiate } from '../hm/env';
import { unify, UnificationError } from '../hm/unify';
import { TypeAnnotation } from '../commentParser';
import { lookupMethod, isBuiltinType, getTypeArity } from '../registries/methodRegistry';
import { checkConstraint, lookupConstraint, checkConstraintMethodShape, getEffectiveMethods, constraintSuperclassClosure } from '../registries/constraintRegistry';
import { isDataType, getDataType } from '../registries/dataTypeRegistry';
import {
  collectKvApplications,
  fixTypeRepKvVars,
  eachType,
  extractParamList,
  renameKvInType,
  mapType,
} from '../hm/typeUtils';
import { BUILTIN_TYPE_ARITIES } from './annotations';

/** Collect kv-encoded TCon varIds from a type tree (varName → old varId). */
export function collectKvNamesInType(t: Type, out: Map<string, number>): void {
  eachType(t, node => {
    if (node.tag === 'TCon') {
      const kv = parseKvName(node.name);
      if (kv && !out.has(kv.varName)) out.set(kv.varName, kv.varId);
    }
  });
}

/**
 * Check whether a constraint type variable (e.g. `m`) appears as a bare TVar
 * in the parameter types of an annotation like `(m, f a) -> m a`, without
 * being wrapped in `TypeRep m`.  Used to suggest `TypeRep m` when the
 * constraint has static methods.
 */
function hasBareConstraintVarInParams(
  annotationType: Type,
  constraintVarName: string,
  varNames: Map<number, string>,
): boolean {
  // Extract parameter types from the TFun
  const params = extractParamList(annotationType);

  // Walk each param type looking for a bare TVar matching the constraint var
  function isBareVar(t: Type): boolean {
    if (t.tag === 'TVar') {
      return varNames.get(t.id) === constraintVarName;
    }
    if (t.tag === 'TCon') {
      // TypeRep m — the m inside TypeRep is fine, skip it
      if (t.name === T_TYPEREP) return false;
      // Tuple / other containers — check args
      return t.args.some(isBareVar);
    }
    if (t.tag === 'TFun') {
      return isBareVar(t.param) || isBareVar(t.result);
    }
    if (t.tag === 'TRecord') {
      for (const k in t.fields) {
        if (isBareVar(t.fields[k])) return true;
      }
      return false;
    }
    return false;
  }

  return params.some(isBareVar);
}

/**
 * Number of mandatory type arguments a known type-constructor name carries.
 * Returns 0 for nullary/scalar types (`String`, `Number`, …) and unknown
 * names; >0 for parametric constructors (`Array`=1, `Either`=2, `StrMap`=1, …).
 */
export function typeConstructorArity(name: string): number {
  const dt = getDataType(name);
  if (dt) return dt.decl.typeVars.length;
  const reg = getTypeArity(name);
  if (reg > 0) return reg;
  return BUILTIN_TYPE_ARITIES.get(name) ?? 0;
}

/**
 * Record a constraint on a kind-variable, splitting between applied
 * (constructor) and unapplied (constraint) buckets.  When `unique` is
 * true, the constraint name is only added if not already present.
 */
export function registerKvConstraint(engine: InferenceEngine, varId: number, constraint: { className: string; isApplied?: boolean }, unique = false): void {
  const map = constraint.isApplied ? engine.kvConstructorConstraints : engine.kvConstraints;
  const existing = map.get(varId) ?? [];
  if (unique && existing.includes(constraint.className)) return;
  existing.push(constraint.className);
  map.set(varId, existing);
}

/**
 * Instantiate a scheme and register pending constraint checks for any
 * constrained type variables. When the scheme has constraints like
 * `Functor f => (a -> b) -> f a -> f b`, the fresh type variable created
 * for `f` is tracked so we can verify the constraint once `f` is resolved.
 */
export function instantiateWithConstraints(engine: InferenceEngine, scheme: Scheme, node: AstNode, annotation?: TypeAnnotation, skipPendingConstraints?: boolean, preBindings?: Map<string, Type>, asGiven?: boolean): Type {
  if (!scheme.constraints || scheme.constraints.length === 0) {
    return instantiate(scheme);
  }

  // We need to manually instantiate so we can track the var mapping
  const varNames = new Map<number, string>();
  collectVarNames(scheme.type, varNames);

  const subst = new Substitution();
  const varIdMap = new Map<string, number>(); // original varName -> fresh var id
  const kvRenameMap = new Map<string, string>(); // old $kv:name:oldId -> new $kv:name:freshId
  const schemeVarSet = new Set(scheme.vars);

  for (const v of scheme.vars) {
    const name = varNames.get(v);
    let fresh = tVar(name);
    while (schemeVarSet.has(fresh.id)) {
      fresh = tVar(name);
    }
    subst.set(v, fresh);
    if (name) {
      varIdMap.set(name, fresh.id);
      // Track kv renaming for constraint vars
      kvRenameMap.set(kvName(name, v), kvName(name, fresh.id));
    }
  }

  // Pre-bind specified scheme vars to concrete types. Used by constrained
  // instance method calls where the receiver TCon args determine some of
  // the scheme vars (e.g. `Prop t a ~> ...` with receiver `Prop Tag Number`
  // pre-binds t→Tag, a→Number) so constraints referencing those vars are
  // checked against the concrete types.
  if (preBindings) {
    for (const [name, concrete] of preBindings) {
      const freshId = varIdMap.get(name);
      if (freshId !== undefined) {
        subst.set(freshId, concrete);
      }
    }
  }

  // Also collect kv-encoded TCon names baked into the type at parse time.
  // The kv varId in the TCon name may differ from scheme.vars (which only
  // lists free TVars, not IDs embedded in TCon name strings).
  const existingKvNames = new Map<string, number>(); // varName -> old kv varId
  collectKvNamesInType(scheme.type, existingKvNames);
  for (const [varName, oldKvId] of existingKvNames) {
    const freshId = varIdMap.get(varName);
    if (freshId !== undefined) {
      const oldKvName = kvName(varName, oldKvId);
      if (!kvRenameMap.has(oldKvName)) {
        kvRenameMap.set(oldKvName, kvName(varName, freshId));
      }
    }
  }

  // Register pending constraints and kvConstraints mapping
  const appliedConstraintVarIds = new Set<number>();
  // freshVarId -> the applied constraint's own arg signature (null = two
  // applied constraints on the same var disagree).
  const appliedConstraintSigs = new Map<number, string | null>();
  // Resolve a constraint's target fresh var id.  Prefer the branch-specific
  // `varId` recorded by `mergeOverloadSchemes` (mapped through `subst` to the
  // instantiation-fresh id): overload branches may share a var letter, and
  // resolving by NAME alone would collapse both onto one id and mis-attach a
  // branch's constraint to the wrong branch's var.  Falls back to the name
  // map for ordinary (non-merged) constrained schemes.
  const resolveConstraintVarId = (constraint: Constraint): number | undefined => {
    if (constraint.varId !== undefined && schemeVarSet.has(constraint.varId)) {
      const applied = subst.apply({ tag: 'TVar', id: constraint.varId, name: constraint.typeVarName });
      if (applied.tag === 'TVar') return applied.id;
    }
    return varIdMap.get(constraint.typeVarName);
  };
  // Constructor-style constraints (`Pair p => ... -> p c a`) where the
  // constrained var IS a named type constructor: freshVarId -> className.
  // Resolved into the instantiated type below (`p c a` -> `Pair c a`).
  const ctorConstraintBindings = new Map<number, string>();
  for (const constraint of scheme.constraints) {
    // Structural-union constraint: register a pending union check.
    // No nominal class lookup, no kv-constraint registration — these
    // are purely structural (the constrained var must unify with one
    // of the alternatives).
    if (constraint.unionAlternatives && constraint.unionAlternatives.length > 0) {
      const freshId = resolveConstraintVarId(constraint);
      if (freshId !== undefined && !skipPendingConstraints) {
        const freshAlternatives = constraint.unionAlternatives.map(alt => subst.apply(alt));
        engine.pendingUnionConstraints.push({
          varId: freshId,
          alternatives: freshAlternatives,
          displayName: constraint.className,
          node,
        });
      }
      continue;
    }

    // Validate that the constraint is defined
    const def = lookupConstraint(constraint.className);
    if (!def) {
      // `TypeRep` is a witness marker, not a `::constraint` class. The bake
      // normally binds the var to `TypeRep <arg>` and drops the constraint;
      // if it survived to here (degenerate form) skip it silently rather
      // than report it as an unknown constraint.
      if (constraint.className === T_TYPEREP) {
        continue;
      }
      // Fallback: if `className` names a known concrete type (built-in
      // like Number/String/Boolean, a registered data type, or a
      // constructor/class declared or imported in scope), treat the
      // constraint as naming a type constructor.  This makes signatures
      // such as `f :: Number r => r -> r` (type-equality assertion) and
      // `m :: Pair p => ... -> p c a` (the var IS the named constructor)
      // work without requiring an explicit `::constraint` definition.
      const namesKnownConstructor =
        isBuiltinType(constraint.className) ||
        isDataType(constraint.className) ||
        engine.annotationMap.has(constraint.className) ||
        engine.importedConstructors.has(constraint.className) ||
        typeConstructorArity(constraint.className) > 0;
      if (namesKnownConstructor) {
        const freshId = resolveConstraintVarId(constraint);
        if (freshId !== undefined && existingKvNames.has(constraint.typeVarName)) {
          // Higher-kinded constructor constraint: the constrained var
          // appears applied (e.g. `Pair p => ... -> p c a`), so the var
          // IS the named type constructor.  Record the binding so every
          // kv-encoded `$kv:p:freshId` usage resolves to the constructor
          // (`p c a` -> `Pair c a`) in the instantiated type below.
          ctorConstraintBindings.set(freshId, constraint.className);
        } else if (freshId !== undefined && !skipPendingConstraints) {
          // Scalar / type-equality form (`Number r => r -> r`): defer to
          // a pending union check that binds `r ~ TCon(className)`.
          // For the applied form `Array String r =>`
          // (positionalArgs = [String, r]) we drop the trailing bound
          // var and use the rest as TCon args.
          let typeArgs: Type[] = [];
          if (constraint.positionalArgs && constraint.positionalArgs.length > 0) {
            const last = constraint.positionalArgs[constraint.positionalArgs.length - 1];
            const dropLast = last.tag === 'TVar' && last.name === constraint.typeVarName;
            const argsRaw = dropLast
              ? constraint.positionalArgs.slice(0, -1)
              : constraint.positionalArgs;
            typeArgs = argsRaw.map(t => subst.apply(t));
          }
          const alt: Type = { tag: 'TCon', name: constraint.className, args: typeArgs };
          engine.pendingUnionConstraints.push({
            varId: freshId,
            alternatives: [alt],
            displayName: constraint.className,
            node,
          });
        }
        continue;
      }
      // Structural annotation diagnostic — emit only at the declaration site
      // (where `annotation` is supplied), never at bare value references, so it
      // is not duplicated on `module.exports = f` / `const g = f`.
      if (!skipPendingConstraints && annotation) {
        const sigLoc =
          annotation?.signatureNameStart !== undefined && annotation?.signatureNameEnd !== undefined
            ? { start: annotation.signatureNameStart, end: annotation.signatureNameEnd }
            : { start: annotation?.commentStart ?? node.start, end: annotation?.commentEnd ?? node.end };
        engine.addDiag(
          `Unknown constraint '${constraint.className}'. Define it with \`// ::constraint ${constraint.className} ${constraint.typeVarName} { ... }\``,
          sigLoc,
        );
      }
      continue;
    }

    // Structural constraint:
    //   `::constraint Name p1 p2 … pN = self1 is body1 [, self2 is body2 …]`
    // Each self-clause is checked independently. The use-site supplies
    // positional arguments matching `headerParams`. For every clause:
    //   - The slot of `selfParam` in positionalArgs is the type that must
    //     satisfy the clause body (one of the union alternatives, or the
    //     body itself when not a union).
    //   - If that slot is concrete (TCon/TFun/etc.), check eagerly via
    //     speculative unify. If it's a use-site TVar, register a pending
    //     union check.
    //   - Body free vars not in headerParams are existential: each
    //     instantiation gets a fresh TVar.
    if (def.selfClauses && def.headerParams) {
      const headerParams = def.headerParams;
      const selfClauses = def.selfClauses;

      // Resolve positional args. When the constraint was written as the
      // simple bare-var form `Name v =>` (no positionalArgs), synthesise
      // a single positional arg pointing to the use-site var.
      let positional: Type[];
      if (constraint.positionalArgs && constraint.positionalArgs.length > 0) {
        positional = constraint.positionalArgs.map(t => subst.apply(t));
      } else {
        // Bare form: requires arity 1.
        const freshId = resolveConstraintVarId(constraint);
        if (freshId === undefined) { continue; }
        positional = [{ tag: 'TVar', id: freshId, name: constraint.typeVarName }];
      }

      if (positional.length !== headerParams.length) {
        // Structural annotation diagnostic — declaration site only (see above).
        if (!skipPendingConstraints && annotation) {
          engine.addDiag(
            `Constraint '${constraint.className}' expects ${headerParams.length} positional type argument(s) but got ${positional.length}`,
            { start: annotation?.commentStart ?? node.start, end: annotation?.commentEnd ?? node.end },
          );
        }
        continue;
      }

      // Map header param name → positional arg type.
      const headerByName = new Map<string, Type>();
      for (let i = 0; i < headerParams.length; i++) {
        headerByName.set(headerParams[i], positional[i]);
      }

      if (skipPendingConstraints) { continue; }

      for (const clause of selfClauses) {
        // Build per-clause id remap: header-named TVars → corresponding
        // positional arg; everything else → fresh existential TVar.
        const idMap = new Map<number, Type>();
        eachType(clause.body, n => {
          if (n.tag === 'TVar' && !idMap.has(n.id)) {
            const pos = headerByName.get(n.name);
            idMap.set(n.id, pos !== undefined ? pos : tVar(n.name));
          }
        });
        const instantiatedBody = mapType(clause.body, n => {
          if (n.tag === 'TVar' && idMap.has(n.id)) return idMap.get(n.id)!;
          return undefined;
        });
        const finalBody = subst.apply(instantiatedBody);
        const alternatives = (finalBody.tag === 'TCon' && finalBody.name === 'Union')
          ? finalBody.args
          : [finalBody];

        const selfType = subst.apply(headerByName.get(clause.selfParam)!);

        // Determine whether to check eagerly or defer.
        // - selfType still a fresh TVar belonging to a use-site bound name
        //   → defer (pending union constraint).
        // - selfType is a TVar but anonymous (no name in source) → still a
        //   use-site var; defer.
        // - selfType has any concrete shape → check eagerly.
        if (selfType.tag === 'TVar') {
          engine.pendingUnionConstraints.push({
            varId: selfType.id,
            alternatives,
            displayName: constraint.className,
            node,
          });
          continue;
        }

        // Eager: try to unify selfType against each alternative.
        let matched = false;
        for (const alt of alternatives) {
          const snapshot = subst.snapshot();
          try {
            const delta = unify(selfType, alt);
            for (const [k, v] of delta.entries()) subst.set(k, v);
            matched = true;
            break;
          } catch (e) {
            if (!(e instanceof UnificationError)) throw e;
            subst.restore(snapshot);
          }
        }
        if (!matched) {
          engine.addDiag(
            `Type '${prettyTypeToString(selfType)}' does not satisfy constraint '${constraint.className}'`,
            { start: annotation?.commentStart ?? node.start, end: annotation?.commentEnd ?? node.end },
          );
        }
      }
      continue;
    }

    // Kind validation: check that the constraint usage matches the expected kind.
    // These are structural diagnostics about how the annotation is *written*
    // (kind mismatch, TypeRep placement, unused applied-arg vars). They belong
    // to the annotation's declaration site only: a bare value reference to a
    // constrained binding (e.g. `module.exports = drop`) instantiates the scheme
    // with no `annotation` argument, and must NOT re-emit them — otherwise the
    // definition-site diagnostic is duplicated at every reference.
    if (!skipPendingConstraints && annotation) {
      const varUsedAsConstructor = existingKvNames.has(constraint.typeVarName);
      if (constraint.isApplied && def.expectedKind === '* -> *') {
        // e.g. Functor (f a) — Functor expects * -> *, but (f a) is *
        engine.addDiag(
          `Constraint kind mismatch: '${constraint.className}' expects kind * -> * (a type constructor), but '(${constraint.typeVarName} ...)' is kind * (a concrete type). Use '${constraint.className} ${constraint.typeVarName}' instead`,
          { start: annotation?.commentStart ?? node.start, end: annotation?.commentEnd ?? node.end },
        );
      } else if (!constraint.isApplied && def.expectedKind === '*' && varUsedAsConstructor) {
        // e.g. Monoid f where f is used as f a — Monoid expects *, but f is * -> *
        engine.addDiag(
          `Constraint kind mismatch: '${constraint.className}' expects kind * (a concrete type), but '${constraint.typeVarName}' is used as a type constructor (kind * -> *). Use '${constraint.className} (${constraint.typeVarName} ...)' instead`,
          { start: annotation?.commentStart ?? node.start, end: annotation?.commentEnd ?? node.end },
        );
      }

      // Applied constraint with static methods: bare type-constructor var
      // in parameter list needs TypeRep wrapping.
      // e.g. Monoid (m a) has static method `empty :: () -> m`.  If `m`
      // appears as a bare parameter, the user should write `TypeRep m`.
      if (constraint.isApplied && varUsedAsConstructor) {
        const allMethods = getEffectiveMethods(constraint.className);
        const hasStatic = allMethods.some(m => !m.signature.includes('~>'));
        if (hasStatic && hasBareConstraintVarInParams(scheme.type, constraint.typeVarName, varNames)) {
          engine.addDiag(
            `Constraint '${constraint.className}' has static methods, but type variable '${constraint.typeVarName}' appears as a bare parameter. Use 'TypeRep ${constraint.typeVarName}' to pass the type constructor`,
            { start: annotation?.commentStart ?? node.start, end: annotation?.commentEnd ?? node.end },
          );
        }
      }

      // Applied constraint inner arg validation: check that inner type
      // variables like 'b' in Monoid (m b) actually appear in the function type.
      // A compound (nested) arg like '(t a)' is checked per component var.
      if (constraint.isApplied && constraint.appliedArgNames) {
        const typeVarNameSet = new Set(varNames.values());
        for (const argName of constraint.appliedArgNames) {
          const componentNames = argName.startsWith('(')
            ? argName.match(/[a-z][A-Za-z0-9]*/g) ?? []
            : [argName];
          for (const component of componentNames) {
            if (!typeVarNameSet.has(component)) {
              engine.addDiag(
                `Type variable '${component}' in constraint '${constraint.className} (${constraint.typeVarName} ${constraint.appliedArgNames.join(' ')})' does not appear in the function type`,
                { start: annotation?.commentStart ?? node.start, end: annotation?.commentEnd ?? node.end },
              );
            }
          }
        }
      }
    }

    const freshId = resolveConstraintVarId(constraint);
    if (freshId !== undefined) {
      if (!skipPendingConstraints) {
        engine.pendingConstraints.push({
          varId: freshId,
          constraintName: constraint.className,
          node,
          reps: scheme.reps,
          given: asGiven,
          typeVarName: constraint.typeVarName,
          appliedArgNames: constraint.isApplied ? constraint.appliedArgNames : undefined,
          // For givens (the enclosing function's own signature), remember the
          // annotation comment range so the missing-constraint diagnostic can
          // point back at (and quick-fix) the signature.
          annStart: asGiven ? annotation?.commentStart : undefined,
          annEnd: asGiven ? annotation?.commentEnd : undefined,
        });
      }

      if (constraint.isApplied) {
        appliedConstraintVarIds.add(freshId);
        // Record the constraint's OWN application signature (`Setoid (f b)`
        // applies `f` to `b`) so the pin-consistency check below can compare
        // it against the applications found in the type — the constraint app
        // itself may not occur in the type at all (interchange's `f (a -> b)`).
        if (constraint.appliedArgNames && constraint.appliedArgNames.length > 0) {
          const sig = constraint.appliedArgs
            ? constraint.appliedArgs
                .map(t => typeToString(renameKvInType(subst.apply(t), kvRenameMap)))
                .join(',')
            : constraint.appliedArgNames.map(n => {
                const id = varIdMap.get(n);
                return id !== undefined ? typeToString({ tag: 'TVar', id, name: n }) : n;
              }).join(',');
          const prev = appliedConstraintSigs.get(freshId);
          if (prev === undefined) appliedConstraintSigs.set(freshId, sig);
          else if (prev !== sig) appliedConstraintSigs.set(freshId, null);
        }
      }
      registerKvConstraint(engine, freshId, constraint);
    }
  }

  // Apply substitution (handles TVar renaming) then rename kv TCon names
  let result = subst.apply(scheme.type);
  result = renameKvInType(result, kvRenameMap);

  // Resolve constructor-style constraints (`Pair p => ... -> p c a`):
  // bind each constrained var to its named constructor so kv usages
  // (`$kv:p:freshId c a`) collapse to `Pair c a`.  Done after the kv
  // rename so the ids match the instantiated type.  Also commit the
  // binding to the engine subst (when not a display-only instantiation)
  // so body unification agrees.
  if (ctorConstraintBindings.size > 0) {
    const ctorSubst = new Substitution();
    for (const [id, cname] of ctorConstraintBindings) {
      const ctor: Type = { tag: 'TCon', name: cname, args: [] };
      ctorSubst.set(id, ctor);
    }
    result = ctorSubst.apply(result);
  }

  // When an applied constraint like `Monoid (m a)` produces a kv-TCon
  // `$kv:m:ID(a)` in the return type, but `TypeRep m` in the parameters
  // still wraps a bare TVar, functions receiving the TypeRep (like
  // `empty :: Monoid m => TypeRep m -> m`) would return the bare TVar `m`
  // instead of the full applied `m a`.  Fix this by replacing the bare
  // TVar inside TypeRep with the applied kv-TCon found elsewhere in the type.
  // Only do this for vars from *applied* constraints (e.g. `Monoid (m a)`),
  // not non-applied constraints (e.g. `Applicative f`) where `f` appears
  // as a constructor naturally (in `f b`) but TypeRep should stay `TypeRep f`.
  const kvApps = new Map<number, Type>();
  collectKvApplications(result, kvApps);
  if (kvApps.size > 0) {
    // NOTE: non-applied constraint vars (e.g. the `f` of
    // `of :: Applicative f => TypeRep f -> a -> f a`) are intentionally NOT
    // pinned: unifyTypeRep binds a bare `TypeRep f` var to the witness's
    // *bare* constructor (stripping the witness's own element params), so
    // `f a` collapses correctly AND the rep stays usable at multiple element
    // types in one body.  Pinning remains only for *applied* constraints
    // (e.g. `Monoid (m a) => TypeRep m -> m`) where the kv application in the
    // rest of the type must be mirrored into the TypeRep parameter.
    //
    // Even then, pinning is only SAFE when the var is kv-applied to a single,
    // consistent argument across the whole type.  When applied to *varying*
    // args (e.g. `(ChainRec m, Setoid (m b)) => TypeRep m -> (a -> m a) ->
    // (a -> m b) -> ...`), picking one application to bake into the TypeRep
    // would be unsound — a callee's bare `TypeRep m` would bind to the
    // applied form and later collapse `m c` into the ill-kinded `m b c`.
    const argSigByVar = new Map<number, string | null>();
    for (const [id, sig] of appliedConstraintSigs) argSigByVar.set(id, sig);
    eachType(result, node => {
      if (node.tag !== 'TCon') return;
      const kv = parseKvName(node.name);
      if (!kv || node.args.length === 0) return;
      if (!appliedConstraintVarIds.has(kv.varId)) return;
      const sig = node.args.map(a => typeToString(a)).join(',');
      const prev = argSigByVar.get(kv.varId);
      if (prev === undefined) argSigByVar.set(kv.varId, sig);
      else if (prev !== sig) argSigByVar.set(kv.varId, null); // inconsistent
    });
    for (const varId of [...kvApps.keys()]) {
      if (!appliedConstraintVarIds.has(varId) || argSigByVar.get(varId) === null) {
        kvApps.delete(varId);
      }
    }
    if (kvApps.size > 0) {
      result = fixTypeRepKvVars(result, kvApps);
    }
  }

  return result;
}

/**
 * Register constraint info for static method body parameter TVars.
 * Matches annotation param positions with body param TVars and registers
 * kvConstraints so hover and autocomplete work on constraint-typed params
 * (e.g. M in `static of(M, value)` when annotation says `Monad m => (m, a) -> ...`).
 */
export function registerStaticMethodConstraints(engine: InferenceEngine, scheme: Scheme, bodyType: Type): void {
  if (!scheme.constraints || scheme.constraints.length === 0) return;

  // Build a map of annotation var names
  const annVarNames = new Map<number, string>();
  collectVarNames(scheme.type, annVarNames);

  // Find which annotation vars correspond to constraint type vars
  const constraintVarIds = new Map<string, number[]>(); // varName -> [varIds]
  for (const constraint of scheme.constraints) {
    const ids: number[] = [];
    for (const [vid, vname] of annVarNames) {
      if (vname === constraint.typeVarName) ids.push(vid);
    }
    constraintVarIds.set(constraint.typeVarName, ids);
  }

  // Extract annotation param types and body param types from TFun
  const annParamTypes = extractParamList(scheme.type);
  const bodyParamTypes = extractParamList(bodyType);

  for (let i = 0; i < annParamTypes.length && i < bodyParamTypes.length; i++) {
    const bodyParam = engine.subst.apply(bodyParamTypes[i]);
    if (bodyParam.tag !== 'TVar') continue;

    // Check if this annotation param position uses a constraint var
    for (const constraint of scheme.constraints) {
      const cVarIds = constraintVarIds.get(constraint.typeVarName) ?? [];
      const annParam = annParamTypes[i];
      // If the annotation param IS the constraint var (e.g. m in (m, a))
      if (annParam.tag === 'TVar' && cVarIds.includes(annParam.id)) {
        registerKvConstraint(engine, bodyParam.id, constraint, true);
      }
    }
  }
}

/**
 * Count pending constraints whose variable has resolved (under the CURRENT
 * substitution) to a concrete type that does NOT satisfy the constraint.
 * Read-only mirror of {@link validatePendingConstraints} (emits no
 * diagnostics).  Used by overload selection to reject a branch that would
 * pin a constraint variable to an incompatible type (e.g. selecting the
 * `Category c => TypeRep c -> c` overload of `id` for `id(Function)` when
 * `Function` does not satisfy `Category`).
 */
export function countViolatedPendingConstraints(engine: InferenceEngine): number {
  let violations = 0;
  for (const pending of engine.pendingConstraints) {
    const resolved = engine.subst.apply({ tag: 'TVar', id: pending.varId, name: '' } as TVar);
    if (resolved.tag === 'TVar') continue;
    if (isAnyType(resolved)) continue;
    if (containsErrorType(resolved)) continue;
    if (resolved.tag === 'TCon' && parseKvName(resolved.name)) continue;
    let typeToCheck: string | null = null;
    if (resolved.tag === 'TCon') typeToCheck = resolved.name;
    else if (resolved.tag === 'TFun') {
      const ret = getReturnType(resolved);
      if (ret.tag === 'TCon') typeToCheck = ret.name;
    } else if (resolved.tag === 'TRecord') typeToCheck = 'Object';
    if (typeToCheck === null) continue;
    if (typeToCheck === T_SPREAD_ARRAY) typeToCheck = 'Array';
    if (!lookupConstraint(pending.constraintName)) continue;
    const { missing } = checkConstraint(pending.constraintName, typeToCheck);
    const applicableReps = [...(pending.reps ?? []), ...engine.fileReps, ...engine.importedReps];
    const repMethodNames = new Set(
      applicableReps
        .filter((r) => r.constraint === pending.constraintName && r.typeName === typeToCheck)
        .map((r) => r.methodName),
    );
    if (missing.some((m) => !repMethodNames.has(m))) violations++;
  }
  return violations;
}

/**
 * Report constraints that a callee REQUIRES on an enclosing function's own
 * (still-polymorphic) type variable but which the enclosing signature never
 * DECLARES.  Haskell's "No instance for (C a) arising from a use of …".
 *
 * Mechanism: an annotated constrained function body instantiates its OWN
 * signature as the authoritative expected type (`asGiven` → pending
 * constraints tagged `given`).  Callees referenced in the body push their
 * required constraints (wanted, `given` unset) onto vars that unify with the
 * enclosing function's declared type vars — so both givens and wanteds share
 * the same resolved var id (a bare TVar or a still-polymorphic `$kv:name:id`
 * higher-kinded TCon).  A wanted whose class is not entailed by the given
 * closure on that var (via `extends` superclasses) is an under-declared
 * constraint.  Only fires when the var carries at least one given, i.e. it
 * belongs to an annotated constrained function — never on inferred /
 * unconstrained polymorphic code.
 */
export function validateMissingConstraints(engine: InferenceEngine): void {
  // Resolve a pending constraint's var to a canonical polymorphic var id:
  // a bare TVar id, or the id embedded in a still-unresolved `$kv:name:id`
  // higher-kinded TCon.  Returns null when the var resolved to a concrete
  // type (handled by validatePendingConstraints) or anything else.
  const canonicalVarId = (varId: number): number | null => {
    const r = engine.subst.apply({ tag: 'TVar', id: varId, name: '' } as TVar);
    if (r.tag === 'TVar') return r.id;
    if (r.tag === 'TCon') {
      const kv = parseKvName(r.name);
      if (kv) return kv.varId;
    }
    return null;
  };

  // Given-constraint closure per canonical var: union of superclass closures
  // of every declared (given) constraint resolving onto that var.  Also
  // remember the declaring annotation's comment range per var so the
  // missing-constraint diagnostic can point at the signature to fix.
  const givenClosureByVar = new Map<number, Set<string>>();
  const givenAnnotationByVar = new Map<number, { start: number; end: number }>();
  for (const p of engine.pendingConstraints) {
    if (!p.given) continue;
    if (!lookupConstraint(p.constraintName)) continue;
    const cid = canonicalVarId(p.varId);
    if (cid === null) continue;
    let set = givenClosureByVar.get(cid);
    if (!set) { set = new Set<string>(); givenClosureByVar.set(cid, set); }
    for (const c of constraintSuperclassClosure(p.constraintName)) set.add(c);
    if (p.annStart !== undefined && p.annEnd !== undefined && !givenAnnotationByVar.has(cid)) {
      givenAnnotationByVar.set(cid, { start: p.annStart, end: p.annEnd });
    }
  }

  if (givenClosureByVar.size === 0) return;

  // For each wanted constraint on a given-carrying var, require entailment.
  const reported = new Set<string>();
  for (const p of engine.pendingConstraints) {
    if (p.given) continue;
    if (!lookupConstraint(p.constraintName)) continue;
    const cid = canonicalVarId(p.varId);
    if (cid === null) continue;
    const given = givenClosureByVar.get(cid);
    if (!given) continue; // var is not a declared var of an annotated function
    if (given.has(p.constraintName)) continue; // entailed by a declared constraint
    const varLetter = p.typeVarName ?? '';
    const key = `${cid}:${p.constraintName}:${p.node.start}:${p.node.end}`;
    if (reported.has(key)) continue;
    reported.add(key);
    // Applied constraints (e.g. `Monoid (f a)`) keep their applied form in
    // the label so the user can copy it verbatim into the signature.
    const varDisplay = varLetter && p.appliedArgNames && p.appliedArgNames.length > 0
      ? `(${varLetter} ${p.appliedArgNames.join(' ')})`
      : varLetter;
    const label = varDisplay ? `${p.constraintName} ${varDisplay}` : p.constraintName;
    const ann = givenAnnotationByVar.get(cid);
    engine.addDiag(
      `Missing constraint '${label}' required here; add it to the enclosing function's signature.`,
      p.node,
      ann ? [{ message: "The enclosing function's signature", start: ann.start, end: ann.end }] : undefined,
    );
  }
}

/**
 * Validate all pending constraints after inference is complete.
 * Checks that each constrained type variable resolved to a concrete type
 * that satisfies the constraint (i.e., has all required methods registered).
 */
export function validatePendingConstraints(engine: InferenceEngine): void {
  for (const pending of engine.pendingConstraints) {
    const resolved = engine.subst.apply({ tag: 'TVar', id: pending.varId, name: '' } as TVar);

    // If still a type variable, the constraint can't be checked yet — skip
    if (resolved.tag === 'TVar') continue;

    // `Any` is the dynamic type: like unification, constraint checks accept it.
    if (isAnyType(resolved)) continue;

    // If the resolved type is poisoned by a prior $error, skip — the
    // originating diagnostic already informs the user; cascading a
    // "Type '$error' does not satisfy constraint" message just adds
    // noise.
    if (containsErrorType(resolved)) continue;

    // If still a kind-variable TCon (not resolved to a concrete type), skip
    if (resolved.tag === 'TCon' && parseKvName(resolved.name)) continue;

    // Must be a TCon to check methods.
    // Special case: when the constraint var resolves to a function type
    // (common in JS where constructor functions serve as type constructor
    // representatives, e.g. Identity :: a -> Identity a), extract the
    // return type's TCon and check that against the constraint.
    let typeToCheck: string | null = null;
    if (resolved.tag === 'TCon') {
      typeToCheck = resolved.name;
    } else if (resolved.tag === 'TFun') {
      const ret = getReturnType(resolved);
      // A function that does not return a constructor's type is a plain
      // function VALUE: check the user-declared `Function` instances
      // (`::rep Setoid Function#equals`).
      typeToCheck = ret.tag === 'TCon' && !isSkolem(ret) ? ret.name : 'Function';
    } else if (resolved.tag === 'TRecord') {
      // Records have no kind-parameter; structurally they all share the
      // outer kind `Object`.  Map TRecord → 'Object' so constraint
      // dispatch consults user-declared Object instance methods (e.g.
      // `// Object#concat :: { ...a } ~> { ...b } -> { ...a, ...b }`).
      // No class names are hardcoded here.
      typeToCheck = 'Object';
    }

    // A SpreadArray (`[a, b, ...]`) is array-like: it satisfies the same
    // constraints and exposes the same methods/`::rep` bindings as `Array`.
    // Normalize it here so constraint resolution, `::rep` lookup, and the
    // method shape-check all consult the `Array` instance (mirrors the
    // SpreadArray→Array normalization in the method registry).
    if (typeToCheck === T_SPREAD_ARRAY) {
      typeToCheck = 'Array';
    }

    if (typeToCheck === null) {
      engine.addDiag(`Type '${prettyTypeToString(resolved)}' cannot satisfy constraint '${pending.constraintName}'`, pending.node);
      continue;
    }

    // Rank-N skolem promise: the `forall` that minted this skolem declared
    // the constraint (e.g. `forall f. Functor f => …`), so the methods are
    // guaranteed by the callee's annotation — nothing to check here.
    const promised = engine.rankNSkolemPromises.get(typeToCheck);
    if (promised && promised.has(pending.constraintName)) continue;

    const { missing } = checkConstraint(pending.constraintName, typeToCheck);

    // Consult `::rep` representations carried by the constraining scheme.
    // A `::rep Constraint Type#method` entry declares that the local
    // instance-method annotation `Type#method` satisfies the constraint's
    // requirement for `method` even though that method is not registered as
    // a normal (autocomplete-visible) method.  These are call-scoped: they
    // only apply when the scheme carrying them is used here.  Schemes that
    // crossed an import boundary carry their reps explicitly; for a
    // constrained function used locally in the same file the reps are not
    // attached to the scheme, so fall back to the file-level `::rep` set.
    const applicableReps = [...(pending.reps ?? []), ...engine.fileReps, ...engine.importedReps];
    // `missing` includes the superclasses' methods (Plus → Alt → Functor), so
    // a superclass instance (`::rep Alt Array#alt`) counts as well.
    const repConstraints = new Set([pending.constraintName, ...constraintSuperclassClosure(pending.constraintName)]);
    const repMethodNames = new Set(
      applicableReps
        .filter(
          (r) => repConstraints.has(r.constraint) && r.typeName === typeToCheck,
        )
        .map((r) => r.methodName),
    );
    const trueMissing = missing.filter((m) => !repMethodNames.has(m));

    if (trueMissing.length > 0) {
      const def = lookupConstraint(pending.constraintName);
      if (!def) {
        engine.addDiag(`Unknown constraint '${pending.constraintName}'`, pending.node);
      } else {
        engine.addDiag(`Type '${typeToCheck}' does not satisfy constraint '${pending.constraintName}': missing method${trueMissing.length > 1 ? 's' : ''} ${trueMissing.map(m => `'${m}'`).join(', ')}`, pending.node);
      }
    } else {
      // When the constraint var resolved to a function type (e.g. a -> Identity a),
      // rebind it to the type constructor name (Identity) so that result types
      // display as e.g. EitherT e Identity String instead of EitherT e (a -> Identity a) String.
      // This matches Haskell/PureScript convention where m is a type constructor, not a function.
      // Walk the substitution chain to find the deepest TVar bound to the function type,
      // since unification may have created intermediate TVar links.
      if (resolved.tag === 'TFun' && typeToCheck !== null) {
        const constructorType = tCon(typeToCheck, []);
        let curId = pending.varId;
        // Chase through TVar → TVar chains to find the one that directly
        // holds the TFun binding.
        for (;;) {
          const cur = engine.subst.lookup(curId);
          if (cur && cur.tag === 'TVar') {
            curId = cur.id;
          } else {
            break;
          }
        }
        engine.subst.set(curId, constructorType);
        // Also collect the rewrite so types that already have the function
        // type baked in (not via a TVar) can be post-processed.
        engine.constraintConstructorRewrites.push({ from: resolved, to: constructorType });
      }

      // Methods exist — also verify their signature shapes match the constraint
      const def = lookupConstraint(pending.constraintName);
      if (def) {
        for (const req of def.methods) {
          // Rep-covered methods are validated at `::rep` registration time
          // against the local annotation; skip the registry shape check
          // here (the registered method, if any, may be hidden/builtin and
          // is intentionally not the satisfying implementation).
          if (repMethodNames.has(req.name)) continue;
          const entry = lookupMethod(typeToCheck, req.name);
          if (!entry) continue;
          const shapeMismatch = checkConstraintMethodShape(
            def.typeVar,
            req.signature,
            typeToCheck,
            entry,
          );
          if (shapeMismatch) {
            engine.addDiag(`Type '${typeToCheck}' does not satisfy constraint '${pending.constraintName}': method '${req.name}' ${shapeMismatch}`, pending.node);
          }
        }
      }
    }
  }
}

/**
 * Validate pending structural-union constraints. Each constrained type
 * variable must unify with at least one of the listed alternatives.
 * The first alternative that successfully unifies wins; its substitution
 * is committed to the engine. If none unify, a diagnostic is emitted.
 * Variables still unresolved at this point are left alone (no diagnostic).
 */
export function validatePendingUnionConstraints(engine: InferenceEngine): void {
  for (const pending of engine.pendingUnionConstraints) {
    const resolved = engine.subst.apply({ tag: 'TVar', id: pending.varId, name: '' } as TVar);

    // If still a free type variable, the constraint cannot constrain
    // anything yet — leave it alone (matches nominal-constraint behaviour).
    if (resolved.tag === 'TVar') continue;

    // Suppress cascade diagnostics when the resolved type is poisoned
    // by a prior $error: the originating error already informs the user,
    // and `Type '$error' does not satisfy union constraint 'X'` is noise.
    if (containsErrorType(resolved)) continue;

    // Resolved to a union (e.g. when an array literal `[1, "3"]` was
    // bound to a free element TVar and widened to `Number | String`):
    // EVERY member of the resolved union must satisfy at least one
    // alternative, otherwise the constraint is violated.  Without this,
    // `unify(Number | String, String)` would succeed (because String is
    // in the union) and a constraint like `(String | Boolean) b` would
    // be silently satisfied even though Number is not allowed.
    if (resolved.tag === 'TCon' && resolved.name === 'Union' && resolved.args.length > 0) {
      const offending: Type[] = [];
      for (const member of resolved.args) {
        const memResolved = engine.subst.apply(member);
        // Free TVars inside the union are non-determinative — skip.
        if (memResolved.tag === 'TVar') continue;
        let memMatched = false;
        for (const alt of pending.alternatives) {
          const altResolved = engine.subst.apply(alt);
          const snap = engine.subst.snapshot();
          try {
            unify(memResolved, altResolved);
            memMatched = true;
            engine.subst.restore(snap); // don't commit — purely a check
            break;
          } catch (e) {
            if (!(e instanceof UnificationError)) throw e;
            engine.subst.restore(snap);
          }
        }
        if (!memMatched) offending.push(memResolved);
      }
      if (offending.length > 0) {
        const offDisp = offending.length === 1
          ? `'${prettyTypeToString(offending[0])}'`
          : offending.map(o => `'${prettyTypeToString(o)}'`).join(', ');
        engine.addDiag(
          `Type ${offDisp} does not satisfy union constraint '${pending.displayName}'`,
          pending.node,
        );
      }
      continue;
    }

    let matched = false;
    for (const alt of pending.alternatives) {
      const altResolved = engine.subst.apply(alt);
      const snapshot = engine.subst.snapshot();
      try {
        const delta = unify(resolved, altResolved);
        // Commit: merge delta into engine subst.
        for (const [k, v] of delta.entries()) {
          engine.subst.set(k, v);
        }
        matched = true;
        break;
      } catch (e) {
        if (!(e instanceof UnificationError)) throw e;
        // Restore and try next alternative.
        engine.subst.restore(snapshot);
      }
    }

    if (!matched) {
      engine.addDiag(
        `Type '${prettyTypeToString(resolved)}' does not satisfy union constraint '${pending.displayName}'`,
        pending.node,
      );
    }
  }
}

/**
 * Post-process a type by replacing constrained function types with their
 * constructor names.  E.g. replaces `a -> Identity a` with `Identity`
 * inside `EitherT e (a -> Identity a) String` → `EitherT e Identity String`.
 * Only rewrites nested occurrences (type args, function params/results,
 * record fields) — not the top-level type itself, so that a standalone
 * variable like `Identity :: a -> Identity a` keeps its function type.
 */
export function applyConstraintConstructorRewrites(engine: InferenceEngine, t: Type): Type {
  if (engine.constraintConstructorRewrites.length === 0) return t;
  return applyConstraintConstructorRewritesInner(engine, t, false);
}

function applyConstraintConstructorRewritesInner(engine: InferenceEngine, t: Type, nested: boolean): Type {
  // Only replace when this is a nested occurrence (inside a TCon arg, TFun, etc.)
  if (nested) {
    for (const rw of engine.constraintConstructorRewrites) {
      if (typesStructurallyMatch(t, rw.from)) {
        return rw.to;
      }
    }
  }
  switch (t.tag) {
    case 'TCon':
      return tCon(t.name, t.args.map(a => applyConstraintConstructorRewritesInner(engine, a, true)));
    case 'TFun':
      return { tag: 'TFun', param: applyConstraintConstructorRewritesInner(engine, t.param, true), result: applyConstraintConstructorRewritesInner(engine, t.result, true) };
    case 'TRecord': {
      const fields: Record<string, Type> = {};
      for (const k in t.fields) {
        fields[k] = applyConstraintConstructorRewritesInner(engine, t.fields[k], true);
      }
      return tRecord(fields);
    }
    default:
      return t;
  }
}

/**
 * Check if two types are structurally identical using a consistent TVar mapping.
 * TVars don't need the same ID — they just need to appear in corresponding positions.
 * E.g. `TVar(1) -> Identity TVar(1)` matches `TVar(99) -> Identity TVar(99)`.
 */
function typesStructurallyMatch(a: Type, b: Type): boolean {
  const mapping = new Map<number, number>();  // a-TVar-id → b-TVar-id
  const check = (x: Type, y: Type): boolean => {
    if (x.tag !== y.tag) return false;
    if (x.tag === 'TVar' && y.tag === 'TVar') {
      const mapped = mapping.get(x.id);
      if (mapped !== undefined) return mapped === y.id;
      mapping.set(x.id, y.id);
      return true;
    }
    if (x.tag === 'TCon' && y.tag === 'TCon') {
      if (x.name !== y.name || x.args.length !== y.args.length) return false;
      return x.args.every((arg, i) => check(arg, (y as TCon).args[i]));
    }
    if (x.tag === 'TFun' && y.tag === 'TFun') {
      return check(x.param, y.param) && check(x.result, y.result);
    }
    return false;
  };
  return check(a, b);
}

/**
 * Bake constructor-style constraints into a type.  When a constraint such as
 * `Pair p => ...` names a known type constructor (not a `::constraint`
 * class), the constrained variable `p` IS that constructor, so every
 * occurrence — bare `p` (a TVar) or applied `p c a` (a kv-encoded TCon
 * `$kv:p:id c a`) — is rewritten to the constructor (`Pair` / `Pair c a`).
 * The ids of rewritten variables are collected in `bakedIds` so the caller
 * can drop them from the scheme's quantified-variable list.
 *
 * `nameToType` carries BARE (non-applied) type-constraint rewrites where the
 * target is an arbitrary type rather than a constructor name — used for bare
 * scalar constraints (`String p` → `p := String`) and structural-union
 * constraints (`(Number | Undefined) x` → `x := Number | Undefined`).
 */
function bakeCtorConstraintsInType(
  t: Type,
  nameToClass: Map<string, string>,
  bakedIds: Set<number>,
  nameToType?: Map<string, Type>,
): Type {
  switch (t.tag) {
    case 'TVar':
      if (t.name && nameToClass.has(t.name)) {
        bakedIds.add(t.id);
        return { tag: 'TCon', name: nameToClass.get(t.name)!, args: [] };
      }
      if (t.name && nameToType && nameToType.has(t.name)) {
        bakedIds.add(t.id);
        return nameToType.get(t.name)!;
      }
      return t;
    case 'TCon': {
      const newArgs = t.args.map((a) => bakeCtorConstraintsInType(a, nameToClass, bakedIds, nameToType));
      const kv = parseKvName(t.name);
      if (kv && nameToClass.has(kv.varName)) {
        bakedIds.add(kv.varId);
        return { tag: 'TCon', name: nameToClass.get(kv.varName)!, args: newArgs };
      }
      if (newArgs.every((a, i) => a === t.args[i])) return t;
      return { tag: 'TCon', name: t.name, args: newArgs };
    }
    case 'TFun': {
      const param = bakeCtorConstraintsInType(t.param, nameToClass, bakedIds, nameToType);
      const result = bakeCtorConstraintsInType(t.result, nameToClass, bakedIds, nameToType);
      if (param === t.param && result === t.result) return t;
      return { tag: 'TFun', param, result };
    }
    case 'TRecord': {
      const fields: Record<string, Type> = {};
      let changed = false;
      for (const k in t.fields) {
        const nf = bakeCtorConstraintsInType(t.fields[k], nameToClass, bakedIds, nameToType);
        if (nf !== t.fields[k]) changed = true;
        fields[k] = nf;
      }
      if (!changed) return t;
      return { ...t, fields };
    }
    default:
      return t;
  }
}

/**
 * Compute the witness type arguments for a `TypeRep <T> v` constraint: the
 * positional args with the trailing bound variable (`v`) removed.  E.g.
 * `TypeRep Array k` → `[Array]`, so the var binds to `TypeRep Array`.
 */
function typeRepWitnessArgs(c: { typeVarName: string; positionalArgs?: Type[] }): Type[] {
  if (!c.positionalArgs || c.positionalArgs.length === 0) return [];
  const last = c.positionalArgs[c.positionalArgs.length - 1];
  const dropLast = last.tag === 'TVar' && last.name === c.typeVarName;
  return dropLast ? c.positionalArgs.slice(0, -1) : c.positionalArgs;
}

/**
 * Bake constructor-style constraints (`Pair p => ... -> p c a`) into a single
 * annotation's types, mutating it in place.  When a constraint names a known
 * type CONSTRUCTOR (builtin, `::data`, locally-annotated, or imported) rather
 * than a `::constraint` class, the constrained variable IS that constructor,
 * so `p`/`p c a` are rewritten to `Pair`/`Pair c a` and the constraint is
 * dropped.  Applied centrally to every `annotationMap` and `annotationByOffset`
 * entry so instantiation, the rigid check, the skolemizing method-body path,
 * hover, and completion all observe the same concrete type.  Bare scalar
 * constraints (var NOT used applied, e.g. `Number run => run -> LimitA run`)
 * are left intact so they keep their pending-union type-equality semantics.
 */
export function bakeCtorConstraintsOnAnnotation(engine: InferenceEngine, ann: TypeAnnotation): void {
  const cons = ann.scheme?.constraints;
  if (!cons || cons.length === 0) return;
  const kvVarNames = new Map<string, number>();
  collectKvNamesInType(ann.scheme!.type, kvVarNames);
  if (ann.receiver) collectKvNamesInType(ann.receiver, kvVarNames);
  if (ann.methodType) collectKvNamesInType(ann.methodType, kvVarNames);
  const nameToClass = new Map<string, string>();
  const nameToType = new Map<string, Type>();
  const keptConstraints = [] as typeof cons;
  // Variables that occur in the final return type keep their deferred
  // behaviour for unions, so per-call resolution stays precise
  // (e.g. `pick :: (String | Number) v => v -> v` ⇒ `pick(5) : Number`).
  const returnVarNames = new Set<string>();
  {
    const retNames = new Map<number, string>();
    collectVarNames(getReturnType(ann.scheme!.type), retNames);
    for (const nm of retNames.values()) returnVarNames.add(nm);
  }
  for (const c of cons) {
    // Structural-union constraint: `(Number | Undefined) x => … -> …`.
    // Bake `x := Number | Undefined` only when `x` never appears in the
    // return type; otherwise leave it as a deferred union constraint so
    // each call site can resolve to its precise alternative.
    if (c.unionAlternatives && c.unionAlternatives.length > 0) {
      if (!returnVarNames.has(c.typeVarName)) {
        nameToType.set(c.typeVarName, tUnion(c.unionAlternatives));
      } else {
        keptConstraints.push(c);
      }
      continue;
    }
    // TypeRep witness constraint: `TypeRep Array k => k -> …` means the
    // constrained var IS the type representative of the preceding type
    // (`k := TypeRep Array`), exposing static constructor methods (`.of`, …)
    // on it.  `TypeRep` is a witness marker, not a `::constraint` class, so
    // bake the binding here and drop the constraint.
    if (c.className === T_TYPEREP) {
      const witnessArgs = typeRepWitnessArgs(c);
      if (witnessArgs.length === 1) {
        nameToType.set(c.typeVarName, tCon(T_TYPEREP, witnessArgs));
      }
      continue;
    }
    // Saturated/partial instance constructor constraint:
    // `Array String k => k -> …` means the constrained var IS the instance
    // `Array String` — the leading positional args applied to the named
    // constructor — not the bare constructor.  Bake `k := Array String`.
    // (`Array k =>`, with no leading args, has no `positionalArgs` and falls
    // through to the bare-constructor branch below.)
    if (
      c.positionalArgs && c.positionalArgs.length >= 2 &&
      !lookupConstraint(c.className) &&
      (isBuiltinType(c.className) ||
        isDataType(c.className) ||
        engine.annotationMap.has(c.className) ||
        engine.importedConstructors.has(c.className) ||
        typeConstructorArity(c.className) > 0)
    ) {
      const last = c.positionalArgs[c.positionalArgs.length - 1];
      if (last.tag === 'TVar' && last.name === c.typeVarName) {
        const leading = c.positionalArgs.slice(0, -1);
        nameToType.set(c.typeVarName, tCon(c.className, leading));
        continue;
      }
    }
    const isKnownType =
      !lookupConstraint(c.className) &&
      (isBuiltinType(c.className) ||
        isDataType(c.className) ||
        engine.annotationMap.has(c.className) ||
        engine.importedConstructors.has(c.className) ||
        typeConstructorArity(c.className) > 0);
    // Applied constructor constraint: `Pair p => … p c a …`.
    if (isKnownType && kvVarNames.has(c.typeVarName)) {
      nameToClass.set(c.typeVarName, c.className);
      continue;
    }
    // Bare type-constraint head: `String p => p -> [p]` or `Array k => k -> k`.
    // A NULLARY type (String, Number, …) binds the var to that type itself
    // (`p := String`).  A PARAMETRIC constructor used bare (`Array k =>`)
    // denotes the *constructor*, so bind the var to its `TypeRep` witness
    // (`k := TypeRep Array`) — exposing static methods and matching the
    // explicit `TypeRep Array k =>` form.
    if (isKnownType && !c.isApplied) {
      if (typeConstructorArity(c.className) > 0) {
        nameToType.set(c.typeVarName, tCon(T_TYPEREP, [tCon(c.className, [])]));
      } else {
        nameToType.set(c.typeVarName, { tag: 'TCon', name: c.className, args: [] });
      }
      continue;
    }
    keptConstraints.push(c);
  }
  if (nameToClass.size === 0 && nameToType.size === 0) return;
  const bakedIds = new Set<number>();
  const newType = bakeCtorConstraintsInType(ann.scheme!.type, nameToClass, bakedIds, nameToType);
  if (ann.receiver) ann.receiver = bakeCtorConstraintsInType(ann.receiver, nameToClass, bakedIds, nameToType);
  if (ann.methodType) ann.methodType = bakeCtorConstraintsInType(ann.methodType, nameToClass, bakedIds, nameToType);
  ann.scheme = {
    ...ann.scheme!,
    type: newType,
    constraints: keptConstraints,
    vars: ann.scheme!.vars.filter((id) => !bakedIds.has(id)),
  };
}
