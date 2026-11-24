"use strict";

// Applicative builds on Apply and Functor (ap.js, map.js).
// ::types ./ap
// ::types ./map

const curry = require ("../more/curry");
const findAlg = require ("../more/findAlg");

let natives = {};

// The constant function.
// ::rep Applicative Function.of
// natives.Function :: a -> Function [x] a
natives.Function = x => _ignored => x;

// The dispatcher takes the type representative first (see ap.js).
// ofFn :: Applicative f => TypeRep f -> a -> f a
const ofFn = findAlg ("of") (natives) (true);

// Wraps one value in an applicative.
// of :: Applicative f => TypeRep f -> a -> f a
const of = curry ((F, x) => ofFn (F) (x));

module.exports = of;
