"use strict";

const curry = require ("../more/curry");
const chain = require ("../fl/chain");
const reduce = require ("../fl/reduce");
const Maybe = require ("../Maybe");
const isArray = require ("../predicate/isArray");
const isDefined = require ("../predicate/isDefined");

const { Nothing, Just } = Maybe;

// One step down a runtime path.  Which type the next level has depends on
// the value of the key, so the steps are `Any`; the typed contract is the
// list of `prop` overloads below.
// step :: Maybe Any -> String -> Maybe Any
const step = found => key => chain (prop (key)) (found);

// followPath :: [String] -> Object k a -> Maybe Any
const followPath = path => target => reduce (step) (Just (target)) (path);

// Tried in declaration order: a key, an index, then paths from the most
// specific (a tuple of keys) to the general one.
// prop :: k -> { [k] :: a, ...r } -> Maybe a
// prop :: Number -> [a] -> Maybe a
// prop :: [k1, k2, k3] -> { [k1] :: { [k2] :: { [k3] :: a, ...r3 }, ...r2 }, ...r1 } -> Maybe a
// prop :: [k1, k2] -> { [k1] :: { [k2] :: a, ...r2 }, ...r1 } -> Maybe a
// prop :: [k1,] -> { [k1] :: a, ...r } -> Maybe a
// prop :: [k1, k2, Number] -> { [k1] :: { [k2] :: [a], ...r2 }, ...r1 } -> Maybe a
// prop :: [k1, Number] -> { [k1] :: [a], ...r } -> Maybe a
const prop = curry ((where, target) => {
  if (isArray (where)) return followPath (where) (target);
  const found = target[where];
  return isDefined (found) ? Just (found) : Nothing;
});

const invoice = { number: "2026-0042", total: 1250, customer: { name: "Acme", vat: { country: "BE" } } };
const total = prop ("total") (invoice); // Maybe Number
const customerName = prop (["customer", "name"]) (invoice); // Maybe String
const country = prop (["customer", "vat", "country"]) (invoice); // Maybe String

module.exports = prop;
