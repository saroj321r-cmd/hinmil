"use strict";

const curry = require ("../more/curry");

// Maps the left (failure) side of a value that has one.
// mapLeft :: (a -> c) -> { mapLeft :: (a -> c) -> r, ...s } -> r
const mapLeft = curry ((f, sided) => sided.mapLeft (f));

module.exports = mapLeft;
