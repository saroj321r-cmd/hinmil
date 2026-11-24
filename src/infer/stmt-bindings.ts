// ============================================================================
// Named-binding & function-declaration inference: annotation validation,
// display-type alignment, generative-var freshening (extracted from statements.ts)
//
// Plain language: handles giving a name a type — `const x = …` and
// `function f() { … }`.  The inferred type of the right-hand side is
// compared against any `::` annotation above it (mismatches become
// diagnostics), and the finished type is sealed into a reusable template
// (generalized) and entered into the environment under the name.
// ============================================================================

import type { InferenceEngine } from './index';

import {
  Type,
  Scheme,
  tVar,
  tUnion,
  tRecord,
  TVar,
  TCon,
  TFun,
  TRecord,
  TLabel,
  TRow,
  parseKvName,
  mono,
  AstNode,
  getReturnType,
  decomposeFunParams,
  isWildcard,
  isUnion,
  prettyTypeToString,
  canonicalizeDisplayVarsByName,
  flattenCurriedType,
  T_UNION,
  isSpread,
  isSkolem,
  containsErrorType,
} from '../hm/types';
import { TypeEnv, instantiate, instantiateWithAny, generalize } from '../hm/env';
import { unify, unifyWidening, UnificationError } from '../hm/unify';
import { neutralizeUnions, someType, eachType, hasTopLevelSpreadChain } from '../hm/typeUtils';
import { blockHasThisAssignment, hasSelfNewGuard, typeAcceptsUndefined } from './narrowing';
import { usesLenientArrowCheck } from './annotation-rigid';
import { maybeRigidCheck, hasUnknownTConDiagForScheme, expandAliases, narrowToIdentifier, annotationMismatchMessage, bindingNameFromNode } from './annotations';
import { speculate } from './helpers';
import { isDataType, isVariant } from '../registries/dataTypeRegistry';
import { getMethodNames, lookupMethod, isBuiltinType } from '../registries/methodRegistry';
import { flushDeferredMemberAccesses } from './expr-member';
import { debugLog } from '../debugLog';
import { isLocalAnnotation } from '../commentParser';
import type * as estree from '../estree';

/**
 * Collect 0-based indices of function parameters that have a JS default
 * value (Acorn `AssignmentPattern`).  Used to mark trailing parameters as
 * optional at call sites — `Path("p", [1,2])` is allowed when the
 * implementation declares `(k, r, defaultValue = undefined) => …`.
 */
function collectOptionalParamSlots(params: AstNode[] | undefined): number[] {
  if (!params || params.length === 0) return [];
  const result: number[] = [];
  for (let i = 0; i < params.length; i++) {
    if (params[i]?.type === 'AssignmentPattern') result.push(i);
  }
  return result;
}

/**
 * When true, the function is a factory/constructor for that sum type and
 * record-vs-TCon mismatches should be suppressed (the annotation is the
 * source of truth).
 */
function annotationReturnsSumType(scheme: Scheme): boolean {
  const ret = getReturnType(scheme.type);
  return ret.tag === 'TCon' && isDataType(ret.name);
}

/**
 * Check whether an annotation scheme's return type is a user-defined nominal
 * type constructor: not a builtin and not a type alias.  This covers sumtypes,
 * classes, ADT factories with `Type#method` annotations, AND plain record
 * factories that introduce a type by their annotation alone
 * (`// Box :: a -> Box a` above `x => ({ value: x })`): the record literal is
 * the runtime representation and the constructor annotation names it.
 */
function annotationReturnsNominalUserType(scheme: Scheme, typeAliases: Map<string, Type>): boolean {
  const ret = getReturnType(scheme.type);
  return ret.tag === 'TCon' && !isBuiltinType(ret.name) && !typeAliases.has(ret.name);
}

/** User type with `Type#method`/property annotations (class, ADT factory). */
function annotationReturnsTConWithMethods(scheme: Scheme): boolean {
  const ret = getReturnType(scheme.type);
  return ret.tag === 'TCon' && !isBuiltinType(ret.name) && getMethodNames(ret.name).length > 0;
}

/**
 * Check whether the sumtype factory guard should suppress type checking.
 * Only suppress when:
 *  1. The annotation's return type is a sumtype or a TCon with registered
 *     methods (a nominal type known only from the annotation accepts ONLY
 *     a record literal), AND
 *  2. The inferred return type is:
 *     - TRecord  (the body returns a record literal — the runtime representation), or
 *     - TVar     (return type not yet resolved, e.g. helper defined later), or
 *     - a sumtype TCon (body delegates to another function returning the
 *       same or another registered sumtype).
 * TCon primitives (Number, String, Void, …) and TFun are real mismatches.
 */
function shouldSuppressSumTypeCheck(scheme: Scheme, inferredType: Type, typeAliases: Map<string, Type>): boolean {
  if (!annotationReturnsSumType(scheme) && !annotationReturnsNominalUserType(scheme, typeAliases)) return false;
  let inferredReturn = getReturnType(inferredType);
  // A body checked against rigid skolems returns the parameter's skolem
  // where an unannotated body would return a free var — same leniency.
  if (isSkolem(inferredReturn)) inferredReturn = tVar();
  // A nominal type known ONLY from this annotation (no sumtype, no
  // `Type#method`s) is introduced by a record literal and nothing else:
  // returning a parameter (`a => a` for `a -> Box a`) or a primitive is a
  // real mismatch.
  if (!annotationReturnsSumType(scheme) && !annotationReturnsTConWithMethods(scheme)) {
    return inferredReturn.tag === 'TRecord';
  }
  if (inferredReturn.tag === 'TVar'
      || (inferredReturn.tag === 'TCon' && isDataType(inferredReturn.name))) {
    return true;
  }
  // Empty-body constructor trust: a stub/empty body infers a Void/Undefined
  // return (e.g. `function Nothing() {}`), but the annotation legitimately
  // declares a data/sum type return (`() -> Maybe a`). The annotation is the
  // source of truth for such constructors, so suppress the mismatch.
  if (inferredReturn.tag === 'TCon'
      && (inferredReturn.name === 'Void' || inferredReturn.name === 'Undefined')) {
    return true;
  }
  if (inferredReturn.tag === 'TRecord') {

    // Suppress unification for factory functions returning a TCon with
    // registered methods so that checkMissingRecordFields can produce a
    // more helpful diagnostic when fields are missing, instead of the
    // generic "Cannot unify {} with Type" error.
    return true;
  }
  return false;
}

/**
 * When the sumtype factory guard suppressed the full type check (inferred
 * return is TRecord with all required keys), validate that each field's type
 * matches the registered method/property signature.
 *
 * Uses the instantiated expectedType to get the correct fresh type variables
 * for the sumtype's type parameters, then builds an expected record from the
 * registered method factories and unifies it against the inferred record.
 *
 * Union types (e.g. `a | e` from `Either2#value :: Either2 e a ~> a | e`) are
 * replaced with fresh TVars before unifying so that variant-specific property
 * types don't cause infinite-type errors against the general union.
 */
function validateSumTypeFactoryFields(
  engine: InferenceEngine,
  scheme: Scheme,
  inferredType: Type,
  expectedType: Type | undefined,
  node: AstNode,
): void {
  const inferredReturn = getReturnType(inferredType);
  if (inferredReturn.tag !== 'TRecord') return;

  const annReturn = getReturnType(scheme.type);
  if (annReturn.tag !== 'TCon') return;

  const typeName = annReturn.name;
  const methodNames = getMethodNames(typeName);
  if (methodNames.length === 0) return;

  // Use the instantiated expected type to get fresh type vars for type params
  const expReturn = expectedType ? getReturnType(expectedType) : null;
  const typeArgs = (expReturn?.tag === 'TCon' ? expReturn.args : []) as Type[];

  const expectedFields: Record<string, Type> = {};
  for (const mn of methodNames) {
    const entry = lookupMethod(typeName, mn);
    if (entry && !entry.isStatic) {
      expectedFields[mn] = neutralizeUnions(entry.factory(typeArgs));
    }
  }

  const expectedRecord = tRecord(expectedFields);
  engine.unifyWithDiagnostic(inferredReturn, expectedRecord, node);
}

/** A record field that may be absent from an object literal: its type
 *  admits `Undefined` (`T | Undefined`). */
function isOptionalRecordField(engine: InferenceEngine, fieldType: Type): boolean {
  return typeAcceptsUndefined(engine.subst, fieldType);
}

/**
 * Check whether a function's inferred return type (record) is missing fields
 * compared to the annotation's return type (after alias expansion).
 * Produces a diagnostic listing the missing fields.
 */
function checkMissingRecordFields(
  engine: InferenceEngine,
  inferredType: Type,
  annotationScheme: Scheme,
  node: AstNode,
): void {
  const inferredReturn = getReturnType(engine.subst.apply(inferredType));
  if (inferredReturn.tag !== 'TRecord') return;

  const annotReturn = getReturnType(annotationScheme.type);
  const expandedReturn = expandAliases(engine.typeAliases, annotReturn, undefined, engine.typeAliasVars);

  let expectedKeys: string[];
  let typeName: string;

  if (expandedReturn.tag === 'TRecord') {
    expectedKeys = Object.keys(expandedReturn.fields);
    typeName = expandedReturn.alias ?? prettyTypeToString(expandedReturn);
  } else if (expandedReturn.tag === 'TCon' && !isBuiltinType(expandedReturn.name) && getMethodNames(expandedReturn.name).length > 0) {
    // For TCon return types with registered methods (sumtype, classes, ADT
    // factories), use registered instance methods as expected fields
    expectedKeys = getMethodNames(expandedReturn.name).filter(n => {
      const entry = lookupMethod(expandedReturn.name, n);
      return !entry?.isStatic;
    });
    typeName = expandedReturn.name;
  } else {
    return;
  }

  if (expectedKeys.length === 0) return;

  const inferredKeys = new Set(Object.keys(inferredReturn.fields));
  // A field typed `T | Undefined` may be left out (reading it gives
  // `undefined`), as for an argument (`findMissingRecordFields`).
  const optionalKeys = expandedReturn.tag === 'TRecord'
    ? new Set(expectedKeys.filter(k => isOptionalRecordField(engine, expandedReturn.fields[k])))
    : new Set<string>();
  const missingKeys = expectedKeys.filter(k => !inferredKeys.has(k) && !optionalKeys.has(k));

  if (missingKeys.length > 0) {
    engine.addDiag(
      `Missing record fields: ${missingKeys.map(k => `'${k}'`).join(', ')} required by ${typeName}`,
      narrowToIdentifier(node),
    );
  }
}

/**
 * Check if a type contains any wildcard ('*' or '*:name') anywhere.
 * When `vars` is given, only check if TVars with those ids would be
 * wildcards (used to inspect the annotation's original type shape).
 */
function wildcardInType(t: Type, vars?: ReadonlySet<number>): boolean {
  return someType(t, n => {
    if (!vars) return isWildcard(n);
    if (n.tag === 'TVar' || n.tag === 'TRow') return vars.has(n.id);
    if (n.tag === 'TLabel' && n.kind === 'var') return vars.has(n.id);
    return false;
  });
}

/**
 * Infer and verify a simple named variable binding that has an initialiser.
 * Handles annotation lookup, expected-type setup, body inference,
 * polymorphic / concrete rigid checks, and pending curry / conditional-return
/**
 * Collect names of unknown type constructors that already have a
 * "Unknown type constructor 'X'" diagnostic recorded.  Used by
 * `emitAnnotationUnify` so we don't double-report a mismatch whose
 * cause is already a missing type.
 */
function collectUnknownTConNames(diagnostics: { message: string }[]): Set<string> {
  const names = new Set<string>();
  for (const d of diagnostics) {
    const m = d.message.match(/Unknown type constructor '([^']+)'/);
    if (m) names.add(m[1]);
  }
  return names;
}

/** Whether a type mentions any of the given (unknown) TCon names. */
function typeMentions(t: Type, names: Set<string>): boolean {
  if (names.size === 0) return false;
  let found = false;
  eachType(t, n => { if (n.tag === 'TCon' && names.has(n.name)) found = true; });
  return found;
}

/**
 * Run a unify(initType, annotatedType) inside annotation validation and
 * emit the unified `Type mismatch: '<name>' has type ...` diagnostic on
 * failure.  Suppresses the diagnostic when the failing sub-types reference
 * an unknown type constructor that already has its own diagnostic — the
 * mismatch is then a consequence of the missing type, not a real error.
 */
function emitAnnotationUnify(
  engine: InferenceEngine,
  initType: Type,
  annotatedType: Type,
  decl: AstNode,
): void {
  // Closed-vs-record annotations: surface fields declared in the annotation

  // that the inferred value doesn't actually carry.  Done BEFORE unify so
  // that an open record's row variable hasn't yet absorbed the surplus.
  // - inferred closed + annotation closed: lenient unifier won't flag this
  // - inferred open   + annotation closed: row variable would silently
  //   absorb annotation-only fields ("the row could contain x"), but the
  //   value clearly doesn't, so we flag it explicitly.
  {
    const r1 = engine.resolve(initType);
    const r2 = engine.resolve(annotatedType);
    if (r1.tag === 'TRecord' && r2.tag === 'TRecord' && !r2.rest) {
      const inferredKeys = new Set(Object.keys(r1.fields));
      const missing = Object.keys(r2.fields).filter(k => !inferredKeys.has(k) && !isOptionalRecordField(engine, r2.fields[k]));
      if (missing.length > 0) {
        engine.addDiag(
          `Missing record fields: ${missing.map(k => `'${k}'`).join(', ')} required by ${prettyTypeToString(r2)}`,
          narrowToIdentifier(decl),
        );
      }
    }
  }
  try {
    const s = unify(engine.resolve(initType), engine.resolve(annotatedType));
    engine.subst.mergeFrom(s);
  } catch (e) {
    if (!(e instanceof UnificationError)) throw e;
    const r1 = engine.resolve(initType);
    const r2 = engine.resolve(annotatedType);
    if (containsErrorType(r1) || containsErrorType(r2)) return;
    // TCon → callable overload promotion.
    // When the inferred type is a bare TCon (e.g. `QueryTag b` returned by a
    // call to `Organisation([...])`) and that constructor has an overloaded
    // callable form declared in the annotation map or imported sidecar
    // (e.g. `QueryTag :: a -> RTask r e [b]`), accept the user's annotation
    // when it unifies against ANY of those callable branches.  This mirrors
    // the constructor-as-callable bridge in `inferCallExpression`.
    if (r1.tag === 'TCon' && /^[A-Z]/.test(r1.name)) {
      // Honour the file-local annotation only.  A sidecar / globals /
      // `::types` entry for a constructor name owned by a different module
      // must not promote this file's TCon into a callable shape.
      const localAnn = engine.annotationMap.get(r1.name);
      const localScheme = isLocalAnnotation(localAnn) ? localAnn?.scheme : undefined;
      const importedScheme = engine.importedConstructors.get(r1.name);
      const scheme = localScheme ?? importedScheme;
      if (scheme) {
        const inst = instantiate(scheme);
        const candidates: Type[] = inst.tag === 'TCon' && inst.name === T_UNION
          ? inst.args
          : [inst];
        for (const cand of candidates) {
          try {
            const s = unify(cand, r2);
            engine.subst.mergeFrom(s);
            return;
          } catch (err) {
            if (!(err instanceof UnificationError)) throw err;
          }
        }
      }
    }
    // Fold-completion leniency (mirrors unifyWithDiagnostic): a TOP-LEVEL
    // spread arrow chain reconciled against a non-function annotation stands
    // for "the chain once fully applied" — retry with the chain's terminal
    // result before surfacing a mismatch.
    {
      const pair =
        r1.tag === 'TFun' && hasTopLevelSpreadChain(r1) && r2.tag !== 'TFun' ? [r1, r2] :
        r2.tag === 'TFun' && hasTopLevelSpreadChain(r2) && r1.tag !== 'TFun' ? [r2, r1] :
        null;
      if (pair) {
        try {
          const s = unify(flattenCurriedType(pair[0]).result, pair[1]);
          engine.subst.mergeFrom(s);
          return;
        } catch (err) {
          if (!(err instanceof UnificationError)) throw err;
          // fall through to normal diagnostic path
        }
      }
    }
    // A narrower union where a wider one is declared: a function that
    // returns `ReactElement | Null` satisfies `… -> ReactElement | String |
    // Null` (covariant result).  Symmetric unification rejects two different
    // unions, so check the direction here, at the annotation.
    {
      const widened = unifyWidening(r1, r2);
      if (widened) {
        engine.subst.mergeFrom(widened);
        return;
      }
    }
    const unknownNames = collectUnknownTConNames(engine.diagnostics);
    if (typeMentions(e.left, unknownNames) || typeMentions(e.right, unknownNames)) return;
    if (containsErrorType(r1) || containsErrorType(r2)) return;
    engine.addDiag(
      annotationMismatchMessage(bindingNameFromNode(decl), r1, r2),
      narrowToIdentifier(decl),
    );
  }
}



/**
 * Validate the inferred type of an annotated binding against its annotation.
 * Handles both polymorphic (quantified) and concrete annotations:
 * wildcard return checks, rigid checks, union narrowing, sum-type factory
 * field validation, and missing record field checks.
 */
function validateAnnotatedBindingType(
  engine: InferenceEngine,
  scheme: Scheme,
  initType: Type,
  expectedType: Type | undefined,
  decl: estree.VariableDeclarator,
  naturalRecordFields: Set<string> | null = null,
): void {
  // Closed-record annotations: when a trial inference revealed the
  // value's natural fields, complain about annotation-only fields up
  // front (the expected-type-driven inference would otherwise have
  // silently absorbed them into a row variable).
  if (naturalRecordFields && expectedType) {
    const annReturn = getReturnType(expectedType);
    if (annReturn.tag === 'TRecord' && !annReturn.rest) {
      const missing = Object.keys(annReturn.fields).filter(k => !naturalRecordFields.has(k) && !isOptionalRecordField(engine, annReturn.fields[k]));
      if (missing.length > 0) {
        engine.addDiag(
          `Missing record fields: ${missing.map(k => `'${k}'`).join(', ')} required by ${prettyTypeToString(annReturn)}`,
          narrowToIdentifier(decl),
        );
      }
    }
  }
  if (scheme.vars.length > 0) {
    // Wildcard return check: when instantiateWithAny was used, a quantified
    // var in param position (e.g. `a` in `a -> String`) becomes a wildcard.
    // If the implementation returns that wildcard (e.g. `return x`) the
    // unifier silently accepts it against the concrete return type.
    // Detect this: if the annotation return type is concrete but the
    // inferred return type (before substitution flattened it) still
    // contains a wildcard, then the implementation doesn't actually
    // produce the declared return type.
    const hasConstraints = scheme.constraints && scheme.constraints.length > 0;
    if (!hasConstraints && scheme.vars.length > 0) {
      const annReturnType = getReturnType(scheme.type);
      const inferredReturnType = getReturnType(initType);
      const resolvedReturn = engine.subst.apply(inferredReturnType);
      if (!wildcardInType(annReturnType, new Set(scheme.vars)) && wildcardInType(resolvedReturn)) {
        const expectedReturn = getReturnType(instantiate(scheme));
        if (!containsErrorType(resolvedReturn) && !containsErrorType(expectedReturn)
            // Sumtype factories: the annotation is the source of truth and
            // the body typically returns a record with wildcard fields from
            // unannotated params (e.g. `Object.create(proto)` in Param.js).
            && !annotationReturnsSumType(scheme)) {
          const subject = bindingNameFromNode(decl);
          const subjectStr = subject ? `'${subject}'` : 'value';
          engine.addDiag(
            `Type mismatch: ${subjectStr} returns a generic value but annotation expects '${prettyTypeToString(expectedReturn)}'`,
            narrowToIdentifier(decl),
          );
        }
      }
    }
    // Polymorphic annotation — run rigid check when appropriate.
    // Skip for factory functions whose return type is a sumtype TCon —
    // the returned record literal IS the runtime representation and the
    // annotation is the source of truth.
    if (hasUnknownTConDiagForScheme(engine.diagnostics, scheme)) {
      // Annotation references unknown type constructors — skip all
      // mismatch checks; the "unknown type constructor" diagnostic is
      // sufficient.
    } else if (!shouldSuppressSumTypeCheck(scheme, initType, engine.typeAliases)) {
      const isFunctionInit = decl.init
        && (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression');
      // A function BUILT by a call (`const f = curry ((a, b) => …)`,
      // `compose (g) (h)`) is checked as rigidly as a literal arrow: its
      // annotation must be an instance of what the call produces, so a
      // signature like `tap :: (a -> b) -> a -> b` for a body that returns its
      // second argument is reported instead of unified away.
      const isCallBuiltFunction = decl.init?.type === 'CallExpression'
        && engine.subst.apply(initType).tag === 'TFun'
        && scheme.type.tag === 'TFun';
      if ((isFunctionInit || isCallBuiltFunction) && !usesLenientArrowCheck(scheme)) {
        // Same rigid check as `function` declarations.
        engine.checkRigid(initType, scheme, decl);
      } else {
        maybeRigidCheck({ subst: engine.subst, typeAliases: engine.typeAliases, diagnostics: engine.diagnostics, addDiag: engine.boundAddDiag, aliasVars: engine.typeAliasVars }, initType, scheme, decl);
      }

      // Catch trivially-broken bodies that the rigid check skips for
      // spread-annotated polymorphic functions: when the annotation's
      // immediate return type is itself a function but the body returns
      // a concrete non-function value (e.g. an empty block returning `Void`).
      const annOuterReturn = scheme.type.tag === 'TFun' ? scheme.type.result : scheme.type;
      const inferredAppliedInit = engine.subst.apply(initType);
      const inferredOuterReturn = inferredAppliedInit.tag === 'TFun'
        ? engine.subst.apply(inferredAppliedInit.result)
        : inferredAppliedInit;
      if (annOuterReturn.tag === 'TFun'
          && inferredOuterReturn.tag === 'TCon'
          && (inferredOuterReturn.name === 'Void' || inferredOuterReturn.name === 'Undefined')
          && !engine.diagnostics.some(d => d.message.startsWith('Type mismatch:'))) {
        const annotatedType = expectedType ?? instantiate(scheme);
        if (!containsErrorType(inferredAppliedInit) && !containsErrorType(annotatedType)) {
          engine.addDiag(
            annotationMismatchMessage(bindingNameFromNode(decl), inferredAppliedInit, annotatedType),
            narrowToIdentifier(decl),
          );
        }
      }

      // When an infinite type error was suppressed during constrained
      // annotation body inference, the body's usage of a parameter
      // conflicts with its declared annotation type (e.g. annotation says
      // `a -> b` but a constraint method requires `a -> m b`).  The rigid
      // check can't catch this because the annotation drives inference,
      // making the inferred type match trivially.
      if (hasConstraints && engine.infiniteTypeSuppressedDuringAnnotation) {
        const annotatedType = expectedType ?? instantiate(scheme);
        const inferredApplied = engine.subst.apply(initType);
        if (!containsErrorType(inferredApplied) && !containsErrorType(annotatedType)) {
          engine.addDiag(
            annotationMismatchMessage(bindingNameFromNode(decl), inferredApplied, annotatedType),
            narrowToIdentifier(decl),
          );
        }
      }
      // For sumtype factory annotations that weren't suppressed (e.g.
      // body returns a primitive instead of a record), also unify to
      // produce the unified mismatch diagnostic.
      if (annotationReturnsSumType(scheme)) {
        const annotatedType = expectedType ?? instantiate(scheme);
        emitAnnotationUnify(engine, initType, annotatedType, decl);
      }
    } else {
      validateSumTypeFactoryFields(engine, scheme, initType, expectedType, decl);
    }
  } else {
    // Concrete annotation — still verify inferred matches.
    // Skip for factory functions that return a sumtype TCon.
    // (Note: per-failure suppression for unknown TCons is handled by
    // `emitAnnotationUnify` so a real mismatch in an unrelated part of
    // the type still fires even when an alias references an unknown type.)
    if (!shouldSuppressSumTypeCheck(scheme, initType, engine.typeAliases)) {
      const annotatedType = expectedType ?? instantiate(scheme);
      // Detect unsafe union narrowing: the inferred type is a union but the
      // annotation is a non-union concrete type that matches only a subset.
      // This is reported up-front because tryAutoUnion may otherwise let
      // unification silently pick a matching member.
      const resolvedInit = engine.subst.apply(initType);
      if (isUnion(resolvedInit) && !isUnion(annotatedType)
          && assertsPresentLookup(engine, decl, resolvedInit, annotatedType)) {
        // The annotation states that a lookup did not miss (see
        // `assertsPresentLookup`): the binding has the annotated type.
      } else if (isUnion(resolvedInit) && !isUnion(annotatedType)) {
        if (!containsErrorType(resolvedInit) && !containsErrorType(annotatedType)) {
          engine.addDiag(
            annotationMismatchMessage(bindingNameFromNode(decl), resolvedInit, annotatedType),
            narrowToIdentifier(decl),
          );
        }
      } else {
        emitAnnotationUnify(engine, initType, annotatedType, decl);
      }
    } else {
      validateSumTypeFactoryFields(engine, scheme, initType, expectedType, decl);
    }
  }
  // Check for missing record fields in the return type
  checkMissingRecordFields(engine, initType, scheme, decl);
}

/**
 * Validate a `::narrow` type-predicate against the JS function it is attached
 * to.  The narrowed parameter is always the last curried parameter (resolved
 * at parse time), so the only remaining runtime check is that a `[k]` label
 * referenced by the narrowed type is supplied by some signature parameter.
 */
function resolveNarrowPredicate(
  engine: InferenceEngine,
  annotation: { scheme?: Scheme | null; narrowLoc?: { start: number; end: number }; commentStart: number; commentEnd: number },
): void {
  const pred = annotation.scheme?.typePredicate;
  if (!pred) return;
  const loc = annotation.narrowLoc ?? { start: annotation.commentStart, end: annotation.commentEnd };

  // The narrowed type references a label `[k]` but no signature parameter
  // supplies its value.
  if (pred.keyVarName && pred.keyParamIndex === undefined) {
    engine.addDiag(
      `::narrow label '[${pred.keyVarName}]' does not match any parameter of this function`,
      loc,
    );
  }
}

/**
 * The function expression produced by a thunk body — either an expression-bodied
 * arrow (`() => g`) or a block whose (last) `return` yields a function
 * (`() => { …; return g; }`).  Returns undefined when the thunk does not
 * directly return a function.
 */
function returnedFunctionNode(body: AstNode | undefined): AstNode | undefined {
  if (!body) return undefined;
  if (body.type === 'ArrowFunctionExpression' || body.type === 'FunctionExpression') {
    return body;
  }
  if (body.type === 'BlockStatement') {
    const stmts = (body as estree.BlockStatement).body as AstNode[];
    for (let i = stmts.length - 1; i >= 0; i--) {
      const s = stmts[i];
      if (s.type === 'ReturnStatement') {
        const arg = (s as estree.ReturnStatement).argument as AstNode | null | undefined;
        return arg && (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression')
          ? arg
          : undefined;
      }
    }
  }
  return undefined;
}

/**
 * Resolve the function node whose parameter chain an overload-union display
 * should annotate.  Normally this is the initializer itself (a direct arrow /
 * function), but for an IIFE — `const f = (() => … return g)()` — the relevant
 * function is the one the thunk RETURNS, so descend through a zero-arg call of
 * a zero-param thunk to its returned function expression.
 */
function effectiveAnnotatedFunctionNode(init: AstNode | undefined): AstNode | undefined {
  if (!init) return undefined;
  if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
    return init;
  }
  if (init.type === 'CallExpression') {
    const call = init as estree.CallExpression;
    const callee = call.callee as AstNode;
    if ((callee.type === 'ArrowFunctionExpression' || callee.type === 'FunctionExpression')
        && (callee as unknown as estree.Function).params.length === 0
        && call.arguments.length === 0) {
      return returnedFunctionNode((callee as unknown as estree.Function).body as AstNode);
    }
  }
  return undefined;
}

/**
 * Align a freshly-instantiated *display* type's kv-encoded constraint-constructor
 * heads (the higher-kinded constraint variable, e.g. `Category c`) with those of
 * the *body* instantiation, so inner bindings that reference the body's
 * constraint variable render with the SAME display letter as the enclosing
 * function's recorded (scope) type.
 *
 * An annotated function is instantiated twice: once for body inference
 * (`expectedType`) and once for the recorded node/display type.  The two
 * instantiations allocate independent fresh ids, so a body binding such as
 * `const idd = id(C)` (whose category head is the body's `$kv:c:377`) is
 * pretty-printed with a *different* letter than the enclosing function's
 * recorded head (`$kv:c:398`).  Renaming the display type's kv head onto the
 * body id reunites them.
 *
 * The kv-encoded constructor head (the constraint variable, e.g. `c` from the
 * `TypeRep c` parameter) is aligned, AND every plain type-variable / row-variable
 * is aligned onto the body id at the structurally-corresponding position.  This
 * makes the recorded scope type use the SAME variable identities as the body, so
 * an inner binding whose type shares a variable with the enclosing function (a
 * PARAMETRIC variable — e.g. `noVal = map(f)(u) :: f b` where `b` is `f`'s
 * codomain) renders with the shared display letter.
 *
 * A callee's *generative* result variable (one introduced from no argument, e.g.
 * the `a` of `id :: Category c => TypeRep c -> c a a`) must still render as its
 * OWN distinct letter (`idd :: Category c => c b b`, not `c a a`).  That is NOT
 * handled here — after unification a generative variable may share the same id as
 * an enclosing variable — but by per-binding generative freshening at the call
 * site (see `freshenGenerativeResultVars`).
 *
 * Returns `from` with its kv-encoded TCon head names and plain var ids renamed to
 * the structurally-corresponding ones in `bodyType`, or `null` when the two types
 * are not structurally identical — i.e. body inference specialized the
 * annotation — in which case the caller keeps the untouched display type.
 */
function alignDisplayVarIds(from: Type, bodyType: Type): Type | null {
  const kvMap = new Map<string, string>();
  // Maps a display-instance var/row id onto the structurally-corresponding body
  // node, so the recorded scope type adopts the body's variable identities.
  const varMap = new Map<number, Type>();

  const collect = (a: Type, b: Type): boolean => {
    // A plain annotation type-variable can be specialized to a higher-kinded
    // (kv-encoded) variable in the body — e.g. `f` appears as `TypeRep f` (a
    // bare TVar in the display instance) but is used as `f a` elsewhere, so body
    // inference resolves it to `$kv:f:ID`.  Align the display var onto the body's
    // kv node so the recorded scope type adopts the body's higher-kinded identity
    // (otherwise the tag mismatch below aborts the whole alignment and inner
    // bindings that reference the kv head render with divergent letters).
    if (a.tag === 'TVar' && b.tag === 'TCon' && parseKvName(b.name)) {
      varMap.set(a.id, b);
      return true;
    }
    if (a.tag !== b.tag) return false;
    switch (a.tag) {
      case 'TVar': {
        const bv = b as TVar;
        if (a.id !== bv.id) varMap.set(a.id, bv);
        return true;
      }
      case 'TRow': {
        const br = b as Extract<Type, { tag: 'TRow' }>;
        if (a.id !== br.id) varMap.set(a.id, br);
        return true;
      }
      case 'TLabel': {
        const bl = b as TLabel;
        if (a.kind !== bl.kind) return false;
        if (a.kind === 'lit') return a.value === (bl as Extract<TLabel, { kind: 'lit' }>).value;
        return true;
      }
      case 'TCon': {
        const bc = b as TCon;
        const ak = parseKvName(a.name);
        const bk = parseKvName(bc.name);
        if (ak && bk) {
          if (ak.varName !== bk.varName) return false;
          if (a.name !== bc.name) kvMap.set(a.name, bc.name);
        } else if (a.name !== bc.name) {
          return false;
        }
        if (a.args.length !== bc.args.length) return false;
        return a.args.every((x, i) => collect(x, bc.args[i]));
      }
      case 'TFun': {
        const bf = b as TFun;
        return collect(a.param, bf.param) && collect(a.result, bf.result);
      }
      case 'TRecord': {
        const br = b as TRecord;
        const aKeys = Object.keys(a.fields);
        const bKeys = Object.keys(br.fields);
        if (aKeys.length !== bKeys.length) return false;
        for (const k of aKeys) {
          if (!(k in br.fields)) return false;
          if (!collect(a.fields[k], br.fields[k])) return false;
        }
        if (!!a.rest !== !!br.rest) return false;
        if (a.rest && br.rest && !collect(a.rest, br.rest)) return false;
        if ((a.labelFields?.length ?? 0) !== (br.labelFields?.length ?? 0)) return false;
        if (a.labelFields && br.labelFields) {
          for (let i = 0; i < a.labelFields.length; i++) {
            if (!collect(a.labelFields[i].label, br.labelFields[i].label)) return false;
            if (!collect(a.labelFields[i].type, br.labelFields[i].type)) return false;
          }
        }
        return true;
      }
    }
    return false;
  };

  if (!collect(from, bodyType)) return null;
  if (kvMap.size === 0 && varMap.size === 0) return from;

  const rename = (t: Type): Type => {
    switch (t.tag) {
      case 'TVar': {
        const mapped = varMap.get(t.id);
        return mapped ? mapped : t;
      }
      case 'TRow': {
        const mapped = varMap.get(t.id);
        return mapped ? mapped : t;
      }
      case 'TCon': {
        const name = kvMap.get(t.name) ?? t.name;
        return { ...t, name, args: t.args.map(rename) };
      }
      case 'TFun':
        return { ...t, param: rename(t.param), result: rename(t.result) };
      case 'TRecord': {
        const fields: Record<string, Type> = {};
        for (const k of Object.keys(t.fields)) fields[k] = rename(t.fields[k]);
        const out: TRecord = { ...t, fields };
        if (t.rest) out.rest = rename(t.rest) as TVar | TRow;
        if (t.labelFields) {
          out.labelFields = t.labelFields.map(lf => ({
            label: rename(lf.label) as TLabel,
            type: rename(lf.type),
          }));
        }
        return out;
      }
    }
    return t;
  };

  return rename(from);
}

/** Collect all type-, row- and label-variable ids reachable in `t`. */
function collectAllVarIds(t: Type, out: Set<number>): void {
  switch (t.tag) {
    case 'TVar': out.add(t.id); return;
    case 'TRow': out.add(t.id); return;
    case 'TLabel': if (t.kind === 'var') out.add((t as Extract<TLabel, { kind: 'var' }>).id); return;
    case 'TCon': t.args.forEach(a => collectAllVarIds(a, out)); return;
    case 'TFun': collectAllVarIds(t.param, out); collectAllVarIds(t.result, out); return;
    case 'TRecord':
      for (const k in t.fields) collectAllVarIds(t.fields[k], out);
      if (t.rest) collectAllVarIds(t.rest, out);
      if (t.labelFields) for (const lf of t.labelFields) {
        collectAllVarIds(lf.label, out);
        collectAllVarIds(lf.type, out);
      }
      return;
  }
}

/**
 * Per-binding *generative* result-variable freshening for the DISPLAY type of a
 * binding whose initializer is a (possibly curried) call `x = f(a)(b)…`.
 *
 * A callee's type variable is PARAMETRIC when it occurs in one of the callee's
 * parameters (it flows in from an argument — e.g. `b` in
 * `map :: Functor f => (a -> b) -> f a -> f b`, which is `f`'s codomain), and
 * GENERATIVE when it occurs ONLY in the callee's result (it is introduced from
 * no argument — e.g. `a` in `id :: Category c => TypeRep c -> c a a`).
 *
 * Parametric variables legitimately unify with — and should render with the same
 * display letter as — the enclosing scope (handled by `alignDisplayVarIds`).
 * Generative variables must render as their OWN fresh letters even though
 * unification may have collapsed them onto an enclosing variable's id (e.g.
 * `id`'s `a` unifies onto the law's `a` via the kv-arity TypeRep rule, yet
 * `idd = id(C)` must still hover as `Category c => c b b`, not `c a a`).
 *
 * We determine generativity from the callee's pristine SCHEME (before body
 * unification, where parameters and result are still cleanly separable), then
 * structurally map the generative scheme variables onto the binding's resolved
 * type and replace those positions with fresh display variables.  Returns the
 * (possibly rewritten) display type; on any structural mismatch it returns
 * `resolved` unchanged.
 */
function freshenGenerativeResultVars(
  engine: InferenceEngine,
  init: AstNode | undefined,
  resolved: Type,
  env: TypeEnv,
): Type {
  if (!init || init.type !== 'CallExpression') return resolved;

  // Walk the (curried) call chain to the base callee, counting total arguments.
  let numArgs = 0;
  let cur: AstNode = init;
  while (cur.type === 'CallExpression') {
    numArgs += (cur as estree.CallExpression).arguments.length;
    cur = (cur as estree.CallExpression).callee as AstNode;
  }
  if (cur.type !== 'Identifier') return resolved;
  const calleeName = (cur as estree.Identifier).name;

  const scheme = env.lookup(calleeName) ?? engine.annotationMap.get(calleeName)?.scheme;
  if (!scheme) return resolved;

  // Candidate overload branches: a Union of TFun branches, else the type itself.
  const branches: Type[] = scheme.type.tag === 'TCon' && scheme.type.name === T_UNION
    ? scheme.type.args.filter(a => a.tag === 'TFun')
    : [scheme.type];

  for (const branch of branches) {
    const { params, result } = flattenCurriedType(branch);
    if (numArgs > params.length) continue;

    // Generative scheme vars: in the final result but in NO parameter.
    const paramVars = new Set<number>();
    params.forEach(p => collectAllVarIds(p, paramVars));
    const resultVars = new Set<number>();
    collectAllVarIds(result, resultVars);
    const generative = new Set([...resultVars].filter(v => !paramVars.has(v)));
    if (generative.size === 0) continue;

    // The binding's type corresponds to the scheme tail after `numArgs` params.
    let tail: Type = branch;
    for (let i = 0; i < numArgs; i++) {
      if (tail.tag !== 'TFun') { tail = branch; break; }
      tail = tail.result;
    }

    // Structurally align the scheme tail with the resolved binding type; at each
    // generative-variable position emit a fresh display variable (one per
    // distinct scheme variable, so `c a a` stays `c b b`).
    const freshFor = new Map<number, Type>();
    let ok = true;
    const build = (s: Type, r: Type): Type => {
      if (!ok) return r;
      if (s.tag === 'TVar' && generative.has(s.id)) {
        let f = freshFor.get(s.id);
        if (!f) { f = tVar(); freshFor.set(s.id, f); }
        return f;
      }
      if (s.tag === 'TVar' || s.tag === 'TRow' || s.tag === 'TLabel') return r;
      if (s.tag !== r.tag) { ok = false; return r; }
      switch (s.tag) {
        case 'TCon': {
          const rc = r as TCon;
          const sk = parseKvName(s.name);
          const rk = parseKvName(rc.name);
          const headOk = (sk && rk) ? sk.varName === rk.varName : s.name === rc.name;
          if (!headOk || s.args.length !== rc.args.length) { ok = false; return r; }
          return { ...rc, args: s.args.map((a, i) => build(a, rc.args[i])) };
        }
        case 'TFun': {
          const rf = r as TFun;
          return { ...rf, param: build(s.param, rf.param), result: build(s.result, rf.result) };
        }
        case 'TRecord': {
          const rr = r as TRecord;
          const sKeys = Object.keys(s.fields);
          if (sKeys.length !== Object.keys(rr.fields).length) { ok = false; return r; }
          const fields: Record<string, Type> = {};
          for (const k of sKeys) {
            if (!(k in rr.fields)) { ok = false; return r; }
            fields[k] = build(s.fields[k], rr.fields[k]);
          }
          return { ...rr, fields };
        }
      }
      return r;
    };

    const built = build(tail, resolved);
    if (ok && freshFor.size > 0) return built;
  }
  return resolved;
}

/**
 * Infer type of a named variable binding (e.g. `const x = expr`).
 *
 * Handles annotation lookup, self-recursion env extension, annotation
 * validation (wildcard return, rigid check, concrete unify), scheme
 * generalization, and isCurriedResult / conditionalReturn
 * flag propagation.
 *
 * Called from `inferVariableDeclaration` for every declarator of the form
 *   `const/let/var name = init`
 * where `name` is a plain identifier (not a destructuring pattern).
 */
export function inferNamedBinding(
  engine: InferenceEngine,
  name: string,
  decl: estree.VariableDeclarator,
  env: TypeEnv,
  nodeKind: string,
  parentStart?: number,
): { scheme: Scheme; displayType: Type } {
  // Check for HM annotation on this variable.
  // Verify the annotation belongs to this specific declaration by checking
  // that nodeStart falls within the declaration's range.  This prevents
  // annotations for same-named variables in different scopes from leaking.
  const rangeStart = parentStart ?? decl.start;
  // Track `const f = function* () {}` generators by name so call sites can
  // wrap their result in `Generator <element>`.
  if (decl.init?.type === 'FunctionExpression'
      && (decl.init as { generator?: boolean }).generator) {
    engine.generatorFunctionNames.add(name);
  }
  let annotation = engine.annotationMap.get(name);
  // Drop non-local annotations: a sidecar / globals / `::types` entry for
  // `name` must not type-check (and thus reject) a user's own `const name =
  // ...` binding.  A locally-declared value SHADOWS an ambient global of the
  // same name (e.g. `const test = propOrElse(...)` next to a Jest `test ::
  // (String, () -> ()) -> ()` global), so the global signature is irrelevant
  // here.  Mirrors the no-initializer branch above.
  if (annotation && !isLocalAnnotation(annotation)) annotation = undefined;
  if (annotation && annotation.nodeStart !== undefined
      && (annotation.nodeStart < rangeStart || annotation.nodeStart > decl.end)) {
    // The name's map entry belongs to another declaration (a same-named
    // helper in another scope); look for this declaration's own annotation.
    // Its key is the annotated node, which can be the declaration, the
    // declarator or (for a nested `const`) the initializer: take the entry
    // for `name` inside this declaration's range.
    let own = engine.annotationsByDeclaration.get(rangeStart)
      ?? engine.annotationsByDeclaration.get(decl.start);
    if (own?.name !== name) {
      own = undefined;
      for (const [at, ann] of engine.annotationsByDeclaration) {
        if (at >= rangeStart && at <= decl.end && ann.name === name) { own = ann; break; }
      }
    }
    annotation = own?.name === name ? own : undefined;
  }

  // For annotated declarations, pre-extend env to enable self-recursion
  let inferEnv = env;
  let expectedType: Type | undefined;
  let selfRecTv: Type | undefined;
  if (annotation?.scheme) {
    inferEnv = inferEnv.extend(name, annotation.scheme);
    // Instantiate annotation early so parameter types are known during body inference
    // Use constraint-aware instantiation to track kv constraints.
    // `asGiven` marks these pending constraints as the binding's DECLARED
    // (given) constraints so validateMissingConstraints can check that callee-
    // required (wanted) constraints on the same type vars are entailed by them.
    expectedType = engine.instantiateWithConstraints(annotation.scheme, decl, annotation, false, undefined, true);

    // For polymorphic annotations WITHOUT constraints (e.g. `RTask String a b`),
    // replace expectedType with one using wildcards (*) for free vars.
    // This way concrete parts are enforced while free vars allow any type.
    // Constrained schemes (e.g. `Functor f => ...`) need the real fresh
    // vars for kv constraint tracking, so they keep the normal flow.
    //
    // However, for non-function value declarations (e.g. `arr :: [Either2 String a]`),
    // keep real TVars so that free variables bind once and are shared across
    // all elements.  This way `a` means "one specific type" (not `Any`).
    const hasConstraints = annotation.scheme.constraints && annotation.scheme.constraints.length > 0;
    const isFunction = decl.init &&
      (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression');
    // Function-valued bindings keep the real fresh vars (like `function`
    // declarations): wildcards here would let the body return the wrong
    // variable (`(a, b) -> b` with body `(x, y) => x`) unnoticed.  The
    // rigid check in validateAnnotatedBindingType enforces the annotation.
    if (annotation.scheme.vars.length > 0 && !hasConstraints && isFunction && usesLenientArrowCheck(annotation.scheme)) {
      expectedType = instantiateWithAny(annotation.scheme);
    }

    // Suppress auto-union inside annotated declarations so that concrete
    // constraints from the annotation produce real errors instead of
    // being silently merged into union types.
    engine.suppressAutoUnion = true;

    // For constrained annotations (e.g. Monad m => ...), suppress
    // "Infinite type" diagnostics from recursive self-references.
    // The recursive call creates fresh constraint vars that the occurs
    // check rejects, but this is safe — the annotation IS the type.
    if (hasConstraints) {
      engine.suppressInfiniteType = true;
      engine.infiniteTypeSuppressedDuringAnnotation = false;
    }
  } else if (
    nodeKind === 'const' &&
    decl.init &&
    (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')
  ) {
    // Non-annotated const function: pre-extend env with a fresh type
    // variable to allow self-recursion (like `let rec` in ML).
    selfRecTv = tVar();
    inferEnv = inferEnv.extend(name, mono(selfRecTv));
  }

  let initType: Type;
  // For annotated function bindings (`const fn = x => ...`), anchor any
  // body-level return-type diagnostics on the variable name rather than
  // on inner expressions or the entire block body.
  const isFunctionInit = decl.init &&
    (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression');
  const prevAnnotationMethodNode = engine.annotationMethodNode;
  if (annotation?.scheme && isFunctionInit) {
    engine.annotationMethodNode = decl;
  }

  // ---- Trial inference for closed-record annotations -----------------
  // When the annotation expects a *closed* record, the real pass below
  // would feed that record as the expected type into call inference,
  // and any open-record callee result would silently absorb annotation-
  // only fields into its row variable.  Detect missing fields by running
  // a one-shot trial inference WITHOUT expected type, capturing the
  // value's natural fields, then rolling back substitution + diagnostics.
  let naturalRecordFields: Set<string> | null = null;
  if (annotation?.scheme && expectedType && decl.init && !isFunctionInit) {
    const annReturn = getReturnType(expectedType);
    if (annReturn.tag === 'TRecord' && !annReturn.rest) {
      speculate(engine, () => {
        const trial = engine.inferExpressionWithExpected(decl.init!, inferEnv, undefined);
        const resolved = engine.subst.apply(trial);
        if (resolved.tag === 'TRecord') {
          naturalRecordFields = new Set(Object.keys(resolved.fields));
        }
      });
    }
  }

  try {
  const prevBindingName = engine.currentBindingName;
  engine.currentBindingName = name;
  const occursCheckBefore = engine.occursCheckCount;
  // Check the body of an annotated polymorphic function against RIGID
  // skolems, exactly like a `function` declaration (whose annotation sits on
  // its own node start): distinct annotation vars can then never be unified
  // by the body (`flag ? x : y` for `(Boolean, a, b) -> a | b` stays a
  // union instead of pinning `a := b`).  Constrained schemes keep their
  // constraint-aware instantiation; overloads/variadics stay lenient.
  const skolemInit = !!(annotation?.scheme && isFunctionInit
    && annotation.scheme.vars.length > 0
    && !(annotation.scheme.constraints && annotation.scheme.constraints.length > 0)
    && !annotation.receiver
    && !usesLenientArrowCheck(annotation.scheme)
    && !hasUnknownTConDiagForScheme(engine.diagnostics, annotation.scheme)
    && !engine.annotationByOffset.has(decl.init!.start));
  const prevCheckedByBinding = engine.annotationCheckedByBinding;
  if (skolemInit) {
    engine.annotationByOffset.set(decl.init!.start, annotation!);
    engine.annotationCheckedByBinding = decl.init as AstNode;
  }
  try {
  initType = engine.inferExpressionWithExpected(decl.init!, inferEnv, expectedType);
  } finally {
    if (skolemInit) {
      engine.annotationByOffset.delete(decl.init!.start);
      engine.annotationCheckedByBinding = prevCheckedByBinding;
    }
    engine.currentBindingName = prevBindingName;
  }
  // A binding whose body produced an infinite type (occurs check) cannot be
  // faithfully reconciled against its annotation — the inferred body type is
  // unrepresentable.  The signature is authoritative, so record that the body
  // was infinite to suppress the downstream annotation-vs-body mismatch.
  const bodyHadOccursCheck = engine.occursCheckCount > occursCheckBefore;

  // Unify the self-recursion type variable with the inferred type.
  // This may fail with an "Infinite type" error for complex recursive
  // patterns (e.g. the curry helper pattern). In that case, silently
  // skip — the recursive reference will remain polymorphic via the
  // fresh TVar, which is acceptable for runtime-focused helper functions.
  if (selfRecTv) {
    try {
      const recSubst = unify(selfRecTv, initType);
      engine.subst = engine.subst.compose(recSubst);
    } catch (e) {
      // "Infinite type" failures here are expected (curry helper pattern,
      // mutually recursive shapes); log anything else for diagnosis.
      if (!(e instanceof UnificationError)) debugLog('statements.selfRecursionUnify', e);
    }
  }

  if (annotation?.scheme && !bodyHadOccursCheck) {
    validateAnnotatedBindingType(engine, annotation.scheme, initType, expectedType, decl, naturalRecordFields);
  }

  // Validate the `::narrow` directive (the narrowed param index is resolved at
  // parse time; this only checks that any `[k]` label is satisfied).
  if (annotation?.scheme?.typePredicate && isFunctionInit && decl.init) {
    resolveNarrowPredicate(engine, annotation);
  }

  // Overload parameter display: when the binding's annotation is a Union of
  // function branches (overloads) with consistent arity, display each
  // parameter as the union of its type across all overloads (e.g.
  // `arr :: [a] | {a}`).  Computed from a CLEAN instantiation of the scheme so
  // the row variables aren't polluted by wildcard instantiation or by body
  // unification, then recorded as a display-only override on the parameters.
  //
  // Curried lambdas (`apply1 => apply2 => …`) are walked level-by-level so
  // every parameter — including those of nested arrows — receives the union
  // of its position across all branches.
  //
  // The annotated function may be wrapped in an IIFE (`const equals =
  // (() => … return value1 => value2 => …)()`); in that case descend through
  // the thunk to the returned arrow chain so its parameters get the unions too.
  const overloadFnNode = annotation?.scheme && decl.init
    ? effectiveAnnotatedFunctionNode(decl.init as AstNode)
    : undefined;
  if (annotation?.scheme && overloadFnNode) {
    // Use a constraint-aware instantiation so kind-variable constraints
    // (e.g. `Apply f =>`) survive into the displayed parameter unions: the
    // `$kv:f:id` TCons are preserved and registered, letting hover render the
    // constraint prefix on parameters such as `apply1 :: Apply f => … | f (a -> b)`.
    const cleanAnn = annotation.scheme.constraints?.length
      ? engine.instantiateWithConstraints(annotation.scheme, decl, annotation, true)
      : instantiate(annotation.scheme);
    if (cleanAnn.tag === 'TCon' && cleanAnn.name === T_UNION
        && cleanAnn.args.length >= 2
        && cleanAnn.args.every(b => b.tag === 'TFun')) {
      // Walk the function's arrow LEVELS.  Each level contributes its own
      // parameter list; a single-arrow multi-parameter function packs them
      // into one tuple TFun param (`(arr, arr2) => …`), while a curried
      // function spreads them across nested single-param arrows
      // (`apply1 => apply2 => …`).  Recording the level structure lets us
      // decompose each branch with the right per-level arity.
      const levels: AstNode[][] = [];
      let fn: AstNode | undefined = overloadFnNode;
      while (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression')) {
        const fnParams = (fn as unknown as estree.Function).params as AstNode[];
        levels.push(fnParams);
        // Only descend into a nested arrow when this level has exactly one
        // parameter and its body is itself a function expression — the
        // classic curried shape.  Anything else terminates the chain.
        const body = (fn as unknown as estree.Function).body as AstNode;
        if (fnParams.length === 1 && body &&
            (body.type === 'ArrowFunctionExpression' || body.type === 'FunctionExpression')) {
          fn = body;
        } else {
          fn = undefined;
        }
      }

      // Walk each branch's TFun chain in lockstep with the arrow levels.
      const branchCursors: (Type | null)[] = cleanAnn.args.slice();
      for (const levelParams of levels) {
        const arity = levelParams.length;
        // Decompose this level from every branch, then advance each cursor.
        const perBranch = branchCursors.map(c => (c ? decomposeFunParams(c, arity) : null));
        for (let b = 0; b < branchCursors.length; b++) {
          branchCursors[b] = perBranch[b] ? perBranch[b]!.restType : null;
        }
        // Only record overrides when EVERY branch contributes the full set of
        // parameters at this level; otherwise arities diverge and a union
        // would be misleading.
        if (!perBranch.every(d => d != null && d.paramTypes.length === arity)) continue;
        for (let i = 0; i < arity; i++) {
          const p = levelParams[i];
          if (!p || p.type !== 'Identifier') continue;
          // Collapse same-named vars across branches onto one id so the
          // pretty-printer keeps each branch's source name (`[a] | { a }`,
          // not `[a] | { b }`).  Display-only.
          engine.recordNodeType(p, canonicalizeDisplayVarsByName(tUnion(perBranch.map(d => d!.paramTypes[i]))));
        }
      }
    } else if (cleanAnn.tag === 'TFun' && overloadFnNode !== (decl.init as AstNode)) {
      // Single (non-overload) annotation wrapped in an IIFE — e.g. FP-library
      // `fl/lte.js`:  `const lte = (() => { …; return v1 => v2 => …; })();`.
      // During thunk inference the annotation's expectedType is NOT threaded
      // through the zero-arg call, so the returned arrow's parameters were
      // bound to FRESH unconstrained vars.  Re-record them from the
      // constraint-aware annotation instantiation so they behave exactly like
      // direct parameters: same constrained type variable, so hover shows the
      // constraint prefix (`value1 :: Ord a => a`) and tracks the annotation's
      // own variable name.  Gated on `overloadFnNode !== decl.init` so direct
      // arrows (which already bind their params from expectedType) are left
      // untouched.
      const levels: AstNode[][] = [];
      let fn: AstNode | undefined = overloadFnNode;
      while (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression')) {
        const fnParams = (fn as unknown as estree.Function).params as AstNode[];
        levels.push(fnParams);
        const body = (fn as unknown as estree.Function).body as AstNode;
        if (fnParams.length === 1 && body &&
            (body.type === 'ArrowFunctionExpression' || body.type === 'FunctionExpression')) {
          fn = body;
        } else {
          fn = undefined;
        }
      }
      let cursor: Type | null = cleanAnn;
      for (const levelParams of levels) {
        const arity = levelParams.length;
        const d: ReturnType<typeof decomposeFunParams> = cursor ? decomposeFunParams(cursor, arity) : null;
        cursor = d ? d.restType : null;
        if (!d || d.paramTypes.length !== arity) break;
        for (let i = 0; i < arity; i++) {
          const p = levelParams[i];
          if (!p || p.type !== 'Identifier') continue;
          engine.recordNodeType(p, d.paramTypes[i]);
        }
      }
    }
  }
  } finally {
  // Restore suppression flags after annotated inference + validation.
  engine.suppressAutoUnion = false;
  engine.suppressInfiniteType = false;
  engine.infiniteTypeSuppressedDuringAnnotation = false;
  engine.annotationMethodNode = prevAnnotationMethodNode;
  }

  // Generalize for `const`, monomorphic for `let`/`var`.
  // Exception: don't generalize a bare TVar that carries kvConstraint
  // entries — generalization would quantify the TVar and instantiation
  // would create a fresh id, losing the constraint mapping.
  // Before generalizing, retry property accesses that were parked on a
  // then-unresolved TVar receiver — the initializer is now fully inferred,
  // so a receiver pinned by a later argument (curried calls) resolves here
  // instead of leaving a spuriously quantified result var (`[b]` → `[Number]`).
  flushDeferredMemberAccesses(engine);
  let resolved = engine.subst.apply(initType);
  // Null-initialised mutable binding: `let x = null; x = value;` is a
  // standard JS initialisation idiom (e.g. an FP library's chainRec sync/async flag
  // `let isSync = null; isSync = true;`).  Widen the binding to `Null | a`
  // so the first non-null assignment pins `a` — later conflicting
  // assignments are still rejected, and `x === null` narrowing keeps
  // working.  Only for UNANNOTATED `let`/`var` with a literal `null` init.
  if (!annotation?.scheme && nodeKind !== 'const'
      && decl.init?.type === 'Literal' && (decl.init as estree.Literal).value === null
      && (decl.init as estree.Literal).raw === 'null'
      && resolved.tag === 'TCon' && resolved.name === 'Null' && resolved.args.length === 0) {
    resolved = tUnion([resolved, tVar()]);
  }
  const useAnnotationType = !!annotation?.scheme;
  let displayType = useAnnotationType
    ? (annotation!.scheme!.constraints?.length
        ? engine.instantiateWithConstraints(annotation!.scheme!, decl, annotation, true)
        : instantiate(annotation!.scheme!))
    : resolved;
  // Option 3: reunite the display type's kv-encoded constraint head with the
  // body instantiation (`expectedType`) so inner bindings that reference the
  // body's higher-kinded constraint variable (e.g. `const idd = id(C)` inside a
  // `Category c => …` law) render its head with the SAME display letter as the
  // enclosing function's recorded scope type.  Only the constraint constructor
  // is aligned — plain object type-variables stay distinct so a callee's fresh
  // result var (id's `a`) does not collapse onto the law's `a`.  Only for
  // constrained function annotations, and only when the body did not specialize
  // the annotation (structural match).
  if (useAnnotationType && expectedType && annotation!.scheme!.constraints?.length) {
    const aligned = alignDisplayVarIds(displayType, engine.subst.apply(expectedType));
    if (aligned) displayType = aligned;
  }
  // For a non-annotated binding whose initializer is a call, render a callee's
  // GENERATIVE result variables (introduced from no argument) with fresh display
  // letters, so e.g. `idd = id(C)` hovers as `Category c => c b b` even though
  // unification collapsed id's `a` onto the enclosing law's `a`.  Parametric
  // variables are left shared (see alignDisplayVarIds).
  if (!useAnnotationType && decl.init) {
    displayType = freshenGenerativeResultVars(engine, decl.init as AstNode, displayType, env);
  }
  const hasKvConstraints = resolved.tag === 'TVar' &&
    (engine.kvConstraints.has(resolved.id) || engine.kvConstructorConstraints.has(resolved.id));
  let scheme: Scheme =
    annotation?.scheme
      ? annotation.scheme  // use the annotation scheme (preserves quantification)
      : nodeKind === 'const'
        ? hasKvConstraints
          ? mono(resolved)
          : generalize(env, resolved, engine.subst)
        : mono(resolved);
  // NOTE: for `let`/`var` we deliberately store `resolved` (the same
  // instance as `displayType`) rather than the pre-subst `initType`.
  // This way later record-extension mutations (in `inferAssignmentExpression`,
  // e.g. `builtIn.Array = …` after `let builtIn = {}`) that mutate
  // `sch.type.fields` are visible to hover lookups that resolve through
  // the recorded `displayType` of the declaration.

  // Propagate isCurriedResult from curry wrapper calls — only when the
  // initializer IS that call (`const f = curry (…)`, `const g = f (a)`).  For
  // a function initializer the flag was left behind by a call inside its
  // body (FP-library validateSpec: `(k, rules, obj, updating) => … objOf (k) …`),
  // and marking the 4-parameter function itself as curried produced a false
  // HM5003 "Curried function called with 4 arguments" at every call site.
  if (engine.pendingIsCurriedResult) {
    engine.pendingIsCurriedResult = false;
    if (decl.init && decl.init.type === 'CallExpression') {
      scheme = { ...scheme, isCurriedResult: true };
      engine.curriedNodes.add(decl.start);
    }
  }

  // Propagate conditional return info (literal guard narrowing)
  if (engine.pendingConditionalReturn) {
    const cr = engine.pendingConditionalReturn;
    engine.pendingConditionalReturn = null;
    // Only attach when the init is a direct function or curry wrapper call
    if (decl.init &&
        (decl.init.type === 'ArrowFunctionExpression' ||
         decl.init.type === 'FunctionExpression' ||
         (decl.init.type === 'CallExpression' &&
          decl.init.callee?.type === 'Identifier' &&
          engine.curryFunctionNames.has(decl.init.callee.name as string)))) {
      scheme = { ...scheme, conditionalReturn: cr };
    }
  }

  // Propagate JS-body parameter defaults: when the binding's init is a
  // function expression with `(x = ...)` parameters, record the indices on
  // the scheme so call sites can treat trailing missing args as optional.
  // Also unwrap chained `name = obj.prop = (…) => …` assignment patterns
  // so member-access syntax shares the same metadata.
  {
    let initFn: AstNode | undefined = decl.init as AstNode | undefined;
    while (initFn && initFn.type === 'AssignmentExpression') {
      initFn = (initFn as estree.AssignmentExpression).right as AstNode;
    }
    if (initFn &&
        (initFn.type === 'ArrowFunctionExpression' ||
         initFn.type === 'FunctionExpression')) {
      const slots = collectOptionalParamSlots((initFn as estree.Function).params as AstNode[]);
      if (slots.length > 0) scheme = { ...scheme, optionalParamSlots: slots };
    }
  }

  return { scheme, displayType };
}

export function inferFunctionDeclaration(engine: InferenceEngine, node: estree.FunctionDeclaration | estree.AnonymousFunctionDeclaration, env: TypeEnv): [TypeEnv, Type] {
  const name = node.id?.name;
  // Track generator functions by name so call sites can wrap the result in
  // `Generator <element>` (the function type itself carries the element type).
  if (name && (node as { generator?: boolean }).generator) {
    engine.generatorFunctionNames.add(name);
  }
  // Provenance: a `function Foo(){ this.x = ... }` is a constructor; any
  // other function gets no entry (regular call expected).
  if (name && node.body?.type === 'BlockStatement' && blockHasThisAssignment(node.body)
      && !hasSelfNewGuard(node.body as AstNode, name)) {
    engine.constructorProvenance.set(
      name,
      isVariant(name) ? 'sumtype-variant' : 'function-this',
    );
  }
  // Check for HM annotation and pass expected type for early param binding
  const annotation = engine.lookupAnnotation(name, node.start);
  let expectedType: Type | undefined;
  let thisType: Type | undefined;
  if (annotation?.scheme) {
    if (annotation.receiver && annotation.methodType) {
      // Method annotation: create coordinated instantiation so receiver and
      // method type share the same fresh type variables.
      ({ thisType, expectedType } = engine.coordinateInstantiate(annotation));
    } else {
      expectedType = engine.instantiateWithConstraints(annotation.scheme, node, annotation);
      // Detect constructor function: non-method annotation whose body uses
      // `this.x = ...` assignments.  Bind `this` to the annotation's return
      // type so that property assignments type-check, and
      // inferBlockReturnType can return it instead of Undefined.
      if (!annotation.receiver && name && node.body?.type === 'BlockStatement'
          && blockHasThisAssignment(node.body)) {
        const retType = getReturnType(expectedType!);
        thisType = retType;
      }
    }
  }
  // If we have a receiver type from a method annotation, bind `this` in env
  let funcEnv = env;
  if (thisType) {
    funcEnv = env.extend('this', mono(thisType));
  }
  if (annotation?.scheme) engine.annotationMethodNode = node;
  const funcType = engine.inferFunctionExpression(node, funcEnv, expectedType);
  engine.annotationMethodNode = null;
  if (name) {
    if (annotation?.scheme) {
      // Skip rigid check and unification for factory functions that return
      // a sumtype TCon — the returned record literal IS the runtime
      // representation and the annotation is the source of truth.
      if (hasUnknownTConDiagForScheme(engine.diagnostics, annotation.scheme)) {
        // Annotation references unknown type constructors — skip all
        // mismatch checks; the "unknown type constructor" diagnostic is
        // sufficient.
      } else if (!shouldSuppressSumTypeCheck(annotation.scheme, funcType, engine.typeAliases)) {
        const diagsBefore = engine.diagnostics.length;
        engine.checkRigid(funcType, annotation.scheme, node);
        // When the rigid check already produced a mismatch diagnostic the
        // follow-up unification would only restate the same conflict in a
        // less informative form ("Cannot unify '()' with 'RTask r e b'"),
        // so skip it.  Still run unification when rigid was clean so the
        // engine's substitution stays in sync with the annotation.
        if (engine.diagnostics.length === diagsBefore) {
          // Reuse expectedType to preserve kv constraint id mapping
          const annotatedType = expectedType ?? instantiate(annotation.scheme);
          // A narrower union result passed the rigid check; bind it the same
          // way instead of restating a union mismatch.
          const widened = unifyWidening(engine.subst.apply(funcType), engine.subst.apply(annotatedType));
          if (widened) engine.subst.mergeFrom(widened);
          else engine.unifyWithDiagnostic(funcType, annotatedType, node);
        }
      } else {
        validateSumTypeFactoryFields(engine, annotation.scheme, funcType, expectedType, node);
      }
      // Check for missing record fields in the return type
      checkMissingRecordFields(engine, funcType, annotation.scheme, node);
      let annotatedScheme = annotation.scheme;
      const declSlots = collectOptionalParamSlots(node.params as AstNode[]);
      if (declSlots.length > 0) annotatedScheme = { ...annotatedScheme, optionalParamSlots: declSlots };
      const newEnv = env.extend(name, annotatedScheme);
      const displayType = instantiate(annotatedScheme);
      if (node.id) engine.recordNodeType(node.id, displayType);
      return [newEnv, engine.subst.apply(funcType)];
    }

    const resolved = engine.subst.apply(funcType);
    let scheme = generalize(env, resolved);
    const declSlots = collectOptionalParamSlots(node.params as AstNode[]);
    if (declSlots.length > 0) scheme = { ...scheme, optionalParamSlots: declSlots };
    const newEnv = env.extend(name, scheme);
    if (node.id) engine.recordNodeType(node.id, resolved);
    if (node.id && scheme.vars.length > 0) {
      engine.declaredSchemes.set(node.id.start, scheme);
    }
    return [newEnv, funcType];
  }
  return [env, funcType];
}


/** `Null`/`Undefined`, the members a lookup adds when it misses. */
function isNullish(t: Type): boolean {
  return t.tag === 'TCon' && t.args.length === 0 && (t.name === 'Undefined' || t.name === 'Null');
}

/**
 * An annotation on a `const` may state that a lookup did not miss: the value
 * comes from a call, a member access or an `await` (`rates.get (code)`,
 * `orders.find (…)`, `invoice.paidAt`), its type is a union with `Undefined`
 * or `Null`, and the annotation is that union without them (`// rate ::
 * Number`).  Unifies the rest with the annotation and returns true; returns
 * false (nothing bound) when the annotation says anything else.
 */
function assertsPresentLookup(
  engine: InferenceEngine,
  decl: estree.VariableDeclarator,
  inferred: Type,
  annotated: Type,
): boolean {
  let init = decl.init as AstNode | null | undefined;
  if (!init) return false;
  if (init.type === 'AwaitExpression') init = (init as unknown as estree.AwaitExpression).argument as AstNode;
  if (init.type !== 'CallExpression' && init.type !== 'MemberExpression') return false;
  if (inferred.tag !== 'TCon' || inferred.name !== T_UNION) return false;
  const present = inferred.args.filter(m => !isNullish(m));
  if (present.length === inferred.args.length || present.length === 0) return false;
  if (containsErrorType(inferred) || containsErrorType(annotated)) return false;
  const rest = present.length === 1 ? present[0] : tUnion(present);
  try {
    engine.subst.mergeFrom(unify(engine.subst.apply(rest), engine.subst.apply(annotated)));
    return true;
  } catch (e) {
    if (e instanceof UnificationError) return false;
    throw e;
  }
}
