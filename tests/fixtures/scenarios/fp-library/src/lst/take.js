"use strict";

const curry = require ("../more/curry");
const compose = require ("../fl/compose");
const empty = require ("../fl/empty");
const gt = require ("../fl/gt");
const map = require ("../fl/map");
const reduce = require ("../fl/reduce");
const append = require ("./append");
const reject = require ("./reject");
const Maybe = require ("../Maybe");
const Pair = require ("../Pair");
const fst = require ("../Pair/fst");
const snd = require ("../Pair/snd");
const isArray = require ("../predicate/isArray");

const { Nothing, Just } = Maybe;

// keepWhile :: (Applicative f, Semigroup (f a)) => Number -> f a -> a -> f a
const keepWhile = left => kept => item => (left > 0 ? append (item) (kept) : kept);

// The pair counts down how many values may still be taken.
// takeStep :: (Applicative f, Semigroup (f a)) => Maybe (Pair Number (f a)) -> a -> Maybe (Pair Number (f a))
const takeStep = state => item =>
  map (counted => Pair (counted.fst - 1) (keepWhile (counted.fst) (counted.snd) (item))) (state);

// The first `count` values, or Nothing when there are fewer.
// take :: (Applicative f, Foldable f, Monoid (f a)) => Number -> f a -> Maybe (f a)
const take = curry ((count, foldable) => {
  if (count < 0) return Nothing;
  if (isArray (foldable)) return count > foldable.length ? Nothing : Just (foldable.slice (0, count));

  // One fold both takes the values and finds out whether there were enough
  // (a negative remainder): no separate pass to measure the size.
  // folded :: Foldable f => Maybe (Pair Number (f a))
  const folded = reduce (takeStep) (Just (Pair (count) (empty (foldable.constructor)))) (foldable);
  return map (snd) (reject (compose (gt (0)) (fst)) (folded));
});

module.exports = take;
