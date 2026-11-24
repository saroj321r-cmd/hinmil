"use strict";

// ::types ../Tuple

const applyArgs = require ("../combinator/applyArgs");
const applyTo = require ("../combinator/applyTo");
const map = require ("../fl/map");
const size = require ("../lst/size");
const Tuple = require ("../Tuple");

// Feeds one input to several functions and returns their results as a
// tuple of the same length (2 to 5 functions in an array literal).
// fanout :: [x -> a, x -> b] -> x -> Tuple2 a b
// fanout :: [x -> a, x -> b, x -> c] -> x -> Tuple3 a b c
// fanout :: [x -> a, x -> b, x -> c, x -> d] -> x -> Tuple4 a b c d
// fanout :: [x -> a, x -> b, x -> c, x -> d, x -> e] -> x -> Tuple5 a b c d e
const fanout = fns => {
  const width = size (fns);
  if (width < 2) throw new TypeError ("fanout: give at least two functions");
  return input => applyArgs (Tuple (width)) (map (applyTo (input)) (fns));
};

module.exports = fanout;
