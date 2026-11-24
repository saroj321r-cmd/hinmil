"use strict";

const curry = require ("../more/curry");
const getType = require ("../more/getType");

// Both values have the same runtime type (primitive kind and type name).
// isSameType :: a -> b -> Boolean
const isSameType = curry ((left, right) =>
  getType (left) === getType (right) && typeof left === typeof right);

module.exports = isSameType;
