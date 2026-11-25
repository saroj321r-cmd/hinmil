// ============================================================================
// Call-expression inference — extracted from InferenceEngine
//
// Plain language: this file answers "what does `f(a, b)` produce?" — the
// hardest question in the engine, because JavaScript call styles vary so
// much.  The general recipe: infer the type of `f`, infer each argument,
// unify the arguments against `f`'s parameters, and read off the result
// type.  Around that core live many specialised paths: curried calls
// (`f(a)(b)`), variadic functions, overloaded signatures (call-overloads.ts),
// method calls on containers, `new` constructor calls, and library-style
// record projections (call-rows.ts).
// ============================================================================

import type { InferenceEngine } from './index';
import {
  Type,
  tVar,
  tFun,
  tVoid,
  tMultiFun,
  tArray,
  tAny,
  tUndefined,
  tUnion,
  AstNode,
  isSpread,
  flattenCurriedType,
  typeToString,
  collectVarNames,
  prettyTypeToString,
  T_TUPLE,
  T_SPREAD_ARRAY,
  T_UNION,
  T_PICKED,
  isTuple,
  isWildcard,
  isAnyType,
  NUMERIC_SUBTYPES,
} from '../hm/types';
import { T_TYPEREP, parseKvName, getReturnType as getFnReturnType } from '../hm/types';
import type { Scheme } from '../hm/types';
import { lookupStaticMethod } from '../registries/methodRegistry';
import { TypeEnv, instantiate, skolemizeForall } from '../hm/env';
import { unify, UnificationError } from '../hm/unify';
import {
  hasSpreadInArrowChain,
  isSpreadTupleOrArray,
  freshenType,
  extractParamTVarIds,
  narrowCallResultByArgs,
  collectTVarIdsFromType,
  scrubSkolems,
  someType,
} from '../hm/typeUtils';
import {
  applyConditionalReturnNarrowing,
  typeAcceptsUndefined,
} from './narrowing';
import { freshVars} from './helpers';
import { narrowToIdentifier } from './annotations';
import { matchFanOutCallee, inferFanOutCall, inferSpreadArrayCall, inferVariadicItems, inferCurryWrapperCall, inferVariadicWrapperCall, inferCurriedFunctionCall, shouldProtectPolymorphicParamArg, tryContainerSpreadChainCall, captureSpreadChainPeel, adaptCallbackArity, trySpreadChainCalleePeel } from './functionPatterns';
import { getMethodNames} from '../registries/methodRegistry';
import { lookupConstraint, constraintSuperclassClosure } from '../registries/constraintRegistry';
import type * as estree from '../estree';
import { parseExpression } from '../parsing';
import { tryExpandKeySetFromArrayArg, tryExpandRowMap, maybeApplyRowOpening, applyPickedProjection, applyMergeReduction, applyAwaitedReduction, findPickedInResultSides, findShadowKeyForChildRow } from './call-rows';
import { tryInferOverloadedCall } from './call-overloads';

// ---------------------------------------------------------------------------
// Numeric literal refinement helpers
// ---------------------------------------------------------------------------

/** Extract a numeric literal value from an AST node, handling unary minus and NaN/Infinity. */
function getNumericLiteralValue(node: AstNode): number | null {
  if (node.type === 'Literal' && typeof (node as estree.Literal).value === 'number') {
    return (node as estree.Literal).value as number;
  }
  if (node.type === 'UnaryExpression') {
    const unary = node as estree.UnaryExpression;
    if (unary.operator === '-' &&
        unary.argument.type === 'Literal' &&
        typeof (unary.argument as estree.Literal).value === 'number') {
      return -((unary.argument as estree.Literal).value as number);
    }
    if (unary.operator === '-' && unary.argument.type === 'Identifier') {
      const name = (unary.argument as estree.Identifier).name;
      if (name === 'Infinity') return -Infinity;
    }
  }
  if (node.type === 'Identifier') {
    const name = (node as estree.Identifier).name;
    if (name === 'NaN') return NaN;
    if (name === 'Infinity') return Infinity;
  }
  return null;
}

/** Validate a numeric literal against a refined numeric type annotation.
 *  Returns an error message if the literal violates the refinement, or null. */
function checkNumericRefinement(typeName: string, value: number): string | null {
  const checks = NUMERIC_REFINEMENT_CHECKS[typeName];
  if (!checks) return null; // Float/Double/Number/etc. — any number is fine
  for (const [predicate, fail] of checks) {
    if (!predicate(value)) return `'${value}' ${fail}`;
  }
  return null;
}

type RefinementCheck = [predicate: (n: number) => boolean, failMessage: string];
const isInt: RefinementCheck = [Number.isInteger, 'is not an integer'];
const isFinite: RefinementCheck = [Number.isFinite, 'is not finite'];
const notNaN: RefinementCheck = [(n) => !Number.isNaN(n), 'is NaN'];
const positive: RefinementCheck = [(n) => n > 0, 'is not positive'];
const negative: RefinementCheck = [(n) => n < 0, 'is not negative'];
const nonNegative: RefinementCheck = [(n) => n >= 0, 'is negative'];
const nonZero: RefinementCheck = [(n) => n !== 0, 'must not be zero'];

const NUMERIC_REFINEMENT_CHECKS: Record<string, RefinementCheck[]> = {
  Integer:                 [isInt],
  NonNegativeInteger:      [isInt, nonNegative],
  NegativeInteger:         [isInt, negative],
  PositiveInteger:         [isInt, positive],
  NonZeroInteger:          [isInt, nonZero],
  PositiveNumber:          [positive],
  NegativeNumber:          [negative],
  ValidNumber:             [notNaN],
  NonZeroValidNumber:      [notNaN, nonZero],
  FiniteNumber:            [isFinite],
  NonZeroFiniteNumber:     [isFinite, nonZero],
  PositiveFiniteNumber:    [isFinite, positive],
  NegativeFiniteNumber:    [isFinite, negative],
};

/**
 * Whether a tuple parameter slot accepts an implicit `Undefined` argument.
 *
 * Used by {@link checkAndPadArity} to relax the strict tuple arity check
 * when the trailing parameters are typed as a constraint variable whose
 * structural body explicitly admits `Undefined` (e.g.
 * `::constraint Source s { s :: String | SQLTag a b | Undefined }`).
 *
 * Returns `true` when:
 *   - the slot resolves to `Undefined` directly, OR
 *   - the slot resolves to a `Union` containing `Undefined`, OR
 *   - the slot resolves to a `TVar` whose registered constraint(s) define
 *     a self-clause (`s :: …`) with a `Union` body containing `Undefined`.
 */
function tupleSlotAcceptsUndefined(engine: InferenceEngine, slot: Type): boolean {
  const resolved = engine.subst.apply(slot);
  if (typeAcceptsUndefined(engine.subst, resolved)) return true;
  if (resolved.tag !== 'TVar') return false;
  // Structural constraints (`::constraint Source s { s :: String | Undefined }`)
  // are tracked as pendingUnionConstraints — each entry lists the union
  // alternatives the use-site var must satisfy.  When ANY pending union
  // constraint on this var lists Undefined as an alternative, the slot is
  // optional.
  for (const pu of engine.pendingUnionConstraints) {
    if (pu.varId !== resolved.id) continue;
    if (pu.alternatives.some(a => {
      const r = engine.subst.apply(a);
      return r.tag === 'TCon' && r.name === 'Undefined';
    })) {
      return true;
    }
  }
  // Nominal constraints stored as kvConstraints (e.g. `Functor f`) — keep
  // a fallback lookup via the constraint registry's selfClauses for
  // forward-compatibility with future structural variants registered there.
  const cs = engine.kvConstraints.get(resolved.id);
  if (!cs || cs.length === 0) return false;
  for (const cname of cs) {
    const def = lookupConstraint(cname);
    if (!def?.selfClauses) continue;
    for (const clause of def.selfClauses) {
      if (clause.selfParam !== def.typeVar) continue;
      if (typeAcceptsUndefined(engine.subst, clause.body)) return true;
    }
  }
  return false;
}

/**
 * Resolve the optionalParamSlots metadata for a callee node.  Supports
 * plain identifier callees (env scheme lookup) and member-access callees
 * (`Param.Path(...)`) via the object's `fieldSchemes` row.
 */
function resolveCalleeOptionalSlots(
  engine: InferenceEngine,
  env: TypeEnv,
  callee: AstNode,
): number[] | undefined {
  if (callee.type === 'Identifier') {
    const sch = env.lookup((callee as estree.Identifier).name as string);
    return sch?.optionalParamSlots;
  }
  if (callee.type === 'MemberExpression' && !(callee as estree.MemberExpression).computed) {
    const me = callee as estree.MemberExpression;
    if (me.object?.type === 'Identifier' && me.property?.type === 'Identifier') {
      const dotted = `${(me.object as estree.Identifier).name}.${(me.property as estree.Identifier).name}`;
      const direct = engine.optionalParamSlotsByDottedName.get(dotted);
      if (direct) return direct;
      return memberCalleeScheme(engine, env, callee)?.optionalParamSlots;
    }
  }
  return undefined;
}

/** The stored scheme of `obj.f` when `obj` is a record that keeps one per
 *  field (`fieldSchemes`: a namespace import, `Param.Path = …`). */
function memberCalleeScheme(engine: InferenceEngine, env: TypeEnv, callee: AstNode): Scheme | undefined {
  if (callee.type !== 'MemberExpression') return undefined;
  const me = callee as estree.MemberExpression;
  if (me.computed || me.object?.type !== 'Identifier' || me.property?.type !== 'Identifier') return undefined;
  const objScheme = env.lookup((me.object as estree.Identifier).name as string);
  if (!objScheme) return undefined;
  const objType = engine.subst.apply(objScheme.type);
  if (objType.tag !== 'TRecord' || !objType.fieldSchemes) return undefined;
  const name = (me.property as estree.Identifier).name as string;
  return Object.prototype.hasOwnProperty.call(objType.fieldSchemes, name) ? objType.fieldSchemes[name] : undefined;
}

/**
 * For tuple-parameter functions, emit a clear arity diagnostic and pad
 * `numArgs` up to the expected count so unification still decomposes the
 * callee.  Returns `{ numArgs, arityMismatch }`.
 *
 * Constraint-aware relaxation: when fewer arguments than expected are
 * provided, but every missing trailing slot is "undefined-friendly" via
 * {@link tupleSlotAcceptsUndefined}, the diagnostic is suppressed and
 * `arityMismatch` is reported as `false` so the caller's normal
 * "pad with Undefined" path fills in the gaps.
 */
function checkAndPadArity(
  engine: InferenceEngine,
  resolvedCallee: Type,
  numArgs: number,
  calleeNode: AstNode,
  optionalParamSlots?: number[],
  hasSpreadArg = false,
): { numArgs: number; arityMismatch: boolean } {
  if (resolvedCallee.tag !== 'TFun' || resolvedCallee.param.tag !== 'TCon'
      || resolvedCallee.param.name !== T_TUPLE || numArgs === 0
      || numArgs === resolvedCallee.param.args.length
      || resolvedCallee.param.args.some(a => isSpread(a))) {
    return { numArgs, arityMismatch: false };
  }
  const expected = resolvedCallee.param.args.length;
  // A spread argument (`fn (a, ...rest)`) supplies an unknown number of
  // values at runtime, so it may fill every remaining parameter — e.g. the
  // surplus-argument pass-through in an FP library's `curry`.  Never report "too few
  // arguments" for such a call; pad so the missing slots stay unconstrained.
  if (hasSpreadArg && numArgs < expected) {
    return { numArgs: expected, arityMismatch: false };
  }
  // Constraint-aware optional trailing slots: if every missing trailing
  // parameter accepts Undefined (via its constraint body), accept the
  // shorter call without diagnostic and let the caller pad with Undefined.
  if (numArgs < expected) {
    const trailing = resolvedCallee.param.args.slice(numArgs);
    if (trailing.every(s => tupleSlotAcceptsUndefined(engine, s))) {
      return { numArgs: expected, arityMismatch: false };
    }
    // JS-body-default optional slots: if every missing trailing slot index
    // is registered as optional via the callee's binding (i.e. the
    // implementation declares `(…, x = …)`), accept the shorter call.
    if (optionalParamSlots && optionalParamSlots.length > 0) {
      const missingIndices: number[] = [];
      for (let i = numArgs; i < expected; i++) missingIndices.push(i);
      if (missingIndices.every(i => optionalParamSlots.includes(i))) {
        return { numArgs: expected, arityMismatch: false };
      }
    }
  }
  engine.addDiag(
    `Expected ${expected} argument${expected === 1 ? '' : 's'} but got ${numArgs}`,
    calleeNode,
  );
  return {
    numArgs: numArgs < expected ? expected : numArgs,
    arityMismatch: true,
  };
}



/**
 * After unification has resolved the callee type, detect attempts to call a
 * non-function value and emit a "not callable" diagnostic.  Two paths:
 *   1. Zero-arg call where unification trivially succeeded against a TVar.
 *   2. Failing unification: rewrite the "Cannot unify" message.
 */
function reportNonCallableCallee(
  engine: InferenceEngine,
  node: estree.CallExpression,
  env: TypeEnv,
  calleeType: Type,
  numArgs: number,
  diagsBefore: number,
  prettyBefore?: string,
): void {
  const resolved = engine.subst.apply(calleeType);
  // Both paths short-circuit when the resolved type is callable (TFun) or
  // still a free TVar (no information yet).
  if (isCallableType(resolved)) return;
  // Prefer the pre-unification pretty-string when supplied: after a failed
  // unification, free TVars in `resolved` may be poisoned to `$error`
  // (see poisonFreeVars), which would leak into the diagnostic.  Fallback
  // strips `$error` to `_` for the rare callers that don't pass a snapshot.
  const pretty = prettyBefore ?? prettyTypeToString(resolved).replace(/\$error/g, '_');

  // Case 1: zero-arg call where unification didn't error.
  if (numArgs === 0 && engine.diagnostics.length === diagsBefore &&
      (node as AstNode).type !== 'NewExpression') {
    if (node.callee.type !== 'MemberExpression' || isGetterPropertyCall(engine, env, node.callee)) {
      engine.addDiag(
        `Type '${pretty}' is not callable`,
        node.callee,
      );
    }
    return;
  }

  // Case 2: rewrite "Cannot unify" emitted by the callee unification.
  if (engine.diagnostics.length > diagsBefore) {
    const lastDiag = engine.diagnostics[engine.diagnostics.length - 1];
    if (lastDiag.message.startsWith('Cannot unify') || lastDiag.message.startsWith('Type mismatch: Cannot unify')) {
      lastDiag.message = `Type '${pretty}' is not callable`;
    }
  }
}

/** A type is callable if it can stand in for a function: TFun, the opaque
 * `Function` constructor (produced e.g. by `typeof x === "function"`
 * narrowing), an unresolved TVar, or a wildcard/`Any` (both match anything
 * by definition — e.g. a cancel handle from `fork :: (…) -> *`). */
function isCallableType(t: Type): boolean {
  if (t.tag === 'TFun' || t.tag === 'TVar') return true;
  if (t.tag === 'TCon' && t.name === 'Function' && (t.args.length === 0 || t.args.length === 2)) return true;
  if (isWildcard(t) || isAnyType(t)) return true;
  return false;
}

/**
 * Detect "calling" what is actually a getter — a member access annotated
 * with a non-function methodType, e.g. `Box#size :: Number`.  Treating these
 * as callable yields better diagnostics than silently returning the type.
 */
function isGetterPropertyCall(
  engine: InferenceEngine, env: TypeEnv, callee: estree.MemberExpression,
): boolean {
  if (callee.object?.type !== 'Identifier' || callee.property?.type !== 'Identifier') {
    return false;
  }
  const objScheme = env.lookup(callee.object.name as string);
  if (!objScheme) return false;
  const objType = engine.subst.apply(objScheme.type);
  if (objType.tag !== 'TCon') return false;
  const ann = engine.annotationMap.get(`${objType.name}#${(callee.property as estree.Identifier).name}`);
  return !!ann && ann.methodType?.tag !== 'TFun';
}

/**
 * Emit a warning when `new` usage doesn't match the callee's constructor
 * provenance:
 *  - `new` on an arrow-factory: the runtime returns a fresh `Object`, NOT
 *    a "Name" instance — almost certainly a mistake.
 *  - missing `new` on a `class` or `function-this` constructor: invoking
 *    such a function without `new` either throws (class) or pollutes the
 *    global object (function-this).
 *
 * Sum-type variants (`'sumtype-variant'`) are intentionally exempt: it
 * is idiomatic in this codebase to write `Just(5)` without `new`.
 */
function checkNewStrictness(engine: InferenceEngine, node: estree.CallExpression): void {
  if (node.callee.type !== 'Identifier') return;
  const name = (node.callee as estree.Identifier).name as string;
  const prov = engine.constructorProvenance.get(name);
  if (!prov || prov === 'sumtype-variant' || prov === 'sumtype') return;

  const isNew = (node as AstNode).type === 'NewExpression';
  if (isNew && prov === 'arrow-factory') {
    engine.addDiag(
      `Cannot use 'new' with arrow-function factory '${name}'; it returns Object, not a new instance`,
      node.callee,
    );
    return;
  }
  if (!isNew && (prov === 'class' || prov === 'function-this')) {
    engine.addDiag(
      `Constructor '${name}' must be called with 'new'`,
      node.callee,
    );
  }
}

/**
 * Look up the built-in constructor kind (`'Array'`, `'Function'`, …) for
 * the callee of a CallExpression.  Returns the kind when the callee is a
 * direct `.constructor` member access or an identifier that was bound to
 * such an access.
 */
function lookupBuiltinCtorKindForCallee(
  engine: InferenceEngine,
  callee: AstNode,
  env: TypeEnv,
): string | undefined {
  if (callee.type === 'MemberExpression'
      && !(callee as estree.MemberExpression).computed
      && ((callee as estree.MemberExpression).property as estree.Identifier)?.name === 'constructor') {
    const propStart = ((callee as estree.MemberExpression).property as AstNode).start;
    let k = engine.builtinCtorKind.get(propStart);
    if (k) return k;
    // Direct form like `[].constructor(...)` — callee hasn't been inferred
    // yet, so populate the map by inferring it on demand.
    try { engine.inferExpression(callee, env); } catch { /* ignore */ }
    k = engine.builtinCtorKind.get(propStart);
    return k;
  }
  if (callee.type === 'Identifier') {
    const n = (callee as estree.Identifier).name;
    const mapped = engine.builtinCtorByVarName.get(n);
    if (mapped) return mapped;
    // Bare global `Function` identifier used as `new Function(...)` /
    // `Function(...)` — enables Phase D smart-infer of the body string.
    if (n === 'Function') return n;
  }
  return undefined;
}

/**
 * Dedupe a list of types by their pretty-printed form (preserves order).
 */
function dedupTypes(types: Type[]): Type[] {
  const seen = new Set<string>();
  const out: Type[] = [];
  for (const t of types) {
    const k = prettyTypeToString(t);
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

/**
 * Specialise calls to built-in constructors (currently only `Array`).
 * Returns the specialised result type, or `null` if no specialisation
 * applies.  Phase D (smart-infer for `Function`) plugs in here too.
 */
function tryInferBuiltinCtorCall(
  engine: InferenceEngine,
  node: estree.CallExpression,
  env: TypeEnv,
): Type | null {
  const kind = lookupBuiltinCtorKindForCallee(engine, node.callee as AstNode, env);
  if (!kind) return null;

  if (kind === 'Array') {
    // Infer the callee for side effects / hover, then synthesise the
    // result as `[union of arg types]` (deduped).  Bypasses the spread
    // unification path entirely.
    engine.inferExpression(node.callee, env);
    const argTypes: Type[] = [];
    for (const arg of node.arguments) {
      if (arg.type === 'SpreadElement') return null; // fall through to generic
      const t = engine.subst.apply(engine.inferExpression(arg as AstNode, env));
      argTypes.push(t);
    }
    if (argTypes.length === 0) return tArray(tVar());
    const elems = dedupTypes(argTypes);
    const elem = elems.length === 1 ? elems[0] : tUnion(elems);
    const result = tArray(elem);
    engine.recordNodeType(node, result);
    return result;
  }

  if (kind === 'Function') {
    const result = tryInferFunctionCtorSmart(engine, node, env);
    if (result) return result;
    // Fall through — let generic call inference produce a `Function` result.
    return null;
  }

  return null;
}

/**
 * Smart-infer `new Function('a', 'b', 'return a + b')`.
 * When every argument is a string literal, the last is treated as the
 * body and the prior strings as parameter names.  We synthesise a
 * `function (a, b) { return a + b }` source, parse it, and infer
 * it with an isolated env so call-site bindings don't leak in.  Returns
 * the inferred function type, or `null` on any parse/infer failure.
 */
function tryInferFunctionCtorSmart(
  engine: InferenceEngine,
  node: estree.CallExpression,
  env: TypeEnv,
): Type | null {
  const args = node.arguments;
  if (args.length === 0) return null;
  // All arguments must be string literals.
  const strs: string[] = [];
  for (const a of args) {
    if (a.type !== 'Literal') return null;
    const v = (a as estree.Literal).value;
    if (typeof v !== 'string') return null;
    strs.push(v);
  }
  const paramNames = strs.slice(0, -1);
  const body = strs[strs.length - 1];
  // Reject param lists that aren't simple identifiers — the parser would also
  // reject, but failing fast keeps error noise out of the diagnostic log.
  if (!paramNames.every(p => /^[A-Za-z_$][\w$]*$/.test(p.trim()))) return null;

  const synth = `(function(${paramNames.join(',')}) { ${body} })`;
  let parsed: estree.Node;
  try {
    parsed = parseExpression(synth);
  } catch {
    return null;
  }
  // Infer with an empty env — Function() bodies don't see outer scope.
  let inferred: Type;
  try {
    inferred = engine.inferExpression(parsed as AstNode, new TypeEnv());
  } catch {
    return null;
  }
  // Record the callee identifier (`Function`) type as the synthesised
  // function type so hover shows something useful and the "Unbound
  // variable: 'Function'" diagnostic is not produced by a downstream
  // inferExpression call on the callee.
  if (node.callee.type === 'Identifier'
      && (node.callee as estree.Identifier).name === 'Function') {
    engine.recordNodeType(node.callee as AstNode, inferred);
  }
  // Infer the literal string arguments for hover / recording — these are
  // safe and don't trigger unbound diagnostics.
  for (const a of args) engine.inferExpression(a as AstNode, env);
  engine.recordNodeType(node, inferred);
  return inferred;
}


/** Is a callee's first parameter variadic: a tuple / spread array with a
 *  `...` member, or a container (`f (…)`) of one? */
function firstParamIsVariadic(engine: InferenceEngine, param: Type): boolean {
  const p = engine.subst.apply(param);
  if (p.tag !== 'TCon') return false;
  if ((p.name === T_TUPLE || p.name === T_SPREAD_ARRAY) && p.args.some(a => isSpread(a))) return true;
  if (p.args.length === 1) {
    const inner = engine.subst.apply(p.args[0]);
    return inner.tag === 'TCon' && (inner.name === T_TUPLE || inner.name === T_SPREAD_ARRAY)
      && inner.args.some(a => isSpread(a));
  }
  return false;
}

/** True when the callee's result (any overload branch) carries a `Picked`
 *  marker, i.e. the call's type is only known after the projection. */
function resultHasPicked(engine: InferenceEngine, calleeType: Type): boolean {
  const resolved = engine.subst.apply(calleeType);
  const results: Type[] = [];
  const collect = (t: Type): void => {
    if (t.tag === 'TFun') results.push(t.result);
    else if (t.tag === 'TCon' && t.name === T_UNION) t.args.forEach(collect);
  };
  collect(resolved);
  return results.some(r => someType(r, n => n.tag === 'TCon' && n.name === T_PICKED));
}

/**
 * Check a projected result against its annotation.  Unification alone is too
 * lenient here (closed records with different fields unify): a projected
 * query is checked EXACTLY — at each position the annotation and the
 * projection must name the same fields (fields the annotation types
 * `X | Undefined` may be absent).  `// q :: QueryTag RangeParams Row` then
 * reports a query that reads a parameter `RangeParams` lacks, or a `Row`
 * field the query does not select.
 */
function checkProjectedAgainstExpected(engine: InferenceEngine, actual: Type, expected: Type, node: AstNode): void {
  const before = engine.diagnostics.length;
  engine.unifyWithDiagnostic(actual, expected, node);
  if (engine.diagnostics.length > before) return;
  const problems: string[] = [];
  const walk = (a: Type, e: Type): void => {
    const ra = engine.maybeExpandAlias(engine.subst.apply(a));
    const re = engine.maybeExpandAlias(engine.subst.apply(e));
    if (ra.tag === 'TRecord' && re.tag === 'TRecord') {
      if (ra.rest || re.rest || (ra.labelFields?.length ?? 0) > 0 || (re.labelFields?.length ?? 0) > 0) return;
      const extra = Object.keys(ra.fields).filter(k => !(k in re.fields));
      const missing = Object.keys(re.fields).filter(k => !(k in ra.fields) && !typeAcceptsUndefinedLoose(engine, re.fields[k]));
      if (extra.length > 0) problems.push(`${extra.map(k => `'${k}'`).join(', ')} not in '${typeToString(re)}'`);
      if (missing.length > 0) problems.push(`${missing.map(k => `'${k}'`).join(', ')} missing from '${typeToString(ra)}'`);
      for (const k of Object.keys(ra.fields)) if (k in re.fields) walk(ra.fields[k], re.fields[k]);
      return;
    }
    if (ra.tag === 'TCon' && re.tag === 'TCon' && ra.name === re.name && ra.args.length === re.args.length) {
      for (let i = 0; i < ra.args.length; i++) walk(ra.args[i], re.args[i]);
    }
  };
  walk(actual, expected);
  if (problems.length > 0) {
    engine.addDiag(`Type mismatch: the query does not match its annotation: ${problems.join('; ')}`, node);
  }
}

/** `T | Undefined` (or `Undefined`). */
function typeAcceptsUndefinedLoose(engine: InferenceEngine, t: Type): boolean {
  const r = engine.subst.apply(t);
  if (r.tag === 'TCon' && r.name === 'Undefined') return true;
  return r.tag === 'TCon' && r.name === T_UNION && r.args.some(x => x.tag === 'TCon' && x.name === 'Undefined');
}

export function inferCallExpression(engine: InferenceEngine, node: estree.CallExpression, env: TypeEnv, expectedResultType?: Type): Type {
    // --- `new` strictness: warn on constructor/`new` mismatches ---
    // Skipped for sumtype variants (idiomatic `Just(5)` allowed) and for
    // anything we have no provenance for.
    checkNewStrictness(engine, node);

    // --- Built-in constructor call specialisation ---
    // `Array(...)` / `[].constructor(...)` / `const ac = [].constructor; ac(...)`
    // should widen the element type to a union of the literal arg types.
    {
      const specialised = tryInferBuiltinCtorCall(engine, node, env);
      if (specialised) return specialised;
    }

    // --- curry wrapper call: curry(fn) ---
    if ((node.callee.type === 'Identifier' && engine.curryFunctionNames.has(node.callee.name as string))
        || memberCalleeScheme(engine, env, node.callee)?.isCurryWrapper) {
      return inferCurryWrapperCall(engine, node, env, expectedResultType);
    }
    // curryN-style wrapper: `curryN (3) (fn)` — the leading call(s) supply
    // the non-function arguments, this call supplies the function.
    {
      let root: AstNode = node.callee as AstNode;
      let depth = 0;
      while (root.type === 'CallExpression') {
        depth++;
        root = (root as estree.CallExpression).callee as AstNode;
      }
      if (depth > 0 && root.type === 'Identifier'
          && engine.curryNFunctionNames.get(root.name as string) === depth) {
        return inferCurryWrapperCall(engine, node, env, expectedResultType);
      }
    }

    let calleeType = engine.inferExpression(node.callee, env);

    // --- Calling a type representative: `TypeRep (T x…)` is the constructor
    // of T (see `T.@@new` in annotations.ts), with its leading type
    // arguments fixed to the representative's.  Without this the call fell
    // into the TypeRep coercion and returned the partial `T x…` itself.
    {
      const rc = engine.subst.apply(calleeType);
      if (rc.tag === 'TCon' && rc.name === T_TYPEREP && rc.args.length === 1) {
        const inner = engine.subst.apply(rc.args[0]);
        if (inner.tag === 'TCon' && !parseKvName(inner.name)) {
          const ctor = lookupStaticMethod(inner.name, '@@new');
          if (ctor) {
            const ctorType = ctor.scheme?.constraints?.length
              ? engine.instantiateWithConstraints(ctor.scheme, node)
              : ctor.factory([]);
            const ret = engine.subst.apply(getFnReturnType(ctorType));
            if (ret.tag === 'TCon' && ret.name === inner.name && ret.args.length >= inner.args.length) {
              for (let i = 0; i < inner.args.length; i++) {
                engine.unifyWithDiagnostic(ret.args[i], inner.args[i], node.callee);
              }
            }
            calleeType = ctorType;
          }
        }
      }
    }

    // --- Overloaded callee: Union of TFun branches (from repeated `Name :: ...`) ---
    // Resolve which branch matches by inferring args first, then trying each.
    // A result with a `Picked` marker only has its real shape after the
    // projection below: an annotation (`// q :: QueryTag Params Row`) is then
    // checked against the projected type, not against the raw marker.
    const deferExpected = !!expectedResultType && resultHasPicked(engine, calleeType);
    {
      const overloadResult = tryInferOverloadedCall(engine, node, env, calleeType, deferExpected ? undefined : expectedResultType);
      if (overloadResult !== null) {
        // The overload path returns before the main path's post-processing
        // hooks run, so apply the `Picked` projection (and a follow-up
        // Merge reduction) here too.  Without this, a call through an
        // overloaded constructor union (e.g. query-builder's
        // `({props} | Table R | ([RSelector p] -> QueryTag p (Picked R RSelector)))`
        // from a generated Tables record) keeps its raw `Picked R Sel`
        // marker: direct property access then only works via the
        // permissive unknown-TCon fallback, and combinators typed with
        // `Merge r1 r2` (e.g. `QueryTag#concat`) produce an unusable union
        // of two unprojected Picked markers.
        let projected = applyPickedProjection(engine, node, env, overloadResult);
        projected = applyMergeReduction(engine, projected, node);
        projected = applyAwaitedReduction(engine, projected);
        if (deferExpected && expectedResultType) checkProjectedAgainstExpected(engine, projected, expectedResultType, node);
        return projected;
      }
    }

    // --- Spread argument call: fn(...args) ---
    // When all arguments are spread elements, the callee accepts variadic args.
    // Type the callee's param as wildcard (*) so that wrapper patterns like
    //   const wrap = (fn) => (...args) => fn(...args)
    // infer as (* -> a) -> * -> a.
    if (node.arguments.length > 0 &&
        node.arguments.every((a: AstNode) => a.type === 'SpreadElement')) {
      const resultType = tVar();
      const calleeFunType = tFun(tAny, resultType);
      engine.unifyWithDiagnostic(calleeType, calleeFunType, node.callee);
      // Infer the spread argument expressions for side effects / recording
      for (const arg of node.arguments) {
        engine.inferExpression((arg as estree.SpreadElement).argument, env);
      }
      if (expectedResultType) {
        engine.unifyWithDiagnostic(resultType, expectedResultType, node);
      }
      return engine.subst.apply(resultType);
    }

    // --- Spread-function wrapper call: fn whose param is a function with spread tuple ---
    // e.g. memoize :: ((a, b, ...) -> z) -> (a, b, ...) -> z
    // This must be checked BEFORE the curried function call path.
    {
      const resolvedCalleeEarly = engine.subst.apply(calleeType);
      if (resolvedCalleeEarly.tag === 'TFun' &&
          resolvedCalleeEarly.param.tag === 'TFun' &&
          isSpreadTupleOrArray(resolvedCalleeEarly.param.param) &&
          !hasSpreadInArrowChain(resolvedCalleeEarly.result) &&
          node.arguments.length === 1) {
        return inferVariadicWrapperCall(engine, node, env, calleeType, resolvedCalleeEarly, expectedResultType);
      }
    }

    // --- Curried function call (result of curry wrapper) ---
    // Check if the callee was produced by a curry wrapper (chained: curry(fn)(a, b))
    // or if the callee is a variable with isCurriedResult in its scheme.
    let isCurried = engine.pendingIsCurriedResult;
    engine.pendingIsCurriedResult = false;
    if (!isCurried && node.callee.type === 'Identifier') {
      const calleeScheme = env.lookup(node.callee.name as string);
      if (calleeScheme?.isCurriedResult) {
        isCurried = true;
      }
    }
    // `ns.f (…)` on a namespace import of a curried library (`R.map (f, xs)`).
    if (!isCurried && memberCalleeScheme(engine, env, node.callee)?.isCurriedResult) {
      isCurried = true;
    }

    // A combinator whose first parameter is variadic — a spread tuple / spread
    // array (`(a -> b, ..., y -> z)`), or a container of one
    // (`f (a -> b, ..., y -> z)`) — needs the specialised routing below
    // (fan-out, variadic items, spread-chain machinery) even when the
    // combinator itself is a `curry (…)` result (an FP library's `pipe`, `compose`,
    // `converge`).  The generic curried path would unify an array literal as a
    // plain `Array (f | g | h)` and lose the link-by-link chain typing.
    if (isCurried) {
      const rc = engine.subst.apply(calleeType);
      if (rc.tag === 'TFun' && firstParamIsVariadic(engine, rc.param)) isCurried = false;
    }

    if (isCurried) {
      const resolvedCalleeForCurry = engine.subst.apply(calleeType);
      if (resolvedCalleeForCurry.tag === 'TFun') {
        const { params, result } = flattenCurriedType(resolvedCalleeForCurry);
        if (params.length > 0) {
          let callResult = inferCurriedFunctionCall(engine, node, env, calleeType, { params, result }, expectedResultType);
          callResult = applyConditionalReturnNarrowing(engine.subst, node, env, callResult);
          return callResult;
        }
      }
    }

    // --- Container-wrapped spread chain called with an array literal ---
    // `f (a -> b, b -> c, ..., y -> z)` behaves exactly like the bare
    // spread-array form `[a -> b, ..., y -> z]`.  Routed by the chain-combinator
    // subsystem (functionPatterns.ts); returns null when it doesn't apply.
    {
      const containerChainResult = tryContainerSpreadChainCall(engine, node, env, calleeType, expectedResultType);
      if (containerChainResult !== null) return containerChainResult;
    }

    let numArgs = node.arguments.length;
    const resultType = tVar();

    // Check if the callee expects more params than provided, and trailing
    // params accept Undefined (i.e. they are optional).  If so, pad with
    // tUndefined so the call type-checks without requiring explicit undefined.
    let resolvedCallee = engine.subst.apply(calleeType);

    // Constructor-as-callable bridge for the case where unification alone
    // wouldn't catch the mismatch — i.e. zero-arg calls.  When the callee
    // resolves to an uppercase TCon (e.g. `QueryTag b` returned from
    // `Organisation([...])`) and the local annotation map or an imported
    // sidecar declares a callable scheme for that name (typically a
    // `QueryTag :: a -> RTask r e [b]` overload supplied by the consumer's
    // project-level override), instantiate that callable form and use it
    // as the effective callee.  This lets `const rest = readRandomOrganisations()`
    // pick up the overridden return type instead of silently producing an
    // unbound TVar.  The non-zero-arg case is already handled by
    // `tryConstructorCallable` invoked from `unifyWithDiagnostic` below.
    if (numArgs === 0 && resolvedCallee.tag === 'TCon'
        && /^[A-Z]/.test(resolvedCallee.name)) {
      const tconName = resolvedCallee.name;
      const localScheme = engine.annotationMap.get(tconName)?.scheme;
      const importedScheme = engine.importedConstructors.get(tconName);
      const scheme = localScheme ?? importedScheme;
      if (scheme) {
        const inst = instantiate(scheme);
        const candidates: Type[] = inst.tag === 'TCon' && inst.name === 'Union'
          ? inst.args.filter(a => a.tag === 'TFun')
          : inst.tag === 'TFun' ? [inst] : [];
        if (candidates.length > 0) {
          // Use the callable form locally for THIS call site.  We
          // intentionally do NOT bind the callee's TVar to the callable
          // form — that would mutate the value's type at every other
          // reference (turning `tagged :: Tag Number` into the union
          // `Tag Number | (a -> a)` next time it's read).  The local
          // rebinding is enough to drive the rest of `inferCallExpression`
          // along the TFun path.
          calleeType = candidates[0];
          resolvedCallee = candidates[0];
        }
      }
    }

    // Handle variadic/spread function calls: (a, ..., z) -> r.  These patterns
    // all key off a `TFun` whose param is a `TCon` container; the structural
    // shapes they match are catalogued by `classifyCallPattern`
    // (functionPatterns.ts), which documents the load-bearing priority order.
    // Partial application of a top-level spread-chain callee peels the
    // remainder (`p1 -> p2 -> ... -> z` applied to one arg → `p2 -> ... -> z`)
    // — see `trySpreadChainCalleePeel` for why this is call-site-only.
    {
      const peeled = trySpreadChainCalleePeel(engine, node, env, resolvedCallee, expectedResultType);
      if (peeled) return peeled;
    }
    if (resolvedCallee.tag === 'TFun' && resolvedCallee.param.tag === 'TCon') {
      // Fan-out combinator (converge/combine): the container is a Foldable-
      // applied heterogeneous tuple `(combiner, a -> x1, a -> x2, ...)`.  A
      // plain unification would melt the array literal into a union and fail
      // against the tuple; instead link each branch to its combiner parameter
      // positionally.  Only fires for a single array-literal argument.
      if (
        numArgs === 1 &&
        node.arguments[0].type === 'ArrayExpression'
      ) {
        const fanOut = matchFanOutCallee(resolvedCallee);
        if (fanOut) {
          return inferFanOutCall(
            engine, node, env, fanOut,
            node.arguments[0] as estree.ArrayExpression,
          );
        }
      }
      if (resolvedCallee.param.name === T_TUPLE &&
          resolvedCallee.param.args.some(a => isSpread(a))) {
        return inferVariadicItems(engine, node, env, resolvedCallee, node.arguments, expectedResultType);
      }

      // Handle spread-array function calls: [a, ..., z] -> r
      if (resolvedCallee.param.name === T_SPREAD_ARRAY &&
          resolvedCallee.param.args.some(a => isSpread(a)) &&
          node.arguments.length === 1 && node.arguments[0].type === 'ArrayExpression') {
        return inferSpreadArrayCall(
          engine, node, env,
          resolvedCallee as { tag: 'TFun'; param: Type; result: Type },
          node.arguments[0] as estree.ArrayExpression,
          expectedResultType,
        );
      }

      if (resolvedCallee.param.name === T_TUPLE && numArgs < resolvedCallee.param.args.length) {
        const expectedParams = resolvedCallee.param.args;
        const missingParams = expectedParams.slice(numArgs);
        const allMissingAcceptUndefined = missingParams.every(p => typeAcceptsUndefined(engine.subst, p));
        if (allMissingAcceptUndefined) {
          numArgs = expectedParams.length;
        }
      }
    }

    // Detect argument count mismatch for tuple-parameter functions early,
    // before unification, to produce a clear arity diagnostic.
    // Instead of bailing out, pad numArgs to the expected count so that
    // unification still decomposes the callee and provided arguments get
    // their correct types.  This avoids cascading errors while the user
    // is still typing additional arguments.
    const calleeOptionalSlots = resolveCalleeOptionalSlots(engine, env, node.callee);
    const hasSpreadArg = node.arguments.some((a: AstNode) => a.type === 'SpreadElement');
    const padded = checkAndPadArity(engine, resolvedCallee, numArgs, node.callee, calleeOptionalSlots, hasSpreadArg);
    numArgs = padded.numArgs;
    const arityMismatch = padded.arityMismatch;

    // When a function is called with zero arguments, treat it as passing
    // `undefined` for every parameter (JS implicit undefined semantics).
    if (numArgs === 0 && resolvedCallee.tag === 'TFun') {
      const calleeParam = resolvedCallee.param;
      if (calleeParam.tag === 'TCon'
          && (calleeParam.name === 'Void' || calleeParam.name === 'Undefined')) {
        // Genuine nullary function `() -> R` (param is the Void marker a
        // zero-param arrow is built with).  A zero-arg call consumes only that
        // single Void parameter and yields `R` — do NOT walk the result chain.
        // Otherwise an IIFE whose thunk returns a curried function — e.g.
        // `(() => value1 => value2 => …)()` typed `Void -> (a -> b -> Boolean)`
        // — would miscount the returned arrows as the thunk's own parameters.
        numArgs = 1;
      } else if (isTuple(calleeParam)) {
        numArgs = calleeParam.args.length;
      } else {
        let count = 1;
        let cur: Type = resolvedCallee.result;
        while (cur.tag === 'TFun') { count++; cur = cur.result; }
        numArgs = count;
      }
    }

    // Extract parameter TVars from the raw callee type (before substitution
    // flattens the chain).  These are the original TVars that need to be
    // updated when an auto-union is created for the corresponding argSlot.
    const calleeParamTVarIds = extractParamTVarIds(calleeType, numArgs);

    // Static key-set removal: when a parameter typed `Array String` receives
    // an inline array literal of string keys (the `omit`/`pick`-by-array
    // pattern), expand the matching `{ [k] :: a, ...r }` group into one
    // concrete field per key so ALL listed keys are removed, not just one.
    calleeType = tryExpandKeySetFromArrayArg(engine, calleeType, node.arguments as ReadonlyArray<AstNode>);

    // Row-map fan-out: when the callee has a label-field `{ [k] :: T }`
    // whose label var k is closed over by the label-field group only,
    // expand it into concrete fields based on the keys of the
    // corresponding object-literal argument.  This makes
    // `unwrap :: { [k] :: Pair a b } -> { [k] :: b }` work uniformly
    // over every key of the argument record.
    calleeType = tryExpandRowMap(engine, calleeType, node.arguments as ReadonlyArray<AstNode>);

    // Plan v6.3 Phase D — structural row-opening at the call site.
    // When the callee's (curried) type has a polymorphic TVar at 2+
    // top-level positions AND at least one argument supplied at one of
    // those positions is an object literal (i.e. structurally a record),
    // rewrite the scheme so each input position gets a fresh row-var and
    // any top-level result position collects them into a `Merge`.  This
    // lets `f :: a -> a -> a` accept records of *different* shapes at
    // different positions without forcing them through a single rigid
    // unification — pure structural mechanism, no class hardcoding.
    calleeType = maybeApplyRowOpening(engine, calleeType, node.arguments as ReadonlyArray<AstNode>);

    // Endomorphic spread-arrow-chain wrapper detection.  An annotation shaped
    // like `(a -> b -> ... -> z) -> a -> b -> ... -> z` (memoize / once /
    // identity-preserving combinators) returns a function of the SAME type as
    // the one it receives.  Because the `...` marker in the RESULT chain is a
    // structural constant with no binding, unifying only the PARAM chain against
    // a concrete argument leaves the result chain's `...` (and any surplus
    // fixed params) in place — e.g. `memoizeCurried(greet2)` would display
    // `a -> b -> ... -> String` instead of greet2's real `a -> b -> String`.
    // When the callee is endomorphic (param chain structurally identical to the
    // result chain and carries a spread), the correct result is simply the
    // concrete argument's own type, so we record the flag here and rebind the
    // result below once the argument has been inferred.
    let endoSpreadWrapper = false;
    {
      const resolvedForEndo = engine.subst.apply(calleeType);
      if (
        numArgs === 1 &&
        resolvedForEndo.tag === 'TFun' &&
        hasSpreadInArrowChain(resolvedForEndo.param) &&
        typeToString(resolvedForEndo.param) === typeToString(resolvedForEndo.result)
      ) {
        endoSpreadWrapper = true;
      }
    }

    // Create placeholder type vars for each argument up front, build the
    // expected callee shape, and unify with the actual callee type.
    // This decomposes the callee and connects each argSlot to the callee's
    // corresponding parameter type.
    const argSlots = freshVars(numArgs);
    // Zero-arg call on a still-unresolved callee: constrain it to a thunk
    // `() -> r` instead of the bare TVar `tMultiFun([], r)` would produce.
    // Without this, `thunk ()` on an unannotated parameter leaves the
    // parameter unconstrained (an FP library's `try :: (() -> a) -> RTask r Error a`
    // in a chained static assignment inferred `a -> ...`).  Known TFun
    // callees were already arity-padded above, so this only fires for
    // genuinely unknown callees.
    const calleeFunType = numArgs === 0 && engine.subst.apply(calleeType).tag === 'TVar'
      ? tFun(tVoid, resultType)
      : tMultiFun(argSlots, resultType);

    // Unify callee with the expected function type.  If unification fails
    // because the callee is a concrete non-function type, replace the
    // confusing "Cannot unify" message with a clearer "not callable" error.
    const diagsBefore = engine.diagnostics.length;
    // Capture a pretty-printed snapshot of the callee BEFORE unification.
    // After a failed unification, free TVars in the callee may be poisoned
    // to `$error` (see poisonFreeVars) which would leak into the
    // "not callable" diagnostic (e.g. `Just $error | Nothing`).  The
    // snapshot preserves the natural variable names (`Just a | Nothing`).
    const calleePrettyBefore = prettyTypeToString(engine.subst.apply(calleeType));
    engine.unifyWithDiagnostic(calleeType, calleeFunType, node.callee);

    // When called with zero arguments, tMultiFun([], result) returns a bare
    // TVar that unifies with anything — so non-function callees (String,
    // Number, etc.) silently succeed instead of producing a diagnostic.
    // Detect this after unification, and rewrite confusing "Cannot unify"
    // messages into clearer "not callable" errors.
    reportNonCallableCallee(engine, node, env, calleeType, numArgs, diagsBefore, calleePrettyBefore);

    // When an expected type is known (from an annotation), unify it with the
    // result type BEFORE inferring arguments.  Because the callee has already
    // been decomposed above, this propagates annotation constraints into the
    // argSlots.  E.g. for `RTask String a Boolean`, this makes `res`'s slot
    // `Boolean -> ()` so that `res("foemp")` correctly errors.
    // An `Awaited x` marker (Promise#then) only means something once the
    // arguments are inferred and it is reduced; the reduced result meets the
    // expected type afterwards, at the use site.
    if (expectedResultType && !deferExpected && !promiseWithAwaited(engine.subst.apply(resultType))) {
      engine.unifyWithDiagnostic(resultType, expectedResultType, node);
    }

    // Now infer actual argument expressions — pass the constrained argSlot
    // as expectedType so function expression arguments get their parameter
    // types pre-constrained by the annotation.
    const actualArgCount = node.arguments.length;

    // When the callee has an explicit type annotation, suppress auto-union
    // during argument inference.  The annotation's parameter types are rigid
    // constraints — a mismatch should produce a diagnostic, not silently
    // create a union type. E.g. `f :: Integer -> Integer` called with
    // `f("hello")` should error, not infer `Integer | String`.
    // Curried applications count too: in `f(g)(true, "x")` the outer call's
    // callee is a CallExpression, but its type still comes from `f`'s
    // annotation — walk the chain to the base identifier so the later arrows
    // of the annotation stay just as rigid as the first.
    let baseCallee: typeof node.callee = node.callee;
    while (baseCallee.type === 'CallExpression') {
      baseCallee = baseCallee.callee;
    }
    const calleeIsAnnotated = baseCallee.type === 'Identifier' &&
      engine.annotationMap.has(baseCallee.name as string);
    const prevSuppressAutoUnion = engine.suppressAutoUnion;
    if (calleeIsAnnotated) {
      engine.suppressAutoUnion = true;
    }

    // Pin the callee-result's free vars for the duration of argument
    // inference: per-element freshening of expanded union element types
    // (array literals) must not sever vars that thread into the result
    // (e.g. `p` in `[Selector p] -> Tag p o`).
    const prevPinned = engine.pinnedElementVarIds;
    {
      const resultVarNames = new Map<number, string>();
      collectVarNames(engine.subst.apply(resultType), resultVarNames);
      engine.pinnedElementVarIds = new Set(resultVarNames.keys());
    }

    const resolvedParamTypes: Type[] = [];
    const actualArgTypes: Type[] = [];
    // Skolems minted for rank-N (`forall`) parameter slots during this call —
    // used by the post-loop escape check below.  Lazily allocated so the
    // rank-1 hot path pays nothing.
    let rankNSkolems: Set<string> | null = null;

    try {

    // Capture resolved param types BEFORE arg inference for union narrowing
    for (let i = 0; i < numArgs && i < actualArgCount; i++) {
      resolvedParamTypes.push(engine.subst.apply(argSlots[i]));
    }

    for (let i = 0; i < numArgs; i++) {
      if (i >= actualArgCount) {
        // Arity mismatch: leave padded slots as fresh vars — the diagnostic
        // was already emitted, no need to unify with Undefined.
        if (arityMismatch) continue;
        // Spread argument (`fn (a, ...rest)`): the remaining slots are filled
        // by the spread at runtime — leave them unconstrained.
        if (hasSpreadArg) continue;
        // Nullary function: () -> m — the slot resolved to Void after callee
        // decomposition; do not pad with Undefined.
        const resolvedSlot = engine.subst.apply(argSlots[i]);
        if (resolvedSlot.tag === 'TCon' && resolvedSlot.name === 'Void') {
          continue;
        }
        // JS-default slot (`(x, y = 0) => …`): the default supplies the
        // value, so the missing argument puts no constraint on the slot.
        if (calleeOptionalSlots && calleeOptionalSlots.includes(i)) continue;
        // Padded optional parameter — fill with Undefined
        engine.unifyWithDiagnostic(tUndefined, argSlots[i], node);
        continue;
      }
      const expectedArgType = engine.subst.apply(argSlots[i]);
      // --- Rank-N parameter slot: the annotation demands a POLYMORPHIC
      // argument (`forall a. ...`).  Skolemize the bound variables and check
      // the argument against the rigid body — only a genuinely polymorphic
      // argument passes (subsumption).  Handled fully by the helper; the
      // regular leniency paths below (callback adaptation, auto-union
      // propagation) must not see the quantifier.
      if (expectedArgType.tag === 'TForall') {
        if (!rankNSkolems) rankNSkolems = new Set<string>();
        const rankNArgType = inferRankNArgument(
          engine, node.arguments[i], env, expectedArgType, rankNSkolems,
        );
        actualArgTypes.push(rankNArgType);
        continue;
      }
      // JS callback-arity tolerance: when the expected slot is a multi-arg
      // callback `(a, Number, [a]) -> b` but the argument is an *expression*
      // that evaluates to a function (e.g. a point-free `dumpKey(this)` call,
      // not an inline arrow), passing the multi-arg slot as the eager expected
      // type would force the nested expression to unify its (fewer-param)
      // function result against the tuple param and spuriously fail.  Defer to
      // `adaptCallbackArity` below by inferring without the eager expected
      // type.  Inline function literals keep the expected type so their
      // parameters get pre-constrained.
      let argExpected: Type | undefined = expectedArgType;
      const argNodeType = node.arguments[i].type;
      const argIsFunctionLiteral =
        argNodeType === 'ArrowFunctionExpression' || argNodeType === 'FunctionExpression';
      if (!argIsFunctionLiteral
          && expectedArgType.tag === 'TFun'
          && isTuple(expectedArgType.param)) {
        argExpected = undefined;
      }
      // Auto-union may widen the ARGUMENT side, never the callee's parameter:
      // when the slot was already concrete after decomposing the callee
      // (`String` from `toUpper :: String -> String`, whether the callee is
      // annotated here, imported, or an alias such as `const top = toUpper`),
      // a mismatching argument is an error — not a silent `String | Number`.
      // Function literals keep their own (gradual) body inference.
      const slotBefore = resolvedParamTypes[i];
      const slotIsConcrete = slotBefore !== undefined && slotBefore.tag !== 'TVar'
        && !(slotBefore.tag === 'TCon' && slotBefore.name === T_UNION);
      const suppressHere = slotIsConcrete && !argIsFunctionLiteral && !engine.suppressAutoUnion;
      if (suppressHere) engine.suppressAutoUnion = true;
      // (Restored after `adaptCallbackArity` below, which performs the
      // argument-vs-slot unification for non-literal arguments.)
      const argType = engine.inferExpressionWithExpected(node.arguments[i], env, argExpected);
      actualArgTypes.push(engine.subst.apply(argType));

      // Protect an annotated, still-polymorphic parameter from being PINNED
      // globally by an unrelated call.  When the argument is a reference to a
      // parameter whose declared (frozen) type is polymorphic — e.g. a
      // `Foldable f => f a | String` overload parameter passed to
      // `hasProp :: String -> Object k a -> Boolean` — unifying the param's
      // own type variable with the callee's concrete parameter would mutate
      // the parameter's type everywhere (inside AND outside any guarding
      // `if`), producing spurious narrowings such as `foldable :: Object k a`.
      // Instead, satisfy the callee slot with a FRESH instantiation of the
      // argument type so the parameter's variable stays free (let-style
      // polymorphism at the call boundary).  This only applies when the slot
      // would otherwise specialise the parameter (the slot is more concrete
      // than a bare variable).
      let effectiveArgType = argType;
      if (shouldProtectPolymorphicParamArg(engine, node.arguments[i], env, argSlots[i])) {
        effectiveArgType = freshenType(engine.subst.apply(argType));
      }

      // JS callback adaptation: pad arity when actual function has fewer params
      // than the expected multi-arg callback slot (e.g. [1,2].map(String)).
      try {
        adaptCallbackArity(engine, effectiveArgType, argSlots[i], node.arguments[i]);
      } finally {
        if (suppressHere) engine.suppressAutoUnion = false;
      }

      // Numeric literal refinement: when the callee has an annotation with a
      // refined numeric type (Integer, NonNegativeInteger, NegativeInteger),
      // check whether the literal value satisfies the refinement.
      if (calleeIsAnnotated) {
        const paramType = engine.subst.apply(argSlots[i]);
        if (paramType.tag === 'TCon' && NUMERIC_SUBTYPES.has(paramType.name)) {
          const litValue = getNumericLiteralValue(node.arguments[i]);
          if (litValue !== null) {
            const err = checkNumericRefinement(paramType.name, litValue);
            if (err) {
              engine.addDiag(
                `Type '${paramType.name}' — ${err}`,
                node.arguments[i],
              );
            }
          }
        }
      }

      // If auto-union was created for this argSlot, propagate the union to
      // the callee's original parameter TVar so it flows into the result type.
      const resolvedSlot = engine.subst.apply(argSlots[i]);
      if (
        resolvedSlot.tag === 'TCon' &&
        resolvedSlot.name === T_UNION &&
        calleeParamTVarIds[i] !== undefined
      ) {
        engine.subst.set(calleeParamTVarIds[i]!, resolvedSlot);
      }

      // Default unfilled record-field type variables to Undefined.  When an
      // object-literal argument lacks a field that the callee's open-record
      // parameter expects (e.g. `getTwo("name", "age", {})` against
      // `(k, i, { [k] :: a, [i] :: b, ...r }) -> { [k] :: a, [i] :: b }`),
      // the value-type variables `a`, `b` would otherwise stay unbound and
      // surface as polymorphic in the result.  At runtime those reads yield
      // `undefined`, so binding the unfilled vars matches JS semantics and
      // gives a more useful inferred type for the call result.
      defaultUnfilledFieldsToUndefined(engine, node.arguments[i], expectedArgType);
    }

    } finally {
      // Restore auto-union suppression state after argument inference.
      engine.suppressAutoUnion = prevSuppressAutoUnion;
      engine.pinnedElementVarIds = prevPinned;
    }

    let result = engine.subst.apply(resultType);

    // Rank-N escape check: a skolem minted for a `forall` parameter slot may
    // not survive into the call's result type — that would let the callee's
    // locally-quantified variable leak into the caller's scope.
    if (rankNSkolems !== null && rankNSkolems.size > 0 &&
        someType(result, t => t.tag === 'TCon' && (rankNSkolems as Set<string>).has(t.name))) {
      engine.addDiag(
        'Polymorphic value escapes its scope: a type bound by \'forall\' appears in the call result',
        narrowToIdentifier(node),
      );
    }

    // Endomorphic spread-arrow-chain wrapper: the result is definitionally the
    // same type as the concrete argument (see the flag computed above).  Adopt
    // the argument's actual (fully arity-resolved) type so the result chain's
    // spread `...` collapses to the argument's real arity instead of lingering.
    if (endoSpreadWrapper && actualArgTypes.length === 1) {
      const resolvedArg = engine.subst.apply(actualArgTypes[0]);
      if (resolvedArg.tag === 'TFun' && !hasSpreadInArrowChain(resolvedArg)) {
        result = resolvedArg;
      }
    }

    // applyArgs-style peeling capture — recorded by the chain-combinator
    // subsystem (functionPatterns.ts) so the follow-up array application can
    // peel partial results and flag over-application.
    captureSpreadChainPeel(engine, node, numArgs, actualArgTypes, resolvedCallee, result);

    // Narrow union return types based on actual argument types.
    // E.g. if callee is (Number | null) -> Number | null and arg is Number,
    // the result narrows to Number (since we know the argument is not null).
    result = narrowCallResultByArgs(result, resolvedParamTypes, actualArgTypes);

    // Literal guard conditional return narrowing
    result = applyConditionalReturnNarrowing(engine.subst, node, env, result);

    // Inline call-site record projection: when the result type contains a
    // `Picked R a` marker (a generic primitive used by libraries that emit
    // signatures like `[Selector] -> QueryTag (Picked Row Selector)`), inspect
    // the call's literal-array argument and replace the marker with a
    // record built from the elements.  Pure post-processing — does not
    // change unification semantics elsewhere.
    validateSelectorRelations(engine, node, result);
    result = applyPickedProjection(engine, node, env, result);
    // Reduce any `Merge a b` markers in the result to a single structural
    // union record (alias-stripped, conflicting field types unified).
    // Runs AFTER picked projection so that combinators like
    // `QueryTag#concat` operate on already-projected rows.
    result = applyMergeReduction(engine, result, node);
    result = applyAwaitedReduction(engine, result);
    if (deferExpected && expectedResultType) checkProjectedAgainstExpected(engine, result, expectedResultType, node);

    // Generic paramHint capture: when the call's result is a TCon and one
    // of its arguments is (after substitution) a callback `({...record...}) -> _`,
    // attach the record as `paramHint` on the result TCon.  This lets
    // helper bindings like `const limit = Limit(p => p.limit)` carry the
    // captured callback record across the binding so downstream consumers
    // (e.g. `gatherParamRecord` in another call's selector list) can
    // reconstruct the structural parameter shape even after generalisation
    // would otherwise erase it.
    if (result.tag === 'TCon' && !result.paramHint) {
      for (const arg of node.arguments) {
        const argType = engine.maybeExpandAlias(
          engine.subst.apply(engine.getNodeType(arg as AstNode) ?? tVar()),
        );
        if (argType.tag === 'TFun') {
          const paramT = engine.maybeExpandAlias(engine.subst.apply(argType.param));
          if (paramT.tag === 'TRecord' && Object.keys(paramT.fields).length > 0) {
            result.paramHint = paramT;
            break;
          }
        }
      }
    }

    // Re-resolve the result so any TCon eventually surfaced through the
    // substitution can still receive a `paramHint` (helper calls like
    // `Limit(p => p.x)` typically have a TVar result here that only
    // becomes `Limit (callback)` after unification at the use-site).
    const resolved = engine.subst.apply(result);
    if (resolved !== result && resolved.tag === 'TCon' && !resolved.paramHint) {
      for (const arg of node.arguments) {
        const argType = engine.maybeExpandAlias(
          engine.subst.apply(engine.getNodeType(arg as AstNode) ?? tVar()),
        );
        if (argType.tag === 'TFun') {
          const paramT = engine.maybeExpandAlias(engine.subst.apply(argType.param));
          if (paramT.tag === 'TRecord' && Object.keys(paramT.fields).length > 0) {
            resolved.paramHint = paramT;
            break;
          }
        }
      }
      result = resolved;
    }

    return result;
  }

// ---------------------------------------------------------------------------
// Rank-N argument subsumption
// ---------------------------------------------------------------------------

/**
 * Check a call argument against a `forall` parameter slot (rank-N
 * subsumption).  The quantified variables are skolemized to fresh rigid
 * constants; the argument is then inferred/checked against the skolemized
 * body.  A monomorphic argument (e.g. `Number -> Number` against
 * `forall a. a -> a`) fails to unify with the skolems and produces ONE
 * targeted "not polymorphic enough" diagnostic — the raw skolem-mismatch
 * diagnostics raised during inference are scrubbed.  Poisoning and
 * auto-union are suppressed for the duration so a failed subsumption
 * neither cascades nor melts into a union.
 */
export function inferRankNArgument(
  engine: InferenceEngine,
  argNode: AstNode,
  env: TypeEnv,
  expected: Extract<Type, { tag: 'TForall' }>,
  rankNSkolems: Set<string>,
): Type {
  const { body: skolemBody, skolems, skolemToName, varToSkolem } = skolemizeForall(expected);
  for (const s of skolems) rankNSkolems.add(s);
  engine.registerSkolemNames(skolemToName);

  // Constraint promises: `forall f. Functor f => …` guarantees the Functor
  // methods on the skolemized binder — record the promised classes (plus
  // superclasses) so pending-constraint validation accepts them on the skolem.
  if (expected.constraints) {
    for (const c of expected.constraints) {
      const sk = c.varId !== undefined ? varToSkolem.get(c.varId) : undefined;
      if (!sk) continue;
      let promised = engine.rankNSkolemPromises.get(sk);
      if (!promised) { promised = new Set(); engine.rankNSkolemPromises.set(sk, promised); }
      promised.add(c.className);
      for (const sup of constraintSuperclassClosure(c.className)) promised.add(sup);
    }
  }

  const diagsBefore = engine.diagnostics.length;
  const prevSuppressUnion = engine.suppressAutoUnion;
  engine.suppressAutoUnion = true;
  engine.suppressPoisonDepth++;
  let argType: Type = skolemBody;
  let failed = false;
  try {
    argType = engine.inferExpressionWithExpected(argNode, env, skolemBody);
    const s = unify(engine.resolve(skolemBody), engine.resolve(argType));
    engine.subst.mergeFrom(s);
  } catch (e) {
    if (!(e instanceof UnificationError)) throw e;
    failed = true;
  } finally {
    engine.suppressPoisonDepth--;
    engine.suppressAutoUnion = prevSuppressUnion;
  }

  // Any diagnostic raised against one of OUR skolems means the same thing:
  // the argument is not polymorphic enough.  Collapse them into one targeted
  // message; keep unrelated diagnostics (genuine errors inside a lambda body).
  // Note: pretty-printing may already have mapped the skolem back to its
  // display letter, so once subsumption is known to have failed we also drop
  // new diagnostics located INSIDE the argument span (they are all symptoms
  // of the same root cause).
  const skolemRes = Array.from(skolems).map(
    n => new RegExp(`${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`),
  );
  const mentionsSkolem = (msg: string): boolean => skolemRes.some(re => re.test(msg));
  let sawSkolemDiag = false;
  for (let d = diagsBefore; d < engine.diagnostics.length; d++) {
    if (mentionsSkolem(engine.diagnostics[d].message)) { sawSkolemDiag = true; break; }
  }
  if (failed || sawSkolemDiag) {
    const argSpan = argNode as { start?: number; end?: number };
    const kept: typeof engine.diagnostics = [];
    for (let d = diagsBefore; d < engine.diagnostics.length; d++) {
      const diag = engine.diagnostics[d];
      const insideArg = typeof argSpan.start === 'number' && typeof argSpan.end === 'number'
        && diag.start >= argSpan.start && diag.end <= argSpan.end;
      if (!insideArg && !mentionsSkolem(diag.message)) kept.push(diag);
    }
    engine.diagnostics.length = diagsBefore;
    engine.diagnostics.push(...kept);
    const gotPretty = prettyTypeToString(
      scrubSkolems(engine.resolve(argType), skolemToName),
    );
    engine.addDiag(
      `Argument is not polymorphic enough: expected '${prettyTypeToString(expected)}' but got '${gotPretty}'`,
      narrowToIdentifier(argNode),
    );
  }
  return engine.resolve(argType);
}

// ---------------------------------------------------------------------------
// Picked projection — inline record build from a call-site array argument
// ---------------------------------------------------------------------------

/**
 * Constructor-aware "no relation" diagnostic.
 *
 * When a call-site has the shape `Parent([Child(...), ...])` (or
 * `Parent([Child, ...])` — bare identifier form) and the result type
 * carries a `Picked R _` marker for a row `R` that has at least one
 * registered method-shadow (i.e. the schema declares relations on that
 * row), each array element whose extracted child-row name is NOT a
 * known relation of `R` produces a friendly diagnostic:
 *
 *   `'Child' has no relation with 'Parent'`
 *
 * Located on the offending element node.  Replaces (and pre-empts) the
 * coarser "is not a valid relation here. Valid relations: …" message
 * that `unifyWithUnion` may also emit at the same span — we strip any
 * such pre-existing diagnostic at the same span when we fire.
 *
 * Generic across libraries — relies only on the `Picked R _` primitive
 * plus method-shadow registry.
 */
function validateSelectorRelations(
  engine: InferenceEngine,
  node: estree.CallExpression,
  result: Type,
): void {
  if (node.callee.type !== 'Identifier') return;
  const parentCalleeName = (node.callee as estree.Identifier).name;
  const arrayArg = node.arguments.find(a => (a as AstNode).type === 'ArrayExpression') as estree.ArrayExpression | undefined;
  if (!arrayArg) return;

  // Collect parent row aliases from `Picked R _` markers in the result.
  const parentRows = new Set<string>();
  const collect = (t: Type, depth = 0): void => {
    if (depth > 20) return;
    if (t.tag === 'TCon') {
      if (t.name === T_PICKED && t.args.length >= 1) {
        const r = engine.subst.apply(t.args[0]);
        if (r.tag === 'TCon') parentRows.add(r.name);
        else if (r.tag === 'TRecord' && r.alias) parentRows.add(r.alias);
      }
      for (const a of t.args) collect(a, depth + 1);
    } else if (t.tag === 'TFun') {
      collect(t.param, depth + 1);
      collect(t.result, depth + 1);
    } else if (t.tag === 'TRecord') {
      for (const k in t.fields) collect(t.fields[k], depth + 1);
      if (t.rest) collect(t.rest, depth + 1);
    }
  };
  collect(result);
  if (parentRows.size === 0) return;

  // Only check parent rows that actually declare some relations.  Without
  // this gate, fully generic demos (e.g. one with no `R#x :: ChildRow`
  // shadows at all) would wrongly reject every nested call.
  const relevantParents = Array.from(parentRows).filter(r => getMethodNames(r).length > 0);
  if (relevantParents.length === 0) return;

  for (const elem of arrayArg.elements) {
    if (!elem) continue;
    const elemNode = elem as AstNode;
    if (elemNode.type !== 'CallExpression' && elemNode.type !== 'Identifier') continue;
    // Skip identifiers that resolve to a column or `Prop T` (handled by
    // projection's own positive cases) — only flag ones that look like
    // a row-constructor reference.
    const elemType = engine.subst.apply(engine.getNodeType(elemNode) ?? tVar());
    const childRow = extractChildRowForRelationCheck(engine, elemNode, elemType);
    if (!childRow) continue;
    // Determine the child constructor name for the message.
    let childCalleeName: string | undefined;
    if (elemNode.type === 'CallExpression') {
      const callee = (elemNode as estree.CallExpression).callee as AstNode;
      if (callee.type === 'Identifier') childCalleeName = (callee as estree.Identifier).name;
    } else {
      childCalleeName = (elemNode as estree.Identifier).name;
    }
    if (!childCalleeName) continue;
    // If ANY relevant parent accepts this child as a relation, allow.
    let accepted = false;
    for (const parentRow of relevantParents) {
      if (findShadowKeyForChildRow(parentRow, childRow, null)) { accepted = true; break; }
    }
    if (accepted) continue;
    // Strip any pre-existing redundant union-mismatch diagnostic at the
    // same span before emitting the friendlier one.
    const loc = narrowToIdentifier(elemNode);
    engine.diagnostics = engine.diagnostics.filter(d =>
      !(d.start === loc.start && d.end === loc.end &&
        / is not a valid relation here\b/.test(d.message)));
    engine.addDiag(
      `'${childCalleeName}' has no relation with '${parentCalleeName}'`,
      loc,
    );
  }
}

/**
 * Like `extractChildRowName` but specifically for the relation-check pass.
 *
 * For CallExpression elements: prefer the call's already-resolved result
 * type, which after `applyPickedProjection` carries a `pickedFrom` tag on
 * its inner TRecord — the most reliable source of "what row this call
 * returns".  Only when that's unavailable, fall back to scanning the
 * callee's TFun signature (result side only, to avoid selector-union
 * cross-pollution from the parent call's unification).
 *
 * For Identifier elements (bare row reference): scan the resolved type's
 * TFun result side for a `Picked R _` marker.
 */
function extractChildRowForRelationCheck(
  engine: InferenceEngine,
  elemNode: AstNode,
  elemType: Type,
): string | null {
  if (elemNode.type === 'CallExpression') {
    const callee = (elemNode as estree.CallExpression).callee as AstNode;
    const calleeType = engine.subst.apply(engine.getNodeType(callee) ?? tVar());
    return findPickedInResultSides(engine, calleeType);
  }
  if (elemNode.type === 'Identifier') {
    // Bare identifier: same caveat — param sides may carry parent's
    // selector-union rows after unification.
    return findPickedInResultSides(engine, elemType);
  }
  return null;
}


/**
 * For an object-literal argument, bind any field-value type variables in the
 * expected (callee) parameter that the literal didn't supply to `Undefined`.
 * This matches JS runtime semantics (missing keys read as `undefined`) and
 * avoids leaving free type vars in the call's result type.
 */
function defaultUnfilledFieldsToUndefined(
  engine: InferenceEngine,
  argNode: AstNode,
  expectedArgType: Type,
): void {
  if (!argNode || argNode.type !== 'ObjectExpression') return;
  const expected = engine.subst.apply(expectedArgType);
  if (expected.tag !== 'TRecord') return;

  // Collect string keys actually present in the literal.
  const provided = new Set<string>();
  const props = (argNode as unknown as { properties: Array<{
    type: string;
    key?: { type: string; name?: string; value?: unknown };
    computed?: boolean;
  }> }).properties || [];
  for (const p of props) {
    if (p.type !== 'Property' || !p.key) continue;
    if (p.computed) continue;
    if (p.key.type === 'Identifier' && typeof p.key.name === 'string') {
      provided.add(p.key.name);
    } else if (p.key.type === 'Literal' && typeof p.key.value === 'string') {
      provided.add(p.key.value);
    }
  }

  for (const [k, vt] of Object.entries(expected.fields)) {
    if (provided.has(k)) continue;
    const resolved = engine.subst.apply(vt);
    if (resolved.tag === 'TVar') {
      engine.subst.set(resolved.id, tUndefined);
    }
  }
}

function isAwaitedMarker(t: Type): boolean {
  return t.tag === 'TCon' && t.name === 'Awaited';
}

/** A `Promise e (Awaited b)` result of `Promise#then` (see applyAwaitedReduction). */
function promiseWithAwaited(t: Type): boolean {
  return t.tag === 'TCon' && t.name === 'Promise' && t.args.some(isAwaitedMarker);
}
