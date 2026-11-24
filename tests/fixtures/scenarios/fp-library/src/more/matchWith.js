"use strict";

const curry = require ("./curry");

// Calls a value's own `matchWith` with a record of cases.
// matchWith :: p -> { matchWith :: p -> b, ...r } -> b
const matchWith = curry ((cases, subject) => subject.matchWith (cases));

module.exports = matchWith;
