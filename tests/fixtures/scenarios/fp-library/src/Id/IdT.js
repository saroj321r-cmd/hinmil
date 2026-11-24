"use strict";

const chain = require ("../fl/chain");
const equals = require ("../fl/equals");
const map = require ("../fl/map");
const getName = require ("../more/getName");
const show = require ("../more/show");

// The identity transformer: adds nothing to the base monad `M`, which makes
// it the smallest example of the transformer shape (a factory from a type
// representative to a new one).
// IdTOver :: Monad m => TypeRep m -> TypeRep (IdT m)
const IdTOver = M => {
  // label :: String
  const label = "Id" + getName (M);

  // IdT :: Monad m => m a -> IdT m a
  function IdT(inner) {
    // IdT#value :: Monad m => IdT m a ~> m a
    this.value = inner;
  }

  // idT :: Monad m => m a -> IdT m a
  function idT(inner) {
    return new IdT (inner);
  }

  // IdT.of :: Monad m => a -> IdT m a
  idT.of = IdT.of = function (value) {
    return idT (M.of (value));
  };

  // Wraps a computation of the base monad.
  // IdT.lift :: Monad m => m a -> IdT m a
  idT.lift = IdT.lift = function (inner) {
    return idT (inner);
  };

  // IdT.name :: String
  Object.defineProperty (IdT, "name", { value: label });

  // idT.name :: String
  Object.defineProperty (idT, "name", { value: label });

  // IdT#@@type :: IdT m a ~> String
  IdT.prototype["@@type"] = label;

  // IdT#equals :: (Monad m, Setoid (m a)) => IdT m a ~> IdT m a -> Boolean
  IdT.prototype.equals = function (other) {
    return equals (other.value) (this.value);
  };

  // IdT#map :: Monad m => IdT m a ~> (a -> b) -> IdT m b
  IdT.prototype.map = function (f) {
    return idT (map (f) (this.value));
  };

  // IdT#ap :: Monad m => IdT m a ~> IdT m (a -> b) -> IdT m b
  IdT.prototype.ap = function (fns) {
    return chain (f => map (f) (this)) (fns);
  };

  // IdT#chain :: Monad m => IdT m a ~> (a -> IdT m b) -> IdT m b
  IdT.prototype.chain = function (f) {
    return idT (chain (value => f (value).extract ()) (this.value));
  };

  // IdT#extract :: Monad m => IdT m a ~> () -> m a
  IdT.prototype.extract = function () {
    return this.value;
  };

  // IdT#show :: IdT m a ~> () -> String
  IdT.prototype.show = function () {
    return label + " (" + show (this.value) + ")";
  };

  // So that `instanceof` and prototype extensions work on the factory.
  idT.prototype = IdT.prototype;

  return idT;
};

module.exports = IdTOver;
