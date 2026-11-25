// ============================================================================
// Function-expression inference: inline-annotation validation, parameter
// binding, block return-type inference (extracted from expressions.ts)
//
// Plain language: when the checker meets a function being defined —
// `(a, b) => a + b` or `function f(x) { … }` — this file works out its type:
// give each parameter a placeholder (or the type from an annotation), walk
// the body to see how the parameters are used and what is returned, and
// assemble the resulting `param -> result` type.
// ============================================================================

import type * as estree from '../estree';
import * as walk from '../walking';
import {
  Type,
  Scheme,
  tVar,
  tCon,
  tFun,
  tVoid,
  tBool,
  isAnyType,
  tArray,
  tMultiFun,
  tRecord,
  tUnion,
  tAny,
  isSpread,
  mono,
  monoFrozen,
  typeToString,
  getReturnType,
  mergeReturnTypes,
  decomposeFunParams,
  canonicalizeDisplayVarsByName,
  AstNode,
  T_UNION,
  T_SPREAD_ARRAY,
  isUnion,
  isTuple,
  containsErrorType,
} from '../hm/types';
import { TypeEnv, instantiate, instantiateSkolem} from '../hm/env';
import { hoistFunctionDeclarations } from './statements';
import { unify, unifyWidening, UnificationError } from '../hm/unify';
import { TypeAnnotation} from '../commentParser';
import { lookupMethod, getMethodNames} from '../registries/methodRegistry';
import { isDataType} from '../registries/dataTypeRegistry';
import {
  freshenType,
  isSpreadTupleOrArray,
  neutralizeUnions,
  structuralEquals,
  scrubSkolems,
  mapType,
} from '../hm/typeUtils';
import {
  blockAlwaysReturns,
  removeNullUndefined,
  extractNullCheck,
  extractTypeofCheck,
  filterUnion,
  typeofCategoryMatches,
  extractTypePredicateNarrowing,
  computeNarrowedEnvs,
  extractLiteralGuardReturnInfo,
  blockHasThisAssignment,
  keyPresentAfter,
} from './narrowing';
import {
  narrowToIdentifier,
  hasUnknownTConDiagForScheme,
  annotationMismatchMessage,
  bindingNameFromNode,
  methodNameMismatchMessage,
} from './annotations';

import type { InferenceEngine } from './index';
import { inferExpression, inferExpressionWithExpected } from './expressions';

/**
 * Validate a function expression's inferred type against its inline annotation.
 * Detects sumtype factory functions (where the annotation is the source of truth)
 * and runs rigid check + unification for normal annotated functions.
 * Returns the (possibly updated) function type.
 */
function validateInlineAnnotation(
  engine: InferenceEngine,
  funcType: Type,
  inlineAnnotation: TypeAnnotation,
  inlineExpectedType: Type,
  node: estree.Function,
): Type {
  const annReturn = getReturnType(inlineAnnotation.scheme!.type);
  const inferredReturn = getReturnType(funcType);
  let isSumTypeFactory = false;
  if (annReturn.tag === 'TCon' && isDataType(annReturn.name)) {
    if (inferredReturn.tag === 'TVar'
        || (inferredReturn.tag === 'TCon' && isDataType(inferredReturn.name))) {
      isSumTypeFactory = true;
    } else if (inferredReturn.tag === 'TRecord') {
      const required = getMethodNames(annReturn.name);
      isSumTypeFactory = required.length === 0
        || required.every(m => m in inferredReturn.fields);
    }
  }
  if (!isSumTypeFactory) {
    const diagNode: AstNode = inlineAnnotation.nameStart != null && inlineAnnotation.nameEnd != null
      ? { start: inlineAnnotation.nameStart, end: inlineAnnotation.nameEnd } as AstNode
      : node as AstNode;
    const diagsBefore = engine.diagnostics.length;
    engine.checkRigid(funcType, inlineAnnotation.scheme!, diagNode);
    if (engine.diagnostics.length === diagsBefore) {
      engine.unifyWithDiagnostic(funcType, inlineExpectedType, diagNode);
    }
  }
  if (isSumTypeFactory) {
    // For sumtype factory functions, trust the annotation completely.
    // Still validate the record fields' types against registered methods.
    if (inferredReturn.tag === 'TRecord' && annReturn.tag === 'TCon') {
      const methodNames = getMethodNames(annReturn.name);
      if (methodNames.length > 0) {
        const expReturn = getReturnType(inlineExpectedType);
        const typeArgs = (expReturn?.tag === 'TCon' ? expReturn.args : []) as Type[];
        const expectedFields: Record<string, Type> = {};
        for (const mn of methodNames) {
          const entry = lookupMethod(annReturn.name, mn);
          if (entry) expectedFields[mn] = neutralizeUnions(entry.factory(typeArgs));
        }
        engine.unifyWithDiagnostic(inferredReturn, tRecord(expectedFields), node as AstNode);
      }
    }
    return inlineExpectedType;
  } else {
    return engine.subst.apply(funcType);
  }
}

/**
 * Collect the identifier names bound by a list of binding patterns
 * (function parameters or `var`/`let`/`const` declarator targets):
 * plain identifiers, defaults (`x = …`), rest (`...xs`), and array/object
 * destructuring.
 */
function collectPatternNames(nodes: (AstNode | null | undefined)[], out: Set<string>): void {
  for (const n of nodes) {
    if (!n) continue;
    switch (n.type) {
      case 'Identifier':
        out.add((n as unknown as estree.Identifier).name);
        break;
      case 'AssignmentPattern':
        collectPatternNames([(n as unknown as estree.AssignmentPattern).left as AstNode], out);
        break;
      case 'RestElement':
        collectPatternNames([(n as unknown as estree.RestElement).argument as AstNode], out);
        break;
      case 'ArrayPattern':
        collectPatternNames((n as unknown as estree.ArrayPattern).elements as AstNode[], out);
        break;
      case 'ObjectPattern':
        for (const p of (n as unknown as estree.ObjectPattern).properties) {
          if (p.type === 'RestElement') collectPatternNames([(p as unknown as estree.RestElement).argument as AstNode], out);
          else collectPatternNames([(p as unknown as estree.Property).value as AstNode], out);
        }
        break;
    }
  }
}

/**
 * Recursively collect the names declared by `var` statements anywhere within a
 * function body, WITHOUT descending into nested function scopes (which have
 * their own `var` environment).  JavaScript hoists `var` declarations to the
 * top of the enclosing function, so a `var` declared in one block is visible
 * in sibling blocks — e.g. two `for` loops sharing `var idx` (FP-library
 * `object/sortBy.js`).
 */
function collectHoistedVarNames(node: AstNode | null | undefined, out: Set<string>): void {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  if (node.type === 'FunctionDeclaration'
      || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression') {
    return; // nested function: its `var`s belong to its own scope
  }
  if (node.type === 'VariableDeclaration'
      && (node as unknown as estree.VariableDeclaration).kind === 'var') {
    for (const d of (node as unknown as estree.VariableDeclaration).declarations) {
      collectPatternNames([d.id as AstNode], out);
    }
  }
  for (const key of Object.keys(node as object)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const val = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(val)) {
      for (const c of val) collectHoistedVarNames(c as AstNode, out);
    } else if (val && typeof val === 'object' && typeof (val as { type?: unknown }).type === 'string') {
      collectHoistedVarNames(val as AstNode, out);
    }
  }
}

/** Origin descriptor (annotation name + comment range) for skolem
 *  registration — lets diagnostics point back at the declaring annotation
 *  when two same-letter skolems collide in one message. */
function annotationOrigin(annotation: TypeAnnotation, node: estree.Function): { name?: string; start: number; end: number } {
  return {
    name: annotation.name,
    start: annotation.commentStart ?? node.start,
    end: annotation.commentEnd ?? node.end,
  };
}

/**
 * When a method annotation's receiver (`Type#m :: Type e a ~> …`) names the
 * SAME constructor (same arity) as the return type of an enclosing annotated
 * function, the record under construction is the receiver itself.  Returns a
 * map from the receiver's type-variable ids to the enclosing return type's
 * corresponding arguments, so `skolemSubstForScheme` pins them instead of
 * minting fresh skolems.
 */
function enclosingReceiverBindings(engine: InferenceEngine, receiver: Type): Map<number, Type> | undefined {
  if (receiver.tag !== 'TCon') return undefined;
  for (let i = engine.enclosingAnnotatedReturns.length - 1; i >= 0; i--) {
    const ret = engine.subst.apply(engine.enclosingAnnotatedReturns[i]);
    if (ret.tag !== 'TCon' || ret.name !== receiver.name || ret.args.length !== receiver.args.length) continue;
    const bindings = new Map<number, Type>();
    for (let j = 0; j < receiver.args.length; j++) {
      const rv = receiver.args[j];
      if (rv.tag === 'TVar') bindings.set(rv.id, ret.args[j]);
    }
    if (bindings.size > 0) return bindings;
  }
  return undefined;
}

/**
 * Lexically scoped type variables: a type variable in a NESTED annotation that
 * also occurs in an enclosing (skolemized) annotation is the same variable —
 * like a generic `T` inside an inner function in TypeScript.  `engine.
 * scopedTypeVars` maps those letters to the enclosing body's skolems; it is
 * extended while a skolem-checked body is inferred and restored afterwards.
 */
/** `!x` or `!obj.prop` (any number of `!`, an odd count): a falsiness test. */
function isNegatedReference(test: AstNode): boolean {
  let target = test;
  let negations = 0;
  while (target.type === 'UnaryExpression' && (target as estree.UnaryExpression).operator === '!') {
    negations += 1;
    target = (target as estree.UnaryExpression).argument as AstNode;
  }
  if (negations % 2 === 0) return false;
  return target.type === 'Identifier'
    || (target.type === 'MemberExpression' && (target as estree.MemberExpression).object.type === 'Identifier');
}

export function inferFunctionExpression(engine: InferenceEngine, node: estree.Function, env: TypeEnv, expectedType?: Type): Type {
  const prevScoped = engine.scopedTypeVars;
  const prevRigidRows = engine.rigidRowIds;
  try {
    return inferFunctionExpressionScoped(engine, node, env, expectedType);
  } finally {
    engine.scopedTypeVars = prevScoped;
    engine.rigidRowIds = prevRigidRows;
  }
}

/** Bind the annotation letters already in lexical scope to the enclosing
 *  skolems, then add this body's own skolems to the scope.  Returns the
 *  mapping to apply to every type minted from the same annotation (the
 *  expected function type, and for a method also its `this` type). */
function scopeSkolems(engine: InferenceEngine, skolemToName: Map<string, string>): (t: Type) => Type {
  const outer = engine.scopedTypeVars;
  const captured = new Map<string, Type>();
  const next = new Map(outer);
  for (const [sk, letter] of skolemToName) {
    const outerSk = outer.get(letter);
    if (outerSk) captured.set(sk, outerSk);
    else next.set(letter, { tag: 'TCon', name: sk, args: [], skolemName: letter });
  }
  engine.scopedTypeVars = next;
  if (captured.size === 0) return t => t;
  return t => mapType(t, n => (n.tag === 'TCon' && captured.has(n.name) ? captured.get(n.name) : undefined));
}

function inferFunctionExpressionScoped(engine: InferenceEngine, node: estree.Function, env: TypeEnv, expectedType?: Type): Type {
  let inlineAnnotation: TypeAnnotation | undefined;
  let inlineExpectedType: Type | undefined;
  let inlineMethodThisType: Type | undefined;
  // When the annotated body is checked against rigid skolem constants (so the
  // body can never poison the annotation's parameter / `this` / return
  // display), this holds the skolem→letter map for that signature.  Its
  // presence also marks that the annotation is authoritative for the returned
  // function type (the body only *checks* against it).
  let inlineSkolemNames: Map<string, string> | undefined;

  // Inline HM annotation on anonymous function expressions:
  //   foo(
  //     // :: Number -> String
  //     x => x + "!"
  //   )
  const annotation = engine.annotationByOffset.get(node.start);
  if (annotation?.scheme && !annotation.receiver && !annotation.name?.includes('#')) {
    inlineAnnotation = annotation;
    const constrained = !!(annotation.scheme.constraints && annotation.scheme.constraints.length > 0);
    // When the annotation references an unknown type constructor it already
    // carries its own "unknown type constructor" diagnostic; rigid skolem
    // checking of the body would only pile on spurious "Cannot unify" noise,
    // so fall back to flexible instantiation (matching the existing
    // suppression of mismatch checks for unknown-TCon schemes).
    const useFlexible = constrained || hasUnknownTConDiagForScheme(engine.diagnostics, annotation.scheme);
    if (useFlexible) {
      // Constrained schemes (e.g. `Functor f =>`) keep the existing
      // constraint-aware instantiation path; skolemizing them would defeat
      // constraint resolution.
      inlineExpectedType = engine.instantiateWithConstraints(annotation.scheme, node as AstNode, annotation, false, undefined, true);
    } else {
      const sk = instantiateSkolem(annotation.scheme);
      engine.registerSkolemNames(sk.skolemToName, annotationOrigin(annotation, node));
      inlineSkolemNames = sk.skolemToName;
      inlineExpectedType = scopeSkolems(engine, sk.skolemToName)(sk.type);
    }
    expectedType = inlineExpectedType;
  } else if (annotation?.receiver && annotation?.methodType && annotation?.scheme && !expectedType) {
    // Method annotation directly above a function expression (e.g. inside a
    // factory function):  // Either2#map :: Either2 e a ~> (a -> b) -> Either2 e b
    //   const map = fn => ...
    // Share the receiver + method type variables (skolems when unconstrained)
    // so the body can be checked without poisoning the displayed signature.
    const constrained = !!(annotation.scheme.constraints && annotation.scheme.constraints.length > 0);
    const useFlexible = constrained || hasUnknownTConDiagForScheme(engine.diagnostics, annotation.scheme);
    if (useFlexible) {
      const { thisType: methodThis, expectedType: methodExpected } = engine.coordinateInstantiate(annotation);
      inlineMethodThisType = methodThis;
      inlineExpectedType = methodExpected;
    } else {
      // For a method annotation nested inside an annotated factory whose
      // signature returns the SAME constructor (`// Either2#map :: Either2 e a ~> …`
      // above `const map = fn => …` in a factory returning `Either2 e a`),
      // the record under construction IS the receiver.  Link the receiver's
      // type variables to the enclosing return type's arguments so closure
      // captures (`value :: e | a`) and the method's own signature agree,
      // instead of minting unrelated same-letter rigid skolems that collide
      // as "Cannot unify 'a' with 'a''".
      const preBindings = enclosingReceiverBindings(engine, annotation.receiver);
      const sk = engine.coordinateInstantiateSkolem(annotation, preBindings);
      engine.registerSkolemNames(sk.skolemToName, annotationOrigin(annotation, node));
      inlineSkolemNames = sk.skolemToName;
      const scoped = scopeSkolems(engine, sk.skolemToName);
      inlineMethodThisType = sk.thisType && scoped(sk.thisType);
      inlineExpectedType = scoped(sk.expectedType);
    }
    const methodScheme: Scheme = { vars: annotation.scheme.vars, type: inlineExpectedType };
    inlineAnnotation = { ...annotation, scheme: methodScheme };
    expectedType = inlineExpectedType;
  }

  // Method annotations with receivers (handled elsewhere) may still carry a
  // name mismatch that should be reported at the implementation site.
  if (annotation?.methodNameMismatch && annotation.name) {
    // Point the diagnostic at the name identifier when location info is available,
    // otherwise fall back to the whole function node.
    const mismatchLoc = (annotation.mismatchNameStart != null && annotation.mismatchNameEnd != null)
      ? { start: annotation.mismatchNameStart, end: annotation.mismatchNameEnd }
      : node as AstNode;
    engine.addDiag(
      methodNameMismatchMessage(annotation.methodNameMismatch, annotation.name),
      mismatchLoc,
      [{ message: `Annotation '${annotation.name}' defined here`, start: annotation.commentStart, end: annotation.commentEnd }],
    );
  }

  // For explicit inline annotations on anonymous callbacks, do not allow
  // auto-union to silently broaden mismatches (e.g. Number vs Boolean).
  const prevSuppressAutoUnion = engine.suppressAutoUnion;
  if (inlineAnnotation) {
    engine.suppressAutoUnion = true;
  }
  let pushedEnclosingReturn = false;

  try {

  // Create fresh type variables for parameters
  let fnEnv = env;

  // Bind `this` for inline method annotations (e.g. Box#map :: Box a ~> ...)
  // so that `this.value` etc. resolve correctly inside the method body.
  if (inlineMethodThisType) {
    fnEnv = fnEnv.extend('this', mono(inlineMethodThisType));
    // Mark `this` as coming from a signature receiver so hover freezes it
    // (renders with the signature's own letters — rule #1).
    fnEnv = fnEnv.extend('__signatureThis', mono(tVoid));
  }

  // If we have an expected type from an annotation, decompose it to get
  // parameter types so they are known *before* body inference.
  let expectedParamTypes: Type[] | undefined;
  let expectedBodyType: Type | undefined;
  let extraExpectedParamTypes: Type[] | undefined;
  // Per-position DISPLAY unions for overloaded functions (union-of-TFun
  // annotations).  These are display-only — the body keeps fresh monomorphic
  // parameter vars — but they drive hover and call-site polymorphism
  // protection for every reference to the parameter.
  let frozenParamDisplays: (Type | undefined)[] | undefined;
  if (expectedType) {
    const resolved = engine.subst.apply(expectedType);
    const decomposed = decomposeFunParams(resolved, node.params.length);
    if (decomposed) {
      expectedParamTypes = decomposed.paramTypes;
      expectedBodyType = decomposed.restType;
      extraExpectedParamTypes = decomposed.extraParamTypes;
    } else if (resolved.tag === 'TCon' && resolved.name === T_UNION) {
      // Union expected type.  Since this code only runs for function literals
      // (arrow / function expressions), the argument can only inhabit a
      // function-typed branch — the non-function members (e.g. the `Undefined`
      // of an optional-callback slot `((String, String) -> Number) | Undefined`)
      // are impossible for a literal function.  Filter to the callable branches
      // and NARROW the union to them.
      const funBranches = resolved.args.filter(b => b.tag === 'TFun');
      if (funBranches.length === 1) {
        // Single callable branch (typically an optional-callback slot).
        // Decompose it directly so the parameters get their contextual types
        // BEFORE body inference.  Without this the arrow's params stay fresh
        // vars and only get back-propagated by a whole-function unify against
        // the union — which fails atomically while the body is still being
        // typed (e.g. `(a, b) => a` before the comparison is written), losing
        // hover/completion inside the body.
        const branchDecomposed = decomposeFunParams(funBranches[0], node.params.length);
        if (branchDecomposed) {
          expectedParamTypes = branchDecomposed.paramTypes;
          expectedBodyType = branchDecomposed.restType;
          extraExpectedParamTypes = branchDecomposed.extraParamTypes;
        }
      } else if (funBranches.length >= 2) {
        // Overloaded annotation: compute the union of each parameter position
        // across all callable branches for display.  Decompose every branch by
        // this arrow level's arity and collect per-position types.
        const arity = node.params.length;
        const perBranch = funBranches.map(b => decomposeFunParams(b, arity));
        if (perBranch.every(d => d != null && d.paramTypes.length === arity)) {
          frozenParamDisplays = [];
          for (let i = 0; i < arity; i++) {
            frozenParamDisplays.push(
              canonicalizeDisplayVarsByName(tUnion(perBranch.map(d => d!.paramTypes[i]))),
            );
          }
        }
      }
    }
  }

  // For async functions, the body's `return X` produces an `X` value but
  // the function's caller-visible return type is `Promise X`.  When an
  // outer annotation pins the function as `... -> Promise T`, the body
  // should be checked against `T` (not `Promise T`).  Peel one Promise
  // layer off the expected body type so unification of the inner return
  // expression succeeds.
  if (node.async && expectedBodyType) {
    const resolvedExpected = engine.subst.apply(expectedBodyType);
    if (resolvedExpected.tag === 'TCon' && resolvedExpected.name === 'Promise'
        && resolvedExpected.args.length === 2) {
      expectedBodyType = resolvedExpected.args[1];
    }
  }

  // A callback whose context expects `… -> ()` (an event handler, a
  // `forEach` body): its result is ignored, as in TypeScript, where
  // `() => void` accepts any result.  `onClick={() => dispatch (action)}`
  // is then fine.  Only for a function literal without its own annotation
  // (an annotated `f :: () -> ()` that returns a value stays an error).
  let discardsResult = false;
  const ownBinding = engine.annotationMethodNode as { init?: unknown } | null | undefined;
  const hasOwnAnnotation = !!inlineAnnotation || (ownBinding != null && ownBinding.init === node);
  if (!hasOwnAnnotation && expectedBodyType && !node.generator && !node.async) {
    const expectedResult = engine.subst.apply(expectedBodyType);
    if (expectedResult.tag === 'TCon' && expectedResult.name === 'Void' && expectedResult.args.length === 0) {
      discardsResult = true;
      expectedBodyType = undefined;
    }
  }

  // Expose the annotated signature's RETURN type to nested method annotations
  // while this body is inferred: a `Type#m :: Type e a ~> …` on a const inside
  // this function describes a method of the record under construction, so its
  // receiver vars should be THIS signature's vars (see the method-annotation
  // branch above).  Only for the rigid (skolemized) path — constrained
  // annotations keep their flexible constraint-aware instantiation.
  if (inlineAnnotation && inlineSkolemNames && expectedBodyType) {
    engine.enclosingAnnotatedReturns.push(getReturnType(expectedBodyType));
    pushedEnclosingReturn = true;
  }

  // Checked against its own annotation: the parameters' rows are rigid in
  // the body (`{ name :: String, ...r }` has no `title`).
  const ownDeclaration = engine.annotationMethodNode as unknown;
  if (expectedParamTypes && (hasOwnAnnotation || ownDeclaration === node)) {
    const rows = new Set(engine.rigidRowIds);
    for (const p of expectedParamTypes) collectRowIds(engine.subst.apply(p), rows);
    engine.rigidRowIds = rows;
  }

  const { fnEnv: fnEnvBound, paramTypes } = bindFunctionParams(engine, node.params as AstNode[], expectedParamTypes, fnEnv, frozenParamDisplays);
  fnEnv = fnEnvBound;

  // Named function expressions (e.g. `(function step(v) { … })(i)`) bind
  // their own name inside the body scope so self-recursive calls resolve.
  // Bind a fresh var now; it is unified with the assembled function type
  // below, once the body has been inferred.
  let selfRefVar: Type | undefined;
  const fnExprName = node.type === 'FunctionExpression' ? (node as estree.FunctionExpression).id?.name : undefined;
  if (fnExprName) {
    selfRefVar = tVar();
    fnEnv = fnEnv.extend(fnExprName, mono(selfRefVar));
  }

  // Hoist function-scoped `var` declarations.  JavaScript `var`s are visible
  // throughout the whole function body regardless of the block they appear in,
  // so pre-bind every `var` name (excluding those already bound as parameters)
  // with a fresh type variable.  Without this, a `var` declared in one block
  // and reused in a sibling block (e.g. two `for` loops sharing `var idx`)
  // reports a spurious "Unbound variable".  Later `VariableDeclaration` /
  // assignment inference refines these fresh vars.
  if (node.body.type === 'BlockStatement') {
    const paramNames = new Set<string>();
    collectPatternNames(node.params as AstNode[], paramNames);
    const hoistedVarNames = new Set<string>();
    collectHoistedVarNames(node.body as AstNode, hoistedVarNames);
    for (const vname of hoistedVarNames) {
      if (paramNames.has(vname)) continue;
      fnEnv = fnEnv.extend(vname, mono(tVar()));
    }
  }

  // Infer body, passing remaining expected type for nested functions
  // When the annotation has a spread tuple, the body may contain
  // reduce/reduceRight calls whose internal typing can't fully express
  // the polymorphic chain composition.  Suppress diagnostics produced
  // during body inference in that case — the annotation is the source
  // of truth.
  const hasSpreadParam = paramTypes.some(
    p => isSpreadTupleOrArray(p) ||
         // Curry wrapper: param is a function with spread tuple
         (p.tag === 'TFun' && isSpreadTupleOrArray(p.param)),
  );
  const diagsBefore = hasSpreadParam ? engine.diagnostics.length : -1;

  // Generators: the declared return type is the YIELD (element) type, and the
  // body's own `return`s produce the generator's *return value* (typically
  // undefined).  Capture the declared element type, stop checking `return`s
  // against it, and start a yield frame so `yield`/`yield*` expressions
  // contribute their element types (collected in expressions.ts YieldExpression).
  let expectedYieldType: Type | undefined;
  if (node.generator) {
    expectedYieldType = expectedBodyType;
    expectedBodyType = undefined;
    engine.generatorYieldStack.push([]);
  }

  let returnType: Type;
  if (node.body.type === 'BlockStatement') {
    // Block body: look for return statements
    returnType = inferBlockReturnType(engine, node.body, fnEnv, expectedBodyType);
  } else {
    // Expression body (arrow function)
    returnType = inferExpressionWithExpected(engine, node.body as AstNode, fnEnv, expectedBodyType);

    // Check: expression body returning a union where a concrete type is expected
    if (expectedBodyType) {
      checkUnionVsExpected(engine, returnType, expectedBodyType, node.body as AstNode);
    }
  }
  if (discardsResult) returnType = tVoid;

  // Drop body diagnostics for spread-annotated functions
  if (diagsBefore >= 0) {
    engine.diagnostics.length = diagsBefore;
  }

  // Generators: replace the inferred `return`-based result with the collected
  // yield (element) type so the function type is `(params) -> <element>`.  A
  // call to the function wraps this element type in `Generator` at the call
  // site (see calls.ts / engine.generatorFunctionNames).
  if (node.generator) {
    const frame = engine.generatorYieldStack.pop() ?? [];
    const applied = frame.map((t) => engine.subst.apply(t));
    let yieldType: Type =
      applied.length === 0 ? tVar()
      : applied.length === 1 ? applied[0]
      : tUnion(applied);
    if (expectedYieldType) {
      engine.unifyWithDiagnostic(yieldType, engine.subst.apply(expectedYieldType), node as AstNode);
      yieldType = engine.subst.apply(expectedYieldType);
    }
    returnType = yieldType;
  }

  // Build function type:
  //   1 param:  a -> result
  //   2+ params: (a, b, ...) -> result  (Tuple-based)
  // When a function expression has fewer params than the expected type
  // (JS allows ignoring trailing callback params), pad the function type
  // with the extra expected param types so it matches the caller's shape.
  let allParams = paramTypes.map((p) => engine.subst.apply(p));
  if (extraExpectedParamTypes && extraExpectedParamTypes.length > 0) {
    allParams = [...allParams, ...extraExpectedParamTypes];
  }
  let funcType: Type = tMultiFun(allParams, returnType);

  // Zero-param function expressions: tMultiFun([], T) collapses to T, but the
  // expression IS a function, so wrap as () -> T to preserve the function
  // shape.  This must happen EVEN when T is itself a function (e.g. a thunk
  // `() => x => x` returning `a -> a`): without the wrapper the nullary level
  // is lost and the value looks like a plain unary `a -> a`, which breaks
  // immediately-invoked uses such as `(() => x => x)()`.
  if (allParams.length === 0) {
    funcType = tFun(tVoid, funcType);
  }

  // Async functions: wrap return type in Promise<T> if not already a Promise.
  // Normally the wrap is skipped when an annotation provides a complete
  // expectedType (because the annotation should already mention Promise).
  // However when an outer annotation pins this function as `... -> Promise T`
  // we peeled the Promise off expectedBodyType above so the body could
  // unify with `T`; here we wrap the inferred return back into `Promise T`
  // so the function type matches the annotation shape.
  const expectedReturnIsPromise =
    !!expectedBodyType
    && (() => {
      // expectedBodyType has been peeled if outer was Promise; check the
      // *original* expected return type instead.
      if (!expectedType) return false;
      const r = engine.subst.apply(expectedType);
      const dec = decomposeFunParams(r, node.params.length);
      const orig = dec?.restType ? engine.subst.apply(dec.restType) : null;
      return !!orig && orig.tag === 'TCon' && orig.name === 'Promise';
    })();
  if (node.async && (!expectedType || expectedReturnIsPromise)) {
    const resolvedReturn = engine.subst.apply(returnType);
    if (!(resolvedReturn.tag === 'TCon' && resolvedReturn.name === 'Promise')) {
      const wrappedReturn = tCon('Promise', [tVar(), resolvedReturn]);
      funcType = tMultiFun(allParams, wrappedReturn);
      if (allParams.length === 0) {
        funcType = tFun(tVoid, funcType);
      }
    }
  }

  // Tie the self-reference var of a named function expression to the final
  // function type so recursive calls in the body agree with the whole type.
  if (selfRefVar) {
    engine.unifyWithDiagnostic(engine.subst.apply(selfRefVar), funcType, node as AstNode);
    funcType = engine.subst.apply(funcType);
  }

  // For FunctionDeclaration nodes, inferFunctionDeclaration (statements.ts)
  // already handles annotation checking — skip the validate call here to avoid
  // duplicate diagnostics, and leave the body skolems on the returned type so
  // statements.ts's own rigid check can still detect a genuinely wrong body
  // (the central scrub in checkAnnotationRigid removes the false self-mismatch
  // while preserving real shape differences).  The declaration binds and
  // displays the annotation scheme directly, so the skolems never surface.
  if (inlineAnnotation?.scheme && inlineExpectedType && node.type !== 'FunctionDeclaration'
      && engine.annotationCheckedByBinding !== (node as AstNode)) {
    funcType = validateInlineAnnotation(engine, funcType, inlineAnnotation, inlineExpectedType, node);
    // When the body was checked against rigid skolems, the annotation is the
    // authoritative type — the body only *validates* against it and must not
    // determine the displayed parameter / `this` / return types (a stub body
    // that returned `()` would otherwise leak into the signature).  Replace the
    // returned function type with the annotation itself, scrubbing the skolems
    // back to ordinary display variables so no downstream consumer (call sites,
    // generalize(), or a second rigid check at the assignment / prototype site)
    // ever sees `§N` constants.
    if (inlineSkolemNames) {
      funcType = scrubSkolems(engine.subst.apply(inlineExpectedType), inlineSkolemNames);
    }
  }

  // Detect literal equality guard patterns for conditional return narrowing.
  if (node.body?.type === 'BlockStatement' && !inlineAnnotation && !expectedType) {
    tryDetectConditionalReturn(engine, node, returnType);
  }

  return funcType;

  } finally {
    engine.suppressAutoUnion = prevSuppressAutoUnion;
    if (pushedEnclosingReturn) engine.enclosingAnnotatedReturns.pop();
  }
}

/**
 * Bind the parameters of a function to fresh type variables (or the expected
 * types provided by an outer annotation) and extend the function's local
 * environment accordingly.  Returns the extended environment and the ordered
 * list of parameter types so the caller can build the function's TFun type.
 */
/** Ids of the row variables (`...r`) of every record inside a type. */
function collectRowIds(t: Type, out: Set<number>): void {
  switch (t.tag) {
    case 'TRecord':
      if (t.rest && (t.rest.tag === 'TVar' || t.rest.tag === 'TRow')) out.add(t.rest.id);
      for (const f of Object.values(t.fields)) collectRowIds(f, out);
      return;
    case 'TFun':
      collectRowIds(t.param, out);
      collectRowIds(t.result, out);
      return;
    case 'TCon':
      for (const a of t.args) collectRowIds(a, out);
      return;
    default:
      return;
  }
}

export function bindFunctionParams(
  engine: InferenceEngine,
  params: AstNode[],
  expectedParamTypes: Type[] | undefined,
  env: TypeEnv,
  frozenDisplays?: (Type | undefined)[],
): { fnEnv: TypeEnv; paramTypes: Type[] } {
  let fnEnv = env;
  const paramTypes: Type[] = [];

  // A variadic expected shape (`(a, b, ...) -> z`, e.g. `curryN (3) ((x, y,
  // flag) => …)`) fixes only the positions BEFORE its `...`; the spread
  // marker itself is never a parameter's type.
  const spreadIdx = expectedParamTypes ? expectedParamTypes.findIndex(isSpread) : -1;
  if (spreadIdx >= 0) expectedParamTypes = expectedParamTypes!.slice(0, spreadIdx);
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    // When an expected param type is available (from an annotation or
    // caller), use it directly instead of creating a fresh TVar.
    // This preserves the original TVars so that auto-union can trace
    // back to them through the substitution chain.
    let paramType: Type;
    if (expectedParamTypes && i < expectedParamTypes.length) {
      paramType = expectedParamTypes[i];
    } else if (param.type === 'RestElement') {
      // Rest parameter without annotation: use wildcard type (*)
      // so that (...args) => fn(...args) infers as (* -> a) -> * -> a
      paramType = tAny;
    } else {
      paramType = tVar();
    }
    paramTypes.push(paramType);
    // A parameter's *declared* type is the annotation the user wrote.  Body
    // inference may later bind the annotation's row / value vars (e.g.
    // `Object.keys(obj)` closing an open `{ a }` row to `{}`), which would
    // poison the live-substituted hover type.  Capture the annotated shape now
    // so hover can always display the signature form the user wrote, for every
    // object form (`{ a }`, `{ ...a }`, `{ [k] :: a }`, `{ x :: Number }`, …).
    const isAnnotatedParam = !!(expectedParamTypes && i < expectedParamTypes.length);

    // Overloaded functions expose a per-position UNION as the parameter's
    // declared type (e.g. `foldable :: f a | String`).  The body keeps a fresh
    // monomorphic variable (so branch inference is unaffected), but the binding
    // carries the union as its `frozenDisplay` — this drives hover at every
    // reference AND lets call sites protect the polymorphic parameter from
    // being pinned by unrelated helpers (see `shouldProtectPolymorphicParamArg`).
    const frozenDisplay = !isAnnotatedParam ? frozenDisplays?.[i] : undefined;

    if (param.type === 'Identifier') {
      // Rank-N: a `forall`-annotated parameter binds POLYMORPHICALLY in the
      // body.  The binding is a genuine Scheme quantifying the forall's own
      // vars, so EVERY use of the parameter instantiates fresh — `f(n)` and
      // `f(s)` in one body each get their own copy of `a -> a`.  The TForall
      // itself is kept as `frozenDisplay` so hover renders the quantifier.
      if (paramType.tag === 'TForall') {
        const polyScheme: Scheme = {
          vars: paramType.vars,
          type: paramType.body,
          constraints: paramType.constraints,
          frozenDisplay: paramType,
        };
        fnEnv = fnEnv.extend(param.name, polyScheme);
        engine.recordNodeType(param, paramType);
        engine.frozenParamType.set(param.start, paramType);
      } else if (paramType.tag === 'TCon' && paramType.name === T_SPREAD_ARRAY &&
          paramType.args.some(a => isSpread(a))) {
        // If the expected param type is a SpreadArray, bind as Array<elemType> in the body
        const firstElem = paramType.args.find(a => !isSpread(a));
        const elemType = firstElem ? freshenType(firstElem) : tVar();
        const bound = tArray(elemType);
        fnEnv = fnEnv.extend(param.name, isAnnotatedParam ? monoFrozen(bound) : mono(bound));
        engine.recordNodeType(param, bound);
        if (isAnnotatedParam) engine.frozenParamType.set(param.start, bound);
      } else if (frozenDisplay) {
        fnEnv = fnEnv.extend(param.name, monoFrozen(paramType, frozenDisplay));
        engine.recordNodeType(param, frozenDisplay);
        engine.frozenParamType.set(param.start, frozenDisplay);
      } else {
        fnEnv = fnEnv.extend(param.name, isAnnotatedParam ? monoFrozen(paramType) : mono(paramType));
        engine.recordNodeType(param, paramType);
        if (isAnnotatedParam) engine.frozenParamType.set(param.start, paramType);
      }
    } else if (param.type === 'AssignmentPattern') {
      // Default parameter: (x = defaultValue)
      const ident = param.left;
      if (ident?.type === 'Identifier') {
        // Treat `(x = undefined)` purely as an optionality marker — do
        // not unify the param type with `Undefined`.  This keeps `x`
        // polymorphic so annotations like `(a, b, c) -> r` remain valid
        // while signaling to call-site arity checks that the slot may
        // be omitted (see `optionalParamSlots`).
        const isUndefinedDefault =
          param.right?.type === 'Identifier' &&
          (param.right as { name?: string }).name === 'undefined';
        if (!isUndefinedDefault) {
          const defaultType = inferExpression(engine, param.right, fnEnv);
          engine.unifyWithDiagnostic(paramType, defaultType, param.right);
        }
        let resolvedParamType = engine.subst.apply(paramType);
        // A default value guarantees the parameter is never Undefined at runtime.
        const narrowed = removeNullUndefined(resolvedParamType);
        // The *declared* type for display is the annotation (pre-narrow); the
        // body binding stays `narrowed` so inference is unaffected.
        fnEnv = fnEnv.extend(ident.name, isAnnotatedParam ? monoFrozen(narrowed, paramType) : mono(narrowed));
        engine.recordNodeType(ident, narrowed);
        if (isAnnotatedParam) engine.frozenParamType.set(ident.start, paramType);
      }
    } else if (param.type === 'RestElement') {
      // Rest parameter: (...args) — type args as Array<elemType>
      const ident = param.argument;
      if (ident?.type === 'Identifier') {
        let elemType: Type;
        if (isTuple(paramType) &&
            paramType.args.some(a => isSpread(a))) {
          const firstElem = paramType.args.find(a => !isSpread(a));
          elemType = firstElem ? freshenType(firstElem) : tVar();
        } else {
          elemType = tVar();
        }
        const bound = tArray(elemType);
        fnEnv = fnEnv.extend(ident.name, isAnnotatedParam ? monoFrozen(bound) : mono(bound));
        engine.recordNodeType(ident, bound);
        if (isAnnotatedParam) engine.frozenParamType.set(ident.start, bound);
      }
    } else if (param.type === 'ObjectPattern' || param.type === 'ArrayPattern') {
      const { env: destructuredEnv } = engine.inferDestructuringPattern(param, paramType, fnEnv, 'const', isAnnotatedParam);
      fnEnv = destructuredEnv;
      // Record the pattern's type so completion/hover can resolve the
      // destructured parameter to its full record/array type.
      engine.recordNodeType(param, paramType);
      if (isAnnotatedParam) engine.frozenParamType.set(param.start, paramType);
    }
  }

  return { fnEnv, paramTypes };
}

/**
 * When a function's inferred return type is a Union, check whether its body
 * contains a literal equality guard pattern (e.g. `if (x === 'a') return T`).
 * If so, record the guard info so that call sites passing a matching literal
 * can narrow the union return type to just the branch's return type.
 */
export function tryDetectConditionalReturn(engine: InferenceEngine, node: estree.Function, returnType: Type): void {
  const resolvedReturn = engine.subst.apply(returnType);
  if (!isUnion(resolvedReturn)) return;
  const paramNames: string[] = [];
  for (const param of node.params) {
    if (param.type === 'Identifier') {
      paramNames.push(param.name as string);
    } else if (param.type === 'AssignmentPattern' && param.left?.type === 'Identifier') {
      paramNames.push(param.left.name as string);
    } else {
      paramNames.push('');
    }
  }
  if (paramNames.length >= 1) {
    const guardInfo = extractLiteralGuardReturnInfo(engine.subst, node.body as AstNode, paramNames, (n) => collectAllReturnTypes(engine, n));
    if (guardInfo) engine.pendingConditionalReturn = guardInfo;
  }
}

/**
 * Check that a union return type is compatible with a concrete expected type.
 * The standard unifier is too lenient here — it lets Union(A, B) unify with
 * A because A is a member.  This helper verifies each union member individually
 * and emits a diagnostic at `reportNode` if any member fails to match.
 */
/** The members of a (nested) union, resolved and with aliases expanded. */
function flattenUnionMembers(engine: InferenceEngine, t: Type): Type[] {
  const out: Type[] = [];
  const collect = (u: Type): void => {
    const r = engine.maybeExpandAlias(engine.subst.apply(u));
    if (isUnion(r)) for (const m of (r as import('../hm/types').TCon).args) collect(m);
    else out.push(r);
  };
  collect(t);
  return out;
}

export function checkUnionVsExpected(engine: InferenceEngine, returnType: Type, expectedType: Type, reportNode: AstNode): void {
  const resolvedReturn = engine.subst.apply(returnType);
  const resolvedExpected = engine.subst.apply(expectedType);
  // Both unions (`b ? "ja" : b ? 2 : null` against `String | Null`): every
  // returned member must fit a member of the expected union.  The symmetric
  // unifier accepts two unions as soon as one contains the other, so the
  // returned `Null | Number | String` passed for `String | Null`.
  if (isUnion(resolvedReturn) && isUnion(resolvedExpected)) {
    const expectedMembers = flattenUnionMembers(engine, resolvedExpected);
    if (expectedMembers.some(m => m.tag === 'TVar' || isAnyType(m))) return;
    const stray = flattenUnionMembers(engine, resolvedReturn).find(member =>
      member.tag !== 'TVar' && !isAnyType(member)
      && !expectedMembers.some(expected => {
        try {
          unify(member, expected);
          return true;
        } catch {
          return false;
        }
      }));
    if (!stray) return;
    // Only where the symmetric unifier would accept the pair; otherwise the
    // annotation check reports the mismatch already.
    try {
      unify(resolvedReturn, resolvedExpected);
    } catch {
      return;
    }
    const anchor = engine.annotationMethodNode ?? reportNode;
    const name = bindingNameFromNode(anchor);
    const ann = name ? engine.lookupAnnotation(name, anchor.start ?? 0) : undefined;
    const expectedFull = ann?.scheme ? instantiate(ann.scheme) : resolvedExpected;
    const inferredFull = expectedFull.tag === 'TFun' ? tFun(expectedFull.param, resolvedReturn) : resolvedReturn;
    if (containsErrorType(inferredFull) || containsErrorType(expectedFull)) return;
    engine.addDiag(annotationMismatchMessage(name, inferredFull, expectedFull), narrowToIdentifier(anchor));
    return;
  }
  if (
    isUnion(resolvedReturn) &&
    !isUnion(resolvedExpected) &&
    resolvedExpected.tag !== 'TVar'
  ) {
    // Flatten nested unions so (Boolean | (Number | Boolean)) becomes [Boolean, Number, Boolean]
    const flatMembers: Type[] = [];
    const collect = (t: Type) => {
      if (isUnion(t)) {
        for (const m of (t as import('../hm/types').TCon).args) collect(m);
      } else {
        flatMembers.push(t);
      }
    };
    collect(resolvedReturn);

    // Deduplicate for diagnostic message
    const seen = new Set<string>();
    const uniqueMembers: Type[] = [];
    for (const m of flatMembers) {
      const s = typeToString(m);
      if (!seen.has(s)) { seen.add(s); uniqueMembers.push(m); }
    }

    // When inside an annotated method, report on the method name
    // rather than on an inner expression deep in the body.
    const anchor = engine.annotationMethodNode ?? reportNode;

    for (const member of uniqueMembers) {
      try {
        unify(member, resolvedExpected);
      } catch (e) {
        if (e instanceof UnificationError) {
          // Build an inferred function type that matches the annotation's
          // shape so the unified mismatch message shows full types when
          // possible (falling back to bare return types otherwise).
          const name = bindingNameFromNode(anchor);
          const ann = name
            ? engine.lookupAnnotation(name, anchor.start ?? 0)
            : undefined;
          const expectedFull = ann?.scheme ? instantiate(ann.scheme) : resolvedExpected;
          const inferredReturn = uniqueMembers.length === 1
            ? uniqueMembers[0]
            : tUnion(uniqueMembers);
          const inferredFull = expectedFull.tag === 'TFun'
            ? tFun(expectedFull.param, inferredReturn)
            : inferredReturn;
          if (containsErrorType(inferredFull) || containsErrorType(expectedFull)) {
            break;
          }
          engine.addDiag(
            annotationMismatchMessage(name, inferredFull, expectedFull),
            narrowToIdentifier(anchor),
          );
          break;
        } else {
          throw e;
        }
      }
    }
  }
}

/** `obj.field == null` / `=== undefined` (a positive null check on a
 *  member of an identifier). */
function isMemberNullCheck(test: AstNode): boolean {
  const b = test as unknown as estree.BinaryExpression;
  if (!['==', '==='].includes(b.operator)) return false;
  const isNullish = (n: AstNode): boolean =>
    (n.type === 'Literal' && (n as unknown as estree.Literal).value === null)
    || (n.type === 'Identifier' && (n as unknown as estree.Identifier).name === 'undefined');
  const isMember = (n: AstNode): boolean => n.type === 'MemberExpression'
    && !(n as unknown as estree.MemberExpression).computed
    && (n as unknown as estree.MemberExpression).object.type === 'Identifier';
  return (isMember(b.left as AstNode) && isNullish(b.right as AstNode))
    || (isMember(b.right as AstNode) && isNullish(b.left as AstNode));
}

/** The value of an unconditional `name = value` at the top level of a
 *  branch (`x = make ();` or `{ …; x = make (); }`), or null. */
function assignedValueIn(branch: AstNode, name: string): AstNode | null {
  const statements: AstNode[] = branch.type === 'BlockStatement'
    ? ((branch as unknown as estree.BlockStatement).body as AstNode[])
    : [branch];
  for (const st of statements) {
    if (st.type !== 'ExpressionStatement') continue;
    const e = (st as unknown as estree.ExpressionStatement).expression as AstNode;
    if (e.type !== 'AssignmentExpression') continue;
    const a = e as unknown as estree.AssignmentExpression;
    if (a.operator === '=' && a.left.type === 'Identifier' && (a.left as estree.Identifier).name === name) {
      return a.right as AstNode;
    }
  }
  return null;
}

export function inferBlockReturnType(engine: InferenceEngine, block: estree.BlockStatement, env: TypeEnv, expectedReturnType?: Type): Type {
  let currentEnv = hoistFunctionDeclarations(engine, block.body as AstNode[], env);
  let returnType: Type | null = null;

  for (const stmt of block.body) {
    if (stmt.type === 'ReturnStatement') {
      if (stmt.argument) {
        returnType = inferExpressionWithExpected(engine, stmt.argument, currentEnv, expectedReturnType);
        // Record it, like a nested return (statements.ts): the return
        // collection below must not guess it from source offsets, where
        // `a === 3` ends with its operand `3` and would read as Number.
        engine.returnTypeOverrides.set(stmt as AstNode, returnType);
      }
      break;
    }

    // `if (!m.has (k)) m.set (k, …);` / `if (!m.has (k)) return …;`: after
    // it `m.get (k)` cannot miss (see `keyPresentAfter`).
    {
      const present = keyPresentAfter(stmt as AstNode);
      if (present) {
        const [newEnv] = engine.inferStatement(stmt, currentEnv);
        currentEnv = newEnv.extend(present, mono(tBool));
        continue;
      }
    }

    // Loop exit: after `while (test) { … }` the test is false, unless the
    // body can `break` out early — continue with the false-branch narrowing
    // (`while (isNext (acc)) { … } return acc.value;` reads a `Done`).
    if (stmt.type === 'WhileStatement' && !containsBreak(stmt.body as AstNode)) {
      const [newEnv] = engine.inferStatement(stmt, currentEnv);
      currentEnv = computeNarrowedEnvs(engine.subst, stmt.test as AstNode, newEnv, engine.annotationMap).altEnv;
      continue;
    }

    // Guard with an assignment: `if (x == null) x = make ();` (or `!x`) —
    // after it `x` holds either its old non-null value or the new one, so
    // it is not null when the assigned value cannot be.  Only an
    // unconditional `x = …` at the top level of the branch counts.
    if (stmt.type === 'IfStatement' && !stmt.alternate && !blockAlwaysReturns(stmt.consequent)) {
      // The guarded variable: `x == null`, `!x`, or one of those as a
      // disjunct of `A || x == null` (the branch runs whenever x is null).
      const guardedBy = (test: AstNode): string | null => {
        const nullCheck = extractNullCheck(test);
        if (nullCheck && nullCheck.isNullCheckPositive) return nullCheck.varName;
        if (isNegatedReference(test)) return ((test as unknown as estree.UnaryExpression).argument as estree.Identifier).name;
        if (test.type === 'LogicalExpression' && (test as unknown as estree.LogicalExpression).operator === '||') {
          const l = test as unknown as estree.LogicalExpression;
          return guardedBy(l.right as AstNode) ?? guardedBy(l.left as AstNode);
        }
        return null;
      };
      const guarded = guardedBy(stmt.test as AstNode);
      const assigned = guarded ? assignedValueIn(stmt.consequent as AstNode, guarded) : null;
      if (guarded && assigned) {
        const [newEnv] = engine.inferStatement(stmt, currentEnv);
        currentEnv = newEnv;
        const valueType = engine.getNodeType(assigned);
        const varScheme = currentEnv.lookup(guarded);
        if (valueType && varScheme) {
          const value = engine.subst.apply(valueType);
          if (structuralEquals(removeNullUndefined(value), value)) {
            currentEnv = currentEnv.extend(guarded, mono(removeNullUndefined(engine.subst.apply(varScheme.type))));
          }
        }
        continue;
      }
    }

    // Guard clause on a member: `if (input.localTime == null) return …;` —
    // after it the member is not null (the else-side narrowing of the test,
    // as in a ternary).
    if (stmt.type === 'IfStatement' && !stmt.alternate && blockAlwaysReturns(stmt.consequent)
        && stmt.test.type === 'BinaryExpression' && isMemberNullCheck(stmt.test as AstNode)) {
      const [newEnv] = engine.inferStatement(stmt, currentEnv);
      currentEnv = computeNarrowedEnvs(engine.subst, stmt.test as AstNode, newEnv, engine.annotationMap).altEnv;
      continue;
    }

    // Guard clause narrowing: if (x == null) return ...; → narrow x after
    if (stmt.type === 'IfStatement' && !stmt.alternate && blockAlwaysReturns(stmt.consequent)) {
      const narrowing = extractNullCheck(stmt.test);
      if (narrowing) {
        // The if body returns, so code after this point has the opposite narrowing
        const [newEnv] = engine.inferStatement(stmt, currentEnv);
        currentEnv = newEnv;
        const varScheme = currentEnv.lookup(narrowing.varName);
        if (varScheme) {
          const resolvedType = engine.subst.apply(varScheme.type);
          const narrowed = removeNullUndefined(resolvedType);
          if (narrowing.isNullCheckPositive) {
            // Guard was "if (x == null) return" → after guard, x is NOT null
            currentEnv = currentEnv.extend(narrowing.varName, mono(narrowed));
          }
          // For "if (x != null) return" → after guard, x IS null (uncommon, don't narrow)
        }
        continue;
      }

      // Guard clause with type predicate: if (isString(x)) return ...; → narrow x after
      const predicateNarrowing = extractTypePredicateNarrowing(engine.subst, stmt.test, currentEnv);
      if (predicateNarrowing) {
        const [newEnv] = engine.inferStatement(stmt, currentEnv);
        // The guard returned when the predicate was true, so after it the
        // predicate is false: the false-branch narrowing (union remainder,
        // or the other variant of a sumtype for a `::narrow <Variant>` guard).
        currentEnv = computeNarrowedEnvs(engine.subst, stmt.test as AstNode, newEnv, engine.annotationMap).altEnv;
        continue;
      }

      // Guard clause on falsiness: if (!x) return ...; → after it `x` is
      // truthy, so not Null/Undefined (`if (!evidence) return "–";`).
      // computeNarrowedEnvs already narrows the else-side of `!x`.
      if (isNegatedReference(stmt.test as AstNode)) {
        const [newEnv] = engine.inferStatement(stmt, currentEnv);
        currentEnv = computeNarrowedEnvs(engine.subst, stmt.test as AstNode, newEnv, engine.annotationMap).altEnv;
        continue;
      }

      // Guard clause with typeof: if (typeof x === "string") return ...; → narrow x after
      const typeofNarrowing = extractTypeofCheck(stmt.test);
      if (typeofNarrowing) {
        const [newEnv] = engine.inferStatement(stmt, currentEnv);
        currentEnv = newEnv;
        const varScheme = currentEnv.lookup(typeofNarrowing.varName);
        if (varScheme) {
          const resolvedType = engine.subst.apply(varScheme.type);
          if (typeofNarrowing.isPositive) {
            // Guard was "if (typeof x === 'string') return ..." → after guard, x is NOT string
            const remainder = filterUnion(resolvedType, (t: Type) => !typeofCategoryMatches(t, typeofNarrowing.narrowedType));
            if (!structuralEquals(remainder, resolvedType)) {
              currentEnv = currentEnv.extend(typeofNarrowing.varName, mono(remainder));
            }
          }
          // For "if (typeof x !== 'string') return" → after guard, x IS string
          else {
            currentEnv = currentEnv.extend(typeofNarrowing.varName, mono(typeofNarrowing.narrowedType));
          }
        }
        continue;
      }

      // Guard clause with ::narrow member expression or method call:
      // if (f.isLeft) return ...;  or  if (f.isLeft()) return ...;
      // → narrow f after the guard
      if ((stmt.test.type === 'MemberExpression'
            && stmt.test.object.type === 'Identifier'
            && stmt.test.property.type === 'Identifier')
          || (stmt.test.type === 'CallExpression'
            && stmt.test.callee?.type === 'MemberExpression'
            && stmt.test.callee.object?.type === 'Identifier'
            && stmt.test.callee.property?.type === 'Identifier')) {
        const { altEnv } = computeNarrowedEnvs(engine.subst, stmt.test, currentEnv, engine.annotationMap);
        if (altEnv !== currentEnv) {
          const [newEnv] = engine.inferStatement(stmt, currentEnv);
          currentEnv = newEnv;
          // Apply the altEnv bindings (the guard returned when predicate was true,
          // so after the guard the opposite variant applies)
          currentEnv = altEnv;
          continue;
        }
      }

      // Guard clause with a compound test: `if (A || B) return …;` — after
      // the guard both A and B are false (`computeNarrowedEnvs` step 3a), so
      // `if (names.length < 2 || link == null) return;` leaves `link` non-null.
      if (stmt.test.type === 'LogicalExpression' && stmt.test.operator === '||') {
        const [newEnv] = engine.inferStatement(stmt, currentEnv);
        currentEnv = computeNarrowedEnvs(engine.subst, stmt.test as AstNode, newEnv, engine.annotationMap).altEnv;
        continue;
      }
    }

    const [newEnv] = engine.inferStatement(stmt, currentEnv);
    currentEnv = newEnv;
  }

  // Collect ALL return types from nested branches and merge with the
  // top-level return type (if any).  This handles patterns like:
  //   if (cond) { return "a" }
  //   return 1
  // → the function return type should be String | Number.
  // Nested returns (inside `if` / loops / `switch`) are inferred WITHOUT the
  // expected return type — only the final top-level `return` gets it.  Merging
  // them into a union afterwards is unsound against an annotation: `[Number]`
  // and `[a]` merge to `[Number | a]`, whose element "matches" `a`.  Check each
  // nested return against the annotated return type as well, exactly like the
  // branches of a ternary (which unify): a rigid variable then reports the
  // mismatch, and a flexible one is pinned so the binding's final check sees it.
  if (expectedReturnType && engine.subst.apply(expectedReturnType).tag !== 'TVar') {
    for (const { node: retNode, type: rt } of collectNestedReturns(engine, block)) {
      // A narrower union (`loading ? <Spinner /> : null`) fits a wider
      // declared union result.
      const widened = unifyWidening(engine.subst.apply(rt), engine.subst.apply(expectedReturnType));
      if (widened) engine.subst.mergeFrom(widened);
      else engine.unifyWithDiagnostic(rt, expectedReturnType, retNode);
    }
  }
  const allReturnTypes = collectAllReturnTypes(engine, block);
  if (allReturnTypes.length > 0) {
    if (returnType === null) {
      returnType = allReturnTypes[0];
    }
    // Merge all return types: resolve and deduplicate
    const resolvedTypes: Type[] = [];
    const seen = new Set<string>();
    for (const rt of allReturnTypes) {
      const resolved = engine.subst.apply(rt);
      const key = typeToString(resolved);
      if (!seen.has(key)) {
        seen.add(key);
        resolvedTypes.push(resolved);
      }
    }
    // Only override returnType when there are multiple distinct types
    if (resolvedTypes.length > 1) {
      returnType = mergeReturnTypes(resolvedTypes);
    }
  }

  // Constructor function detection: if the block has `this.x = ...`
  // assignments and no (or only guard) return, the function implicitly
  // returns `this`.  Use the bound `this` type from the environment.
  if (returnType === null && blockHasThisAssignment(block)) {
    const thisScheme = env.lookup('this');
    if (thisScheme) {
      returnType = instantiate(thisScheme);
    }
  }

  if (returnType === null) {
    // A body that can only exit by throwing never produces a value, so its
    // return type is unconstrained (bottom) — a fresh var lets a throw-only
    // thunk like `() => { throw "boom"; }` satisfy any `() -> a` slot
    // (FP-library: `RTask.try (() => { throw "boom"; })`).
    returnType = blockAlwaysThrows(block) ? tVar() : tVoid;
  }

  // Check: if the resolved return type is a union but the expected return
  // type is a concrete (non-union, non-TVar) type, verify that ALL members
  // of the union match the expected type.  The normal unifier is too lenient
  // here — it allows Union(Number, Null) to match Number because Number is
  // a member.  But returning a Union where a concrete type is expected is a
  // real type error (the value could be any member of the union).
  if (expectedReturnType) {
    checkUnionVsExpected(engine, returnType, expectedReturnType, block);
  }

  return returnType;
}

/** True when the block's execution unavoidably ends in a `throw` (last
 * statement is a throw, or an if/else where both branches always throw). */
function blockAlwaysThrows(node: AstNode): boolean {
  if (node.type === 'ThrowStatement') return true;
  if (node.type === 'BlockStatement') {
    const body = node.body ?? [];
    const last = body[body.length - 1];
    return !!last && blockAlwaysThrows(last);
  }
  if (node.type === 'IfStatement') {
    return !!node.alternate && blockAlwaysThrows(node.consequent) && blockAlwaysThrows(node.alternate);
  }
  return false;
}

/**
 * Collect ALL return-statement types from nested branches.
 * Uses acorn-walk to traverse blocks, if/else, switch cases, and try/catch
 * without descending into nested function bodies.
 */
/** The type recorded for exactly `node` (same start AND end), preferred over
 *  a lookup by end offset alone, which is ambiguous: `(await x) === "PONG"` and its operand
 *  `"PONG"` end at the same position, and the operand's type would be taken
 *  for the whole expression. */
function recordedTypeOf(engine: InferenceEngine, node: AstNode): Type | undefined {
  const byEnd = engine.nodeTypesByEnd.get(node.end);
  if (byEnd && byEnd.start === node.start) return byEnd.type;
  const byStart = engine.nodeTypes.get(node.start);
  if (byStart && byStart.end === node.end) return byStart.type;
  // Not recorded under exactly this node: the end-offset entry is the best
  // remaining guess (returns inferred through the statement path are
  // recorded explicitly and never reach this point).
  return byEnd?.type;
}

/** Returns with an argument that are NOT direct statements of `block`
 *  (those are inferred against the expected type already), outside nested
 *  functions — with their recorded (or local-kind-lifted) types. */
function collectNestedReturns(engine: InferenceEngine, block: AstNode): { node: AstNode; type: Type }[] {
  const out: { node: AstNode; type: Type }[] = [];
  const direct = new Set<AstNode>(((block as estree.BlockStatement).body ?? []) as AstNode[]);
  walk.ancestor(block, {
    ReturnStatement(ret: any, _state: unknown, ancestors: estree.AnyNode[]) {
      if (direct.has(ret) || !ret.argument) return;
      for (let i = 1; i < ancestors.length - 1; i++) {
        const t = ancestors[i].type;
        if (t === 'FunctionDeclaration' || t === 'FunctionExpression' || t === 'ArrowFunctionExpression') return;
      }
      const t = engine.returnTypeOverrides.get(ret) ?? recordedTypeOf(engine, ret.argument);
      if (t) out.push({ node: ret.argument as AstNode, type: t });
    },
  });
  return out;
}

export function collectAllReturnTypes(engine: InferenceEngine, node: AstNode): Type[] {
  if (!node) return [];
  const types: Type[] = [];

  walk.ancestor(node, {
    ReturnStatement(ret: any, _state: unknown, ancestors: estree.AnyNode[]) {
      // Skip returns inside nested function bodies
      for (let i = 1; i < ancestors.length - 1; i++) {
        const t = ancestors[i].type;
        if (t === 'FunctionDeclaration' || t === 'FunctionExpression' || t === 'ArrowFunctionExpression') {
          return;
        }
      }

      if (ret.argument) {
        // A return under a local kind equality (`isArray` guard on `f a`)
        // contributes its re-expressed type (`f x`, not `[x]`).
        const t = engine.returnTypeOverrides.get(ret) ?? recordedTypeOf(engine, ret.argument);
        if (t) types.push(t);
      } else {
        // Bare return (no argument) — skip if inside a guard clause
        // (IfStatement without alternate).  These are early-exit control
        // flow and should not introduce () into the function return type.
        for (let i = ancestors.length - 2; i >= 1; i--) {
          const a = ancestors[i] as AstNode;
          if (a.type === 'IfStatement' && !a.alternate) {
            return;
          }
        }
        types.push(tVoid);
      }
    },
  });

  return types;
}

/** Conservative: any `break` in a loop body (outside nested functions) may
 *  leave the loop while its test is still true. */
function containsBreak(node: AstNode): boolean {
  let found = false;
  const visit = (n: unknown): void => {
    if (found || !n || typeof n !== 'object') return;
    const t = (n as { type?: string }).type;
    if (t === 'BreakStatement') { found = true; return; }
    if (t === 'FunctionExpression' || t === 'ArrowFunctionExpression' || t === 'FunctionDeclaration') return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === 'loc' || k === 'range') continue;
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object') visit(v);
    }
  };
  visit(node);
  return found;
}
