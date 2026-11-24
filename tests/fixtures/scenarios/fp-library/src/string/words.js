"use strict";

// The words of a text: split on whitespace, without the empty pieces that
// leading or trailing whitespace leaves.
// words :: String -> Array String
const words = text => text.split (/\s+/).filter (piece => piece.length > 0);

module.exports = words;
