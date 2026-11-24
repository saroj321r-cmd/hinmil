"use strict";

const curry = require ("../more/curry");
const isFunction = require ("./isFunction");
const nil = require ("./nil");

// Does `target` carry a callable member called `name`?
// hasFunction :: String -> a -> Boolean
const hasFunction = curry ((name, target) =>
  !nil (target) && isFunction (target[name]));

module.exports = hasFunction;
