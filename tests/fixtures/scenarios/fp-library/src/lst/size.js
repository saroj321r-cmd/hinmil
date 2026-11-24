"use strict";

const reduce = require ("../fl/reduce");
const hasProp = require ("../object/hasProp");

// The number of values: `length` when there is one, else a count by folding.
// size :: Foldable f => f a -> Number
// size :: String -> Number
const size = foldable => {
  if (hasProp ("length") (foldable)) return foldable.length;
  return reduce (count => _item => count + 1) (0) (foldable);
};

module.exports = size;
