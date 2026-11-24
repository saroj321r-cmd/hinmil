// =============================================================================
// Rank-N example 01 — applyBoth: a genuinely polymorphic callback argument
//
// `forall a. a -> a` in parameter position demands that the argument work for
// EVERY type. Without `forall`, rank-1 HM silently accepts too much here
// (the classic limitation); with `forall` it is enforced.
// =============================================================================

// applyBoth :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];

// Positive: the identity function is polymorphic enough.
const ok = applyBoth(x => x)(1, "one");

// Negative (uncomment to see the diagnostic):
// "Argument is not polymorphic enough: expected 'forall a. a -> a'
//  but got 'Number -> Number'"
//
// const bad = applyBoth(x => x + 1)(1, "one");

export { applyBoth, ok };
