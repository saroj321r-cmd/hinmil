"use strict";

const equals = require ("../fl/equals");
const show = require ("../more/show");

// Numbers under addition, as a monoid (and a group).
// Sum :: Number -> Sum
function Sum(amount) {
  // Sum#value :: Sum ~> Number
  this.value = amount;
}

// sum :: Number -> Sum
function sum(amount) {
  return new Sum (amount);
}

// sum.empty :: () -> Sum
sum.empty = Sum.empty = function () {
  return sum (0);
};

// sum.name :: String
Object.defineProperty (sum, "name", { value: "Sum" });

// Sum#@@type :: String
Sum.prototype["@@type"] = "Sum";

// Sum#equals :: Sum ~> Sum -> Boolean
Sum.prototype.equals = function (other) {
  return equals (other.value) (this.value);
};

// Sum#concat :: Sum ~> Sum -> Sum
Sum.prototype.concat = function (other) {
  return sum (this.value + other.value);
};

// Sum#invert :: Sum ~> () -> Sum
Sum.prototype.invert = function () {
  return sum (0 - this.value);
};

// Sum#valueOf :: Sum ~> () -> Number
Sum.prototype.valueOf = function () {
  return this.value;
};

// Sum#show :: Sum ~> () -> String
Sum.prototype.show = function () {
  return "Sum (" + show (this.value) + ")";
};

module.exports = sum;
