"use strict";

const size = require ("../lst/size");
const findAlg = require ("../more/findAlg");
const sortKeys = require ("../object/sortKeys");
const isSameType = require ("../predicate/isSameType");

let natives = {};

// unboxed :: a -> a
const unboxed = x => (x === null || x === undefined ? x : x.valueOf ());

// ::rep Setoid Null#equals
// natives.Null :: Null ~> Null -> Boolean
natives.Null = function (_other) {
  return true;
};

// ::rep Setoid Undefined#equals
// natives.Undefined :: Undefined ~> Undefined -> Boolean
natives.Undefined = function (_other) {
  return true;
};

// NaN equals NaN here (Object.is), unlike with `===`; 0 equals -0.
// ::rep Setoid Number#equals
// natives.Number :: Number ~> Number -> Boolean
natives.Number = function (other) {
  const a = unboxed (this);
  const b = unboxed (other);
  return a === b || Object.is (a, b);
};

// ::rep Setoid String#equals
// natives.String :: String ~> String -> Boolean
natives.String = function (other) {
  return unboxed (this) === unboxed (other);
};

// ::rep Setoid Boolean#equals
// natives.Boolean :: Boolean ~> Boolean -> Boolean
natives.Boolean = function (other) {
  return unboxed (this) === unboxed (other);
};

// ::rep Setoid Array#equals
// natives.Array :: Setoid a => Array a ~> Array a -> Boolean
natives.Array = function (other) {
  return size (this) === size (other) && this.every ((x, i) => equals (other[i]) (x));
};

// Same keys (also keys holding `undefined`), and equal values under them.
// ::rep Setoid Object#equals
// natives.Object :: Setoid a => Object k a ~> Object k a -> Boolean
natives.Object = function (other) {
  const keys = sortKeys (this);
  return equals (sortKeys (other)) (keys) && keys.every (k => equals (other[k]) (this[k]));
};

// ::rep Setoid Date#equals
// natives.Date :: Date ~> Date -> Boolean
natives.Date = function (other) {
  return equals (other.getTime ()) (this.getTime ());
};

// ::rep Setoid RegExp#equals
// natives.RegExp :: RegExp ~> RegExp -> Boolean
natives.RegExp = function (other) {
  return String (this) === String (other) && this.lastIndex === other.lastIndex;
};

// ::rep Setoid Error#equals
// natives.Error :: Error ~> Error -> Boolean
natives.Error = function (other) {
  return this.name === other.name && this.message === other.message;
};

// Functions are only equal to themselves.
// ::rep Setoid Function#equals
// natives.Function  :: (* -> a) ~> (* -> b) -> Boolean
natives.Function = function (other) {
  return this === other;
};

// The dispatcher takes the value first (see ap.js).
// equalsFn :: Setoid a => a -> a -> Boolean
const equalsFn = findAlg ("equals") (natives) (false);

// Structural equality.  A pair that is already being compared further up
// (a structure that contains itself) counts as equal, so the comparison
// ends.
// equals :: Setoid a => a -> a -> Boolean
const equals = (() => {
  const comparing = new Map ();
  return a => b => {
    if (!isSameType (a) (b)) return false;
    const partners = comparing.get (a) || [];
    if (partners.includes (b)) return true;
    comparing.set (a, partners.concat ([b]));
    try {
      return equalsFn (b) (a);
    } finally {
      comparing.set (a, partners);
    }
  };
}) ();

module.exports = equals;
