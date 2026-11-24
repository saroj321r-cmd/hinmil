"use strict";

const equals = require ("../fl/equals");
const show = require ("../more/show");

// The smallest functor there is, used as a Free-monad instruction in tests.
// Callable with or without `new`.
// FreeBox :: a -> FreeBox a
function FreeBox(content) {
  if (!(this instanceof FreeBox)) return new FreeBox (content);
  // FreeBox#value :: FreeBox a ~> a
  this.value = content;
}

// FreeBox.of :: a -> FreeBox a
FreeBox.of = function (content) {
  return new FreeBox (content);
};

// FreeBox.@@type :: String
FreeBox["@@type"] = "FreeBox";

// FreeBox#@@type :: FreeBox a ~> String
FreeBox.prototype["@@type"] = "FreeBox";

// FreeBox#equals :: Setoid a => FreeBox a ~> FreeBox a -> Boolean
FreeBox.prototype.equals = function (other) {
  return equals (other.value) (this.value);
};

// An instruction of a free monad is a functor.
// FreeBox#map :: FreeBox a ~> (a -> b) -> FreeBox b
FreeBox.prototype.map = function (f) {
  return new FreeBox (f (this.value));
};

// FreeBox#chain :: FreeBox a ~> (a -> FreeBox b) -> FreeBox b
FreeBox.prototype.chain = function (f) {
  return f (this.value);
};

// FreeBox#show :: FreeBox a ~> () -> String
FreeBox.prototype.show = function () {
  return "FreeBox (" + show (this.value) + ")";
};

module.exports = FreeBox;
