"use strict";

const curry = require ("../more/curry");
const lte = require ("./lte");

// `lt (x) (y)`: is y less than x?
// lt :: Ord a => a -> a -> Boolean
const lt = curry ((x, y) => !lte (y) (x));

module.exports = lt;
