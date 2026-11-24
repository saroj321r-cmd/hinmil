"use strict";

const chain = require ("../fl/chain");
const concat = require ("../fl/concat");
const map = require ("../fl/map");
const getName = require ("../more/getName");
const Pair = require ("../Pair");
const fst = require ("../Pair/fst");
const snd = require ("../Pair/snd");

// A computation that threads a state `s` through steps of the base monad
// `M`: running it with a start state gives the result and the final state.
// StateTOver :: Monad m => TypeRep m -> TypeRep (StateT m s)
const StateTOver = M => {
  // innerName :: String
  const innerName = getName (M);
  // label :: String
  const label = "State" + innerName;

  // StateT :: Monad m => (s -> m (Pair a s)) -> StateT m s a
  function StateT(run) {
    // StateT#run :: Monad m => StateT m s a ~> s -> m (Pair a s)
    this.run = run;
  }

  // stateT :: Monad m => (s -> m (Pair a s)) -> StateT m s a
  function stateT(run) {
    return new StateT (run);
  }

  // StateT.of :: Monad m => a -> StateT m s a
  stateT.of = StateT.of = function (value) {
    return stateT (state => M.of (Pair (value) (state)));
  };

  // Runs a step of the base monad without touching the state.
  // StateT.lift :: Monad m => m a -> StateT m s a
  stateT.lift = StateT.lift = function (inner) {
    return stateT (state => map (value => Pair (value) (state)) (inner));
  };

  // The state itself as the result.
  // StateT.pull :: Monad m => StateT m s s
  stateT.pull = stateT (state => M.of (Pair (state) (state)));

  // Something derived from the state.
  // StateT.pulls :: Monad m => (s -> a) -> StateT m s a
  stateT.pulls = function (read) {
    return stateT (state => M.of (Pair (read (state)) (state)));
  };

  // StateT.modify :: Monad m => (s -> s) -> StateT m s Null
  stateT.modify = function (change) {
    return stateT (state => M.of (Pair (null) (change (state))));
  };

  // StateT.set :: Monad m => s -> StateT m s Null
  stateT.set = function (next) {
    return stateT (_state => M.of (Pair (null) (next)));
  };

  // StateT.name :: String
  Object.defineProperty (StateT, "name", { value: label });

  // stateT.name :: String
  Object.defineProperty (stateT, "name", { value: label });

  // StateT#@@type :: StateT m s a ~> String
  StateT.prototype["@@type"] = label;

  // Both run on the same start state; the results join, this state is kept.
  // StateT#concat :: (Monad m, Semigroup a) => StateT m s a ~> StateT m s a -> StateT m s a
  StateT.prototype.concat = function (other) {
    return stateT (state =>
      chain (mine => map (theirs => Pair (concat (fst (theirs)) (fst (mine))) (snd (mine))) (other.run (state)))
        (this.run (state)));
  };

  // StateT#map :: Monad m => StateT m s a ~> (a -> b) -> StateT m s b
  StateT.prototype.map = function (f) {
    return stateT (state => this.run (state).map (p => Pair (f (fst (p))) (snd (p))));
  };

  // StateT#ap :: Monad m => StateT m s a ~> StateT m s (a -> b) -> StateT m s b
  StateT.prototype.ap = function (fns) {
    return chain (f => map (f) (this)) (fns);
  };

  // The next step starts from the state this one ended with.
  // StateT#chain :: Monad m => StateT m s a ~> (a -> StateT m s b) -> StateT m s b
  StateT.prototype.chain = function (f) {
    return stateT (state => chain (p => f (fst (p)).run (snd (p))) (this.run (state)));
  };

  // Only the result.
  // StateT#eval :: Monad m => StateT m s a ~> s -> m a
  StateT.prototype.eval = function (start) {
    return this.run (start).map (fst);
  };

  // Only the final state.
  // StateT#exec :: Monad m => StateT m s a ~> s -> m s
  StateT.prototype.exec = function (start) {
    return this.run (start).map (snd);
  };

  // StateT#show :: StateT m s a ~> () -> String
  StateT.prototype.show = function () {
    return label + " (run :: s -> " + innerName + " (Pair a s))";
  };

  // So that `instanceof` and prototype extensions work on the factory.
  stateT.prototype = StateT.prototype;

  return stateT;
};

module.exports = StateTOver;
