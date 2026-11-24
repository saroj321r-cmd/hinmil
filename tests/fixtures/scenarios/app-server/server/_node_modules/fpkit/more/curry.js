"use strict";

// Gathers arguments until `arity` of them have arrived, in any grouping:
// `f (a) (b)`, `f (a, b)`, `f (a) (b, c)`.  An empty call returns the same
// function.  The result type depends on how many arguments arrive at
// runtime, which HM cannot express, so this body is unchecked; `curry`'s
// annotation is the contract.
// gather :: ((a, ...) -> z, Number, Array a) -> Array a -> z
// ::ignore-function
const gather = (fn, arity, held) => {
  const next = (...args) => {
    if (args.length === 0) return next;
    const all = held.concat (args);
    return all.length < arity ? gather (fn, arity, all) : fn (...all);
  };
  return next;
};

// Curries a function on its declared number of parameters (`fn.length`;
// defaults and rest parameters do not count — see `curryN`).
// curry :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curry = fn => gather (fn, fn.length, []);

module.exports = curry;
