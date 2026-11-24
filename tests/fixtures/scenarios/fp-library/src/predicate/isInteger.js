"use strict";

// The largest whole number a double holds exactly: 2^53 - 1.
const LARGEST_EXACT = 9007199254740991;

// A whole Number within the exactly representable range.
// ::narrow Number
// isInteger :: a -> Boolean
const isInteger = candidate =>
  typeof candidate === "number"
  && candidate % 1 === 0
  && Math.abs (candidate) <= LARGEST_EXACT;

module.exports = isInteger;
