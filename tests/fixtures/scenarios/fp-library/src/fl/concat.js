"use strict";

const curry = require ("../more/curry");
const findAlg = require ("../more/findAlg");

let natives = {};

// Records join field-wise; the right-hand record wins on a shared key.
// ::rep Semigroup Object#concat
// natives.Object :: { ...a } ~> { ...b } -> { ...a, ...b }
natives.Object = function (other) {
  return Object.assign ({}, this, other);
};

// The dispatcher takes the value first (see ap.js).
// concatFn :: Semigroup a => a -> a -> a
// concatFn :: { ...a } -> { ...b } -> { ...a, ...b }
const concatFn = findAlg ("concat") (natives) (false);

// `concat (x) (y)` puts y first: it is `y.concat (x)`.
// concat :: Semigroup a => a -> a -> a
// concat :: { ...b } -> { ...a } -> { ...a, ...b }
const concat = curry ((after, before) => concatFn (before) (after));

module.exports = concat;
