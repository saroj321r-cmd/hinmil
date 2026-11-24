"use strict";

const curry = require ("../more/curry");
const ap = require ("./ap");
const map = require ("./map");

// A binary function lifted into an Apply.
// lift2 :: Apply f => (a -> b -> c) -> f a -> f b -> f c
const lift2 = curry ((f, first, second) => ap (map (f) (first)) (second));

module.exports = lift2;
