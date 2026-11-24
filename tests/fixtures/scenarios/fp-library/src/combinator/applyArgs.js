"use strict";

const apply = require ("./apply");
const reduce = require ("../fl/reduce");

// Feeds a curried function its arguments one by one.
// applyArgs :: (a -> b -> ... -> z) -> [a, b, ...] -> z
const applyArgs = reduce (apply);

module.exports = applyArgs;
