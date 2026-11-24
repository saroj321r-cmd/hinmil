// ============================================================================
// Annotation rigid checking — rigid skolem comparison of inferred types
// against polymorphic annotations, plus diagnostic narrowing helpers
// (split from annotations.ts; verbatim moves)
//
// Plain language: an annotation like `f :: a -> a` is a PROMISE — "f works
// for any type the caller picks".  To verify it, the checker replaces `a`
// with an untouchable made-up type (a *skolem*, rendered `§N`) and re-checks
// the function body.  If the body secretly assumes `a` is e.g. Number, the
// skolem refuses to match and the broken promise is reported.  "Rigid" means
// the variable is not allowed to bend to what the body wants.
// ============================================================================

import {
  Type,
  tVar,
  Scheme,
  typeToString,
  prettyTypeToString,
  prettyTypeToStringPair,
  containsErrorType,
  getReturnType,
  isWildcard,
  isAnyType,
  AstNode,
  T_UNION,
  T_MERGE,
  isUnion,
  isTuple,
  parseKvName,
} from '../hm/types';
import { instantiate, instantiateRigid, instantiateSkolem } from '../hm/env';
import { unify, unifyWidening, UnificationError } from '../hm/unify';
import { hasSpreadInArrowChain, isSpreadTupleOrArray, isArrowChainTuple, containsQuantifiedVar, collectKvApplications, fixTypeRepKvVars, mapType, eachType, scrubSkolems, hasTopLevelSpreadChain, someType } from '../hm/typeUtils';
import { isSpread } from '../hm/types';
import { flattenCurriedType } from '../hm/types';


// ---------------------------------------------------------------------------
// Context interface for methods that need engine state
import { expandAliases, type RigidCheckContext } from './annotations';
import { hasStructuralMismatch, hasParamShapeMismatch } from './annotation-validation';

/**
 * Decide whether to run a rigid annotation check for a polymorphic scheme,
 * and run it if appropriate.  Skips when:
 *   - The annotation uses spread types (which can cause false positives)
 *   - A body-level return-type mismatch was already reported
 *   - The return type contains quantified vars (constructor pattern)
 *     and the scheme is unconstrained — UNLESS there is a parameter shape
 *     mismatch (curried vs tuple), which is always a structural error.
 */
export function maybeRigidCheck(
  ctx: RigidCheckContext,
  inferredType: Type,
  annScheme: Scheme,
  node: AstNode,
): void {
  // Skip when the annotation references unknown type constructors — any
  // mismatch is a consequence of the missing definition, not a real error.
  if (hasUnknownTConDiagForScheme(ctx.diagnostics, annScheme)) return;

  // Skip spread-annotated functions: both spread-TUPLE params
  // (`((a, b, ...) -> z) -> …`) and spread ARROW CHAINS
  // (`(a -> b -> ... -> z) -> …`).  The `...` marker makes these annotations
  // intentionally variadic, so rigid structural matching against a concrete
  // inferred body would produce spurious mismatches.
  if (annScheme.type.tag === 'TFun' && (
    isSpreadTupleOrArray(annScheme.type.param) ||
    hasSpreadInArrowChain(annScheme.type.param) ||
    (annScheme.type.param.tag === 'TFun' && isSpreadTupleOrArray(annScheme.type.param.param))
  )) return;

  // Skip if a body-level return-type mismatch diagnostic already exists
  if (ctx.diagnostics.some(d => d.message.startsWith('Type mismatch:'))) return;

  // Always run the rigid check when the parameter shape (curried vs tuple)
  // differs between annotation and inferred type — this is a structural
  // mismatch regardless of whether the return type is polymorphic.
  const resolvedInferred = ctx.subst.apply(inferredType);

  // Kind-level mismatch between an annotation and a function value.  Only
  // meaningful when the value is actually a function.
  if (resolvedInferred.tag === 'TFun') {
    const annType = annScheme.type;
    // Overloaded annotation (a Union of function branches): the body must
    // match AT LEAST ONE branch.  Report only when none of them match.
    if (annType.tag === 'TCon' && annType.name === T_UNION
        && annType.args.length >= 2
        && annType.args.every(b => b.tag === 'TFun')) {
      const branches = annType.args;
      // An overloaded implementation typically returns DIFFERENT values in
      // different code paths, each satisfying a DIFFERENT overload branch
      // (e.g. `concat` returns an array in one path and an object in
      // another).  So the body is valid when every distinct value it can
      // return is accepted by AT LEAST ONE branch's result type — not when
      // the whole function matches a single branch.
      const actualReturn = ctx.subst.apply(getReturnType(resolvedInferred));
      const actualMembers = isUnion(actualReturn) ? actualReturn.args : [actualReturn];
      const allCovered = actualMembers.every(member =>
        branches.some(branch =>
          rigidReturnMatches(ctx, member, { vars: annScheme.vars, type: getReturnType(branch) })));
      if (!allCovered) {
        ctx.addDiag(
          `Function body matches none of the ${branches.length} overload signatures: `
            + branches.map(b => prettyTypeToString(b)).join('; '),
          narrowToIdentifier(node),
        );
      }
      return;
    }
    // The value is a function but the annotation is a concrete, non-function
    // data type (e.g. `f :: Array a`).  Route to the rigid check, which
    // unifies the two and emits the standard mismatch message.
    if (isConcreteNonFunctionAnnotation(ctx, annType)) {
      checkAnnotationRigid(ctx, inferredType, annScheme, node);
      return;
    }
  }

  if (hasParamShapeMismatch(annScheme.type, resolvedInferred)) {
    checkAnnotationRigid(ctx, inferredType, annScheme, node);
    return;
  }

  const hasConstraints = annScheme.constraints && annScheme.constraints.length > 0;
  if (hasConstraints) {
    checkAnnotationRigid(ctx, inferredType, annScheme, node);
  } else {
    const returnType = getReturnType(annScheme.type);
    if (!containsQuantifiedVar(returnType, new Set(annScheme.vars))) {
      checkAnnotationRigid(ctx, inferredType, annScheme, node);
    } else if (hasStructuralMismatch(annScheme.type, resolvedInferred)) {
      // Return type has quantified vars — skip full rigid check to avoid
      // false positives from wildcards, BUT still catch clear structural
      // mismatches (wrong return TCon, param count difference, etc.).
      checkAnnotationRigid(ctx, inferredType, annScheme, node);
    }
  }
}

/**
 * Check, in isolation, whether a single value the body can return is accepted
 * by one overload branch's result type.  The branch's result is instantiated
 * with FRESH flexible variables so its polymorphic positions can absorb the
 * concrete value (e.g. branch result `{ ...a, ...b }` accepts an empty `{}`).
 * Used to implement "every body return must satisfy at least one overload".
 */
function rigidReturnMatches(
  ctx: RigidCheckContext,
  actualMember: Type,
  branchReturnScheme: Scheme,
): boolean {
  const freshReturn = instantiate(branchReturnScheme);
  const expected = expandAliases(ctx.typeAliases, freshReturn, undefined, ctx.aliasVars);
  const actual = expandAliases(
    ctx.typeAliases, ctx.subst.apply(actualMember), undefined, ctx.aliasVars);
  if (containsErrorType(actual) || containsErrorType(expected)) return true;
  // A branch whose result is an OPEN / merged record (`{ ...a, ...b }`,
  // `{ x :: T, ...r }`) accepts any object the body produces — the row
  // variables can absorb (or be) whatever fields are present, including an
  // empty object.  So treat any record-valued body return as matching such a
  // branch directly (plain unification can't reduce a `Merge` marker).
  if (actual.tag === 'TRecord' && isOpenOrMergeRecord(expected)) return true;
  try {
    unify(actual, expected);
    return true;
  } catch (e) {
    if (e instanceof UnificationError) return false;
    throw e;
  }
}

/** True when a type is an open record (has a row rest) or a `Merge` marker. */
function isOpenOrMergeRecord(t: Type): boolean {
  if (t.tag === 'TCon' && t.name === T_MERGE) return true;
  if (t.tag === 'TRecord' && t.rest != null) return true;
  return false;
}

/**
 * True when `t` is a concrete, non-function data type that a function value
 * could never inhabit (`Array a`, `Number`, `Maybe a`, …).  Bare type
 * variables, wildcards, `any`, `Object`, tuples and function types are
 * deliberately excluded so legitimate polymorphic / structural annotations
 * are never flagged.
 */
function isConcreteNonFunctionAnnotation(ctx: RigidCheckContext, t: Type): boolean {
  const expanded = expandAliases(ctx.typeAliases, t, undefined, ctx.aliasVars);
  if (expanded.tag !== 'TCon') return false;
  const name = expanded.name;
  if (name === 'Object' || name === T_UNION) return false;
  if (isWildcard(expanded) || isAnyType(expanded)) return false;
  if (isTuple(expanded)) return false;
  return true;
}

/**
 * Replace all wildcard types (*  or *:name) with fresh TVars so that
 * the rigid check's unification is not silently bypassed.
 */
function stripWildcards(t: Type): Type {
  return mapType(t, n => isWildcard(n) ? tVar() : undefined);
}

/**
 * Collect all type constructor names referenced in a type.
 */
function collectTypeConstructorNames(t: Type, out: Set<string> = new Set()): Set<string> {
  eachType(t, node => { if (node.tag === 'TCon') out.add(node.name); });
  return out;
}

/**
 * Check whether any existing diagnostic reports an unknown type constructor
 * that appears in the given annotation scheme.  When true, further mismatch
 * diagnostics should be suppressed because the type system cannot meaningfully
 * compare types that reference undefined constructors.
 */
export function hasUnknownTConDiagForScheme(
  diagnostics: { message: string }[],
  scheme: Scheme,
): boolean {
  const tcons = collectTypeConstructorNames(scheme.type);
  return diagnostics.some(d => {
    const m = d.message.match(/Unknown type constructor '([^']+)'/);
    return m != null && tcons.has(m[1]);
  });
}

/**
 * Narrow an AST node range to its most relevant identifier.  Used by
 * `unifyWithDiagnostic` so that only the function/variable name is
 * underlined red, not the entire expression or declaration.
 *
 * Handles: VariableDeclarator, FunctionDeclaration, CallExpression,
 * MemberExpression, AssignmentExpression, MethodDefinition,
 * and falls back to the node itself.
 */
export function narrowToIdentifier(node: AstNode): { start: number; end: number } {
  // VariableDeclarator / FunctionDeclaration / ClassDeclaration → id
  if ('id' in node && node.id && typeof node.id.start === 'number' && typeof node.id.end === 'number') {
    return node.id;
  }
  // MethodDefinition → key (the method name)
  if (node.type === 'MethodDefinition' && node.key
      && typeof node.key.start === 'number' && typeof node.key.end === 'number') {
    return node.key;
  }
  // CallExpression → callee (or callee.property for member calls)
  if (node.type === 'CallExpression' && node.callee) {
    if (node.callee.type === 'MemberExpression' && node.callee.property
        && typeof node.callee.property.start === 'number') {
      return node.callee.property;
    }
    return node.callee;
  }
  // AssignmentExpression → left identifier or left.property
  if (node.type === 'AssignmentExpression' && node.left) {
    if (node.left.type === 'MemberExpression' && node.left.property
        && typeof node.left.property.start === 'number') {
      return node.left.property;
    }
    if (node.left.type === 'Identifier') return node.left;
  }
  // MemberExpression → property
  if (node.type === 'MemberExpression' && node.property
      && typeof node.property.start === 'number') {
    return node.property;
  }
  // ConditionalExpression → underline the whole ternary.
  // Narrowing to `node.test` would point at the boolean condition (e.g.
  // `flag ? a : b` → `flag`), which has nothing to do with the type of
  // the expression's value.  The whole ternary is the honest source.
  if (node.type === 'ConditionalExpression'
      && typeof node.start === 'number' && typeof node.end === 'number') {
    return { start: node.start, end: node.end };
  }
  // ArrowFunctionExpression / FunctionExpression → parameter list (signature),
  // not the entire body.  Keeps "Cannot unify" diagnostics on the function
  // signature instead of underlining a multi-line block.
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    const params = (node as { params?: AstNode[] }).params;
    if (params && params.length > 0) {
      const first = params[0];
      const last = params[params.length - 1];
      if (typeof first.start === 'number' && typeof last.end === 'number') {
        return { start: first.start, end: last.end };
      }
    }
    // No params (or unparseable): underline just up to the body start.
    const body = (node as { body?: AstNode }).body;
    if (body && typeof node.start === 'number' && typeof body.start === 'number'
        && body.start > node.start) {
      return { start: node.start, end: body.start };
    }
  }
  return node;
}

/**
 * Extract the binding identifier name from common AST nodes that introduce
 * an annotation (variable declarators, function declarations, methods).
 * Used to build user-friendly diagnostic messages that mention the symbol
 * by name instead of using generic phrasing.
 */
export function bindingNameFromNode(node: AstNode): string | undefined {
  if ('id' in node && node.id && (node.id as AstNode).type === 'Identifier') {
    return (node.id as { name?: string }).name;
  }
  if (node.type === 'MethodDefinition' && node.key && (node.key as AstNode).type === 'Identifier') {
    return (node.key as { name?: string }).name;
  }
  return undefined;
}

/**
 * Unified diagnostic message for any kind of annotation-vs-implementation
 * mismatch (full-type mismatch, return-type union mismatch, rigid check
 * failure, ...).  Using one consistent template across emit sites makes
 * the diagnostics easier to scan and to filter on.
 */
export function annotationMismatchMessage(
  name: string | undefined,
  inferred: Type,
  expected: Type,
): string {
  const subject = name ? `'${name}'` : 'value';
  const [inf, exp] = prettyTypeToStringPair(inferred, expected);
  return `Type mismatch: ${subject} has type '${inf}' but annotation expects '${exp}'`;
}

/**
 * Should an annotation-mismatch diagnostic be SUPPRESSED?  Returns true
 * when either the inferred or expected type contains the `$error`
 * sentinel — those types are produced by error recovery (poisoned free
 * type variables after a failed unification) and reporting them only
 * cascades the original root-cause diagnostic into noise.
 *
 * The `$error` sentinel never appears in user-written annotations or in
 * a clean inference run, so suppressing is safe: a real mismatch always
 * has a clean type on at least one side... wait, NO — both sides can be
 * polluted simultaneously.  Skip if EITHER side is polluted.
 */
export function shouldSuppressMismatch(inferred: Type, expected: Type): boolean {
  return containsErrorType(inferred) || containsErrorType(expected);
}

/**
 * Diagnostic message for a method-name mismatch between a declared
 * member and its preceding annotation (e.g. `// foo :: …` over `bar() {}`).
 */
export function methodNameMismatchMessage(
  methodName: string,
  annotationName: string,
): string {
  return `Method name '${methodName}' does not match annotation '${annotationName}'`;
}

/**
 * Does the annotation contain a chain-container / bare arrow-chain tuple —
 * `(a -> b, b -> c, ..., y -> z)` (possibly wrapped in a container
 * `f (a -> b, ..., y -> z)`)?  Such combinators (pipe / compose over a
 * Foldable) legitimately infer an *endomorphic collapse* of the chain in
 * their body — a standard `reduce`/apply fold cannot express the full
 * heterogeneous `a -> z` — so the rigid check would spuriously report the
 * body as "less polymorphic than the annotation".  When the annotation uses
 * this pattern we trust the declared signature and skip the rigid mismatch.
 */
function annotationHasArrowChainTuple(t: Type): boolean {
  let found = false;
  eachType(t, n => {
    if (found) return;
    if (isArrowChainTuple(n)) found = true;
  });
  return found;
}

/**
 * Check that the inferred type is compatible with an annotation scheme
 * using rigid (skolem) type variables.  This catches cases where the
 * implementation is *less* polymorphic than the annotation claims.
 *
 * The check runs in isolation — it does NOT affect the main substitution.
 */
export function checkAnnotationRigid(
  ctx: RigidCheckContext,
  inferredType: Type,
  annotationScheme: Scheme,
  node: AstNode,
): void {
  // The inferred type may still carry rigid skolems (`§N`) that were minted
  // while checking an annotated body.  They must be scrubbed back to ordinary
  // display variables before the comparison: a body skolem can never unify
  // with the fresh rigid skolem this check mints from the annotation, which
  // would otherwise emit a spurious "value has type X but annotation expects
  // X" self-mismatch.  Genuine body/return shape differences survive the
  // scrub (e.g. a stub returning `()` instead of a variable) and still report.
  inferredType = scrubSkolems(inferredType, ctx.skolemDisplayNames);
  if (annotationScheme.constraints && annotationScheme.constraints.length > 0) {
    // For applied constraints with TypeRep parameters, the scheme has
    // a bare TVar inside TypeRep (e.g. TypeRep m) while the inferred
    // type has the applied kv-TCon (e.g. TypeRep (m a)).  Apply the
    // same fixup to the scheme for consistent rigid comparison.
    // Only for vars from *applied* constraints, not non-applied ones.
    let schemeForRigid = annotationScheme;
    const appliedVarNames = new Set<string>();
    for (const c of annotationScheme.constraints) {
      if (c.isApplied) appliedVarNames.add(c.typeVarName);
    }
    const kvApps = new Map<number, Type>();
    collectKvApplications(annotationScheme.type, kvApps);
    // Mirror the instantiation-side pinning rule: only *applied* constraint
    // vars (e.g. `Monoid (m a)`) get their TypeRep param rewritten, and only
    // when the var is kv-applied to a single consistent argument across the
    // type.  Non-applied constraint vars stay bare — unifyTypeRep binds a
    // bare `TypeRep f` var to the witness's bare constructor directly.
    const sigByName = new Map<string, string | null>();
    // Seed with each applied constraint's OWN application signature
    // (`Setoid (f b)` applies `f` to `b`) — the constraint's app may not
    // occur in the type itself, yet still conflicts with a differing use
    // (interchange's `f (a -> b)`).
    for (const c of annotationScheme.constraints) {
      if (!c.isApplied || !c.appliedArgNames || c.appliedArgNames.length === 0) continue;
      const sig = c.appliedArgs
        ? c.appliedArgs.map(t => typeToString(t)).join(',')
        : c.appliedArgNames.join(',');
      const prev = sigByName.get(c.typeVarName);
      if (prev === undefined) sigByName.set(c.typeVarName, sig);
      else if (prev !== sig) sigByName.set(c.typeVarName, null);
    }
    eachType(annotationScheme.type, n => {
      if (n.tag !== 'TCon') return;
      const kv = parseKvName(n.name);
      if (!kv || n.args.length === 0) return;
      if (!appliedVarNames.has(kv.varName)) return;
      const sig = n.args.map(a => typeToString(a)).join(',');
      const prev = sigByName.get(kv.varName);
      if (prev === undefined) sigByName.set(kv.varName, sig);
      else if (prev !== sig) sigByName.set(kv.varName, null);
    });
    if (appliedVarNames.size > 0) {
      // Keep kv-applications whose var belongs to an applied constraint and
      // is consistently applied — drop the rest.
      for (const [varId, kvType] of kvApps) {
        if (kvType.tag === 'TCon') {
          const kv = parseKvName(kvType.name);
          if (kv && (!appliedVarNames.has(kv.varName) || sigByName.get(kv.varName) === null)) {
            kvApps.delete(varId);
          }
        }
      }
    } else {
      kvApps.clear();
    }
    if (kvApps.size > 0) {
      schemeForRigid = { ...annotationScheme, type: fixTypeRepKvVars(annotationScheme.type, kvApps) };
    }
    const { type: rigidAnnotType } = instantiateRigid(schemeForRigid);
    const resolvedInferred = stripWildcards(ctx.subst.apply(inferredType));
    try {
      unify(resolvedInferred, rigidAnnotType);
    } catch (e) {
      if (e instanceof UnificationError) {
        // Fold-completion leniency (mirrors unifyWithDiagnostic): a TOP-LEVEL
        // spread arrow chain reconciled against a non-function annotation
        // stands for "the chain once fully applied", so compare the chain's
        // terminal result instead of the whole chain before reporting.
        if (chainTerminalMatches(resolvedInferred, rigidAnnotType)) return;
        // A narrower union result than the annotation declares is fine.
        if (unifyWidening(resolvedInferred, rigidAnnotType)) return;
        // Use a non-rigid instantiation for display so user-facing
        // messages don't leak skolem (§) variable names.
        const displayAnnot = instantiate(schemeForRigid);
        if (containsErrorType(resolvedInferred) || containsErrorType(displayAnnot)) return;
        if (annotationHasArrowChainTuple(annotationScheme.type)) return;
        ctx.addDiag(
          annotationMismatchMessage(bindingNameFromNode(node), resolvedInferred, displayAnnot),
          narrowToIdentifier(node),
        );
      } else {
        throw e;
      }
    }
    return;
  }

  // Param-only skolemization: variables in a parameter / `this` position are
  // fixed by the caller and must match rigidly; variables that occur only in
  // the return position are chosen by the body, so they stay flexible and a
  // concrete return value (e.g. `[Number]` for an annotated `[b]`) is accepted.
  const { type: rigidAnnotType } = instantiateSkolem(annotationScheme);
  // Scrub registered body skolems AFTER applying the substitution: a skolem
  // can be hidden behind a substitution binding (e.g. a `this`-instance type
  // argument that the body unified with a parameter skolem), so scrubbing the
  // raw inferred type alone leaves it in the resolved type and produces a
  // spurious self-mismatch (`(a,b) -> Pair §0 §1` vs `(a,b) -> Pair §2 §3`).
  const resolvedInferred = expandAliases(
    ctx.typeAliases,
    scrubSkolems(stripWildcards(ctx.subst.apply(inferredType)), ctx.skolemDisplayNames),
    undefined,
    ctx.aliasVars,
  );
  const expandedAnnot = expandAliases(ctx.typeAliases, rigidAnnotType, undefined, ctx.aliasVars);
  try {
    const inferredReturn = getReturnType(resolvedInferred);
    const annotReturn = getReturnType(expandedAnnot);
    if (isUnion(inferredReturn) &&
        !isUnion(annotReturn)) {
      for (const member of inferredReturn.args) {
        unify(member, annotReturn);
      }
    } else {
      unify(resolvedInferred, expandedAnnot);
    }
  } catch (e) {
    if (e instanceof UnificationError) {
      // Fold-completion leniency — see the constrained branch above.
      if (chainTerminalMatches(resolvedInferred, expandedAnnot)) return;
      // A narrower union result than the annotation declares is fine.
      if (unifyWidening(resolvedInferred, expandedAnnot)) return;
      const displayAnnot = expandAliases(ctx.typeAliases, instantiate(annotationScheme), undefined, ctx.aliasVars);
      if (containsErrorType(resolvedInferred) || containsErrorType(displayAnnot)) return;
      if (annotationHasArrowChainTuple(annotationScheme.type)) return;
      ctx.addDiag(
        annotationMismatchMessage(bindingNameFromNode(node), resolvedInferred, displayAnnot),
        narrowToIdentifier(node),
      );
    } else {
      throw e;
    }
  }
}

/**
 * Does the inferred type's spread-chain TERMINAL unify with a non-function
 * annotation type?  A top-level spread arrow chain (`a -> b -> ... -> z`)
 * only arises from an explicit `...` annotation and stands for the
 * heterogeneous fold that consumes all of its parameters at runtime, so an
 * asserting boundary (the annotation) compares against the completed fold —
 * the chain's terminal result.  Runs in isolation (trial unify only).
 */
function chainTerminalMatches(inferred: Type, annot: Type): boolean {
  if (inferred.tag !== 'TFun' || !hasTopLevelSpreadChain(inferred)) return false;
  if (annot.tag === 'TFun') return false;
  try {
    unify(flattenCurriedType(inferred).result, annot);
    return true;
  } catch (e) {
    if (e instanceof UnificationError) return false;
    throw e;
  }
}

/**
 * Annotations that keep the lenient (structural) check for function-valued
 * `const` bindings: overload unions (the body only has to satisfy SOME
 * branch per returned value) and spread-annotated variadics (`...`), whose
 * fixed-arity body can never match the open chain rigidly.
 */
const lenientArrowMemo = new WeakMap<Scheme, boolean>();

export function usesLenientArrowCheck(scheme: Scheme): boolean {
  const memo = lenientArrowMemo.get(scheme);
  if (memo !== undefined) return memo;
  const t = scheme.type;
  const lenient = (t.tag === 'TCon' && t.name === T_UNION) || someType(t, isSpread);
  lenientArrowMemo.set(scheme, lenient);
  return lenient;
}
