"use strict";

// Monoid builds on Semigroup; the Object instance is in concat.js.
// ::types ./concat

const findAlg = require ("../more/findAlg");

let natives = {};

// ::rep Monoid String.empty
// natives.String :: () -> String
natives.String = () => "";

// ::rep Monoid Array.empty
// natives.Array :: () -> Array a
natives.Array = () => [];

// ::rep Monoid Object.empty
// natives.Object :: () -> Object k a
natives.Object = () => ({});

// The dispatcher takes the type representative first (see ap.js).
// emptyFn :: Monoid m => TypeRep m -> () -> m
const emptyFn = findAlg ("empty") (natives) (true);

// The neutral value of a monoid.
// empty :: Monoid m => TypeRep m -> m
const empty = M => emptyFn (M) ();

module.exports = empty;
