// ============================================================================
// Functional pattern recognition — central home for the LSP's understanding of
// curried, variadic (`...`) and container-shaped combinators.
// ============================================================================
//
// The type inference for call expressions (`inferCallExpression` in calls.ts)
// dispatches over a family of *functional patterns* — curry wrappers, curried
// results, variadic spread chains, spread-array appliers, and the fan-out
// combinators (converge / combine).  This module is the shared home for the
// pattern classification and for the self-contained pattern handlers, so the
// recognition logic lives in one place rather than being scattered through the
// dispatch tree.
//
// All pattern handlers now live here in full (curry wrapper, variadic wrapper,
// curried application, variadic items, spread-array applier, container spread
// chain, applyArgs peel capture, and fan-out); calls.ts retains only the
// dispatch that selects among them (see CallPatternKind for the catalogue).
//
// ----------------------------------------------------------------------------
// The chain-combinator subsystem — two DUAL special rules
// ----------------------------------------------------------------------------
// Two heterogeneous-fold rules cooperate to type `reduce`-based combinators
// whose accumulator type varies across the fold (the homogeneous
// `reduce :: (b -> a -> b) -> b -> f a -> b` cannot express them).  Both are
// detected PURELY STRUCTURALLY — no `reduce`/`Foldable` name is ever matched.
//
//   R. reduce-over-chain (pipe/compose): a container of ARROWS
//      `f (a->b, ..., y->z)`.  FINITE (endomorphic collapse `b = a`).
//        R1a  collapse    — unify.ts (isArrowChainTuple/collapseArrowChainTuple)
//        R1b  trust        — annotations.ts (annotationHasArrowChainTuple + skip)
//        R2   call routing — this module (tryContainerSpreadChainCall,
//                            inferSpreadArrayCall)
//
//   A. applyArgs peeling: a single curried fn + a `[a, b, ...]` applier
//      `(a->b->...->z) -> [a, b, ...] -> z = reduce(apply)`.  INFINITE
//      (occurs-check `d = c -> d`).
//        A-unify    — unify.ts (unifySpreadArrowChain / hasTopLevelSpreadChain)
//        A-infinite — index.ts/statements.ts (suppressInfiniteType, occursCheck)
//        A-peel     — this module (captureSpreadChainPeel + inferSpreadArrayCall);
//                     the `spreadChainPeel` Map is engine state (index.ts)
//
// The pure Type predicates both rules share live in hm/typeUtils.ts (the lowest
// layer); they are re-exported below so this module is the single, documented
// reference surface for the subsystem.  See sample/demo9.js for a worked
// demonstration of both rules.

import type { InferenceEngine } from './index';
import {
  Type,
  AstNode,
  tVar,
  tFun,
  tCon,
  tTuple,
  tArray,
  tUndefined,
  isSpread,
  isTuple,
  flattenCurriedType,
  parseKvName,
  typeToString,
  T_TUPLE,
  T_UNION,
  T_SPREAD_ARRAY,
} from '../hm/types';
import { TypeEnv } from '../hm/env';
import type * as estree from '../estree';
import {
  hasSpreadInArrowChain,
  isSpreadTupleOrArray,
  collapseMultiParamLevel,
  detectSpreadChainLink,
  isArrowChainTuple,
  collapseArrowChainTuple,
  hasTopLevelSpreadChain,
  replaceSpreadTupleWithConcrete,
  freshenType,
  collectTVarIdsFromType,
  extractCorresponding,
} from '../hm/typeUtils';
import { applyConditionalReturnNarrowing } from './narrowing';
import { narrowToIdentifier } from './annotations';
import { freshVars } from './helpers';

// Chain-combinator predicate surface (defined in hm/typeUtils.ts).  Re-exported
// here so the classifier, the handlers, and their callers reference one place.
export {
  hasSpreadInArrowChain,
  isSpreadTupleOrArray,
  collapseMultiParamLevel,
  detectSpreadChainLink,
  isArrowChainTuple,
  collapseArrowChainTuple,
  hasTopLevelSpreadChain,
};

/**
 * The functional call-patterns the inference engine recognises.  This enum is
 * the documented catalogue of the dispatch order used by `inferCallExpression`
 * (calls.ts); every handler it names now lives in this module, while the
 * dispatch that selects among them stays inline in the engine's hot path.
 */
export enum CallPatternKind {
  /** `curry(f)` — wraps a multi-param function into a curried chain. */
  CurryWrapper = 'CurryWrapper',
  /** The result of a curried application: `a -> b -> ... -> z`. */
  CurriedResult = 'CurriedResult',
  /** A wrapper over a variadic callee: `(a, ..., z) -> r`. */
  VariadicWrapper = 'VariadicWrapper',
  /** A variadic callee applied to positional items: `pipe(f, g, h)`. */
  VariadicItems = 'VariadicItems',
  /** A callee applied to a spread array argument: `f(...xs)`. */
  SpreadArrayApplier = 'SpreadArrayApplier',
  /** A container-wrapped linear spread chain: `f (a->b, b->c, ..., y->z)`. */
  ContainerSpreadChain = 'ContainerSpreadChain',
  /** A curried arrow chain carrying a `...` marker: `a -> b -> ... -> z`. */
  SpreadArrowChain = 'SpreadArrowChain',
  /** A fan-out combinator: `converge([f, g, h])` / `combine([...])`. */
  FanOut = 'FanOut',
  /** An uppercase constructor value used in call position. */
  ConstructorCallable = 'ConstructorCallable',
  /** A callback argument whose arity is adapted to the expected slot. */
  CallbackArity = 'CallbackArity',
  /** The default application path. */
  Regular = 'Regular',
}

/**
 * Fan-out combinator template, extracted from a callee of the shape
 *   `Foldable f => f (x1 -> x2 -> ... -> z, a -> x1, a -> x2, ...) -> a -> RESULT`
 * (converge / combine).  The container holds a HEAD *combiner* followed by a
 * variadic TAIL of *branches*, each producing one combiner parameter from a
 * shared input `a`.  `wrapper`, when present, is the Applicative/Chain type
 * constructor that wraps every branch result and the final result (combine's
 * `m`); it is `null` for the plain fan-out (converge).
 */
export interface FanOutTemplate {
  wrapper: string | null;
  /**
   * The kind-variable id of the Foldable container `f` (`$kv:f:N`).  The
   * fan-out call only fires for a single array-literal argument, so `f` is
   * always `Array`; binding this id lets the container's declared
   * constraints (`Foldable f`, `Applicative f`, `Monoid (f a)`) resolve and
   * be validated against `Array` — exactly as ordinary unification does for
   * a simple `f a` parameter (e.g. `tail`).
   */
  containerVarId: number;
}

/**
 * Recognise a fan-out combinator callee.  Returns the template when the callee
 * is `f (Tuple(HEAD, a -> x1, ..., ...)) -> a -> RESULT` with a Foldable-style
 * container (a constrained type variable applied to a single spread tuple whose
 * first element is a curried arrow chain), otherwise `null`.
 */
export function matchFanOutCallee(resolvedCallee: Type): FanOutTemplate | null {
  if (resolvedCallee.tag !== 'TFun') return null;
  const param = resolvedCallee.param;
  // Container: a constrained type var (`$kv:f:N`) applied to exactly one arg.
  const containerKv = param.tag === 'TCon' ? parseKvName(param.name) : null;
  if (param.tag !== 'TCon' || !containerKv || param.args.length !== 1) return null;
  const inner = param.args[0];
  if (inner.tag !== 'TCon' || inner.name !== T_TUPLE) return null;
  if (!inner.args.some(a => isSpread(a))) return null;
  // First tuple element must be the curried combiner (a function).
  if (inner.args.length < 2 || inner.args[0].tag !== 'TFun') return null;
  // At least one tail element must be a branch `a -> xk`.
  const hasBranch = inner.args.slice(1).some(a => a.tag === 'TFun');
  if (!hasBranch) return null;
  // Determine the branch/result wrapper from the call's final result template
  // `a -> RESULT`: if RESULT is `m z` (a constrained var applied to one arg),
  // this is the Applicative-lifting variant (combine); otherwise plain.
  let wrapper: string | null = null;
  const resTail = resolvedCallee.result;
  if (resTail.tag === 'TFun' && resTail.result.tag === 'TCon'
      && parseKvName(resTail.result.name) && resTail.result.args.length === 1) {
    wrapper = resTail.result.name;
  }
  return { wrapper, containerVarId: containerKv.varId };
}

/**
 * Infer a fan-out combinator call `converge([combiner, b1, b2, ...])` /
 * `combine([...])`.  Positional linking: the combiner is flattened to params
 * `P`; branch `k` is unified with `a -> P[k]` (or `a -> m P[k]` for combine)
 * against a single shared input variable `a`.  A branch-count vs combiner-arity
 * mismatch is reported.  The call yields `a -> z` (or `a -> m z`).
 */
export function inferFanOutCall(
  engine: InferenceEngine,
  node: estree.CallExpression,
  env: TypeEnv,
  template: FanOutTemplate,
  arrayNode: estree.ArrayExpression,
): Type {
  const elements = arrayNode.elements as AstNode[];
  const aShared = tVar();
  const wrap = (t: Type): Type =>
    template.wrapper ? tCon(template.wrapper, [t]) : t;

  // The fan-out argument is an array literal, so the Foldable container `f`
  // is `Array`.  Bind its kind-variable id (still unresolved here because
  // this path bypasses the ordinary parameter/argument unification) so the
  // container's declared constraints — `Foldable f`, `Applicative f`,
  // `Monoid (f a)` — resolve to `Array` and are validated exactly as they
  // are for a simple `f a` parameter.  Only bind when still unresolved to
  // avoid clobbering a concrete binding from an earlier step.
  const containerVar: Type = { tag: 'TVar', id: template.containerVarId, name: '' };
  if (engine.subst.apply(containerVar).tag === 'TVar') {
    engine.subst.set(template.containerVarId, tCon('Array', []));
  }

  if (elements.length === 0) {
    // Empty container: nothing to converge — result is `a -> a`.
    return tFun(aShared, aShared);
  }

  // HEAD combiner.
  const combinerType = engine.subst.apply(engine.inferExpression(elements[0], env));
  const flat = flattenCurriedType(combinerType);
  const params = flat.params;
  const branches = elements.slice(1);

  // Arity: one branch per combiner parameter.
  if (branches.length !== params.length && params.length > 0) {
    engine.addDiag(
      `The fan-out combiner takes ${params.length} argument${params.length === 1 ? '' : 's'}, ` +
        `but ${branches.length} branch${branches.length === 1 ? ' was' : 'es were'} supplied`,
      arrayNode,
    );
  }

  const linked = Math.min(branches.length, params.length);
  for (let k = 0; k < linked; k++) {
    const branchType = engine.subst.apply(engine.inferExpression(branches[k], env));
    const expected = tFun(aShared, wrap(engine.subst.apply(params[k])));
    engine.unifyWithDiagnostic(branchType, expected, branches[k]);
  }
  // Branches beyond the combiner's arity (over-supply) still get inferred so
  // their own bodies are checked, but they have no combiner slot to link to.
  for (let k = linked; k < branches.length; k++) {
    engine.inferExpression(branches[k], env);
  }

  const zc = engine.subst.apply(flat.result);
  return tFun(engine.subst.apply(aShared), wrap(zc));
}

/**
 * Assign before/after slot constraints and set up chain constraints for a
 * spread-annotated call (both function-arg and array-element variants).
 *
 * - `before` annotation types are unified with the first N slots.
 * - `after` annotation types are unified with the last M slots.
 * - Middle slots get fresh chain-compatible type variables.
 * - Pairwise chain constraints are added across the spread boundary.
 */
export function applySpreadSlotConstraints(
    engine: InferenceEngine,
    slots: Type[],
    before: Type[],
    after: Type[],
    numItems: number,
    reportNode: AstNode,
  ): void {
    // Assign before types to first slots
    for (let i = 0; i < before.length && i < numItems; i++) {
      engine.unifyWithDiagnostic(slots[i], before[i], reportNode);
    }

    // Assign after types to last slots (may overlap with before)
    for (let i = 0; i < after.length; i++) {
      const idx = numItems - after.length + i;
      if (idx >= 0) {
        engine.unifyWithDiagnostic(slots[idx], after[i], reportNode);
      }
    }

    // Add chain constraints across the ... boundary and for middle slots.
    const chain = detectSpreadChainLink(before, after);
    if (chain && (before.length > 0 || after.length > 0) && numItems >= before.length + after.length) {
      const middleStart = before.length;
      const middleEnd = numItems - after.length;

      // Create chain-compatible type slots for middle items
      if (middleStart < middleEnd) {
        const prototype = before[0] ?? after[0];
        for (let i = middleStart; i < middleEnd; i++) {
          const freshSlot = freshenType(prototype);
          engine.unifyWithDiagnostic(slots[i], freshSlot, reportNode);
        }
      }

      // Add pairwise chain constraints from lastBefore through all middle to firstAfter.
      const chainStart = before.length > 0 ? before.length - 1 : 0;
      const chainEnd = numItems - after.length;
      for (let i = chainStart; i < chainEnd && i < numItems - 1; i++) {
        const slotI = engine.subst.apply(slots[i]);
        const slotJ = engine.subst.apply(slots[i + 1]);

        if (slotI.tag === 'TFun' && slotJ.tag === 'TFun') {
          if (chain.direction === 'ltr') {
            const outI = extractCorresponding(chain.resultTemplate, slotI.result, chain.linkId);
            const inJ = extractCorresponding(chain.paramTemplate, slotJ.param, chain.linkId);
            if (outI && inJ) engine.unifyWithDiagnostic(outI, inJ, reportNode);
          } else {
            const outJ = extractCorresponding(chain.resultTemplate, slotJ.result, chain.linkId);
            const inI = extractCorresponding(chain.paramTemplate, slotI.param, chain.linkId);
            if (outJ && inI) engine.unifyWithDiagnostic(outJ, inI, reportNode);
          }
        }
      }
    }
  }

/**
 * Infer a spread-array call `[a, ..., z] -> r` (or the container-wrapped
 * `f (a, ..., z)` normalised to the same shape) against a single array-literal
 * argument.  Splits the spread tuple into before/after, chain-links the array
 * elements via `inferVariadicItems`, records the array node's hover type, and
 * applies applyArgs-style peeling when the callee captured a curried arity.
 */
export function inferSpreadArrayCall(
    engine: InferenceEngine,
    node: AstNode,
    env: TypeEnv,
    resolvedCallee: { tag: 'TFun'; param: Type; result: Type },
    arrayNode: estree.ArrayExpression,
    expectedResultType?: Type,
  ): Type {
    // Arity check: for an arrow *chain* spread `[a->b, b->c, ..., y->z]` the
    // `...` denotes "zero or more links", and the shared boundary types let any
    // length collapse onto the declared endpoints.  All degenerate lengths are
    // therefore legal and inferable:
    //   0 links -> the chain is the identity `a -> a` (an empty fold returns
    //              the threaded seed unchanged).  This mirrors the fan-out
    //              empty-container rule in `inferFanOutCall`.
    //   1 link  -> the single element's arrow type (the first `before` and last
    //              `after` templates unify onto that one slot).
    //   N links -> the collapsed chain `first.param -> last.result`.
    // For a plain heterogeneous spread tuple (`[String, ..., Number]`) the
    // before/after positions are independent, so every non-spread element is
    // mandatory.
    const tArgs = (resolvedCallee.param as { args: Type[] }).args;
    const spreadIdxAr = tArgs.findIndex(a => isSpread(a));
    const nonSpreadAr = tArgs.filter(a => !isSpread(a));
    const isArrowChain = nonSpreadAr.length > 0 && nonSpreadAr.every(a => a.tag === 'TFun');
    const elemCount = arrayNode.elements.length;
    if (isArrowChain && elemCount === 0) {
      // Empty arrow chain: nothing to compose — the result is the identity
      // `a -> a`.  Record an empty-array hover type and short-circuit before
      // the slot machinery (which has no elements to link).
      engine.recordNodeType(arrayNode as unknown as AstNode, tArray(tVar()));
      const identityInput = tVar();
      return tFun(identityInput, identityInput);
    }
    const minRequired = spreadIdxAr >= 0
      ? (isArrowChain
          ? 1
          : tArgs.length - 1)
      : tArgs.length;
    if (elemCount < minRequired) {
      engine.addDiag(
        `Array literal has ${elemCount} element${elemCount === 1 ? '' : 's'}, expected at least ${minRequired} for type '${typeToString(resolvedCallee.param)}'`,
        arrayNode as unknown as AstNode,
      );
    }
    const result = inferVariadicItems(
      engine, node, env, resolvedCallee,
      arrayNode.elements as AstNode[],
      expectedResultType,
    );
    // Record a standard Array type on the array node for hover display
    const firstNonSpread = tArgs.find(a => !isSpread(a));
    const arrayElemType = firstNonSpread ? freshenType(firstNonSpread) : tVar();
    engine.recordNodeType(arrayNode as unknown as AstNode, tArray(engine.subst.apply(arrayElemType)));

    // applyArgs-style peeling.  If the callee of THIS array application is
    // a combinator partial whose function argument's arity we captured,
    // derive the result by peeling that function by the array length:
    //   m  >  n  -> over-application (runtime crash)  => diagnostic
    //   m  <  n  -> partial application => result is the curried remainder
    //   m === n  -> full application    => keep the chain terminal result
    // (n counts curried levels; the array literal supplies m arguments.)
    const peel = engine.spreadChainPeel.get((node as { callee: AstNode }).callee);
    if (peel) {
      const n = peel.params.length;
      const m = elemCount;
      if (m > n) {
        engine.addDiag(
          `Array literal has ${m} element${m === 1 ? '' : 's'}, but the function takes at most ${n} argument${n === 1 ? '' : 's'}`,
          arrayNode as unknown as AstNode,
        );
      } else if (m < n) {
        let remainder = engine.subst.apply(peel.result);
        for (let i = n - 1; i >= m; i--) {
          remainder = tFun(engine.subst.apply(peel.params[i]), remainder);
        }
        return remainder;
      }
    }
    return result;
  }

/**
 * Shared logic for inferring variadic tuple/array calls (with `...` spread).
 *
 * The callee has a function type whose param is a Tuple or SpreadArray that
 * contains a spread marker.  We split the tuple into "before" (types before
 * `...`) and "after" (types after `...`).  Before types are assigned to the
 * first N items, after types to the last M items.  Overlapping positions
 * (when actualItems < before+after) unify with both — naturally connecting
 * the chain pattern (e.g. pipe, compose).  Middle items get fresh type vars.
 *
 * `items` is either function arguments or array literal elements.
 */
export function inferVariadicItems(
    engine: InferenceEngine,
    node: AstNode,
    env: TypeEnv,
    resolvedCallee: Type,
    items: AstNode[],
    expectedResultType?: Type,
  ): Type {
    const numItems = items.length;
    const calleeFun = resolvedCallee as { tag: 'TFun'; param: Type; result: Type };
    const tupleArgs = (calleeFun.param as { tag: 'TCon'; name: string; args: Type[] }).args;
    const spreadIdx = tupleArgs.findIndex(a => isSpread(a));
    const before = tupleArgs.slice(0, spreadIdx);
    const after = tupleArgs.slice(spreadIdx + 1);

    const resultType = tVar();
    engine.unifyWithDiagnostic(resultType, calleeFun.result, node);

    if (expectedResultType) {
      engine.unifyWithDiagnostic(resultType, expectedResultType, node);
    }

    const slots = freshVars(numItems);
    applySpreadSlotConstraints(engine, slots, before, after, numItems, node);

    for (let i = 0; i < numItems; i++) {
      if (items[i]) {
        const expectedItemType = engine.subst.apply(slots[i]);
        const itemType = engine.inferExpressionWithExpected(items[i], env, expectedItemType);
        // Use the already-applied expected type rather than the raw slot TVar so
        // that auto-union does not bind the slot to a Union when an annotation
        // gave it a concrete type — we want a clear mismatch diagnostic.
        engine.unifyWithDiagnostic(itemType, expectedItemType, items[i]);
      }
    }

    return engine.subst.apply(resultType);
  }

export function inferCurryWrapperCall(engine: InferenceEngine, node: estree.CallExpression, env: TypeEnv, expectedResultType?: Type): Type {
    // Infer the callee (the curry function itself) to record its type
    engine.inferExpression(node.callee, env);

    // An OVERLOADED binding annotation (union of function branches, e.g.
    // an FP library's `ap :: Apply f => f (a -> b) -> f a -> f b` +
    // `ap :: (a -> b -> c) -> (a -> b) -> a -> c`) is not a single expected
    // type for the curried result: unifying against the union always fails.
    // The binding-level overload check (`maybeRigidCheck`) verifies the body
    // branch-wise, exactly as for a plain nested-arrow implementation.
    if (expectedResultType) {
      const exp = engine.subst.apply(expectedResultType);
      if (exp.tag === 'TCon' && exp.name === T_UNION && exp.args.length >= 2
          && exp.args.every(b => b.tag === 'TFun')) {
        expectedResultType = undefined;
      }
    }

    if (node.arguments.length !== 1) {
      engine.addDiag(`Curry wrapper expects exactly 1 argument (the function to curry), got ${node.arguments.length}`, narrowToIdentifier(node as AstNode));
      return tVar();
    }

    // If the call site has an annotation in curried form
    // (e.g. `// foo :: String -> a -> Boolean`), build a tuple-form
    // expected type for the lambda argument so its parameters pick up
    // the annotated types BEFORE body inference, instead of being left
    // as fresh tvars that drift to default numerics.
    let expectedArgType: Type | undefined;
    const fnArg = node.arguments[0] as estree.Function;
    const fnArity = (fnArg && (fnArg.type === 'ArrowFunctionExpression' || fnArg.type === 'FunctionExpression'))
      ? (fnArg.params?.length ?? 0)
      : 0;
    if (expectedResultType && fnArity > 1) {
      const flat = flattenCurriedType(engine.subst.apply(expectedResultType));
      if (flat.params.length >= fnArity) {
        const tupleParams = flat.params.slice(0, fnArity);
        // Result is whatever remains after consuming `fnArity` params
        // (re-curry the remaining params with the original tail).
        let remainingResult: Type = flat.result;
        for (let i = flat.params.length - 1; i >= fnArity; i--) {
          remainingResult = tFun(flat.params[i], remainingResult);
        }
        expectedArgType = tFun(tTuple(tupleParams), remainingResult);
      }
    }

    // Infer the argument (the function being curried)
    const argType = expectedArgType
      ? engine.inferExpressionWithExpected(node.arguments[0], env, expectedArgType)
      : engine.inferExpression(node.arguments[0], env);
    const resolvedArgType = engine.subst.apply(argType);

    // Helper: build a fully curried type from one TFun branch.  Returns
    // the original type when it's not a multi-param tuple function (curry
    // is then a no-op).
    const curryBranch = (branch: Type): Type | null => {
      if (branch.tag !== 'TFun') return null;
      if (!isTuple(branch.param)) return branch;
      const ps = (branch.param as { args: Type[] }).args;
      if (ps.length <= 1) return branch;
      let cur: Type = branch.result;
      for (let i = ps.length - 1; i >= 0; i--) cur = tFun(ps[i], cur);
      return cur;
    };

    // Overloaded function: curry each branch and re-union the results so
    // call sites continue to pick the matching overload.
    if (resolvedArgType.tag === 'TCon' && resolvedArgType.name === T_UNION
        && resolvedArgType.args.every(a => a.tag === 'TFun')) {
      const curried: Type[] = [];
      for (const branch of resolvedArgType.args) {
        const c = curryBranch(branch);
        if (c) curried.push(c);
      }
      if (curried.length === 0) {
        engine.addDiag(`Curry wrapper expects a function argument`, node.arguments[0]);
        return tVar();
      }
      engine.pendingIsCurriedResult = true;
      const result = curried.length === 1 ? curried[0] : tCon(T_UNION, curried);
      if (expectedResultType) engine.unifyWithDiagnostic(result, expectedResultType, node);
      return engine.subst.apply(result);
    }

    if (resolvedArgType.tag !== 'TFun') {
      engine.addDiag(`Curry wrapper expects a function argument`, node.arguments[0]);
      return tVar();
    }

    let params: Type[];
    let result: Type;

    if (isTuple(resolvedArgType.param)) {
      // Multi-param function: (A, B, C) -> R
      params = resolvedArgType.param.args;
      result = resolvedArgType.result;
    } else {
      // Single-param function: not useful to curry. Return as-is.
      engine.pendingIsCurriedResult = false;
      return resolvedArgType;
    }

    if (params.length <= 1) {
      // 0 or 1 param — curry is a no-op
      engine.pendingIsCurriedResult = false;
      return resolvedArgType;
    }

    // Build fully curried type: A -> B -> C -> R
    let curriedType: Type = result;
    for (let i = params.length - 1; i >= 0; i--) {
      curriedType = tFun(params[i], curriedType);
    }

    engine.pendingIsCurriedResult = true;

    if (expectedResultType) {
      engine.unifyWithDiagnostic(curriedType, expectedResultType, node);
    }

    return engine.subst.apply(curriedType);
  }

/**
 * Arity-tolerant unification for an aligned callback parameter pair.  When
 * both sides are function types and the ACTUAL declares fewer parameters than
 * the EXPECTED callback supplies, JS simply leaves the surplus parameters
 * undefined — align the declared prefix and the results (e.g. a node-style
 * `cb` used as `cb ("err")` against a slot's `(e, a) -> ()`).  Falls back to
 * plain unification in every other case.
 */
function unifyCallbackParamTolerant(
  engine: InferenceEngine, actual: Type, expected: Type, argNode: AstNode,
): void {
  const a = engine.subst.apply(actual);
  const e = engine.subst.apply(expected);
  if (a.tag === 'TFun' && e.tag === 'TFun') {
    const apl = isTuple(a.param) ? a.param.args : [a.param];
    const epl = isTuple(e.param) ? e.param.args : [e.param];
    if (apl.length < epl.length && !apl.some(isSpread) && !epl.some(isSpread)) {
      for (let j = 0; j < apl.length; j++) {
        engine.unifyWithDiagnostic(apl[j], epl[j], argNode);
      }
      engine.unifyWithDiagnostic(a.result, e.result, argNode);
      return;
    }
  }
  engine.unifyWithDiagnostic(actual, expected, argNode);
}

/**
 * Handle a call to a spread-function wrapper like memoize/once/tryCatch.
 *
 * Pattern: ((a, b, ...) -> z) -> (a, b, ...) -> z
 * The callee takes a function with a spread tuple param and returns a
 * function with the same (or modified) shape. We unify the argument's
 * concrete param list against the spread pattern and reconstruct the
 * result type with the concrete param list (stripping spread markers).
 */
export function inferVariadicWrapperCall(
    engine: InferenceEngine,
    node: estree.CallExpression,
    env: TypeEnv,
    calleeType: Type,
    resolvedCallee: Type,
    expectedResultType?: Type,
  ): Type {
    const calleeFun = resolvedCallee as { tag: 'TFun'; param: Type; result: Type };
    const paramFun = calleeFun.param as { tag: 'TFun'; param: Type; result: Type };
    const paramTuple = paramFun.param as { tag: 'TCon'; name: string; args: Type[] };

    // Infer the argument (the function being wrapped)
    const argType = engine.inferExpression(node.arguments[0], env);
    const resolvedArg = engine.subst.apply(argType);

    // Extract concrete param types from the argument
    let concreteParams: Type[];
    let concreteResult: Type;

    if (resolvedArg.tag === 'TFun' && isTuple(resolvedArg.param)) {
      concreteParams = resolvedArg.param.args;
      concreteResult = resolvedArg.result;
    } else if (resolvedArg.tag === 'TFun') {
      // Single-param function
      concreteParams = [resolvedArg.param];
      concreteResult = resolvedArg.result;
    } else {
      // Can't determine — fall back to standard inference
      const paramType = tVar();
      const resultType = tVar();
      const calleeFunType = tFun(paramType, resultType);
      engine.unifyWithDiagnostic(calleeType, calleeFunType, node.callee);
      engine.unifyArgWithDiagnostic(argType, engine.subst.apply(paramType), node.arguments[0]);
      if (expectedResultType) {
        engine.unifyWithDiagnostic(resultType, expectedResultType, node);
      }
      return engine.subst.apply(resultType);
    }

    // Bind the spread pattern's type vars to concrete types
    const spreadIdx = paramTuple.args.findIndex(a => isSpread(a));
    const beforePattern = paramTuple.args.slice(0, spreadIdx);
    const afterPattern = paramTuple.args.slice(spreadIdx + 1);

    // Unify before elements
    for (let i = 0; i < beforePattern.length && i < concreteParams.length; i++) {
      unifyCallbackParamTolerant(engine, concreteParams[i], beforePattern[i], node.arguments[0]);
    }

    // Unify after elements (from the end)
    for (let i = 0; i < afterPattern.length; i++) {
      const concreteIdx = concreteParams.length - afterPattern.length + i;
      if (concreteIdx >= 0) {
        unifyCallbackParamTolerant(engine, concreteParams[concreteIdx], afterPattern[i], node.arguments[0]);
      }
    }

    // Unify the result type var
    engine.unifyWithDiagnostic(paramFun.result, concreteResult, node.arguments[0]);

    // Now build the return type by applying substitutions to the annotation's
    // result type, but replacing any spread Tuples with the concrete param list.
    const resultType = engine.subst.apply(calleeFun.result);
    const finalResult = replaceSpreadTupleWithConcrete(resultType, concreteParams);

    if (expectedResultType) {
      engine.unifyWithDiagnostic(finalResult, expectedResultType, node);
    }

    return engine.subst.apply(finalResult);
  }

/**
 * Handle a call to a curried function (result of curry wrapper) with any number of arguments.
 *
 * For a curried type A -> B -> C -> R:
 *   - Called with 1 arg:  unify arg with A, return B -> C -> R
 *   - Called with 2 args: unify args with [A, B], return C -> R
 *   - Called with 3 args: unify args with [A, B, C], return R
 */
/**
 * Decide whether a call argument that references an annotated, still-
 * polymorphic parameter should be protected from being pinned by the callee's
 * concrete parameter type.  Returns true only when:
 *   • the argument is a bare Identifier,
 *   • it resolves to a parameter whose binding carries a `frozenDisplay`
 *     (i.e. an annotated parameter),
 *   • that declared type is an *overload union* of unrelated branches
 *     (e.g. `Foldable f => f a | String`) — NOT a single polymorphic type
 *     such as `a -> b`, which must still unify so genuine mismatches surface,
 *   • the current argument type is still polymorphic (unresolved), and
 *   • the callee slot it would unify against is MORE concrete than a bare
 *     variable (so the unification would actually specialise the parameter).
 *
 * In that situation the parameter is being used purely as a value passed to an
 * unrelated helper (such as a `hasProp` membership test); pinning its variable
 * would leak the helper's parameter type back onto the parameter everywhere.
 */
export function shouldProtectPolymorphicParamArg(
  engine: InferenceEngine,
  argNode: AstNode,
  env: TypeEnv,
  argSlot: Type,
): boolean {
  if (argNode.type !== 'Identifier') return false;
  const scheme = env.lookup((argNode as estree.Identifier).name as string);
  if (!scheme || !scheme.frozenDisplay) return false;

  // The declared type must be an overload union of unrelated branches.  A
  // single polymorphic type (e.g. `a -> b`) is intentionally left unprotected
  // so that passing it to a callee whose slot has more structure (e.g. a
  // constraint method expecting `a -> m b`) still reports a real mismatch.
  const declared = scheme.frozenDisplay;
  if (declared.tag !== 'TCon' || declared.name !== T_UNION) return false;

  // The live argument type must still be polymorphic (unresolved); if the body
  // already specialised it to something concrete, respect that.
  const resolvedArg = engine.subst.apply(scheme.type);
  const argVars = new Set<number>();
  collectTVarIdsFromType(resolvedArg, argVars);
  if (argVars.size === 0) return false;

  // The callee slot must be more concrete than a bare variable — otherwise no
  // specialisation would occur and protection is unnecessary.
  const resolvedSlot = engine.subst.apply(argSlot);
  if (resolvedSlot.tag === 'TVar') return false;

  return true;
}

/**
 * `__` or `ns.__` whose type is `Placeholder`: Ramda's placeholder, which
 * leaves a parameter of a curried function open.  The name is checked first,
 * so ordinary arguments are inferred once, with their expected type.
 */
function isPlaceholderArgument(engine: InferenceEngine, arg: AstNode, env: TypeEnv): boolean {
  const name = arg.type === 'Identifier'
    ? (arg as estree.Identifier).name
    : arg.type === 'MemberExpression' && !(arg as estree.MemberExpression).computed
      && (arg as estree.MemberExpression).property?.type === 'Identifier'
      ? ((arg as estree.MemberExpression).property as estree.Identifier).name
      : null;
  if (name !== '__') return false;
  const t = engine.subst.apply(engine.inferExpression(arg, env));
  return t.tag === 'TCon' && t.name === 'Placeholder' && t.args.length === 0;
}

export function inferCurriedFunctionCall(
    engine: InferenceEngine,
    node: estree.CallExpression,
    env: TypeEnv,
    calleeType: Type,
    curryInfo: { params: Type[]; result: Type },
    expectedResultType?: Type,
  ): Type {
    const numArgs = node.arguments.length;
    const { params, result } = curryInfo;

    // Zero-arg call: treat as passing `undefined` for the first parameter.
    // Consume the parameter so that subsequent chained calls shift to the
    // next param (e.g. takeWhile()([2]) checks [2] against Array a, not
    // against a -> Boolean).  Only the first `()` gets the error.
    if (numArgs === 0) {
      if (params.length > 0) {
        // Highlight only the "()" part, not the whole call expression
        const parensLoc = { start: node.callee.end, end: node.end } as AstNode;
        // A genuine nullary step (`() -> R`, param is the Void marker) is
        // satisfied by the empty call itself — exactly as on the regular call
        // path (calls.ts).  Only a real parameter receives `undefined`.
        const first = engine.subst.apply(params[0]);
        if (!(first.tag === 'TCon' && first.name === 'Void' && first.args.length === 0)) {
          engine.unifyWithDiagnostic(tUndefined, params[0], parensLoc);
        }

        // Build the remaining curried type after consuming the first param
        const remainingParams = params.slice(1);
        let restType: Type = result;
        for (let i = remainingParams.length - 1; i >= 0; i--) {
          restType = tFun(remainingParams[i], restType);
        }
        if (remainingParams.length > 0) {
          engine.pendingIsCurriedResult = true;
        }
        return engine.subst.apply(restType);
      }
      return engine.subst.apply(calleeType);
    }

    if (numArgs === 1) {
      // Single arg: use normal inference (works naturally with curried types)
      // But still set pendingIsCurriedResult if there are remaining params
      const resultType = tVar();
      const argSlot = tVar();
      const calleeFunType = tFun(argSlot, resultType);
      engine.unifyWithDiagnostic(calleeType, calleeFunType, node.callee);

      // Check if conditional return narrowing may apply.  When it does,
      // we must defer the expectedResultType unification until AFTER
      // narrowing so that the narrowed (not the original union) type
      // propagates into the caller's type variables.
      const calleeName = node.callee.type === 'Identifier' ? node.callee.name as string : null;
      const calleeScheme = calleeName ? env.lookup(calleeName) : null;
      const deferExpected = calleeScheme?.conditionalReturn != null;

      if (expectedResultType && !deferExpected) {
        engine.unifyWithDiagnostic(resultType, expectedResultType, node);
      }

      const expectedArgType = engine.subst.apply(argSlot);
      const argType = engine.inferExpressionWithExpected(node.arguments[0], env, expectedArgType);
      // Same protection as the regular call path: an overload-annotated
      // parameter passed to an unrelated helper (`hasProp ("length")
      // (foldable)` in an FP library's `size`) must not be pinned to the helper's
      // parameter type — also when the helper is a `curry (…)` result.
      const effectiveArgType = shouldProtectPolymorphicParamArg(engine, node.arguments[0], env, argSlot)
        ? freshenType(engine.subst.apply(argType))
        : argType;
      // Directional, like the multi-argument path below.  Against the
      // RESOLVED slot: the fresh `argSlot` is bound to the callee's parameter
      // by now, and a still-variable slot would let auto-union widen it
      // instead of reporting a wrong argument (`curry (f) ("2")`).
      engine.unifyArgWithDiagnostic(effectiveArgType, engine.subst.apply(argSlot), node.arguments[0]);

      // If remaining params > 1, result is still curried
      if (params.length > 1) {
        engine.pendingIsCurriedResult = true;
      }

      if (deferExpected) {
        // Apply narrowing first, then unify with expected type
        let narrowed = applyConditionalReturnNarrowing(engine.subst, node, env, engine.subst.apply(resultType));
        if (expectedResultType) {
          engine.unifyWithDiagnostic(narrowed, expectedResultType, node);
        }
        return engine.subst.apply(narrowed);
      }

      return engine.subst.apply(resultType);
    }

    if (numArgs > params.length) {
      engine.addDiag(`Curried function called with ${numArgs} arguments, but only accepts up to ${params.length}`, narrowToIdentifier(node as AstNode));
      return tVar();
    }

    // Multi-arg call: consume numArgs parameters from the curried chain
    const consumedParams = params.slice(0, numArgs);
    // A placeholder argument (`subtract (__, 10)`) leaves its parameter open:
    // the result takes the skipped parameters first, then the rest.
    const skippedParams: Type[] = [];

    // Infer each argument and unify with the corresponding consumed param
    for (let i = 0; i < numArgs; i++) {
      if (isPlaceholderArgument(engine, node.arguments[i], env)) {
        skippedParams.push(consumedParams[i]);
        continue;
      }
      const argType = engine.inferExpressionWithExpected(node.arguments[i], env, consumedParams[i]);
      const effectiveArgType = shouldProtectPolymorphicParamArg(engine, node.arguments[i], env, consumedParams[i])
        ? freshenType(engine.subst.apply(argType))
        : argType;
      engine.unifyArgWithDiagnostic(effectiveArgType, consumedParams[i], node.arguments[i]);
    }

    const remainingParams = [...skippedParams, ...params.slice(numArgs)];
    let restType: Type = result;
    for (let i = remainingParams.length - 1; i >= 0; i--) {
      restType = tFun(remainingParams[i], restType);
    }

    if (expectedResultType) {
      engine.unifyWithDiagnostic(restType, expectedResultType, node);
    }

    // If there are remaining params, result is still curried
    if (remainingParams.length > 0) {
      engine.pendingIsCurriedResult = true;
    }

    return engine.subst.apply(restType);
  }

/**
 * Route a container-wrapped spread chain called with an array literal.
 *
 * `f (a -> b, b -> c, ..., y -> z)` behaves exactly like the bare spread-array
 * form `[a -> b, ..., y -> z]`.  Detected up front (before the curried-call
 * path swallows the single array argument as a whole): the kind-variable `f` is
 * bound to the literal's concrete container (`Array`) so the Foldable `::rep`
 * discharge still resolves, then the literal's elements are routed through the
 * shared chain-collapsing machinery (`inferSpreadArrayCall`).
 *
 * Only a *linear* pipe/compose chain (every non-spread element a single-arg
 * arrow) is routed here; a fan-out combinator whose HEAD is a multi-arity
 * combiner is left for `matchFanOutCallee`.  Returns the inferred result type
 * when it routes, otherwise `null`.
 */
export function tryContainerSpreadChainCall(
  engine: InferenceEngine,
  node: estree.CallExpression,
  env: TypeEnv,
  calleeType: Type,
  expectedResultType?: Type,
): Type | null {
  const rc = engine.subst.apply(calleeType);
  if (
    rc.tag === 'TFun' &&
    rc.param.tag === 'TCon' &&
    node.arguments.length === 1 &&
    node.arguments[0].type === 'ArrayExpression'
  ) {
    const kvInfo = parseKvName(rc.param.name);
    if (kvInfo && rc.param.args.length === 1) {
      const inner = engine.subst.apply(rc.param.args[0]);
      if (
        inner.tag === 'TCon' &&
        (inner.name === T_TUPLE || inner.name === T_SPREAD_ARRAY) &&
        inner.args.some(a => isSpread(a))
      ) {
        // Distinguish a *linear* pipe/compose chain
        // `(a -> b, b -> c, ..., y -> z)` — every element a single-arg
        // arrow — from a fan-out combinator `(x1 -> x2 -> ... -> z,
        // a -> x1, ...)` whose HEAD is a multi-arity combiner.  Only the
        // former is routed through the spread-array chain machinery; the
        // latter is left for `matchFanOutCallee` further down.
        const nonSpread = inner.args.filter(a => !isSpread(a));
        const allSingleArgArrows =
          nonSpread.length > 0 &&
          nonSpread.every(a => a.tag === 'TFun' && flattenCurriedType(a).params.length === 1);
        if (allSingleArgArrows) {
          // Bind the container kind-variable to Array (0 args absorbed) —
          // mirrors `unifyKvConcrete`'s binding for `f a` vs `Array x`.
          engine.subst.set(kvInfo.varId, tCon('Array', []));
          const effCallee = {
            tag: 'TFun' as const,
            param: tCon(T_SPREAD_ARRAY, inner.args),
            result: rc.result,
          };
          return inferSpreadArrayCall(
            engine, node, env, effCallee,
            node.arguments[0] as estree.ArrayExpression,
            expectedResultType,
          );
        }
      }
    }
  }
  return null;
}

/**
 * applyArgs-style peeling CAPTURE.  When a combinator's parameter is a spread
 * arrow chain `(a -> b -> ... -> z)` and applying the concrete curried function
 * argument yields a spread-array applier `[a, b, ...] -> z`, record the
 * function's flattened arity + terminal keyed by THIS call node.  The follow-up
 * array application (`partial(array)`) looks it up via `node.callee` to peel the
 * result (partial application) and flag over-application.  Cheap to compute;
 * only fires for the SpreadArray form.
 */
export function captureSpreadChainPeel(
  engine: InferenceEngine,
  node: estree.CallExpression,
  numArgs: number,
  actualArgTypes: Type[],
  resolvedCallee: Type,
  result: Type,
): void {
  if (
    numArgs === 1 &&
    actualArgTypes.length === 1 &&
    resolvedCallee.tag === 'TFun' &&
    hasSpreadInArrowChain(resolvedCallee.param) &&
    result.tag === 'TFun' &&
    result.param.tag === 'TCon' &&
    result.param.name === T_SPREAD_ARRAY &&
    (result.param as { args: Type[] }).args.some(a => isSpread(a))
  ) {
    // A spread arrow chain `a -> b -> ... -> z` consumes ONE argument per
    // curried level (the applier feeds one array element per level).  A
    // function level that takes multiple parameters (e.g. `(x, dummy) => …`)
    // still consumes exactly one array element — the surplus parameters read
    // as `undefined` at runtime (that is the whole point of the `dummy`
    // slot).  Rather than rejecting such a level we SOFT-COLLAPSE it to its
    // first parameter, so `(x, dummy) -> b` behaves like `x -> b`.  This is
    // reflected in the recorded peel params so partial-application remainders
    // display as clean single-parameter chains.
    const fnFlat = flattenCurriedType(engine.subst.apply(actualArgTypes[0]));
    engine.spreadChainPeel.set(node, {
      params: fnFlat.params.map(p => collapseMultiParamLevel(engine.subst.apply(p))),
      result: fnFlat.result,
    });
  }
}

/**
 * PARTIAL APPLICATION of a top-level spread-chain CALLEE.  When a value typed
 * as a variadic arrow chain `p1 -> p2 -> ... -> z` is CALLED with fewer
 * arguments than its fixed leading params, the honest result is the PEELED
 * REMAINDER chain (`p2 -> ... -> z`), not the terminal `z` that the lenient
 * `unifySpreadArrowChain` bottom-out rule would produce.  This is the rule
 * that types the heterogeneous fold accumulator in FP-library `combine`:
 *
 *   // reducer :: Applicative m => (m x -> m y -> ... -> m z) -> (a -> m x) -> m y -> ... -> m z
 *   const reducer = acc => fn => acc (fn (value));
 *
 * `acc (…)` peels ONE argument off the chain per step.  Context-aware by
 * design: only a CALL site knows the chain is being applied — at the raw
 * unification level a short concrete function is indistinguishable from a
 * short function ARGUMENT, which must keep bottoming out on the terminal so
 * over-application diagnostics stay intact.
 *
 * Returns the remainder type, or `null` when the pattern does not apply
 * (no top-level spread, zero args, or enough args to reach the spread —
 * the generic path handles those).
 */
export function trySpreadChainCalleePeel(
  engine: InferenceEngine,
  node: estree.CallExpression,
  env: TypeEnv,
  resolvedCallee: Type,
  expectedResultType?: Type,
): Type | null {
  if (resolvedCallee.tag !== 'TFun' || !hasTopLevelSpreadChain(resolvedCallee)) return null;
  const numArgs = node.arguments.length;
  if (numArgs === 0) return null;
  if (node.arguments.some(a => a.type === 'SpreadElement')) return null;
  const flat = flattenCurriedType(resolvedCallee);
  const spreadIdx = flat.params.findIndex(isSpread);
  // Only intercept when the args stop BEFORE the spread — once the spread
  // starts absorbing, the chain length is unknown and the generic terminal
  // reconciliation is the right (existing) semantics.
  if (spreadIdx < 0 || numArgs >= spreadIdx) return null;

  for (let i = 0; i < numArgs; i++) {
    const slot = engine.subst.apply(flat.params[i]);
    const argType = engine.inferExpressionWithExpected(node.arguments[i], env, slot);
    engine.unifyArgWithDiagnostic(argType, flat.params[i], node.arguments[i] as AstNode);
  }

  const remainder = flat.params
    .slice(numArgs)
    .reduceRight<Type>((acc, p) => tFun(p, acc), flat.result);
  if (expectedResultType) {
    engine.unifyWithDiagnostic(remainder, expectedResultType, node);
  }
  return engine.subst.apply(remainder);
}

/**
 * JS allows ignoring extra callback arguments (e.g. `[1,2].map(String)` works
 * even though `map` passes `(element, index, array)`).  When the expected slot
 * is a multi-arg Tuple function and the actual arg is a function with fewer
 * params, pad the arg type to match the expected shape instead of erroring.
 */
export function adaptCallbackArity(engine: InferenceEngine, argType: Type, argSlot: Type, argNode: AstNode): void {
    const resolvedArg = engine.subst.apply(argType);
    const resolvedExpected = engine.subst.apply(argSlot);
    if (resolvedArg.tag === 'TFun' && resolvedExpected.tag === 'TFun') {
      const paramList = (p: Type): Type[] => isTuple(p) ? p.args.slice() : [p];
      const actualParams = paramList(resolvedArg.param);
      const expectedParams = paramList(resolvedExpected.param);

      // Arity-tolerant unification for an aligned parameter pair — see
      // `unifyCallbackParamTolerant` (module level).
      const unifyParamPairTolerant = (actual: Type, expected: Type): void =>
        unifyCallbackParamTolerant(engine, actual, expected, argNode);

      // (0) Expected callback is VARIADIC — a tuple containing a `...` spread
      //     (e.g. a node-style wrapper `fromNode :: ((..., (e, a) -> ()) -> *)
      //     -> ...`).  The spread absorbs any number of the actual function's
      //     params; align the fixed params before the spread from the START
      //     and the fixed params after the spread from the END, each with the
      //     arity-tolerant pair unification above.
      const spreadIdx = expectedParams.findIndex(p => isSpread(p));
      if (spreadIdx >= 0 && isTuple(resolvedExpected.param)
          && !actualParams.some(p => isSpread(p))) {
        const before = expectedParams.slice(0, spreadIdx);
        const after = expectedParams.slice(spreadIdx + 1).filter(p => !isSpread(p));
        if (actualParams.length >= before.length
            && actualParams.length >= after.length) {
          for (let j = 0; j < before.length; j++) {
            unifyParamPairTolerant(actualParams[j], before[j]);
          }
          for (let j = 0; j < after.length; j++) {
            unifyParamPairTolerant(
              actualParams[actualParams.length - after.length + j],
              after[j],
            );
          }
          engine.unifyWithDiagnostic(resolvedArg.result, resolvedExpected.result, argNode);
          return;
        }
      }

      // (1) Actual takes FEWER params than the expected multi-arg callback:
      //     JS ignores the extra arguments the caller passes (e.g.
      //     `[1, 2].map(String)` works even though `map` passes
      //     `(element, index, array)`).  Pad the arg to the expected shape so
      //     the slot variable still binds to a full function type.
      if (actualParams.length < expectedParams.length && isTuple(resolvedExpected.param)) {
        for (let j = 0; j < actualParams.length; j++) {
          engine.unifyWithDiagnostic(actualParams[j], expectedParams[j], argNode);
        }
        const paddedType = tFun(tTuple(expectedParams), resolvedArg.result);
        engine.unifyWithDiagnostic(paddedType, argSlot, argNode);
        return;
      }

      // (2) Actual takes MORE params than the expected callback: the surplus
      //     trailing params are simply never supplied at call time, so accept
      //     the function by aligning only the leading params and the results
      //     (e.g. a binary `(a, b) => a` passed where a unary `a -> b` is
      //     expected, or a native `Array#reduce` 4-param callback used where a
      //     2-param `reduce` is required).
      if (actualParams.length > expectedParams.length) {
        for (let j = 0; j < expectedParams.length; j++) {
          engine.unifyWithDiagnostic(actualParams[j], expectedParams[j], argNode);
        }
        engine.unifyWithDiagnostic(resolvedArg.result, resolvedExpected.result, argNode);
        return;
      }
    }
    // (3) An as-yet-unknown function (`[…].map (done)` with `done` an
    //     unannotated parameter) passed to a builtin callback whose trailing
    //     params are optional (`(x, i, xs)`): bind it to the short form
    //     `x -> b`, as almost every such callback is written.  Binding the
    //     full tuple would pin `done` to three parameters.
    if (resolvedArg.tag === 'TVar' && resolvedExpected.tag === 'TFun'
        && isTuple(resolvedExpected.param)
        && resolvedExpected.param.tag === 'TCon'
        && resolvedExpected.param.optionalFrom !== undefined) {
      const n = resolvedExpected.param.optionalFrom;
      const kept = resolvedExpected.param.args.slice(0, n);
      const shortParam = kept.length === 1 ? kept[0] : tTuple(kept);
      engine.unifyWithDiagnostic(argType, tFun(shortParam, resolvedExpected.result), argNode);
      return;
    }
    // Pass the raw argSlot (TVar) so auto-union can trace the chain
    engine.unifyArgWithDiagnostic(argType, argSlot, argNode);
  }

/**
 * Classify a resolved callee + call node into the functional CALL PATTERN it
 * matches, returning the FIRST match in the subsystem's dispatch priority order
 * (or `Regular` when none applies).  This is the single, testable CATALOGUE of
 * the *structural* dispatch decisions that `inferCallExpression` (calls.ts)
 * makes once the callee type has been resolved.
 *
 * NOTE: the engine's hot path keeps its own inline structural checks (kept for
 * clarity and to avoid a second pass over the callee); this classifier MIRRORS
 * that order rather than driving it, and serves as the documented,
 * independently-tested reference for the dispatch shapes.  The state-dependent
 * early paths (curry-wrapper-by-name, spread-arg wildcard, curried-result) are
 * handled by the engine's flow before this classification would apply.
 *
 * Priority (load-bearing — mirrors the historical inline order):
 *   1. VariadicWrapper      — `((a, .., z) -> r) -> (a, .., z) -> r`, 1 arg.
 *   2. ContainerSpreadChain — `f (a->b, .., y->z)` linear pipe/compose chain
 *                             (every element a single-arg arrow), 1 array arg.
 *   3. FanOut               — `f (combiner, a->x1, ..)` multi-arity head, 1 array arg.
 *   4. VariadicItems        — `(a, .., z) -> r` spread tuple applied positionally.
 *   5. SpreadArrayApplier   — `[a, .., z] -> r` applied to 1 array literal.
 *   6. Regular              — the default application path.
 */
export function classifyCallPattern(
  resolvedCallee: Type,
  node: estree.CallExpression,
): CallPatternKind {
  if (resolvedCallee.tag !== 'TFun') return CallPatternKind.Regular;
  const param = resolvedCallee.param;
  const numArgs = node.arguments.length;
  const singleArrayArg =
    numArgs === 1 && node.arguments[0].type === 'ArrayExpression';

  // 1. Spread-function wrapper: `((a, b, ...) -> z) -> (a, b, ...) -> z`.
  if (
    param.tag === 'TFun' &&
    isSpreadTupleOrArray(param.param) &&
    !hasSpreadInArrowChain(resolvedCallee.result) &&
    numArgs === 1
  ) {
    return CallPatternKind.VariadicWrapper;
  }

  if (param.tag === 'TCon') {
    // A container kind-variable applied to one heterogeneous tuple/spread.
    const kvInfo = parseKvName(param.name);
    if (kvInfo && param.args.length === 1 && singleArrayArg) {
      const inner = param.args[0];
      if (
        inner.tag === 'TCon' &&
        (inner.name === T_TUPLE || inner.name === T_SPREAD_ARRAY) &&
        inner.args.some(a => isSpread(a))
      ) {
        // 2. Linear pipe/compose chain — every non-spread element a single-arg
        //    arrow — takes priority over the multi-arity fan-out combiner.
        const nonSpread = inner.args.filter(a => !isSpread(a));
        const allSingleArgArrows =
          nonSpread.length > 0 &&
          nonSpread.every(a => a.tag === 'TFun' && flattenCurriedType(a).params.length === 1);
        if (allSingleArgArrows) return CallPatternKind.ContainerSpreadChain;
      }
    }

    // 3. Fan-out combinator (converge/combine): multi-arity combiner head.
    if (singleArrayArg && matchFanOutCallee(resolvedCallee)) {
      return CallPatternKind.FanOut;
    }

    // 4. Variadic spread tuple applied positionally.
    if (param.name === T_TUPLE && param.args.some(a => isSpread(a))) {
      return CallPatternKind.VariadicItems;
    }

    // 5. Spread-array applier applied to a single array literal.
    if (
      param.name === T_SPREAD_ARRAY &&
      param.args.some(a => isSpread(a)) &&
      singleArrayArg
    ) {
      return CallPatternKind.SpreadArrayApplier;
    }
  }

  return CallPatternKind.Regular;
}



