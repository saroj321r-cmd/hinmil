"use strict";

const identity = require ("../combinator/identity");
const concat = require ("../fl/concat");
const once = require ("../more/once");
const Step = require ("../Step");
const isResult = require ("../Result/isResult");

const { Done, Next } = Step;

// A lazy computation that fails with an `e` or succeeds with an `a`; it runs
// when forked.  `fork` returns whatever the handler returns for a future
// that settles right away (`alt` relies on that), e.g. a cancel function
// otherwise.
// Future :: ((e -> b) -> (a -> b) -> b) -> Future e a
function Future(fork) {
  // Future#fork :: Future e a ~> (e -> b) -> (a -> b) -> b
  this.fork = fork;
}

// future :: ((e -> b) -> (a -> b) -> b) -> Future e a
function future(fork) {
  return new Future (fork);
}

// future.of :: a -> Future e a
future.of = Future.of = function (value) {
  return future (_reject => resolve => resolve (value));
};

// Loops without growing the stack while the steps settle immediately; a
// step that settles later continues the loop from its own callback.
// future.chainRec :: (forall c. (a -> c) -> (b -> c) -> a -> Future e c) -> a -> Future e b
future.chainRec = Future.chainRec = function (step) {
  return seed => future (reject => resolve => {
    // run :: a -> ()
    const run = start => {
      let state = Next (start);
      let looping = true;
      while (looping && state.isNext) {
        let inside = true;
        let settled = false;
        step (Next) (Done) (state.value).fork (reject) (s => {
          if (inside) {
            state = s;
            settled = true;
          } else if (s.isNext) {
            run (s.value);
          } else {
            resolve (s.value);
          }
        });
        inside = false;
        looping = settled;
      }
      if (looping) resolve (state.value);
    };
    run (seed);
  });
};

// future.name :: String
Object.defineProperty (future, "name", { value: "Future" });

// Future#@@type :: String
Future.prototype["@@type"] = "Future";

// One after the other; a Result on the other side counts as a settled future.
// Future#concat :: Semigroup a => Future e a ~> Future e a -> Future e a
Future.prototype.concat = function (other) {
  return future (reject => resolve =>
    this.fork (reject) (mine => {
      const next = isResult (other) ? future.of (other) : other;
      return next.fork (reject) (theirs => resolve (concat (theirs) (mine)));
    }));
};

// Future#map :: Future e a ~> (a -> b) -> Future e b
Future.prototype.map = function (f) {
  return future (reject => resolve => this.fork (reject) (value => resolve (f (value))));
};

// Both futures run at the same time; the first failure wins.
// Future#ap :: Future e a ~> Future e (a -> b) -> Future e b
Future.prototype.ap = function (fns) {
  return future (reject => resolve => {
    const rejectOnce = once (reject);
    let f;
    let x;
    let haveF = false;
    let haveX = false;
    // finish :: () -> ()
    const finish = () => {
      if (haveF && haveX) resolve (f (x));
    };
    fns.fork (rejectOnce) (g => {
      f = g;
      haveF = true;
      finish ();
    });
    this.fork (rejectOnce) (value => {
      x = value;
      haveX = true;
      finish ();
    });
  });
};

// Future#chain :: Future e a ~> (a -> Future e b) -> Future e b
Future.prototype.chain = function (f) {
  return future (reject => resolve => this.fork (reject) (value => f (value).fork (reject) (resolve)));
};

// Settles this future first and keeps it unless it failed.
// Future#alt :: Future e a ~> Future e a -> Future e a
Future.prototype.alt = function (other) {
  return this.fork (_failure => other) (_value => this);
};

// Future#bimap :: Future e a ~> (e -> c) -> (a -> b) -> Future c b
Future.prototype.bimap = function (onFailure) {
  return onSuccess => future (reject => resolve =>
    this.fork (failure => reject (onFailure (failure))) (value => resolve (onSuccess (value))));
};

// Future#mapLeft :: Future e a ~> (e -> c) -> Future c a
Future.prototype.mapLeft = function (f) {
  return this.bimap (f) (identity);
};

// A failure becomes a success too.
// Future#coalesce :: Future e a ~> (e -> b) -> (a -> b) -> Future e b
Future.prototype.coalesce = function (onFailure) {
  return onSuccess => future (_reject => resolve =>
    this.fork (failure => resolve (onFailure (failure))) (value => resolve (onSuccess (value))));
};

// Future#bichain :: Future e a ~> (e -> Future c b) -> (a -> Future c b) -> Future c b
Future.prototype.bichain = function (onFailure) {
  return onSuccess => future (reject => resolve =>
    this.fork (failure => onFailure (failure).fork (reject) (resolve))
      (value => onSuccess (value).fork (reject) (resolve)));
};

// Future#swap :: Future e a ~> () -> Future a e
Future.prototype.swap = function () {
  return future (reject => resolve => this.fork (failure => resolve (failure)) (value => reject (value)));
};

// Future#show :: Future e a ~> () -> String
Future.prototype.show = function () {
  return "Future (fork :: (e -> ()) -> (a -> ()) -> ())";
};

module.exports = future;
