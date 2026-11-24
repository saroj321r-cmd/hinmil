// =============================================================================
// Rank-N example 03 — interpreters: one polymorphic handler for every element
//
// The foldFree/interpreter pattern: a function receives a handler that must
// work for ALL element types (`forall a. [a] -> Maybe a`) and applies it to
// differently-typed parts of a data structure.
// =============================================================================

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

// safeHead :: [a] -> Maybe a
const safeHead = xs => (xs.length > 0 ? Just(xs[0]) : Nothing());

// firstOf :: (forall a. [a] -> Maybe a) -> { nums :: [Number], strs :: [String] } -> [Maybe Number, Maybe String]
const firstOf = pick => rec => [pick(rec.nums), pick(rec.strs)];

const ok = firstOf(safeHead)({ nums: [1, 2, 3], strs: ["a", "b"] });

// Negative (uncomment): a handler that can only deal with Numbers is not
// polymorphic enough.
//
// // numHead :: [Number] -> Maybe Number
// const numHead = xs => (xs.length > 0 ? Just(xs[0] * 1) : Nothing());
// const bad = firstOf(numHead)({ nums: [1], strs: ["a"] });

export { safeHead, firstOf, ok };
