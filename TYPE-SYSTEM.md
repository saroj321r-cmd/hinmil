# Type System — Where HinMil Follows Hindley-Milner, and Where It Deliberately Leaves It

HinMil implements classic **rank-1 Hindley-Milner** type inference with
let-generalization, plus **opt-in rank-N checking** via explicit `forall`
annotations. That single sentence explains most of what the engine can
and cannot do, so this document spells it out — and then catalogues every
place where the engine *deliberately* extends or deviates from the textbook
algorithm, why it does so, and where the boundaries lie.

The [README](README.md) documents the features from the user's point of view;
[ARCHITECTURE.md](ARCHITECTURE.md) describes the code layout; the
[GLOSSARY](GLOSSARY.md) explains the jargon. This document sits in between:
it is about the *type theory* — what was kept, what was bent, and what was
traded away on purpose.

---

## Table of Contents

- [The Foundation: Rank-1 HM](#the-foundation-rank-1-hm)
  - [What rank-1 means in practice](#what-rank-1-means-in-practice)
  - [Rank-N via explicit annotations](#rank-n-via-explicit-annotations)
- [Design Principles](#design-principles)
- [Variadic Spread Forms (`...`)](#variadic-spread-forms-)
  - [Spread tuples: pipe & compose](#spread-tuples-pipe--compose)
  - [Spread arrow chains](#spread-arrow-chains)
  - [The two dual fold rules](#the-two-dual-fold-rules)
  - [Typing a heterogeneous fold: the reducer recipe](#typing-a-heterogeneous-fold-the-reducer-recipe)
  - [Call-site-only semantics and its consequences](#call-site-only-semantics-and-its-consequences)
- [Constraints as Type Classes](#constraints-as-type-classes)
- [The Rest of the Delta](#the-rest-of-the-delta)
  - [Tuple-applied calling convention](#tuple-applied-calling-convention)
  - [Explicit curry wrappers](#explicit-curry-wrappers)
  - [Records: pragmatic width subtyping](#records-pragmatic-width-subtyping)
  - [Union types and flow-sensitive narrowing](#union-types-and-flow-sensitive-narrowing)
  - [Annotations as assertions for lookups](#annotations-as-assertions-for-lookups)
  - [Overloading](#overloading)
  - [Label polymorphism](#label-polymorphism)
  - [Nominal and structural types side by side](#nominal-and-structural-types-side-by-side)
  - [Constraint representatives and TypeRep](#constraint-representatives-and-typerep)
  - [Infinite types and annotated extents](#infinite-types-and-annotated-extents)
  - [Trusting annotations](#trusting-annotations)
  - [Gradual corners: `Any`, wildcards and auto-union](#gradual-corners-any-wildcards-and-auto-union)
  - [Rigid annotations and scoped type variables](#rigid-annotations-and-scoped-type-variables)
  - [Literal types](#literal-types)
  - [Type-level functions: `Picked`, `Merge`, `Awaited`](#type-level-functions-picked-merge-awaited)
  - [Higher-kinded types without kind inference](#higher-kinded-types-without-kind-inference)
  - [Top-level hoisting](#top-level-hoisting)
  - [Types across modules](#types-across-modules)
- [Where Each Rule Lives](#where-each-rule-lives)

---

## The Foundation: Rank-1 HM

The engine is a classic Hindley-Milner checker: unification with an occurs
check, substitution, environments, and let-generalization. That buys the two
properties the whole project is built on:

- **Full inference.** Plain JavaScript with zero annotations still gets
  types. Annotations refine and document; they are never *required* for the
  machinery to work.
- **Principal types.** When the engine infers a type, it is the most general
  one — `identity` really is `a -> a`, not `Number -> Number` because a
  number happened to pass through first.

**Rank-1** means that all the implicit `forall`s sit at the very front of a
signature. `a -> a` is really `forall a. a -> a`, generalized when the
binding is finished (*let-generalization*, see the
[Glossary](GLOSSARY.md#generalization--scheme)) and instantiated fresh at
every use site.

### What rank-1 means in practice

A quantifier at the front is the only place a quantifier can be. A function
*parameter* can therefore never itself be polymorphic — the moment a
polymorphic value is passed as an argument, it is instantiated **once** and
pinned:

```javascript
// This does not type in rank-1 HM:
// both :: (a -> a) -> (Number, String) -> [Number, String]
const both = (f) => (n, s) => [f(n), f(s)];
// `a` is chosen once, by the caller.  Inside the body it is a fixed,
// unknown type, so neither call is allowed:
// Cannot unify 'a' with 'Number' (and 'a' with 'String')
```

Without the annotation, textbook HM rejects `both (x => x) (1, "one")`
(`n` and `s` must share `f`'s parameter type). HinMil accepts that call: it
widens the shared type instead of reporting an error — the *no false
positives* principle below.

Allowing `both` needs a `forall` *inside* a parameter position —
`(forall a. a -> a) -> ...` — which is rank-2. HinMil supports exactly that,
but only when the `forall` is written explicitly (see
[the next section](#rank-n-via-explicit-annotations)). The same limitation
shows up in fold accumulators whose type changes on every iteration:
`reduce`'s signature `(b -> a -> b) -> b -> f a -> b` instantiates `b`
exactly once for the whole fold, so an accumulator that shrinks from
`m x1 -> m x2 -> m z` to `m x2 -> m z` per step cannot be expressed
directly. (The [spread arrow chain](#spread-arrow-chains) form exists
precisely for this case.)

### Rank-N via explicit annotations

Higher-rank *inference* is undecidable, so HinMil follows the Odersky–Läufer
tradition (like Haskell's `RankNTypes`): **inference stays rank-1; a `forall`
written at an inner position of an annotation is checked, never inferred**.

```javascript
// applyBoth :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];

const ok  = applyBoth(x => x)(1, "one");      // ✓ genuinely polymorphic
const bad = applyBoth(x => x + 1)(1, "one");  // ✗ Argument is not polymorphic enough
```

In brief: the system is predicative (a variable never instantiates to a
polytype); arguments are checked by skolemization with shallow subsumption
(`Argument is not polymorphic enough` on failure) and a skolem-escape check
(`Polymorphic value escapes its scope` — the `runST` pattern); a
`forall`-bound parameter is a real scheme in the body (each use instantiates
fresh); constraints may sit inside the `forall` (`forall f. Functor f => …`);
record fields may be `forall`-typed (dictionary passing); toplevel and
result-position `forall`s are hoisted into the ordinary rank-1 scheme. For
the variadic idioms (`pipe`, `compose`, heterogeneous folds) the dedicated
[spread forms](#variadic-spread-forms-) remain the right tool — those stay
fully inferable. Worked examples live in [sample/rankN/](sample/rankN/).

---

## Design Principles

Three principles recur in every deviation described below. They are worth
naming once:

1. **No false positives.** When the engine cannot type something precisely,
   it degrades to a *less precise* type (a collapse, a fresh variable, an
   `Any`-like hole) rather than reporting an error that is not real. A
   missed diagnostic is annoying; a wrong one destroys trust.
2. **Special forms over type-system extensions.** Each real-world idiom gets
   a small, dedicated type form with its own rules (`...` chains, label
   variables, `Picked`), instead of generalizing the whole system (rank-n,
   full dependent rows). The rules stay local and testable.
3. **Context may steer semantics.** Textbook unification is context-free.
   HinMil allows the *syntactic* context — is this type being applied at a
   call site, or passed as an argument? — to pick between interpretations
   when the types alone are ambiguous. See
   [call-site-only semantics](#call-site-only-semantics-and-its-consequences).

---

## Variadic Spread Forms (`...`)

The `...` marker in a signature is the project's main departure from textbook
HM. It means "zero or more positions of the surrounding shape" and comes in
two flavours.

### Spread tuples: pipe & compose

A tuple parameter may carry a `...` to accept any number of arguments, with
the pattern of the written elements extended across the gap:

```javascript
// pipe :: ((a -> b), (b -> c), ..., (y -> z)) -> a -> z
const pipe = (...fns) => fns.reduce((acc, fn) => x => fn(acc(x)));
```

At a call site the engine lays the actual arguments over the template,
threads the intermediate variables (`b`, `c`, … become fresh links), and
checks every connection. Direction (pipe vs. compose) is detected from which
type variables adjacent positions share — see
[Pipe & Compose](README.md#pipe--compose) in the README. Degenerate lengths
are legal by design: a single stage is just that stage's type, and an empty
chain is accepted — though its type then leaves the input and the output
unrelated (`a -> z`) rather than tying them together as the identity it is
at runtime.

The same mechanism types fan-out combinators (`converge`-style: one curried
combiner followed by `...` branch functions) and appliers that take a spread
*array* (`[a, b, ...] -> z`).

### Spread arrow chains

The second flavour puts the `...` inside a **curried arrow chain**:

```javascript
// liftN :: Apply m => Number -> (x -> y -> ... -> z) -> m x -> m y -> ... -> m z
```

`m x -> m y -> ... -> m z` reads: "a curried function of *unknown length*
whose parameters follow this pattern and whose final result is `m z`". This
is not a rank-n type — there is no hidden `forall` — but it is also not a
plain HM type: its length is indeterminate, and unification against it has
special rules:

- **Chain vs. chain**: positions unify pairwise, terminals unify.
- **Chain vs. concrete function**: the concrete side's leading parameters
  unify with the chain's leading parameters; when the concrete side runs
  out, its result unifies with the chain's **terminal**. A short function is
  allowed to "bottom out" — the `...` absorbed zero positions.
- **Chain vs. union**: a union callee (say `liftN`'s body returning
  `lift2 | lift3 | lift4 | lift5`) unifies with a chain only when **every**
  member of the union fits the chain. One bad member fails the whole union —
  soundness is kept by unanimity, not by picking a winner.

### The two dual fold rules

Two structural rules cover the `reduce`-shaped combinators. They are duals of
each other, and neither matches on names — only on type shapes:

- **R — reduce over a chain of arrows** (`pipe`/`compose`): a *container of
  functions* `f (a -> b, ..., y -> z)` collapses link by link. The fold is
  finite and endomorphic (each step's output type feeds the next step's
  input), so no occurs-check trouble arises.
- **A — applyArgs peeling**: a *single curried function* applied to a spread
  array, `(a -> b -> ... -> z) -> [a, b, ...] -> z`. Here the fold threads
  the function itself through the accumulator, which in raw HM produces an
  infinite type (`z` occurs in `a -> ... -> z`). The engine recognizes the
  shape, suppresses the occurs-check explosion, and types the application
  positionally instead.

### Typing a heterogeneous fold: the reducer recipe

The hardest shape is a fold whose **accumulator changes type every
iteration** — a `combine`-style variadic lift, which lifts an n-ary function
and then feeds it one wrapped argument per step:

```javascript
// reducer :: Applicative m => (m x -> m y -> ... -> m z) -> (a -> m x) -> m y -> ... -> m z
const reducer = acc => fn => acc(fn(value));

return reduce(reducer)(liftN(n - 1)(hd))(tl);
```

In rank-1 HM this is untypeable (the accumulator would need a polymorphic
type at an argument position — rank-2). With a spread-chain annotation on the
reducer, three cooperating rules make it positively typed:

1. **Call-site peel.** When a value whose type is a spread chain is *called*
   with fewer arguments than its fixed leading parameters, the result is the
   **peeled remainder**: applying `m x -> m y -> ... -> m z` to one argument
   yields `m y -> ... -> m z`. One application, one parameter off the front.
2. **Union unanimity.** `liftN`'s return type is a union of concrete lift
   functions; the chain annotation accepts it because every member unifies
   (see above).
3. **Fold completion.** The fold's final accumulator is still a *chain*,
   while the annotated return type is the chain's *terminal* (`m z`). When
   unification of chain-vs-concrete fails at a binding boundary, the engine
   retries against the chain's terminal — the `...` absorbed everything.

Note the quiet parser dependency: inside `(m x -> ...)`, the juxtaposition
`m x` only parses as a type application when `m` is a **constraint
variable** — which is why the `Applicative m =>` context on these
annotations is load-bearing, not decoration.

### Call-site-only semantics and its consequences

Rule 1 above — the peel — lives **only in the call path**, not in the
unifier. This is a deliberate asymmetry, and it is worth understanding why.

When the unifier sees a chain against a short concrete function, it cannot
tell two situations apart:

- the chain is being **applied** and the concrete side is a partial
  application — the result should be the peeled remainder;
- a short function is being **passed as an argument** where a chain is
  expected — the result should bottom out on the terminal, so that
  over-application diagnostics still fire (`applyArgs(f)([1, 2, 3])` with a
  unary `f` must still report *"takes at most 1 argument"*).

Only the call site knows which one it is. So the peel fires exactly when a
spread-chain-typed value is the callee of a syntactic call expression, the
arguments stop before the `...`, and none of them is a spread element.
Everywhere else, the context-free bottoming-out rule applies.

The consequences, honestly stated:

- **Indirect application does not peel.** Route the chain through a helper
  (`const apply1 = f => x => f(x)`), through `.call`/`.apply`, or through a
  container, and the engine falls back to terminal collapse. The fallback is
  benign — a less precise type, never a false error — but the hover will
  show the terminal rather than the remainder.
- **Argument positions always bottom out.** Passing a chain where a concrete
  function is expected reconciles against the terminal.
- **The same pair of types can unify differently in different syntactic
  contexts.** Theoretically impure; practically exactly what resolves the
  ambiguity. This is design principle 3 at work.

---

## Constraints as Type Classes

Textbook HM has no qualified types. HinMil adds a constraint system in the
spirit of Haskell type classes, declared with
[`::constraint`](README.md#constraint--type-classes):

```javascript
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Apply f { f :: Functor, f :: { ap :: f a ~> f (a -> b) -> f b } }
```

The deviations worth knowing about:

- **Discharge is structural.** A constraint is satisfied when the concrete
  type actually has the required methods (built-in, annotated, or registered
  via [`::rep`](README.md#rep--constraint-representatives)) — there are no
  explicit instance declarations. Superclasses (`f :: Functor` above) are
  entailed transitively.
- **Constraint variables are higher-kinded.** The `f` in `Functor f => f a`
  stands for a type *constructor*, not a type — a modest form of
  higher-kinded polymorphism that textbook HM lacks.
- **Constraint variables are rigid inside checked bodies.** A
  universally-quantified constraint variable introduced by an annotation's
  `=>` context may not be instantiated to a concrete constructor by the
  body — even one that satisfies the constraint. `Array` is an
  `Applicative`, but a `forall f` signature still may not secretly pick
  `f := Array`. This is *parametricity*, enforced with skolems; the overload
  resolver additionally filters out branches that would pin a rigid variable
  (`src/infer/call-overloads.ts`).
- **Constraint variables parse greedily.** `f a` is a type application only
  when `f` is bound by a constraint head (or followed by parentheses). Plain
  lowercase juxtaposition is otherwise not application — a parsing rule that
  keeps ordinary signatures unambiguous.

---

## The Rest of the Delta

Shorter entries; each links to the README section that documents the
user-facing behaviour.

### Tuple-applied calling convention

Textbook HM is curried: every application is one argument. JavaScript is
not, so HinMil makes multi-argument calls first-class: `f(a, b)` constructs a
tuple and unifies it against the parameter. `(A, B) -> C` and
`A -> B -> C` are *different types* matching different call shapes. See
[Calling Convention](README.md#calling-convention).

### Explicit curry wrappers

Curried behaviour is opt-in via a `curry` helper whose annotation the engine
recognizes (`((a, b, ...) -> z) -> a -> b -> ... -> z`). The engine then
types *all* mixed application forms — `f(a)(b, c)`, `f(a, b)(c)` — against
one signature. Pure HM has no notion of this; it is a special form keyed on
the wrapper's spread annotation. See [Curry](README.md#curry).

### Records: pragmatic width subtyping

Open records (`{ name :: String, ...rest }`) are standard row polymorphism.
The deviation is on *closed* records: closed-vs-closed unification silently
accepts extra caller fields, because passing wider objects is everyday
JavaScript. Strict HM would reject it; HinMil trades that strictness for
compatibility. The one place where extra fields are an error is an object
*literal* against a *named* closed record (an alias): a field the alias does
not declare is almost always a typo in an optional field, so it is reported
as HM1010 with a "did you mean" hint. See
[Records & Row Polymorphism](README.md#records--row-polymorphism).

Reading a field outside an open record extends its row while the row is
still a free variable (`o.total` on `{ paid :: Boolean, ...r }` makes it
`{ paid :: Boolean, total :: t, ...r' }`), as row-polymorphic inference
does. While a function body is checked against its own annotation, the
rows of its parameters are rigid (`engine.rigidRowIds`), so a field the
annotation does not list stays an error.

### Union types and flow-sensitive narrowing

HM has no union types and no flow sensitivity. HinMil infers unions from
conditionals (`Number | String`), lets annotations declare them, and narrows
them back down inside `typeof`/null/truthiness guards and
[`::narrow`](README.md#narrow--type-predicates) predicates. Narrowing is a
per-branch re-binding of the environment — a flow analysis bolted onto HM,
not part of unification. See [Type Narrowing](README.md#type-narrowing).

Unification itself is symmetric, but unions are not: where a value flows
into a declared type, HinMil checks the direction.

- **Arguments**: every member of a union argument must be accepted by the
  parameter (`Number | Undefined` does not fit `Number | Null`), and a plain
  `String` does not fit a union of string literals. Type variables, skolems,
  label variables and overload sets are exempt — they are bound, not
  checked. The check also runs per field of an object-literal argument
  (and so for JSX props) and for a `curry`-wrapped call.
- **Results**: a body may return *fewer* alternatives than its annotation
  (`String | Null` satisfies `-> String | Number | Null`), never more.
  Functions widen covariantly in their result; parameters must match.

Both rules only add errors where the symmetric unification wrongly
succeeded. The argument check also decides between overload branches: a
branch whose parameter an argument does not fit drops out. A union
argument whose members fit *different* branches (`Result | Task Result`
against `Task a -> Task a` and `a -> Task a`) is then resolved per member,
and the agreeing results are the call's type — a small, local form of the
distribution that intersection-typed systems do in general.

### Annotations as assertions for lookups

A lookup that can miss (`Map#get :: k -> (v | Undefined)`) is typed
honestly, and two escape hatches keep everyday code free of noise. A `has`
test on the same map and key is flow information, like a null check: the
branch where it holds (and the code after `if (!m.has (k)) m.set (k, …)`)
reads `m.get (k)` without the `Undefined`. And an annotation on a `const`
whose value comes from a call, member access or `await` may drop `Undefined`
and `Null` from the inferred union: the author asserts an invariant the
checker cannot see (TypeScript's `!`). Everywhere else an annotation that
is narrower than the inferred union is an error.

### Overloading

One name, several signatures, resolved per call site by trying branches **in
declaration order** and taking the first that unifies. Order-dependence is a
deliberate simplicity trade: no best-match scoring, no ambiguity errors —
the author controls priority by ordering. See
[Overloading](README.md#overloading).

### Label polymorphism

Field *names* can be variables of their own sort (`k` in
`(k, { [k] :: a, ...r }) -> a`), unified with singleton string-literal
types. Textbook HM quantifies only over types; this adds a second, parallel
kind of variable. See [Label Polymorphism](README.md#label-polymorphism).

### Nominal and structural types side by side

Records and constraints are structural; sum types, classes, and alias-named
constructors are nominal. A nominal value can discharge a structural
requirement when its (annotated or built-in) members line up — the member
sets are compared, not the names. Pure HM systems are typically all-nominal
or all-structural; HinMil runs both and defines the bridge.

### Constraint representatives and TypeRep

Two value-level escape hatches for type-level facts:

- [`::rep`](README.md#rep--constraint-representatives) registers an
  annotated method as a constraint's representative, so `Array` can satisfy
  `Monoid` through a user-declared `Array.empty`.
- `TypeRep f` types functions that take a *runtime witness* of a type
  constructor (`of(Array)(1)`), connecting a value argument to a
  higher-kinded variable — a dependent-flavoured trick kept deliberately
  small.

### Infinite types and annotated extents

The occurs check rejects infinite types, as in any HM system. Two softenings
apply. First, the recognized fold shapes (the A rule above) suppress the
infinite-type diagnostic where the shape proves the fold is intentional.
Second, inside the extent of an *annotated* binding, raw infinite-type
diagnostics are dropped when the diagnostics are built (editor and CLI
alike): the annotation already states the
intended type, and the occurs-check failure is an artifact of inference
meeting a shape it cannot thread, not a bug in the user's code.

### Trusting annotations

Annotations in HinMil are *checked claims*, but the
[`trustAnnotations`](README.md#configuration) setting provides an escalation
ladder (`off` → `signatures` → `annotated-bodies` → `all-bodies`) that
progressively suppresses mismatch diagnostics in favour of the written
signature. At the stricter end this resembles HM's "annotations as checked
assertions"; at the looser end it approaches TypeScript's `declare` — the
user chooses where on that line a project sits.

### Gradual corners: `Any`, wildcards and auto-union

HM has no "unknown" type. HinMil has three, each with a narrow purpose:

- **`Any`** is the type of what cannot be known: an import from a package
  without typings, a name a bundled typing does not declare (open world),
  `globalThis`. `Any` unifies with everything, satisfies every constraint,
  and a member of `Any` is `Any`. It never arises from code the engine can
  see. (`JSON.parse` is different: it returns a fresh type variable,
  `String -> a`, so its result takes the type of how it is used.)
- **The wildcard `*`** is the author's "don't care" in an annotation
  (`fork :: (…) -> *`). A union with a bare `*` collapses to `*`.
- **Auto-union.** Where unannotated code uses one variable at two types —
  `both (x => x) (1, "one")` with `n` and `s` sharing `f`'s parameter —
  textbook HM fails. HinMil widens the shared variable to the union
  (`Number | String`) instead: the *no false positives* principle applied
  to code nobody made a promise about. Only the argument side widens; a
  parameter that is already concrete never does, and annotated code is
  checked without this leniency.

### Rigid annotations and scoped type variables

An annotation is checked, not trusted. Its type variables become *skolems*
inside the body (rigid placeholders the body may not specialize), so
`second :: (a, b) -> b` over `(x, y) => x` is an error — the same check for a
`function`, a `const` arrow, a dotted static and a function built by a call
(`const f = curry (…)`). Overload sets and `...` chains keep a more lenient
check, because their bodies legitimately specialize per branch.

Type variables are **lexically scoped**, like generics in TypeScript: a
letter in a nested annotation that also occurs in an enclosing annotation is
the same variable. Standard HM (and Haskell without `ScopedTypeVariables`)
treats every annotation as closed; HinMil needs the scoped reading so closure
helpers inside a polymorphic function can be annotated at all.

### Literal types

String literals in type position are singleton types (`'draft' | 'paid'`),
built on the same label machinery as [label polymorphism](#label-polymorphism).
A literal argument must be one of the allowed values, a plain `String` does
not fit (see [union direction](#union-types-and-flow-sensitive-narrowing)),
and a `const` bound to a literal, or a ternary of literals, keeps the
literal. Numeric literal types (`2 -> …`) exist for arity-by-value APIs;
in an overload set the literal branch wins over a `Number` branch.

### Type-level functions: `Picked`, `Merge`, `Awaited`

HM types are inert data; HinMil has three type constructors that *compute*
after a call, each reduced once the arguments are known:

- **`Picked Row Selectors`** projects a row record onto the selected fields
  (query builders: `Table ["id", "name"]` gives `{ id, name }`), following
  nested relations through the element type's instance-callable signature.
- **`Merge a b`** is the result of a record spread (`{ ...a, ...b }`,
  `Object.assign`): the right-hand fields win; dictionaries merge their
  value types.
- **`Awaited b`** unwraps a returned promise (`Promise#then` returns
  `Promise e (Awaited b)`), so `then (x => fetchNext (x))` is not a promise
  of a promise.

They are deliberately closed: users cannot define their own type-level
functions.

### Higher-kinded types without kind inference

`f a` with a constraint-bound `f` is a higher-kinded application, encoded
internally as a *kind variable* (`$kv:f`). There is no kind inference: a
type variable may only be applied when a constraint declares it, a sum type
used as a `TypeRep m` witness is cut one argument short (`Either e`), and
the kind of everything else follows from the annotations. Two bridges make
everyday JavaScript fit: a function is a functor in its result
(`f a` ≡ `x -> a`, and `p b c` ≡ `b -> c` for a Profunctor), and a guard
proves a kind locally — after `Array.isArray (xs)` or a `::narrow Array`
predicate on `xs :: f a`, the true branch knows `f ≡ Array`.

### Top-level hoisting

JavaScript lets a top-level function use a `const` declared further down.
Annotated bindings are hoisted with their annotation. An unannotated
top-level `const`/`let` gets a placeholder that is unified, after its
declaration, with a *fresh instance* of the inferred type — so a forward
use neither breaks polymorphism nor reports a conflict the order of
declarations created. This applies at the top level only, not in blocks.

### Types across modules

Every module is inferred on its own; its exports are generalized and
cached, and an importing module instantiates them. Two additions to plain
HM modules: **types travel with imports** — importing a value also makes
the type aliases visible in its module available, transitively through
`::types` and imports — and **packages bring their own types** through
inline annotations, `.hm` sidecars, companion `@hm/<pkg>` packages,
bundled typings or project stubs (see the README's
[merge order](README.md#merge-order)). A module on an import cycle is
reported (HM3005, a warning); inference continues across it.

---

## Where Each Rule Lives

For contributors — the code homes of the rules above:

| Rule | Home |
|------|------|
| Core unification, occurs check | `src/hm/unify.ts` |
| Chain/spread predicates (pure, lowest layer) | `src/hm/typeUtils.ts` |
| Spread-form call handlers & classifier (`classifyCallPattern`) | `src/infer/functionPatterns.ts` |
| Call-site peel (`trySpreadChainCalleePeel`) | `src/infer/functionPatterns.ts`, dispatched from `src/infer/calls.ts` |
| Union-vs-chain unanimity | `src/hm/unify.ts` (`unifyWithUnion`) |
| Fold-completion retry | `src/infer/unifyDiag.ts` |
| Constraint declaration & discharge | `src/registries/`, `src/infer/annotations.ts` |
| Rigid variables / parametricity filter | `src/infer/annotation-rigid.ts`, `src/infer/call-overloads.ts` |
| Narrowing | `src/infer/narrowing.ts` |
| `has` before `get` (key-present markers) | `src/infer/narrowing.ts` (`presentKeyMarker`, `keyPresentAfter`), `src/infer/expressions.ts` |
| Annotation asserts a present lookup | `src/infer/stmt-bindings.ts` (`assertsPresentLookup`) |
| Auto-union | `src/infer/unifyDiag.ts` (`tryAutoUnion`) |
| Scoped type variables | `src/infer/expr-functions.ts` (`scopedTypeVars`) |
| `Picked` projection, `Merge` and `Awaited` reduction | `src/infer/call-rows.ts` (`applyPickedProjection`, `applyMergeReduction`, `applyAwaitedReduction`) |
| Local kind equalities from guards | `src/infer/statements.ts` (`localKindEqsForGuard`) |
| Top-level hoisting | `src/infer/statements.ts` (`reconcileForwardDecls`) |
| Types across modules, travelling type names | `src/services/importContext.ts` (`createImportTypeAliasResolver`) |
| Union direction: arguments, object-literal fields | `src/infer/unifyDiag.ts` (`argumentOutsideParameter`, `checkObjectLiteralFields`) |
| Union direction: results against annotations | `src/hm/unify.ts` (`unifyWidening`) |
| Union direction in overload trials, union distribution | `src/infer/call-overloads.ts` (`argOutsideBranch`) |
| Excess fields of an object literal (HM1010) | `src/infer/unifyDiag.ts` (`findExcessRecordFields`) |
| Annotation-extent diagnostic filtering | `src/server.ts` |

The structural rules are deliberately *name-blind*: nothing dispatches on an
identifier being called `pipe` or `reduce`. If a rule fires, it fired because
the types had the shape — which is what keeps the special forms honest
members of the type system rather than hard-coded library knowledge.
