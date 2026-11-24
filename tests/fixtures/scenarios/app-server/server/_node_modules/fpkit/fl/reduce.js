"use strict";

const curry = require ("../more/curry");
const findAlg = require ("../more/findAlg");

let natives = {};

// ::rep Foldable Array#reduce
// natives.Array :: Array a ~> (b -> a -> b) -> b -> b
natives.Array = function (step) {
  return start => this.reduce ((acc, x) => step (acc) (x), start);
};

// Folds over the values of a record, in key order of insertion.
// ::rep Foldable Object#reduce
// natives.Object :: { [k] :: a } ~> (b -> a -> b) -> b -> b
natives.Object = function (step) {
  return start => Object.values (this).reduce ((acc, x) => step (acc) (x), start);
};

// The dispatcher takes the value first (see ap.js).
// reducer :: Foldable f => f a -> (b -> a -> b) -> b -> b
const reducer = findAlg ("reduce") (natives) (false);

// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b
const reduce = curry ((step, start, foldable) => reducer (foldable) (step) (start));

module.exports = reduce;
