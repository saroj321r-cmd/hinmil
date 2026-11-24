"use strict";

const curry = require ("../more/curry");
const lt = require ("./lt");

// `gt (x) (y)`: is y greater than x?
// gt :: Ord a => a -> a -> Boolean
const gt = curry ((x, y) => lt (y) (x));

module.exports = gt;
