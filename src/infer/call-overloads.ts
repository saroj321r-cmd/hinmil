// ============================================================================
// Overload-trial machinery for call inference — extracted from calls.ts
//
// Plain language: an *overloaded* function has several alternative
// signatures.  To type a call, the checker tries each signature in turn
// against the actual arguments — in pencil (see `speculate` in helpers.ts),
// so a failed try leaves no trace — and commits to the branch that fits.
// This file contains that trial-and-selection machinery.
// ============================================================================

import type { InferenceEngine } from './index';
import {
  Type,
  tVar,
  tFun,
  tTuple,
  tCon,
  tUnion,
  tUndefined,
  AstNode,
  isSpread,
  prettyTypeToString,
  parseKvName,
  isNumLitName,
  kvName,
  collectVarNames,
  T_TUPLE,
  T_SPREAD_ARRAY,
  T_UNION,
  containsErrorType,
} from '../hm/types';
import { TypeEnv} from '../hm/env';
import { unify} from '../hm/unify';
import {
  mapType,
  someType,
  discriminateRecordArg,
} from '../hm/typeUtils';
import { speculate, tryCommit, bestEffort } from './helpers';
import type * as estree from '../estree';
import { applyMergeReduction } from './call-rows';
import { argumentOutsideParameter } from './unifyDiag';

/**
 * Collect the ids of constraint kind-variables (`$kv:` TCons — e.g. the `f`
 * in `Alt f => f a`) that appear in the resolved types of a call's argument
 * expressions.  The argument expressions are inferred inside a snapshot that
 * is immediately rolled back, so this has no lasting effect on the
 * substitution.  Used to keep concrete overload branches from silently pinning
 * a constraint variable (see {@link tryInferOverloadedCall}).
 */
function collectConstraintKvIds(
  engine: InferenceEngine,
  node: estree.CallExpression,
  env: TypeEnv,
): Set<number> {
  const ids = new Set<number>();
  speculate(engine, () => {
    for (const arg of node.arguments as AstNode[]) {
      let t: Type;
      try {
        t = engine.subst.apply(engine.inferExpression(arg, env));
      } catch {
        continue;
      }
      someType(t, n => {
        if (n.tag === 'TCon') {
          const kv = parseKvName(n.name);
          if (kv) ids.add(kv.varId);
        }
        return false;
      });
    }
  });
  return ids;
}

/**
 * Overload-resolution path for callees whose type resolves to a `Union`
 * of `TFun` branches — the shape produced by repeated `Name :: ...` lines
 * in a `.hm` annotation file.
 *
 * Returns `null` when the callee is NOT an overloaded union (so the regular
 * call-inference code handles it).  Otherwise infers the argument
 * expressions, then tries each branch in declaration order:
 *
 *   • snapshot the substitution
 *   • unify the branch's parameter shape with the actual args
 *   • on success: unify the branch's result with the expected result type
 *     (if any), record the result, and return
 *   • on failure: restore the snapshot and try the next branch
 *
 * If no branch matches, emit a single diagnostic listing every branch's
 * parameter type and return a fresh `TVar`.
 */
export function tryInferOverloadedCall(
  engine: InferenceEngine,
  node: estree.CallExpression,
  env: TypeEnv,
  calleeType: Type,
  expectedResultType?: Type,
): Type | null {
  const resolved = engine.subst.apply(calleeType);
  if (resolved.tag !== 'TCon' || resolved.name !== T_UNION) return null;
  const branches = resolved.args.filter((b): b is Type & { tag: 'TFun' } => b.tag === 'TFun');
  // Need at least 2 callable branches.  Non-TFun branches (e.g. a TCon
  // mixed in for property-access purposes) are silently ignored — they
  // simply can't satisfy a call site.
  if (branches.length < 2) return null;
  // Skip when ANY argument is a spread — let the regular path handle it.
  if (node.arguments.some((a: AstNode) => a.type === 'SpreadElement')) return null;

  // Expand bare polymorphic type aliases inside the branches before
  // unification.  Branches imported from a sidecar (e.g. `Table :: [Selector]
  // -> QueryTag b`) reference aliases by name only — `expandAliases` cannot
  // transform a bare TCon whose args are empty when the alias has free
  // type vars, because it has no scheme-level binders to instantiate
  // against.  Since the branches reaching this point are already
  // `instantiate`d (their TVars are fresh), it is safe to instantiate
  // each bare polymorphic alias with its own fresh TVars here.
  const expandBareAliases = (t: Type): Type =>
    mapType(t, n => {
      if (n.tag !== 'TCon') return undefined;
      if (!engine.typeAliases.has(n.name)) return undefined;
      if (n.args.length !== 0) return undefined;
      const vars = engine.typeAliasVars.get(n.name) ?? [];
      if (vars.length === 0) return undefined; // handled by ordinary expandAliases
      return engine.maybeExpandAlias(n);
    });
  const expandedBranches = branches.map(b => {
    const eb = expandBareAliases(b);
    return eb.tag === 'TFun' ? eb : b;
  });

  const numArgs = node.arguments.length;
  const calleeStart = (node.callee as AstNode).start;

  // Branch ordering by record discrimination.  Ordinary record unification is
  // lenient (it merges differing field names), so the *first* branch whose
  // parameter is any record will swallow a record argument even when a later
  // branch matches it precisely (e.g. `objectOverload :: { nam } -> { nam }`
  // accepting a `Test = { name }` argument meant for the `Test -> Test`
  // branch).  To pick the genuinely-matching overload we infer the arguments
  // once (without committing them), score each branch by how precisely its
  // record parameters match, and try branches in best-first order.  Scores
  // are zero for every non-record overload, so this is a no-op (original
  // order preserved by the stable sort) for the common Number/String/Array
  // discriminations handled by unification.
  let trialOrder = expandedBranches.map((_, i) => i);
  const plainArgTypes: (Type | null)[] = speculate(engine, () => {
    engine.suppressPoisonDepth++;
    try {
      return node.arguments.map(a => {
        try {
          return engine.subst.apply(engine.inferExpression(a as AstNode, env));
        } catch {
          return null;
        }
      });
    } finally {
      engine.suppressPoisonDepth--;
    }
  }) ?? node.arguments.map(() => null);
  {
    const scoreBranch = (branch: Type & { tag: 'TFun' }): number => {
      const params =
        branch.param.tag === 'TCon' && branch.param.name === T_TUPLE
          ? branch.param.args
          : [branch.param];
      let score = 0;
      for (let k = 0; k < numArgs; k++) {
        const at = plainArgTypes[k];
        const pt = params[k];
        if (!at || !pt) continue;
        const verdict = discriminateRecordArg(engine.subst.apply(at), engine.subst.apply(pt));
        if (verdict === 'exact') score += 2;
        else if (verdict === 'reject') score -= 3;
      }
      return score;
    };
    const scores = expandedBranches.map(scoreBranch);
    // Only reorder when there is an actual record-discrimination signal;
    // otherwise leave the original order completely untouched.
    if (scores.some(s => s !== 0)) {
      trialOrder = trialOrder
        .slice()
        .sort((a, b) => scores[b] - scores[a] || a - b);
    }
  }

  const isFnLiteralArg = (k: number): boolean => {
    const t = (node.arguments[k] as { type?: string }).type;
    return t === 'ArrowFunctionExpression' || t === 'FunctionExpression';
  };

  // Per-trial capture of the applied expected type for each function-literal
  // argument, populated by `attemptBranch` just before it returns (while the
  // branch's unifications are still live).  Used by the ambiguous curried-union
  // path below to link a provided callback's parameter nodes to the surviving
  // tails' element variable, so hover resolves them once a later curried
  // application pins the element type.
  let trialArgExpected: (Type | undefined)[] = [];

  // Attempt to apply a single branch to the provided args: push the branch's
  // expected param shapes down into the argument expressions, unify, and
  // return the (possibly still-curried) remainder type on success — or `null`
  // when the branch cannot accept this many args.  Mutates `engine.subst`;
  // callers snapshot/restore around it.  Throws on a genuine unification
  // failure (treated as "branch rejected" by the caller).
  // Direction (as for an ordinary call, see `argumentOutsideParameter`): the
  // symmetric unifier lets a plain `String` fit a literal union and a union
  // argument fit as soon as one member does.  A branch whose parameter the
  // argument does not fit in that direction does not match.
  // `unionArgRejected`: a branch fell out because a UNION argument did not fit
  // in that direction — only then is distributing the union worth a try.
  let unionArgRejected = false;
  const argOutsideBranch = (argType: Type, paramType: Type | undefined): boolean => {
    if (paramType === undefined || argumentOutsideParameter(engine, argType, paramType) === null) return false;
    const a = engine.subst.apply(argType);
    if (a.tag === 'TCon' && a.name === T_UNION) unionArgRejected = true;
    return true;
  };

  const attemptBranch = (branch: Type & { tag: 'TFun' }, fixedArgTypes?: readonly Type[]): Type | null => {
    // Single array-literal argument vs a fixed-arity positional parameter
    // (`[k1,]`, `[k1, k2]`, … — encoded as a SpreadArray TCon): reject the
    // branch when the literal's length cannot satisfy the parameter's arity.
    // Without this guard a length mismatch is only caught later as a spurious
    // arity diagnostic on whichever branch happens to be committed.  The guard
    // lets a single-argument overload set be discriminated by the literal's
    // length alone — e.g. `lensPath(["a", "b"])` selects the `[k1, k2] -> …`
    // branch over the `[k1,]` / `[k1, k2, k3]` branches.
    if (numArgs === 1 && branch.param.tag === 'TCon' && branch.param.name === T_SPREAD_ARRAY) {
      const argNode = node.arguments[0] as { type?: string; elements?: unknown[] };
      if (argNode.type === 'ArrayExpression' && Array.isArray(argNode.elements)) {
        const litLen = argNode.elements.length;
        const spreadIdx = branch.param.args.findIndex(a => isSpread(a));
        if (spreadIdx < 0) {
          // Fixed positional: literal length must match exactly.
          if (litLen !== branch.param.args.length) return null;
        } else {
          // With a rest element: literal must supply at least the fixed slots.
          const minRequired = branch.param.args.length - 1;
          if (litLen < minRequired) return null;
        }
      }
    }
    const branchExpected: (Type | undefined)[] = [];
    // Zero-arg call: `f ()` in JS always INVOKES — it is never a partial
    // application.  Without this, every branch trivially "accepts" zero
    // provided args, and the ambiguous-curried-union path below returns the
    // whole overload union as the call's result (an FP library's `RTask.ask ()`
    // against `() -> RTask r e r | (r -> a) -> RTask r e a` leaked the
    // union into the surrounding `forkWith` argument slot).  Mirror the
    // regular call path's semantics: a nullary branch (`Void`/`Undefined`
    // param) matches outright; any other branch gets implicit `undefined`
    // for every declared parameter and is rejected when that fails.
    if (numArgs === 0) {
      let cur: Type = engine.subst.apply(branch);
      if (cur.tag !== 'TFun') return null;
      const p = engine.subst.apply(cur.param);
      if (p.tag === 'TCon' && (p.name === 'Void' || p.name === 'Undefined')) {
        cur = engine.subst.apply(cur.result);
      } else {
        let walk: Type = cur;
        while (walk.tag === 'TFun') {
          const params = walk.param.tag === 'TCon' && walk.param.name === T_TUPLE
            ? walk.param.args
            : [walk.param];
          for (const prm of params) {
            engine.subst.mergeFrom(unify(engine.subst.apply(prm), tUndefined));
          }
          walk = engine.subst.apply(walk.result);
        }
        cur = walk;
      }
      if (expectedResultType) {
        engine.subst.mergeFrom(unify(engine.subst.apply(cur), engine.subst.apply(expectedResultType)));
      }
      return engine.subst.apply(cur);
    }
    if (branch.param.tag === 'TCon' && branch.param.name === T_TUPLE) {
      for (let k = 0; k < numArgs; k++) branchExpected.push(branch.param.args[k]);
    } else {
      let walk: Type = branch;
      for (let k = 0; k < numArgs; k++) {
        if (walk.tag === 'TFun') { branchExpected.push(walk.param); walk = walk.result; }
        else branchExpected.push(undefined);
      }
    }
    const argTypes: Type[] = [];
    // Pin the branch-result's free vars during argument inference (see
    // `pinnedElementVarIds`): array-literal elements matched against an
    // expanded union must keep sharing vars that thread into the result.
    const prevPinned = engine.pinnedElementVarIds;
    {
      const resultVarNames = new Map<number, string>();
      collectVarNames(engine.subst.apply(branch.result), resultVarNames);
      engine.pinnedElementVarIds = new Set(resultVarNames.keys());
    }
    try {
      for (let k = 0; k < numArgs; k++) {
        const exp = branchExpected[k];
        const fixed = fixedArgTypes?.[k];
        const t = fixed
          ? fixed
          : exp
            ? engine.inferExpressionWithExpected(node.arguments[k], env, exp)
            : engine.inferExpression(node.arguments[k], env);
        argTypes.push(t);
      }
    } finally {
      engine.pinnedElementVarIds = prevPinned;
    }

    // Multi-arg tuple branch: unify the whole tuple with the branch's param.
    if (branch.param.tag === 'TCon' && branch.param.name === T_TUPLE) {
      const actualArgShape: Type = numArgs === 1 ? argTypes[0] : tTuple(argTypes);
      engine.subst.mergeFrom(unify(engine.subst.apply(branch.param), engine.subst.apply(actualArgShape)));
      for (let k = 0; k < numArgs; k++) {
        if (argOutsideBranch(argTypes[k], branch.param.args[k])) return null;
      }
      // Reduce record-spread results (`(a, b) -> { ...a, ...b }`, e.g.
      // `Object.assign`) BEFORE comparing with the expected result: an
      // unreduced `Merge` marker only unifies with plain records, so a branch
      // returning `Merge {} {[k]::a} {[k]::a}` was rejected against
      // `{ [k] :: a }`.  No node: this is a speculative trial.
      engine.subst.mergeFrom(unify(applyMergeReduction(engine, engine.subst.apply(branch.result)), engine.subst.apply(expectedResultType ?? tVar())));
      trialArgExpected = branchExpected.map((exp, k) =>
        exp && isFnLiteralArg(k) ? engine.subst.apply(exp) : undefined);
      return engine.subst.apply(branch.result);
    }

    // Curried / single-arg branch: walk through one application at a time.
    let cur: Type = branch;
    let i = 0;
    while (i < numArgs && cur.tag === 'TFun') {
      engine.subst.mergeFrom(unify(engine.subst.apply(cur.param), engine.subst.apply(argTypes[i])));
      if (argOutsideBranch(argTypes[i], cur.param)) return null;
      cur = engine.subst.apply(cur.result);
      i++;
    }
    if (i !== numArgs) return null; // too many args for this branch
    if (expectedResultType) {
      try {
        engine.subst.mergeFrom(unify(engine.subst.apply(cur), engine.subst.apply(expectedResultType)));
      } catch (e) {
        // Bridge: branch result is a TCon X but a callable is expected — try
        // the constructor's annotated call signatures for X.
        const expR = engine.subst.apply(expectedResultType);
        if (cur.tag === 'TCon' && expR.tag === 'TFun' &&
            !engine.tryConstructorCallable(cur, cur, expectedResultType, expR)) {
          throw e;
        }
      }
      cur = engine.subst.apply(cur);
    }
    trialArgExpected = branchExpected.map((exp, k) =>
      exp && isFnLiteralArg(k) ? engine.subst.apply(exp) : undefined);
    return cur;
  };

  // Phase 1: discover which branches accept the provided args WITHOUT
  // committing.  Greedily committing the first matching branch is wrong for
  // CURRIED overloads whose provided-arg prefix is identical across branches
  // (e.g. `reduce :: (b->a->b) -> b -> [a] -> b` and
  //       `reduce :: (b->a->b) -> b -> { [k] :: a } -> b`): the discriminating
  // argument arrives in a LATER application, so committing now would force the
  // record argument against `[a]`.  Instead we collect every compatible branch
  // and, when more than one survives with a still-curried tail, return their
  // tails as a union so the next application can discriminate.
  // Union-argument distribution.  A partial application of an overloaded
  // function can stay AMBIGUOUS (`merge (lift3 f)` fits both the binary and
  // the ternary `merge` branch — the discriminating Tuple arrives later), so
  // its type is an overload-set union of the surviving tails.  When such a
  // value is itself the argument of an overloaded call (`compose (merge
  // (lift3 f))`), re-inferring it against one parameter shape would commit
  // the inner choice too early.  Instead resolve this call once per
  // argument branch, with the argument's type fixed to that branch, and keep
  // every surviving result as a new overload-set union: the next
  // application discriminates, exactly as for the inner call.
  if (numArgs === 1) {
    const nat = plainArgTypes[0];
    if (nat && nat.tag === 'TCon' && nat.name === T_UNION && nat.overloadSet
        && nat.args.length >= 2 && nat.args.every(b => b.tag === 'TFun')) {
      const results: Type[] = [];
      engine.suppressPoisonDepth++;
      try {
        for (const argBranch of nat.args) {
          for (const branchIndex of trialOrder) {
            const r = speculate(engine, () => {
              const diagsBefore = engine.diagnostics.length;
              const out = attemptBranch(expandedBranches[branchIndex], [argBranch]);
              const newErrors = engine.diagnostics.slice(diagsBefore)
                .some(d => d.severity === undefined || d.severity === 1);
              return newErrors || !out ? null : engine.subst.apply(out);
            }, null);
            if (r && !containsErrorType(r)) { results.push(r); break; }
          }
        }
      } finally {
        engine.suppressPoisonDepth--;
      }
      if (results.length >= 2 && results.every(r => r.tag === 'TFun')) {
        const union = tUnion(results, { overloadSet: true });
        engine.recordNodeType(node, union);
        return union;
      }
    }
  }

  const accepted: { branchIndex: number; remainder: Type; argExpected: (Type | undefined)[] }[] = [];
  engine.suppressPoisonDepth++;
  for (const branchIndex of trialOrder) {
    trialArgExpected = [];
    // A branch whose trial produced an ERROR diagnostic did not really match
    // — e.g. an array-literal argument inferred against the branch's tuple
    // parameter (`[k1, Number]`) with a mismatching element.  Such failures
    // happen inside argument inference, are reported as diagnostics instead
    // of thrown, and would otherwise let the branch count as accepted.
    const remainder = speculate(engine, () => {
      const diagsBefore = engine.diagnostics.length;
      const r = attemptBranch(expandedBranches[branchIndex]);
      const newErrors = engine.diagnostics.slice(diagsBefore)
        .some(d => d.severity === undefined || d.severity === 1);
      return newErrors ? null : r;
    }, null);
    const argExpected = trialArgExpected;
    if (remainder) accepted.push({ branchIndex, remainder, argExpected });
  }
  engine.suppressPoisonDepth--;

  // Union-argument distribution for a plain union (a value that is one of
  // several types).  With the direction check, a union argument only fits a
  // branch when EVERY member does, so `toTask (x)` with `x :: Result | Task
  // Result` against `Task a -> Task a` and `a -> Task a` would fall to the
  // generic branch with `a := Result | Task Result`.  At runtime each member
  // takes the branch that fits it: resolve the call per member, and when the
  // members pick DIFFERENT branches whose results agree, that common result
  // is the call's type.  When every member picks the same branch, or the
  // results disagree, the ordinary trials decide (unchanged).  Only tried
  // when the direction check rejected a branch for the whole union.
  if (numArgs === 1 && unionArgRejected) {
    const nat = plainArgTypes[0];
    if (nat && nat.tag === 'TCon' && nat.name === T_UNION && !nat.overloadSet
        && nat.args.length >= 2 && nat.args.every(m => m.tag !== 'TFun')) {
      const results: Type[] = [];
      const chosen = new Set<number>();
      engine.suppressPoisonDepth++;
      try {
        for (const member of nat.args) {
          for (const branchIndex of trialOrder) {
            const r = speculate(engine, () => {
              const diagsBefore = engine.diagnostics.length;
              const out = attemptBranch(expandedBranches[branchIndex], [member]);
              const newErrors = engine.diagnostics.slice(diagsBefore)
                .some(d => d.severity === undefined || d.severity === 1);
              return newErrors || !out ? null : engine.subst.apply(out);
            }, null);
            if (r && !containsErrorType(r)) { results.push(r); chosen.add(branchIndex); break; }
          }
        }
      } finally {
        engine.suppressPoisonDepth--;
      }
      if (results.length === nat.args.length && chosen.size >= 2) {
        const common = tryCommit(engine, () => {
          for (const r of results.slice(1)) {
            engine.subst.mergeFrom(unify(engine.subst.apply(results[0]), engine.subst.apply(r)));
          }
          if (expectedResultType) {
            engine.subst.mergeFrom(unify(engine.subst.apply(results[0]), engine.subst.apply(expectedResultType)));
          }
          return engine.subst.apply(results[0]);
        });
        if (common) {
          engine.recordNodeType(node, common);
          return common;
        }
      }
    }
  }

  // Literal specificity.  A branch whose parameter is a numeric literal type
  // (`_Tuple :: 2 -> …`) only accepts that very literal, so when it matched
  // it is strictly more specific than a rival that merely accepted a
  // `Number` (`_Tuple :: Number -> Any`, the fallback for an unknown `n`).
  // Keep the branches with the most literal-typed parameters.
  if (accepted.length > 1) {
    const literalParams = (branchIndex: number): number => {
      const b = expandedBranches[branchIndex];
      const params = b.param.tag === 'TCon' && b.param.name === T_TUPLE
        ? b.param.args.slice(0, numArgs)
        : (() => { const ps: Type[] = []; let w: Type = b; for (let k = 0; k < numArgs && w.tag === 'TFun'; k++) { ps.push(w.param); w = w.result; } return ps; })();
      return params.filter(p => p.tag === 'TCon' && p.args.length === 0 && isNumLitName(p.name)).length;
    };
    const scores = accepted.map(a => literalParams(a.branchIndex));
    const best = Math.max(...scores);
    if (best > 0 && scores.some(sc => sc < best)) {
      for (let i = accepted.length - 1; i >= 0; i--) {
        if (scores[i] < best) accepted.splice(i, 1);
      }
    }
  }

  // Poison-absorption filter.  `attemptBranch` captures its remainder via
  // `subst.apply`, so if a branch "accepted" the args only because a nested
  // call's unification failed and `unifyWithDiagnostic` bound the offending
  // free vars to the `$error` sentinel (see `poisonFreeVars`), that sentinel
  // is BAKED into the captured remainder — even though the substitution is
  // rolled back immediately after.  Such a branch did not genuinely match; it
  // merely absorbed the failure.  Drop every `$error`-polluted remainder,
  // provided at least one rival branch matched cleanly.  When EVERY branch is
  // polluted (e.g. an argument was already poisoned upstream) the set is left
  // intact so a real diagnostic still surfaces downstream.
  if (accepted.some(a => !containsErrorType(a.remainder))) {
    for (let i = accepted.length - 1; i >= 0; i--) {
      if (containsErrorType(accepted[i].remainder)) accepted.splice(i, 1);
    }
  }

  // Natural-type structural filter.  A branch can spuriously "accept" a nested
  // overloaded-call argument: pushing the branch's (function-shaped) parameter
  // down into that argument forces the argument's OWN overload resolution to
  // fail, yielding a poison `tVar` that then unifies with anything.  Re-check
  // each accepted branch against the argument's NATURAL type (inferred with no
  // expected type).  When a genuine structural conflict exists between two
  // concrete shapes (e.g. an applied container `f b` vs a function `b -> c`)
  // and at least one rival branch is naturally compatible, drop the
  // conflicting branch — it only "matched" via the poisoned variable.
  if (accepted.length > 1) {
    const branchParams = (branch: Type & { tag: 'TFun' }): (Type | undefined)[] => {
      const params: (Type | undefined)[] = [];
      if (branch.param.tag === 'TCon' && branch.param.name === T_TUPLE) {
        for (let k = 0; k < numArgs; k++) params.push(branch.param.args[k]);
      } else {
        let walk: Type = branch;
        for (let k = 0; k < numArgs; k++) {
          if (walk.tag === 'TFun') { params.push(walk.param); walk = walk.result; }
          else params.push(undefined);
        }
      }
      return params;
    };
    const naturallyCompatible = (branchIndex: number): boolean => {
      const params = branchParams(expandedBranches[branchIndex]);
      for (let k = 0; k < numArgs; k++) {
        const nat = plainArgTypes[k];
        const par = params[k];
        if (!nat || !par) continue;
        const na = engine.subst.apply(nat);
        const pa = engine.subst.apply(par);
        // A bare type variable on either side unifies with anything and must
        // not trigger a rejection — only two concrete shapes can conflict.
        if (na.tag === 'TVar' || pa.tag === 'TVar') continue;
        const ok = speculate(engine, () => { engine.subst.mergeFrom(unify(na, pa)); return true; }, false);
        if (!ok) return false;
      }
      return true;
    };
    const compat = accepted.map(a => naturallyCompatible(a.branchIndex));
    if (compat.some(c => c) && compat.some(c => !c)) {
      for (let i = accepted.length - 1; i >= 0; i--) {
        if (!compat[i]) accepted.splice(i, 1);
      }
    }
  }

  // Constraint-satisfiability filter.  A branch can "accept" the args by mere
  // unification yet pin one of its constraint variables to a type that does
  // NOT satisfy that constraint (e.g. the `Category c => TypeRep c -> c`
  // overload of `id` accepts `id(Function)` by binding `c = Function`, but
  // `Function` is not a `Category`).  Detect such branches by re-running them
  // in isolation and counting freshly-violated pending constraints; drop them
  // when at least one rival branch is constraint-clean.  When every branch
  // violates (a genuine error) the set is left intact so a diagnostic still
  // surfaces downstream.
  // Both filters below (constraint violations, rigid pinning) measure the
  // SAME thing — the state right after `attemptBranch` from the current
  // substitution — so each surviving branch is trialled ONCE and both metrics
  // are read from that single speculation (each trial re-infers every
  // argument, which made these filters the dominant cost of overload
  // resolution).  `uniqueRigid` comes from the real substitution, which the
  // speculative filters never change.
  const uniqueRigid: number[] = [];
  if (accepted.length > 1) {
    const rigidVarIds = engine.pendingConstraints
      .filter(c => c.given)
      .map(c => {
        const r = engine.subst.apply({ tag: 'TVar', id: c.varId, name: '' });
        return r.tag === 'TVar' ? r.id : -1;
      })
      .filter(id => id >= 0);
    uniqueRigid.push(...new Set(rigidVarIds));
  }
  // A rigid functor variable must stay a variable (or another kind
  // variable).  If a branch resolves it to anything concrete — a container
  // constructor (`Array`, `Object`), a function/Reader shape, a record, … —
  // that branch violates parametricity.
  const pinsRigidNow = (): boolean => {
    for (const id of uniqueRigid) {
      const r = engine.subst.apply({ tag: 'TVar', id, name: '' });
      if (r.tag !== 'TVar' && !(r.tag === 'TCon' && parseKvName(r.name))) return true;
    }
    return false;
  };
  const trialMetrics = new Map<number, { violations: number; pins: boolean }>();
  if (accepted.length > 1) {
    for (const a of accepted) {
      let pins = false;
      const violations = speculate(engine, () => {
        attemptBranch(expandedBranches[a.branchIndex]);
        pins = pinsRigidNow();
        const before = engine.diagnostics.length;
        engine.validatePendingConstraints();
        return engine.countViolatedPendingConstraints() + (engine.diagnostics.length - before);
      }, Number.MAX_SAFE_INTEGER);
      trialMetrics.set(a.branchIndex, { violations, pins });
    }
  }

  if (accepted.length > 1) {
    // Counted with the FULL check (method presence AND method shape, e.g. a
    // curried `Foldable#reduce` vs the native `Array#reduce`), so a branch
    // that only unifies structurally does not win just by coming first in
    // declaration order.  Unrelated pending constraints count equally for
    // every branch, hence "fewest violations" rather than "zero".
    const fewest = Math.min(...accepted.map(a => trialMetrics.get(a.branchIndex)!.violations));
    const clean = accepted.filter(a => trialMetrics.get(a.branchIndex)!.violations === fewest);
    if (clean.length > 0 && clean.length < accepted.length) {
      accepted.length = 0;
      accepted.push(...clean);
    }
  }

  // Parametricity filter (must run BEFORE the ambiguous curried-union path
  // below).  A universally-quantified type-class variable introduced by an
  // annotation's `=>` context — e.g. the `f` of
  // `(Applicative f, Setoid (f b)) => TypeRep f -> …` — is RIGID: the body may
  // not instantiate it to a concrete constructor, even one that happens to
  // satisfy the constraint (`Array` is an `Applicative`, yet a `forall f`
  // signature still may not pick `f := Array`).  A concrete-container overload
  // branch (`[a -> b] -> [a] -> [b]`) can nonetheless "accept" an argument
  // whose type is `f (a -> b)` by binding the rigid `f := Array`; if such a
  // branch survives into an ambiguous union, a later application
  // (`ap(of(A)(f))(of(A)(x))`) propagates the concrete slot back and pins the
  // shared rigid functor, producing a spurious `Cannot unify 'Array' with
  // 'f a'`.  Detect this by trialling each branch (against the REAL
  // substitution, so the rigid var ids are the genuine ones) and dropping any
  // branch that leaves a given/rigid constraint variable bound to a concrete
  // constructor — provided at least one rival branch keeps them abstract.  A
  // no-op when there are no given constraints (unannotated code stays
  // permissive) or when every branch pins one (a real error still surfaces).
  let rigidFilterNarrowed = false;
  if (accepted.length > 1 && uniqueRigid.length > 0) {
    const clean = accepted.filter(a => !trialMetrics.get(a.branchIndex)!.pins);
    if (clean.length > 0 && clean.length < accepted.length) {
      accepted.length = 0;
      accepted.push(...clean);
      rigidFilterNarrowed = true;
    }
  }

  // When the parametricity filter above narrowed the set to a single still-
  // curried branch, keep it UNCOMMITTED (return the loose remainder) instead
  // of falling through to the single-branch commit path.  Committing via
  // `attemptBranch` here re-infers the argument against the branch's parameter
  // and mutates the shared substitution, which — for a self-referential
  // argument such as `of(A)(x => x) :: f (a -> a)` — ties the rigid functor's
  // element variable to `a -> a` and yields a spurious infinite type at the
  // next application.  The uncommitted remainder unifies cleanly there, exactly
  // as the multi-branch ambiguous union does.
  if (rigidFilterNarrowed && accepted.length === 1 && accepted[0].remainder.tag === 'TFun') {
    const remainder = accepted[0].remainder;
    engine.recordNodeType(node, remainder);
    return remainder;
  }

  if (accepted.length > 1 && accepted.every(a => a.remainder.tag === 'TFun')) {
    // Still-ambiguous curried overload: keep all compatible tails alive as a
    // union so a later application can pick the right branch.  Do NOT pin
    // `callSiteOverloadIndex` — the call site remains compatible with every
    // surviving overload (hover / signature help surface them all).
    //
    // A provided callback parameter (e.g. `pair` in `map(pair => …)(acc)`) would
    // otherwise hover as a bare type variable: the Phase-1 trials were rolled
    // back, so the param node references a now-unbound trial variable while each
    // surviving tail references ITS OWN (also unbound) element variable.  We
    // reconnect them WITHOUT committing any branch: for every provided function
    // literal, allocate one shared element variable per parameter position and
    // rewrite each surviving tail so that its corresponding element variable IS
    // that shared variable.  Recording the callback param nodes against the same
    // shared variable means a later curried application (which pins the functor
    // element, e.g. `(acc)`) resolves the callback params, while the union tails
    // stay uncommitted so signature-help narrowing is unaffected.
    const remainders = accepted.map(a => a.remainder);
    for (let k = 0; k < numArgs; k++) {
      if (!isFnLiteralArg(k)) continue;
      // If any surviving branch applied a fully-resolved (concrete-parameter)
      // function type to this callback, the callback's element type is already
      // known (e.g. `Pair Number (f a) -> …` once a later `(acc)` pinned the
      // functor).  The callback BODY was only ever inferred under the rolled-
      // back Phase-1 trials, so its parameter usages and body-local bindings
      // (`pair.fst`, `let n = pair.fst`, `let xs = pair.snd`) still reference
      // now-unbound trial variables and hover as bare vars.  Re-infer the whole
      // callback against that concrete function type ONCE so the entire body
      // resolves.  The concrete type carries only OUTER variables (never the
      // union tails' own element variable), so the union built below stays
      // polymorphic and signature-help narrowing is unaffected.
      const concreteFn = accepted
        .map(a => (a.argExpected[k] ? engine.subst.apply(a.argExpected[k]!) : undefined))
        .find(t => t !== undefined && t.tag === 'TFun' && t.param.tag !== 'TVar');
      if (concreteFn) {
        const argNode = node.arguments[k] as AstNode;
        // Drop the callback body's stale node-type recordings first: the
        // Phase-1 trials that produced them were rolled back, so declaration
        // sites (`let n = pair.fst`) still point at now-unbound trial vars that
        // re-inference does not overwrite (a binding is recorded once, at its
        // declarator).  Clearing the span makes the re-inference authoritative.
        for (const off of [...engine.nodeTypes.keys()]) {
          if (off >= argNode.start && off < argNode.end) engine.nodeTypes.delete(off);
        }
        for (const off of [...engine.nodeTypesByEnd.keys()]) {
          if (off > argNode.start && off <= argNode.end) engine.nodeTypesByEnd.delete(off);
        }
        // Re-inference is best-effort; the union return below is unchanged.
        bestEffort(engine, () => {
          engine.inferExpressionWithExpected(argNode, env, concreteFn);
        });
        continue;
      }
      // Otherwise every branch left this callback's parameters as free element
      // vars (e.g. while the enclosing binding is still being generalised).
      // Link each parameter position to ONE shared var (rewriting each
      // surviving tail) so a later curried application — which pins the functor
      // element — resolves it.
      const freeArgNode = node.arguments[k] as AstNode;
      const paramNodes = ((node.arguments[k] as { params?: AstNode[] }).params) ?? [];
      const sharedByPos: Type[] = [];
      for (let j = 0; j < paramNodes.length; j++) {
        const pn = paramNodes[j];
        if ((pn as { type?: string }).type !== 'Identifier') { sharedByPos[j] = tVar(); continue; }
        // Each surviving branch's applied type for this parameter position
        // (walk the curried applied-expected type `j` steps).
        const perBranch: (Type | undefined)[] = accepted.map(a => {
          let walk = a.argExpected[k];
          for (let s = 0; s < j && walk && walk.tag === 'TFun'; s++) walk = walk.result;
          return walk && walk.tag === 'TFun' ? walk.param : undefined;
        });
        // Link every branch's free element var to ONE shared var (rewriting each
        // surviving tail) so a later curried application resolves it.
        const shared = tVar();
        let linked = false;
        perBranch.forEach((t, bi) => {
          if (t && t.tag === 'TVar') {
            const id = t.id;
            remainders[bi] = mapType(remainders[bi], (x) =>
              x.tag === 'TVar' && x.id === id ? shared : undefined);
            linked = true;
          }
        });
        sharedByPos[j] = shared;
        if (linked) engine.recordNodeType(pn as AstNode, shared);
      }
      // The callback BODY (`let n = pair.fst`, `let xs = pair.snd`, `n - 1`, …)
      // was only inferred under the rolled-back Phase-1 trials, so its local
      // bindings still reference now-unbound trial variables and hover as bare
      // vars.  Re-infer the callback against a function type built from the
      // shared parameter vars (RESULT left free) so body-internal constraints
      // resolve those bindings from how they are USED (e.g. `n - 1` ⇒
      // `n :: Number`).  The shared parameter stays a free variable — its field
      // accesses are structurally unconstrained — so the union tails remain
      // polymorphic and signature-help narrowing is unaffected.
      if (sharedByPos.length > 0) {
        let expected: Type = tVar();
        for (let j = sharedByPos.length - 1; j >= 0; j--) {
          expected = tFun(sharedByPos[j] ?? tVar(), expected);
        }
        for (const off of [...engine.nodeTypes.keys()]) {
          if (off >= freeArgNode.start && off < freeArgNode.end) engine.nodeTypes.delete(off);
        }
        for (const off of [...engine.nodeTypesByEnd.keys()]) {
          if (off > freeArgNode.start && off <= freeArgNode.end) engine.nodeTypesByEnd.delete(off);
        }
        // Re-inference is best-effort; the union return below is unchanged.
        bestEffort(engine, () => {
          engine.inferExpressionWithExpected(freeArgNode, env, expected);
        });
      }
    }
    // The surviving tails are still an overload set: keep declaration order
    // so the next application tries them in that order too.
    const aligned = tUnion(remainders, { overloadSet: true });
    engine.recordNodeType(node, aligned);
    return aligned;
  }

  // Constraint-variable preservation.  When an argument's type carries a
  // type-class constraint variable (encoded as a `$kv:` kind-variable TCon —
  // e.g. `f a` under `Alt f =>`), a concrete overload branch such as
  // `Array a -> Array a -> Array a` can still "accept" it by unifying the
  // kind variable with `Array`, silently pinning the polymorphic parameter to
  // a concrete type everywhere.  That is wrong: the constraint-polymorphic
  // branch (`Alt f => f a -> …`) is the genuine match.  Re-order the accepted
  // branches so those that DON'T concretise a constraint variable present in
  // the arguments are committed first.  This is order-independent (it does not
  // rely on the union's branch order) and is a no-op when no argument carries
  // a constraint variable.
  if (accepted.length > 1) {
    const argKvIds = collectConstraintKvIds(engine, node, env);
    if (argKvIds.size > 0) {
      const concretisations = (branch: Type & { tag: 'TFun' }): number =>
        speculate(engine, () => {
          attemptBranch(branch);
          let count = 0;
          for (const id of argKvIds) {
            const bound = engine.subst.apply(tCon(kvName('', id), []));
            // After substitution the kind variable resolves to a concrete
            // (non-kind-variable) constructor when the branch pinned it.
            if (bound.tag === 'TCon' && !parseKvName(bound.name)) count++;
          }
          return count;
        }, Number.MAX_SAFE_INTEGER);
      const score = new Map<number, number>();
      for (const a of accepted) score.set(a.branchIndex, concretisations(expandedBranches[a.branchIndex]));
      accepted.sort((x, y) => (score.get(x.branchIndex)! - score.get(y.branchIndex)!));
    }
  }

  if (accepted.length >= 1) {
    // A single compatible branch (or several whose tail is already a final,
    // fully-applied value): commit the best one (trialOrder is best-first).
    const branchIndex = accepted[0].branchIndex;
    const committed = tryCommit(engine, () => {
      const remainder = attemptBranch(expandedBranches[branchIndex]);
      const result = applyMergeReduction(engine, engine.subst.apply(remainder ?? tVar()), node);
      engine.recordNodeType(node, result);
      // Only pin the matched overload index for a DIRECT application of the
      // named/member binding (`f(args)` / `obj.m(args)`).  For a chained
      // curried sub-application (`f(a)(b)` — callee is itself a CallExpression)
      // the union being resolved is a transient remainder union whose branch
      // order does NOT correspond to the original overload list, and every
      // sub-application shares the same callee start offset, so pinning here
      // would overwrite the call site with a meaningless index.  Leaving it
      // unset lets hover / signature help surface all compatible overloads.
      if ((node.callee as AstNode).type !== 'CallExpression') {
        engine.callSiteOverloadIndex.set(calleeStart, branchIndex);
      }
      return result;
    });
    if (committed) return committed;
  }

  // No branch matched.  When the caller supplied an expected RESULT type,
  // check whether the arguments alone select a branch: then the arguments
  // are fine and the result is what conflicts — say that, instead of the
  // misleading "No overload matches arguments" (e.g. `fs.readFileSync (p,
  // "utf-8")` inside a function annotated to return a Number).
  if (expectedResultType) {
    const expectedForMessage = expectedResultType;
    expectedResultType = undefined;
    let argOnly: Type | null = null;
    engine.suppressPoisonDepth++;
    try {
      for (const branchIndex of trialOrder) {
        trialArgExpected = [];
        const remainder = speculate(engine, () => {
          const r = attemptBranch(expandedBranches[branchIndex]);
          return r ? applyMergeReduction(engine, engine.subst.apply(r)) : null;
        }, null);
        if (remainder) { argOnly = remainder; break; }
      }
    } finally {
      engine.suppressPoisonDepth--;
      expectedResultType = expectedForMessage;
    }
    if (argOnly) {
      engine.addDiag(
        `Type mismatch: Cannot unify '${prettyTypeToString(argOnly)}' with '${prettyTypeToString(engine.subst.apply(expectedForMessage))}'`,
        node,
      );
      return tVar();
    }
  }

  // No branch matched — emit a single descriptive diagnostic.
  // Re-infer argTypes once more in raw form for the message.
  const rawArgTypes: Type[] = node.arguments.map(a => engine.inferExpression(a, env));
  const sigs = branches.map(b => prettyTypeToString(b)).join('\n  ');
  const argList = rawArgTypes.map(t => prettyTypeToString(engine.subst.apply(t))).join(', ');
  engine.addDiag(
    `No overload matches arguments (${argList}). Available signatures:\n  ${sigs}`,
    node,
  );
  return tVar();
}
