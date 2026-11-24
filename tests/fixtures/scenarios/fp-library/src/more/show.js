"use strict";

const findAlg = require ("./findAlg");
const sortKeys = require ("../object/sortKeys");

// field :: a -> String -> String
const field = record => key => show (key) + ": " + show (record[key]);

// boxed :: String -> String -> String
const boxed = kind => inner => "new " + kind + "(" + inner + ")";

let natives = {};

// natives.Null :: Null ~> () -> String
natives.Null = function () {
  return "null";
};

// natives.Undefined :: Undefined ~> () -> String
natives.Undefined = function () {
  return "undefined";
};

// natives.Number :: Number ~> () -> String
natives.Number = function () {
  if (typeof this === "object") return boxed ("Number") (show (this.valueOf ()));
  return Object.is (this, -0) ? "-0" : String (this);
};

// Quoted like a literal, so the text can be read back.
// natives.String :: String ~> () -> String
natives.String = function () {
  if (typeof this === "object") return boxed ("String") (show (this.valueOf ()));
  return JSON.stringify (this);
};

// natives.Boolean :: Boolean ~> () -> String
natives.Boolean = function () {
  if (typeof this === "object") return boxed ("Boolean") (show (this.valueOf ()));
  return this ? "true" : "false";
};

// Elements first, then any extra (non-index) keys.
// natives.Array :: Array a ~> () -> String
natives.Array = function () {
  const extra = sortKeys (this).filter (k => !/^[0-9]+$/.test (k)).map (field (this));
  return "[" + this.map (show).concat (extra).join (", ") + "]";
};

// natives.Object :: Object k a ~> () -> String
natives.Object = function () {
  return "{" + sortKeys (this).map (field (this)).join (", ") + "}";
};

// natives.Date :: Date ~> () -> String
natives.Date = function () {
  const valid = !isNaN (this.getTime ());
  return boxed ("Date") (show (valid ? this.toISOString () : NaN));
};

// natives.RegExp :: RegExp ~> () -> String
natives.RegExp = function () {
  return String (this);
};

// natives.Error :: Error ~> () -> String
natives.Error = function () {
  return this.name + "(" + show (this.message) + ")";
};

// natives.Function :: Function [x] a ~> () -> String
natives.Function = function () {
  return this.toString ();
};

// natives.Uint8Array :: Uint8Array ~> () -> String
natives.Uint8Array = function () {
  return this.toString ();
};

// The dispatcher takes the value first; which implementation runs is only
// known at runtime, so hinmil cannot check it against the bodies above.
// describe :: a -> () -> String
const describe = findAlg ("show") (natives) (false);

// A readable, re-evaluable text for any value; a value that contains itself
// shows as <Circular>.
// show :: a -> String
const show = (() => {
  const visiting = new Set ();
  return value => {
    if (visiting.has (value)) return "<Circular>";
    visiting.add (value);
    try {
      return describe (value) ();
    } finally {
      visiting.delete (value);
    }
  };
}) ();

module.exports = show;
