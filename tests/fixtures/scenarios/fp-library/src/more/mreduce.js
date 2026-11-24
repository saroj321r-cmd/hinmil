"use strict";

const curry = require ("./curry");
const mconcat = require ("./mconcat");

// `mconcat`, then unwrapped.
// mreduce :: (Unwrappable m, Foldable f) => TypeRep m -> f a -> Any
const mreduce = curry ((Monoid, foldable) => mconcat (Monoid) (foldable).value);

module.exports = mreduce;
