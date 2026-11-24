"use strict";

// The name of a type representative, or of a singleton value.
// getName :: a -> String
const getName = rep => rep.name || rep["@@singleton"];

module.exports = getName;
