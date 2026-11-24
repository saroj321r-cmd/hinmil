"use strict";

const curry = require ("../more/curry");
const flip = require ("../combinator/flip");
const concat = require ("../fl/concat");
const empty = require ("../fl/empty");
const lte = require ("../fl/lte");
const of = require ("../fl/of");
const reduce = require ("../fl/reduce");

// atMost :: Ord a => a -> a -> Boolean
const atMost = flip (lte);

// Sorts by a key, stably: equal keys keep their order.  Numbers and strings
// compare natively (NaN first); other keys through their `lte`.
// sortBy :: (Ord b, Applicative m, Foldable m, Monoid (m a)) => (a -> b) -> m a -> m a
const sortBy = curry ((keyOf, foldable) => {
  const entries = reduce (acc => item => acc.concat ([{ at: acc.length, item, key: keyOf (item) }])) ([]) (foldable);
  const kind = entries.length === 0 ? "none" : typeof entries[0].key;
  const before = kind === "number" ? a => b => a <= b || a !== a
    : kind === "string" ? a => b => a <= b
    : atMost;
  const order = (x, y) => {
    const xFirst = before (x.key) (y.key);
    const yFirst = before (y.key) (x.key);
    if (xFirst && yFirst) return x.at - y.at;
    return xFirst ? -1 : 1;
  };
  const sorted = entries.slice ().sort (order);
  if (Array.isArray (foldable)) return sorted.map (entry => entry.item);
  const Rep = foldable.constructor;
  let rebuilt = empty (Rep);
  for (const entry of sorted) rebuilt = concat (of (Rep) (entry.item)) (rebuilt);
  return rebuilt;
});

module.exports = sortBy;
