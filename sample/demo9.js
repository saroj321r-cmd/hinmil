"use strict";

// ==========================================================================
// demo9.js — Container-wrapped spread arrow-chains (`f (...)`)
//
// Cousins of the `pipe` combinator family.  A `Foldable` container holding a
// spread arrow-chain — `f (a -> b, b -> c, ..., y -> z)` — must behave exactly
// like the bare spread tuple `(a -> b, ..., y -> z)` (demo2 ex3) and the
// spread array `[a -> b, ..., y -> z]` (demo2 ex8), both at the definition
// site (body inference vs. the annotation) and at every call site
// (`combinator([f, g, ...])(x)`).
// ==========================================================================

// ==========================================================================
// THE SPECIAL "reduce-over-chain" RULE  (why this file type-checks)
// ==========================================================================
//
// A spread arrow-chain type is a Tuple whose elements are arrows joined at
// their boundaries, with a `...` marker standing for "zero or more further
// links of the same shape":
//
//     (a -> b, b -> c, ..., y -> z)
//      \___/  \___/       \___/
//       e0     e1          eN        result(e_k) == param(e_{k+1})
//
// Wrapped in a Foldable container it becomes  `f (a -> b, b -> c, ..., y -> z)`.
// Two independent problems arise; the "reduce-over-chain" rule is the set of
// three cooperating mechanisms that solve them.  It is scoped *narrowly*: it
// only fires when the tuple is a spread whose non-spread elements are ALL
// arrows (`isSpread` + every element `TFun`).  Plain heterogeneous spreads
// like `(String, ..., Number)` and multi-arity fan-outs are untouched.
//
// ------------------------------------------------------------------------
// PROBLEM 1 — the definition site (the combinator BODY vs. its annotation)
// ------------------------------------------------------------------------
// A generic `pipe`/`compose` folds the chain with a plain `reduce`.  The
// reducer (`applyTo :: a -> (a -> b) -> b`, or an inline `acc => fn => …`)
// forces every accumulator step to share ONE type variable, so the body can
// only ever infer the *endomorphic collapse* of the chain:
//
//     annotation : f (a -> b, b -> c, ..., y -> z) -> a -> z
//     body infers: f (a -> b, b -> c, ..., y -> a) -> a -> a   (z unified to a)
//
// This is mathematically unavoidable with a standard `reduce` — the fold pins
// the seed, the element and the result to the same variable *before* the
// container is even consulted.  Two mechanisms keep this honest yet usable:
//
//   (1a) Chain-tuple → arrow COLLAPSE (in unification).  When the whole
//        chain tuple `(a -> b, b -> c, ..., y -> z)` is unified against a
//        single arrow (the reducer's per-element expectation), it collapses
//        to its composed endpoints `first.param -> last.result` (= `a -> z`)
//        instead of melting all elements into one homogeneous arrow.  This
//        removes the spurious `Cannot unify '(a -> b, ..., y -> a)' with
//        'a -> a'` error the naive fold would raise.
//
//   (1b) Rigid-check TRUST FALLBACK (annotation vs. body).  The remaining
//        gap — body `… -> a -> a` is *less* polymorphic than the declared
//        `… -> a -> z` — would normally be reported as "implementation less
//        polymorphic than its annotation".  For a chain-container annotation
//        we TRUST the declared signature and suppress that one diagnostic,
//        because the endomorphic collapse is an artefact of `reduce`, not a
//        real bug.  The *exported* type is therefore the annotation, so every
//        consumer still sees the fully heterogeneous `a -> z`.
//
// ------------------------------------------------------------------------
// PROBLEM 2 — every call site (`combinator([f, g, …])(x)`)
// ------------------------------------------------------------------------
// Because these combinators are curried (`foldable => value => …`), a call
// `pipe([f, g])(x)` used to route through the ordinary curried-call path,
// which unified the array literal *homogeneously* against `f (…tuple…)` and
// so tried to merge the two heterogeneous element results (e.g. `Number` and
// `String`) into one — the infamous `Cannot unify 'String' with 'Number'`.
//
//   (2)  Call-site RE-ROUTING.  When the callee resolves to
//        `f (spread-tuple-of-single-arg-arrows)` and is applied to a single
//        array literal, the call is detected up front, the container variable
//        `f` is bound to the literal's concrete container (`Array`, so the
//        Foldable `::rep` still discharges), and the elements are threaded
//        through the SAME spread-array chain-linking machinery used by the
//        bare `[a -> b, ..., y -> z]` form (demo2 ex8).  Each element links
//        to the next positionally; the last element's result is the answer.
//
// ------------------------------------------------------------------------
// SOUNDNESS boundary (what is NOT suppressed)
// ------------------------------------------------------------------------
//   * A broken link — `[x => x + 1, x => x.length]` feeds a `Number` where a
//     `String` is required — is still a hard error.
//   * Too few stages for the spread (`< 2` links) is still an arity error.
//   * A multi-arity head (`f (x1 -> x2 -> z, a -> x1, …)`) is a *fan-out*, not
//     a linear chain, and keeps flowing through fan-out recognition (§4).
//
// ------------------------------------------------------------------------
// THE DUAL — applyArgs peeling (§5)
// ------------------------------------------------------------------------
// The pipe/compose family folds a container of ARROWS `f (a->b, ..., y->z)`
// and, as shown above, its worst case is a *finite* endomorphic collapse (the
// accumulator variable is pinned: `b = a`).  Its mirror image is `applyArgs`,
// which folds a SINGLE curried function over an array of its arguments:
//
//     applyArgs : (a -> b -> ... -> z) -> [a, b, ...] -> z
//     const applyArgs = reduce(apply)          // apply : (a -> b) -> a -> b
//
// Here the accumulator changes type at EVERY step — it starts as the whole
// curried function and sheds one arrow per argument consumed — so the same
// naive `reduce` produces a genuine INFINITE type (`d = c -> d`, an
// occurs-check failure) rather than a finite collapse.  A third, *dual*
// mechanism keeps it usable:
//
//   (3)  applyArgs PEELING.  When a curried function is applied through the
//        `[a, b, ...]` applier, the result is derived by PEELING the function
//        by the number of array elements:
//          #elements === #levels -> full application    -> terminal result z
//          #elements <  #levels  -> partial application  -> curried remainder
//          #elements >  #levels  -> over-application     -> hard diagnostic
//        The declared arrow chain is trusted (its occurs-check is suppressed,
//        exactly mirroring (1b)), and the per-element linking reuses the SAME
//        spread-array machinery as (2) — both meet inside `inferSpreadArrayCall`.
//
// So the two rules are DUALS: (1a/1b/2) collapse-and-trust a container of
// arrows (finite); (3) peel-and-trust a curried function over an array of
// values (infinite).  Section 5 exercises the peeling path.
//
// The sections below exercise each of these paths with working examples.
// ==========================================================================

// --- Foldable / Chain machinery (self-contained) --------------------------

// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b, reduceRight :: f a ~> (b -> a -> b) -> b -> b } }
// ::constraint Chain m { m :: { chain :: m a ~> (a -> m b) -> m b } }

let natives = {};

// ::rep Foldable Array#reduce
// ::rep Foldable Array#reduceRight
// natives.Array :: Array a ~> (b -> a -> b) -> b -> b
natives.Array = function (fn) {
  return init => this.reduce((acc, value) => fn(acc)(value), init);
};

// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b
const reduce = fn => init => foldable => natives.Array(fn)(init);

// reduceRight :: Foldable f => (b -> a -> b) -> b -> f a -> b
const reduceRight = fn => init => foldable => natives.Array(fn)(init);

// applyTo :: a -> (a -> b) -> b
const applyTo = value => fn => fn(value);

// id :: a -> a
const id = x => x;

// compose2 :: (b -> c) -> (a -> b) -> a -> c
const compose2 = f => g => x => f(g(x));

// apply :: (a -> b) -> a -> b
const apply = fn => value => fn(value);

// --- Box (a Chain functor) for the Kleisli cousins ------------------------

// Box :: a -> Box a
const Box = value => ({
  value,
  // Box#map :: Box a ~> (a -> b) -> Box b
  map: fn => Box(fn(value)),
  // Box#chain :: Box a ~> (a -> Box b) -> Box b
  chain: fn => fn(value),
});

// ==========================================================================
// 1. pipe — left-to-right composition over a Foldable of arrows
//    Exercises the FULL rule: body inference (1a collapse + 1b trust) at the
//    definition, and call-site re-routing (2) at every `pipe([…])(x)`.
// ==========================================================================

// pipe :: Foldable f => f (a -> b, b -> c, ..., y -> z) -> a -> z
const pipe = foldable => value => reduce(applyTo)(value)(foldable);

// number in, boolean out — two heterogeneous element result types
const pipe1 = pipe([x => x + 1, x => x > 0])(3);

// three-stage heterogeneous chain: Number -> Number -> String -> Boolean
const pipe2 = pipe([x => x + 1, x => "n" + x, x => x.length > 0])(3);

// point-free: the intermediate combinator is fully applied later
const numberToFlag = pipe([x => x + 1, x => x > 0]);
const pipe3 = numberToFlag(41);

// --- reusable named stages ------------------------------------------------

// inc :: Number -> Number
const inc = x => x + 1;
// label :: Number -> String
const label = x => "n" + x;
// size :: String -> Number
const size = x => x.length;
// isPos :: Number -> Boolean
const isPos = x => x > 0;

// named-function stages instead of inline arrows
const pipe4 = pipe([inc, isPos])(3);

// a longer four-stage chain mixing named + inline stages
const pipe5 = pipe([inc, label, size, isPos])(3);

// the chain array may be a plain variable, not just a literal
const stages = [inc, label, size, isPos];
const pipe6 = pipe(stages)(3);

// a pipe stage may itself be a pipe — nested composition
const addTwice = pipe([inc, inc]);
const pipe7 = pipe([addTwice, isPos])(3);

// --- point-free, composition-RETURNING pipe -------------------------------
// Instead of threading a seed value, fold the chain into the composed
// function `a -> z` and return it directly (demo2 ex8 style, over a generic
// container).  Partial application therefore yields the arrow itself.  This is
// the clearest view of mechanism (1a): the chain collapses to the composed
// endpoints, so `pipeFn([inc, isPos])` is exactly `Number -> Boolean`.

// pipeFn :: Foldable f => f (a -> b, b -> c, ..., y -> z) -> a -> z
const pipeFn = foldable => reduce(acc => fn => compose2(fn)(acc))(id)(foldable);

// the composed arrow, not yet applied: Number -> Boolean
const numberToFlag2 = pipeFn([inc, isPos]);
const pipe8 = pipeFn([inc, isPos])(3);


// ==========================================================================
// 2. compose — genuine right-to-left composition (reduceRight over a Foldable)
//    Same rule, mirrored chain `(y -> z, x -> y, ..., a -> b)`: (1a) collapses
//    it to `a -> z`, (1b) trusts the annotation, (2) re-routes the call.
// ==========================================================================

// compose :: Foldable f => f (y -> z, x -> y, ..., a -> b) -> a -> z
const compose = foldable => value => reduceRight(applyTo)(value)(foldable);

// String -> Number -> Boolean, read right-to-left as (isPos ∘ size)
const compose1 = compose([isPos, size])("hello");

// ==========================================================================
// 3. pipeK — Kleisli composition over a Foldable of `a -> m b` arrows
//    (the Chain-constrained cousin, mirrors demo2 ex5/ex10).  The chain links
//    on the *inner* results `m b`; the rule still applies (1a/1b/2), yielding
//    the heterogeneous `a -> m z`.
// ==========================================================================

// pipeK :: (Foldable f, Chain m) => f (a -> m b, b -> m c, ..., y -> m z) -> a -> m z
const pipeK = foldable => value =>
  reduce(acc => fn => acc.chain(fn))(Box(value))(foldable);

const pipeK1 = pipeK([x => Box(x + 1), x => Box(x > 0)])(3);

// ==========================================================================
// 4. fan-out (converge) — the SAME container-of-arrows shape but a
//    multi-arity head; the reduce-over-chain rule deliberately does NOT fire
//    here (the head is not a single-arg arrow), so it keeps flowing through
//    fan-out recognition instead — see the SOUNDNESS boundary above.
// ==========================================================================

// coerce :: a -> b
const coerce = v => v;

// converge :: Foldable f => f (x1 -> x2 -> ... -> z, a -> x1, a -> x2, ...) -> a -> z
const converge = fns => value => coerce(value);

// add3 :: Number -> Number -> Number -> Number
const add3 = x => y => z => x + y + z;

const converge1 = converge([add3, x => x + 1, x => x + 2, x => x + 3])(1);

// ==========================================================================
// 5. applyArgs — the DUAL rule: peeling a curried function over its arguments
//    Mirror of §1-4.  Instead of folding a container of ARROWS, fold ONE
//    curried function over an array of VALUES.  The accumulator changes type
//    per step (an infinite type for a naive `reduce`), so mechanism (3) PEELS
//    the function by the array length instead of collapsing a chain.  See the
//    DUAL note in the header block above.
// ==========================================================================

// applyArgs :: (a -> b -> ... -> z) -> [a, b, ...] -> z
const applyArgs = reduce(apply);

// full application (2 levels, 2 elements) -> the terminal result Number
const sum2 = applyArgs(x => y => x + y)([1, 2]);

// heterogeneous element types tie to the parameters -> String
const firstOf2 = applyArgs(s => n => s)(["hi", 42]);

// partial application (3 levels, 2 elements) -> the curried remainder a -> Number
const addThreePartial = applyArgs(x => y => z => x + y)([1, 2]);

// SOUNDNESS: over-application (more elements than curried levels) is a hard
// error — `applyArgs(x => x)([1, 2])` reports "takes at most 1 argument".  It
// is exercised in the test suite rather than here so this file stays clean.
