"use strict";

const curry = require ("../more/curry");
const filter = require ("../fl/filter");

// The opposite of `filter`: keeps what fails the test.
// reject :: Filterable f => (a -> Boolean) -> f a -> f a
const reject = curry ((test, filterable) =>
  filter (item => !test (item)) (filterable));

module.exports = reject;
