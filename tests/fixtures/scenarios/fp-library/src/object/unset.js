"use strict";

const curry = require ("../more/curry");
const isArray = require ("../predicate/isArray");
const isInteger = require ("../predicate/isInteger");
const isObject = require ("../predicate/isObject");
const isString = require ("../predicate/isString");
const set = require ("./set");

// withoutIndex :: Number -> [a] -> [a]
const withoutIndex = position => items =>
  items.filter ((_item, i) => i !== position);

// withoutKey :: k -> Object k a -> Object k a
const withoutKey = key => target => {
  const rest = {};
  Object.keys (target).forEach (k => {
    if (k !== key && target[k] !== undefined) rest[k] = target[k];
  });
  return rest;
};

// isContainer :: a -> Boolean
const isContainer = x => isObject (x) || isArray (x);

// Removes the last key of a runtime path; a path that does not lead
// anywhere leaves the value unchanged.  Levels are `Any` (see `prop`).
// unsetIn :: [String | Number] -> Any -> Any
const unsetIn = path => target => {
  if (!isContainer (target)) return target;
  const [head, ...rest] = path;
  if (rest.length === 0) {
    if (isArray (target) && isInteger (head)) return withoutIndex (head) (target);
    if (isObject (target) && isString (head)) return withoutKey (head) (target);
    return target;
  }
  return isContainer (target[head]) ? set (head) (unsetIn (rest) (target[head])) (target) : target;
};

// unset :: k -> { [k] :: a, ...r } -> { ...r }
// unset :: [k1, k2] -> { [k1] :: { [k2] :: a, ...r2 }, ...r1 } -> { [k1] :: { ...r2 }, ...r1 }
// unset :: [k1,] -> { [k1] :: a, ...r } -> { ...r }
// unset :: [k1, Number, Number] -> { [k1] :: [[a] | b], ...r } -> { [k1] :: [[a] | b], ...r }
// unset :: [k1, Number] -> { [k1] :: [a], ...r } -> { [k1] :: [a], ...r }
// unset :: [Number, Number] -> [[a] | b] -> [[a] | b]
const unset = curry ((where, target) =>
  (isArray (where) ? unsetIn (where) (target) : withoutKey (where) (target)));

module.exports = unset;
