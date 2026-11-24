// =============================================================================
// Rank-N example 04 — hoist: constraints INSIDE the forall (HKT binders)
//
// `forall f. Functor f => f Number -> f Number` demands a transformation that
// works for EVERY functor and only uses the Functor interface. The constraint
// inside the forall gives the skolemized `f` its methods.
// =============================================================================

// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// Maybe :: Just a | Nothing

// Just :: a -> Maybe a
class Just {
  constructor(value) {
    // Maybe#value :: Maybe a ~> a
    this.value = value;
  }

  // Maybe#map :: Maybe a ~> (a -> b) -> Maybe b
  map(fn) {
    return new Just(fn(this.value));
  }
}

// Nothing :: () -> Maybe a
class Nothing {
  map(_fn) {
    return new Nothing();
  }
}

// hoistTwice :: (forall f. Functor f => f Number -> f Number) -> Maybe Number -> Maybe Number
const hoistTwice = step => mx => step(step(mx));

// double :: Functor f => f Number -> f Number
const double = fx => fx.map(x => x * 2);

const ok = hoistTwice(double)(Just(10));

// Negative (uncomment): a Maybe-specific step is not generic enough for
// `forall f. Functor f => ...`.
//
// // maybeOnly :: Maybe Number -> Maybe Number
// const maybeOnly = mx => mx;
// const bad = hoistTwice(maybeOnly)(Just(1));

export { hoistTwice, double, ok };
