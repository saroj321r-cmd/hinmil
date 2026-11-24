"use strict";

const getType = require ("../more/getType");

// isResult :: a -> Boolean
const isResult = candidate => getType (candidate) === "Result";

module.exports = isResult;
