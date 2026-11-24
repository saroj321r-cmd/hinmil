"use strict";

const chain = require ("../fl/chain");
const concat = require ("../fl/concat");
const equals = require ("../fl/equals");
const lte = require ("../fl/lte");
const map = require ("../fl/map");
const show = require ("../more/show");

// Two values side by side.  As a functor it works on the second one; the
// first one is context (and must be a Semigroup for `ap` and `chain`).
// Pair :: (a, b) -> Pair a b
function Pair(first, second) {
  // Pair#fst :: a
  this.fst = first;
  // Pair#snd :: b
  this.snd = second;
}

// pair :: a -> b -> Pair a b
function pair(first) {
  return second => new Pair (first, second);
}

// pair.name :: String
Object.defineProperty (pair, "name", { value: "Pair" });

// Pair#@@type :: String
Pair.prototype["@@type"] = "Pair";

// Pair#equals :: (Setoid a, Setoid b) => Pair a b ~> Pair a b -> Boolean
Pair.prototype.equals = function (other) {
  return equals (other.fst) (this.fst) && equals (other.snd) (this.snd);
};

// By the first part, then by the second.
// Pair#lte :: (Ord a, Ord b) => Pair a b ~> Pair a b -> Boolean
Pair.prototype.lte = function (other) {
  if (!equals (other.fst) (this.fst)) return lte (other.fst) (this.fst);
  return lte (other.snd) (this.snd);
};

// Pair#compose :: Pair a b ~> Pair b c -> Pair a c
Pair.prototype.compose = function (other) {
  return pair (this.fst) (other.snd);
};

// Pair#concat :: (Semigroup a, Semigroup b) => Pair a b ~> Pair a b -> Pair a b
Pair.prototype.concat = function (other) {
  return pair (concat (other.fst) (this.fst)) (concat (other.snd) (this.snd));
};

// Pair#map :: Pair a b ~> (b -> c) -> Pair a c
Pair.prototype.map = function (f) {
  return pair (this.fst) (f (this.snd));
};

// Pair#ap :: Semigroup s => Pair a b ~> Pair a (b -> c) -> Pair a c
Pair.prototype.ap = function (other) {
  return chain (f => map (f) (this)) (other);
};

// Pair#reduce :: Pair a b ~> (c -> b -> c) -> c -> c
Pair.prototype.reduce = function (f) {
  return start => f (start) (this.snd);
};

// Pair#traverse :: Applicative f => Pair a b ~> TypeRep f -> (b -> f c) -> f (Pair a c)
Pair.prototype.traverse = function (_F) {
  return f => map (second => pair (this.fst) (second)) (f (this.snd));
};

// Pair#chain :: Semigroup a => Pair a b ~> (b -> Pair a c) -> Pair a c
Pair.prototype.chain = function (f) {
  const result = f (this.snd);
  return pair (concat (result.fst) (this.fst)) (result.snd);
};

// Pair#extend :: Pair a b ~> (Pair a b -> c) -> Pair a c
Pair.prototype.extend = function (f) {
  return pair (this.fst) (f (this));
};

// Pair#extract :: Pair a b ~> () -> b
Pair.prototype.extract = function () {
  return this.snd;
};

// Pair#bimap :: Pair a b ~> (a -> c) -> (b -> d) -> Pair c d
Pair.prototype.bimap = function (onFirst) {
  return onSecond => pair (onFirst (this.fst)) (onSecond (this.snd));
};

// Pair#merge :: Pair a b ~> (a -> b -> c) -> c
Pair.prototype.merge = function (f) {
  return f (this.fst) (this.snd);
};

// Pair#swap :: Pair a b ~> () -> Pair b a
Pair.prototype.swap = function () {
  return pair (this.snd) (this.fst);
};

// Pair#show :: Pair a b ~> () -> String
Pair.prototype.show = function () {
  return "Pair (" + show (this.fst) + ") (" + show (this.snd) + ")";
};

module.exports = pair;
