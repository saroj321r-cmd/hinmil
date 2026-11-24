"use strict";

// Apply builds on Functor; the Function and Object functors are in map.js.
// ::types ./map

const curry = require ("../more/curry");
const findAlg = require ("../more/findAlg");
const hasProp = require ("../object/hasProp");

let natives = {};

// Every function applied to every value, functions outermost.
// ::rep Apply Array#ap
// natives.Array :: Array a ~> Array (a -> b) -> Array b
natives.Array = function (fns) {
  return fns.flatMap (f => this.map (x => f (x)));
};

// Applies field-wise: only the fields both records have.
// natives.Object :: { [a] :: b } ~> { [a] :: b -> c } -> { [a] :: c }
natives.Object = function (fns) {
  const out = {};
  Object.keys (this).forEach (key => {
    if (hasProp (key) (fns)) out[key] = fns[key] (this[key]);
  });
  return out;
};

// Both functions see the same input (the S combinator).
// ::rep Apply Function#ap
// natives.Function :: Function [a] b ~> Function [a] (b -> c) -> Function [a] c
natives.Function = function (fns) {
  return input => fns (input) (this (input));
};

// The dispatcher takes the value first; the implementation is chosen at
// runtime, so hinmil cannot check it against the bodies above.
// apFn :: Apply f => f a -> f (a -> b) -> f b
// apFn :: Array a -> Array (a -> b) -> Array b
// apFn :: { [a] :: b } -> { [a] :: b -> c } -> { [a] :: c }
// apFn :: (a -> b) -> (a -> b -> c) -> (a -> c)
const apFn = findAlg ("ap") (natives) (false);

// ap :: Apply f => f (a -> b) -> f a -> f b
// ap :: Array (a -> b) -> Array a -> Array b
// ap :: { [a] :: b -> c } -> { [a] :: b } -> { [a] :: c }
// ap :: (a -> b -> c) -> (a -> b) -> (a -> c)
const ap = curry ((fns, values) => apFn (values) (fns));

module.exports = ap;
