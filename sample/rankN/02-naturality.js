// =============================================================================
// Rank-N example 02 — naturality: `forall a. Maybe a -> Maybe a`
//
// A natural transformation must not look at the elements; the `forall`
// enforces that. `mx => mx.map(x => x)` is NOT natural enough according to
// the checker (map demands a function on the element), but pure structure
// preservation (identity, or producing Nothing) is.
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

// applyNat :: (forall a. Maybe a -> Maybe a) -> (Maybe Number, Maybe String) -> [Maybe Number, Maybe String]
const applyNat = nat => (mn, ms) => [nat(mn), nat(ms)];

// idNat :: Maybe a -> Maybe a
const idNat = mx => mx;

const ok = applyNat(idNat)(Just(1), Just("one"));

// Negative (uncomment): a transformation that only works on Maybe Number
// is not a natural transformation.
//
// // onlyNumbers :: Maybe Number -> Maybe Number
// const onlyNumbers = mx => mx.map(x => x * 2);
// const bad = applyNat(onlyNumbers)(Just(1), Just("one"));

export { applyNat, idNat, ok };
