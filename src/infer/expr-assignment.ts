// ============================================================================
// Assignment-expression inference and module.exports tracking
// (extracted from expressions.ts)
//
// Plain language: handles `x = value`, `obj.field = value` and the CommonJS
// export forms (`module.exports = …`, `exports.name = …`).  The job is to
// check the assigned value against what the target is allowed to hold, and
// to keep the record of "what does this file export" up to date.
// ============================================================================

import type * as estree from '../estree';
import {
  Type,
  Scheme,
  tVar,
  tFun,
  tUnion,
  prettyTypeToString,
  getReturnType,
  AstNode,
  isAppliedFunction,
} from '../hm/types';
import { TypeEnv, instantiate} from '../hm/env';
import { extractPrototypeMethod, isLocalAnnotation, TypeAnnotation } from '../commentParser';
import { usesLenientArrowCheck } from './annotation-rigid';
import { lookupMethod, registerMethod} from '../registries/methodRegistry';
import { isDataType} from '../registries/dataTypeRegistry';
import { mapType, someType } from '../hm/typeUtils';
import {
  hasUnknownTConDiagForScheme,
  registerAnnotationMethod,
} from './annotations';
import { tryInferPrototypeMethodAssignment } from './expr-prototype';

import type { InferenceEngine } from './index';
import { inferExpression, inferExpressionWithExpected } from './expressions';

/**
 * Detect a sumtype-factory member assignment such as
 * `Param.Path = (...) => Object.create(proto)`.
 *
 * When the annotation's return type is a registered sumtype TCon and the
 * inferred body produces a record / sumtype TCon / TVar, the annotation is
 * the source of truth and rigid + unification mismatch checks must be
 * skipped — exactly mirroring `shouldSuppressSumTypeCheck` in `statements.ts`.
 */
/**
 * `this.<field> = <array/object literal>` inside a constructor whose field is
 * annotated (`T#field :: T a b ~> [a, b]`): the annotated field type is the
 * expected type of the literal, so an array literal becomes a tuple (as it
 * does for an annotated `const` or `return`) instead of `[a | b]`.
 */
function annotatedThisFieldType(engine: InferenceEngine, node: any, env: TypeEnv): Type | undefined {
  const left = node.left;
  if (left?.type !== 'MemberExpression' || left.computed) return undefined;
  if (left.object?.type !== 'ThisExpression' || left.property?.type !== 'Identifier') return undefined;
  if (node.right?.type !== 'ArrayExpression' && node.right?.type !== 'ObjectExpression') return undefined;
  const thisScheme = env.lookup('this');
  if (!thisScheme) return undefined;
  const thisResolved = engine.subst.apply(instantiate(thisScheme));
  if (thisResolved.tag !== 'TCon') return undefined;
  const entry = lookupMethod(thisResolved.name, left.property.name);
  return entry ? entry.factory(thisResolved.args) : undefined;
}

function isSumTypeFactoryAssignment(scheme: Scheme, rightType: Type): boolean {
  const annReturn = getReturnType(scheme.type);
  if (annReturn.tag !== 'TCon' || !isDataType(annReturn.name)) return false;
  const inferredReturn = getReturnType(rightType);
  return inferredReturn.tag === 'TVar'
    || inferredReturn.tag === 'TRecord'
    || (inferredReturn.tag === 'TCon' && isDataType(inferredReturn.name));
}

/**
 * If `t` is a Union containing `Undefined`, return the Union with
 * `Undefined` removed (collapsing to a single member when only one
 * remains).  Returns the input unchanged otherwise.
 *
 * Used by object-spread merging: a field typed `T | Undefined` from a
 * heterogeneous array element merge means "this key may be absent".
 * When such a value is spread *over* a record that already has the key,
 * the absent case leaves the prior value untouched, so the result type
 * is `T` (not `T | Undefined`).
 */
export function stripUndefinedFromUnion(t: Type): Type {
  if (t.tag !== 'TCon' || t.name !== 'Union') return t;
  const kept = t.args.filter(a => !(a.tag === 'TCon' && a.name === 'Undefined'));
  if (kept.length === t.args.length) return t;
  if (kept.length === 1) return kept[0];
  if (kept.length === 0) return t;
  return tUnion(kept);
}

/** Build an expected function type that keeps the first `arity` parameter
 *  types of `annotated` but replaces the final result with a fresh variable.
 *  Used to bind an annotated arrow's parameters during body inference without
 *  performing the return-type unification inside the body (that check stays at
 *  the assignment node). */
function paramsOnlyExpected(annotated: Type, arity: number): Type {
  if (arity <= 0) return tVar();
  if (annotated.tag !== 'TFun') return annotated;
  return tFun(annotated.param, paramsOnlyExpected(annotated.result, arity - 1));
}

export function inferAssignmentExpression(engine: InferenceEngine, node: estree.AssignmentExpression, env: TypeEnv): Type {
  // --- Prototype method: X.prototype.method = function() {...} ---
  const protoResult = tryInferPrototypeMethodAssignment(engine, node, env);
  if (protoResult) return protoResult;

  // Unannotated `X.prototype.method = ...`: the user has NOT supplied a
  // signature, so we deliberately do NOT couple the method to the type
  // (no implicit prototype registration) — but we also must NOT emit
  // "Property 'prototype' does not exist on type X".  Infer the RHS so its
  // body is still checked on its own, then return without touching the LHS
  // member chain (which is what produced the spurious prototype diagnostic).
  if (node.left?.type === 'MemberExpression' && !node.left.computed
      && extractPrototypeMethod(node.left)) {
    return inferExpression(engine, node.right, env);
  }

  // Pre-check for annotated member assignments (e.g. `Box.fromPair ::
  // Pair a b -> Box b`, `EitherT.of :: Monad m => ...`) so we can guide body
  // inference with the expected type.  Pushing the annotated type binds an
  // annotated arrow's PARAMETERS to their declared types, so field accesses in
  // the body resolve from the annotation (`pair :: Pair a b` ⇒ `pair.fst :: a`)
  // instead of relying on structural coercion — a mismatched return is still
  // caught by the rigid check further below.  It also enables constraint-based
  // method lookup on parameters like `M` in `M.of(...)`.
  let constrainedAnnotation: { annotatedType: Type } | undefined;
  if (node.left.type === 'MemberExpression' && !node.left.computed) {
    const obj = node.left.object;
    const prop = node.left.property;
    if (obj?.type === 'Identifier' && prop?.type === 'Identifier') {
      const dottedName = `${obj.name}.${prop.name}`;
      const ann = engine.annotationMap.get(dottedName);
      // Only honour file-local annotations: a sidecar / globals /
      // `::types` `Foo.bar :: (Constraint c) => ...` entry must not
      // silently inject constraints into an unrelated user assignment
      // with the same dotted name.
      //
      // Method-form annotations (`Receiver ~> MethodType`) are intentionally
      // excluded: passing an expected type here would bypass the inline
      // method-`this` binding in `inferFunctionExpression` (which only fires
      // when no expected type is set).  Those go through `coordinateInstantiate`
      // instead, which registers the same constraints AND binds `this` from
      // the receiver.  Without this exclusion a constrained method like
      // `Alt f => Function [a] (f a) ~> ...` would leave `this` an unbound var.
      if (isLocalAnnotation(ann) && ann!.scheme && !ann!.receiver) {
        const hasConstraints = !!(ann!.scheme.constraints && ann!.scheme.constraints.length > 0);
        const rhsIsFn = node.right?.type === 'ArrowFunctionExpression'
          || node.right?.type === 'FunctionExpression';
        if (hasConstraints) {
          // Constrained: push the full annotated type (unchanged behaviour) so
          // constraint-based method lookup on parameters works.
          const annotatedType = engine.instantiateWithConstraints(ann!.scheme, node, ann!);
          constrainedAnnotation = { annotatedType };
        } else if (rhsIsFn) {
          // Unconstrained function: bind the arrow's PARAMETERS to their
          // declared types but leave the RESULT free.  This resolves field
          // accesses in the body from the annotation (`pair :: Pair a b` ⇒
          // `pair.fst :: a`) without performing the return-type unification
          // inside the body — that check stays at the controlled rigid/unify
          // site on the assignment node, which preserves its diagnostic
          // location AND the unknown-type-constructor suppression.
          const full = engine.instantiateWithConstraints(ann!.scheme, node, ann!);
          const arity = (node.right as estree.Function).params?.length ?? 0;
          constrainedAnnotation = { annotatedType: paramsOnlyExpected(full, arity) };
        }
      }
    }
  }

  // Method-form annotation on a property assignment whose RHS is a function
  // expression (e.g. `builtIn.Array = function (other) { ... }` with
  // `// builtIn.Array :: Array a ~> Array a -> Boolean`).  The dotted-name
  // annotation lookup above stores the annotation only by dotted name, but
  // `inferFunctionExpression` binds `this` from the receiver only when the
  // annotation is reachable by node offset.  Stash it under the RHS offset
  // so the existing inline-method-this binding path fires, giving every
  // `this` in the body a consistent receiver type.
  if (node.left.type === 'MemberExpression' && !node.left.computed) {
    const obj = node.left.object;
    const prop = node.left.property;
    if (obj?.type === 'Identifier' && prop?.type === 'Identifier'
        && (node.right?.type === 'FunctionExpression' || node.right?.type === 'ArrowFunctionExpression')) {
      const dottedName = `${obj.name}.${prop.name}`;
      const ann = engine.annotationMap.get(dottedName);
      if (ann?.receiver && ann?.methodType && ann?.scheme && isLocalAnnotation(ann)
          && !engine.annotationByOffset.has(node.right.start)) {
        engine.annotationByOffset.set(node.right.start, ann);
      }
    }
  }

  // A plain polymorphic static (`// _Task.loop :: a -> [a]` above
  // `_Task.loop = Task.loop = function (…) {…}`) checks its body against
  // rigid skolems, like a `const` arrow or a `function` declaration, so
  // nested annotations share its type variables (lexical scoping).  The
  // assignment below still validates the result.
  const staticFn = staticAnnotatedFunction(engine, node);
  const prevCheckedByBinding = engine.annotationCheckedByBinding;
  if (staticFn) {
    engine.annotationByOffset.set(staticFn.fn.start, staticFn.ann);
    engine.annotationCheckedByBinding = staticFn.fn;
  }
  let rightType: Type;
  try {
  if (constrainedAnnotation) {
    engine.suppressInfiniteType = true;
    try {
      rightType = inferExpressionWithExpected(engine, node.right, env, constrainedAnnotation.annotatedType);
    } finally {
      engine.suppressInfiniteType = false;
    }
  } else {
    const fieldType = annotatedThisFieldType(engine, node, env);
    rightType = fieldType
      ? inferExpressionWithExpected(engine, node.right, env, fieldType)
      : inferExpression(engine, node.right, env);
  }
  } finally {
    if (staticFn) {
      engine.annotationByOffset.delete(staticFn.fn.start);
      engine.annotationCheckedByBinding = prevCheckedByBinding;
    }
  }

  if (node.left.type === 'MemberExpression' && !node.left.computed) {
    // Handle annotated member assignments: Box.fromPair = pair => ...
    const obj = node.left.object;
    const prop = node.left.property;
    if (obj?.type === 'Identifier' && prop?.type === 'Identifier') {
      const dottedName = `${obj.name}.${prop.name}`;
      // Track JS-body parameter defaults for member assignments — used by
      // call-site arity checks so `Param.Path("k", [1,2])` is accepted
      // when the implementation declares `(k, r, d = undefined)`.
      if (node.right?.type === 'ArrowFunctionExpression' || node.right?.type === 'FunctionExpression') {
        const rfn = node.right as estree.Function;
        const slots: number[] = [];
        for (let i = 0; i < (rfn.params?.length ?? 0); i++) {
          if ((rfn.params[i] as AstNode)?.type === 'AssignmentPattern') slots.push(i);
        }
        if (slots.length > 0) engine.optionalParamSlotsByDottedName.set(dottedName, slots);
      }
      const annotation = engine.annotationMap.get(dottedName);
      // Honour only file-local annotations: a sidecar / globals /
      // `::types` `Foo.bar :: T` entry must not silently define the
      // type of an unrelated user assignment that happens to share the
      // dotted name.  The else branch below (no-annotation) handles
      // both "no entry" and "non-local entry" the same way.
      if (annotation?.scheme && isLocalAnnotation(annotation)) {
        // Chained static assignment: `_Task.ask = Task.ask = fn` annotates
        // only the OUTER dotted name.  The inner unannotated target was
        // already registered (below, on a previous visit of the inner
        // AssignmentExpression) with the inferred implementation type, so
        // call sites resolving the static through the inner constructor
        // name — which is how a module's default export resolves statics —
        // would miss annotation-only information such as overload unions.
        // Propagate the annotation to every chained inner dotted target.
        let chained: AstNode | undefined = node.right as AstNode | undefined;
        while (chained?.type === 'AssignmentExpression') {
          const innerLeft = (chained as estree.AssignmentExpression).left;
          if (innerLeft?.type === 'MemberExpression' && !innerLeft.computed
              && innerLeft.object?.type === 'Identifier'
              && innerLeft.property?.type === 'Identifier') {
            const innerDotted = `${innerLeft.object.name}.${innerLeft.property.name}`;
            if (innerDotted !== dottedName
                && !engine.annotationMap.get(innerDotted)?.scheme) {
              registerAnnotationMethod(innerDotted, annotation);
            }
          }
          chained = (chained as estree.AssignmentExpression).right as AstNode;
        }
        // Extend the LHS record with the new field so subsequent reads
        // (e.g. `Param.Query("...")` after `Param.Query = ...`) resolve
        // through the normal record-field path instead of emitting
        // "Property 'X' does not exist on type ...".  We store the
        // *annotated* type (instantiated) rather than the inferred RHS
        // type so that downstream reads see e.g. `(String, [a], b) -> Param`
        // instead of the structural record produced by the body.
        // The annotation is the source of truth.
        {
          const sch = env.lookup(obj.name);
          if (sch && sch.type.tag === 'TRecord' && !(prop.name in sch.type.fields)) {
            const annotatedFieldType = engine.instantiateWithConstraints(
              annotation.scheme, node, annotation);
            sch.type.fields[prop.name] = annotatedFieldType;
            // Also stash the SCHEME on the record so reads through ANY
            // alias of this record (not just the original `obj.name`)
            // re-instantiate freshly per use site.  Without this,
            // `const Aliased = Param; Aliased.Query(...)` would fall
            // through to `fields[prop.name]` (the already-instantiated
            // type) and bypass call-site argument unification + constraint
            // validation.
            if (!sch.type.fieldSchemes) sch.type.fieldSchemes = {};
            // Enrich the stored scheme with optionalParamSlots when the
            // RHS is a function expression with JS body defaults
            // (`(x = …)`), so call sites can treat trailing missing args
            // as optional via member-access too.
            let storedScheme = annotation.scheme;
            if (node.right?.type === 'ArrowFunctionExpression' || node.right?.type === 'FunctionExpression') {
              const rfn = node.right as estree.Function;
              const slots: number[] = [];
              for (let i = 0; i < (rfn.params?.length ?? 0); i++) {
                if ((rfn.params[i] as AstNode)?.type === 'AssignmentPattern') slots.push(i);
              }
              if (slots.length > 0) storedScheme = { ...storedScheme, optionalParamSlots: slots };
            }
            sch.type.fieldSchemes[prop.name] = storedScheme;
            // For method-form annotations (`Receiver ~> MethodType`), the
            // stored field type is only the MethodType — pretty-printing
            // the host record would lose the `Receiver ~>` prefix.
            // Stash the original raw signature so hover renders the full
            // `Array a ~> (a -> Array b) -> Array b` form for the field.
            if (annotation.receiver && annotation.raw) {
              if (!sch.type.fieldDisplays) sch.type.fieldDisplays = {};
              sch.type.fieldDisplays[prop.name] = annotation.raw;
            }
            // Fase B3: a `::hidden` / `::private` member annotation must also
            // hide the corresponding field on the host record, so hover and
            // completion over the host (e.g. `builtIn`) do not surface it.
            if (annotation.hidden || annotation.private) {
              if (!sch.type.hiddenFields) sch.type.hiddenFields = new Set<string>();
              sch.type.hiddenFields.add(prop.name);
            }
          }
        }
        // Skip mismatch checks when annotation has unknown type constructors —
        // the "unknown type constructor" diagnostic is the root cause.
        if (hasUnknownTConDiagForScheme(engine.diagnostics, annotation.scheme)) {
          // Don't checkRigid or unify — the unknown type makes it meaningless.
        } else if (isSumTypeFactoryAssignment(annotation.scheme, rightType)) {
          // Sumtype factory assigned to a member (e.g. `Param.Path = (...) => Object.create(proto)`).
          // The annotation is the source of truth; the body returns a record that
          // structurally represents the sumtype value. Skip rigid/unify mismatch.
        } else {
        const hasConstraints = !!(annotation.scheme.constraints && annotation.scheme.constraints.length > 0);
        const diagsBefore = engine.diagnostics.length;
        if (!hasConstraints) {
          // Non-constrained: normal flow
          engine.checkRigid(rightType, annotation.scheme, node);
          if (engine.diagnostics.length === diagsBefore) {
            const annotatedType = engine.instantiateWithConstraints(annotation.scheme, node, annotation);
            engine.unifyWithDiagnostic(rightType, annotatedType, node);
          }
        } else {
          // Constrained: already instantiated and inferred with expected type;
          // just unify and suppress infinite type during the unification too.
          engine.checkRigid(rightType, annotation.scheme, node);
          if (engine.diagnostics.length === diagsBefore) {
            engine.suppressInfiniteType = true;
            try {
              // `constrainedAnnotation` is only populated for constrained
              // annotations WITHOUT a receiver (method-form `Receiver ~> …`
              // annotations are handled by the inline-`this` binding path and
              // intentionally leave it unset — see the guard above).  Fall
              // back to a fresh instantiation so a constrained *method* such as
              // `Alt f => Function [a] (f a) ~> …` still unifies its body
              // against the annotated type instead of dereferencing undefined.
              const annotatedType = constrainedAnnotation
                ? constrainedAnnotation.annotatedType
                : engine.instantiateWithConstraints(annotation.scheme, node, annotation);
              engine.unifyWithDiagnostic(rightType, annotatedType, node);
            } finally {
              engine.suppressInfiniteType = false;
            }
          }

          // Register constraint info for body parameter TVars so that
          // constraint-based method lookup works on parameters (e.g. M.of()
          // inside `EitherT.of = function(M, value) { ... }`).
          if (annotation.scheme.constraints) {
            engine.registerStaticMethodConstraints(annotation.scheme, rightType);
          }
        }
        }
      } else if (
        (!annotation || !isLocalAnnotation(annotation))
        && obj.name !== 'module' && obj.name !== 'exports'
        && (
          node.right.type === 'FunctionExpression' || node.right.type === 'ArrowFunctionExpression'
          || (() => {
            // Unannotated `Obj.prop = <identifier/expr>` whose RHS resolves to
            // a function type (e.g. `Response.Redirect = _Redirect;` where
            // `_Redirect :: Number -> String -> Response a`).  Treat it as a
            // static factory so hover + cross-file export mirror the
            // function-expression case below.
            const rt = engine.subst.apply(rightType);
            return rt.tag === 'TFun' || isAppliedFunction(rt);
          })()
        )
      ) {
        // Unannotated static method assignment: X.y = function(...) { ... }
        // Register as a static method and record method signature for hover.
        const resolvedType = engine.subst.apply(rightType);
        registerMethod(obj.name, prop.name, {
          signature: `${dottedName} :: ${prettyTypeToString(resolvedType)}`,
          factory: (_typeArgs: Type[]) => resolvedType,
          isStatic: true,
        });
        engine.recordNodeType(prop, resolvedType);
        engine.methodSignatures.set(
          prop.start,
          `${dottedName} :: ${prettyTypeToString(resolvedType)}`,
        );
        // Record for the cross-file export map so a default export's static
        // factories are re-exported even without an explicit annotation.
        let members = engine.staticMemberTypes.get(obj.name);
        if (!members) {
          members = new Map<string, Type>();
          engine.staticMemberTypes.set(obj.name, members);
        }
        if (!members.has(prop.name)) members.set(prop.name, resolvedType);
      }

      // Track CommonJS exports
      if (obj.name === 'module' && prop.name === 'exports') {
        // module.exports = { Box, Pair } or module.exports = expr
        engine.usesCjsExports = true;
        trackModuleExports(engine, node.right, env, rightType);
      } else if (obj.name === 'exports') {
        engine.usesCjsExports = true;
        // exports.Box = Box
        engine.exportedNames.add(prop.name);
        // Capture the RHS type so re-exports like `exports.Limit = Limit_1.default;`
        // (where `Limit` is not bound in env) still surface a typed export.
        engine.cjsExportTypes.set(prop.name, rightType);
      }
    }

    // Handle `module.exports.X = expr` (LHS object is itself a MemberExpression)
    if (
      obj?.type === 'MemberExpression'
      && !obj.computed
      && obj.object?.type === 'Identifier' && obj.object.name === 'module'
      && obj.property?.type === 'Identifier' && obj.property.name === 'exports'
      && prop?.type === 'Identifier'
    ) {
      engine.usesCjsExports = true;
      engine.exportedNames.add(prop.name);
      engine.cjsExportTypes.set(prop.name, rightType);
    }

    // Handle this.<prop> = ... inside constructors: record method signature
    // so hover on the property shows Type#prop :: Type ~> PropType.
    if (obj?.type === 'ThisExpression' && prop?.type === 'Identifier') {
      const thisScheme = env.lookup('this');
      if (thisScheme) {
        const thisResolved = engine.subst.apply(instantiate(thisScheme));
        if (thisResolved.tag === 'TCon') {
          // Track this property as assigned in the constructor
          engine.constructorProperties.add(`${thisResolved.name}#${prop.name}`);
          const entry = lookupMethod(thisResolved.name, prop.name);
          if (entry) {
            const propType = entry.factory(thisResolved.args);
            engine.recordNodeType(prop, propType);
            engine.methodSignatures.set(
              prop.start,
              `${thisResolved.name}#${prop.name} :: ${prettyTypeToString(thisResolved)} ~> ${prettyTypeToString(propType)}`,
            );
          }
        }
      }
    }
    // Generic member assignment unification (e.g. `record.field = value`,
    // `this.#priv = value`).  The annotated static-method path above already
    // handles `Type.method = ...` assignments via `unifyWithDiagnostic`
    // against the annotation, and `this.<prop> = ...` constructor-style
    // assignments are typically against fresh TVars (so unification is a
    // no-op there).  For everything else we infer the LHS and unify it with
    // the RHS so concrete field types are enforced.  Logical assignment
    // operators (`||=`, `&&=`, `??=`) require RHS to be assignable to LHS
    // *unless* the LHS resolves to `Null`, in which case the operator is
    // being used as a nullish-coalescing initialiser and the RHS may legally
    // have an unrelated type (e.g. `let label = null; label ??= "fallback"`).
    const op = (node as estree.AssignmentExpression).operator;
    const handledAsAnnotatedStatic =
      obj?.type === 'Identifier' && prop?.type === 'Identifier'
      && (() => {
        const a = engine.annotationMap.get(`${obj.name}.${prop.name}`);
        return !!a?.scheme && isLocalAnnotation(a);
      })();
    // CommonJS sentinel writes are tracked separately and don't represent
    // a typed slot to unify against.
    const isCommonJsExport =
      (obj?.type === 'Identifier' && prop?.type === 'Identifier'
        && (obj.name === 'module' || obj.name === 'exports'))
      || (obj?.type === 'MemberExpression' && !obj.computed
        && obj.object?.type === 'Identifier' && obj.object.name === 'module'
        && obj.property?.type === 'Identifier' && obj.property.name === 'exports');
    if (!handledAsAnnotatedStatic && !isCommonJsExport) {
      // Allow extending records via property assignment without diagnostics:
      // when the LHS is a non-computed member expression on a record value
      // and the property doesn't exist yet, silently add it instead of
      // emitting "Property 'x' does not exist on type ...".  This makes
      // common JS patterns (`const Param = {}; Param.Path = ...;` or
      // `const x = Object.create(proto); x.key = key;`) work cleanly and
      // surfaces the new field on subsequent intellisense lookups.
      if (
        prop?.type === 'Identifier'
        && obj?.type !== 'ThisExpression'
      ) {
        const propName = prop.name as string;
        const objType = inferExpression(engine, obj, env);
        const resolvedObj = engine.subst.apply(objType);
        if (resolvedObj.tag === 'TRecord' && !(propName in resolvedObj.fields)) {
          const envSch = obj.type === 'Identifier' ? env.lookup(obj.name) : undefined;
          const envRecord = envSch && envSch.type.tag === 'TRecord' ? envSch.type : undefined;
          // Break object-reference cycles before storing the field: in the
          // tagged-constructor pattern (`Ns.Make = (...) => Object.create(proto)`
          // with `proto.constructor` pointing back at `Ns`) the RHS type
          // contains the very record we are about to extend.  Storing it
          // verbatim would turn the type graph into a loop and every
          // recursive type walker (substitution, free-var collection,
          // printing) would recurse forever.  Replace back-references with a
          // fresh type variable so the stored field type stays finite.
          const isBackRef = (n: Type): boolean =>
            n === resolvedObj || (envRecord !== undefined && n === envRecord);
          const safeRight = someType(rightType, isBackRef)
            ? mapType(rightType, n => (isBackRef(n) ? tVar() : undefined))
            : rightType;
          // Mutate the resolved copy so this assignment node sees the field.
          resolvedObj.fields[propName] = safeRight;
          // Walk Identifier chains (Param, this.x.y is excluded) to mutate
          // the env-stored original record.  subst.apply rebuilds closed
          // records, so the env-bound TRecord is the durable one — adding
          // to its `fields` map makes the property visible on later reads.
          if (envRecord) {
            envRecord.fields[propName] = safeRight;
          }
          engine.recordNodeType(prop, safeRight);
          engine.recordNodeType(node.left, safeRight);
          return rightType;
        }
      }
      const leftType = inferExpression(engine, node.left, env);
      const isLogicalAssign = op === '||=' || op === '&&=' || op === '??=';
      const lhsResolved = engine.subst.apply(leftType);
      const lhsIsNull = lhsResolved.tag === 'TCon' && lhsResolved.name === 'Null';
      if (!isLogicalAssign || !lhsIsNull) {
        engine.unifyWithDiagnostic(leftType, rightType, node);
      }
    }
  } else if (node.left.type === 'Identifier') {
    const leftType = inferExpression(engine, node.left, env);
    // Logical assignments (`||=`, `&&=`, `??=`) require the RHS to be
    // assignable to the LHS slot, except when the LHS resolves to `Null` —
    // that's the nullish-coalescing initialiser pattern and the fallback
    // may legally have a different type (e.g. `let label = null; label ??= "x"`).
    const op = (node as estree.AssignmentExpression).operator;
    const isLogicalAssign = op === '||=' || op === '&&=' || op === '??=';
    const lhsResolved = engine.subst.apply(leftType);
    const lhsIsNull = lhsResolved.tag === 'TCon' && lhsResolved.name === 'Null';
    if (!isLogicalAssign || !lhsIsNull) {
      engine.unifyWithDiagnostic(leftType, rightType, node);
    }
  } else if (node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern') {
    // Destructuring assignment: ({ a, b } = obj) or ([a, b] = arr)
    engine.inferDestructuringPattern(node.left, rightType, env, 'let');
  }
  return rightType;
}

/** Track names from `module.exports = { ... }` or `module.exports = expr`. */
export function trackModuleExports(engine: InferenceEngine, node: AstNode, env: TypeEnv, rightType?: Type): void {
  if (node.type === 'ObjectExpression') {
    // module.exports = { Box, Pair, add }  or a re-export barrel
    // module.exports = { RTask: require ("./RTask"), of: _RTask.of }
    const recordType = rightType ? engine.subst.apply(rightType) : undefined;
    for (const prop of node.properties) {
      if (prop.type === 'Property') {
        const keyName =
          prop.key?.type === 'Identifier' ? prop.key.name :
          prop.key?.type === 'Literal' ? String(prop.key.value) : null;
        if (keyName) {
          engine.exportedNames.add(keyName);
          // Value is not the same-named identifier (`{ Box }` / `{ Box: Box }`):
          // the export's type is the property value's inferred type.
          const sameNamedIdent = prop.value?.type === 'Identifier' && prop.value.name === keyName;
          if (!sameNamedIdent && recordType?.tag === 'TRecord' && recordType.fields[keyName]) {
            engine.cjsExportTypes.set(keyName, recordType.fields[keyName]);
            engine.cjsValueExports.add(keyName);
          }
        }
      }
    }
    if (rightType) engine.cjsObjectExportType = rightType;
  } else if (node.type === 'Identifier') {
    // module.exports = Box — export as 'default'
    engine.defaultExportName = node.name;
    engine.exportedNames.add('default');
    // Also export with the identifier's name
    engine.exportedNames.add(node.name);
  }
}

/**
 * The innermost function of an annotated dotted static assignment
 * (`A.m = B.m = function …`) whose plain, unconstrained, polymorphic
 * annotation should check the body against rigid skolems.  Method-form
 * (`~>`), constrained, overloaded and variadic annotations keep their own
 * paths.
 */
function staticAnnotatedFunction(
  engine: InferenceEngine,
  node: estree.AssignmentExpression,
): { fn: AstNode; ann: TypeAnnotation } | undefined {
  if (node.left.type !== 'MemberExpression' || node.left.computed) return undefined;
  const obj = node.left.object;
  const prop = node.left.property;
  if (obj?.type !== 'Identifier' || prop?.type !== 'Identifier') return undefined;
  const ann = engine.annotationMap.get(`${obj.name}.${prop.name}`);
  if (!ann?.scheme || ann.receiver || !isLocalAnnotation(ann)) return undefined;
  if (ann.scheme.vars.length === 0) return undefined;
  if (ann.scheme.constraints && ann.scheme.constraints.length > 0) return undefined;
  if (usesLenientArrowCheck(ann.scheme)) return undefined;
  if (hasUnknownTConDiagForScheme(engine.diagnostics, ann.scheme)) return undefined;
  let fn: AstNode | undefined = node.right as AstNode | undefined;
  while (fn?.type === 'AssignmentExpression') fn = (fn as estree.AssignmentExpression).right as AstNode;
  if (!fn || (fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression')) return undefined;
  if (engine.annotationByOffset.has(fn.start)) return undefined;
  return { fn, ann };
}
