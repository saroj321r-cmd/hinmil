"use strict";

const Future = require (".");
const Either = require ("../Either");
const FutureT = require ("./FutureT");

// A future of an Either.
// FutureEither :: TypeRep (FutureT (Either l) e)
const FutureEither = FutureT (Either);

// A Left stops the chain: it is passed on unchanged.
// chainEither :: FutureT (Either l) e a -> (a -> FutureT (Either l) e b) -> FutureT (Either l) e b
const chainEither = source => f =>
  FutureEither (reject => resolve =>
    source.fork (reject) (either => {
      if (either.isLeft) resolve (either);
      else f (either.value).fork (reject) (resolve);
    }));

// Folds the Either inside, leaving a plain future.
// matchEither :: FutureT (Either l) e a -> { Left :: l -> b, Right :: a -> b } -> Future e b
const matchEither = source => cases =>
  Future (reject => resolve => source.fork (reject) (either => resolve (either.matchWith (cases))));

// FutureEither#chain :: FutureT (Either l) e a ~> (a -> FutureT (Either l) e b) -> FutureT (Either l) e b
FutureEither.prototype.chain = function (f) {
  return chainEither (this) (f);
};

// FutureEither#matchWith :: FutureT (Either l) e a ~> { Left :: l -> b, Right :: a -> b } -> Future e b
FutureEither.prototype.matchWith = function (cases) {
  return matchEither (this) (cases);
};

module.exports = FutureEither;
