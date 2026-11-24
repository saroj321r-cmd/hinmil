// =============================================================================
// Rank-N example 07 — Church encoding
//
// A Church numeral is `forall a. (a -> a) -> a -> a`: it promises to work
// with EVERY carrier type. Thanks to rank-2, `toNumber` can genuinely demand
// that — a "numeral" that secretly only works with Numbers gets caught.
// =============================================================================

// zero :: forall a. (a -> a) -> a -> a
const zero = _f => x => x;

// two :: forall a. (a -> a) -> a -> a
const two = f => x => f(f(x));

// toNumber :: (forall a. (a -> a) -> a -> a) -> Number
const toNumber = n => n(x => x + 1)(0);

// toString :: (forall a. (a -> a) -> a -> a) -> String
const toString = n => n(s => s + "|")("");

const n0 = toNumber(zero);
const n2 = toNumber(two);
const s2 = toString(two);

// Negative (uncomment): not a real Church numeral — it only works on
// Numbers, so it is not polymorphic enough.
//
// const fake = f => x => f(x) + 1;
// const bad = toNumber(fake);

export { zero, two, toNumber, toString, n0, n2, s2 };