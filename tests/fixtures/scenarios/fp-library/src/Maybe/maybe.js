"use strict";

// ::types .

const curry = require ("../more/curry");

// Unwraps a Maybe: the fallback for Nothing, `f` of the value for a Just.
// maybe :: b -> (a -> b) -> Maybe a -> b
const maybe = curry ((fallback, f, m) =>
  m.matchWith ({
    Just: found => f (found),
    Nothing: () => fallback
  }));

module.exports = maybe;
