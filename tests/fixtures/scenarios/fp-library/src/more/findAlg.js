"use strict";

const curry = require ("./curry");
const getType = require ("./getType");
const hasFunction = require ("../predicate/hasFunction");

// Chooses the implementation of method `name` for a value.  `natives` maps
// runtime type names (Array, String, …) to implementations for values that
// do not carry the method themselves; `natives.Default` is the last resort.
// With `forType`, the first argument is a type representative and the
// method is a static one (`of`, `empty`, …).
// findAlg :: String -> { Default :: (x -> y) | Undefined, ...r } -> Boolean -> a -> b -> c
const findAlg = curry ((name, natives, forType) => {
  const fallback = natives["Default"];
  if (forType) {
    return rep => input => {
      const chosen = rep[name] || natives[rep.name] || fallback;
      if (!chosen) throw new TypeError (rep.name + " has no static method " + name);
      return chosen (input);
    };
  }
  const ownsIt = hasFunction (name);
  return receiver => {
    const typeName = getType (receiver);
    const native = natives[typeName];
    if (native) return arg => native.bind (receiver) (arg);
    if (ownsIt (receiver)) return arg => receiver[name] (arg);
    if (fallback) return arg => fallback.bind (receiver) (arg);
    throw new TypeError (typeName + " has no method " + name);
  };
});

module.exports = findAlg;
