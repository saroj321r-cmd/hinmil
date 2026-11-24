"use strict";

const curry = require ("../more/curry");

// Application with the argument first (the "thrush").
// applyTo :: a -> (a -> b) -> b
const applyTo = curry ((x, f) => f (x));

module.exports = applyTo;
