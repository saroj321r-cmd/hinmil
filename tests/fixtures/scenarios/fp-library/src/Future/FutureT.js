"use strict";

const chain = require ("../fl/chain");
const map = require ("../fl/map");
const getName = require ("../more/getName");

// A future whose result lives in the base monad `M` (a Maybe, an Either, …).
// FutureTOver :: Monad m => TypeRep m -> TypeRep (FutureT m e)
const FutureTOver = M => {
  // innerName :: String
  const innerName = getName (M);
  // label :: String
  const label = "Future" + innerName;

  // FutureT :: Monad m => ((e -> ()) -> (m a -> ()) -> ()) -> FutureT m e a
  function FutureT(fork) {
    // FutureT#fork :: Monad m => FutureT m e a ~> (e -> ()) -> (m a -> ()) -> ()
    this.fork = fork;
  }

  // futureT :: Monad m => ((e -> ()) -> (m a -> ()) -> ()) -> FutureT m e a
  function futureT(fork) {
    return new FutureT (fork);
  }

  // FutureT.of :: Monad m => a -> FutureT m e a
  futureT.of = FutureT.of = function (value) {
    return futureT (_reject => resolve => resolve (M.of (value)));
  };

  // Wraps a value of the base monad.
  // FutureT.lift :: Monad m => m a -> FutureT m e a
  futureT.lift = FutureT.lift = function (inner) {
    return futureT (_reject => resolve => resolve (inner));
  };

  // FutureT.rejected :: Monad m => e -> FutureT m e a
  futureT.rejected = function (failure) {
    return futureT (reject => _resolve => reject (failure));
  };

  // FutureT.name :: String
  Object.defineProperty (FutureT, "name", { value: label });

  // futureT.name :: String
  Object.defineProperty (futureT, "name", { value: label });

  // FutureT#@@type :: FutureT m e a ~> String
  FutureT.prototype["@@type"] = label;

  // FutureT#map :: Monad m => FutureT m e a ~> (a -> b) -> FutureT m e b
  FutureT.prototype.map = function (f) {
    return futureT (reject => resolve => this.fork (reject) (inner => resolve (map (f) (inner))));
  };

  // Continues with every value inside the base monad.  A base value without
  // one (Left, Nothing) never settles here; FutureEither overrides `chain`
  // for that.
  // FutureT#chain :: Monad m => FutureT m e a ~> (a -> FutureT m e b) -> FutureT m e b
  FutureT.prototype.chain = function (f) {
    return futureT (reject => resolve =>
      this.fork (reject) (inner => {
        map (value => f (value).fork (reject) (resolve)) (inner);
      }));
  };

  // Derived from `chain`, so the instance is a lawful Apply.
  // FutureT#ap :: Monad m => FutureT m e a ~> FutureT m e (a -> b) -> FutureT m e b
  FutureT.prototype.ap = function (fns) {
    return chain (f => map (f) (this)) (fns);
  };

  // FutureT#show :: FutureT m e a ~> () -> String
  FutureT.prototype.show = function () {
    return label + " (fork :: (e -> ()) -> (" + innerName + " a -> ()) -> ())";
  };

  // So that `instanceof` and prototype extensions work on the factory.
  futureT.prototype = FutureT.prototype;

  return futureT;
};

module.exports = FutureTOver;
