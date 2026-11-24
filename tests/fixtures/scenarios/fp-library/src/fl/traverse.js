"use strict";

// Traversable builds on Functor; the Object functor is in map.js.
// ::types ./map

const curry = require ("../more/curry");
const findAlg = require ("../more/findAlg");
const lift2 = require ("./lift2");
const of = require ("./of");

let natives = {};

// A copy of `record` with `value` under `key`.
// withField :: k -> b -> Object k b -> Object k b
const withField = key => value => record => {
  const copy = Object.assign ({}, record);
  copy[key] = value;
  return copy;
};

// Runs the effects from left to right and collects the results.
// natives.Array :: Applicative f => Array a ~> TypeRep f -> (a -> f b) -> f (Array b)
natives.Array = function (F) {
  return f => this.reduce (
    (acc, x) => lift2 (done => next => done.concat ([next])) (acc) (f (x)),
    of (F) ([]));
};

// Per field, in key order; the record is rebuilt inside the applicative.
// natives.Object :: Applicative f => Object k a ~> TypeRep f -> (a -> f b) -> f (Object k b)
natives.Object = function (F) {
  return f => Object.keys (this).reduce (
    (acc, key) => lift2 (done => next => withField (key) (next) (done)) (acc) (f (this[key])),
    of (F) ({}));
};

// The dispatcher takes the value first (see ap.js).
// traverseFn :: (Traversable t, Applicative f) => t a -> TypeRep f -> (a -> f b) -> f (t b)
const traverseFn = findAlg ("traverse") (natives) (false);

// traverse :: (Traversable t, Applicative f)
//          => TypeRep f -> (a -> f b) -> t a -> f (t b)
const traverse = curry ((F, f, traversable) => traverseFn (traversable) (F) (f));

module.exports = traverse;
