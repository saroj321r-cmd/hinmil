// ============================================================================
// Prototype method assignment: X.prototype.method = function () { ... }
//
// Plain language: older JavaScript adds methods to a class by assigning to
// its *prototype* object.  This file recognises that pattern, infers or
// validates the method's type, and registers it so `new X().method()` calls
// type-check like ordinary class methods.
// ============================================================================

import type * as estree from '../estree';
import {
  Type,
  AstNode,
  tVar,
  tCon,
  tFun,
  tVoid,
  mono,
  prettyTypeToString,
} from '../hm/types';
import { Substitution } from '../hm/substitution';
import { TypeEnv } from '../hm/env';
import { TypeAnnotation, extractPrototypeMethod, isLocalAnnotation } from '../commentParser';
import { getParentTypeName, isDataType, getDataType, isVariant } from '../registries/dataTypeRegistry';
import { getReturnType } from '../hm/types';
import type { InferenceEngine } from './index';
import { inferExpression, inferExpressionWithExpected } from './expressions';
import { methodNameMismatchMessage } from './annotations';
import { variantThisScheme } from './helpers';

/* eslint-disable @typescript-eslint/no-unused-vars */
void isDataType; // reserved for future use; kept in imports to mirror expressions.ts
/* eslint-enable @typescript-eslint/no-unused-vars */

function inferShorthandPrototypeMethod(
  engine: InferenceEngine,
  node: estree.AssignmentExpression,
  env: TypeEnv,
  proto: { typeName: string; methodName: string },
  ann: TypeAnnotation,
  hashName: string,
): Type {
  const displayHashName = ann.name ?? hashName;
  const left = node.left as estree.MemberExpression;

  // Determine the receiver type.  When the annotation belongs to a sumtype
  // parent (e.g. Either#map) and the concrete type is a variant (Right),
  // synthesize the parent type with fresh type variables so the hover shows
  // `Either e a ~> ...` and type variables connect to the annotation body.
  // When the type is not a sumtype but has a constructor annotation whose
  // return type is `TypeName a b ...`, extract the type variables from there
  // (e.g. `RTask :: ... -> RTask r e a` → receiver `RTask r e a`).
  let thisType: Type;
  const annTypeName = (ann.name ?? hashName).split('#')[0];
  const parentDataType = getDataType(annTypeName);
  if (parentDataType && parentDataType.decl.typeVars.length > 0) {
    const freshArgs = parentDataType.decl.typeVars.map(v => tVar(v));
    thisType = tCon(annTypeName, freshArgs);
  } else {
    const ctorAnn = engine.annotationMap.get(annTypeName);
    const ctorReturnType = ctorAnn?.scheme ? getReturnType(ctorAnn.scheme.type) : null;
    if (ctorReturnType && ctorReturnType.tag === 'TCon'
        && ctorReturnType.name === annTypeName && ctorReturnType.args.length > 0) {
      const freshArgs = ctorReturnType.args.map(a =>
        a.tag === 'TVar' ? tVar(a.name) : tVar(),
      );
      thisType = tCon(annTypeName, freshArgs);
    } else {
      thisType = tCon(proto.typeName, []);
    }
  }

  // Record node types for the LHS chain
  const protoObj = left.object as estree.MemberExpression; // X.prototype
  const protoBase = protoObj.object; // X (Identifier)
  const constructorType = inferExpression(engine, protoBase as AstNode, env);
  engine.recordNodeType(protoBase as AstNode, constructorType);
  engine.recordNodeType(protoObj.property as AstNode, thisType);

  // Infer RHS with `this` bound to the receiver type
  let methodEnv = env.extend('this', variantThisScheme(proto.typeName, thisType) ?? mono(thisType));
  methodEnv = methodEnv.extend('__signatureThis', mono(tVoid));
  if (isVariant(proto.typeName)) {
    methodEnv = methodEnv.extend('__sumtypeVariant', mono(tCon(proto.typeName, [])));
  }
  const rightType = inferExpression(engine, node.right, methodEnv);

  // For 0-param function expressions, tMultiFun([], result) collapses to
  // just the return type.  Re-wrap as () -> result so the method type
  // correctly reflects the function shape.
  const rhsIsFunction = node.right.type === 'FunctionExpression' || node.right.type === 'ArrowFunctionExpression';
  const rhsParams = rhsIsFunction ? (node.right as estree.Function).params.length : -1;
  const methodType = (rhsIsFunction && rhsParams === 0 && rightType.tag !== 'TFun')
    ? tFun(tVoid, rightType)
    : rightType;

  engine.recordNodeType(left.property as AstNode, methodType);
  engine.checkRigid(methodType, ann.scheme!, node);

  engine.methodSignatures.set(
    (left.property as AstNode).start,
    `${displayHashName} :: ${prettyTypeToString(thisType)} ~> ${ann.raw}`,
  );
  engine.annotationByOffset.set((left.property as AstNode).start, ann);

  return methodType;
}

/**
 * `X.prototype.method = function() { ... }` when a matching
 * `X#method` annotation exists.  Returns the inferred type
 * if the pattern matches, otherwise `null`.
 */
export function tryInferPrototypeMethodAssignment(engine: InferenceEngine, node: estree.AssignmentExpression, env: TypeEnv): Type | null {
  if (node.left?.type !== 'MemberExpression' || node.left.computed) return null;
  const proto = extractPrototypeMethod(node.left);
  if (!proto) return null;

  const hashName = `${proto.typeName}#${proto.methodName}`;
  let ann = engine.annotationMap.get(hashName);
  // Honour only file-local annotations: a sidecar / globals / `::types`
  // `Foo#method :: ...` entry must not silently define the receiver/method
  // type of an unrelated user's `Foo.prototype.method = ...` assignment.
  if (ann && !isLocalAnnotation(ann)) ann = undefined;

  // Fallback: if no direct X#method annotation, look up by offset on the RHS.
  // This handles parent type annotations like `// Either#map :: ...` above
  // `Left.prototype.map = ...` where the annotation name differs from the
  // concrete type name.
  if (!ann?.receiver || !ann?.methodType || !ann?.scheme) {
    const rhsStart = node.right?.start;
    if (rhsStart !== undefined) {
      const offsetAnn = engine.annotationByOffset.get(rhsStart);
      if (offsetAnn?.scheme) {
        if (offsetAnn.methodNameMismatch) {
          // The annotation above has a different method name — report on the function
          engine.addDiag(
            methodNameMismatchMessage(proto.methodName, offsetAnn.name ?? ''),
            node.left.property as AstNode,
            [{ message: `Annotation '${offsetAnn.name}' defined here`, start: offsetAnn.commentStart, end: offsetAnn.commentEnd }],
          );
        } else {
          // Validate the method name in the annotation matches
          const annName = offsetAnn.name;
          if (annName && annName.includes('#')) {
            const annMethodName = annName.split('#')[1];
            if (annMethodName === proto.methodName) {
              ann = offsetAnn;
            }
          }
        }
      }
    }
  }

  // sumtype-aware fallback: if the concrete type is a variant of a sumtype sum type,
  // look up the parent type's annotation directly (e.g. Either#map for Left.prototype.map).
  if (!ann?.scheme) {
    const parentName = getParentTypeName(proto.typeName);
    if (parentName) {
      const parentAnn = engine.annotationMap.get(`${parentName}#${proto.methodName}`);
      if (parentAnn?.scheme && !parentAnn.methodNameMismatch) {
        ann = parentAnn;
      }
    }
  }

  // Shorthand annotation path: `// Animal#speak :: String` (no ~> syntax).
  // The annotation has a scheme but no receiver/methodType.  Synthesize the
  // receiver from the type name and infer the RHS function with `this` bound.
  if (ann?.scheme && (!ann.receiver || !ann.methodType)) {
    return inferShorthandPrototypeMethod(engine, node, env, proto, ann, hashName);
  }

  if (!ann?.receiver || !ann?.methodType || !ann?.scheme) return null;

  // Determine the display name: use the annotation's own name (e.g. Either#map)
  // or fall back to the concrete hash name (e.g. Left#map).
  const displayHashName = ann.name ?? hashName;

  // Record node types for the LHS chain so hover works:
  //   X → constructor type,  prototype → receiver type,  .method → method type
  const protoObj = node.left.object as estree.MemberExpression; // X.prototype
  const protoBase = protoObj.object; // X (Identifier)
  const constructorType = inferExpression(engine, protoBase as AstNode, env);
  engine.recordNodeType(protoBase as AstNode, constructorType);

  const { thisType, expectedType } = engine.coordinateInstantiate(ann);
  engine.recordNodeType(protoObj.property as AstNode, thisType);

  let methodEnv = env.extend('this', variantThisScheme(proto.typeName, thisType) ?? mono(thisType));
  methodEnv = methodEnv.extend('__signatureThis', mono(tVoid));
  if (isVariant(proto.typeName)) {
    methodEnv = methodEnv.extend('__sumtypeVariant', mono(tCon(proto.typeName, [])));
  }

  // Make the parameter / `this` / return DISPLAY authoritative from the
  // signature, never the body.  Stash the method annotation at the RHS
  // function offset so `inferFunctionExpression` takes its skolemizing
  // method-`~>` path (param-only rigid skolems): the body is only *checked*
  // against the rigid signature, so a stub or disagreeing body can no longer
  // poison the shown parameter types (e.g. `f("x")` must not turn `a -> b`
  // into `String -> Number`).  That path is guarded by `!expectedType`, so we
  // must infer the RHS WITHOUT an expected type for it to activate.  We keep
  // the flexible path for constrained schemes (skolemizing them would defeat
  // constraint resolution) and for non-function RHS.
  let rightType: Type;
  const canSkolemizeBody =
    (node.right.type === 'FunctionExpression' || node.right.type === 'ArrowFunctionExpression')
    && !(ann.scheme.constraints && ann.scheme.constraints.length > 0);
  if (canSkolemizeBody) {
    if (!engine.annotationByOffset.has((node.right as AstNode).start)) {
      engine.annotationByOffset.set((node.right as AstNode).start, ann);
    }
    rightType = inferExpression(engine, node.right, methodEnv);
  } else {
    rightType = inferExpressionWithExpected(engine, node.right, methodEnv, expectedType);
  }

  const diagsBefore = engine.diagnostics.length;
  engine.checkRigid(rightType, ann.scheme, node);
  // Save and restore the substitution around unification so that
  // parameter types recorded during inference are not corrupted.
  // e.g. Nothing.prototype.map returns `this` (Maybe a) but the
  // annotation expects Maybe b — unification would bind a=b.
  const savedSubst = new Substitution(engine.subst.entries());
  if (engine.diagnostics.length === diagsBefore) {
    engine.unifyWithDiagnostic(rightType, expectedType, node);
  }
  engine.subst = savedSubst;
  engine.recordNodeType(node.left.property as AstNode, rightType);

  // Record method signature for hover on the method name (e.g. `map` in `Left.prototype.map`).
  // Use the user-supplied annotation (`ann.raw`) as the authoritative source so the
  // displayed signature is exactly what the user wrote, regardless of how the body
  // happened to be inferred.  When the inferred type disagrees, the `checkRigid`
  // pass above will already have emitted a diagnostic — hover should not lie.
  engine.methodSignatures.set(
    (node.left.property as AstNode).start,
    `${displayHashName} :: ${ann.raw}`,
  );

  // Store the annotation at the method property offset so hover can retrieve it
  engine.annotationByOffset.set((node.left.property as AstNode).start, ann);

  return rightType;
}
