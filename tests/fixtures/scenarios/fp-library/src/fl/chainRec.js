"use strict";

// ChainRec builds on Chain and Apply (chain.js, ap.js).
// ::types ./chain
// ::types ./ap

const curry = require ("../more/curry");
const findAlg = require ("../more/findAlg");
const Step = require ("../Step");
const isDone = require ("../Step/isDone");
const isNext = require ("../Step/isNext");

const { Next, Done } = Step;

let natives = {};

// Depth-first, without recursion: each step returns more seeds (Next) and
// results (Done); seeds are expanded before the ones queued earlier.
// ::rep ChainRec Array.chainRec
// natives.Array :: (forall c. (a -> c) -> (b -> c) -> a -> Array c) -> a -> Array b
natives.Array = function (step) {
  return seed => {
    const pending = [seed];
    const results = [];
    while (pending.length > 0) {
      const produced = step (Next) (Done) (pending.shift ());
      const seeds = [];
      for (const s of produced) {
        if (isDone (s)) results.push (s.value);
        else seeds.push (s.value);
      }
      pending.unshift (...seeds);
    }
    return results;
  };
};

// Loops until the step says Done; every step reads the same environment.
// ::rep ChainRec Function.chainRec
// natives.Function :: (forall c. (a -> c) -> (b -> c) -> a -> Function [z] c) -> a -> Function [z] b
natives.Function = function (step) {
  return seed => env => {
    let state = Next (seed);
    while (isNext (state)) state = step (Next) (Done) (state.value) (env);
    return state.value;
  };
};

// The dispatcher takes the type representative first (see ap.js).
// chainRecFn :: ChainRec m => TypeRep m -> ((a -> c) -> (b -> c) -> a -> m c) -> a -> m b
const chainRecFn = findAlg ("chainRec") (natives) (true);

// chainRec :: ChainRec m => TypeRep m -> ((a -> c) -> (b -> c) -> a -> m c) -> a -> m b
const chainRec = curry ((M, step, seed) => chainRecFn (M) (step) (seed));

module.exports = chainRec;
