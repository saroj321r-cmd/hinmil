"use strict";

// Anything but `undefined` (a `null` counts as defined).
// isDefined :: a -> Boolean
const isDefined = candidate => typeof candidate !== "undefined";

module.exports = isDefined;
