"use strict";

const curry = require ("../more/curry");

// A record with a single field.
// objOf :: k -> a -> { [k] :: a }
const objOf = curry ((key, value) => {
  const single = {};
  single[key] = value;
  return single;
});

module.exports = objOf;
