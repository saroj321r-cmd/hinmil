// ============================================================================
// Constraint-based method dispatch
// ============================================================================
// Plain language: when code calls `obj.method(…)` but the checker only knows
// `obj` as "some type satisfying constraint C" (e.g. "some Functor"), the
// method cannot be looked up on a concrete type.  Instead this file looks it
// up in the constraint's required-methods list — "every Functor has a map
// with THIS signature" — and uses that signature.
//
// Resolves `obj.method` calls when `obj` is a constraint-bound TVar / kv-TCon.
// Used by `inferMemberExpression` and friends in `expressions.ts`.
// ============================================================================

import type * as estree from '../estree';
import {
  Type,
  TVar,
  tVar,
  tCon,
  prettyTypeToString,
  kvName,
  parseKvName,
  constraintBaseName,
  collectVarNames,
} from '../hm/types';
import { Substitution } from '../hm/substitution';
import { lookupConstraint, getEffectiveMethods, ConstraintDef } from '../registries/constraintRegistry';
import { parseMethodTypeSignature, parseTypeSignature } from '../hm/typeParser';
import { renameKvInType } from '../hm/typeUtils';
import type { InferenceEngine } from './index';

/**
 * Search a kvConstraints map for constraint names that apply to a given
 * kv variable.  First tries a direct lookup by `kvVarId`, then falls back
 * to scanning all constrained TVars via substitution to find one that
 * resolved to the same kv name.
 */
export function resolveKvConstraintNames(
  kvConstraints: Map<number, string[]>,
  subst: Substitution,
  kvVarId: number,
  kvTConName: string,
): string[] | undefined {
  let cNames = kvConstraints.get(kvVarId);
  if (cNames) return cNames;

  const kv = parseKvName(kvTConName);
  if (!kv) return undefined;

  for (const [tvId, names] of kvConstraints) {
    const tvResolved = subst.apply({ tag: 'TVar' as const, id: tvId, name: '' });
    if (tvResolved.tag === 'TCon' && tvResolved.name === kvTConName) {
      return names;
    }
  }
  return undefined;
}

/**
 * Resolve the union of regular and constructor-applied constraint names that
 * apply to a kv variable.  Returns a deduplicated array (empty if none).
 */
export function collectAllKvConstraintNames(
  kvConstraints: Map<number, string[]>,
  kvConstructorConstraints: Map<number, string[]>,
  subst: Substitution,
  kvVarId: number,
  kvTConName: string,
): string[] {
  const regular = resolveKvConstraintNames(kvConstraints, subst, kvVarId, kvTConName) ?? [];
  const applied = resolveKvConstraintNames(kvConstructorConstraints, subst, kvVarId, kvTConName) ?? [];
  return [...new Set([...regular, ...applied])];
}

/**
 * Shared helper: parse a method type signature, instantiate fresh type
 * variables, unify the receiver with the target type, and record the result.
 */
function resolveConstraintInstanceMethod(
  engine: InferenceEngine,
  signature: string,
  typeVar: string,
  unifyTarget: Type,
  constraintName: string,
  methodName: string,
  node: estree.MemberExpression,
): Type {
  const parsed = parseMethodTypeSignature(signature, [typeVar]);
  const freshSubst = new Substitution();
  for (const v of parsed.scheme.vars) {
    freshSubst.set(v, tVar());
  }
  const freshReceiver = freshSubst.apply(parsed.receiver);
  const freshMethodType = freshSubst.apply(parsed.methodType);
  engine.unifyWithDiagnostic(freshReceiver, unifyTarget, node.object);
  const resultType = engine.subst.apply(freshMethodType);
  engine.recordNodeType(node.property, resultType);
  const displayObj = prettyTypeToString(engine.subst.apply(unifyTarget));
  engine.methodSignatures.set(
    node.property.start,
    `[${constraintName}] ${methodName} :: ${displayObj} ~> ${prettyTypeToString(resultType)}`,
  );
  return resultType;
}

/**
 * Look up a method on a kind-variable constrained type.  Searches the
 * constraint definitions registered for the given kind-variable id and,
 * if one of the constraints defines the requested method, instantiates
 * its type signature and unifies the receiver type.
 *
 * Returns the method type or null if no match.
 */
export function lookupConstraintMethod(
  engine: InferenceEngine,
  kvVarId: number,
  methodName: string,
  resolvedObjType: import('../hm/types').TCon,
  node: estree.MemberExpression,
): Type | null {
  let constraintNames = resolveKvConstraintNames(engine.kvConstraints, engine.subst, kvVarId, resolvedObjType.name);
  // For applied kind * constraints (e.g. Semigroup (s a)), the constraint is
  // stored in kvConstructorConstraints. Include those for instance method lookup.
  const ctorNames = resolveKvConstraintNames(engine.kvConstructorConstraints, engine.subst, kvVarId, resolvedObjType.name);
  if (ctorNames && ctorNames.length > 0) {
    const kindStarCtorNames = ctorNames.filter(cn => {
      const baseName = constraintBaseName(cn);
      const def = lookupConstraint(baseName);
      return def?.expectedKind === '*';
    });
    if (kindStarCtorNames.length > 0) {
      constraintNames = [...(constraintNames ?? []), ...kindStarCtorNames];
    }
  }
  if (!constraintNames || constraintNames.length === 0) return null;

  for (const cName of constraintNames) {
    const def = lookupConstraint(cName);
    if (!def) continue;

    const effectiveMethods = getEffectiveMethods(cName);
    const req = effectiveMethods.find(m => m.name === methodName);
    if (!req) continue;

    try {
      return resolveConstraintInstanceMethod(engine, req.signature, req.ownerTypeVar ?? def.typeVar, resolvedObjType, cName, methodName, node);
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Look up a constraint method on a plain TVar.
 * When a parameter M has type TVar(id) with constraint Monad, then M.of should
 * resolve through the constraint definition. Handles both instance methods
 * (with ~> receiver) and static/function methods (without ~>).
 */
export function lookupConstraintMethodOnTVar(
  engine: InferenceEngine,
  tvarId: number,
  methodName: string,
  constraintNames: string[],
  node: estree.MemberExpression,
): Type | null {
  for (const cName of constraintNames) {
    // Applied constraints may be stored as "Monoid (f a)" — extract base name
    const baseName = constraintBaseName(cName);
    const def = lookupConstraint(baseName);
    if (!def) continue;

    const effectiveMethods = getEffectiveMethods(baseName);
    const req = effectiveMethods.find(m => m.name === methodName);
    if (!req) continue;

    // Skip instance methods (with ~>) — those are not callable on a type
    // constructor TVar (M). Instance methods are accessed on values (m a),
    // not on the type constructor itself.
    if (req.signature.includes('~>')) continue;

    // Parse as regular function signature (e.g. "a -> m a" for of).
    // An inherited method uses its declaring constraint's variable
    // (`of :: a -> f a` from Applicative f, reached through Monad m).
    const ownerVar = req.ownerTypeVar ?? def.typeVar;
    try {
      const parsed = parseTypeSignature(req.signature, [ownerVar]);

      // Identify which parsed var corresponds to the constraint's type var
      const varNames = new Map<number, string>();
      collectVarNames(parsed.type, varNames);
      let constraintVarParsedId: number | undefined;
      for (const v of parsed.vars) {
        if (varNames.get(v) === ownerVar) {
          constraintVarParsedId = v;
          break;
        }
      }

      // Always link the constraint var to the actual TVar so that return
      // types of methods like `of :: a -> m a` stay connected to the monad
      // and argument mismatches are detected.
      const freshSubst = new Substitution();
      const kvRenameMap = new Map<string, string>();
      for (const v of parsed.vars) {
        if (v === constraintVarParsedId) {
          // Check if this is an applied constraint (e.g. Monoid (m a)).
          // For applied constraints, the constraint's type var represents the
          // full applied type (m a), so we use a kv-TCon.  For bare constraints
          // (e.g. Monoid m), it's just the TVar.
          const appliedNames = engine.kvConstructorConstraints.get(tvarId) ?? [];
          const isApplied = appliedNames.some(n => constraintBaseName(n) === baseName);
          if (isApplied) {
            freshSubst.set(v, tCon(kvName(ownerVar, tvarId), [tVar()]));
          } else {
            freshSubst.set(v, { tag: 'TVar', id: tvarId, name: ownerVar });
          }
          // Rename any kv-TCon names from the parsed type to use the actual tvarId
          kvRenameMap.set(kvName(ownerVar, v), kvName(ownerVar, tvarId));
        } else {
          freshSubst.set(v, tVar());
        }
      }

      let resultType = freshSubst.apply(parsed.type);
      if (kvRenameMap.size > 0) {
        resultType = renameKvInType(resultType, kvRenameMap);
      }

      engine.recordNodeType(node.property, resultType);
      engine.methodSignatures.set(
        node.property.start,
        `[${baseName}] ${methodName} :: ${req.signature}`,
      );
      return resultType;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Look up an instance method on a plain TVar for a kind-* constraint.
 * For constraints like `Semigroup s`, the TVar IS a concrete value, so
 * instance methods (with ~>) should resolve directly.
 */
export function lookupConstraintInstanceMethodOnTVar(
  engine: InferenceEngine,
  tvar: TVar,
  methodName: string,
  def: ConstraintDef,
  req: { name: string; signature: string; ownerTypeVar?: string },
  node: estree.MemberExpression,
): Type | null {
  try {
    return resolveConstraintInstanceMethod(engine, req.signature, req.ownerTypeVar ?? def.typeVar, tvar, def.name, methodName, node);
  } catch {
    return null;
  }
}
