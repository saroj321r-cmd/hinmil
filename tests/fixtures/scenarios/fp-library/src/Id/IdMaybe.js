"use strict";

const Maybe = require ("../Maybe");
const IdT = require ("./IdT");

// The identity transformer over Maybe.
// IdMaybe :: TypeRep (IdT Maybe)
const IdMaybe = IdT (Maybe);

module.exports = IdMaybe;
