"use strict";

const curry = require ("../more/curry");
const isDefined = require ("../predicate/isDefined");
const nil = require ("../predicate/nil");

// True when `target` has a defined value under `key`; in that branch the
// field is known to be there.
// ::narrow { [k] :: a, ...r }
// hasProp :: k -> { [k] :: a | Undefined, ...r } -> Boolean
const hasProp = curry ((key, target) =>
  !nil (target) && isDefined (target[key]));

module.exports = hasProp;
