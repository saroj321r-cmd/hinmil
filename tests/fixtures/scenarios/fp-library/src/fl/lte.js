"use strict";

const findAlg = require ("../more/findAlg");
const sortKeys = require ("../object/sortKeys");
const isSameType = require ("../predicate/isSameType");
const equals = require ("./equals");

let natives = {};

// unboxed :: a -> a
const unboxed = x => (x === null || x === undefined ? x : x.valueOf ());

// ::rep Ord Null#lte
// natives.Null :: Null ~> Null -> Boolean
natives.Null = function (_other) {
  return true;
};

// ::rep Ord Undefined#lte
// natives.Undefined :: Undefined ~> Undefined -> Boolean
natives.Undefined = function (_other) {
  return true;
};

// NaN sorts before every number.
// ::rep Ord Number#lte
// natives.Number :: Number ~> Number -> Boolean
natives.Number = function (other) {
  const a = unboxed (this);
  return Number.isNaN (a) || a <= unboxed (other);
};

// ::rep Ord String#lte
// natives.String :: String ~> String -> Boolean
natives.String = function (other) {
  return unboxed (this) <= unboxed (other);
};

// false before true.
// ::rep Ord Boolean#lte
// natives.Boolean :: Boolean ~> Boolean -> Boolean
natives.Boolean = function (other) {
  return !unboxed (this) || !!unboxed (other);
};

// Lexicographic: the first differing element decides; a prefix comes first.
// ::rep Ord Array#lte
// natives.Array :: Setoid a => Array a ~> Array a -> Boolean
natives.Array = function (other) {
  const shared = Math.min (this.length, other.length);
  const differs = this.slice (0, shared).findIndex ((x, i) => !equals (other[i]) (x));
  if (differs >= 0) return lte (other[differs]) (this[differs]);
  return this.length <= other.length;
};

// Compares the sorted keys first, then the values under them.
// ::rep Ord Object#lte
// natives.Object :: Ord a => Object k a ~> Object k a -> Boolean
natives.Object = function (other) {
  const mine = sortKeys (this);
  const theirs = sortKeys (other);
  for (let i = 0; i < mine.length; i += 1) {
    if (i >= theirs.length) return false;
    if (mine[i] !== theirs[i]) return mine[i] < theirs[i];
    if (!equals (other[mine[i]]) (this[mine[i]])) return lte (other[mine[i]]) (this[mine[i]]);
  }
  return true;
};

// ::rep Ord Date#lte
// natives.Date :: Date ~> Date -> Boolean
natives.Date = function (other) {
  return this.getTime () <= other.getTime ();
};

// The dispatcher takes the value first (see ap.js).
// lteFn :: Ord a => a -> a -> Boolean
const lteFn = findAlg ("lte") (natives) (false);

// `lte (x) (y)`: is y at most x?  Values of different types are unordered
// (false).  A pair already being compared further up falls back to
// `equals`, so a structure that contains itself still ends.
// lte :: Ord a => a -> a -> Boolean
const lte = (() => {
  const comparing = new Map ();
  return a => b => {
    if (!isSameType (a) (b)) return false;
    const partners = comparing.get (a) || [];
    if (partners.includes (b)) return equals (a) (b);
    comparing.set (a, partners.concat ([b]));
    try {
      return lteFn (b) (a);
    } finally {
      comparing.set (a, partners);
    }
  };
}) ();

module.exports = lte;
