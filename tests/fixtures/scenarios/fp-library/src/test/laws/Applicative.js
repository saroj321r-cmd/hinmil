"use strict";

const ap = require ("../../fl/ap");
const equals = require ("../../fl/equals");
const of = require ("../../fl/of");

// The Applicative laws of the Fantasy Land specification, as predicates.

// Applying the wrapped identity changes nothing.
// identity :: (Applicative f, Setoid (f a)) => TypeRep f -> f a -> Boolean
const identity = F => v => equals (v) (ap (of (F) (x => x)) (v));

// Wrapping commutes with application.
// homomorphism :: (Applicative f, Setoid (f b)) => TypeRep f -> (a -> b) -> a -> Boolean
const homomorphism = F => f => x =>
  equals (of (F) (f (x))) (ap (of (F) (f)) (of (F) (x)));

// The order of a wrapped function and a wrapped value can be swapped.
// interchange :: (Applicative f, Setoid (f b)) => TypeRep f -> f (a -> b) -> a -> Boolean
const interchange = F => u => y =>
  equals (ap (of (F) (f => f (y))) (u)) (ap (u) (of (F) (y)));

const applicativeLaws = F => ({
  identity: identity (F),
  homomorphism: homomorphism (F),
  interchange: interchange (F)
});

module.exports = applicativeLaws;
