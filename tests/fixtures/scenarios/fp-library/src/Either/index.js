"use strict";

const identity = require ("../combinator/identity");
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

// A value or a reason why there is none: Right holds the value, Left the
// reason.  Everything after a Left is skipped.
// Either :: Left e | Right a
function Either() {
  throw new TypeError ("Either is abstract: use Either.Left or Either.Right");
}

// Left :: e -> Either e a
function Left(value) {
  // Either#value :: Either e a ~> e | a
  this.value = value;
}

// Right :: a -> Either e a
function Right(value) {
  this.value = value;
}

Left.prototype = Object.create (Either.prototype);
Right.prototype = Object.create (Either.prototype);

// left :: e -> Either e a
function left(reason) {
  return new Left (reason);
}

// right :: a -> Either e a
function right(value) {
  return new Right (value);
}

// left.name :: String
Object.defineProperty (left, "name", { value: "Left" });

// right.name :: String
Object.defineProperty (right, "name", { value: "Right" });

// Either.Left :: e -> Either e a
Either.Left = left;

// Either.Right :: a -> Either e a
Either.Right = right;

// Either.of :: a -> Either e a
Either.of = function (value) {
  return right (value);
};

// Steps until Done; a Left on the way ends the loop with that Left.
// Either.chainRec :: (forall c. (a -> c) -> (b -> c) -> a -> Either e c) -> a -> Either e b
Either.chainRec = function (step) {
  return seed => {
    let state = Next (seed);
    while (isNext (state)) {
      const produced = step (Next) (Done) (state.value);
      if (produced.isLeft) return produced;
      state = produced.value;
    }
    return right (state.value);
  };
};

// Either#@@type :: Either a b ~> String
Left.prototype["@@type"] = "Either";
Right.prototype["@@type"] = "Either";

// Either#@@tag :: Either a b ~> String
Left.prototype["@@tag"] = "Left";
Right.prototype["@@tag"] = "Right";

// ::narrow Left
// Either#isLeft :: Either a b ~> Boolean
Left.prototype.isLeft = true;
Right.prototype.isLeft = false;

// Either#isRight :: Either a b ~> Boolean
Left.prototype.isRight = false;
Right.prototype.isRight = true;

/* Either#equals  :: (Setoid e, Setoid a)
                  => Either e a ~> Either e a -> Boolean */
Left.prototype.equals = function (other) {
  return other.matchWith ({ Left: reason => equals (reason) (this.value), Right: _value => false });
};

Right.prototype.equals = function (other) {
  return other.matchWith ({ Left: _reason => false, Right: value => equals (value) (this.value) });
};

// Every Left sorts before every Right.
/* Either#lte :: (Ord e, Ord a)
              => Either e a ~> Either e a -> Boolean */
Left.prototype.lte = function (other) {
  return other.matchWith ({ Left: reason => lte (reason) (this.value), Right: _value => true });
};

Right.prototype.lte = function (other) {
  return other.matchWith ({ Left: _reason => false, Right: value => lte (value) (this.value) });
};

// The first Left wins; two Rights join their values.
/* Either#concat  :: (Semigroup e, Semigroup a)
                  => Either e a ~> Either e a -> Either e a */
Left.prototype.concat = function (_other) {
  return this;
};

Right.prototype.concat = function (other) {
  return other.isLeft ? other : right (concat (other.value) (this.value));
};

// Either#map :: Either e a ~> (a -> b) -> Either e b
Left.prototype.map = function (_f) {
  return this;
};

Right.prototype.map = function (f) {
  return right (f (this.value));
};

// Either#ap :: Either e a ~> Either e (a -> b) -> Either e b
Left.prototype.ap = function (fns) {
  return chain (f => map (f) (this)) (fns);
};

Right.prototype.ap = function (fns) {
  return chain (f => map (f) (this)) (fns);
};

// The first Right.
// Either#alt :: Either e a ~> Either e a -> Either e a
Left.prototype.alt = function (other) {
  return other;
};

Right.prototype.alt = function (_other) {
  return this;
};

// Either#reduce :: Either e a ~> (b -> a -> b) -> b -> b
Left.prototype.reduce = function (_step) {
  return start => start;
};

Right.prototype.reduce = function (step) {
  return start => step (start) (this.value);
};

/* Either#traverse  :: Applicative f
                    => Either e a ~> TypeRep f -> (a -> f b) -> f (Either e b) */
Left.prototype.traverse = function (F) {
  return _f => of (F) (this);
};

Right.prototype.traverse = function (_F) {
  return f => map (right) (f (this.value));
};

// Either#chain :: Either e a ~> (a -> Either e b) -> Either e b
Left.prototype.chain = function (_f) {
  return this;
};

Right.prototype.chain = function (f) {
  return f (this.value);
};

// Either#extend :: Either e a ~> (Either e a -> b) -> Either e b
Left.prototype.extend = function (_f) {
  return this;
};

Right.prototype.extend = function (f) {
  return right (f (this));
};

// Either#bimap :: Either e a ~> (e -> c) -> (a -> b) -> Either c b
Left.prototype.bimap = function (onLeft) {
  return _onRight => left (onLeft (this.value));
};

Right.prototype.bimap = function (_onLeft) {
  return onRight => right (onRight (this.value));
};

// Either#mapLeft :: Either e a ~> (e -> c) -> Either c a
Left.prototype.mapLeft = function (f) {
  return this.bimap (f) (identity);
};

Right.prototype.mapLeft = function (_f) {
  return this;
};

// Turns both sides into a Right.
// Either#coalesce :: Either e a ~> (e -> b) -> (a -> b) -> Either e b
Left.prototype.coalesce = function (onLeft) {
  return _onRight => right (onLeft (this.value));
};

Right.prototype.coalesce = function (_onLeft) {
  return onRight => right (onRight (this.value));
};

// Either#matchWith :: Either e a ~> { Left :: e -> b, Right :: a -> b } -> b
Left.prototype.matchWith = function (cases) {
  return cases.Left (this.value);
};

Right.prototype.matchWith = function (cases) {
  return cases.Right (this.value);
};

// Either#swap :: Either e a ~> () -> Either a e
Left.prototype.swap = function () {
  return right (this.value);
};

Right.prototype.swap = function () {
  return left (this.value);
};

// Either#show :: Either e a ~> () -> String
Left.prototype.show = function () {
  return "Left (" + show (this.value) + ")";
};

Right.prototype.show = function () {
  return "Right (" + show (this.value) + ")";
};

module.exports = Either;
