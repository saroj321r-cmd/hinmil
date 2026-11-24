"use strict";

const curry = require ("../more/curry");
const findAlg = require ("../more/findAlg");

let natives = {};

// natives.Array :: Array a ~> (a -> b) -> Array b
natives.Array = function (f) {
  return this.map (x => f (x));
};

// ::rep Functor Object#map
// natives.Object :: Object k a ~> (a -> b) -> Object k b
natives.Object = function (f) {
  const mapped = {};
  Object.keys (this).forEach (key => {
    mapped[key] = f (this[key]);
  });
  return mapped;
};

// Mapping over a function is composing after it.
// ::rep Functor Function#map
// natives.Function :: Function [x] a ~> (a -> b) -> Function [x] b
natives.Function = function (f) {
  return input => f (this (input));
};

// The dispatcher takes the value first (see ap.js).
// mapFn :: Functor f => f a -> (a -> b) -> f b
// mapFn :: { [k] :: a } -> (a -> b) -> { [k] :: b }
const mapFn = findAlg ("map") (natives) (false);

// map :: Functor f => (a -> b) -> f a -> f b
// map :: (a -> b) ->  { [k] :: a } ->  { [k] :: b }
const map = curry ((f, functor) => mapFn (functor) (f));

module.exports = map;
