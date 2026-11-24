"use strict";

// Calls a value's own `swap`.
// swap :: { swap :: () -> r, ...s } -> r
const swap = pair => pair.swap ();

module.exports = swap;
