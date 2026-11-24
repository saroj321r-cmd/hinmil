"use strict";

// Chain builds on Apply and Functor (ap.js, map.js).
// ::types ./ap
// ::types ./map

const curry = require ("../more/curry");
const findAlg = require ("../more/findAlg");

let natives = {};

// ::rep Chain Array#chain
// Array#chain :: natives.Array :: Array a ~> (a -> Array b) -> Array b
natives.Array = function (f) {
  return this.flatMap (x => f (x));
};

// A function as a reader: the next step also sees the original input.
// ::rep Chain Function#chain
// natives.Function :: Function [x] a ~> (a -> Function [x] b) -> Function [x] b
natives.Function = function (f) {
  return input => f (this (input)) (input);
};

// The dispatcher takes the value first (see ap.js).
// chainFn :: Chain m => m a -> (a -> m b) -> m b
const chainFn = findAlg ("chain") (natives) (false);

// chain :: Chain m => (a -> m b) -> m a -> m b
const chain = curry ((f, m) => chainFn (m) (f));

module.exports = chain;
