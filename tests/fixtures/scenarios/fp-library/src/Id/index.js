"use strict";

const chain = require ("../fl/chain");
const concat = require ("../fl/concat");
const equals = require ("../fl/equals");
const lte = require ("../fl/lte");
const map = require ("../fl/map");
const show = require ("../more/show");
const Step = require ("../Step");
const isNext = require ("../Step/isNext");

const { Done, Next } = Step;

// The identity container: a value in a box, nothing more.  Useful as the
// base monad of a transformer and in law tests.
// Id :: a -> Id a
function Id(value) {
  this.value = value;
}

// id :: a -> Id a
function id(value) {
  return new Id (value);
}

// id.of :: a -> Id a
id.of = Id.of = function (value) {
  return new Id (value);
};

// id.chainRec :: (forall c. (a -> c) -> (b -> c) -> a -> Id c) -> a -> Id b
id.chainRec = Id.chainRec = function (step) {
  return seed => {
    let state = Next (seed);
    while (isNext (state)) state = step (Next) (Done) (state.value).value;
    return id (state.value);
  };
};

// id.name :: String
Object.defineProperty (id, "name", { value: "Id" });

// Id#@@type :: String
Id.prototype["@@type"] = "Id";

// Id#equals :: Setoid a => Id a ~> Id a -> Boolean
Id.prototype.equals = function (other) {
  return equals (other.value) (this.value);
};

// Id#lte :: Ord a => Id a ~> Id a -> Boolean
Id.prototype.lte = function (other) {
  return lte (other.value) (this.value);
};

// Id#concat :: Semigroup a => Id a ~> Id a -> Id a
Id.prototype.concat = function (other) {
  return id (concat (other.value) (this.value));
};

// Id#map :: Id a ~> (a -> b) -> Id b
Id.prototype.map = function (f) {
  return id (f (this.value));
};

// Id#ap :: Id a ~> Id (a -> b) -> Id b
Id.prototype.ap = function (fns) {
  return chain (f => map (f) (this)) (fns);
};

// Id#reduce :: Id a ~> (b -> a -> b) -> b -> b
Id.prototype.reduce = function (step) {
  return start => step (start) (this.value);
};

// Id#traverse :: Applicative f => Id a ~> TypeRep f -> (a -> f b) -> f (Id b)
Id.prototype.traverse = function (_F) {
  return f => map (id) (f (this.value));
};

// Id#chain :: Id a ~> (a -> Id b) -> Id b
Id.prototype.chain = function (f) {
  return f (this.value);
};

// Id#extend :: Id a ~> (Id a -> b) -> Id b
Id.prototype.extend = function (f) {
  return id (f (this));
};

// Id#extract :: Id a ~> () -> a
Id.prototype.extract = function () {
  return this.value;
};

// Id#show :: Id a ~> () -> String
Id.prototype.show = function () {
  return "Id (" + show (this.value) + ")";
};

module.exports = id;
