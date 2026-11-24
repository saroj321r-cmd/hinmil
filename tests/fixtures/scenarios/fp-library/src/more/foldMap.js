"use strict";

const curry = require ("./curry");
const concat = require ("../fl/concat");
const reduce = require ("../fl/reduce");

// Maps every value into a semigroup and joins the results, starting from
// `start`.
// foldMap :: (Foldable f, Semigroup m) => (a -> m) -> f a -> m -> m
const foldMap = curry ((toM, foldable, start) => {
  // joinNext :: Semigroup m => m -> a -> m
  const joinNext = joined => item => concat (toM (item)) (joined);
  return reduce (joinNext) (start) (foldable);
});

module.exports = foldMap;
