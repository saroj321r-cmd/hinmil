"use strict";

const curry = require ("./curry");
const empty = require ("../fl/empty");
const foldMap = require ("./foldMap");

// Wraps every value with the monoid's constructor and joins them, starting
// from its empty value.
// mconcat :: (Monoid m, Foldable f) => TypeRep m -> f a -> m
const mconcat = curry ((Monoid, foldable) =>
  foldMap (Monoid) (foldable) (empty (Monoid)));

module.exports = mconcat;
