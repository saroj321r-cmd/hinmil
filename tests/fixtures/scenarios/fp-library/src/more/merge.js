"use strict";

// ::types ../Pair/index
// ::types ../Tuple

const curry = require ("./curry");

// Spreads the parts of a pair or tuple over a curried function.  The second
// argument chooses the overload; Pair and Tuple2 share a branch so that a
// point-free `compose (merge (f))` resolves before the value is known.
// merge :: (a -> b -> z) -> (Pair a b | Tuple2 a b) -> z
// merge :: (a -> b -> c -> z) -> Tuple3 a b c -> z
// merge :: (a -> b -> c -> d -> z) -> Tuple4 a b c d -> z
// merge :: (a -> b -> c -> d -> e -> z) -> Tuple5 a b c d e -> z
const merge = curry ((f, parts) => parts.merge (f));

module.exports = merge;
