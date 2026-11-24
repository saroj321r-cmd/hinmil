// =============================================================================
// Rank-N example 06 — withResource: skolem escape (the runST pattern)
//
// `forall s.` in a callback type brands a resource: the callback may work
// with it, but the brand must not leave the result. If a call tries to
// smuggle the branded value out anyway, the checker reports "Polymorphic
// value escapes its scope".
// =============================================================================

// withSecret :: (forall s. s -> Number) -> Number
const withSecret = use => use({ token: 42 });

// Positive: the callback does not look at the resource itself.
const ok = withSecret(_s => 7);

// Negative 1 (uncomment): the identity returns the resource → the result
// type would contain the skolem → escape diagnostic.
//
// // extract :: (forall s. s -> a) -> a
// const extract = f => f(0);
// const leaked = extract(x => x);

// Negative 2 (uncomment): a monomorphic callback is not polymorphic enough.
//
// // mono :: Number -> Number
// const mono = x => x + 1;
// const bad = withSecret(mono);

export { withSecret, ok };
