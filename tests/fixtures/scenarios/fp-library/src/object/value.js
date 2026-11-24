"use strict";

const curry = require ("../more/curry");

// The value of a field (no Maybe: the field must exist).
// value :: k -> { [k] :: a, ...r } -> a
const value = curry ((key, target) => target[key]);

module.exports = value;
