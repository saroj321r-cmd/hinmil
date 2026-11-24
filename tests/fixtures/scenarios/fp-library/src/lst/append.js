"use strict";

const curry = require ("../more/curry");
const concat = require ("../fl/concat");
const of = require ("../fl/of");

// Adds one value at the end, for any container that can wrap a single value
// (`of`) and join two containers (`concat`).
// append :: (Applicative f, Semigroup (f a)) => a -> f a -> f a
const append = curry ((item, container) =>
  concat (of (container.constructor) (item)) (container));

module.exports = append;
