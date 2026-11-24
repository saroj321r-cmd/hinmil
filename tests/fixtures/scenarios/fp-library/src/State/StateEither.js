"use strict";

const Either = require ("../Either");
const StateT = require ("./StateT");

// State over Either: a stateful computation that can fail.
const StateEither = StateT (Either);

module.exports = StateEither;
