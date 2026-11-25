// ============================================================================
// Unification — the heart of Hindley-Milner
//
// WHAT THIS FILE DOES (in plain language)
// ---------------------------------------------------------------------------
// *Unification* answers one question, over and over: "can these two type
// descriptions be made identical, and if so, what must each placeholder
// stand for?"  It is like fitting two puzzle pieces together:
//
//   • unify `Array a` with `Array Number`  → yes, and we learn a = Number
//   • unify `Number` with `String`         → no → a type error is reported
//
// The answers ("a = Number") are collected in a Substitution (see
// substitution.ts).  The main entry point is `unify(t1, t2)`; internally
// `unifyCore` works through a long ladder of cases, roughly ordered from
// "most flexible" to "most specific":
//
//   1. wildcards / Any            — match anything, ask no questions
//   2. unions                     — match if ANY member matches
//   3. type variables             — bind the placeholder to the other side
//                                   (after the occurs check, which forbids a
//                                   placeholder containing itself)
//   4. rows & labels              — the machinery for "open" objects
//   5. functions                  — parameter unifies with parameter,
//                                   result with result (incl. curried /
//                                   variadic chains)
//   6. records                    — field-by-field, honouring open rows
//   7. named types (TCon)         — same name, then unify the arguments
//   8. assorted bridges           — special conversions (TypeRep, numeric
//                                   subtypes, built-in members, merge shapes)
//
// A failed match throws UnificationError; the inference engine catches these
// and turns them into the squiggly-underline diagnostics users see.
// ============================================================================

import { Type, TRecord, TLabelVar, TForall, typeToString, parseKvName, tCon, tVar, tRow, tLabelVar, isWildcard, isAnyType, isNumericType, isNumericSubtypeOf, isSpread, isUnion, getReturnType, isAppliedFunction, desugarFunctionType, desugarObjectType, flattenCurriedType, structuralEquals, T_UNION, T_TUPLE, T_SPREAD_ARRAY, T_TYPEREP, T_PICKED, T_MERGE, T_ERROR, T_ARRAY, T_OBJECT, T_FUNCTION, ANNOTATION_NAME_RE } from './types';
import { collapseMultiParamLevel, isArrowChainTuple, collapseArrowChainTuple, hasTopLevelSpreadChain, hasSpreadInArrowChain } from './typeUtils';
import { Substitution } from './substitution';
import { lookupMethod, isBuiltinType, getTypeArity } from '../registries/methodRegistry';
import { getDataType } from '../registries/dataTypeRegistry';

/** Stack traces of internal control-flow errors are only useful while
 *  debugging hinmil itself (`HM_DEBUG=1`). */
const CAPTURE_STACKS = typeof process !== 'undefined' && !!process.env?.HM_DEBUG;

/**
 * Unification failure.  Thrown very often during SPECULATIVE inference
 * (overload trials, natural-type checks) where the error is caught and
 * discarded, so it is kept cheap: the message is rendered lazily on first
 * read and no stack trace is captured (unless `HM_DEBUG` is set).  Together
 * these were ~4% of the FP-library lint.
 */
export class UnificationError extends Error {
  private _message: string | undefined;
  constructor(
    public readonly left: Type,
    public readonly right: Type,
    message?: string,
  ) {
    const limit = Error.stackTraceLimit;
    if (!CAPTURE_STACKS) Error.stackTraceLimit = 0;
    super();
    Error.stackTraceLimit = limit;
    this._message = message;
    this.name = 'UnificationError';
  }
  override get message(): string {
    if (this._message === undefined) {
      this._message = `Cannot unify ${typeToString(this.left)} with ${typeToString(this.right)}`;
    }
    return this._message;
  }
  override set message(value: string) {
    this._message = value;
  }
}

/**
 * Specialised {@link UnificationError} thrown by the occurs check when a type
 * variable would have to be bound to a type that mentions itself (an infinite
 * type, e.g. `b ~ a -> b`).  Carries the offending variable and the type it
 * occurs in so callers can render an actionable "infinite type" diagnostic.
 * The message keeps the historical `Infinite type:` prefix for back-compat
 * with existing `startsWith('Infinite type:')` checks.
 */
export class OccursCheckError extends UnificationError {
  constructor(
    left: Type,
    right: Type,
    public readonly tvType: Type,
    public readonly occursInType: Type,
  ) {
    super(
      left,
      right,
      `Infinite type: ${tvType.tag === 'TVar' ? tvType.name : typeToString(tvType)} ~ ${typeToString(occursInType)}`,
    );
    this.name = 'OccursCheckError';
  }
}

/** Maximum recursion depth for unification / occurs-check to prevent stack overflow. */
const MAX_DEPTH = 500;

/**
 * Occurs check: does type variable `id` appear anywhere inside `type`?
 * Prevents infinite types like `a = a -> b`.
 */
function occursIn(id: number, type: Type, depth = 0): boolean {
  if (depth > MAX_DEPTH) {
    throw new UnificationError(
      { tag: 'TVar', id, name: `t${id}` } as Type,
      type,
      `Occurs-check exceeded maximum depth (${MAX_DEPTH})`,
    );
  }
  switch (type.tag) {
    case 'TVar':
      return type.id === id;
    case 'TCon': {
      // Check if TCon name encodes a kind variable with this id.
      // At depth 0 (top-level), a kv-TCon whose varId matches is NOT
      // infinite — it's just the constructor applied to args (m := m a).
      // Only flag it as infinite if it appears nested (depth > 0) or if
      // the id also appears inside the args.
      const kv = parseKvName(type.name);
      if (kv && kv.varId === id) {
        if (depth > 0) return true;
        return type.args.some((a) => occursIn(id, a, depth + 1));
      }
      return type.args.some((a) => occursIn(id, a, depth + 1));
    }
    case 'TFun':
      return occursIn(id, type.param, depth + 1) || occursIn(id, type.result, depth + 1);
    case 'TRecord':
      for (const k in type.fields) {
        if (occursIn(id, type.fields[k], depth + 1)) return true;
      }
      // Label-polymorphic fields (`{ [k] :: a, ...r }`) keep their value type
      // in `labelFields`, NOT in `fields`.  Skipping them lets an infinite
      // type such as `a = { [k] :: a }` escape the occurs check and later
      // blows the stack in `Substitution.apply`.
      if (type.labelFields) {
        for (const lf of type.labelFields) {
          if (occursIn(id, lf.type, depth + 1)) return true;
          if (occursIn(id, lf.label, depth + 1)) return true;
        }
      }
      if (type.rest && occursIn(id, type.rest, depth + 1)) return true;
      return false;
    case 'TLabel':
      return type.kind === 'var' && type.id === id;
    case 'TRow':
      return type.id === id;
    case 'TForall':
      // Bound vars are globally fresh — `id` can only refer to a FREE
      // (outer) variable, so just recurse into the body.
      return occursIn(id, type.body, depth + 1);
  }
}

/** Unify a flexible type (wildcard / Any) with another type.
 *  Binds the other side if it's a TVar; otherwise propagates the
 *  flexible type into any free TVars contained in `other` so that
 *  expressions like `f(x)` against `f :: Any` produce `Any` rather
 *  than a leftover unbound result tvar. This mirrors the semantics
 *  of a top type: every position absorbs `Any`, including the result
 *  of a function call. */
function unifyFlexible(flex: Type, other: Type): Substitution {
  if (other.tag === 'TVar') {
    return Substitution.singleton(other.id, flex);
  }
  // Walk `other` and bind any unbound TVars to `flex`. We avoid
  // touching label vars (which live in their own sort).
  const subst = new Substitution();
  const visit = (t: Type): void => {
    switch (t.tag) {
      case 'TVar':
        if (subst.lookup(t.id) === undefined) subst.set(t.id, flex);
        return;
      case 'TCon':
        for (const arg of t.args) visit(arg);
        return;
      case 'TFun':
        visit(t.param);
        visit(t.result);
        return;
      case 'TRecord':
        for (const k of Object.keys(t.fields)) visit(t.fields[k]);
        if (t.rest) visit(t.rest);
        return;
      case 'TForall':
        // Never bind variables under a nested quantifier — a wildcard must
        // not erase the polymorphism a rank-N annotation demands.
        return;
      default:
        return;
    }
  };
  visit(other);
  return subst;
}

/** Instantiate a nested `forall` with fresh flexible type variables.
 *  Used for graceful degradation when a TForall meets a non-forall type in a
 *  context that has no dedicated rank-N handling (call-site subsumption in
 *  the inference layer intercepts BEFORE unification on the strict path). */
function instantiateForallBody(f: TForall): Type {
  const s = new Substitution();
  for (let i = 0; i < f.vars.length; i++) {
    s.set(f.vars[i], tVar(f.varNames[i]));
  }
  return s.apply(f.body);
}

/** Bind a TVar to a type, checking for occurs and union membership. */
function bindVar(tv: Type & { tag: 'TVar' }, other: Type, t1: Type, t2: Type): Substitution {
  // TVar is already a direct member of the union — no binding needed
  if (other.tag === 'TCon' && other.name === T_UNION &&
      other.args.some(a => a.tag === 'TVar' && a.id === tv.id)) {
    return new Substitution();
  }
  if (occursIn(tv.id, other)) {
    throw new OccursCheckError(t1, t2, tv, other);
  }
  return Substitution.singleton(tv.id, other);
}

/** Unify argument lists pairwise, threading the substitution through. */
function unifyArgs(args1: Type[], args2: Type[], subst: Substitution, depth: number): Substitution {
  for (let i = 0; i < args1.length; i++) {
    const s = unify(subst.apply(args1[i]), subst.apply(args2[i]), depth);
    subst = s.compose(subst);
  }
  return subst;
}

/** Unify a kind-variable TCon against a concrete TCon with partial application. */
function unifyKvConcrete(
  kvSide: Type & { tag: 'TCon' }, kvInfo: { varName: string; varId: number },
  concrete: Type & { tag: 'TCon' },
  t1: Type, t2: Type, depth: number,
): Substitution {
  if (kvSide.args.length > concrete.args.length) {
    throw new UnificationError(t1, t2);
  }
  if (occursIn(kvInfo.varId, concrete)) {
    throw new UnificationError(t1, t2, `Infinite type`);
  }
  const numAbsorbed = concrete.args.length - kvSide.args.length;
  const absorbedArgs = concrete.args.slice(0, numAbsorbed);
  const matchingArgs = concrete.args.slice(numAbsorbed);
  let subst = Substitution.singleton(kvInfo.varId, tCon(concrete.name, absorbedArgs));
  return unifyArgs(kvSide.args, matchingArgs, subst, depth);
}

/** TypeRep m coercion: extract the return type's constructor from a function. */
function isInternalTypeName(name: string): boolean {
  return name.startsWith('$') || name === T_ARRAY || name === T_OBJECT || name === 'Function';
}

function unifyTypeRep(
  typeRep: Type & { tag: 'TCon' }, fn: Type & { tag: 'TFun' }, depth: number,
): Substitution {
  const ret = getReturnType(fn);
  const inner = typeRep.args[0];
  // A constructor function whose result is an OPAQUE type variable — one
  // that does not occur in any parameter — witnesses `TypeRep` for exactly
  // that variable: `(b -> m)` in
  // `mconcatMap :: Monoid m => (b -> m) -> … -> m`, where the same value is
  // called AND passed to `empty :: TypeRep m -> m`.  A result variable that
  // is threaded from a parameter (`a -> a`, identity) is not a constructor.
  if (ret.tag === 'TVar') {
    let paramsMentionRet = false;
    for (let t: Type = fn; t.tag === 'TFun'; t = t.result) {
      if (occursIn(ret.id, t.param)) { paramsMentionRet = true; break; }
    }
    if (!paramsMentionRet) return unify(inner, ret, depth + 1);
  }
  if (ret.tag !== 'TCon') {
    throw new UnificationError(typeRep, fn);
  }
  // `TypeRep m` denotes the constructor ITSELF (possibly partially applied),
  // not one saturated application of it. When the rep slot is still a bare
  // type variable, strip the witness return type's trailing ELEMENT argument:
  // `a -> Identity a` witnesses `TypeRep Identity`, not `TypeRep (Identity a)`.
  // Leading args stay absorbed (`a -> RTask r e a` → `TypeRep (RTask r e)`),
  // mirroring unifyKvConcrete's partial-application absorption. This keeps a
  // rep usable at MULTIPLE element types in one body (of(A)(x) and of(A)(y)).
  // Only a type-VARIABLE trailing arg is stripped — a concrete element
  // (`() -> Config String`) is part of the constructor's identity.
  if (ret.args.length > 0 && ret.args[ret.args.length - 1].tag === 'TVar') {
    if (inner.tag === 'TVar') {
      return unify(inner, tCon(ret.name, ret.args.slice(0, -1)), depth + 1);
    }
    // The rep slot already resolved to a bare/partial constructor (a previous
    // witness bound it): compare constructor identity at the SLOT's arity,
    // dropping the witness's own element applications.
    if (inner.tag === 'TCon' && !parseKvName(inner.name)
        && inner.name === ret.name && inner.args.length < ret.args.length) {
      return unify(inner, tCon(ret.name, ret.args.slice(0, inner.args.length)), depth + 1);
    }
  }
  return unify(inner, ret, depth + 1);
}

// ---------------------------------------------------------------------------
// label ↔ row bridge (Phase B)
//
// `{[i]::a}` (a pure *var-label* record) and `{...a}` (a pure *open row*)
// are two spellings of "the same arbitrary sub-object".  Structurally they
// differ — the former carries a `labelFields` group whose *value* is a
// value-type var, the latter a `rest` row var — so HM unification can't see
// them as equal on its own.  When such a label record meets a row-bearing
// record / `Merge` marker / another label record, we reinterpret each
// `[lbl]::val` group as an *open row* (`{...val}`): the group's value-var is
// bound to a fresh row and the record is rewritten in row form (single group
// ⇒ `{...val}`, multiple groups ⇒ `Merge[{...v1},{...v2}]` collapsed to bare
// rows).  This bridge fires ONLY in abstract record position (the other side
// is a pure open row, a `Merge` of rows, or another pure-var-label record) —
// never against a concrete-field record, where the historical
// `matchLabelFields` concrete-key expansion (deepMerge / label polymorphism)
// must be preserved.
// ---------------------------------------------------------------------------

/** Well-known structural members exposed intrinsically by a concrete builtin
 *  container.  Used so a concrete value (e.g. an Array) can unify with a record
 *  that requires only members the container always provides (e.g. `length`).
 *  Returns null for types with no such intrinsic record-shaped members. */
function builtinStructuralMembers(tconName: string): Record<string, Type> | null {
  switch (tconName) {
    case T_SPREAD_ARRAY:
    case T_ARRAY:
    case 'Array':
    case 'String':
      return { length: tCon('Number') };
    default:
      return null;
  }
}

/** A record written purely as one-or-more `[varLabel]::value` groups, with no
 *  concrete fields, no row tail, and not a strict `{}`. */
function isPureVarLabelRecord(r: Type): r is TRecord {
  if (r.tag !== 'TRecord') return false;
  if (r.strictEmpty) return false;
  if (r.rest) return false;
  if (Object.keys(r.fields).length > 0) return false;
  if (!r.labelFields || r.labelFields.length === 0) return false;
  return r.labelFields.every((lf) => lf.label.tag === 'TLabel' && lf.label.kind === 'var');
}

/** A record written as a pure open row `{...x}` — a single row tail with no
 *  concrete fields and no label groups. */
function isPureOpenRow(r: Type): r is TRecord {
  if (r.tag !== 'TRecord') return false;
  if (r.strictEmpty) return false;
  if (!r.rest) return false;
  if (Object.keys(r.fields).length > 0) return false;
  if (r.labelFields && r.labelFields.length > 0) return false;
  return true;
}

/** True when `other` is an abstract record position the label↔row bridge may
 *  unify against: a pure open row, another pure-var-label record, or a
 *  `Merge` marker. */
function isRowishForBridge(other: Type): boolean {
  if (isPureOpenRow(other) || isPureVarLabelRecord(other)) return true;
  if (other.tag === 'TCon' && other.name === T_MERGE) return true;
  return false;
}

/**
 * Reinterpret a pure-var-label record as its row form.  Returns the rewritten
 * type plus a substitution binding each group's value-var to the fresh row
 * that now stands in for it.
 *   `{[i]::a}`        → `{...rowA}`           with  a := rowA
 *   `{[j]::a,[i]::b}` → `Merge[rowA, rowB]`   with  a := rowA, b := rowB
 */
function toRowForm(r: TRecord): { rowForm: Type; pre: Substitution } {
  const pre = new Substitution();
  const rows: Type[] = [];
  for (const lf of r.labelFields ?? []) {
    const vt = lf.type;
    if (vt.tag === 'TVar') {
      const row = tRow(vt.name);
      pre.set(vt.id, row);
      rows.push(row);
    } else if (vt.tag === 'TRow') {
      rows.push(vt);
    } else {
      // Non-var value (already concrete / structured): stand in a fresh row
      // so the group still reads as an arbitrary sub-object.
      rows.push(tRow());
    }
  }
  if (rows.length === 1) {
    return { rowForm: { tag: 'TRecord', fields: {}, rest: rows[0] as TRecord['rest'] }, pre };
  }
  return { rowForm: tCon(T_MERGE, rows), pre };
}

// ---------------------------------------------------------------------------
// merge-shape acceptance (object-system robustness decision)
//
// A *merge-shape* return type — `{ ...a, ...b }` (a `Merge` marker), a pure
// open row `{ ...a }`, a pure var-label record `{ [k] :: a }`, or a
// `mergeRow`-flagged record — describes "some record built from the inputs";
// its exact shape is not determinable from the signature alone.  The system
// treats it as satisfied by ANY record-ish body (`obj1`, `{...obj1}`, `{}`, a
// concrete record, …) — never poisoning the parameter rows/labels — while a
// non-record body (Number, String, Array, …) still reports a mismatch.
// ---------------------------------------------------------------------------

/** A "merge-shape" record form (see header).  A mixed concrete+open record
 *  (`{ x :: Number, ...a }`) is deliberately NOT a merge-shape, so it keeps
 *  strict structural checking. */
function isMergeShape(t: Type): boolean {
  if (t.tag === 'TCon' && t.name === T_MERGE) return true;
  if (t.tag === 'TRecord') {
    if (t.mergeRow) return true;
    if (isPureOpenRow(t) || isPureVarLabelRecord(t)) return true;
  }
  return false;
}

/** "Record-ish": a value whose runtime form is an object/record in any
 *  encoding — a record (open/closed/label), a `Merge` marker, the `$error`
 *  sentinel, or a still-flexible type/row variable.  Non-records (Number,
 *  String, Array, Boolean, function, …) are excluded. */
function isRecordIsh(t: Type): boolean {
  if (t.tag === 'TRecord') return true;
  if (t.tag === 'TVar' || t.tag === 'TRow') return true;
  if (t.tag === 'TCon' && (t.name === T_MERGE || t.name === T_ERROR)) return true;
  return false;
}

/** The decision predicate: a merge-shape on one side accepts a record-ish
 *  value on the other.  Applied as a fallback when normal unification fails. */
function mergeShapeAccepts(a: Type, b: Type): boolean {
  return (isMergeShape(a) && isRecordIsh(b)) || (isMergeShape(b) && isRecordIsh(a));
}

/**
 * Public unification entry point.  Wraps {@link unifyCore} with the
 * merge-shape acceptance fallback ({@link mergeShapeAccepts}): when the core
 * unifier fails on a pair where one side is a merge-shape record and the other
 * is record-ish, the failure becomes success (identity substitution) — the
 * annotation's merge-shape return is authoritative and accepts any record
 * body.  Every recursive call routes through this wrapper, so acceptance is
 * evaluated per-frame: the failing return-position frame accepts while genuine
 * non-record mismatches (and outer frames) still throw.
 */
/** Expands a bare alias name (`Node`) to its body, or returns the type
 *  unchanged.  Installed by the inference engine for the duration of an
 *  `infer` call (see {@link withAliasExpander}). */
export type AliasExpander = (t: Type) => Type;

let aliasExpander: AliasExpander | null = null;

/** Run `f` with `expander` as the alias expander of unify (restored
 *  afterwards, so nested engines for imports keep their own). */
export function withAliasExpander<T>(expander: AliasExpander | null, f: () => T): T {
  const previous = aliasExpander;
  aliasExpander = expander;
  try {
    return f();
  } finally {
    aliasExpander = previous;
  }
}

/** The body of a bare alias name, or null. */
function expandedAliasName(t: Type): Type | null {
  if (!aliasExpander || t.tag !== 'TCon' || t.args.length !== 0) return null;
  const expanded = aliasExpander(t);
  return expanded === t ? null : expanded;
}

export function unify(t1: Type, t2: Type, _depth = 0): Substitution {
  try {
    return unifyCore(t1, t2, _depth);
  } catch (e) {
    if (e instanceof UnificationError && mergeShapeAccepts(t1, t2)) {
      return new Substitution();
    }
    // A bare alias name that unify met unexpanded: the recursive reference
    // inside a recursive alias (`Node :: String | … | [Node]`, kept as a
    // name to break the cycle), or a name inside another module's type.
    // Expand it once and retry.  Only on the failure path, so a successful
    // unification costs nothing extra.
    if (e instanceof UnificationError && !(t1.tag === 'TCon' && t2.tag === 'TCon' && t1.name === t2.name)) {
      const e1 = expandedAliasName(t1);
      const e2 = e1 ? null : expandedAliasName(t2);
      if (e1 || e2) return unify(e1 ?? t1, e2 ?? t2, _depth + 1);
    }
    throw e;
  }
}

/**
 * Unify two types, producing a substitution that makes them equal.
 */
function unifyCore(t1: Type, t2: Type, _depth = 0): Substitution {
  if (_depth > MAX_DEPTH) {
    throw new UnificationError(t1, t2, `Unification exceeded maximum depth (${MAX_DEPTH})`);
  }
  // Wildcard type ('*' or named '*:name') unifies with anything.
  if (isWildcard(t1)) return unifyFlexible(t1, t2);
  if (isWildcard(t2)) return unifyFlexible(t2, t1);

  // Any (top type) — unifies with everything like wildcard, but unlike
  // wildcard it is a concrete named type that survives in inference output.
  if (isAnyType(t1)) return unifyFlexible(t1, t2);
  if (isAnyType(t2)) return unifyFlexible(t2, t1);

  // Union type: unify succeeds if the other type matches ANY member
  if (isUnion(t1) && t2.tag !== 'TVar') {
    return unifyWithUnion(t1.args, t2, _depth + 1, t1.tag === 'TCon' && !!t1.overloadSet);
  }
  if (isUnion(t2) && t1.tag !== 'TVar') {
    return unifyWithUnion(t2.args, t1, _depth + 1, t2.tag === 'TCon' && !!t2.overloadSet);
  }

  // Both are the same variable
  if (t1.tag === 'TVar' && t2.tag === 'TVar' && t1.id === t2.id) {
    return new Substitution();
  }

  // Row variables live in a separate sort (W2 disjoint TRow refactor).
  // Same row-var is trivially equal; row-vs-row binds; row-vs-record
  // captures the record's fields into the row binding (handled by
  // bindRow, which delegates to the existing TRecord splice logic in
  // Substitution.apply).  Row-vs-TVar is treated as ordinary TVar
  // binding (the TVar absorbs the row sort) — keeps backward compat
  // while sites still allocate TVars in row position.
  if (t1.tag === 'TRow' && t2.tag === 'TRow') {
    if (t1.id === t2.id) return new Substitution();
    return Substitution.singleton(t1.id, t2);
  }
  if (t1.tag === 'TRow') {
    if (occursIn(t1.id, t2)) {
      throw new UnificationError(t1, t2, `Infinite row: ${t1.name} ~ ${typeToString(t2)}`);
    }
    return Substitution.singleton(t1.id, t2);
  }
  if (t2.tag === 'TRow') {
    if (occursIn(t2.id, t1)) {
      throw new UnificationError(t1, t2, `Infinite row: ${t2.name} ~ ${typeToString(t1)}`);
    }
    return Substitution.singleton(t2.id, t1);
  }

  // Label unification — labels live in their own sort.  Same-id vars
  // are trivially equal; lit-vs-lit checks string equality; var-vs-anything
  // (including a non-label type — handled further down by the catch-all)
  // binds.  We do NOT throw for TLabel-vs-non-TLabel here, because TVars
  // must still be allowed to absorb a TLabel (so a generic `a` can be
  // bound to a label inside e.g. `(a, b) -> a`).
  if (t1.tag === 'TLabel' && t2.tag === 'TLabel') {
    if (t1.kind === 'var' && t2.kind === 'var' && t1.id === t2.id) {
      return new Substitution();
    }
    if (t1.kind === 'lit' && t2.kind === 'lit') {
      if (t1.value === t2.value) return new Substitution();
      throw new UnificationError(t1, t2,
        `Cannot unify label literals '${t1.value}' and '${t2.value}'`);
    }
    if (t1.kind === 'var') return Substitution.singleton(t1.id, t2);
    return Substitution.singleton((t2 as TLabelVar).id, t1);
  }

  // Both are type variables with different IDs — prefer keeping the one
  // with a user-supplied annotation name (single letter like 'a', 'r')
  // so that annotation names survive through substitution chains.
  // When both have annotation names, keep the one with the lower ID
  // (created earlier — typically the callback parameter rather than
  // a constructor/factory parameter introduced during body inference).
  if (t1.tag === 'TVar' && t2.tag === 'TVar') {
    const t1HasAnnotName = ANNOTATION_NAME_RE.test(t1.name);
    const t2HasAnnotName = ANNOTATION_NAME_RE.test(t2.name);
    if (t1HasAnnotName && !t2HasAnnotName) {
      return Substitution.singleton(t2.id, t1);
    }
    if (t2HasAnnotName && !t1HasAnnotName) {
      return Substitution.singleton(t1.id, t2);
    }
    // Both have annotation names or neither does — keep the lower ID
    // (earlier-created variable, typically the binding-site variable).
    if (t1.id < t2.id) {
      return Substitution.singleton(t2.id, t1);
    }
    return Substitution.singleton(t1.id, t2);
  }

  // t1 is a variable — bind it
  if (t1.tag === 'TVar') return bindVar(t1, t2, t1, t2);

  // t2 is a variable — bind it
  if (t2.tag === 'TVar') return bindVar(t2, t1, t1, t2);

  // Nested universal quantifiers (rank-N annotations).
  if (t1.tag === 'TForall' || t2.tag === 'TForall') {
    if (t1.tag === 'TForall' && t2.tag === 'TForall') {
      if (t1 === t2 || structuralEquals(t1, t2)) return new Substitution();
      if (t1.vars.length === t2.vars.length) {
        // Alpha-rename t2's binders onto t1's, then unify the bodies.  The
        // shared binders must come out UNBOUND — a binding would mean one
        // side is less polymorphic than the other.
        const rename = new Substitution();
        for (let i = 0; i < t2.vars.length; i++) {
          rename.set(t2.vars[i], { tag: 'TVar', id: t1.vars[i], name: t1.varNames[i] ?? `t${t1.vars[i]}` });
        }
        const s = unify(t1.body, rename.apply(t2.body), _depth + 1);
        for (const v of t1.vars) {
          if (s.lookup(v) !== undefined) {
            throw new UnificationError(t1, t2, 'Polymorphic type is not general enough');
          }
        }
        return s;
      }
      throw new UnificationError(t1, t2,
        'Cannot unify forall types quantifying different numbers of variables');
    }
    // TForall vs a non-forall type: graceful degradation — instantiate the
    // quantifier with fresh flexible vars and unify rank-1 style.  The strict
    // rank-N check happens at call sites (subsumption) before unify runs.
    const f = t1.tag === 'TForall' ? t1 : (t2 as TForall);
    const other = t1.tag === 'TForall' ? t2 : t1;
    return unify(instantiateForallBody(f), other, _depth + 1);
  }

  // After TVar binding has been considered, a remaining label-vs-non-label
  // mismatch is usually a hard error.  But labels are *runtime strings*, so
  // a TLabel may be used wherever a `String` is expected (and vice versa) —
  // e.g. `if (key === k) ...` inside a label-polymorphic function body.
  // We allow that compatibility silently (no binding); other type pairings
  // (e.g. `Number` vs `TLabel`) remain errors.
  if (t1.tag === 'TLabel' || t2.tag === 'TLabel') {
    const other = t1.tag === 'TLabel' ? t2 : t1;
    if (other.tag === 'TCon' && other.name === 'String' && other.args.length === 0) {
      return new Substitution();
    }
    throw new UnificationError(t1, t2, 'Label vs non-label');
  }

  // Both are function types
  if (t1.tag === 'TFun' && t2.tag === 'TFun') {
    // Spread arrow chain: `a -> b -> ... -> z` absorbs a variable number of
    // *middle* curried parameters when unified against a concrete curried
    // function.  Handle the whole chain at once before the generic
    // param/result recursion (which would mismatch `... -> z` against a
    // non-function remainder).
    //
    // Only route here for a GENUINE top-level spread chain — one whose leading
    // params are all simple (no higher-order param before the spread).  A type
    // like `(a -> b -> ... -> z) -> (a -> b -> ... -> z)` (e.g. `memoizeCurried`)
    // carries the spread nested inside its function-typed parameter/result; it
    // is a plain 1-arg function and must decompose STRUCTURALLY, otherwise
    // `flattenCurriedType` would merge the callee's result chain into the
    // parameter list and collapse the call result to the bare terminal `z`.
    if (hasTopLevelSpreadChain(t1) || hasTopLevelSpreadChain(t2)) {
      return unifySpreadArrowChain(t1, t2, _depth + 1);
    }
    const s1 = unify(t1.param, t2.param, _depth + 1);
    const s2 = unify(s1.apply(t1.result), s1.apply(t2.result), _depth + 1);
    return s2.compose(s1);
  }

  // Chain-container element collapse.  A spread tuple/array whose non-spread
  // elements are all arrows — `(a -> b, b -> c, ..., y -> z)` — represents a
  // chained sequence of functions (how a container-wrapped chain
  // `f (a->b, ..., y->z)` stores its element type).  When such a chain meets a
  // SINGLE arrow (e.g. the element expectation of a fold/reduce whose reducer
  // applies each element to an accumulator), collapse the chain to its overall
  // composed arrow `first.param -> last.result` and unify that.  This makes a
  // container-wrapped chain fold like the bare spread-array form instead of
  // failing to match the reducer's element type.
  {
    const chainSide = isArrowChainTuple(t1) ? t1 : isArrowChainTuple(t2) ? t2 : null;
    const arrowSide = t1.tag === 'TFun' ? t1 : t2.tag === 'TFun' ? t2 : null;
    if (chainSide && arrowSide) {
      const collapsed = collapseArrowChainTuple(chainSide);
      if (collapsed) return unify(collapsed, arrowSide, _depth + 1);
    }
  }

  // Function (TCon) matches any function type (TFun)
  if ((t1.tag === 'TFun' && t2.tag === 'TCon' && t2.name === 'Function' && t2.args.length === 0) ||
      (t2.tag === 'TFun' && t1.tag === 'TCon' && t1.name === 'Function' && t1.args.length === 0)) {
    return new Substitution();
  }

  // Applied `Function [params] result` is sugar for a `TFun`.  Desugar so it
  // unifies structurally with a real `TFun` *and* with another applied
  // `Function` (possibly spelled at a different arity, e.g. the curried
  // `Function [x] (Function [y] a)` vs the tupled `Function [x, y] a`).
  if (isAppliedFunction(t1) && (t2.tag === 'TFun' || isAppliedFunction(t2))) {
    const d1 = desugarFunctionType(t1.args[0], t1.args[1]);
    const d2 = isAppliedFunction(t2) ? desugarFunctionType(t2.args[0], t2.args[1]) : t2;
    return unify(d1, d2, _depth + 1);
  }
  if (isAppliedFunction(t2) && t1.tag === 'TFun') {
    return unify(t1, desugarFunctionType(t2.args[0], t2.args[1]), _depth + 1);
  }

  // A kind variable applied to one argument (`f a`, e.g. `Functor f => f a`)
  // accepts a one-parameter function value: `f := Function [x]`, the reader
  // functor (`x -> a` is `Function [x] a`).  Whether `Function` satisfies the
  // constraint is decided at discharge (`::rep Functor Function#map`).
  {
    const funSide = t1.tag === 'TFun' ? t1 : t2.tag === 'TFun' ? t2 : null;
    const kvSide = !funSide ? null : t1.tag === 'TCon' ? t1 : t2.tag === 'TCon' ? t2 : null;
    const kv = kvSide && kvSide.args.length === 1 ? parseKvName(kvSide.name) : null;
    if (kv && funSide
        && !(funSide.param.tag === 'TCon' && (funSide.param.name === T_TUPLE || funSide.param.name === 'Void'))
        && !occursIn(kv.varId, funSide)
        // Not a variadic chain (`m x -> m y -> ... -> m z` stands for its
        // terminal), and not a function that mentions the kind variable
        // itself (`m x -> …`): binding `m` to it would be circular.
        && !hasSpreadInArrowChain(funSide)
        && !mentionsKindVar(funSide, kv.varId)) {
      const fBinding = Substitution.singleton(kv.varId, tCon(T_FUNCTION, [tCon(T_ARRAY, [funSide.param])]));
      const s2 = unify(fBinding.apply(kvSide!.args[0]), fBinding.apply(funSide.result), _depth + 1);
      return s2.compose(fBinding);
    }
  }

  // A kind variable applied to TWO arguments (`p b c`, e.g.
  // `Profunctor p => p b c`) accepts a one-parameter function value:
  // `p := Function`, with `p b c` ≡ `b -> c` — the binary counterpart of the
  // reader functor above.  `Substitution.apply` renders the application as
  // `Function [b] c`; whether `Function` satisfies the constraint is decided
  // at discharge (`::rep Profunctor Function#promap`).  An applied
  // `Function [x] y` on the other side is read through its desugared arrow,
  // so its parameter list never lands in the `b` slot.
  {
    const asFun = (t: Type): Type | null =>
      t.tag === 'TFun' ? t : isAppliedFunction(t) ? desugarFunctionType(t.args[0], t.args[1]) : null;
    const f1 = t1.tag === 'TCon' && t1.args.length === 2 && parseKvName(t1.name) ? null : asFun(t1);
    const f2 = f1 ? null : t2.tag === 'TCon' && t2.args.length === 2 && parseKvName(t2.name) ? null : asFun(t2);
    const funSide = f1 ?? f2;
    const kvSide = f1 ? t2 : t1;
    const kv = funSide && funSide.tag === 'TFun' && kvSide.tag === 'TCon' && kvSide.args.length === 2
      ? parseKvName(kvSide.name) : null;
    if (kv && funSide && funSide.tag === 'TFun' && kvSide.tag === 'TCon'
        && !(funSide.param.tag === 'TCon' && (funSide.param.name === T_TUPLE || funSide.param.name === 'Void'))
        && !occursIn(kv.varId, funSide)
        && !hasSpreadInArrowChain(funSide)
        && !mentionsKindVar(funSide, kv.varId)) {
      const pBinding = Substitution.singleton(kv.varId, tCon(T_FUNCTION, []));
      const s1 = unify(pBinding.apply(kvSide.args[0]), pBinding.apply(funSide.param), _depth + 1).compose(pBinding);
      const s2 = unify(s1.apply(kvSide.args[1]), s1.apply(funSide.result), _depth + 1);
      return s2.compose(s1);
    }
  }

  // TypeRep coercion: TypeRep m can unify with a constructor function
  // (e.g. a -> Identity a) by extracting the return type's constructor.
  if (t1.tag === 'TCon' && t1.name === T_TYPEREP && t1.args.length === 1 && t2.tag === 'TFun') {
    return unifyTypeRep(t1, t2, _depth);
  }
  if (t2.tag === 'TCon' && t2.name === T_TYPEREP && t2.args.length === 1 && t1.tag === 'TFun') {
    return unifyTypeRep(t2, t1, _depth);
  }

  // TypeRep(f) vs TypeRep($kv:f [args]) — a bare functor-kind var (on the
  // *actual* side) meeting a kv-*application* (on the *expected*/annotated
  // side).  A TypeRep denotes a type *constructor*, so both sides refer to
  // the same constructor `f`; the trailing application args (produced by the
  // `of :: TypeRep f -> a -> f a` param fixup) are spurious for TypeRep
  // identity.  Bind the actual bare var to the *unapplied* constructor so a
  // later `f b` stays a single-arg `f b` instead of collapsing to the
  // ill-kinded `f a b`.  Direction matters: the reverse case (an applied
  // *actual* `TypeRep (m a)` binding a bare *param* `m`, as in
  // `empty :: Monoid m => TypeRep m -> m` under an applied `Monoid (m a)`
  // constraint) must keep the application so `empty(M)` yields `m a` — that
  // falls through to the generic path below.
  if (t1.tag === 'TCon' && t1.name === T_TYPEREP && t1.args.length === 1 &&
      t2.tag === 'TCon' && t2.name === T_TYPEREP && t2.args.length === 1) {
    const a1 = t1.args[0];
    const a2 = t2.args[0];
    if (a1.tag === 'TVar' && a2.tag === 'TCon' && a2.args.length > 0 && parseKvName(a2.name)) {
      return Substitution.singleton(a1.id, tCon(a2.name, []));
    }
    // `TypeRep (f x…)` (a kv application, typically from the `of` param
    // fixup) meeting `TypeRep (T y…)` where `T y…` is UNDER-saturated — a
    // constructor still missing arguments (`StateT Id s` of `StateT m s a`,
    // i.e. a monad-transformer instance).  The witness IS that constructor:
    // bind `f := T y…` and drop the phantom `x…`.  The generic kv path would
    // absorb a real parameter as the element (`f := StateT Id`, `x := s`).
    for (const [kvSideArg, otherArg] of [[a1, a2], [a2, a1]] as const) {
      if (kvSideArg.tag !== 'TCon' || otherArg.tag !== 'TCon') continue;
      const kv = parseKvName(kvSideArg.name);
      if (!kv || kvSideArg.args.length === 0 || parseKvName(otherArg.name)) continue;
      const full = getDataType(otherArg.name)?.decl.typeVars.length ?? getTypeArity(otherArg.name);
      if (full > 0 && otherArg.args.length < full) {
        if (occursIn(kv.varId, otherArg)) throw new UnificationError(t1, t2, 'Infinite type');
        return Substitution.singleton(kv.varId, otherArg);
      }
    }
    // Both sides are kind-variable constructors at *differing* arity, e.g.
    // `TypeRep f` (a bare kv head, 0 args) meeting `TypeRep (f a)` (an applied
    // kv head).  This arises when a shared `TypeRep f` binding (`A`) is passed
    // to several `of :: TypeRep f -> a -> f a` calls with different value
    // types: the first call's param-fixup binds `A`'s var to the *unapplied*
    // constructor, so the next call meets `TypeRep g1` vs `TypeRep (g2 a)`.
    // Since a TypeRep names a *constructor*, the trailing application args are
    // phantom for identity — collapse the more-applied head onto the less-
    // applied one (dropping the phantom args) instead of failing the generic
    // kv arity check.
    if (a1.tag === 'TCon' && a2.tag === 'TCon') {
      const kv1 = parseKvName(a1.name);
      const kv2 = parseKvName(a2.name);
      if (kv1 && kv2 && a1.args.length !== a2.args.length) {
        if (kv1.varId === kv2.varId) return new Substitution();
        const [fewer, moreKv] = a1.args.length < a2.args.length
          ? [a1, kv2] : [a2, kv1];
        return Substitution.singleton(moreKv.varId, tCon(fewer.name, []));
      }
    }
  }

  // Both are constructed types
  if (t1.tag === 'TCon' && t2.tag === 'TCon') {
    // Strict-empty array (`[]` in an annotation) enforcement — the array
    // analogue of the strict-empty record rule below.  A strict-empty array
    // accepts only another empty array: either another strict-empty array, or
    // an empty array *literal* whose element variable is an unbound
    // `emptyArray` TVar.  An array with a concrete element type is rejected.
    if (t1.name === T_ARRAY && t2.name === T_ARRAY &&
        t1.args.length === 1 && t2.args.length === 1 &&
        (t1.strictEmpty === true || t2.strictEmpty === true)) {
      const acceptsEmpty = (other: Extract<Type, { tag: 'TCon' }>): boolean => {
        if (other.strictEmpty === true) return true;
        const el = other.args[0];
        return el.tag === 'TVar' && el.emptyArray === true;
      };
      const ok = t1.strictEmpty === true
        ? acceptsEmpty(t2)
        : acceptsEmpty(t1);
      if (!ok) throw new UnificationError(t1, t2);
      // Both sides are empty — unify the (fresh) element vars harmlessly.
      return unifyArgs(t1.args, t2.args, new Substitution(), _depth + 1);
    }

    const kv1 = parseKvName(t1.name);
    const kv2 = parseKvName(t2.name);

    // Kind variable vs concrete constructor: bind the kv to the concrete name.
    if (kv1 && !kv2) return unifyKvConcrete(t1, kv1, t2, t1, t2, _depth + 1);
    if (!kv1 && kv2) return unifyKvConcrete(t2, kv2, t1, t1, t2, _depth + 1);

    if (kv1 && kv2) {
      if (t1.args.length !== t2.args.length) {
        throw new UnificationError(t1, t2);
      }
      if (kv1.varId === kv2.varId) {
        // Same kind variable — just unify args
        return unifyArgs(t1.args, t2.args, new Substitution(), _depth + 1);
      }
      // Different kind vars — bind one to the other
      return unifyArgs(t1.args, t2.args, Substitution.singleton(kv1.varId, tCon(t2.name, [])), _depth + 1);
    }

    // Numeric subtype compatibility with directional widening.
    // Convention: t1 = inferred/actual, t2 = expected/annotated.
    // Widening (Integer → Double) is OK; narrowing (Double → Integer) is not.
    // Number ↔ any subtype is always allowed (JS has a single number type).
    if (isNumericType(t1) && isNumericType(t2)) {
      if (t1.name === t2.name) return new Substitution();
      if (t1.name === 'Number' || t2.name === 'Number') return new Substitution();
      if (isNumericSubtypeOf(t1.name, t2.name)) return new Substitution();
      // Narrowing or incompatible subtypes — fall through to throw UnificationError
    }

    // A fixed-length tuple flows into `[Any]`: `Any` absorbs every element,
    // so a tuple can be handed to an untyped array helper (and back).
    {
      const isTupleLike = (t: Type) => t.tag === 'TCon' && (t.name === T_TUPLE || t.name === T_SPREAD_ARRAY);
      const isAnyArray = (t: Type) => t.tag === 'TCon' && t.name === T_ARRAY && t.args.length === 1 && isAnyType(t.args[0]);
      if ((isTupleLike(t1) && isAnyArray(t2)) || (isAnyArray(t1) && isTupleLike(t2))) {
        return new Substitution();
      }
    }

    // A positional list `[a, b]` (no `...`) meets a list `[e]` when every
    // element is an `e`: a
    // positionally destructured value (`([home, away]) => …`) still accepts
    // a real list, and a pair of the same type can be used as a list.
    {
      const isPlainTuple = (t: Type) => t.tag === 'TCon' && t.name === T_SPREAD_ARRAY && t.args.length > 0
        && !t.args.some(a => isSpread(a));
      const isList = (t: Type) => t.tag === 'TCon' && t.name === T_ARRAY && t.args.length === 1;
      if ((isPlainTuple(t1) && isList(t2)) || (isList(t1) && isPlainTuple(t2))) {
        const tuple = (isPlainTuple(t1) ? t1 : t2) as import('./types').TCon;
        const elem = (isList(t1) ? t1 : t2) as import('./types').TCon;
        return unifyArgs(tuple.args, tuple.args.map(() => elem.args[0]), new Substitution(), _depth + 1);
      }
    }

    // A BARE parameterised constructor (`First`, registered arity > 0) only
    // arises from a `TypeRep m` witness, which binds `m` to the constructor
    // itself (`a -> First a` ⊢ `TypeRep First`).  When such an `m` is then
    // used in a value slot (`leftIdentity :: TypeRep m -> m -> Boolean`), it
    // stands for an application of that constructor: `First` ≈ `First String`.
    if (t1.name === t2.name && (t1.args.length === 0) !== (t2.args.length === 0)
        && !parseKvName(t1.name) && !isInternalTypeName(t1.name)) {
      const full = getDataType(t1.name)?.decl.typeVars.length ?? getTypeArity(t1.name);
      const applied = t1.args.length === 0 ? t2 : t1;
      if (full > 0 && applied.args.length === full) return new Substitution();
    }

    // Normal case: both are concrete constructors
    if (t1.name !== t2.name || t1.args.length !== t2.args.length) {
      // Spread-tuple unification: Tuple(a, b, ...) can unify with Tuple(X, Y, Z)
      // The ... absorbs any number of elements in the middle.
      if (t1.name === t2.name && (t1.name === T_TUPLE || t1.name === T_SPREAD_ARRAY)) {
        const spread1 = t1.args.some(a => isSpread(a));
        const spread2 = t2.args.some(a => isSpread(a));
        if (spread1 || spread2) {
          return unifySpreadTuple(t1.args, t2.args, t1, t2, _depth + 1);
        }
      }
      // Specialised error message when the constructors share a name
      // but disagree on arity — e.g. `Box a` vs `Box a b`.  Internal
      // synthetic names (Tuple, Union, SpreadArray, ...) keep the
      // generic message because they're never user-visible.
      if (t1.name === t2.name &&
          t1.name !== T_TUPLE && t1.name !== T_UNION && t1.name !== T_SPREAD_ARRAY) {
        throw new UnificationError(
          t1, t2,
          `Type constructor '${t1.name}' applied to ${t1.args.length} type argument${t1.args.length === 1 ? '' : 's'} ` +
          `but ${t2.args.length} expected`,
        );
      }
      throw new UnificationError(t1, t2);
    }
    // Check for spread tuples even when lengths match
    if ((t1.name === T_TUPLE || t1.name === T_SPREAD_ARRAY) &&
        (t1.args.some(a => isSpread(a)) || t2.args.some(a => isSpread(a)))) {
      return unifySpreadTuple(t1.args, t2.args, t1, t2, _depth + 1);
    }
    return unifyArgs(t1.args, t2.args, new Substitution(), _depth + 1);
  }

  // Both are record types — unify field by field, with row-variable
  // support for open records (`{ x :: a | r }`).  Closed-vs-closed remains
  // lenient on extras for back-compat: only the *common* keys are unified
  // and surplus keys on either side are silently accepted.  When at least
  // one side is open, the row variable absorbs the surplus from the other
  // side and (if the other side is also open) shares its row tail.
  if (t1.tag === 'TRecord' && t2.tag === 'TRecord') {
    // Nominal check: when BOTH records carry a (different) alias name,
    // they originate from distinct named declarations (e.g.
    // `LocationRow :: { … }` vs `ApplicationRow :: { … }`) and must
    // not unify even if their fields happen to overlap.  Without this,
    // the lenient closed-vs-closed rule below would silently accept
    // `QueryTag ApplicationRow` against `QueryTag LocationRow` because they
    // share `id :: Number`, defeating the per-table relation
    // restriction emitted by query-builder introspect.  When only one side has
    // an alias (or neither), keep the historical lenient behaviour so
    // record literals can still match named record types.
    if (t1.alias && t2.alias && t1.alias !== t2.alias) {
      throw new UnificationError(t1, t2);
    }

    // label ↔ row bridge: a pure `[var]::value` record meeting a row-bearing
    // (or another label) record is reinterpreted in row form so the two
    // spellings of "an arbitrary sub-object" unify.  Scoped to abstract
    // record position — never fires against a concrete-field record, where
    // `matchLabelFields` below performs the concrete-key expansion.
    if (isPureVarLabelRecord(t1) && isRowishForBridge(t2)) {
      const { rowForm, pre } = toRowForm(t1);
      const s = unify(rowForm, pre.apply(t2), _depth + 1);
      return s.compose(pre);
    }
    if (isPureVarLabelRecord(t2) && isRowishForBridge(t1)) {
      const { rowForm, pre } = toRowForm(t2);
      const s = unify(pre.apply(t1), rowForm, _depth + 1);
      return s.compose(pre);
    }

    // A record written as a literal `{}` in an annotation (`strictEmpty`) is a
    // strict, exactly-empty object.  Unlike inferred empty object literals
    // (which stay open/lenient so growing objects type-check), a strict `{}`
    // must not absorb any concrete field, so unifying it with a record that
    // carries concrete fields or label fields is an error.
    const isStrictEmpty = (r: TRecord): boolean =>
      r.strictEmpty === true &&
      !r.rest &&
      Object.keys(r.fields).length === 0 &&
      (!r.labelFields || r.labelFields.length === 0);
    const hasConcreteFields = (r: TRecord): boolean =>
      Object.keys(r.fields).length > 0 ||
      (r.labelFields != null && r.labelFields.length > 0);
    if (
      (isStrictEmpty(t1) && hasConcreteFields(t2)) ||
      (isStrictEmpty(t2) && hasConcreteFields(t1))
    ) {
      throw new UnificationError(t1, t2);
    }

    let subst = new Substitution();
    const keys1 = Object.keys(t1.fields);
    const keys2 = Object.keys(t2.fields);
    const commonKeys = keys1.filter((k) => keys2.includes(k));
    for (const k of commonKeys) {
      const s = unify(subst.apply(t1.fields[k]), subst.apply(t2.fields[k]), _depth + 1);
      subst = s.compose(subst);
    }
    const onlyIn1: Record<string, Type> = {};
    const onlyIn2: Record<string, Type> = {};
    for (const k of keys1) if (!commonKeys.includes(k)) onlyIn1[k] = subst.apply(t1.fields[k]);
    for (const k of keys2) if (!commonKeys.includes(k)) onlyIn2[k] = subst.apply(t2.fields[k]);

    // Label-keyed fields: bind each unresolved label var to a concrete
    // field name from the *other* side and unify the value type.  This
    // handles e.g. `{ [k] :: a, ...r }` ↔ `{ x :: Number, y :: Number }`
    // by picking up `x` for `k` (deterministic when only one candidate
    // remains; first-fit otherwise — caller is expected to disambiguate
    // by passing the label as an argument first).
    // When BOTH records are open, a still-unknown label need not name a field
    // the other side already has: `{ [k] :: a, ...r }` (from `prop (key)`
    // before its key is known) meeting `{ paid :: Boolean, ...r1 }` can be a
    // new field that the rows absorb.  Guessing `k := 'paid'` there broke
    // `pipe (filter (propEq (false, "paid")), map (prop ("total")))`.  The
    // label stays free and is bound when its key arrives.
    const bothOpen = !!(t1.rest && t2.rest);
    const matchLabelFields = (
      labelFields: ReadonlyArray<{ label: import('./types').TLabel; type: Type }> | undefined,
      candidates: Record<string, Type>,
    ): void => {
      if (!labelFields || labelFields.length === 0) return;
      for (const lf of labelFields) {
        const lbl = subst.apply(lf.label);
        if (lbl.tag !== 'TLabel') continue;
        if (lbl.kind === 'lit') {
          // Migrate by direct key match against `candidates`.
          if (lbl.value in candidates) {
            const s = unify(subst.apply(lf.type), candidates[lbl.value], _depth + 1);
            subst = s.compose(subst);
            delete candidates[lbl.value];
          }
          continue;
        }
        // Label still a var → pick first remaining candidate, bind label.
        if (bothOpen) continue;
        const remaining = Object.keys(candidates);
        if (remaining.length === 0) continue;
        const pickedKey = remaining[0];
        const s1 = unify(lbl, { tag: 'TLabel', kind: 'lit', value: pickedKey }, _depth + 1);
        subst = s1.compose(subst);
        const s2 = unify(subst.apply(lf.type), candidates[pickedKey], _depth + 1);
        subst = s2.compose(subst);
        delete candidates[pickedKey];
      }
    };
    matchLabelFields(t1.labelFields, onlyIn2);
    matchLabelFields(t2.labelFields, onlyIn1);

    const has1 = Object.keys(onlyIn1).length > 0;
    const has2 = Object.keys(onlyIn2).length > 0;

    // Closed-vs-closed: keep historical lenient behaviour (no error, no binding).
    if (!t1.rest && !t2.rest) return subst;

    // Helper: build a TRecord carrying `extras` and a (possibly fresh) row tail.
    const buildTail = (extras: Record<string, Type>, sharedRest?: typeof t1.rest): TRecord => {
      const rec: TRecord = { tag: 'TRecord', fields: extras };
      if (sharedRest) rec.rest = sharedRest;
      return rec;
    };

    // 1) t1 open, t2 open: link the two rows through a fresh shared row.
    //    r1 := { onlyIn2 | rShared }, r2 := { onlyIn1 | rShared }.
    if (t1.rest && t2.rest) {
      // Special case: identical row vars and no surplus → already unified.
      if (t1.rest.id === t2.rest.id && !has1 && !has2) return subst;
      // No surplus on either side: link the two row variables DIRECTLY rather
      // than wrapping each in a fresh `{ rShared }` record.  The wrapper would
      // rebind a named row (`{...a}`) to an anonymous shared row, so hovers on
      // a parameter typed `{...a}` would collapse to `{ r16 }`.  A direct
      // row-var unification keeps the surviving name (`{ a }`).
      if (!has1 && !has2) {
        const s = unify(subst.apply(t1.rest), subst.apply(t2.rest), _depth + 1);
        return s.compose(subst);
      }
      const rShared = tRow();
      const r1Bind = buildTail(onlyIn2, rShared);
      const r2Bind = buildTail(onlyIn1, rShared);
      const s1 = unify(subst.apply(t1.rest), r1Bind, _depth + 1);
      subst = s1.compose(subst);
      const s2 = unify(subst.apply(t2.rest), subst.apply(r2Bind), _depth + 1);
      subst = s2.compose(subst);
      return subst;
    }

    // 2) Only t1 open: t1.rest absorbs the surplus from t2.  Surplus on t1
    //    side (has1) is acceptable because t2 is closed-but-lenient.
    if (t1.rest) {
      const r1Bind = buildTail(onlyIn2);
      const s1 = unify(subst.apply(t1.rest), r1Bind, _depth + 1);
      subst = s1.compose(subst);
      return subst;
    }

    // 3) Only t2 open: symmetric.
    if (t2.rest) {
      const r2Bind = buildTail(onlyIn1);
      const s2 = unify(subst.apply(t2.rest), r2Bind, _depth + 1);
      subst = s2.compose(subst);
      return subst;
    }

    return subst;
  }

  // Wildcard (named or bare) wrapping a record — allow compatibility
  if (
    (t1.tag === 'TCon' && t2.tag === 'TRecord') ||
    (t1.tag === 'TRecord' && t2.tag === 'TCon')
  ) {
    const tcon = (t1.tag === 'TCon' ? t1 : t2) as { tag: 'TCon'; name: string; args: Type[] };
    const rec  = t1.tag === 'TRecord' ? t1 : (t2 as TRecord);

    // A bare alias name and the record expanded from that same alias are
    // one type.  The name reaches unify unexpanded when it travels inside
    // another module's type (`Promise Error (Toast -> ())`, an FP library's
    // `Component` in a list of routes); the local side is expanded.  Before,
    // they met as "Cannot unify 'Toast' with 'Toast'".
    if (tcon.args.length === 0 && rec.alias === tcon.name) {
      return new Substitution();
    }

    // Applied `Object k a` is sugar for `{ [k] :: a }`.  Desugar and unify
    // structurally with the concrete record so e.g. `Object k a` accepts a
    // real `{ x :: Number }` (binding the label/value vars accordingly).
    if (tcon.name === 'Object' && tcon.args.length === 2) {
      const desugared = desugarObjectType(tcon.args[0], tcon.args[1]);
      return unify(
        t1.tag === 'TRecord' ? t1 : desugared,
        t1.tag === 'TRecord' ? desugared : t2,
        _depth + 1,
      );
    }

    // A kind-variable constructor applied to one argument (`f a`, e.g. the
    // parameter of a `Foldable f => f a -> …` function) can accept a concrete
    // record by treating the record as an `Object k a`: bind the constructor
    // variable `f` to the partial application `Object k` and unify its single
    // argument with the record's value type via the `Object`-record desugar.
    // Unification only needs to succeed structurally — whether `Object`
    // legitimately satisfies the constraint is decided later by constraint
    // discharge (a `::rep Foldable Object#reduce` bridges it).  Without this,
    // passing an object literal to such a function is wrongly rejected before
    // the rep can ever be consulted.
    const kvApplied = parseKvName(tcon.name);
    if (kvApplied && tcon.args.length === 1 && !occursIn(kvApplied.varId, rec)) {
      const label = tLabelVar();
      const fBinding = Substitution.singleton(kvApplied.varId, tCon(T_OBJECT, [label]));
      const desugared = desugarObjectType(label, tcon.args[0]);
      const s2 = unify(fBinding.apply(rec), fBinding.apply(desugared), _depth + 1);
      return s2.compose(fBinding);
    }

    // `Merge a b` ↔ TRecord compatibility: when one side is a deferred
    // `Merge` marker (used to type combinators like `QueryTag#concat`
    // whose result row is the structural union of both operands) and
    // every argument resolves to a TRecord, flatten the marker into a
    // single TRecord and unify it with `rec`.  Mirrors the runtime
    // collapse performed by `applyMergeReduction` in `src/infer/calls.ts`
    // but at unification time, so the marker doesn't leak when the call
    // result is unified before the post-processor runs (e.g. when the
    // surrounding `one(x.concat(y))` call's parameter slot pulls the
    // expectation through).
    if (tcon.name === T_MERGE && tcon.args.length >= 2) {
      // label ↔ row bridge: a pure `[var]::value` record on the other side of
      // a `Merge` marker is rewritten in row form (`Merge[rowA,rowB]`) so the
      // two spellings unify positionally.
      if (isPureVarLabelRecord(rec)) {
        const { rowForm, pre } = toRowForm(rec);
        const s = unify(pre.apply(tcon), rowForm, _depth + 1);
        return s.compose(pre);
      }
      const flat: Record<string, Type> = {};
      let allRecords = true;
      for (const arg of tcon.args) {
        if (arg.tag === 'TRecord') {
          for (const k in arg.fields) {
            if (!(k in flat)) flat[k] = arg.fields[k];
          }
        } else {
          allRecords = false;
          break;
        }
      }
      if (allRecords) {
        const collapsed: TRecord = { tag: 'TRecord', fields: flat };
        return unify(
          t1.tag === 'TRecord' ? t1 : collapsed,
          t1.tag === 'TRecord' ? collapsed : t2,
          _depth + 1,
        );
      }
    }

    // Picked-projection compatibility:
    //   `Picked R sel` ≡ TRecord X  iff  X was produced by selecting from R.
    // Generic primitive — `Picked` is hinmil's projection type for "the
    // record obtained by applying selector `sel` to row `R`".  When the
    // call-site projection has run (see `applyPickedProjection` in
    // src/infer/calls.ts), the resulting TRecord carries `pickedFrom = R`.
    // A slot expectation `Picked R _` (typically a branch of a
    // `<Table>Selector` union) accepts any such record.  This makes the
    // mechanism library-agnostic: any DSL that emits `Picked R sel` slots
    // and produces records via the projection benefits — not just query-builder.
    if (tcon.name === T_PICKED && tcon.args.length >= 1) {
      const rArg = tcon.args[0];
      const rowName =
        rArg.tag === 'TCon' ? rArg.name :
        rArg.tag === 'TRecord' ? rArg.alias :
        undefined;
      const recRow = rec.pickedFrom ?? rec.alias;
      if (rowName && recRow && rowName === recRow) {
        // Bind the selector tvar (if any) to a fresh var — the actual
        // selector list has already been absorbed into the projected
        // record's fields, so its precise type carries no further info.
        if (tcon.args.length >= 2 && tcon.args[1].tag === 'TVar') {
          return Substitution.singleton(tcon.args[1].id, tVar());
        }
        return new Substitution();
      }
    }

    // istanbul ignore next — wildcard TCons are intercepted by the early
    // isWildcard(t1)/isWildcard(t2) guards at the top of unify(), so
    // isWildcard(tcon) is always false when this branch is reached.
    /* istanbul ignore next */
    if (isWildcard(tcon)) return new Substitution();
    // Object is compatible with any record type (JS object)
    if (tcon.tag === 'TCon' && tcon.name === 'Object' && tcon.args.length === 0) return new Substitution();
    // StrMap a is compatible with a record if all field values unify with a
    if (tcon.tag === 'TCon' && tcon.name === 'StrMap' && tcon.args.length === 1) {
      const valType = tcon.args[0];
      let subst = new Substitution();
      for (const k in rec.fields) {
        const s = unify(subst.apply(rec.fields[k]), subst.apply(valType), _depth + 1);
        subst = s.compose(subst);
      }
      return subst;
    }
    // A concrete builtin container satisfies a record whose concrete fields are
    // all well-known structural members it exposes — e.g. an Array (or String)
    // instance has `length :: Number`, so `[Number]` unifies with
    // `{ length :: a | Undefined }`.  This powers predicates like
    // `hasProp("length")([2])` where the parameter record's label var resolves
    // to a concrete key the value type provides intrinsically.
    {
      const fieldKeys = Object.keys(rec.fields);
      if (fieldKeys.length > 0) {
        const members = builtinStructuralMembers(tcon.name);
        if (members && fieldKeys.every((k) => k in members)) {
          let subst = new Substitution();
          for (const k of fieldKeys) {
            const s = unify(subst.apply(rec.fields[k]), subst.apply(members[k]), _depth + 1);
            subst = s.compose(subst);
          }
          return subst;
        }
      }
    }
    // A user-defined nominal type satisfies a record whose concrete fields are
    // all registered instance members it exposes — e.g. `Arrow` declares
    // `Arrow#@@type :: Arrow a b ~> String`, so `Arrow a b` unifies with
    // `{ @@type :: String }` (as required by `getType :: { @@type :: String }
    // | Undefined -> String`).  Each member's type is produced by its factory
    // instantiated with the container's type args, then unified with the
    // record field.  Restricted to non-builtin types (builtins expose many
    // methods and are handled structurally above) and to records with no
    // label-polymorphic groups, to keep the match precise.
    {
      const fieldKeys = Object.keys(rec.fields);
      if (
        fieldKeys.length > 0 &&
        (!rec.labelFields || rec.labelFields.length === 0) &&
        // A user sumtype shadows a builtin of the same name (FP-library's
        // `Response` vs the Fetch API `Response`).
        (!isBuiltinType(tcon.name) || getDataType(tcon.name) !== null)
      ) {
        const entries = fieldKeys.map((k) => lookupMethod(tcon.name, k));
        if (entries.every((e) => e !== null)) {
          let subst = new Substitution();
          let ok = true;
          for (let i = 0; i < fieldKeys.length; i++) {
            let memberType: Type;
            try {
              memberType = entries[i]!.factory(tcon.args);
            } catch {
              ok = false;
              break;
            }
            const s = unify(subst.apply(rec.fields[fieldKeys[i]]), subst.apply(memberType), _depth + 1);
            subst = s.compose(subst);
          }
          if (ok) return subst;
        }
      }
    }
    throw new UnificationError(t1, t2);
  }

  // Mismatched tags
  throw new UnificationError(t1, t2);
}

/**
 * Every member of `sub` unifies with some member of `sup`, under one
 * substitution that is threaded through the members.  Concrete members of
 * `sup` are tried before type variables, so `Undefined` meets `Undefined`
 * instead of binding `a := Undefined`.  Null when a member does not fit.
 */
function unionSubsetSubstitution(sub: Type[], sup: Type[], depth: number): Substitution | null {
  const ordered = [...sup.filter(m => m.tag !== 'TVar'), ...sup.filter(m => m.tag === 'TVar')];
  let subst = new Substitution();
  for (const member of sub) {
    let found: Substitution | null = null;
    for (const candidate of ordered) {
      try {
        found = unify(subst.apply(member), subst.apply(candidate), depth + 1);
        break;
      } catch { /* try next candidate */ }
    }
    if (!found) return null;
    subst = found.compose(subst);
  }
  return subst;
}

/**
 * Unify a concrete type with a union type.
 * Succeeds if the type matches at least one member of the union.
 */
function unifyWithUnion(members: Type[], other: Type, depth = 0, overloadSet = false): Substitution {
  // If the other side is also a Union, check that all its members match some member here
  if (isUnion(other)) {
    let allMatched = true;
    for (const otherMember of other.args) {
      let matched = false;
      for (const member of members) {
        try {
          unify(member, otherMember, depth + 1);
          matched = true;
          break;
        } catch { /* try next */ }
      }
      if (!matched) { allMatched = false; break; }
    }
    if (allMatched) return new Substitution();
    // The other direction: every member here fits a member of `other`
    // (`Number | Undefined` against `a | Null | Undefined`).  The bindings
    // are kept (`a := Number`), so a defaulting helper like
    // `valueOr :: a -> a | Null | Undefined -> a` accepts a narrower union.
    const subset = unionSubsetSubstitution(members, other.args, depth);
    if (subset) return subset;
    // Relaxed: when the value-side union is an "overloaded identifier" union
    // — i.e. it mixes callable (TFun) members with one or more non-callable
    // value members (Table TCon, metadata TRecord, …) — accept the union
    // as long as at least one of its non-function members matches some
    // member of the expected union. This supports query-builder-style overloads
    // like `LocationType :: Table | (a -> b) | (c -> d) | { props :: … }`
    // being usable as a `Selector` (whose Table branch matches Table); the
    // function and metadata branches are ignored at value sites.
    const hasFun = members.some(m => m.tag === 'TFun');
    const valueMembers = members.filter(m => m.tag !== 'TFun');
    if (hasFun && valueMembers.length > 0) {
      for (const vm of valueMembers) {
        for (const otherMember of other.args) {
          try {
            unify(vm, otherMember, depth + 1);
            return new Substitution();
          } catch { /* try next */ }
        }
      }
    }
    throw new UnificationError(tCon(T_UNION, members), other);
  }

  // Soundness gate for widened heterogeneous function arrays.  When an array
  // literal mixes functions of DIFFERENT arities its element type widens to a
  // union like `(a -> b) | (a -> b -> c)`.  Matching such a union against a
  // single concrete function expectation must NOT silently succeed by picking
  // whichever member happens to fit — no single arity can describe every
  // element.  Reject when every member is a function and their arities differ.
  // (Overload/selector unions carry non-function members and are unaffected;
  // same-arity function unions keep the permissive element-widening behaviour.)
  // An OVERLOAD SET (the alternatives of an overloaded function, possibly a
  // still-ambiguous partial application) is different: it denotes ONE of its
  // branches, chosen by context — so a function expectation simply selects
  // the first branch (declaration order) that fits.
  if (overloadSet && other.tag === 'TFun' && members.every(m => m.tag === 'TFun')) {
    for (const member of members) {
      try {
        return unify(member, other, depth + 1);
      } catch { /* try next branch */ }
    }
    throw new UnificationError(tCon(T_UNION, members), other);
  }

  if (other.tag === 'TFun' && members.length >= 2 &&
      members.every(m => m.tag === 'TFun')) {
    // Exemption: a spread arrow chain `a -> b -> ... -> z` is BUILT to absorb
    // differing arities, so a mixed-arity function union CAN be described by
    // it — e.g. FP-library `liftN` returning `lift2 | lift3 | …` checked against
    // `(x -> y -> ... -> z) -> m x -> m y -> ... -> m z`.  Soundness is kept
    // by requiring EVERY member (every runtime branch) to fit the chain.
    if (hasTopLevelSpreadChain(other) ||
        (other.param.tag === 'TFun' && hasSpreadInArrowChain(other.param))) {
      let subst = new Substitution();
      for (const member of members) {
        const s = unify(subst.apply(member), subst.apply(other), depth + 1);
        subst = s.compose(subst);
      }
      return subst;
    }
    const arities = new Set(members.map(m => flattenCurriedType(m).params.length));
    if (arities.size > 1) {
      throw new UnificationError(tCon(T_UNION, members), other);
    }
  }

  // A member with the same type constructor is the most specific match: try
  // it first.  Otherwise a structural member can win by declaration order —
  // a query builder's generated `Departments :: ({ props :: … } | Table DepartmentsRow | …)`
  // matched `Table r` through the `{ props }` record (via `Table#props`)
  // and left `r` unbound, so `Repo (Departments)` lost the row type.
  // (`isUnion` above is a type guard that narrows every TCon away, hence
  // the widening cast.)
  const target = other as unknown as { tag: string; name?: string };
  if (target.tag === 'TCon') {
    const name = target.name;
    const nominal = members.findIndex(m => m.tag === 'TCon' && m.name === name);
    if (nominal > 0) {
      try {
        return unify(members[nominal], other, depth + 1);
      } catch { /* fall back to declaration order */ }
    }
  }

  // Try each member — succeed if any one matches
  for (const member of members) {
    try {
      return unify(member, other, depth + 1);
    } catch { /* try next member */ }
  }
  // Friendlier diagnostic for the "wrong relation" case: when union members
  // include `… (Picked R _)` branches and `other` carries a record tagged
  // with `pickedFrom`, surface "'X' is not a valid relation here." instead
  // of dumping the entire union.
  const friendly = buildPickedMismatchMessage(members, other);
  if (friendly) {
    throw new UnificationError(tCon(T_UNION, members), other, friendly);
  }
  throw new UnificationError(tCon(T_UNION, members), other);
}

/** Walk a type collecting names `R` from any `Picked R …` TCon nodes. */
function collectPickedRowNames(t: Type, out: Set<string>, depth = 0): void {
  if (depth > 20) return;
  switch (t.tag) {
    case 'TCon':
      if (t.name === T_PICKED && t.args.length >= 1) {
        const r = t.args[0];
        if (r.tag === 'TCon') out.add(r.name);
        else if (r.tag === 'TRecord' && r.alias) out.add(r.alias);
      }
      for (const a of t.args) collectPickedRowNames(a, out, depth + 1);
      return;
    case 'TFun':
      collectPickedRowNames(t.param, out, depth + 1);
      collectPickedRowNames(t.result, out, depth + 1);
      return;
    case 'TRecord':
      for (const k in t.fields) collectPickedRowNames(t.fields[k], out, depth + 1);
      if (t.rest) collectPickedRowNames(t.rest, out, depth + 1);
      return;
    default:
      return;
  }
}

/** Find the `pickedFrom` tag of any TRecord embedded in `t`. */
function findPickedFrom(t: Type, depth = 0): string | undefined {
  if (depth > 20) return undefined;
  switch (t.tag) {
    case 'TRecord':
      if (t.pickedFrom) return t.pickedFrom;
      for (const k in t.fields) {
        const r = findPickedFrom(t.fields[k], depth + 1);
        if (r) return r;
      }
      if (t.rest) return findPickedFrom(t.rest, depth + 1);
      return undefined;
    case 'TCon':
      for (const a of t.args) {
        const r = findPickedFrom(a, depth + 1);
        if (r) return r;
      }
      return undefined;
    case 'TFun': {
      const r = findPickedFrom(t.param, depth + 1);
      if (r) return r;
      return findPickedFrom(t.result, depth + 1);
    }
    default:
      return undefined;
  }
}

function buildPickedMismatchMessage(members: Type[], other: Type): string | undefined {
  const validRows = new Set<string>();
  for (const m of members) collectPickedRowNames(m, validRows);
  if (validRows.size === 0) return undefined;
  const attempted = findPickedFrom(other);
  if (!attempted) return undefined;
  if (validRows.has(attempted)) return undefined; // shouldn't happen, but be safe
  const sorted = Array.from(validRows).sort();
  const list = sorted.length <= 8
    ? sorted.join(', ')
    : sorted.slice(0, 8).join(', ') + `, … (${sorted.length - 8} more)`;
  return `'${attempted}' is not a valid relation here. Valid relations: ${list}`;
}
/**
 * Unify two tuple/spread-array arg lists where one side has a spread marker (...).
 * The spread marker absorbs any number of elements.
 *
 * Example: Tuple(a, b, ...) unifies with Tuple(Number, String, Boolean)
 *   → a=Number, b=String (the ... absorbs Boolean)
 *
 * Example: Tuple(..., y, z) unifies with Tuple(Number, String, Boolean)
 *   → y=String, z=Boolean (the ... absorbs Number)
 */
/**
 * Unify a spread arrow chain (`a -> b -> ... -> y -> z`) against another
 * function type.  The `...` marker absorbs a variable number of *middle*
 * curried parameters: the params BEFORE the spread match the concrete
 * function's leading params, the params AFTER the spread match its trailing
 * params, the terminal result unifies with the concrete terminal result, and
 * every parameter in between is absorbed by the spread.
 *
 * Mirrors {@link unifySpreadTuple} but for curried arrow chains.
 */
function unifySpreadArrowChain(t1: Type, t2: Type, depth: number): Substitution {
  const f1 = flattenCurriedType(t1);
  const f2 = flattenCurriedType(t2);
  const spread1 = f1.params.findIndex(isSpread);
  const spread2 = f2.params.findIndex(isSpread);

  // Both sides carry a spread: unify shared before/after positionally
  // (shorter side wins) plus the terminal results.
  if (spread1 >= 0 && spread2 >= 0) {
    const before1 = f1.params.slice(0, spread1);
    const after1 = f1.params.slice(spread1 + 1);
    const before2 = f2.params.slice(0, spread2);
    const after2 = f2.params.slice(spread2 + 1);
    let subst = new Substitution();
    const minB = Math.min(before1.length, before2.length);
    for (let i = 0; i < minB; i++) {
      const s = unify(subst.apply(before1[i]), subst.apply(before2[i]), depth + 1);
      subst = s.compose(subst);
    }
    const minA = Math.min(after1.length, after2.length);
    for (let i = 0; i < minA; i++) {
      const s = unify(
        subst.apply(after1[after1.length - minA + i]),
        subst.apply(after2[after2.length - minA + i]),
        depth + 1,
      );
      subst = s.compose(subst);
    }
    const sr = unify(subst.apply(f1.result), subst.apply(f2.result), depth + 1);
    return sr.compose(subst);
  }

  // One side spread, the other concrete.
  const [sp, conc] = spread1 >= 0 ? [f1, f2] : [f2, f1];
  const spreadIdx = sp.params.findIndex(isSpread);
  const before = sp.params.slice(0, spreadIdx);
  const after = sp.params.slice(spreadIdx + 1);

  // Each level of a spread arrow chain consumes a SINGLE argument.  A concrete
  // level written with multiple parameters (`(x, dummy) => …`, typed with a
  // Tuple param) collapses to its first parameter — the surplus params are
  // `undefined` at runtime.  Collapsing here keeps the SpreadArray applier
  // slots single-valued so array elements unify cleanly.
  const concParams = conc.params.map(collapseMultiParamLevel);

  // The concrete side supplies fewer params than the spread chain's fixed
  // before+after.  A spread arrow chain is intentionally variadic, so a shorter
  // concrete chain is a valid instance rather than an error: the concrete
  // function simply "bottoms out" earlier (its terminal result stands in for
  // the whole variadic tail).  This covers a polymorphic annotation result
  // reconciled against a longer inferred chain, a shorter-arity function passed
  // where the chain permits more params, AND a body that collapses the nested
  // currying into a single terminal (e.g. a recursive memoizer inferred as
  // `a -> b | c | d` against `a -> b -> ... -> z`).  Unify as many leading
  // params as supplied and let the concrete terminal absorb the tail.
  if (conc.params.length < before.length + after.length) {
    let subst = new Substitution();
    const n = Math.min(before.length, concParams.length);
    for (let i = 0; i < n; i++) {
      const s = unify(subst.apply(before[i]), subst.apply(concParams[i]), depth + 1);
      subst = s.compose(subst);
    }
    // PARTIAL APPLICATION of a spread-chain CALLEE (result = peeled remainder,
    // not the terminal) is handled context-aware in the call path
    // (`inferCallExpression` → trySpreadChainCalleePeel), NOT here: at the
    // unification level a short concrete side is indistinguishable from a
    // short function ARGUMENT, which must keep bottoming out on the terminal
    // so arity bookkeeping (over-application diagnostics) stays intact.
    // Reconcile the concrete terminal with the spread chain's terminal result
    // so the variadic tail propagates (keeps the call result informative).
    const s = unify(subst.apply(conc.result), subst.apply(sp.result), depth + 1);
    return s.compose(subst);
  }

  let subst = new Substitution();
  for (let i = 0; i < before.length; i++) {
    const s = unify(subst.apply(before[i]), subst.apply(concParams[i]), depth + 1);
    subst = s.compose(subst);
  }
  for (let i = 0; i < after.length; i++) {
    const cIdx = concParams.length - after.length + i;
    const s = unify(subst.apply(after[i]), subst.apply(concParams[cIdx]), depth + 1);
    subst = s.compose(subst);
  }
  // The spread absorbs every middle concrete param; the terminal result of
  // the chain unifies with the concrete terminal result.
  const sr = unify(subst.apply(sp.result), subst.apply(conc.result), depth + 1);
  return sr.compose(subst);
}

function unifySpreadTuple(args1: Type[], args2: Type[], t1: Type, t2: Type, depth = 0): Substitution {
  const spreadIdx1 = args1.findIndex(a => isSpread(a));
  const spreadIdx2 = args2.findIndex(a => isSpread(a));

  // If both have spreads, unify the non-spread elements positionally
  if (spreadIdx1 >= 0 && spreadIdx2 >= 0) {
    const before1 = args1.slice(0, spreadIdx1);
    const after1 = args1.slice(spreadIdx1 + 1);
    const before2 = args2.slice(0, spreadIdx2);
    const after2 = args2.slice(spreadIdx2 + 1);

    // Unify before elements (shorter side)
    let subst = new Substitution();
    const minBefore = Math.min(before1.length, before2.length);
    for (let i = 0; i < minBefore; i++) {
      const s = unify(subst.apply(before1[i]), subst.apply(before2[i]), depth + 1);
      subst = s.compose(subst);
    }
    // Unify after elements (shorter side, from the end)
    const minAfter = Math.min(after1.length, after2.length);
    for (let i = 0; i < minAfter; i++) {
      const s = unify(
        subst.apply(after1[after1.length - minAfter + i]),
        subst.apply(after2[after2.length - minAfter + i]),
        depth + 1,
      );
      subst = s.compose(subst);
    }
    return subst;
  }

  // One side has a spread, the other is concrete
  const [spreadArgs, concreteArgs] = spreadIdx1 >= 0 ? [args1, args2] : [args2, args1];
  const spreadIdx = spreadArgs.findIndex(a => isSpread(a));
  const before = spreadArgs.slice(0, spreadIdx);
  const after = spreadArgs.slice(spreadIdx + 1);

  // The concrete side must have at least as many elements as the non-spread parts
  if (concreteArgs.length < before.length + after.length) {
    throw new UnificationError(t1, t2);
  }

  let subst = new Substitution();

  // Unify "before" elements with the first N concrete elements
  for (let i = 0; i < before.length; i++) {
    const s = unify(subst.apply(before[i]), subst.apply(concreteArgs[i]), depth + 1);
    subst = s.compose(subst);
  }

  // Unify "after" elements with the last M concrete elements
  for (let i = 0; i < after.length; i++) {
    const concreteIdx = concreteArgs.length - after.length + i;
    const s = unify(subst.apply(after[i]), subst.apply(concreteArgs[concreteIdx]), depth + 1);
    subst = s.compose(subst);
  }

  return subst;
}

/** Does `t` contain an application of the kind variable `varId` (`$kv:m:id`)? */
function mentionsKindVar(t: Type, varId: number): boolean {
  switch (t.tag) {
    case 'TCon': {
      const kv = parseKvName(t.name);
      if (kv && kv.varId === varId) return true;
      return t.args.some(a => mentionsKindVar(a, varId));
    }
    case 'TFun': return mentionsKindVar(t.param, varId) || mentionsKindVar(t.result, varId);
    case 'TRecord': return Object.values(t.fields).some(f => mentionsKindVar(f, varId));
    default: return false;
  }
}

/**
 * Unify a value against a WIDER declared type, in one direction: every
 * member of an actual union must unify with some member of the declared
 * union (`ReactElement | Null` fits `ReactElement | String | Null`); for
 * functions the parameters unify and the result widens (covariant).  Used
 * where an annotation is checked against its implementation: symmetric
 * unification rejects two different unions.  Returns the substitution, or
 * null when the actual type is not narrower.
 */
export function unifyWidening(actual: Type, declared: Type): Substitution | null {
  const acc = new Substitution();
  const members = (t: Type): Type[] => {
    const r = acc.apply(t);
    return r.tag === 'TCon' && r.name === T_UNION ? r.args.flatMap(members) : [r];
  };
  const go = (a0: Type, d0: Type): boolean => {
    const a = acc.apply(a0);
    const d = acc.apply(d0);
    if (a.tag === 'TFun' && d.tag === 'TFun') {
      try {
        acc.mergeFrom(unify(acc.apply(a.param), acc.apply(d.param)));
      } catch (e) {
        if (!(e instanceof UnificationError)) throw e;
        return false;
      }
      return go(a.result, d.result);
    }
    const declaredMembers = members(d);
    if (declaredMembers.length < 2) return false;
    return members(a).every(member => declaredMembers.some(m => {
      try {
        acc.mergeFrom(unify(acc.apply(member), acc.apply(m)));
        return true;
      } catch (e) {
        if (!(e instanceof UnificationError)) throw e;
        return false;
      }
    }));
  };
  return go(actual, declared) ? acc : null;
}
