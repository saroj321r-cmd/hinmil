"use strict";

const Tuple = require (".");

// The pair-sized tuple factory.
// Tuple2 :: a -> b -> Tuple2 a b
const Tuple2 = Tuple (2);

module.exports = Tuple2;
