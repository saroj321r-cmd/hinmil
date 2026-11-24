"use strict";

const curry = require ("../more/curry");
const getName = require ("../more/getName");
const getType = require ("../more/getType");
const tag = require ("../more/tag");

// Is `candidate` a value of `rep`?  `rep` is a type representative, or a
// singleton such as `Nothing`, which is matched by its `@@singleton` name.
// is :: TypeRep f -> a -> Boolean
// is :: { @@singleton :: String | Undefined, ...r } -> a -> Boolean
const is = curry ((rep, candidate) => {
  const wanted = getName (rep);
  return getType (candidate) === wanted || tag (candidate) === wanted;
});

module.exports = is;
