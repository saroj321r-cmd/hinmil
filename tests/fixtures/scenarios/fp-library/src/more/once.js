"use strict";

// Runs `f` on the first call only; later calls return that first result.
// once :: (a -> b) -> a -> b
const once = f => {
  let ran = false;
  let first;
  return input => {
    if (!ran) {
      first = f (input);
      ran = true;
    }
    return first;
  };
};

module.exports = once;
