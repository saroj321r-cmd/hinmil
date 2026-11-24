"use strict";

// collectN :: (Number, (a, ...) -> z, Array a) -> Array a -> z
// ::ignore-function
const collectN = (arity, fn, held) => (...args) => {
  const all = held.concat (args.length === 0 ? [undefined] : args);
  return all.length < arity ? collectN (arity, fn, all) : fn (...all.slice (0, arity));
};

// Curries to exactly `arity` arguments, whatever `fn.length` says (for
// functions with defaults, rest parameters or bound functions).  An empty
// call passes `undefined`.
// curryN :: Number -> ((a, b, ...) -> z) -> a -> b -> ... -> z
const curryN = arity => fn => collectN (arity, fn, []);

module.exports = curryN;
