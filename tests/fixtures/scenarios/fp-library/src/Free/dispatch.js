"use strict";

const curry = require ("../more/curry");
const is = require ("../predicate/is");

// An interpreter for `Free#go` (the natural transformation it expects),
// built from a list of [type representative, interpreter] pairs: the first
// pair whose type matches the instruction interprets it; anything else goes
// through `of`.  The type differs per pair, so it is existential (`Any`, as
// in Free); the choice itself is checked.
// dispatch :: (Functor m, Chainable u) => (a -> u a) -> [[Any, Any -> u Any]] -> m c -> u c
const dispatch = curry ((of, interpreters, instruction) => {
  const match = interpreters.find (entry => is (entry[0]) (instruction));
  const interpret = match ? match[1] : of;
  return interpret (instruction);
});

module.exports = dispatch;
