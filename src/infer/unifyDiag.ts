// ============================================================================
// Unification with diagnostics — error reporting, recovery and bridging
//
// Plain language: the raw puzzle solver (unify.ts) just says "doesn't fit".
// This wrapper turns that into a helpful, human-readable error at the right
// source location — and then *recovers* so one mistake doesn't set off a
// chain of follow-up errors (the offending placeholders are poisoned with a
// silent `$error` marker that suppresses further complaints).
//
// Extracted from the InferenceEngine class.  These functions implement the
// diagnostic-producing unification path: pretty error messages, alias-expand
// retry, infinite-type reporting, auto-union bridging, constructor-callable
// bridging and `$error` poisoning for cascade suppression.
// ============================================================================

import type { InferenceEngine } from './index';
import type * as estree from '../estree';
import {
  Type,
  Scheme,
  tCon,
  typeToString,
  prettyTypeToStringPair,
  AstNode,
  containsErrorType,
  flattenCurriedType,
  T_ERROR,
  T_UNION,
  tUndefined,
  isAnyType,
  isErrorType,
  isWildcard,
  isSkolem,
  prettyTypeToString,
  structuralEquals,
} from '../hm/types';
import { freeTypeVarsInType, instantiate } from '../hm/env';
import { unify, UnificationError, OccursCheckError } from '../hm/unify';
import {
  isUnionable,
  mergeUnion,
  mergeSameConstructor,
  mapType,
  findHostSlots,
  findOverloadSlots,
  substTVar,
  hasTopLevelSpreadChain,
} from '../hm/typeUtils';
import { narrowToIdentifier } from './annotations';
import { typeAcceptsUndefined } from './narrowing';

export function unifyWithDiagnostic(engine: InferenceEngine, t1: Type, t2: Type, node: AstNode): void {
  try {
    const s = unify(engine.resolve(t1), engine.resolve(t2));
    engine.subst.mergeFrom(s);
  } catch (e) {
    if (!(e instanceof UnificationError)) throw e;

    // Retry once with both sides expanded through `maybeExpandAlias`.
    // This catches cases where one side is a zero-arg TCon alias for
    // a TRecord (e.g. `GameRow :: { id :: Number, name :: String }`)
    // and the other side is a TRecord literal.  Without this fallback,
    // `insert({ id: 1, name: "x" })` against `insert :: GameRow -> ...`
    // would wrongly diagnose a TCon-vs-TRecord mismatch.  Aliases are
    // intentionally NOT eagerly expanded everywhere — many call paths
    // need to keep the alias name visible — so we only expand here on
    // the failure path.
    const e1 = engine.maybeExpandAlias(engine.resolve(t1));
    const e2 = engine.maybeExpandAlias(engine.resolve(t2));
    if (e1 !== engine.resolve(t1) || e2 !== engine.resolve(t2)) {
      try {
        const s = unify(e1, e2);
        engine.subst.mergeFrom(s);
        return;
      } catch (e2err) {
        if (!(e2err instanceof UnificationError)) throw e2err;
        // fall through to normal diagnostic path
      }
    }

    // Suppress "Infinite type" during annotated constrained self-recursion
    if (engine.suppressInfiniteType && e.message.startsWith('Infinite type:')) {
      engine.infiniteTypeSuppressedDuringAnnotation = true;
      return;
    }

    // Fold-completion leniency: a TOP-LEVEL spread arrow chain
    // (`a -> b -> ... -> z`) reconciled against a NON-function type stands for
    // "the chain once fully applied" — a variadic chain only arises from an
    // explicit `...` annotation, and the heterogeneous fold that produced it
    // consumes all of its parameters at runtime.  E.g. FP-library `combine`:
    // `reduce (reducer) (liftN (n - 1) (hd)) (tl)` yields the accumulator
    // CHAIN, while the annotated return is the terminal `m z`.  Retry with
    // the chain's terminal result before surfacing a mismatch.
    {
      const rr1 = engine.resolve(t1);
      const rr2 = engine.resolve(t2);
      const pair =
        rr1.tag === 'TFun' && hasTopLevelSpreadChain(rr1) && rr2.tag === 'TCon' ? [rr1, rr2] :
        rr2.tag === 'TFun' && hasTopLevelSpreadChain(rr2) && rr1.tag === 'TCon' ? [rr2, rr1] :
        null;
      if (pair) {
        try {
          const s = unify(flattenCurriedType(pair[0]).result, pair[1]);
          engine.subst.mergeFrom(s);
          return;
        } catch (e3) {
          if (!(e3 instanceof UnificationError)) throw e3;
          // fall through to normal diagnostic path
        }
      }
    }

    // Infinite type (occurs-check): emit a clear, actionable diagnostic
    // attributed to the enclosing binding.  A binding SIGNATURE overrules
    // this — the post-pass in server.ts drops HM_INFINITE_TYPE diagnostics
    // located inside an annotated binding extent.
    if (e instanceof OccursCheckError || e.message.startsWith('Infinite type:')) {
      engine.occursCheckCount++;
      const subject = engine.currentBindingName ?? 'Value';
      let detail = '';
      if (e instanceof OccursCheckError) {
        const [occStr, varStr] = prettyTypeToStringPair(e.occursInType, e.tvType);
        detail = ` (${varStr} occurs in ${occStr})`;
      }
      engine.addDiag(`${subject} has an infinite type${detail}. Add a type signature.`, narrowToIdentifier(node));
      poisonFreeVars(engine, engine.resolve(t1), engine.resolve(t2));
      return;
    }

    // Suppress unification errors involving `$error` — these come from
    // property accesses on types where the property doesn't exist OR
    // from a previous failed unification whose free TVars were poisoned
    // (see `poisonFreeVars` below).  A specific diagnostic has already
    // been emitted at the originating site; surfacing further mismatches
    // that mention `$error` would only add noise.  Check the FULL type
    // (not just the outermost tag) so cases like `Prop $error -> ...`
    // are also suppressed.
    const r1 = engine.resolve(t1);
    const r2 = engine.resolve(t2);
    if (containsErrorType(r1) || containsErrorType(r2)) return;
    if (tryAutoUnion(engine, t1, r1, t2, r2)) return;
    if (tryConstructorCallable(engine, t1, r1, t2, r2)) return;

    // Pretty-print the types so internal variable IDs (t429, t430)
    // are replaced with readable letters (a, b, c, ...).
    const [pretty1, pretty2] = prettyTypeToStringPair(e.left, e.right);
    // When unify produced a specialised arity-mismatch message, surface it
    // verbatim so it gets classified as HM_TYPE_ARITY_MISMATCH (2008)
    // instead of the generic HM_TYPE_MISMATCH (1001).
    if (e.message.startsWith("Type constructor '") && e.message.includes('applied to')) {
      const ctorName = e.left.tag === 'TCon' ? e.left.name : '?';
      const got = e.left.tag === 'TCon' ? e.left.args.length : 0;
      const exp = e.right.tag === 'TCon' ? e.right.args.length : 0;
      engine.addDiag(
        `Type constructor '${ctorName}' expects ${exp} type argument${exp === 1 ? '' : 's'} but got ${got}`,
        narrowToIdentifier(node),
      );
      return;
    }
    // When unify produced a specialised "is not a valid relation here"
    // message (Picked-union mismatch), surface it verbatim instead of
    // dumping the entire union.
    if (/ is not a valid relation here\b/.test(e.message)) {
      engine.addDiag(e.message, narrowToIdentifier(node));
      return;
    }
    engine.addDiag(`Type mismatch: Cannot unify '${pretty1}' with '${pretty2}'`, narrowToIdentifier(node));

    // Error recovery: poison free type variables involved in the failed
    // unification by binding them to the `$error` sentinel.  Subsequent
    // unifications that touch these variables are silently absorbed by the
    // `isErrorType` check above (and at other unify sites), preventing one
    // root-cause mismatch from cascading into multiple noisy diagnostics.
    poisonFreeVars(engine, r1, r2);
  }
}

/** Directional variant of `unifyWithDiagnostic` for the call-argument
 *  position.  Adds a pre-check that surfaces missing required fields on
 *  a closed-record parameter — the standard `unify` is symmetric and
 *  historically lenient for closed-vs-closed records, so passing an
 *  empty `{}` against a parameter type `{ @@type :: String }` would
 *  otherwise silently succeed.  Surplus fields on the argument side
 *  remain accepted (width subtyping).  Falls through to the normal
 *  unification when no missing fields are detected. */
export function unifyArgWithDiagnostic(engine: InferenceEngine, argType: Type, paramType: Type, node: AstNode): void {
  const excess = findExcessRecordFields(engine, node, paramType);
  if (excess) engine.addDiag(excess, node);
  const missing = findMissingRecordFields(engine, argType, paramType);
  if (missing) {
    engine.addDiag(missing, node);
    // Still run the normal unify so downstream inference sees the binding
    // — but the diagnostic above is the user-facing message.
  }
  const before = engine.diagnostics.length;
  unifyWithDiagnostic(engine, argType, paramType, node);
  if (engine.diagnostics.length === before) {
    const outside = argumentOutsideParameter(engine, argType, paramType);
    if (outside) engine.addDiag(outside, narrowToIdentifier(node));
    else checkObjectLiteralFields(engine, node, argType, paramType);
  }
}

/**
 * The fields of an object-literal argument (also the props of a JSX
 * element) in the same direction as an argument: `<Text intent={level} />`
 * with `level :: String` does not fit `intent :: Intent | Undefined`.  The
 * field types come from the inferred record of the argument (the type
 * recorded at a value's start offset can belong to a sub-expression, such
 * as `best` in `best == null ? null : best.loss`).
 */
function checkObjectLiteralFields(engine: InferenceEngine, node: AstNode, argType: Type, paramType: Type): void {
  if (node.type !== 'ObjectExpression') return;
  const param = engine.maybeExpandAlias(engine.resolve(paramType));
  const arg = engine.maybeExpandAlias(engine.resolve(argType));
  if (param.tag !== 'TRecord' || arg.tag !== 'TRecord') return;
  for (const prop of (node as unknown as estree.ObjectExpression).properties) {
    if (prop.type !== 'Property' || prop.computed) continue;
    const key = prop.key as AstNode;
    const name = key.type === 'Identifier'
      ? (key as unknown as estree.Identifier).name
      : key.type === 'Literal' ? String((key as unknown as estree.Literal).value) : null;
    if (name === null || !(name in param.fields) || !(name in arg.fields)) continue;
    const outside = argumentOutsideParameter(engine, arg.fields[name], param.fields[name]);
    if (outside) engine.addDiag(outside.replace('Type mismatch:', `Type mismatch in field '${name}':`), prop.value as AstNode);
  }
}

/** The members of a type: the members of a (nested) union, or the type. */
function membersOf(engine: InferenceEngine, t: Type): Type[] {
  const out: Type[] = [];
  const collect = (u: Type, depth: number): void => {
    const r = engine.maybeExpandAlias(engine.resolve(u));
    if (depth < 6 && r.tag === 'TCon' && r.name === T_UNION) {
      for (const a of r.args) collect(a, depth + 1);
    } else {
      out.push(r);
    }
  };
  collect(t, 0);
  return out;
}

/** Is this member open (a type variable or a rigid one, a label variable,
 *  `Any`, the error sentinel)? */
function isOpenMember(t: Type): boolean {
  return t.tag === 'TVar' || isSkolem(t) || (t.tag === 'TLabel' && t.kind !== 'lit')
    || isAnyType(t) || isErrorType(t) || isWildcard(t);
}

/** A union that describes ONE value with several faces rather than a choice:
 *  an overload set, or a value that is both callable and a record/table
 *  (`Table Row | ([Selector] -> QueryTag Row)`). */
function isFacetUnion(engine: InferenceEngine, t: Type): boolean {
  const r = engine.resolve(t);
  if (r.tag !== 'TCon' || r.name !== T_UNION) return false;
  if (r.overloadSet) return true;
  return r.args.some(a => engine.resolve(a).tag === 'TFun');
}

/**
 * Direction for a call argument: every member of the argument must fit a
 * member of the parameter.  The symmetric unifier accepts a union argument
 * as soon as ONE member fits (`Number | Null` for `Number`, `Number | Null
 * | Undefined` for `Number | Undefined`), and a plain `String` where a
 * literal union is expected (`intent :: "none" | "danger"`), because a
 * label and a string are interchangeable to it.  Returns the diagnostic, or
 * null when the argument fits.
 */
export function argumentOutsideParameter(engine: InferenceEngine, argType: Type, paramType: Type): string | null {
  if (isFacetUnion(engine, argType)) return null;
  // A list against a list: the same check on the elements
  // (`Foo ([k])` with `k :: String` for `['id' | 'name']`).
  const argList = engine.maybeExpandAlias(engine.resolve(argType));
  const paramList = engine.maybeExpandAlias(engine.resolve(paramType));
  if (argList.tag === 'TCon' && argList.name === 'Array' && argList.args.length === 1
      && paramList.tag === 'TCon' && paramList.name === 'Array' && paramList.args.length === 1) {
    return argumentOutsideParameter(engine, argList.args[0], paramList.args[0]);
  }
  // Fast path for the common call: an argument that is not a union only
  // matters against a parameter that can hold a literal (a union, a label,
  // or an alias of one); a record, function, list or primitive cannot.
  const rawArg = engine.resolve(argType);
  const rawParam = engine.resolve(paramType);
  const argMayBeUnion = (rawArg.tag === 'TCon' && rawArg.name === T_UNION)
    || (rawArg.tag === 'TCon' && rawArg.args.length === 0 && engine.typeAliases.has(rawArg.name));
  const paramMayHoldLiteral = rawParam.tag === 'TLabel'
    || (rawParam.tag === 'TCon' && (rawParam.name === T_UNION || engine.typeAliases.has(rawParam.name)));
  if (!argMayBeUnion && !paramMayHoldLiteral) return null;
  const params = membersOf(engine, paramType);
  if (params.some(isOpenMember)) return null;
  const args = membersOf(engine, argType);
  // Only a union argument or a literal parameter: otherwise the unifier
  // above is authoritative (and knows bindings a trial unify would miss,
  // such as a higher-kinded `m`).
  const literalParam = params.some(p => p.tag === 'TLabel' && p.kind === 'lit');
  if (args.length < 2 && !literalParam) return null;
  // A literal parameter (`"danger"`) takes only that literal (or a label
  // variable, or a `const` bound to it), not any string.
  const fitsLiteral = (arg: Type, value: string): boolean => {
    if (arg.tag === 'TCon' && arg.stringLiteral !== undefined) return arg.stringLiteral === value;
    return arg.tag === 'TLabel' && (arg.kind !== 'lit' || arg.value === value);
  };
  const literalValues: string[] = [];
  for (const p of params) if (p.tag === 'TLabel' && p.kind === 'lit') literalValues.push(p.value);
  const unifies = (arg: Type, param: Type): boolean => {
    try {
      unify(arg, param);
      return true;
    } catch {
      return false;
    }
  };
  // Cheap first: a bare type (`Null`, `Number`, `Date`) by name, a compound
  // one against the parameter members of the same shape (record against
  // record, the same constructor); only without such a member every one.
  const sameShape = (arg: Type, param: Type): boolean =>
    arg.tag === param.tag && (arg.tag !== 'TCon' || (param as typeof arg).name === arg.name);
  const fits = (arg: Type): boolean => {
    if (isOpenMember(arg)) return true;
    if (literalValues.some(v => fitsLiteral(arg, v))) return true;
    const others = params.filter(p => !(p.tag === 'TLabel' && p.kind === 'lit'));
    if (arg.tag === 'TCon' && arg.args.length === 0
        && others.some(p => p.tag === 'TCon' && p.name === arg.name && p.args.length === 0)) {
      return true;
    }
    const shaped = others.filter(p => sameShape(arg, p));
    if (shaped.some(p => structuralEquals(arg, p))) return true;
    if (shaped.length > 0 && shaped.some(p => unifies(arg, p))) return true;
    const rest = others.filter(p => !sameShape(arg, p));
    return rest.some(p => unifies(arg, p));
  };
  const stray = args.filter(a => !fits(a));
  if (stray.length === 0) return null;
  const shown = (ts: Type[]): string => ts.length === 1 ? prettyTypeToString(ts[0]) : prettyTypeToString(tCon(T_UNION, ts));
  return `Type mismatch: Cannot unify '${shown(args)}' with '${shown(params)}' ('${shown(stray)}' does not fit)`;
}

/**
 * Excess-property check (as in TypeScript, for "fresh" literals only): an
 * object LITERAL passed where a NAMED closed record (a type alias) is
 * expected may not have fields that record does not declare.  Catches typos in optional fields —
 * `{ form: d, to: d }` for `{ from :: Date | Undefined, to :: Date }` is
 * otherwise accepted and `from` silently missing.  Open records (`{ …,
 * ...r }`), dictionaries, literals with a spread and computed keys are not
 * checked.
 */
function findExcessRecordFields(engine: InferenceEngine, node: AstNode, paramType: Type): string | null {
  if (node.type !== 'ObjectExpression') return null;
  const literal = node as unknown as estree.ObjectExpression;
  const keys: string[] = [];
  for (const prop of literal.properties) {
    if (prop.type !== 'Property' || prop.computed) return null;
    const key = prop.key as AstNode;
    if (key.type === 'Identifier') keys.push((key as unknown as estree.Identifier).name);
    else if (key.type === 'Literal' && typeof (key as unknown as estree.Literal).value === 'string') keys.push(String((key as unknown as estree.Literal).value));
    else return null;
  }
  if (keys.length === 0) return null;
  let records = [engine.resolve(paramType)];
  const first = records[0];
  if (first.tag === 'TCon' && first.name === T_UNION) {
    records = first.args.map(a => engine.resolve(a)).filter(a => !(a.tag === 'TCon' && a.name === tUndefined.name));
  }
  if (records.length !== 1) return null;
  const named = records[0];
  const rec = engine.maybeExpandAlias(named);
  if (rec.tag !== 'TRecord' || rec.rest || (rec.labelFields && rec.labelFields.length > 0)) return null;
  // Only NAMED record types (`RangeParams :: { … }`) are exact: a record
  // inferred from destructuring (`({ x }) => x`) or an inline annotation
  // keeps JavaScript's lenience for extra fields.
  const isNamed = (named.tag === 'TCon' && named.name !== T_UNION) || !!rec.alias;
  if (!isNamed) return null;
  const known = Object.keys(rec.fields);
  if (known.length === 0) return null;
  const unknown = keys.filter(k => !(k in rec.fields));
  if (unknown.length === 0) return null;
  const hint = unknown.length === 1 ? closestName(unknown[0], known.filter(k => !keys.includes(k))) : null;
  const names = unknown.map(k => `'${k}'`).join(', ');
  return `Unknown field${unknown.length > 1 ? 's' : ''} ${names} on argument; expected '${typeToString(rec)}'${hint ? ` (did you mean '${hint}'?)` : ''}`;
}

/** The candidate within edit distance 2 of `name` (closest first), or null. */
function closestName(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDist = 3;
  for (const c of candidates) {
    const d = editDistance(name, c);
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return best;
}

/** Levenshtein distance with adjacent transpositions (`form` ↔ `from`). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Return a diagnostic message describing fields required by the
 *  parameter's closed record type that are absent from the argument's
 *  closed record type, or `null` if every required field is present. */
function findMissingRecordFields(engine: InferenceEngine, argType: Type, paramType: Type): string | null {
  const stripOptional = (t: Type): Type[] => {
    const r = engine.resolve(t);
    if (r.tag === 'TCon' && r.name === T_UNION) {
      return r.args
        .map(a => engine.resolve(a))
        .filter(a => !(a.tag === 'TCon' && a.name === tUndefined.name));
    }
    return [r];
  };
  const paramCands = stripOptional(paramType);
  const argCands = stripOptional(argType);
  for (const p of paramCands) {
    const pExp = engine.maybeExpandAlias(p);
    if (pExp.tag !== 'TRecord' || pExp.rest) continue;
    // Find at least one arg-side record that satisfies the param shape;
    // if every arg-side record is missing required fields, report the
    // gap against the first such candidate.
    let firstMissing: { fields: string[]; param: Type } | null = null;
    let anySatisfies = false;
    for (const a of argCands) {
      const aExp = engine.maybeExpandAlias(a);
      if (aExp.tag !== 'TRecord' || aExp.rest) {
        // Non-record arg candidate (e.g. TVar, TCon) — can't validate, skip.
        anySatisfies = true;
        break;
      }
      // A field is "missing" only when the argument lacks it AND the
      // parameter's declared type for that field does NOT admit Undefined.
      // A field typed as `T | Undefined` (or just `Undefined`) is implicitly
      // optional — omitting it on the argument is equivalent to `undefined`.
      const missing = Object.keys(pExp.fields).filter(k => {
        if (k in aExp.fields) return false;
        return !typeAcceptsUndefined(engine.subst, pExp.fields[k]);
      });
      if (missing.length === 0) { anySatisfies = true; break; }
      if (!firstMissing) firstMissing = { fields: missing, param: pExp };
    }
    if (!anySatisfies && firstMissing) {
      const fields = firstMissing.fields.map(k => `'${k}'`).join(', ');
      return `Missing required field${firstMissing.fields.length > 1 ? 's' : ''} ${fields} on argument; expected '${typeToString(firstMissing.param)}'`;
    }
  }
  return null;
}

/** Bind every free TVar reachable from the given types to the `$error`
 *  sentinel.  Used to recover from a failed unification so downstream
 *  inference can continue without producing cascading noise. */
export function poisonFreeVars(engine: InferenceEngine, ...types: Type[]): void {
  if (engine.suppressPoisonDepth > 0) return;
  const errorType = tCon(T_ERROR, []);
  const seen = new Set<number>();
  for (const t of types) {
    for (const id of freeTypeVarsInType(t)) {
      if (seen.has(id)) continue;
      seen.add(id);
      engine.subst.set(id, errorType);
    }
  }
}

/**
 * Try to automatically create a union type when unification of two
 * concrete types fails.  Returns true if a union was created.
 */
export function tryAutoUnion(engine: InferenceEngine, t1: Type, r1: Type, t2: Type, r2: Type): boolean {
  if (engine.suppressAutoUnion) return false;
  if (isUnionable(r1) && isUnionable(r2)) {
    // Build the union from both sides
    const union = mergeUnion(r1, r2);
    // Find a TVar in the substitution chain from t1 or t2
    const rootId = findRootTVarId(engine, t1) ?? findRootTVarId(engine, t2);
    if (rootId === null) return false;
    engine.subst.set(rootId, union);
    return true;
  }
  // Same-name parameterized types: union the differing args.
  // e.g. Either String Number + Either String String → Either String (Number | String)
  if (r1.tag === 'TCon' && r2.tag === 'TCon' &&
      r1.name === r2.name && r1.args.length === r2.args.length && r1.args.length > 0) {
    const unionArgs: Type[] = [];
    for (let i = 0; i < r1.args.length; i++) {
      try {
        const s = unify(r1.args[i], r2.args[i]);
        engine.subst.mergeFrom(s);
        unionArgs.push(s.apply(r1.args[i]));
      } catch {
        // Differing args: try unionable merge or recursive same-constructor merge
        if (isUnionable(r1.args[i]) && isUnionable(r2.args[i])) {
          unionArgs.push(mergeUnion(r1.args[i], r2.args[i]));
        } else {
          const nested = mergeSameConstructor(r1.args[i], r2.args[i]);
          if (!nested) return false;
          unionArgs.push(nested);
        }
      }
    }
    const merged = tCon(r1.name, unionArgs);
    const rootId = findRootTVarId(engine, t1) ?? findRootTVarId(engine, t2);
    if (rootId === null) return false;
    engine.subst.set(rootId, merged);
    return true;
  }
  return false;
}

/**
 * Try to bridge a TCon ↔ TFun mismatch using the TCon name's constructor
 * annotations.  When a value of type `QueryTag b` is required to be a
 * function (e.g. it's passed to `one(t => t(p).map(...))`), check the
 * annotation map for `QueryTag :: a -> Promise [b]` and instantiate that
 * signature into the TVar slot, so the constructor's call-overloads
 * become usable as the value's type at this site.
 */
export function tryConstructorCallable(engine: InferenceEngine, t1: Type, r1: Type, t2: Type, r2: Type): boolean {
  const tryOne = (tcon: Type, fn: Type, hostT: Type): boolean => {
    if (tcon.tag !== 'TCon' || fn.tag !== 'TFun') return false;
    // Only `Name() :: T` (instance-callable) annotations can describe
    // how a value of an uppercase TCon is invoked.  The constructor
    // scheme `Name :: ...` describes how to construct a `Name`, never
    // how to call one — so it is intentionally NOT consulted here as
    // a callable signature for an instance.
    const localCallables = engine.instanceCallables.get(tcon.name);
    if (!localCallables || localCallables.length === 0) return false;
    const candidates: Type[] =
      localCallables.map((s: Scheme) => instantiate(s)).filter((t: Type) => t.tag === 'TFun');
    // Expand bare polymorphic type aliases (e.g. `[Selector]` →
    // `[String | Prop a' | …]` with fresh TVars) inside each candidate.
    // The scheme came from an imported sidecar that was parsed before
    // the consumer's alias map existed, so bare uppercase references
    // need lazy instantiation here.
    const expandBareAliases = (t: Type): Type =>
      mapType(t, n => {
        if (n.tag !== 'TCon') return undefined;
        if (!engine.typeAliases.has(n.name)) return undefined;
        if (n.args.length !== 0) return undefined;
        const vars = engine.typeAliasVars.get(n.name) ?? [];
        if (vars.length === 0) return undefined;
        return engine.maybeExpandAlias(n);
      });
    const expandedCandidates = candidates.map(c => {
      const ec = expandBareAliases(c);
      return ec.tag === 'TFun' ? ec : c;
    });
    // When the host TCon (the value being called) carries a row arg —
    // e.g. `QueryTag {projected}` from a Picked projection — specialise
    // the carrier TVar of each candidate's result with that row.  This
    // turns `a -> RTask r e [b]` into `a -> RTask r e [{projected}]`,
    // so the call's actual result type, signature help, and chained
    // method completions all see the projected row instead of a bare
    // type variable.  When the host also carries a parameter arg (the
    // `p` in `QueryTag p row`), substitute that into the candidate's
    // parameter slot so e.g. `p -> RTask r e [{projected}]` is what
    // unification sees.
    const slots = findHostSlots(tcon);
    // Display-only fallback: a host without a parameter slot in its
    // declared arity may still carry a `paramHint` attached during
    // call-site post-processing (see `bindParamSlot` in
    // `src/infer/calls.ts`).
    const paramArg = slots.paramArg ?? tcon.paramHint ?? null;
    const specialisedCandidates = expandedCandidates.map(cand => {
      if (cand.tag !== 'TFun') return cand;
      let out: Type = cand;
      const { paramTVarId, carrierTVarId } = findOverloadSlots(out);
      if (slots.rowArg && carrierTVarId !== null) {
        out = substTVar(out, carrierTVarId, slots.rowArg);
      }
      if (paramArg && paramTVarId !== null) {
        out = substTVar(out, paramTVarId, paramArg);
      }
      return out;
    });
    for (const cand of specialisedCandidates) {
      try {
        const s = unify(cand, fn);
        // Bind the TCon-side TVar (if any in the chain) to the instantiated callable.
        const rootId = findRootTVarId(engine, hostT);
        if (rootId !== null) engine.subst.set(rootId, cand);
        engine.subst.mergeFrom(s);
        return true;
      } catch { /* try next */ }
    }
    return false;
  };
  return tryOne(r1, r2, t1) || tryOne(r2, r1, t2);
}

/**
 * Follow a type through the substitution chain to find the deepest TVar
 * that is bound to a concrete type.  Returns that TVar's id, or null.
 */
export function findRootTVarId(engine: InferenceEngine, t: Type): number | null {
  if (t.tag !== 'TVar') return null;
  const bound = engine.subst.lookup(t.id);
  if (!bound) return null; // unbound TVar — no concrete binding
  if (bound.tag === 'TVar') {
    // Chain continues — follow it
    const deeper = findRootTVarId(engine, bound);
    return deeper ?? t.id;
  }
  // bound to a concrete type — this TVar is the root
  return t.id;
}
