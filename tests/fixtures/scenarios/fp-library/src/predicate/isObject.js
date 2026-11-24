"use strict";

// A plain object (not an array, a date, null, …).
// isObject :: a -> Boolean
const isObject = candidate =>
  Object.prototype.toString.call (candidate) === "[object Object]";

module.exports = isObject;
