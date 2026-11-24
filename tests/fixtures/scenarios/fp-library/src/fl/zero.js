"use strict";

// Plus builds on Alt and Functor (alt.js, map.js).
// ::types ./alt
// ::types ./map

const findAlg = require ("../more/findAlg");

let natives = {};

// ::rep Plus Array.zero
// natives.Array :: () -> Array a
natives.Array = () => [];

// ::rep Plus Object.zero
// natives.Object :: () -> Object k a
natives.Object = () => ({});

// The dispatcher takes the type representative first (see ap.js).
// zeroFn :: Plus f => TypeRep f -> () -> f a
const zeroFn = findAlg ("zero") (natives) (true);

// The empty alternative.
// zero :: Plus f => TypeRep f -> f a
const zero = F => zeroFn (F) ();

module.exports = zero;
