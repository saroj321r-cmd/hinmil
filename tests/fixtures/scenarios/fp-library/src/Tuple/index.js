"use strict";

const concat = require ("../fl/concat");
const equals = require ("../fl/equals");
const reduce = require ("../fl/reduce");
const show = require ("../more/show");

// Fixed-size tuples with one to five parts of their own types.  Every size
// is a type of its own (`Tuple1 a` … `Tuple5 a b c d e`) with its own
// constructor; `Tuple` is the shared base that carries the methods.  The
// curried factories are named after their type ("Tuple1" … "Tuple5").
// `Tuple` itself only throws, so its result type is free.
// Tuple :: () -> a
function Tuple() {
  throw new TypeError ("Tuple is abstract: use Tuple (n)");
}

// Tuple1 :: a -> Tuple1 a
function Tuple1(a) {
  // Tuple1#n :: Tuple1 a ~> Number
  this.n = 1;
  // Tuple1#parts :: Tuple1 a ~> [a,]
  this.parts = [a];
}

Tuple1.prototype = Object.create (Tuple.prototype);

// Tuple1#@@type :: Tuple1 a ~> String
Tuple1.prototype["@@type"] = "Tuple1";

// Tuple2 :: (a, b) -> Tuple2 a b
function Tuple2(a, b) {
  // Tuple2#n :: Tuple2 a b ~> Number
  this.n = 2;
  // Tuple2#parts :: Tuple2 a b ~> [a, b]
  this.parts = [a, b];
}

Tuple2.prototype = Object.create (Tuple.prototype);

// Tuple2#@@type :: Tuple2 a b ~> String
Tuple2.prototype["@@type"] = "Tuple2";

// Tuple3 :: (a, b, c) -> Tuple3 a b c
function Tuple3(a, b, c) {
  // Tuple3#n :: Tuple3 a b c ~> Number
  this.n = 3;
  // Tuple3#parts :: Tuple3 a b c ~> [a, b, c]
  this.parts = [a, b, c];
}

Tuple3.prototype = Object.create (Tuple.prototype);

// Tuple3#@@type :: Tuple3 a b c ~> String
Tuple3.prototype["@@type"] = "Tuple3";

// Tuple4 :: (a, b, c, d) -> Tuple4 a b c d
function Tuple4(a, b, c, d) {
  // Tuple4#n :: Tuple4 a b c d ~> Number
  this.n = 4;
  // Tuple4#parts :: Tuple4 a b c d ~> [a, b, c, d]
  this.parts = [a, b, c, d];
}

Tuple4.prototype = Object.create (Tuple.prototype);

// Tuple4#@@type :: Tuple4 a b c d ~> String
Tuple4.prototype["@@type"] = "Tuple4";

// Tuple5 :: (a, b, c, d, e) -> Tuple5 a b c d e
function Tuple5(a, b, c, d, e) {
  // Tuple5#n :: Tuple5 a b c d e ~> Number
  this.n = 5;
  // Tuple5#parts :: Tuple5 a b c d e ~> [a, b, c, d, e]
  this.parts = [a, b, c, d, e];
}

Tuple5.prototype = Object.create (Tuple.prototype);

// Tuple5#@@type :: Tuple5 a b c d e ~> String
Tuple5.prototype["@@type"] = "Tuple5";

// tuple1 :: a -> Tuple1 a
function tuple1(a) {
  return new Tuple1 (a);
}

// tuple2 :: a -> b -> Tuple2 a b
function tuple2(a) {
  return b => new Tuple2 (a, b);
}

// tuple3 :: a -> b -> c -> Tuple3 a b c
function tuple3(a) {
  return b => c => new Tuple3 (a, b, c);
}

// tuple4 :: a -> b -> c -> d -> Tuple4 a b c d
function tuple4(a) {
  return b => c => d => new Tuple4 (a, b, c, d);
}

// tuple5 :: a -> b -> c -> d -> e -> Tuple5 a b c d e
function tuple5(a) {
  return b => c => d => e => new Tuple5 (a, b, c, d, e);
}

// tuple1.name :: String
Object.defineProperty (tuple1, "name", { value: "Tuple1" });
// tuple2.name :: String
Object.defineProperty (tuple2, "name", { value: "Tuple2" });
// tuple3.name :: String
Object.defineProperty (tuple3, "name", { value: "Tuple3" });
// tuple4.name :: String
Object.defineProperty (tuple4, "name", { value: "Tuple4" });
// tuple5.name :: String
Object.defineProperty (tuple5, "name", { value: "Tuple5" });

// Feeds the parts one by one to a curried function whose arity is only
// known at runtime (`applyArgs` does this for a fixed length).
// feedParts :: Any -> [Any] -> Any
const feedParts = f => parts => {
  let applied = f;
  for (const part of parts) applied = applied (part);
  return applied;
};

const factories = [tuple1, tuple2, tuple3, tuple4, tuple5];

// The size is a VALUE: a literal size picks the typed factory (numeric
// literal types); a size only known as a Number gets the untyped fallback.
// makeTuple :: 1 -> a -> Tuple1 a
// makeTuple :: 2 -> a -> b -> Tuple2 a b
// makeTuple :: 3 -> a -> b -> c -> Tuple3 a b c
// makeTuple :: 4 -> a -> b -> c -> d -> Tuple4 a b c d
// makeTuple :: 5 -> a -> b -> c -> d -> e -> Tuple5 a b c d e
// makeTuple :: Number -> Any
function makeTuple(size) {
  const factory = factories[size - 1];
  if (!factory) throw new RangeError ("Tuple: a size from 1 to 5, got " + size);
  return factory;
}

Object.defineProperty (makeTuple, "name", { value: "Tuple" });

// Tuple1#equals :: Setoid a => Tuple1 a ~> Tuple1 a -> Boolean
// Tuple2#equals :: Setoid a => Tuple2 a a ~> Tuple2 a a -> Boolean
// Tuple3#equals :: Setoid a => Tuple3 a a a ~> Tuple3 a a a -> Boolean
// Tuple4#equals :: Setoid a => Tuple4 a a a a ~> Tuple4 a a a a -> Boolean
// Tuple5#equals :: Setoid a => Tuple5 a a a a a ~> Tuple5 a a a a a -> Boolean
Tuple.prototype.equals = function (other) {
  return this.n === other.n && this.parts.every ((part, i) => equals (other.parts[i]) (part));
};

// Part by part.
// Tuple1#concat :: Semigroup a => Tuple1 a ~> Tuple1 a -> Tuple1 a
// Tuple2#concat :: Semigroup a => Tuple2 a a ~> Tuple2 a a -> Tuple2 a a
// Tuple3#concat :: Semigroup a => Tuple3 a a a ~> Tuple3 a a a -> Tuple3 a a a
// Tuple4#concat :: Semigroup a => Tuple4 a a a a ~> Tuple4 a a a a -> Tuple4 a a a a
// Tuple5#concat :: Semigroup a => Tuple5 a a a a a ~> Tuple5 a a a a a -> Tuple5 a a a a a
Tuple.prototype.concat = function (other) {
  const joined = this.parts.map ((part, i) => concat (other.parts[i]) (part));
  return feedParts (makeTuple (this.n)) (joined);
};

// Tuple1#map :: Tuple1 a ~> (a -> b) -> Tuple1 b
// Tuple2#map :: Tuple2 a a ~> (a -> b) -> Tuple2 b b
// Tuple3#map :: Tuple3 a a a ~> (a -> b) -> Tuple3 b b b
// Tuple4#map :: Tuple4 a a a a ~> (a -> b) -> Tuple4 b b b b
// Tuple5#map :: Tuple5 a a a a a ~> (a -> b) -> Tuple5 b b b b b
Tuple.prototype.map = function (f) {
  return feedParts (makeTuple (this.n)) (this.parts.map (part => f (part)));
};

// Tuple1#merge :: Tuple1 a ~> (a -> z) -> z
// Tuple2#merge :: Tuple2 a b ~> (a -> b -> z) -> z
// Tuple3#merge :: Tuple3 a b c ~> (a -> b -> c -> z) -> z
// Tuple4#merge :: Tuple4 a b c d ~> (a -> b -> c -> d -> z) -> z
// Tuple5#merge :: Tuple5 a b c d e ~> (a -> b -> c -> d -> e -> z) -> z
Tuple.prototype.merge = function (f) {
  return feedParts (f) (this.parts);
};

// Tuple1#show :: Tuple1 a ~> () -> String
// Tuple2#show :: Tuple2 a b ~> () -> String
// Tuple3#show :: Tuple3 a b c ~> () -> String
// Tuple4#show :: Tuple4 a b c d ~> () -> String
// Tuple5#show :: Tuple5 a b c d e ~> () -> String
Tuple.prototype.show = function () {
  return reduce (text => part => text + " (" + show (part) + ")") (this["@@type"]) (this.parts);
};

module.exports = makeTuple;
