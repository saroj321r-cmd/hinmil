"use strict";

const curry = require ("../more/curry");
const empty = require ("../fl/empty");
const reduce = require ("../fl/reduce");
const append = require ("./append");
const Pair = require ("../Pair");
const snd = require ("../Pair/snd");
const isArray = require ("../predicate/isArray");

// keepUnless :: (Applicative f, Semigroup (f a)) => Boolean -> f a -> a -> f a
const keepUnless = skip => kept => item => (skip ? kept : append (item) (kept));

// Drops the leading values that satisfy `test`.
// dropWhile :: (Applicative f, Foldable f, Monoid (f a)) => (a -> Boolean) -> f a -> f a
const dropWhile = curry ((test, foldable) => {
  if (isArray (foldable)) {
    const first = foldable.findIndex (item => !test (item));
    return first < 0 ? [] : foldable.slice (first);
  }

  // The pair holds "still dropping?" and what was kept so far.
  // walk :: (Applicative f, Semigroup (f a)) => Pair Boolean (f a) -> a -> Pair Boolean (f a)
  const walk = state => item => {
    const skip = state.fst && test (item);
    return Pair (skip) (keepUnless (skip) (state.snd) (item));
  };

  return snd (reduce (walk) (Pair (true) (empty (foldable.constructor))) (foldable));
});

module.exports = dropWhile;
