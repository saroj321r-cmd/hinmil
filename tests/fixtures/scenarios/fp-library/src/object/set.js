"use strict";

const curry = require ("../more/curry");
const concat = require ("../fl/concat");
const isArray = require ("../predicate/isArray");
const isInteger = require ("../predicate/isInteger");
const isObject = require ("../predicate/isObject");
const objOf = require ("./objOf");

// canHold :: a -> Boolean
const canHold = x => isArray (x) || isObject (x);

// replaceAt :: Number -> a -> [a] -> [a]
const replaceAt = position => value => items =>
  items.map ((item, i) => (i === position ? value : item));

// withKey :: k -> a -> { ...r } -> { [k] :: a, ...r }
const withKey = key => value => target =>
  concat (objOf (key) (value)) (target);

// Rebuilds a runtime path, creating an array or a record where a level is
// missing (an array when the next key is an index).  The levels are `Any`
// for the same reason as in `prop`; the overloads below are the contract.
// setIn :: [String | Number] -> a -> Any -> Any
const setIn = path => value => target => {
  const [head, ...rest] = path;
  if (rest.length === 0) return set (head) (value) (target);
  const level = canHold (target[head]) ? target[head] : isInteger (rest[0]) ? [] : {};
  return set (head) (setIn (rest) (value) (level)) (target);
};

// Tried in declaration order: an existing key, a new key, an index, then
// paths (tuples of keys, possibly ending in an index).
// set :: k -> a -> { [k] :: b, ...r } -> { [k] :: a, ...r }
// set :: k -> a -> { ...r } -> { [k] :: a, ...r }
// set :: Number -> a -> [a] -> [a]
// set :: [k1, k2, k3] -> a -> { [k1] :: { [k2] :: { [k3] :: b, ...r3 }, ...r2 }, ...r1 } -> { [k1] :: { [k2] :: { [k3] :: a, ...r3 }, ...r2 }, ...r1 }
// set :: [k1, k2] -> a -> { [k1] :: { [k2] :: b, ...r2 }, ...r1 } -> { [k1] :: { [k2] :: a, ...r2 }, ...r1 }
// set :: [k1,] -> a -> { [k1] :: b, ...r } -> { [k1] :: a, ...r }
// set :: [k1, k2, Number] -> a -> { [k1] :: { [k2] :: [a], ...r2 }, ...r1 } -> { [k1] :: { [k2] :: [a], ...r2 }, ...r1 }
// set :: [k1, Number] -> a -> { [k1] :: [a], ...r } -> { [k1] :: [a], ...r }
// The dispatch looks at runtime shapes (path, index or key) that one HM body
// cannot follow, so only it is unchecked; each case is a typed helper.
// ::ignore-function
const set = curry ((where, value, target) => {
  if (isArray (where)) return setIn (where) (value) (target);
  return isArray (target) ? replaceAt (where) (value) (target) : withKey (where) (value) (target);
});

module.exports = set;
