"use strict";

const curry = require ("../more/curry");
const concat = require ("../fl/concat");
const isArray = require ("../predicate/isArray");
const objOf = require ("./objOf");
const propOr = require ("./propOr");
const set = require ("./set");

// Applies `f` to one field, index or path; the shape follows `set`.
// over :: k -> (a -> b) -> { [k] :: a, ...r } -> { [k] :: b, ...r }
// over :: Number -> (a -> a) -> [a] -> [a]
// over :: [k1, k2, k3] -> (a -> b) -> { [k1] :: { [k2] :: { [k3] :: a, ...r3 }, ...r2 }, ...r1 } -> { [k1] :: { [k2] :: { [k3] :: b, ...r3 }, ...r2 }, ...r1 }
// over :: [k1, k2] -> (a -> b) -> { [k1] :: { [k2] :: a, ...r2 }, ...r1 } -> { [k1] :: { [k2] :: b, ...r2 }, ...r1 }
// over :: [k1,] -> (a -> b) -> { [k1] :: a, ...r } -> { [k1] :: b, ...r }
// over :: [k1, k2, Number] -> (a -> a) -> { [k1] :: { [k2] :: [a], ...r2 }, ...r1 } -> { [k1] :: { [k2] :: [a], ...r2 }, ...r1 }
// over :: [k1, Number] -> (a -> a) -> { [k1] :: [a], ...r } -> { [k1] :: [a], ...r }
// atIndex :: Number -> (a -> a) -> [a] -> [a]
const atIndex = position => f => items =>
  items.map ((item, i) => (i === position ? f (item) : item));

// atKey :: k -> (a -> b) -> { [k] :: a, ...r } -> { [k] :: b, ...r }
const atKey = key => f => target =>
  concat (objOf (key) (f (target[key]))) (target);

// The overloads above are the contract.  Whether `where` is a path, an index
// or a key is only known at runtime, so the dispatch itself is unchecked;
// every case is a typed helper.
// ::ignore-function
const over = curry ((where, f, target) => {
  if (isArray (where)) return set (where) (f (propOr (undefined) (where) (target))) (target);
  return isArray (target) ? atIndex (where) (f) (target) : atKey (where) (f) (target);
});

module.exports = over;
