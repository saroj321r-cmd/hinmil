"use strict";

const equals = require ("../fl/equals");
const Maybe = require ("../Maybe");
const show = require ("../more/show");

const { Nothing } = Maybe;

// The first present value wins: a monoid over Maybe.
// First :: Maybe a -> First a
function First(found) {
  // First#value :: First a ~> Maybe a
  this.value = found;
}

// first :: Maybe a -> First a
function first(found) {
  return new First (found);
}

// first.empty :: () -> First a
first.empty = First.empty = function () {
  return first (Nothing);
};

// first.name :: String
Object.defineProperty (first, "name", { value: "First" });

// First#@@type :: First a ~> String
First.prototype["@@type"] = "First";

// First#equals :: Setoid a => First a ~> First a -> Boolean
First.prototype.equals = function (other) {
  return equals (other.value) (this.value);
};

// First#concat :: First a ~> First a -> First a
First.prototype.concat = function (other) {
  return first (this.value.matchWith ({
    Just: _found => this.value,
    Nothing: () => other.value
  }));
};

// First#valueOf :: First a ~> () -> Maybe a
First.prototype.valueOf = function () {
  return this.value;
};

// First#show :: First a ~> () -> String
First.prototype.show = function () {
  return "First (" + show (this.value) + ")";
};

module.exports = first;
