"use strict";

// The variant name of a sum-type value.
// tag :: a -> String
const tag = variant => variant["@@tag"];

module.exports = tag;
