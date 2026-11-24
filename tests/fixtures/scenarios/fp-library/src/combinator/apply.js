"use strict";

const curry = require ("../more/curry");

// Function application as a function.
// apply :: (a -> b) -> a -> b
const apply = curry ((f, x) => f (x));

module.exports = apply;
