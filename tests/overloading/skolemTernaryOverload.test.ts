// Regression tests for TypeRep constructor-identity semantics and applied
// constraints (fpkit fantasy-land law files — ChainRec/Applicative/Alternative/
// Traversable).
//
// Core invariants:
//  1. `TypeRep f` binds the BARE constructor from a witness function
//     (`a -> Identity a` witnesses `TypeRep Identity`), so one rep is usable
//     at MULTIPLE element types in a body (Applicative interchange).
//  2. An applied constraint (`Setoid (m b)`) must NOT pin `TypeRep m` to one
//     arbitrary application when `m` is used at varying args — the pin used
//     to make a callee's bare rep var collapse `m c` into the ill-kinded
//     `m a c` (fpkit ChainRec equivalence law).
//  3. A kv var bound to another kv APPLICATION contributes no phantom args
//     at other usage sites (`f b` stays `f b`, never `f a b`).
//  4. Nested applied-constraint args parse and discharge
//     (`Setoid (f (t a))`, Traversable identity law).

import { diags } from '../helpers/infer';

const PRELUDE = `
// ::constraint Setoid s { s :: { equals :: s ~> s -> Boolean } }
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Apply f { f :: Functor, f :: { ap :: f a ~> f (a -> b) -> f b } }
// ::constraint Applicative f { f :: Apply, f :: { of :: a -> f a } }
// ::constraint Alt f { f :: Functor, f :: { alt :: f a ~> f a -> f a } }
// ::constraint Plus f { f :: Alt, f :: { zero :: () -> f a } }
// ::constraint Alternative f { f :: Applicative, f :: Plus }
// ::constraint Chain m { m :: Apply, m :: { chain :: m a ~> (a -> m b) -> m b } }
// ::constraint ChainRec m { m :: Chain, m :: { chainRec :: ((a -> c) -> (b -> c) -> a -> m c) -> a -> m b } }

// map :: Functor f => (a -> b) -> f a -> f b
// map :: (a -> b) -> { [k] :: a } -> { [k] :: b }
const map = f => xs => map (f) (xs);
// ap :: Apply f => f a -> f (a -> b) -> f b
const ap = fa => ff => ap (fa) (ff);
// of :: Applicative f => TypeRep f -> a -> f a
const of = T => x => of (T) (x);
// zero :: Plus f => TypeRep f -> f a
const zero = T => zero (T);
// equals :: Setoid s => s -> s -> Boolean
const equals = x => y => equals (x) (y);
// chainRec :: ChainRec m => TypeRep m -> ((a -> c) -> (b -> c) -> a -> m c) -> a -> m b
const chainRec = T => f => x => chainRec (T) (f) (x);
`;

function noMismatch(msgs: string[]): void {
  expect(msgs.filter(m => m.includes('Cannot unify'))).toEqual([]);
  expect(msgs.filter(m => m.includes('infinite type'))).toEqual([]);
}

describe('TypeRep constructor identity across multiple element types', () => {
  test('ChainRec equivalence: applied Setoid (m b) does not pin TypeRep m (no `m a c`)', () => {
    const src = `${PRELUDE}
// equivalence :: (ChainRec m, Setoid (m b)) => TypeRep m -> (a -> Boolean) -> (a -> m a) -> (a -> m b) -> a -> Boolean
const equivalence = M => p => n => d => i => {
  const lhs = chainRec (M) (next => done => v => (p (v) ? map (done) (d (v)) : map (next) (n (v)))) (i);
  return true;
};
`;
    noMismatch(diags(src));
  });

  test('Applicative interchange: one rep used at two element types', () => {
    const src = `${PRELUDE}
// interchange :: (Applicative f, Setoid (f b)) => TypeRep f -> f (a -> b) -> a -> Boolean
const interchange = A => u => y => {
  const lhs = ap (u) (of (A) (fn => fn (y)));
  const rhs = ap (of (A) (y)) (u);
  return equals (rhs) (lhs);
};
`;
    noMismatch(diags(src));
  });

  test('Alternative annihilation: zero(A) element stays free of the Setoid pin', () => {
    const src = `${PRELUDE}
// annihilation :: (Alternative f, Setoid (f a)) => TypeRep f -> f a -> Boolean
const annihilation = A => x => {
  const lhs = ap (x) (zero (A));
  const rhs = zero (A);
  return equals (rhs) (lhs);
};
`;
    noMismatch(diags(src));
  });

  test('Traversable identity: nested applied constraint Setoid (f (t a)) parses and discharges', () => {
    const src = `${PRELUDE}
// ::constraint Foldable t { t :: { reduce :: t a ~> ((b, a) -> b, b) -> b } }
// ::constraint Traversable t { t :: Functor, t :: Foldable, t :: { traverse :: t a ~> (TypeRep f, a -> f b) -> f (t b) } }

// traverse :: (Traversable t, Applicative f) => TypeRep f -> (a -> f b) -> t a -> f (t b)
const traverse = T => f => xs => traverse (T) (f) (xs);

// identity :: (Traversable t, Applicative f, Setoid (f (t a))) => TypeRep f -> t a -> Boolean
const identity = F => u => {
  const lhs = traverse (F) (of (F)) (u);
  const rhs = of (F) (u);
  return equals (rhs) (lhs);
};
`;
    const msgs = diags(src);
    noMismatch(msgs);
    expect(msgs.filter(m => m.includes('Missing constraint'))).toEqual([]);
    expect(msgs.filter(m => m.includes('Invalid type annotation'))).toEqual([]);
  });
});

describe('binary container (Either e a) through TypeRep slots', () => {
  // fpkit Either/index.spec.js: a 2-arg sumtype rep (typed `TypeRep (Either e a)`)
  // bound to a `TypeRep m` slot and RE-applied in the body (`m c`) must not
  // produce the ill-kinded `Either e a c` — the saturated binding's trailing
  // type-VARIABLE args are one element application, not constructor identity
  // (over-saturation trim in Substitution.apply).  Bare `m` usages (kind-*
  // reps like `Monoid m => TypeRep m -> m`) keep the full saturated binding —
  // covered by tests/constraints/sumtypeCarrierTypeRepWitness.test.ts.
  const EITHER = `
// Either :: Left e | Right a

// Left :: e -> Either e a
function Left(value) { this.value = value; }
// Right :: a -> Either e a
function Right(value) { this.value = value; }
`;

  function noArity(msgs: string[]): void {
    noMismatch(msgs);
    expect(msgs.filter(m => m.includes('type argument'))).toEqual([]);
  }

  test('chainRec (Either): rep re-applied at a fresh element (`m c`) keeps arity 2', () => {
    const src = `${PRELUDE}${EITHER}
const r = chainRec (Either) (next => done => x => x < 10 ? new Left ("< 10.") : new Right (x >= 100 ? done (x) : next (x + x))) (1);
`;
    noArity(diags(src));
  });

  test('equivalence (Either): applied Setoid (m b) + binary rep — no arity error', () => {
    const src = `${PRELUDE}${EITHER}
// equivalence :: (ChainRec m, Setoid (m b)) => TypeRep m -> (a -> Boolean) -> (a -> m a) -> (a -> m b) -> a -> Boolean
const equivalence = M => p => n => d => i => equivalence (M) (p) (n) (d) (i);
const r = equivalence (Either) (x => x >= 100) (x => x < 10 ? new Left ("< 10.") : new Right (x + x)) (x => new Right (x)) (10);
`;
    noArity(diags(src));
  });

  test('naturality: two unary reps (Array, Maybe) alongside a binary Traversable container', () => {
    const src = `${PRELUDE}
// ::constraint Foldable t { t :: { reduce :: t a ~> (b -> a -> b) -> b -> b } }
// ::constraint Traversable t { t :: Functor, t :: { traverse :: Applicative f => t a ~> TypeRep f -> (a -> f b) -> f (t b) } }
${EITHER}
// Maybe :: Nothing | Just a

// Just :: a -> Maybe a
function Just(value) { this.value = value; }

// head :: Foldable f => f a -> Maybe a
const head = xs => head (xs);
// naturality :: (Traversable t, Applicative f, Applicative g) => TypeRep f -> TypeRep g -> (f a -> g a) -> t (f a) -> Boolean
const naturality = F => G => nt => tfa => naturality (F) (G) (nt) (tfa);
const r1 = naturality (Array) (Maybe) (head) (new Left (["a"]));
const r2 = naturality (Array) (Maybe) (head) (new Right ([1]));
`;
    noArity(diags(src));
  });
});

describe('curried overloaded call with skolem container in ternary arms', () => {
  test('both ternary arms resolve the Functor branch — no mismatch', () => {
    const src = `${PRELUDE}
// fn :: Chain m => (a -> Boolean) -> (a -> c) -> (b -> c) -> (a -> m a) -> (a -> m b) -> a -> m c
const fn = p => next => done => n => d => v =>
  (p (v) ? map (done) (d (v)) : map (next) (n (v)));
`;
    const msgs = diags(src);
    expect(msgs.filter(m => m.includes('Cannot unify'))).toEqual([]);
    expect(msgs.filter(m => m.includes('Type mismatch'))).toEqual([]);
  });

  test('single arm (no ternary) resolves the Functor branch', () => {
    const src = `${PRELUDE}
// fn :: Chain m => (a -> c) -> (a -> m a) -> a -> m c
const fn = next => n => v => map (next) (n (v));
`;
    const msgs = diags(src);
    expect(msgs.filter(m => m.includes('Cannot unify'))).toEqual([]);
  });
});
