"use strict";

const reduce = require ("../fl/reduce");

// withLine :: String -> String -> String
const withLine = text => line => text + line + "\n";

// Joins lines, each one ended by a newline.
// unlines :: Array String -> String
const unlines = lines => reduce (withLine) ("") (lines);

module.exports = unlines;
