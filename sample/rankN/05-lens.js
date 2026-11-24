// =============================================================================
// Rank-N example 05 — Van Laarhoven lens
//
// A lens is `forall f. Functor f => (a -> f a) -> s -> f s`: one value that
// works with EVERY functor. `over` picks Identity; the same lens would be a
// getter with Const. Without rank-2 this type cannot be expressed.
// =============================================================================

// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// Identity :: a -> Identity a
class Identity {
  constructor(value) {
    // Identity#value :: Identity a ~> a
    this.value = value;
  }

  // Identity#map :: Identity a ~> (a -> b) -> Identity b
  map(fn) {
    return new Identity(fn(this.value));
  }
}

// over :: (forall f. Functor f => (Number -> f Number) -> s -> f s) -> (Number -> Number) -> s -> s
const over = lens => fn => s => lens(x => new Identity(fn(x)))(s).value;

// xLens :: Functor f => (Number -> f Number) -> { x :: Number, y :: Number } -> f { x :: Number, y :: Number }
const xLens = fn => p => fn(p.x).map(x => ({ x: x, y: p.y }));

const moved = over(xLens)(n => n + 10)({ x: 1, y: 2 });

export { over, xLens, moved };
