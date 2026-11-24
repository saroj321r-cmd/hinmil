"use strict";

const chain = require ("../fl/chain");
const concat = require ("../fl/concat");
const equals = require ("../fl/equals");
const lte = require ("../fl/lte");
const map = require ("../fl/map");
const of = require ("../fl/of");
const show = require ("../more/show");
const Step = require ("../Step");
const isNext = require ("../Step/isNext");

const { Done, Next } = Step;

// An optional value: Just one, or Nothing.
// Maybe :: Nothing | Just a
function Maybe() {
  throw new TypeError ("Maybe is abstract: use Maybe.Just or Maybe.Nothing");
}

// Nothing :: () -> Maybe a
function Nothing() {}

// Just :: a -> Maybe a
function Just(value) {
  // Maybe#value :: a
  this.value = value;
}

// Nothing# :: Maybe
Nothing.prototype = Object.create (Maybe.prototype);

// Just# :: Maybe
Just.prototype = Object.create (Maybe.prototype);

// just :: a -> Maybe a
function just(value) {
  return new Just (value);
}

// Only the Nothing value carries it.
// Maybe#@@singleton :: Maybe a ~> String | Undefined
Nothing.prototype["@@singleton"] = "Nothing";

// just.name :: String
Object.defineProperty (just, "name", { value: "Just" });

// Maybe.Nothing :: Maybe a
Maybe.Nothing = new Nothing ();

// Maybe.Just :: a -> Maybe a
Maybe.Just = just;

// Maybe.empty :: () -> Maybe a
Maybe.empty = function () {
  return Maybe.Nothing;
};

// Maybe.zero :: () -> Maybe a
Maybe.zero = function () {
  return Maybe.Nothing;
};

// Maybe.of :: a -> Maybe a
Maybe.of = function (value) {
  return just (value);
};

// Steps until Done; a Nothing on the way ends the loop with Nothing.
// Maybe.chainRec :: (forall c. (a -> c) -> (b -> c) -> a -> Maybe c) -> a -> Maybe b
Maybe.chainRec = function (step) {
  return seed => {
    let state = Next (seed);
    while (isNext (state)) {
      const produced = step (Next) (Done) (state.value);
      if (produced.isNothing) return produced;
      state = produced.value;
    }
    return just (state.value);
  };
};

// Maybe#@@type :: String
Nothing.prototype["@@type"] = "Maybe";
Just.prototype["@@type"] = "Maybe";

// Maybe#@@tag :: String
Nothing.prototype["@@tag"] = "Nothing";
Just.prototype["@@tag"] = "Just";

// ::narrow Nothing
// Maybe#isNothing :: Boolean
Nothing.prototype.isNothing = true;
Just.prototype.isNothing = false;

// ::narrow Just
// Maybe#isJust :: Boolean
Nothing.prototype.isJust = false;
Just.prototype.isJust = true;

// Maybe#equals :: Setoid a => Maybe a ~> Maybe a -> Boolean
Nothing.prototype.equals = function (other) {
  return other.isNothing;
};

Just.prototype.equals = function (other) {
  return other.isJust && equals (other.value) (this.value);
};

// Nothing sorts first.
// Maybe#lte :: Maybe a ~> Maybe a -> Boolean
Nothing.prototype.lte = function (_other) {
  return true;
};

Just.prototype.lte = function (other) {
  return other.isJust && lte (other.value) (this.value);
};

// Nothing is the neutral element; two Justs join their values.
// Maybe#concat :: Semigroup a => Maybe a ~> Maybe a -> Maybe a
Nothing.prototype.concat = function (other) {
  return other;
};

Just.prototype.concat = function (other) {
  return other.isJust ? just (concat (other.value) (this.value)) : this;
};

// Maybe#filter :: Maybe a ~> (a -> Boolean) -> Maybe a
Nothing.prototype.filter = function (_keep) {
  return this;
};

Just.prototype.filter = function (keep) {
  return keep (this.value) ? this : Maybe.Nothing;
};

// Maybe#map :: Maybe a ~> (a -> b) -> Maybe b
Nothing.prototype.map = function (_f) {
  return this;
};

Just.prototype.map = function (f) {
  return just (f (this.value));
};

// Maybe#ap :: Maybe a ~> Maybe (a -> b) -> Maybe b
Nothing.prototype.ap = function (fns) {
  return chain (f => map (f) (this)) (fns);
};

Just.prototype.ap = function (fns) {
  return chain (f => map (f) (this)) (fns);
};

// The first Just.
// Maybe#alt :: Maybe a ~> Maybe a -> Maybe a
Nothing.prototype.alt = function (other) {
  return other;
};

Just.prototype.alt = function (_other) {
  return this;
};

// Maybe#reduce :: Maybe a ~> (b -> a -> b) -> b -> b
Nothing.prototype.reduce = function (_step) {
  return start => start;
};

Just.prototype.reduce = function (step) {
  return start => step (start) (this.value);
};

// Maybe#traverse :: Applicative f =>
//                   Maybe a ~> TypeRep f -> (a -> f b) -> f (Maybe b)
Nothing.prototype.traverse = function (F) {
  return _f => of (F) (this);
};

Just.prototype.traverse = function (_F) {
  return f => map (just) (f (this.value));
};

// Maybe#chain :: Maybe a ~> (a -> Maybe b) -> Maybe b
Nothing.prototype.chain = function (_f) {
  return this;
};

Just.prototype.chain = function (f) {
  return f (this.value);
};

// Maybe#extend :: Maybe a ~> (Maybe a -> b) -> Maybe b
Nothing.prototype.extend = function (_f) {
  return this;
};

Just.prototype.extend = function (f) {
  return just (f (this));
};

// Turns both cases into a Just: the fallback for Nothing, `f` for a value.
// Maybe#coalesce :: Maybe a ~> (() -> b) -> (a -> b) -> Maybe b
Nothing.prototype.coalesce = function (whenNothing) {
  return _whenJust => just (whenNothing ());
};

Just.prototype.coalesce = function (_whenNothing) {
  return whenJust => just (whenJust (this.value));
};

// Maybe#matchWith :: Maybe a ~> { Nothing :: () -> b, Just :: a -> b } -> b
Nothing.prototype.matchWith = function (cases) {
  return cases.Nothing ();
};

Just.prototype.matchWith = function (cases) {
  return cases.Just (this.value);
};

// The value, or the fallback for Nothing.
// Maybe#option :: Maybe a ~> a -> a
Nothing.prototype.option = function (fallback) {
  return fallback;
};

Just.prototype.option = function (_fallback) {
  return this.value;
};

// Maybe#show :: Maybe a ~> () -> String
Nothing.prototype.show = function () {
  return "Nothing";
};

Just.prototype.show = function () {
  return "Just (" + show (this.value) + ")";
};

module.exports = Maybe;
