"use strict";

const curry = require ("../more/curry");
const findAlg = require ("../more/findAlg");

let natives = {};

// natives.Function :: Function [a] b ~> Function [b] c -> Function [a] c
natives.Function = function (then) {
  return input => then (this (input));
};

// The dispatcher takes the value first (see ap.js).
// composeFn :: Semigroupoid c => c i j -> c j k -> c i k
// composeFn :: Function [a] b -> Function [b] c -> Function [a] c
const composeFn = findAlg ("compose") (natives) (false);

// Right to left: `compose (g) (f)` runs f, then g.
// compose :: Semigroupoid c => c j k -> c i j -> c i k
// compose :: Function [b] c ->  Function [a] b -> Function [a] c
const compose = curry ((second, first) => composeFn (first) (second));

module.exports = compose;
