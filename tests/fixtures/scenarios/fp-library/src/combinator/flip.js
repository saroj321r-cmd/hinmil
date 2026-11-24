"use strict";

const curry = require ("../more/curry");

// Swaps the first two arguments of a curried function.
// flip :: (a -> b -> c) -> b -> a -> c
const flip = curry ((f, second, first) => f (first) (second));

module.exports = flip;
