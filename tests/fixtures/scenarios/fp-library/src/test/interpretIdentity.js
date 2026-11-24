"use strict";

const dispatch = require ("../Free/dispatch");
const Id = require ("../Id");
const boxToIdentity = require ("./boxToIdentity");
const FreeBox = require ("./FreeBox");

// Runs a Free program of FreeBox instructions in Id.
// interpretIdentity :: Functor m => m c -> Id c
const interpretIdentity = dispatch (Id.of) ([[FreeBox, boxToIdentity]]);

module.exports = interpretIdentity;
