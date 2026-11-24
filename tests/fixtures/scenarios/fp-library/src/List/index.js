"use strict";

const ap = require ("../fl/ap");
const chain = require ("../fl/chain");
const concat = require ("../fl/concat");
const equals = require ("../fl/equals");
const filter = require ("../fl/filter");
const map = require ("../fl/map");
const of = require ("../fl/of");
const reduce = require ("../fl/reduce");
const traverse = require ("../fl/traverse");
const show = require ("../more/show");

// A singly linked list: empty (Nil), or a head in front of a tail (Cons).
// List :: Nil | Cons a
function List() {
  throw new TypeError ("List is abstract: use List.Nil or List.Cons");
}

// Nil :: () -> List a
function Nil() {}

// Cons :: (a, List a) -> List a
function Cons(head, tail) {
  this.head = head;
  this.tail = tail;
}

// Nil# :: List
Nil.prototype = Object.create (List.prototype);

// Cons# :: List
Cons.prototype = Object.create (List.prototype);

// cons :: a -> List a -> List a
function cons(head) {
  return tail => new Cons (head, tail);
}

// Only the empty list carries it.
// List#@@singleton :: List a ~> String | Undefined
Nil.prototype["@@singleton"] = "Nil";

// cons.name :: String
Object.defineProperty (cons, "name", { value: "Cons" });

// List.Nil :: List a
List.Nil = new Nil ();

// List.Cons :: a -> List a -> List a
List.Cons = cons;

// List.empty :: () -> List a
List.empty = function () {
  return List.Nil;
};

// List.zero :: () -> List a
List.zero = function () {
  return List.Nil;
};

// List.of :: a -> List a
List.of = function (value) {
  return cons (value) (List.Nil);
};

// List#@@type :: List a ~> String
Nil.prototype["@@type"] = "List";
Cons.prototype["@@type"] = "List";

// List#@@tag :: List a ~> String
Nil.prototype["@@tag"] = "Nil";
Cons.prototype["@@tag"] = "Cons";

// List#isNil :: List a ~> Boolean
Nil.prototype.isNil = true;
Cons.prototype.isNil = false;

// List#isCons :: List a ~> Boolean
Nil.prototype.isCons = false;
Cons.prototype.isCons = true;

// List#equals :: Setoid a => List a ~> List a -> Boolean
Nil.prototype.equals = function (other) {
  return other.isNil;
};

Cons.prototype.equals = function (other) {
  return other.matchWith ({
    Cons: head => tail => equals (head) (this.head) && equals (tail) (this.tail),
    Nil: () => false
  });
};

// List#concat :: List a ~> List a -> List a
Nil.prototype.concat = function (other) {
  return other;
};

Cons.prototype.concat = function (other) {
  return cons (this.head) (concat (other) (this.tail));
};

// List#filter :: List a ~> (a -> Boolean) -> List a
Nil.prototype.filter = function (_keep) {
  return this;
};

Cons.prototype.filter = function (keep) {
  const rest = filter (keep) (this.tail);
  return keep (this.head) ? cons (this.head) (rest) : rest;
};

// List#map :: List a ~> (a -> b) -> List b
Nil.prototype.map = function (_f) {
  return this;
};

Cons.prototype.map = function (f) {
  return cons (f (this.head)) (map (f) (this.tail));
};

// List#ap :: List a ~> List (a -> b) -> List b
Nil.prototype.ap = function (fns) {
  return chain (f => map (f) (this)) (fns);
};

Cons.prototype.ap = function (fns) {
  return chain (f => map (f) (this)) (fns);
};

// Both lists, one after the other.
// List#alt :: List a ~> List a -> List a
Nil.prototype.alt = function (other) {
  return concat (other) (this);
};

Cons.prototype.alt = function (other) {
  return concat (other) (this);
};

// List#reduce :: List a ~> (b -> a -> b) -> b -> b
Nil.prototype.reduce = function (_step) {
  return start => start;
};

Cons.prototype.reduce = function (step) {
  return start => reduce (step) (step (start) (this.head)) (this.tail);
};

// List#traverse :: Applicative f
//                 => List a ~> TypeRep f -> (a -> f b) -> f (List b)
Nil.prototype.traverse = function (F) {
  return _f => of (F) (this);
};

Cons.prototype.traverse = function (F) {
  return f => ap (map (cons) (f (this.head))) (traverse (F) (f) (this.tail));
};

// List#chain :: List a ~> (a -> List b) -> List b
Nil.prototype.chain = function (_f) {
  return this;
};

Cons.prototype.chain = function (f) {
  return concat (chain (f) (this.tail)) (f (this.head));
};

// The cases receive the head and the tail curried.
// List#matchWith :: List a ~> { Nil :: () -> b, Cons :: a -> List a ->  b } -> b
Nil.prototype.matchWith = function (cases) {
  return cases.Nil ();
};

Cons.prototype.matchWith = function (cases) {
  return cases.Cons (this.head) (this.tail);
};

// List#show :: List a ~> () -> String
Nil.prototype.show = function () {
  return "Nil";
};

Cons.prototype.show = function () {
  return "Cons (" + show (this.head) + ") (" + show (this.tail) + ")";
};

module.exports = List;
