"use strict";

// The keys of a record (or the indices of a list), in sorted order.
// sortKeys :: { ...r } -> [String]
// sortKeys :: [a] -> [String]
const sortKeys = target => Object.keys (target).sort ();

module.exports = sortKeys;
