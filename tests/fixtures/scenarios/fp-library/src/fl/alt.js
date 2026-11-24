"use strict";

// Alt builds on Functor; the Object and Function functors are in map.js.
// ::types ./map

const curry = require ("../more/curry");
const findAlg = require ("../more/findAlg");
const concat = require ("./concat");

let natives = {};

// For lists and records, the alternative is everything from both.
// ::rep Alt Array#alt
// natives.Array :: Array a ~> Array a -> Array a
natives.Array = function (other) {
  return concat (other) (this);
};

// ::rep Alt Object#alt
// natives.Object :: Object k a ~> Object k a -> Object k a
natives.Object = function (other) {
  return concat (other) (this);
};

// Pointwise: both functions run on the input, their results are combined.
// ::rep Alt Function#alt
// natives.Function :: Alt f => Function [a] (f a) ~> Function [a] (f a) -> Function [a] (f a)
natives.Function = function (other) {
  return input => alt (other (input)) (this (input));
};

// The dispatcher takes the value first (see ap.js).
// altFn :: Alt f => f a -> f a -> f a
// altFn :: Array a -> Array a -> Array a
// altFn :: Alt f => Function [a] (f a) -> Function [a] (f a) -> Function [a] (f a)
const altFn = findAlg ("alt") (natives) (false);

// alt :: Alt f => f a -> f a -> f a
// alt :: Array a -> Array a -> Array a
// alt :: Alt f => Function [a] (f a) -> Function [a] (f a) -> Function [a] (f a)
const alt = curry ((fallback, first) => altFn (first) (fallback));

module.exports = alt;
