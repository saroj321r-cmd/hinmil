// =============================================================================
// Rank-N example 08 — dictionary passing: polymorphic record fields
//
// A field with `forall` stores a genuinely polymorphic function: every access
// instantiates fresh, and at construction the field is checked for
// polymorphism. This is how you build explicit "method dictionaries".
// =============================================================================

// listOps :: { map :: forall a b. (a -> b) -> [a] -> [b], name :: String }
const listOps = {
  map: fn => xs => xs.map(fn),
  name: "list",
};

// The field works on any element type — two uses, two instantiations:
const nums = listOps.map(x => x * 2)([1, 2, 3]);
const lens = listOps.map(s => s.length)(["aa", "b"]);

// Negative (uncomment): a "map" that simply returns the input list cannot
// live up to `[a] -> [b]`.
//
// // badOps :: { map :: forall a b. (a -> b) -> [a] -> [b], name :: String }
// const badOps = {
//   map: _fn => xs => xs,
//   name: "bad",
// };

export { listOps, nums, lens };
