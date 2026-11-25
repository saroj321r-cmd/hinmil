// ============================================================================
// Hindley-Milner Type System — Core Types
//
// WHAT THIS FILE DOES (in plain language)
// ---------------------------------------------------------------------------
// This is the foundation of the whole type checker: it defines how a "type"
// is stored in memory.  Everything else in the project builds on the shapes
// declared here.
//
// Think of types as labels describing what kind of value something is
// ("a Number", "a list of Strings", "a function from Number to Boolean").
// This file provides:
//
//   1. The building blocks (the "Type AST"): TVar (a placeholder for an
//      unknown type), TCon (a named type like Number or Array String),
//      TFun (a function type), TRecord (an object type with named fields),
//      TLabel/TRow (pieces used for "open" objects).  See GLOSSARY.md for
//      a plain-language explanation of each term.
//   2. "Smart constructors" — small helper functions (tVar, tCon, tFun,
//      tRecord, tUnion, ...) that build those blocks correctly, so no other
//      file has to assemble the raw objects by hand.
//   3. Type schemes — reusable, sealed type templates for polymorphic
//      definitions (e.g. `identity :: a -> a` works for ANY a).
//   4. Pretty-printing — turning a type back into the human-readable text
//      shown in hover popups and error messages.
//   5. Small pure helpers for inspecting and combining types.
//
// Nothing in this file performs inference itself; it is purely the
// vocabulary that the inference engine (src/infer/) and the puzzle solver
// (src/hm/unify.ts) speak.
// ============================================================================

// ---------------------------------------------------------------------------
// Type Variable Allocator — encapsulates the fresh-ID counter
//
// Plain language: every "unknown type" placeholder needs a unique serial
// number so two unknowns are never confused with each other.  This class is
// the ticket machine that hands out those numbers, one at a time.
// ---------------------------------------------------------------------------

/**
 * A `TypeVarAllocator` owns a monotonically-increasing counter that is used to
 * generate unique type-variable IDs via {@link tVar}.  Wrapping the counter in
 * an instance makes it possible to run multiple inference sessions without
 * sharing (and accidentally corrupting) a single global counter.
 *
 * For backward compatibility a module-level *active* allocator is maintained
 * and all legacy free-functions (`resetTypeVarCounter`, `saveTypeVarCounter`,
 * `restoreTypeVarCounter`, `freshTypeVarId`) delegate to it.
 */
export class TypeVarAllocator {
  private nextId: number;

  constructor(start = 0) {
    this.nextId = start;
  }

  /** Reset the counter to 0 (or to a specific value). */
  reset(value = 0): void {
    this.nextId = value;
  }

  /** Return the current counter value (for later {@link restore}). */
  save(): number {
    return this.nextId;
  }

  /** Set the counter to a previously saved value. */
  restore(value: number): void {
    this.nextId = value;
  }

  /** Allocate and return the next unique type-variable ID. */
  fresh(): number {
    return this.nextId++;
  }
}

/** The module-level allocator used by all free-standing helper functions. */
let _activeAllocator = new TypeVarAllocator();

/** Return the currently active allocator. */
export function getActiveAllocator(): TypeVarAllocator {
  return _activeAllocator;
}

/**
 * Replace the active allocator.  Returns the previous one so callers can
 * restore it later (e.g. when an import inference finishes).
 */
export function setActiveAllocator(a: TypeVarAllocator): TypeVarAllocator {
  const prev = _activeAllocator;
  _activeAllocator = a;
  return prev;
}

// Backward-compatible free functions — delegate to the active allocator.

export function resetTypeVarCounter(): void {
  _activeAllocator.reset();
}

export function saveTypeVarCounter(): number {
  return _activeAllocator.save();
}

export function restoreTypeVarCounter(value: number): void {
  _activeAllocator.restore(value);
}

export function freshTypeVarId(): number {
  return _activeAllocator.fresh();
}

// ---------------------------------------------------------------------------
// AST node type — shared syntax-tree node alias
// ---------------------------------------------------------------------------

/**
 * Union of all ESTree node types (see `src/estree.ts`).
 *
 * Using `AnyNode` (instead of the base `Node`) gives TypeScript
 * discriminated-union narrowing on `node.type` inside switch statements.
 */
export type AstNode = import('../estree').AnyNode;

// ---------------------------------------------------------------------------
// Type AST — the building blocks every type is made of
//
// Plain language: a type is stored as a small tree of objects.  Each object
// has a `tag` field saying which building block it is (TVar, TCon, TFun, ...),
// plus the details for that block.  For example the type `Array Number` is
// stored as  { tag: 'TCon', name: 'Array', args: [{ tag: 'TCon',
// name: 'Number', args: [] }] }.
// ---------------------------------------------------------------------------

/** A type variable — a placeholder for a type we don't know yet, e.g. `a`.
 *  Comparable to the `x` in school algebra: "some type, to be determined".
 *  Each one carries a unique `id` so two placeholders never collide. */
export interface TVar {
  tag: 'TVar';
  id: number;
  name: string;
  /** Marks the fresh element variable of an EMPTY array literal `[]` that had
   *  no expected element type.  Such a variable carries no information ("the
   *  array is empty, element type unknown"), so two UNBOUND empty-array element
   *  vars compare EQUAL during union dedup (`unionMemberEquivalent`) — collapsing
   *  e.g. `[{ cars::[a] } | { cars::[b] }]` (from `concat([{cars:[]}],[{cars:[]}])`)
   *  into `[{ cars::[a] }]`.  Also lets a strict-empty-array type accept an empty
   *  array literal.  Pure inference metadata; ignored by `structuralEquals`. */
  emptyArray?: boolean;
}

/** A concrete, *named* type, possibly with sub-parts ("arguments"), e.g.
 *  `Number` (no args), `Array String` (one arg: the element type), or the
 *  internal `Union` / `Tuple` markers.  "Con" is short for *constructor*:
 *  the name constructs a full type out of the argument types you give it. */
export interface TCon {
  tag: 'TCon';
  name: string;
  args: Type[];
  /** Marks an array type written as a literal `[]` in a type *annotation* — a
   *  strict, exactly-empty array (analogous to a strict-empty record `{}`).
   *  Such an array must not absorb a concrete element type during unification;
   *  it unifies only with another strict-empty array or with an empty array
   *  literal (whose element var carries {@link TVar.emptyArray}).  The element
   *  arg is retained (`args.length === 1`) so the `Array` 1-arg invariant
   *  holds everywhere; this flag is the discriminator.  Set only by the
   *  type-annotation parser; pure unification metadata. */
  strictEmpty?: boolean;
  /** Parameter tuple of a BUILTIN callback whose positions from this index
   *  on are optional for the callee (`Array#map` passes `(x, i, xs)`, most
   *  callbacks use only `x`).  An as-yet-unknown function passed there is
   *  bound to the short form.  Preserved by `Substitution.apply`. */
  optionalFrom?: number;
  /** Rigid skolem (`§N`) only: the annotation letter it stands for, so code
   *  without access to the engine's skolem map can still display it. */
  skolemName?: string;
  /** Marks a `Union` that is an overload set (from repeated annotations):
   *  its members keep declaration order (see `tUnion`). */
  overloadSet?: boolean;
  /** `String` only: the value of a `const` bound to a string literal
   *  (`const k = "id"`).  Unification ignores it; the directional argument
   *  check accepts the value where that literal is expected. */
  stringLiteral?: string;
  /** Optional display-only hint carrying a parameter record inferred at
   *  call-site post-processing (see `applyPickedProjection` in
   *  `src/infer/calls.ts`).  Used by hover and signature help to
   *  substitute the parameter slot of an instance-callable overload
   *  (e.g. `QueryTag() :: p -> Promise [o]`) when the host TCon's
   *  declared arity does not include a parameter arg.  Carries no
   *  semantic meaning during unification or type printing of the
   *  TCon itself; consumers must opt in to reading it. */
  paramHint?: Type;
}

/** A function type `a -> b`: "takes an `a`, gives back a `b`".  Functions
 *  with several parameters are stored either as a chain of these
 *  (`a -> b -> c`, i.e. curried) or with a Tuple parameter (`(a, b) -> c`). */
export interface TFun {
  tag: 'TFun';
  param: Type;
  result: Type;
}

/** A record/object type `{ field1 :: Type1, field2 :: Type2 }`.
 *
 *  When `rest` is set, the record is **open** (row-polymorphic): the row
 *  variable absorbs additional fields during unification, modelling the
 *  `{ x, ...rest }` JavaScript spread/rest pattern.  When undefined, the
 *  record is closed (the historical default — preserved for back-compat).
 */
export interface TRecord {
  tag: 'TRecord';
  fields: Record<string, Type>;
  /** Row variable for open records.  Unifies with a TRecord of leftover
   *  fields when this record is unified against another with extra keys.
   *
   *  Historically this was a plain {@link TVar}; W2 introduced the
   *  disjoint {@link TRow} sort and TRecord.rest now accepts either —
   *  the migration to row-only happens incrementally as call-sites are
   *  audited.  Mixed shapes are valid: a TVar in rest position behaves
   *  as a row by virtue of its position (i.e. it can never resolve to a
   *  non-record without unification failing). */
  rest?: TVar | TRow;
  /** Optional alias name for display (e.g. 'Person' instead of the expanded fields). */
  alias?: string;
  /** Marks a record written as a literal `{}` in a type *annotation* — a
   *  strict, closed, exactly-empty object.  Such a record must not absorb
   *  surplus fields during unification (unlike inferred empty object literals,
   *  which stay open/lenient so growing objects still type-check).  Set only
   *  by the type-annotation parser; pure unification metadata. */
  strictEmpty?: boolean;
  /** Rigid skolem (`§N`) only: the annotation letter it stands for, so code
   *  without access to the engine's skolem map can still display it. */
  skolemName?: string;
  /** When this record was produced by a `Picked R sel` projection, holds
   *  the source row name `R`.  Survives the `alias`-stripping that
   *  inlines the projection in hover output, so unification can still
   *  match the record against `Picked R _` slot expectations in selector
   *  unions (e.g. a `…Selector` branch like `QueryTag p (Picked LocationRow a)`).
   *  Generic mechanism — any library that uses `Picked` benefits, not
   *  just query-builder. */
  pickedFrom?: string;
  /** Set on a `Picked` projection whose selection named no columns: the
   *  "all columns" result is a fallback for running the query by itself,
   *  not a selection — in a `Merge` (e.g. `QueryTag#concat`) such a record
   *  is the identity and the other operands decide the fields. */
  defaultProjection?: boolean;
  /** Polymorphic-label fields, e.g. `{ [k] :: a }` where `k` is a label
   *  variable.  Once `k` resolves to a literal label, the entry migrates
   *  to {@link fields} during substitution.  Keeping these separate from
   *  string-keyed `fields` avoids ambiguous encoding while the label is
   *  still a variable. */
  labelFields?: Array<{ label: TLabel; type: Type }>;
  /** Per-field type schemes captured at annotated member assignment time.
   *  When a member is assigned via `Obj.X = func` and an HM annotation
   *  `// X :: Obj.X :: ...` (or `// Obj.X :: ...`) is in scope, the
   *  scheme is recorded here in addition to the instantiated type going
   *  into {@link fields}.  Member-access reads (e.g. `Obj.X(args)` or
   *  `aliased.X(args)` after `const aliased = Obj`) re-instantiate the
   *  scheme freshly per use site so argument unification AND constraint
   *  validation happen at the call site, not at the assignment site.
   *  Pure inference metadata: ignored by `unify`/`structuralEquals`. */
  fieldSchemes?: Record<string, Scheme>;
  /** Optional per-field display strings used by `typeToString` to render
   *  fields whose declared form cannot be reconstructed from the stored
   *  field type alone — e.g. a method annotation
   *  `// Array#chain :: builtIn.Array :: Array a ~> (a -> Array b) -> Array b`
   *  stores the method-type (right of `~>`) as the field type, but hover
   *  on the host record should still show the full `Array a ~> …` form.
   *  Pure display metadata: ignored by `unify`/`structuralEquals`. */
  fieldDisplays?: Record<string, string>;
  /** Field names that were marked with a `// ::hidden` (or `// ::private`)
   *  directive directly above the property in an object literal.  Kept on
   *  the type so completion/hover can filter them while structural
   *  unification still sees the underlying field.  Pure metadata:
   *  ignored by `unify`. */
  hiddenFields?: Set<string>;
  /** Set by `tryExpandRowMap` on a label-group result row that also carries
   *  an open `...b` tail (e.g. the annotation `({ [k]::a }, {...b}) -> { [k]::a, ...b }`).
   *  Signals that when the row variable resolves to a concrete record during
   *  `Substitution.apply`, overlapping keys must be DEEP-merged
   *  (`deepMergeTypes`) rather than first-wins kept — so a spread-merge
   *  combines `likedTypes::[String]` and `likedTypes::[Number]` into
   *  `[String | Number]`.  Pure inference metadata: ignored by `unify`. */
  mergeRow?: boolean;
}

/** A field-label type, used by row polymorphism's presence/absence constraints.
 *  A label is either a concrete literal (e.g. `'x'`) — `kind: 'lit'` —
 *  or a label variable that ranges over labels — `kind: 'var'`.
 *  Label vars participate in unification just like ordinary type vars
 *  but live in a separate sort: they unify only with other labels. */
export interface TLabelLit {
  tag: 'TLabel';
  kind: 'lit';
  value: string;
}
export interface TLabelVar {
  tag: 'TLabel';
  kind: 'var';
  id: number;
  name: string;
}
export type TLabel = TLabelLit | TLabelVar;

/** A row variable — a separate sort from {@link TVar}.  Row variables
 *  inhabit only the rest-position of records, where they absorb the
 *  set of remaining fields during row-unification.  Distinguishing them
 *  from ordinary type variables eliminates the historical conflation of
 *  "type-of-type" vs. "row-of-fields" in `TRecord.rest` and lets the
 *  pretty-printer render them with the distinctive `...r` syntax.
 *
 *  TRow ids live in the SAME counter as TVar ids — they are still
 *  produced via {@link freshTypeVarId} so that all-vars set tracking
 *  (e.g. occurs-check) does not need a second id space; the disjointness
 *  is enforced by `tag` only. */
export interface TRow {
  tag: 'TRow';
  id: number;
  name: string;
}

/** A nested universal quantifier — the rank-N building block.
 *
 *  Plain language: `forall a. a -> a` as a *type* (not a scheme).  A
 *  `TForall` appears only in NESTED positions — e.g. as a function
 *  parameter (`(forall a. a -> a) -> b`, rank-2) or a record field value.
 *  Top-level / result-position quantifiers are hoisted into the enclosing
 *  {@link Scheme} by the parser (prenex normalization), so a `TForall`
 *  node always marks a place where the CALLEE chooses the instantiation
 *  (the caller must supply a genuinely polymorphic value).
 *
 *  Invariants:
 *  - `vars` ids are globally fresh and occur ONLY inside `body` — they are
 *    never bound in the engine substitution and never quantified by any
 *    enclosing Scheme.
 *  - `constraints` (optional) scope over `vars`, e.g.
 *    `forall f. Functor f => (a -> f a)`. */
export interface TForall {
  tag: 'TForall';
  /** Bound type-variable ids (fresh, scoped to `body`). */
  vars: number[];
  /** Source names of the bound variables, parallel to `vars`. */
  varNames: string[];
  /** Constraints scoped to the bound variables (`forall f. Functor f => …`). */
  constraints?: Constraint[];
  /** The quantified body type. */
  body: Type;
}

export type Type = TVar | TCon | TFun | TRecord | TLabel | TRow | TForall;

// ---------------------------------------------------------------------------
// Type Scheme (polytypes)
//
// Plain language: a *scheme* is a sealed, reusable type template.  When a
// definition like `identity = x => x` is finished, its leftover placeholders
// are "sealed in" (the `vars` list below), producing the template
// `a -> a`.  Every place that later *uses* identity gets its own fresh copy
// of `a` — so one call site can use it with Numbers and another with Strings
// without the two interfering.  A scheme can also carry extra requirements
// (constraints) and various bits of behavioural metadata.
// ---------------------------------------------------------------------------

/** A type class constraint, e.g. `Functor f` or `Monoid (f a)`,
 *  or a structural-union constraint like `((a -> Number) | Number) run`. */
export interface Constraint {
  className: string;
  typeVarName: string;
  /** Branch-specific bound var id this constraint targets.  Set by
   *  {@link mergeOverloadSchemes} when combining overload branches so a
   *  constraint from one branch (e.g. `Semigroupoid c`) attaches to ITS OWN
   *  branch's `c` var rather than colliding by name with a same-named var in
   *  another branch.  When present, instantiation resolves the fresh var id
   *  through the id map instead of the (ambiguous) name map. */
  varId?: number;
  /** True when the constraint uses applied syntax, e.g. `Monoid (f a)`.
   *  Applied constraints target the constructor of the applied type. */
  isApplied?: boolean;
  /** Inner type-variable names from applied constraints, e.g. `['a']` for `Monoid (f a)`.
   *  A nested application renders as one compound entry, e.g. `['(t a)']` for
   *  `Setoid (f (t a))`. */
  appliedArgNames?: string[];
  /** Parsed inner argument TYPES from applied constraints — parallel to
   *  `appliedArgNames`.  Plain vars are TVars; a nested application
   *  (`Setoid (f (t a))`) is the same kv-encoded TCon the signature body
   *  would produce for `t a`. */
  appliedArgs?: Type[];
  /** When set, this is an inline anonymous structural-union constraint
   *  written as `(T1 | T2 | …) v =>`. The constrained type variable must
   *  unify with one of the listed alternative types (left-to-right).
   *  `className` then holds a synthetic display string. */
  unionAlternatives?: Type[];
  /** Positional type arguments supplied at the use site for a structural
   *  constraint defined as `::constraint Name p1 p2 … pN = …`. Each entry
   *  may be a TVar (use-site bound) or a concrete type. Matches the def's
   *  `headerParams` positionally. `typeVarName` mirrors the LAST positional
   *  arg when it is a bare TVar (so existing nominal-style consumers keep
   *  reading it); when the last positional arg is concrete, `typeVarName`
   *  is set to the synthetic placeholder '_concrete'. */
  positionalArgs?: Type[];
}

/** A type predicate for narrowing, attached via `::narrow` on a Boolean-returning function annotation */
export interface TypePredicate {
  /** The type-variable name of the parameter that gets narrowed (e.g. 'a').
   *  May be empty when the narrowed parameter is not a bare type variable
   *  (e.g. a record parameter like `{ [k] :: a }`). */
  paramName: string;
  /** The (0-based) curried-parameter index that gets narrowed.  For a simple
   *  `a -> Boolean` predicate this is 0; for a multi-parameter predicate such
   *  as `k -> { [k] :: a } -> Boolean` it is the index of the LAST parameter
   *  (the value being tested), here 1. */
  paramIndex: number;
  /** The type to narrow to when the predicate returns true (e.g. String) */
  narrowedType: Type;
  /** The label-variable name referenced in {@link narrowedType} (e.g. 'k' in
   *  `{ [k] :: a }`).  When set, the call-site narrowing substitutes this
   *  label var with the concrete key argument supplied at {@link keyParamIndex}
   *  (when that argument is a string literal). */
  keyVarName?: string;
  /** The (0-based) curried-parameter index supplying the value for
   *  {@link keyVarName} — the index of the signature parameter whose type
   *  variable name matches the label var (e.g. 0 for the `k` in
   *  `k -> { [k] :: a } -> Boolean`). */
  keyParamIndex?: number;
}

/** Conditional return type info for literal equality or truthiness guards in function bodies.
 * When a function has `if (param === literal) { return T; }` or `if (param) { return T; }`,
 * this records the param position and the matching return type string
 * so the return type union can be narrowed at call sites. */
export interface ConditionalReturn {
  paramIndex: number;
  matchReturnTypeStr: string;  // typeToString of the return type when the guard matches
  literalValue?: string | number | boolean | bigint | RegExp | null;          // for equality guards (if param === value)
  isTruthiness?: boolean;      // true for truthiness guards (if (param))
}

export interface Scheme {
  vars: number[];   // bound type-variable ids
  type: Type;
  constraints?: Constraint[];  // type class constraints, e.g. [{ className: 'Functor', typeVarName: 'f' }]
  typePredicate?: TypePredicate;  // type predicate for narrowing (from ::narrow)
  isCurriedResult?: boolean;  // marks a function produced by a curry wrapper (enables multi-arg calls)
  isCurryWrapper?: boolean;  // marks a curry wrapper function itself (propagated across imports)
  /** curryN-style wrapper: number of leading arguments before the function
   *  to curry (`curryN :: Number -> ((a, b, ...) -> z) -> a -> b -> ... -> z`). */
  curryLeadingArgs?: number;
  conditionalReturn?: ConditionalReturn;  // literal guard return narrowing (from if (param === literal) { return T; })
  optionalParamSlots?: number[];  // 0-based indices of trailing tuple-param slots that have JS body defaults (callable with fewer args)
  /** `::rep` representatives attached to a constrained function.  Each entry
   *  lets a container type discharge a constraint method (constraint, typeName,
   *  methodName) via the local representing `signature` — but ONLY while
   *  discharging THIS function's constraints (call-scoped, not global).  See
   *  RepEntry.  Travels with the scheme across the import boundary. */
  reps?: RepEntry[];
  /** Display-only override: the **annotation** type to show for this binding,
   *  regardless of how body inference later substitutes its vars.  Set on
   *  annotated function parameters so hover/usages always render the signature
   *  form (`{ a }`, `{ x :: Number }`, …) instead of a body-poisoned type.
   *  Dropped by control-flow narrowing (which rebinds via plain `mono`), so an
   *  accepted narrow inside e.g. `if (!b) { … }` still shows the narrowed type. */
  frozenDisplay?: Type;
  /** True when the scheme's type contains a nested {@link TForall} (rank-N
   *  annotation).  Cached at parse time so hot paths can gate all rank-N
   *  handling behind a single boolean check. */
  hasForall?: boolean;
}

/** A `::rep <Constraint> <Type#method>` representative.  Declares that the
 *  named container method (already annotated locally in the declaring file)
 *  stands in for the constraint's like-named method when satisfying that
 *  constraint — scoped to the function that carries it.  `signature` is the
 *  resolved local annotation signature (form-exact, see Fase 2). */
export interface RepEntry {
  constraint: string;
  typeName: string;
  methodName: string;
  signature: string;
  /** True when the rep was declared with `Type.method` (a static constraint
   *  method, no `~>` receiver); false/undefined for instance reps. */
  isStatic?: boolean;
}

// ---------------------------------------------------------------------------
// Smart constructors
//
// Plain language: helper functions that assemble the building blocks above.
// The rest of the codebase calls these instead of writing the raw objects by
// hand, so invariants (unique ids, default names) live in exactly one place.
// ---------------------------------------------------------------------------

/** Create a fresh type variable (a brand-new "unknown type" placeholder)
 *  with a unique id.  Without an explicit name it gets an auto name like
 *  `t42` — the pretty-printer later renames those to `a`, `b`, `c`, … */
export function tVar(name?: string): TVar {
  const id = freshTypeVarId();
  return { tag: 'TVar', id, name: name ?? `t${id}` };
}

/** Smart constructor for a fresh row-variable.  Used by the parser when
 *  it sees `{ ...r }` with a lowercase identifier, and by destructure
 *  inference (`{ a, ...rest }` patterns) to allocate the row-tail. */
export function tRow(name?: string): TRow {
  const id = freshTypeVarId();
  return { tag: 'TRow', id, name: name ?? `r${id}` };
}

/** Create a named type, e.g. `tCon('Number')` or `tCon('Array', [elem])`. */
export function tCon(name: string, args: Type[] = []): TCon {
  return { tag: 'TCon', name, args };
}

/** Create a function type `param -> result`. */
export function tFun(param: Type, result: Type): TFun {
  return { tag: 'TFun', param, result };
}

/** Create a nested universal quantifier (rank-N position), e.g.
 *  `forall a. a -> a` as used inside `(forall a. a -> a) -> b`. */
export function tForall(
  vars: number[],
  varNames: string[],
  body: Type,
  constraints?: Constraint[],
): TForall {
  const out: TForall = { tag: 'TForall', vars, varNames, body };
  if (constraints && constraints.length > 0) out.constraints = constraints;
  return out;
}

/** Does the type contain a nested {@link TForall} anywhere? */
export function containsForall(t: Type): boolean {
  switch (t.tag) {
    case 'TForall': return true;
    case 'TCon': return t.args.some(containsForall);
    case 'TFun': return containsForall(t.param) || containsForall(t.result);
    case 'TRecord': {
      for (const k in t.fields) { if (containsForall(t.fields[k])) return true; }
      if (t.labelFields) {
        for (const lf of t.labelFields) { if (containsForall(lf.type)) return true; }
      }
      return false;
    }
    case 'TVar':
    case 'TLabel':
    case 'TRow':
      return false;
  }
}

/** Create a type scheme: `type` with the variable ids in `vars` sealed in
 *  (universally quantified — "works for any choice of these variables"). */
export function scheme(vars: number[], type: Type): Scheme {
  return { vars, type };
}

/** Create a monomorphic scheme (no quantified variables) */
export function mono(type: Type): Scheme {
  return { vars: [], type };
}

/** Monomorphic scheme carrying a display-only `frozenDisplay` override.  Used
 *  for annotated function parameters: `type` participates in body inference as
 *  usual, while `frozenDisplay` (the annotation) is what hover renders for the
 *  parameter and every reference to it.  Defaults `frozenDisplay` to `type`. */
export function monoFrozen(type: Type, frozen: Type = type): Scheme {
  return { vars: [], type, frozenDisplay: frozen };
}

// ---------------------------------------------------------------------------
// Built-in type name constants (prevent typos, enable rename-refactoring)
// ---------------------------------------------------------------------------

export const T_ARRAY  = 'Array';
// Reserved (`$`-prefixed) so a user type named `Tuple` (FP-library's
// `Tuple :: (Number, Array a) -> Tuple Number a`) is never mistaken for the
// internal multi-parameter tuple.
export const T_TUPLE  = '$Tuple';
export const T_UNION  = 'Union';
export const T_SPREAD_ARRAY = 'SpreadArray';
export const T_ERROR  = '$error';
export const T_NUMBER = 'Number';
export const T_STRING = 'String';
export const T_BOOLEAN = 'Boolean';
export const T_TYPEREP = 'TypeRep';
/** The two built-ins with mandatory children: `Function [params] result`
 *  and `Object k a`.  Both are kept in applied `TCon` form for display but
 *  are pure sugar over `TFun` / `TRecord` (see `desugarFunctionType` /
 *  `desugarObjectType`). */
export const T_FUNCTION = 'Function';
export const T_OBJECT = 'Object';
/** Reserved TCon name for inline call-site record projection.  A signature
 *  such as `[a] -> QueryTag (Picked R a)` tells the call-expression
 *  post-processor in `src/infer/calls.ts` to inspect the call's literal
 *  array argument and replace `Picked R a` with a record built from the
 *  array's elements (string-literal columns become row-field types,
 *  identifiers of `Prop T` type contribute named fields, nested calls of
 *  type `QueryTag YRow` resolve via the parent row's method-shadows).
 *  Generic — not coupled to any one library. */
export const T_PICKED = 'Picked';
/** Reserved TCon name for structural record-union reduction.  An
 *  annotation such as `QueryTag#concat :: QueryTag p1 r1 ~> QueryTag p2 r2 ->
 *  QueryTag (Merge p1 p2) (Merge r1 r2)` tells the call-expression
 *  post-processor in `src/infer/calls.ts` to collapse each `Merge a b`
 *  whose args resolve to two TRecords into a single structural-union
 *  record (alias-stripped).  Conflicting field types are unified.
 *  Generic — usable by any combinator that merges row + param shapes. */
export const T_MERGE = 'Merge';

// ---------------------------------------------------------------------------
// Type predicates (common tag+name checks used across the codebase)
// ---------------------------------------------------------------------------

/** Is `t` a TCon with the given name? */
export function isTCon(t: Type, name: string): t is TCon {
  return t.tag === 'TCon' && t.name === name;
}

/** Is `t` a Union type? (`TCon('Union', [...])`) */
export function isUnion(t: Type): t is TCon {
  return t.tag === 'TCon' && t.name === T_UNION;
}

/** Is `t` a Tuple type? (`TCon('Tuple', [...])`) */
export function isTuple(t: Type): t is TCon {
  return t.tag === 'TCon' && t.name === T_TUPLE;
}

/** Is `t` the `$error` sentinel produced by failed property accesses? */
export function isErrorType(t: Type): boolean {
  return t.tag === 'TCon' && t.name === T_ERROR;
}

/** Does any subtree of `t` contain the `$error` sentinel?  Used by hover
 *  to suppress display lines that have been polluted by error recovery
 *  poisoning (where free type variables in a failed unification are bound
 *  to `$error` to stop diagnostic cascades). */
export function containsErrorType(t: Type): boolean {
  if (t.tag === 'TCon' && t.name === T_ERROR) return true;
  if (t.tag === 'TCon') return (t.args ?? []).some(containsErrorType);
  if (t.tag === 'TFun') return containsErrorType(t.param) || containsErrorType(t.result);
  if (t.tag === 'TRecord') return Object.values(t.fields).some(containsErrorType);
  return false;
}

// ---------------------------------------------------------------------------
// Built-in types
// ---------------------------------------------------------------------------

export const tNumber: TCon  = tCon('Number');
export const tString: TCon  = tCon('String');
export const tBool: TCon    = tCon('Boolean');
export const tBigInt: TCon  = tCon('BigInt');
export const tSymbol: TCon  = tCon('Symbol');
export const tNull: TCon    = tCon('Null');
export const tUndefined: TCon = tCon('Undefined');
export const tVoid: TCon    = tCon('Void');

// Sanctuary / HM built-in types
export const T_ANY_TYPE = 'Any';
export const tAnyType: TCon          = tCon(T_ANY_TYPE);
export const tObject: TCon            = tCon('Object');
export const tBuffer: TCon            = tCon('Buffer');
export const tInteger: TCon           = tCon('Integer');
export const tFloat: TCon             = tCon('Float');
export const tDouble: TCon            = tCon('Double');
export const tNonNegativeInteger: TCon = tCon('NonNegativeInteger');
export const tNegativeInteger: TCon   = tCon('NegativeInteger');
export const tPositiveNumber: TCon    = tCon('PositiveNumber');
export const tNegativeNumber: TCon    = tCon('NegativeNumber');
export const tValidNumber: TCon       = tCon('ValidNumber');
export const tNonZeroValidNumber: TCon = tCon('NonZeroValidNumber');
export const tFiniteNumber: TCon      = tCon('FiniteNumber');
export const tNonZeroFiniteNumber: TCon = tCon('NonZeroFiniteNumber');
export const tPositiveFiniteNumber: TCon = tCon('PositiveFiniteNumber');
export const tNegativeFiniteNumber: TCon = tCon('NegativeFiniteNumber');
export const tNonZeroInteger: TCon    = tCon('NonZeroInteger');
export const tPositiveInteger: TCon   = tCon('PositiveInteger');
export function tStrMap(val: Type): TCon {
  return tCon('StrMap', [val]);
}

/** Check if a type is the `Any` top type (unifies with everything, but is a real named type). */
export function isAnyType(t: Type): boolean {
  return t.tag === 'TCon' && t.name === T_ANY_TYPE && t.args.length === 0;
}

/** Numeric subtypes of Number.  These are Sanctuary refinement types that
 *  should unify with `Number` (and with each other) because JS only has a
 *  single `number` runtime type. */
export const NUMERIC_SUBTYPES: ReadonlySet<string> = new Set([
  'Integer', 'Float', 'Double', 'NonNegativeInteger', 'NegativeInteger',
  'PositiveNumber', 'NegativeNumber', 'ValidNumber', 'NonZeroValidNumber',
  'FiniteNumber', 'NonZeroFiniteNumber', 'PositiveFiniteNumber', 'NegativeFiniteNumber',
  'NonZeroInteger', 'PositiveInteger',
]);

/** Is this type `Number` or one of its Sanctuary subtypes? */
export function isNumericType(t: Type): boolean {
  return t.tag === 'TCon' && t.args.length === 0 &&
    (t.name === 'Number' || NUMERIC_SUBTYPES.has(t.name));
}

/**
 * Numeric subtype hierarchy (widening direction):
 *   NonNegativeInteger, NegativeInteger  ⊂  Integer  ⊂  Float ≈ Double  ⊂  Number
 *
 * Plain language: some number types are more specific versions of others —
 * every PositiveInteger is also an Integer, and every Integer is also a
 * Number.  This table lists, for each specific type, all the broader types
 * it may safely be treated as ("widened" to).
 */
const NUMERIC_SUPERTYPES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Integer subtypes
  ['PositiveInteger',      new Set(['NonNegativeInteger', 'NonZeroInteger', 'Integer', 'PositiveFiniteNumber', 'NonZeroFiniteNumber', 'FiniteNumber', 'NonZeroValidNumber', 'ValidNumber', 'PositiveNumber', 'Float', 'Double', 'Number'])],
  ['NonNegativeInteger',   new Set(['Integer', 'FiniteNumber', 'ValidNumber', 'Float', 'Double', 'Number'])],
  ['NegativeInteger',      new Set(['NonZeroInteger', 'Integer', 'NegativeFiniteNumber', 'NonZeroFiniteNumber', 'FiniteNumber', 'NonZeroValidNumber', 'ValidNumber', 'NegativeNumber', 'Float', 'Double', 'Number'])],
  ['NonZeroInteger',       new Set(['Integer', 'NonZeroFiniteNumber', 'FiniteNumber', 'NonZeroValidNumber', 'ValidNumber', 'Float', 'Double', 'Number'])],
  ['Integer',              new Set(['FiniteNumber', 'ValidNumber', 'Float', 'Double', 'Number'])],
  // FiniteNumber subtypes
  ['PositiveFiniteNumber', new Set(['NonZeroFiniteNumber', 'FiniteNumber', 'NonZeroValidNumber', 'ValidNumber', 'PositiveNumber', 'Float', 'Double', 'Number'])],
  ['NegativeFiniteNumber', new Set(['NonZeroFiniteNumber', 'FiniteNumber', 'NonZeroValidNumber', 'ValidNumber', 'NegativeNumber', 'Float', 'Double', 'Number'])],
  ['NonZeroFiniteNumber',  new Set(['FiniteNumber', 'NonZeroValidNumber', 'ValidNumber', 'Float', 'Double', 'Number'])],
  ['FiniteNumber',         new Set(['ValidNumber', 'Float', 'Double', 'Number'])],
  // ValidNumber subtypes
  ['NonZeroValidNumber',   new Set(['ValidNumber', 'Float', 'Double', 'Number'])],
  ['ValidNumber',          new Set(['Float', 'Double', 'Number'])],
  // Number subtypes
  ['PositiveNumber',       new Set(['Float', 'Double', 'Number'])],
  ['NegativeNumber',       new Set(['Float', 'Double', 'Number'])],
  ['Float',                new Set(['Double', 'Number'])],
  ['Double',               new Set(['Float', 'Number'])],
]);

/** May the numeric type named `sub` be safely treated as `sup`?
 *  E.g. `isNumericSubtypeOf('Integer', 'Number')` → true. */
export function isNumericSubtypeOf(sub: string, sup: string): boolean {
  if (sub === sup) return true;
  return NUMERIC_SUPERTYPES.get(sub)?.has(sup) ?? false;
}

/** Create an array type `[elem]` — "a list whose elements are all `elem`". */
export function tArray(elem: Type): TCon {
  return tCon(T_ARRAY, [elem]);
}

/** A spread/variadic marker in tuple types: (a, ..., z) */
export const tSpread: TCon = tCon('...');

/** Check if a type is a spread marker. */
export function isSpread(t: Type): boolean {
  return t.tag === 'TCon' && t.name === '...' && t.args.length === 0;
}

/** A wildcard type that unifies with anything (no substitution produced). */
export const tAny: TCon = tCon('*');

/** Wildcard prefix for named wildcards: '*:name' */
const WILDCARD_PREFIX = '*';

/** Check if a type is a wildcard (either bare '*' or named '*:name'). */
export function isWildcard(t: Type): boolean {
  return t.tag === 'TCon' && t.name.startsWith(WILDCARD_PREFIX) && t.args.length === 0;
}

/** Create a named wildcard for a particular annotation var name. */
export function tNamedWildcard(varName: string): TCon {
  return tCon(`*:${varName}`);
}

/** Extract the display name from a wildcard type. Returns the var name
 *  for named wildcards, or '*' for the bare wildcard. */
export function wildcardDisplayName(t: Type): string {
  if (t.tag === 'TCon' && t.name.startsWith('*:')) {
    return t.name.slice(2);
  }
  return '*';
}

/** Structural equality check: are `a` and `b` the exact same type, compared
 *  piece by piece?  ("Structural" = we compare the tree contents, not object
 *  identity.)  O(tree size) but avoids allocating a string representation. */
export function structuralEquals(a: Type, b: Type): boolean {
  if (a === b) return true;
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case 'TVar': return a.id === (b as typeof a).id;
    case 'TCon': {
      const bc = b as typeof a;
      return a.name === bc.name && a.args.length === bc.args.length &&
        a.args.every((arg, i) => structuralEquals(arg, bc.args[i]));
    }
    case 'TFun': {
      const bf = b as typeof a;
      return structuralEquals(a.param, bf.param) && structuralEquals(a.result, bf.result);
    }
    case 'TRecord': {
      const br = b as typeof a;
      const aKeys = Object.keys(a.fields);
      const bKeys = Object.keys(br.fields);
      const sameRest =
        (a.rest === undefined && br.rest === undefined) ||
        (a.rest !== undefined && br.rest !== undefined && a.rest.id === br.rest.id);
      // Nominal aliases (e.g. `CaregiverRow` vs `EmployeeRow`, both
      // expanding to `{ id :: Number }`) must remain distinct in
      // structural comparisons — otherwise union dedup in `tUnion`
      // collapses `Picked CaregiverRow a` and `Picked EmployeeRow a`
      // into a single member, making subsequent relation-validation
      // see only one of the two rows as "valid".
      if (a.alias !== br.alias) return false;
      if (a.pickedFrom !== br.pickedFrom) return false;
      return sameRest && aKeys.length === bKeys.length &&
        aKeys.every(k => k in br.fields && structuralEquals(a.fields[k], br.fields[k]));
    }
    case 'TLabel': {
      const bl = b as typeof a;
      if (a.kind !== bl.kind) return false;
      if (a.kind === 'lit') return a.value === (bl as TLabelLit).value;
      return a.id === (bl as TLabelVar).id;
    }
    case 'TRow': return a.id === (b as typeof a).id;
    case 'TForall': {
      // TForall nodes are created once per annotation and shared by
      // reference, so strict comparison (same binder ids + same body) is
      // sufficient here.  Alpha-equivalence across DIFFERENT annotations is
      // handled during unification (binder renaming in unifyCore).
      const bq = b as typeof a;
      return a.vars.length === bq.vars.length &&
        a.vars.every((v, i) => v === bq.vars[i]) &&
        structuralEquals(a.body, bq.body);
    }
  }
}

/** Like {@link structuralEquals}, but two UNBOUND empty-array element variables
 *  (see {@link TVar.emptyArray}) compare EQUAL regardless of their id.  Used
 *  ONLY by {@link tUnion} dedup so union members that differ solely in a fresh
 *  empty-array element var collapse to a single member.  Kept separate from
 *  `structuralEquals` to avoid relaxing equality anywhere else (occurs-checks,
 *  general inference comparisons). */
export function unionMemberEquivalent(a: Type, b: Type): boolean {
  if (a === b) return true;
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case 'TVar': {
      const bv = b as typeof a;
      if (a.id === bv.id) return true;
      return a.emptyArray === true && bv.emptyArray === true;
    }
    case 'TCon': {
      const bc = b as typeof a;
      return a.name === bc.name && a.args.length === bc.args.length &&
        a.args.every((arg, i) => unionMemberEquivalent(arg, bc.args[i]));
    }
    case 'TFun': {
      const bf = b as typeof a;
      return unionMemberEquivalent(a.param, bf.param) && unionMemberEquivalent(a.result, bf.result);
    }
    case 'TRecord': {
      const br = b as typeof a;
      const aKeys = Object.keys(a.fields);
      const bKeys = Object.keys(br.fields);
      const sameRest =
        (a.rest === undefined && br.rest === undefined) ||
        (a.rest !== undefined && br.rest !== undefined && a.rest.id === br.rest.id);
      if (a.alias !== br.alias) return false;
      if (a.pickedFrom !== br.pickedFrom) return false;
      return sameRest && aKeys.length === bKeys.length &&
        aKeys.every(k => k in br.fields && unionMemberEquivalent(a.fields[k], br.fields[k]));
    }
    case 'TLabel': {
      const bl = b as typeof a;
      if (a.kind !== bl.kind) return false;
      if (a.kind === 'lit') return a.value === (bl as TLabelLit).value;
      return a.id === (bl as TLabelVar).id;
    }
    case 'TRow': return a.id === (b as typeof a).id;
    case 'TForall': {
      const bq = b as typeof a;
      return a.vars.length === bq.vars.length &&
        a.vars.every((v, i) => v === bq.vars[i]) &&
        unionMemberEquivalent(a.body, bq.body);
    }
  }
}

/**
 * Build a union type (`Number | String | …`) from a list of members.
 *
 * Plain language: a union means "the value is ONE of these types".  This
 * builder does three jobs so unions stay small and predictable:
 *   1. flattens unions nested inside unions,
 *   2. removes duplicate members,
 *   3. sorts the members into a canonical order so the same set of types
 *      always prints identically.
 * A single-member union collapses to just that member.
 */
export function tUnion(types: Type[], opts?: { overloadSet?: boolean }): Type {
  // Defensive cap: structural deduplication below is O(n²); on
  // pathological input (auto-union runaway, malformed annotation, ...)
  // an unbounded `types` array would freeze the language server.
  // Real-world query-builder Selector unions can exceed 32 (cols + Prop a +
  // 20+ QueryTag X + 20+ Table X + Limit + Offset + SQLTag a), so the
  // cap is set generously while still bounding worst-case work.
  const MAX_UNION_MEMBERS = 256;
  // Flatten nested unions and deduplicate members structurally.  Flattening
  // is essential: members built via substitution/instantiation of a
  // polymorphic result (e.g. Array.concat `[a | b]` where a/b are themselves
  // unions) arrive as nested T_UNION nodes.  Without flattening, two nested
  // unions are compared as opaque members and duplicates survive
  // (e.g. `Number | String | Number | Boolean`).
  const unique: Type[] = [];
  let capped = false;
  let absorbed = false;
  const addMember = (t: Type): void => {
    if (capped || absorbed) return;
    if (t.tag === 'TCon' && t.name === T_UNION) {
      for (const m of t.args) addMember(m);
      return;
    }
    // A bare wildcard absorbs the whole union: `X | *` ≡ `*` (the author
    // explicitly does not care).  Annotation style from task libraries
    // (`fork :: (…) -> * | (() -> ())`) would otherwise survive as a
    // union whose members fail downstream checks ("not callable").
    // NAMED wildcards (`*:name`) carry identity and are NOT absorbed.
    if (t.tag === 'TCon' && t.name === WILDCARD_PREFIX && t.args.length === 0) {
      absorbed = true;
      return;
    }
    if (!unique.some(u => unionMemberEquivalent(u, t))) {
      unique.push(t);
      if (unique.length >= MAX_UNION_MEMBERS) capped = true;
    }
  };
  for (const t of types) {
    addMember(t);
    if (capped || absorbed) break;
  }
  if (absorbed) return tAny;
  if (unique.length === 1) return unique[0];
  if (unique.length === 0) return types[0];
  // An OVERLOAD SET (repeated `name ::` annotations) keeps declaration order:
  // overload resolution tries branches in that order and the first that
  // unifies (and satisfies its constraints) wins — README › Overloading.
  // Every other union is sorted canonically below.
  if (opts?.overloadSet) return { tag: 'TCon', name: T_UNION, args: unique, overloadSet: true };
  // Canonical member ordering: sort lexicographically by rendered type so
  // that the *same set* of members always renders identically regardless of
  // the construction order (`mergeUnion(a, b)` vs `mergeUnion(b, a)`,
  // different inference paths, etc.).  Array.sort is stable (ES2019+), so
  // members that stringify equally keep their relative encounter order.
  // Decorate-sort-undecorate: render each member once instead of on every
  // comparison (typeToString is expensive on deep types).
  const decorated = unique.map((t, i) => ({ t, key: typeToString(t), i }));
  decorated.sort((a, b) => {
    const c = a.key.localeCompare(b.key);
    return c !== 0 ? c : a.i - b.i;
  });
  return tCon(T_UNION, decorated.map(d => d.t));
}

/** A tuple type for multi-parameter functions: (A, B) -> C */
export function tTuple(types: Type[]): TCon {
  return tCon(T_TUPLE, types);
}

/**
 * Build a function type from parameter types and a return type.
 * Single param: A -> R
 * Multi param:  (A, B) -> R  (uses Tuple internally)
 */
export function tMultiFun(params: Type[], result: Type): Type {
  if (params.length === 0) return result;
  if (params.length === 1) return tFun(params[0], result);
  return tFun(tTuple(params), result);
}

// ---------------------------------------------------------------------------
// Applied built-in sugar: `Function [params] result` and `Object k a`
//
// `Function` and `Object` carry two mandatory children.  They stay in their
// applied `TCon` form for DISPLAY, but are pure sugar over `TFun` / `TRecord`:
//   • `Function [x] a`     ≡ `x -> a`
//   • `Function [x, y] a`  ≡ `(x, y) -> a`
//   • `Function [] a`      ≡ `() -> a`
//   • `Object k a`         ≡ `{ [k] :: a }`
// Unification (src/hm/unify.ts) and the duplicate-overload key
// (`normalizeOpenObjectsForKey`) desugar them on the fly so the surface form
// never has to be reconstructed.
// ---------------------------------------------------------------------------

/** Is `t` an applied `Function [params] result` (exactly two children)? */
export function isAppliedFunction(t: Type): t is TCon {
  return t.tag === 'TCon' && t.name === T_FUNCTION && t.args.length === 2;
}

/** Is `t` an applied `Object k a` (exactly two children)? */
export function isAppliedObject(t: Type): t is TCon {
  return t.tag === 'TCon' && t.name === T_OBJECT && t.args.length === 2;
}

/** Extract the positional parameter list from a `Function` first child,
 *  which must be array-like (`[x]` → Array, `[x, y]` → SpreadArray, `[]` →
 *  strict-empty Array).  Returns `null` when the child is not array-like — a
 *  malformed annotation that the validator reports separately. */
export function functionParamList(params: Type): Type[] | null {
  if (params.tag === 'TCon' && params.name === T_ARRAY && params.args.length === 1) {
    return params.strictEmpty === true ? [] : [params.args[0]];
  }
  if (params.tag === 'TCon' && params.name === T_SPREAD_ARRAY) {
    return params.args.slice();
  }
  return null;
}

/** Desugar `Function [params] result` to the equivalent `TFun`. */
export function desugarFunctionType(params: Type, result: Type): Type {
  const list = functionParamList(params);
  // Lenient fallback: a non-array first child is invalid (flagged by the
  // validator) — treat the whole child as a single parameter so unification
  // still has something structural to work with.
  if (list === null) return tFun(params, result);
  if (list.length === 0) return tFun(tVoid, result);
  return tMultiFun(list, result);
}

/** Desugar `Object k a` to the equivalent `{ [k] :: a }` record. */
export function desugarObjectType(key: Type, val: Type): TRecord {
  if (key.tag === 'TLabel') {
    return { tag: 'TRecord', fields: {}, labelFields: [{ label: key, type: val }] };
  }
  // Defensive: a non-label key (malformed) → an arbitrary open object.
  return { tag: 'TRecord', fields: {}, rest: tVar() };
}

/** Canonical opaque "any function" — `Function [a] b` with fresh vars. */
export function tAnyFunction(): TCon {
  return tCon(T_FUNCTION, [tArray(tVar()), tVar()]);
}

/** Canonical opaque "any object" — `Object k a` with a fresh label + value. */
export function tAnyObject(): TCon {
  return tCon(T_OBJECT, [tLabelVar(), tVar()]);
}

/** A record type, e.g. `{ name :: String, age :: Number }` */
export function tRecord(fields: Record<string, Type>, alias?: string): TRecord {
  return alias ? { tag: 'TRecord', fields, alias } : { tag: 'TRecord', fields };
}

/** An open (row-polymorphic) record `{ field1 :: T1 | r }`.  The optional
 *  `rest` argument lets callers reuse an existing row variable (for
 *  destructuring patterns where the same row is shared between the
 *  parameter and the `rest` binding); when omitted, a fresh TVar is
 *  allocated. */
export function tOpenRecord(fields: Record<string, Type>, rest?: TVar | TRow): TRecord {
  return { tag: 'TRecord', fields, rest: rest ?? tVar() };
}

/**
 * Deep-merge two record types the way `{ ...a, ...b }` spreads them: fields
 * present in only one side are carried over; fields present in BOTH are
 * combined — recursively merged when both are records, otherwise unioned
 * (`Number | String`).  Overlapping keys therefore appear exactly once.
 *
 * `labelFields` (index signatures) are concatenated, and the result stays
 * open when either input is open (its row variable is preserved).  Inputs
 * are assumed to be already substitution-applied by the caller.
 */
export function mergeRecordTypes(a: TRecord, b: TRecord): TRecord {
  const fields: Record<string, Type> = { ...a.fields };
  for (const k of Object.keys(b.fields)) {
    const incoming = b.fields[k];
    if (k in fields) {
      fields[k] = deepMergeTypes(fields[k], incoming);
    } else {
      fields[k] = incoming;
    }
  }
  const out: TRecord = { tag: 'TRecord', fields };
  const labelFields = [...(a.labelFields ?? []), ...(b.labelFields ?? [])];
  if (labelFields.length > 0) out.labelFields = labelFields;
  // Result is open when either operand was open; reuse b's row first so the
  // "latest spread" row variable drives further absorption.
  const rest = b.rest ?? a.rest;
  if (rest) out.rest = rest;
  return out;
}

/**
 * Deep-merge two arbitrary types for `{ ...a, ...b }`-style spreads / `Merge`
 * marker reduction.  This is the single shared primitive every merge site
 * routes through so overlapping keys are combined consistently:
 *
 *   • both records            → field-wise `mergeRecordTypes` (recurses here)
 *   • same real container TCon → merge arg-wise, so `[String]` + `[Number]`
 *     becomes `[String | Number]` and `[{x::A}]` + `[{x::B}]` becomes
 *     `[{x :: A | B}]`.  Structural markers (Union / Merge / Tuple / TypeRep /
 *     Picked / SpreadArray) are NOT treated as containers — merging their
 *     positional args would be meaningless — so they fall through to a union.
 *   • structurally identical   → either side
 *   • anything else            → `A | B`
 */
export function deepMergeTypes(a: Type, b: Type): Type {
  if (a.tag === 'TRecord' && b.tag === 'TRecord') {
    return mergeRecordTypes(a, b);
  }
  if (
    a.tag === 'TCon' && b.tag === 'TCon' &&
    a.name === b.name &&
    a.args.length === b.args.length &&
    a.args.length > 0 &&
    !DEEP_MERGE_OPAQUE_CONS.has(a.name)
  ) {
    return tCon(a.name, a.args.map((arg, i) => deepMergeTypes(arg, b.args[i])));
  }
  if (structuralEquals(a, b)) return a;
  return tUnion([a, b]);
}

/** Constructors whose positional args are NOT container element types, so
 *  `deepMergeTypes` must union them rather than merge arg-wise. */
const DEEP_MERGE_OPAQUE_CONS = new Set<string>([
  T_UNION, T_MERGE, T_TUPLE, T_TYPEREP, T_PICKED, T_SPREAD_ARRAY,
]);


// ---------------------------------------------------------------------------
// Label smart constructors
// ---------------------------------------------------------------------------

/** A concrete field-label literal, e.g. `tLabelLit('x')`. */
export function tLabelLit(value: string): TLabelLit {
  return { tag: 'TLabel', kind: 'lit', value };
}

/** A fresh label variable, optionally with a display name. */
export function tLabelVar(name?: string): TLabelVar {
  const id = freshTypeVarId();
  return { tag: 'TLabel', kind: 'var', id, name: name ?? `k${id}` };
}

/** True when `t` is a label type. */
export function isLabel(t: Type): t is TLabel {
  return t.tag === 'TLabel';
}

// ---------------------------------------------------------------------------
// Kind-variable helpers
// A kind variable is a type variable used as a type constructor (higher-kinded).
// In TCon names it's encoded as "$kv:name:id", e.g. "$kv:f:42".
// ---------------------------------------------------------------------------

const KV_PREFIX = '$kv:';

/** Check whether a TCon name represents a kind variable. */
export function isKindVariable(name: string): boolean {
  return name.startsWith(KV_PREFIX);
}

/** Create a kind-variable TCon name from the var name and id. */
export function kvName(varName: string, varId: number): string {
  return `${KV_PREFIX}${varName}:${varId}`;
}

// ---------------------------------------------------------------------------
// Curry overload generation
// ---------------------------------------------------------------------------

/**
 * Flatten a curried function type into its individual parameter types and final result.
 * e.g. A -> B -> C -> R  →  { params: [A, B, C], result: R }
 * e.g. (Tuple [A, B]) -> R  →  { params: [A, B], result: R }  (from multi-param)
 */
export function flattenCurriedType(t: Type): { params: Type[]; result: Type } {
  const params: Type[] = [];
  let current = t;
  while (current.tag === 'TFun') {
    params.push(current.param);
    current = current.result;
  }
  return { params, result: current };
}

/**
 * Generate all curried overload types for a set of parameters and a result type.
 * For params [A, B, C] and result R, generates all ordered partitions:
 *   - A -> B -> C -> R        (fully curried)
 *   - (A, B) -> C -> R
 *   - A -> (B, C) -> R
 *   - (A, B, C) -> R          (original uncurried)
 *
 * The number of overloads is 2^(n-1) where n = params.length.
 */
export function generateCurriedOverloads(params: Type[], result: Type): Type[] {
  if (params.length === 0) return [result];
  if (params.length === 1) return [tFun(params[0], result)];

  const overloads: Type[] = [];
  const numGaps = params.length - 1;

  // Each bit pattern represents cuts between adjacent params.
  // bit i = 1 means there is a cut between param[i] and param[i+1].
  for (let mask = 0; mask < (1 << numGaps); mask++) {
    const groups: Type[][] = [[]];
    groups[0].push(params[0]);

    for (let i = 0; i < numGaps; i++) {
      if (mask & (1 << i)) {
        // Cut: start new group
        groups.push([params[i + 1]]);
      } else {
        // No cut: add to current group
        groups[groups.length - 1].push(params[i + 1]);
      }
    }

    // Build curried function type from groups (right to left)
    let type: Type = result;
    for (let j = groups.length - 1; j >= 0; j--) {
      const group = groups[j];
      const param = group.length === 1 ? group[0] : tTuple(group);
      type = tFun(param, type);
    }
    overloads.push(type);
  }

  return overloads;
}

/** Parse a kind-variable TCon name. Returns null if not a kv name. */
// Hot path (every `Substitution.apply` on a TCon): reject ordinary names on
// their first character, and memoise parsed kv names.  The returned objects
// are shared and must not be mutated.
const kvParseCache = new Map<string, Readonly<{ varName: string; varId: number }> | null>();
export function parseKvName(name: string): Readonly<{ varName: string; varId: number }> | null {
  if (name.charCodeAt(0) !== 36 /* '$' */ || !name.startsWith(KV_PREFIX)) return null;
  const cached = kvParseCache.get(name);
  if (cached !== undefined) return cached;
  const rest = name.slice(KV_PREFIX.length);
  const colonIdx = rest.lastIndexOf(':');
  let result: Readonly<{ varName: string; varId: number }> | null = null;
  if (colonIdx >= 0) {
    const varName = rest.slice(0, colonIdx);
    const varId = parseInt(rest.slice(colonIdx + 1), 10);
    if (!isNaN(varId)) result = Object.freeze({ varName, varId });
  }
  if (kvParseCache.size > 50_000) kvParseCache.clear(); // bound memory in long LSP sessions
  kvParseCache.set(name, result);
  return result;
}

/**
 * Extract the base constraint name from a possibly-applied constraint string.
 * "Monoid (f a)" → "Monoid", "Semigroup" → "Semigroup".
 */
export function constraintBaseName(name: string): string {
  const spaceIdx = name.indexOf(' ');
  return spaceIdx >= 0 && name.includes('(') ? name.slice(0, spaceIdx) : name;
}

// ---------------------------------------------------------------------------
// Regex constants (shared across codebase)
// ---------------------------------------------------------------------------

/** Matches single lowercase annotation var names (a, b, c, ... z). */
export const ANNOTATION_NAME_RE = /^[a-z]$/;

/** Matches auto-generated type var names (t0, t1, ...). */
export const AUTO_TVAR_NAME_RE = /^t\d+$/;
/** The name `tRow ()` gives a fresh row variable (`r246`).  Displayed as
 *  `r` (then `r1`, `r2`, …) instead of leaking the internal id. */
export const AUTO_ROW_NAME_RE = /^r\d+$/;

/** Prefix used for rigid skolem TCon names (e.g. `§0`, `§1`).  A skolem is a
 *  rigid type constant standing in for a universally-quantified annotation
 *  variable while a function body is checked against its signature. */
export const SKOLEM_PREFIX = '§';

/** True when a type is a rigid skolem constant (a `§N` TCon). */
export function isSkolem(t: Type): boolean {
  return t.tag === 'TCon' && t.name.startsWith(SKOLEM_PREFIX);
}

// ---------------------------------------------------------------------------
// Pretty-printing
//
// Plain language: turning a type tree back into readable text such as
// `Array (Number | String) -> Boolean`.  This is what users see in hover
// popups, completions and error messages, so a lot of care goes into
// parenthesisation (only where needed) and into giving placeholder
// variables friendly letters (a, b, c, …) instead of internal names (t42).
// ---------------------------------------------------------------------------

/** Does a type need parens when used as a juxtaposition arg?
 *  ("Juxtaposition" = type application by adjacency, e.g. the `a` in
 *  `Maybe a`.  A structured arg like `Maybe (a -> b)` needs the parens.) */
function needsParens(t: Type): boolean {
  if (t.tag === 'TFun') return true;
  if (t.tag === 'TCon' && t.name === T_UNION) return true;
  // `Object k a` renders as a record `{ [k] :: a }` — like Array/Tuple it never
  // needs wrapping parens as a juxtaposition arg.
  if (t.tag === 'TCon' && t.args.length > 0 && t.name !== T_ARRAY && t.name !== T_TUPLE && t.name !== T_SPREAD_ARRAY && !isAppliedObject(t)) return true;
  return false;
}

/** Does a union member need parens to disambiguate `|` precedence? */
function unionMemberNeedsParens(t: Type): boolean {
  // `|` binds tighter than `->`, so `A | B -> C` parses as `(A | B) -> C`.
  // A function as union member therefore needs parens: `A | (B -> C)`.
  // `Function […] …` renders as an arrow, so it needs parens too.
  return t.tag === 'TFun' || t.tag === 'TForall' || isAppliedFunction(t);
}

/** Does a function param need parens to keep `->` right-associative & unambiguous? */
function funParamNeedsParens(t: Type): boolean {
  // Nested function: `(a -> b) -> c` differs from `a -> b -> c`.
  // Union as param needs NO parens: `A | B -> C` already parses as
  // `(A | B) -> C` since `|` binds tighter than `->`.  Adding parens
  // here would silently rewrite what the user wrote.
  // `Function […] …` renders as an arrow, so it needs parens like TFun.
  // A nested quantifier extends maximally right, so `(forall a. a -> a) -> b`
  // needs parens around the forall in param position.
  return t.tag === 'TFun' || t.tag === 'TForall' || isAppliedFunction(t);
}

/**
 * Shared implementation for type-to-string conversion.
 * When `names` is provided, TVar ids are resolved through the map (for pretty-printing).
 * When omitted, the TVar's own `.name` property is used.
 */
function typeToStringImpl(t: Type, names?: Map<number, string>, singletonIds?: Set<number>): string {
  switch (t.tag) {
    case 'TVar':
      return names?.get(t.id) ?? t.name;
    case 'TCon': {
      const kv = parseKvName(t.name);
      const displayName = kv ? (names?.get(kv.varId) ?? kv.varName) : t.name;
      if (t.name === 'Void' && t.args.length === 0) return '()';
      // Render the `$error` poison sentinel as a wildcard placeholder so
      // it never leaks into hover / signature-help output.  The diagnostic
      // for the underlying unification failure is emitted separately.
      if (t.name === T_ERROR) return '_';
      if (isWildcard(t)) return wildcardDisplayName(t);
      if (t.name === T_UNION) {
        return t.args
          .map(a => unionMemberNeedsParens(a)
            ? `(${typeToStringImpl(a, names, singletonIds)})`
            : typeToStringImpl(a, names, singletonIds))
          .join(' | ');
      }
      if (t.name === T_ARRAY && t.args.length === 1) {
        // A strict-empty array annotation `[]` renders as `[]`.
        if (t.strictEmpty === true) return '[]';
        return `[${typeToStringImpl(t.args[0], names, singletonIds)}]`;
      }
      if (t.name === T_SPREAD_ARRAY) {
        return `[${t.args.map(a => typeToStringImpl(a, names, singletonIds)).join(', ')}]`;
      }
      if (t.name === T_TUPLE) {
        return `(${t.args.map(a => typeToStringImpl(a, names, singletonIds)).join(', ')})`;
      }
      // Spread sugar for Merge: render `Merge a b` / `Merge {x::T} a b`
      // as `{ ...a, ...b }` / `{ x :: T, ...a, ...b }` when all non-
      // record args are TVar.  Anything more exotic falls through to the
      // raw `Merge ...` form.
      if (t.name === T_MERGE && t.args.length > 0) {
        const segs: string[] = [];
        // Track which segments came from bare row-vars vs concrete
        // fields, so we can hide the noisy `...a` tails when at least
        // one concrete record contributed real fields (a free row-var
        // sibling adds no information in that case).
        const spreadOnly: boolean[] = [];
        // Track per-segment row-tail IDs so we can also drop
        // singly-occurring bare tails (their name is uninformative
        // when it doesn't bind anything elsewhere in the type).
        const segRowIds: (number | null)[] = [];
        let ok = true;
        for (const a of t.args) {
          if (a.tag === 'TVar' || a.tag === 'TRow') {
            segs.push(`...${typeToStringImpl(a, names, singletonIds)}`);
            spreadOnly.push(true);
            segRowIds.push(a.id);
          } else if (a.tag === 'TRecord' && !a.rest) {
            // Inline record's field strings.
            const keys = Object.keys(a.fields).filter(k => k !== 'constructor');
            for (const k of keys) {
              segs.push(`${k} :: ${typeToStringImpl(a.fields[k], names, singletonIds)}`);
              spreadOnly.push(false);
              segRowIds.push(null);
            }
            if (a.labelFields) {
              for (const { label, type: vt } of a.labelFields) {
                const labelStr = label.kind === 'lit'
                  ? `'${label.value}'`
                  : (names?.get(label.id) ?? label.name);
                segs.push(`[${labelStr}] :: ${typeToStringImpl(vt, names, singletonIds)}`);
                spreadOnly.push(false);
                segRowIds.push(null);
              }
            }
          } else {
            ok = false;
            break;
          }
        }
        if (ok) {
          const hasConcrete = spreadOnly.some(s => !s);
          if (hasConcrete) {
            const concreteSegs = segs.filter((_, i) => !spreadOnly[i]);
            return `{ ${concreteSegs.join(', ')} }`;
          }
          // All spread — drop any bare-row segment whose id occurs only
          // once in the whole type (its name doesn't tie back to any
          // other position, so it carries no information).  When the
          // caller didn't pass a `singletonIds` set (raw `typeToString`
          // calls), keep all segments to preserve the existing
          // user-facing annotation surface.
          const filtered: string[] = [];
          for (let i = 0; i < segs.length; i++) {
            const rid = segRowIds[i];
            if (rid !== null && singletonIds && singletonIds.has(rid)) continue;
            filtered.push(segs[i]);
          }
          if (filtered.length === 0) {
            // All segments were bare-row singletons that we just
            // dropped.  Rather than collapsing to a meaningless `{}`,
            // surface a single bare polymorphic variable so a `Merge p1
            // p2` of two zero-param tags displays the same way as a
            // single zero-param tag would: `a` instead of `{}`.
            for (let i = 0; i < t.args.length; i++) {
              const a = t.args[i];
              if (a.tag === 'TVar' || a.tag === 'TRow') {
                return typeToStringImpl(a, names, singletonIds);
              }
            }
            return '{}';
          }
          return `{ ${filtered.join(', ')} }`;
        }
      }
      // Sugar: `Function [x] a` -> `x -> a`, `Function [x, y] a` -> `(x, y) -> a`,
      // `Function [] a` -> `() -> a`.  Nested `Function [x] (Function [y] a)`
      // renders as `x -> y -> a` because the result recurses through here.
      if (t.name === T_FUNCTION && t.args.length === 2) {
        const list = functionParamList(t.args[0]);
        if (list !== null) {
          const resultStr = typeToStringImpl(t.args[1], names, singletonIds);
          if (list.length === 1) {
            const p = list[0];
            const pStr = funParamNeedsParens(p)
              ? `(${typeToStringImpl(p, names, singletonIds)})`
              : typeToStringImpl(p, names, singletonIds);
            return `${pStr} -> ${resultStr}`;
          }
          const paramsStr = list
            .map(a => typeToStringImpl(a, names, singletonIds))
            .join(', ');
          return `(${paramsStr}) -> ${resultStr}`;
        }
      }
      // Sugar: `Object k a` -> `{ [k] :: a }`.
      if (t.name === T_OBJECT && t.args.length === 2) {
        const key = t.args[0];
        const keyStr = key.tag === 'TLabel'
          ? (key.kind === 'lit' ? `'${key.value}'` : (names?.get(key.id) ?? key.name))
          : typeToStringImpl(key, names, singletonIds);
        return `{ [${keyStr}] :: ${typeToStringImpl(t.args[1], names, singletonIds)} }`;
      }
      if (t.args.length === 0) return displayName;
      return `${displayName} ${t.args.map(a => needsParens(a) ? `(${typeToStringImpl(a, names, singletonIds)})` : typeToStringImpl(a, names, singletonIds)).join(' ')}`;
    }
    case 'TFun': {
      const paramStr = funParamNeedsParens(t.param)
        ? `(${typeToStringImpl(t.param, names, singletonIds)})`
        : typeToStringImpl(t.param, names, singletonIds);
      return `${paramStr} -> ${typeToStringImpl(t.result, names, singletonIds)}`;
    }
    case 'TRecord': {
      if (t.alias) return t.alias;
      // Hide the implicit `constructor` field that `Object.create(prototype)`
      // inherits — it carries no useful display info and clutters the type.
      // Also hide fields marked via `::hidden` / `::private` so enumerating the
      // host record (e.g. hover over `builtIn`) does not surface them.
      const keys = Object.keys(t.fields)
        .filter(k => k !== 'constructor' && !t.hiddenFields?.has(k));
      const fieldStrs = keys
        .map(k => {
          const override = t.fieldDisplays?.[k];
          return override
            ? `${k} :: ${override}`
            : `${k} :: ${typeToStringImpl(t.fields[k], names, singletonIds)}`;
        });
      if (t.labelFields) {
        for (const { label, type: vt } of t.labelFields) {
          const labelStr = label.kind === 'lit'
            ? `'${label.value}'`
            : (names?.get(label.id) ?? label.name);
          fieldStrs.push(`[${labelStr}] :: ${typeToStringImpl(vt, names, singletonIds)}`);
        }
      }
      const joined = fieldStrs.join(', ');
      if (t.rest) {
        const restStr = typeToStringImpl(t.rest, names, singletonIds);
        // A row-only open record (`{...a}`) renders with the `{a}` shorthand;
        // when concrete fields are also present we keep the explicit `...a`
        // tail so the field/row boundary stays readable (`{ x :: T, ...a }`).
        return fieldStrs.length === 0 ? `{ ${restStr} }` : `{ ${joined}, ...${restStr} }`;
      }
      if (fieldStrs.length === 0) return '{}';
      return `{ ${joined} }`;
    }
    case 'TLabel': {
      if (t.kind === 'lit') return `'${t.value}'`;
      return names?.get(t.id) ?? t.name;
    }
    case 'TRow':
      // Standalone TRow renders as `...r` — but TRow normally only
      // appears inside a TRecord's rest position where the record's
      // pretty-printer already prefixes `...`.  Bare display is mainly
      // for diagnostic messages.
      return names?.get(t.id) ?? t.name;
    case 'TForall': {
      const varsStr = t.vars
        .map((id, i) => names?.get(id) ?? t.varNames[i] ?? `t${id}`)
        .join(' ');
      const cs = t.constraints && t.constraints.length > 0
        ? (t.constraints.length === 1
          ? `${renderConstraintStr(t.constraints[0], names)} => `
          : `(${t.constraints.map(c => renderConstraintStr(c, names)).join(', ')}) => `)
        : '';
      return `forall ${varsStr}. ${cs}${typeToStringImpl(t.body, names, singletonIds)}`;
    }
  }
}

/** Render a single constraint (`Functor f`, `Monoid (f a)`, `(A | B) v`) as
 *  annotation text.  Shared by {@link schemeToString} and the nested-forall
 *  case of {@link typeToStringImpl}. */
function renderConstraintStr(c: Constraint, names?: Map<number, string>): string {
  const renderArg = (t: Type): string => {
    const s = typeToStringImpl(t, names);
    return (t.tag === 'TFun' || (t.tag === 'TCon' && t.args.length > 0)) ? `(${s})` : s;
  };
  if (c.unionAlternatives && c.unionAlternatives.length > 0) {
    const alts = c.unionAlternatives.map(a => {
      const s = typeToStringImpl(a, names);
      return a.tag === 'TFun' ? `(${s})` : s;
    }).join(' | ');
    return `(${alts}) ${c.typeVarName}`;
  }
  if (c.positionalArgs && c.positionalArgs.length > 0) {
    return `${c.className} ${c.positionalArgs.map(renderArg).join(' ')}`;
  }
  return `${c.className} ${c.typeVarName}`;
}

/** Render a type as text using each variable's own stored name (no
 *  re-lettering).  For user-facing output prefer {@link prettyTypeToString},
 *  which renames variables to friendly sequential letters. */
export function typeToString(t: Type): string {
  return typeToStringImpl(t);
}

/**
 * Is `r` an "open object" annotation form — one whose declared shape places
 * no constraint on the concrete keys/values?  Three syntactic spellings all
 * mean "an arbitrary object" and must canonicalize to the same overload key:
 *
 *   • `Object`                — handled by the caller (already a `TCon`).
 *   • `{ a }` / `{ ...r }`    — empty fields + a bare row/var tail.
 *   • `{ [k] :: a }`          — only polymorphic-label fields whose label AND
 *                               value are both type variables.
 *
 * A record with any concrete field (`{ x :: Number }`), a concrete index
 * value (`{ [k] :: Number }`), or the strict-empty `{}` form is NOT open and
 * keeps its own distinct key.
 */
function isOpenObjectRecord(r: TRecord): boolean {
  if (Object.keys(r.fields).length > 0) return false;
  if (r.strictEmpty) return false;
  const labels = r.labelFields ?? [];
  if (labels.length === 0) {
    // `{ a }` / `{ ...r }`: an empty record with an open row/var tail.
    return r.rest !== undefined;
  }
  // `{ [k] :: a }`: only polymorphic-label fields, no concrete tail, and every
  // label and value must be a bare variable (so `{ [k] :: Number }` stays
  // distinct).
  if (r.rest !== undefined) return false;
  return labels.every(lf => lf.label.kind === 'var' && lf.type.tag === 'TVar');
}

/**
 * Rewrite every "open object" record (see {@link isOpenObjectRecord}) to the
 * canonical `Object` constructor, recursing through function and constructor
 * positions.  Used ONLY to build the duplicate-overload key in
 * {@link canonicalSchemeKey} — it never touches the real scheme type, so
 * unification and hover rendering are unaffected.
 */
function normalizeOpenObjectsForKey(t: Type): Type {
  switch (t.tag) {
    case 'TRecord':
      return isOpenObjectRecord(t) ? tObject : t;
    case 'TFun':
      return tFun(normalizeOpenObjectsForKey(t.param), normalizeOpenObjectsForKey(t.result));
    case 'TCon':
      // Applied `Function`/`Object` are sugar — desugar so an overload spelled
      // `Function [x, y] a` keys identically to `(x, y) -> a`, and `Object k a`
      // keys identically to `{ [k] :: a }`.
      if (t.name === T_FUNCTION && t.args.length === 2) return normalizeOpenObjectsForKey(desugarFunctionType(t.args[0], t.args[1]));
      if (t.name === T_OBJECT && t.args.length === 2) return normalizeOpenObjectsForKey(desugarObjectType(t.args[0], t.args[1]));
      return t.args.length === 0 ? t : tCon(t.name, t.args.map(normalizeOpenObjectsForKey));
    default:
      return t;
  }
}

/**
 * Produce an alpha-canonical key string for a scheme: every distinct type /
 * row / label / kind variable is renamed to a positional canonical name
 * (`a`, `b`, `c`, …) in order of first appearance, and the (sorted) constraint
 * list is appended.  Two schemes that are identical up to consistent variable
 * renaming therefore produce the SAME key.  Used to detect duplicate overload
 * signatures regardless of which variable letters the author happened to use.
 *
 * Plain language: a "fingerprint" for a signature that ignores the author's
 * choice of letter names — `a -> a` and `x -> x` get the same fingerprint.
 */
export function canonicalSchemeKey(scheme: Scheme): string {
  const keyType = normalizeOpenObjectsForKey(scheme.type);
  const ids: number[] = [];
  const names = new Map<number, string>(); // id -> source name (first wins)
  collectVarIdsAndNames(keyType, names, ids);
  if (scheme.constraints) {
    for (const c of scheme.constraints) {
      if (c.positionalArgs) for (const a of c.positionalArgs) collectVarIdsAndNames(a, names, ids);
      if (c.unionAlternatives) for (const a of c.unionAlternatives) collectVarIdsAndNames(a, names, ids);
    }
  }
  const canonical = new Map<number, string>();  // id -> canonical name
  const byOrigName = new Map<string, string>(); // source name -> canonical name
  let next = 0;
  for (const id of ids) {
    if (canonical.has(id)) continue;
    const cn = varNameFromIndex(next++);
    canonical.set(id, cn);
    const orig = names.get(id);
    if (orig !== undefined && !byOrigName.has(orig)) byOrigName.set(orig, cn);
  }
  const typeStr = typeToStringImpl(keyType, canonical);
  if (!scheme.constraints || scheme.constraints.length === 0) return typeStr;
  const renderC = (c: Constraint): string => {
    const tv = byOrigName.get(c.typeVarName) ?? c.typeVarName;
    if (c.unionAlternatives && c.unionAlternatives.length > 0) {
      return '(' + c.unionAlternatives.map(a => typeToStringImpl(a, canonical)).join('|') + ') ' + tv;
    }
    if (c.positionalArgs && c.positionalArgs.length > 0) {
      return c.className + ' ' + c.positionalArgs.map(a => typeToStringImpl(a, canonical)).join(' ');
    }
    return c.className + ' ' + tv;
  };
  const cs = scheme.constraints.map(renderC).sort().join(',');
  return cs + ' => ' + typeStr;
}

/** Render a scheme as annotation text, constraints included —
 *  e.g. `Functor f => f a -> f b`. */
export function schemeToString(s: Scheme): string {
  const renderConstraint = (c: Constraint): string => {
    const renderArg = (t: Type): string => {
      const s = typeToString(t);
      return (t.tag === 'TFun' || (t.tag === 'TCon' && t.args.length > 0)) ? `(${s})` : s;
    };
    if (c.unionAlternatives && c.unionAlternatives.length > 0) {
      const alts = c.unionAlternatives.map(a => {
        const s = typeToString(a);
        return a.tag === 'TFun' ? `(${s})` : s;
      }).join(' | ');
      return `(${alts}) ${c.typeVarName}`;
    }
    if (c.positionalArgs && c.positionalArgs.length > 0) {
      return `${c.className} ${c.positionalArgs.map(renderArg).join(' ')}`;
    }
    return `${c.className} ${c.typeVarName}`;
  };
  const constraintStr = s.constraints && s.constraints.length > 0
    ? (s.constraints.length === 1
      ? `${renderConstraint(s.constraints[0])} => `
      : `(${s.constraints.map(renderConstraint).join(', ')}) => `)
    : '';

  return constraintStr + typeToString(s.type);
}

/**
 * Build a pretty name map from collected variable IDs and their original names.
 * Preserves user-chosen annotation names (like a, b, a1); replaces
 * auto-generated names (t0, t1, ...) with sequential letters.
 */
function buildPrettyNameMap(
  varIds: number[],
  varNamesById: Map<number, string>,
  shareByName: boolean = false,
): Map<number, string> {
  const nameMap = new Map<number, string>();
  const usedNames = new Set<string>();
  // When shareByName is set, distinct ids carrying the same source name
  // collapse to the same displayed letter (used by pair-printing so
  // "annotation a" lines up with "inferred a" even after instantiation
  // produced fresh TVar ids on each side).
  const nameToFirstId = new Map<string, number>();
  // First pass: preserve original annotation names
  for (const id of varIds) {
    if (nameMap.has(id)) continue;
    const origName = varNamesById.get(id);
    if (!origName || AUTO_TVAR_NAME_RE.test(origName) || AUTO_ROW_NAME_RE.test(origName)) continue;
    if (usedNames.has(origName)) {
      if (shareByName && nameToFirstId.has(origName)) {
        const firstId = nameToFirstId.get(origName)!;
        nameMap.set(id, nameMap.get(firstId)!);
      }
      continue;
    }
    nameMap.set(id, origName);
    usedNames.add(origName);
    nameToFirstId.set(origName, id);
  }
  // Second pass: fresh rows become `r`, `r1`, `r2`, … (rows read best with
  // a row-like name; the sequential letters below are for type variables).
  let rowIdx = 0;
  for (const id of varIds) {
    if (nameMap.has(id)) continue;
    if (!AUTO_ROW_NAME_RE.test(varNamesById.get(id) ?? '')) continue;
    let name: string;
    do {
      name = rowIdx === 0 ? 'r' : `r${rowIdx}`;
      rowIdx++;
    } while (usedNames.has(name));
    nameMap.set(id, name);
    usedNames.add(name);
  }
  // Third pass: assign sequential names to remaining vars
  let idx = 0;
  for (const id of varIds) {
    if (nameMap.has(id)) continue;
    let name: string;
    do {
      name = varNameFromIndex(idx++);
    } while (usedNames.has(name));
    nameMap.set(id, name);
    usedNames.add(name);
  }
  return nameMap;
}

/**
 * Pretty-print a type, renaming type variables to a, b, c, ... in order of
 * first appearance.  Produces human-friendly output for hover display.
 */
export function prettyTypeToString(t: Type): string {
  const varIds: number[] = [];
  const varNamesById = new Map<number, string>();
  collectVarIdsAndNames(t, varNamesById, varIds);
  // A row-tail TVar/TRow id that appears exactly once across the whole
  // type carries no information beyond "open record" — its name binds
  // nothing else.  Track them so the Merge spread-printer can drop
  // such uninformative tails when no concrete fields are present
  // (e.g. `Merge a p2` rendering as `{}` instead of `{ ...a, ...p2 }`).
  const counts = new Map<number, number>();
  for (const id of varIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const singletonIds = new Set<number>();
  for (const [id, c] of counts) if (c === 1) singletonIds.add(id);
  return typeToStringImpl(t, buildPrettyNameMap(varIds, varNamesById), singletonIds);
}

/**
 * Pretty-print `t` using a letter assignment SEEDED from `context` so that a
 * type variable shared between the two renders with the SAME letter in both.
 *
 * Used for hover: when the cursor is on a sub-expression inside a function,
 * `context` is the enclosing function's type.  Without this, each hover
 * canonicalizes letters from scratch, so a variable shared by `f :: a -> b`
 * and its result `result` would render as `b` when hovering `f` but `a` when
 * hovering `result` in isolation.  Seeding from `context` first pins the
 * shared variable to the letter it has in the enclosing scope.
 */
export function prettyTypeToStringWithContext(t: Type, context: Type): string {
  const varIds: number[] = [];
  const varNamesById = new Map<number, string>();
  // Seed with the context's variables first (establishes letter order), then
  // append any variables unique to `t`.
  collectVarIdsAndNames(context, varNamesById, varIds);
  collectVarIdsAndNames(t, varNamesById, varIds);
  // Singleton detection is based on `t` alone (drives the Merge open-row tail
  // elision), independent of the seeding order.
  const tIds: number[] = [];
  collectVarIdsAndNames(t, new Map<number, string>(), tIds);
  const counts = new Map<number, number>();
  for (const id of tIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const singletonIds = new Set<number>();
  for (const [id, c] of counts) if (c === 1) singletonIds.add(id);
  // `shareByName` collapses distinct ids carrying the SAME source name onto one
  // letter.  A variable that flows from the enclosing scope into a
  // sub-expression (e.g. the higher-kinded `f` of `Pair Number (f a)` re-read
  // as `pair.snd :: f a`) may arrive with a freshly-instantiated id; without
  // this, the context's `f` claims the letter `f` and the sub-expression's copy
  // is bumped to a sequential letter (`b a`).  Auto-generated names (`t0`, …)
  // are exempt, so genuinely distinct body-local vars keep distinct letters.
  return typeToStringImpl(t, buildPrettyNameMap(varIds, varNamesById, /* shareByName */ true), singletonIds);
}

/**
 * Build the type-variable → display-letter map that {@link prettyTypeToString}
 * (or {@link prettyTypeToStringWithContext} when `context` is given) uses to
 * render `t`.  Exposed so callers that render a constraint prefix separately
 * from the type body (e.g. hover) can label the constrained variable with the
 * SAME letter the body shows for it, instead of the variable's raw internal
 * name.
 */
export function buildVarDisplayNameMap(t: Type, context?: Type): Map<number, string> {
  const varIds: number[] = [];
  const varNamesById = new Map<number, string>();
  if (context) collectVarIdsAndNames(context, varNamesById, varIds);
  collectVarIdsAndNames(t, varNamesById, varIds);
  // When seeded from a context, share letters across ids with the same source
  // name so a variable shared between context and `t` (e.g. the higher-kinded
  // `f`) renders with ONE letter instead of the second copy being re-lettered.
  return buildPrettyNameMap(varIds, varNamesById, /* shareByName */ !!context);
}

/**
 * Pretty-print two types using a shared name map so that the same TVar id
 * gets the same letter in both.  Used for error messages like
 * "Cannot unify X with Y" to keep variable names readable and consistent.
 *
 * Distinct TVar ids that originated from the same source name (e.g. both
 * sides of a comparison reference an annotation's `a`) collapse to the same
 * displayed letter so the two type strings line up visually.  This matters
 * for the "X has type ... but annotation expects ..." family of messages,
 * where instantiation produces fresh TVar ids on each side.
 */
export function prettyTypeToStringPair(t1: Type, t2: Type): [string, string] {
  const varIds: number[] = [];
  const varNamesById = new Map<number, string>();
  collectVarIdsAndNames(t1, varNamesById, varIds);
  collectVarIdsAndNames(t2, varNamesById, varIds);
  const nameMap = buildPrettyNameMap(varIds, varNamesById, /* shareByName */ true);
  return [typeToStringImpl(t1, nameMap), typeToStringImpl(t2, nameMap)];
}

/**
 * Rewrite a type so that distinct variables (TVar / TRow / TLabel-var)
 * carrying the SAME user-chosen source name collapse onto a single
 * representative id — a DISPLAY-ONLY normalization.  Used when combining
 * independently-instantiated overload branches into one union for hover: each
 * branch wrote e.g. `a`, but `mergeOverloadSchemes` refreshed them to distinct
 * ids, so the pretty-printer would otherwise rename the second `a` to `b`
 * (e.g. `[a] | { b }`).  Sharing the id per source name makes it render as the
 * source name in every branch (`[a] | { a }`).
 *
 * Auto-generated names (`t0`, `t1`, …) are left untouched so genuinely
 * distinct inference vars keep distinct letters.  The result must be used for
 * display only — it deliberately conflates ids that are NOT semantically equal.
 */
export function canonicalizeDisplayVarsByName(t: Type): Type {
  const repIdByName = new Map<string, number>();
  const collect = (ty: Type): void => {
    switch (ty.tag) {
      case 'TVar':
      case 'TRow':
        if (!AUTO_TVAR_NAME_RE.test(ty.name) && !repIdByName.has(ty.name)) {
          repIdByName.set(ty.name, ty.id);
        }
        break;
      case 'TCon': {
        // Higher-kinded variables are encoded in the TCon name as `$kv:f:id`.
        // Track them by source name too so a repeated kind-variable across
        // overload branches (e.g. `f a` and `Function [a] (f a)`) collapses
        // onto ONE id and renders with the same letter in every branch.
        const kv = parseKvName(ty.name);
        if (kv && !AUTO_TVAR_NAME_RE.test(kv.varName) && !repIdByName.has(kv.varName)) {
          repIdByName.set(kv.varName, kv.varId);
        }
        ty.args.forEach(collect);
        break;
      }
      case 'TFun':
        collect(ty.param);
        collect(ty.result);
        break;
      case 'TRecord':
        for (const k in ty.fields) collect(ty.fields[k]);
        if (ty.rest) collect(ty.rest);
        if (ty.labelFields) for (const lf of ty.labelFields) { collect(lf.label); collect(lf.type); }
        break;
      case 'TLabel':
        if (ty.kind === 'var' && !AUTO_TVAR_NAME_RE.test(ty.name) && !repIdByName.has(ty.name)) {
          repIdByName.set(ty.name, ty.id);
        }
        break;
      case 'TForall':
        // Do NOT descend: the binders are scoped and may reuse an outer
        // var's source name — conflating them would capture the bound var.
        break;
    }
  };
  const rewrite = (ty: Type): Type => {
    switch (ty.tag) {
      case 'TVar': {
        const rep = repIdByName.get(ty.name);
        return rep != null && rep !== ty.id ? { ...ty, id: rep } : ty;
      }
      case 'TRow': {
        const rep = repIdByName.get(ty.name);
        return rep != null && rep !== ty.id ? { ...ty, id: rep } : ty;
      }
      case 'TCon': {
        const args = ty.args.map(rewrite);
        const kv = parseKvName(ty.name);
        if (kv) {
          const rep = repIdByName.get(kv.varName);
          if (rep != null && rep !== kv.varId) {
            return { ...ty, name: kvName(kv.varName, rep), args };
          }
        }
        return { ...ty, args };
      }
      case 'TFun':
        return { ...ty, param: rewrite(ty.param), result: rewrite(ty.result) };
      case 'TRecord': {
        const fields: Record<string, Type> = {};
        for (const k in ty.fields) fields[k] = rewrite(ty.fields[k]);
        const out: TRecord = { ...ty, fields };
        if (ty.rest) out.rest = rewrite(ty.rest) as TVar | TRow;
        if (ty.labelFields) {
          out.labelFields = ty.labelFields.map(lf => ({ label: rewrite(lf.label) as TLabel, type: rewrite(lf.type) }));
        }
        return out;
      }
      case 'TLabel': {
        if (ty.kind === 'var') {
          const rep = repIdByName.get(ty.name);
          return rep != null && rep !== ty.id ? { ...ty, id: rep } : ty;
        }
        return ty;
      }
      default:
        return ty;
    }
  };
  collect(t);
  return rewrite(t);
}

/** Collect TVar ids and name mappings from a type.
 *  When `ids` is provided, each encountered TVar id is pushed into it (preserving order of first appearance).
 *  `names` always receives `id → name` mappings. */
function collectVarIdsAndNames(t: Type, names: Map<number, string>, ids?: number[]): void {
  switch (t.tag) {
    case 'TVar':
      ids?.push(t.id);
      if (!names.has(t.id)) names.set(t.id, t.name);
      break;
    case 'TCon': {
      // Track kind-variable ids as type variable ids too
      const kv = parseKvName(t.name);
      if (kv) {
        ids?.push(kv.varId);
        if (!names.has(kv.varId)) names.set(kv.varId, kv.varName);
      }
      t.args.forEach(a => collectVarIdsAndNames(a, names, ids));
      break;
    }
    case 'TFun': collectVarIdsAndNames(t.param, names, ids); collectVarIdsAndNames(t.result, names, ids); break;
    case 'TRecord':
      for (const k in t.fields) collectVarIdsAndNames(t.fields[k], names, ids);
      if (t.rest) collectVarIdsAndNames(t.rest, names, ids);
      if (t.labelFields) for (const lf of t.labelFields) {
        collectVarIdsAndNames(lf.label, names, ids);
        collectVarIdsAndNames(lf.type, names, ids);
      }
      break;
    case 'TLabel':
      if (t.kind === 'var') {
        ids?.push(t.id);
        if (!names.has(t.id)) names.set(t.id, t.name);
      }
      break;
    case 'TRow':
      ids?.push(t.id);
      if (!names.has(t.id)) names.set(t.id, t.name);
      break;
    case 'TForall':
      // Register the bound variables (so pretty-printing letters them with
      // their annotation names) and recurse into the body.  Bound ids are
      // globally fresh, so registering them can never clash with outer vars.
      for (let i = 0; i < t.vars.length; i++) {
        ids?.push(t.vars[i]);
        if (!names.has(t.vars[i])) names.set(t.vars[i], t.varNames[i] ?? `t${t.vars[i]}`);
      }
      collectVarIdsAndNames(t.body, names, ids);
      break;
  }
}

/** The i-th friendly variable letter: a, b, c, … z, a1, b1, … */
function varNameFromIndex(i: number): string {
  const letter = String.fromCharCode(97 + (i % 26));
  const suffix = i >= 26 ? String(Math.floor(i / 26)) : '';
  return letter + suffix;
}

/**
 * Collect every display-relevant variable id in `t` (ordinary TVars, row-tail
 * TRow vars, TLabel vars, and higher-kinded `$kv:name:id` ids baked into TCon
 * names).  Used by hover scope-seeding to decide whether a piece of enclosing
 * context genuinely SHARES a variable with the hovered type — only then may it
 * influence letter assignment.
 */
export function collectAllVarIds(t: Type): Set<number> {
  const ids: number[] = [];
  collectVarIdsAndNames(t, new Map<number, string>(), ids);
  return new Set(ids);
}

// ---------------------------------------------------------------------------
// Pure type utility functions (no inference engine state)
//
// Plain language: small stand-alone helpers for taking function types apart
// (parameters vs. return type) and combining several types into one.
// "Pure" = they only look at their inputs; they read no global state.
// ---------------------------------------------------------------------------

/** Get the final return type of a (possibly curried) function type:
 *  for `a -> b -> c` that is `c`. */
export function getReturnType(t: Type): Type {
  if (t.tag === 'TFun') return getReturnType(t.result);
  return t;
}

/**
 * Merge a list of return types into a unified type.
 * When all types share the same outer TCon, merges inner type args
 * position-by-position.  Otherwise produces a flat Union.
 */
export function mergeReturnTypes(types: Type[]): Type {
  if (types.every(t => t.tag === 'TCon' && t.args.length > 0)) {
    const first = types[0] as TCon;
    const firstName = first.name;
    if (types.every(t => (t as TCon).name === firstName)) {
      const arity = first.args.length;
      const mergedArgs: Type[] = [];
      for (let i = 0; i < arity; i++) {
        const argTypes: Type[] = [];
        const seenArgs = new Set<string>();
        for (const t of types) {
          const arg = (t as TCon).args[i];
          const key = typeToString(arg);
          if (!seenArgs.has(key)) { seenArgs.add(key); argTypes.push(arg); }
        }
        // Wildcards absorb anything: if some args are wildcards and others
        // are concrete, drop the wildcards and keep the concretes (the
        // wildcard branch's return type is unconstrained in this slot, so
        // it conforms to whatever the concrete branches produce).
        const hasWildcard = argTypes.some(isWildcard);
        const hasConcrete = argTypes.some(a => !isWildcard(a));
        const filteredArgs = hasWildcard && hasConcrete
          ? argTypes.filter(a => !isWildcard(a))
          : argTypes;
        mergedArgs.push(filteredArgs.length === 1 ? filteredArgs[0] : tUnion(filteredArgs));
      }
      return tCon(firstName, mergedArgs);
    }
  }
  return tUnion(types);
}

/**
 * Decompose a function type into its parameter slot types for N params.
 * Handles Tuple-encoded multi-param functions, spread/variadic tuples, and
 * JS's "fewer params than expected" convention.
 *
 * For curried:  a -> b -> c  with N=1 → params=[a], rest=(b -> c)
 * For tuple:    (a, b) -> c  with N=2 → params=[a, b], rest=c
 */
export function decomposeFunParams(
  t: Type,
  numParams: number,
): { paramTypes: Type[]; restType: Type; extraParamTypes?: Type[] } | null {
  if (t.tag !== 'TFun') return null;

  if (isTuple(t.param) && t.param.args.length === numParams) {
    return { paramTypes: t.param.args, restType: t.result };
  }

  if (isTuple(t.param) &&
      t.param.args.some(a => isSpread(a)) && numParams === 1) {
    return { paramTypes: [t.param], restType: t.result };
  }

  if (isTuple(t.param) &&
      numParams >= 0 && numParams < t.param.args.length) {
    return {
      paramTypes: t.param.args.slice(0, numParams),
      restType: t.result,
      extraParamTypes: t.param.args.slice(numParams),
    };
  }

  if (numParams >= 1) {
    // A parameter aligned with the `...` region of a spread arrow chain
    // (`a -> b -> ... -> z`) must not receive the literal spread marker as its
    // type — a value parameter can never BE a spread.  The middle params the
    // spread absorbs are unconstrained, so hand the parameter a fresh variable
    // and continue with the terminal/result.  This prevents `...` leaking into
    // the inferred function type (which would spuriously clash with the param's
    // real usage, e.g. `z` in `x => y => z => x + y + z`).
    if (isSpread(t.param)) {
      return { paramTypes: [tVar()], restType: t.result };
    }
    return { paramTypes: [t.param], restType: t.result };
  }

  // Zero-param function used where a function is expected: treat the
  // expected parameter as an extra (ignored) param so the function type
  // still wraps the return type (e.g. `() => expr` passed as `a -> b`
  // becomes `a -> exprType` rather than bare `exprType`).
  if (numParams === 0) {
    return { paramTypes: [], restType: t.result, extraParamTypes: [t.param] };
  }

  return null;
}

/** Count how many parameters a function type expects (returns a display string). */
export function countFunParams(t: Type): string {
  if (t.tag !== 'TFun') return '0 parameters';
  if (isTuple(t.param)) {
    return `${t.param.args.length} parameter(s)`;
  }
  let count = 1;
  let current: Type = t.result;
  while (current.tag === 'TFun') { count++; current = current.result; }
  return `${count} parameter(s)`;
}

/** Find TCon names in a type not present in `known` (skipping kind-variable names). */
/**
 * Numeric literal (singleton) types — `2` in `_Tuple :: 2 -> …`.  Encoded as
 * a nullary nominal constructor named by the canonical number text, so `2`
 * unifies only with `2`: NOT with `Number` (a `Number` value of unknown value
 * cannot pick a literal overload — it falls through to a `Number` branch).  A
 * number literal EXPRESSION takes the literal type only where one is expected
 * (see `inferLiteral`); everywhere else it is plain `Number`.
 */
const NUM_LIT_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
export function isNumLitName(name: string): boolean {
  return NUM_LIT_RE.test(name);
}
export function tNumLit(value: number): TCon {
  return { tag: 'TCon', name: String(value), args: [] };
}

export function findUnknownTCons(t: Type, known: Set<string>, out: string[] = []): string[] {
  switch (t.tag) {
    case 'TCon':
      if (!parseKvName(t.name) && !isWildcard(t) && !isSpread(t) && !known.has(t.name) && !isNumLitName(t.name))
        out.push(t.name);
      for (const arg of t.args) findUnknownTCons(arg, known, out);
      break;
    case 'TFun':
      findUnknownTCons(t.param, known, out);
      findUnknownTCons(t.result, known, out);
      break;
    case 'TRecord':
      for (const k in t.fields) findUnknownTCons(t.fields[k], known, out);
      if (t.rest) findUnknownTCons(t.rest, known, out);
      break;
    case 'TForall':
      findUnknownTCons(t.body, known, out);
      break;
  }
  return out;
}

/** Collect all TVar id→name mappings from a type (for preserving var names across instantiation). */
export function collectVarNames(t: Type, names: Map<number, string>): void {
  collectVarIdsAndNames(t, names);
}
