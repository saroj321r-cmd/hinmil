"use strict";

const curry = require ("../more/curry");
const findAlg = require ("../more/findAlg");

let natives = {};

// ::rep Filterable Array#filter
// natives.Array :: Array a ~> (a -> Boolean) -> Array a
natives.Array = function (keep) {
  return this.filter (x => keep (x));
};

// Keeps the fields whose value passes.
// ::rep Filterable Object#filter
// natives.Object :: Object k a ~> (a -> Boolean) -> Object k a
natives.Object = function (keep) {
  const kept = {};
  for (const key of Object.keys (this)) {
    if (keep (this[key])) kept[key] = this[key];
  }
  return kept;
};

// The dispatcher takes the value first (see ap.js).
// filterFn :: Filterable f => f a -> (a -> Boolean) -> f a
const filterFn = findAlg ("filter") (natives) (false);

// filter :: Filterable f => (a -> Boolean) -> f a -> f a
const filter = curry ((keep, filterable) => filterFn (filterable) (keep));

module.exports = filter;
