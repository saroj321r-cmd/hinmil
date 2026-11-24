"use strict";

const curry = require ("../more/curry");
const identity = require ("../combinator/identity");
const maybe = require ("../Maybe/maybe");
const prop = require ("./prop");

// `prop`, with a fallback instead of a Maybe.
// propOr :: a -> k -> { [k] :: a, ...r } -> a
// propOr :: a -> Number -> [a] -> a
// propOr :: a -> [k1, k2, k3] -> { [k1] :: { [k2] :: { [k3] :: a, ...r3 }, ...r2 }, ...r1 } -> a
// propOr :: a -> [k1, k2] -> { [k1] :: { [k2] :: a, ...r2 }, ...r1 } -> a
// propOr :: a -> [k1,] -> { [k1] :: a, ...r } -> a
const propOr = curry ((fallback, where, target) =>
  maybe (fallback) (identity) (prop (where) (target)));

module.exports = propOr;
