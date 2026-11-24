"use strict";

const show = require ("../more/show");

// What a route sends back: a stream, a piece of text, or a value to be
// serialised (JSON).
/*
 Body :: Stream a |
         Text a |
         Value a
 */
function Body() {
  throw new TypeError ("Body is abstract: use Body.Stream, Body.Text or Body.Value");
}

// Stream :: a -> Body a
function Stream(content) {
  this.value = content;
}

// Text :: a -> Body a
function Text(content) {
  this.value = content;
}

// Value :: a -> Body a
function Value(content) {
  this.value = content;
}

// Stream# :: Body
Stream.prototype = Object.create (Body.prototype);

// Text# :: Body
Text.prototype = Object.create (Body.prototype);

// Value# :: Body
Value.prototype = Object.create (Body.prototype);

// stream :: a -> Body a
function stream(content) {
  return new Stream (content);
}

// text :: a -> Body a
function text(content) {
  return new Text (content);
}

// value :: a -> Body a
function value(content) {
  return new Value (content);
}

// stream.name :: String
Object.defineProperty (stream, "name", { value: "Stream" });

// text.name :: String
Object.defineProperty (text, "name", { value: "Text" });

// value.name :: String
Object.defineProperty (value, "name", { value: "Value" });

// Body.Stream :: a -> Body a
Body.Stream = stream;

// Body.Text :: a -> Body a
Body.Text = text;

// Body.Value :: a -> Body a
Body.Value = value;

// Body#@@type :: String
Stream.prototype["@@type"] = "Body";
Text.prototype["@@type"] = "Body";
Value.prototype["@@type"] = "Body";

// Body#@@tag :: String
Stream.prototype["@@tag"] = "Stream";
Text.prototype["@@tag"] = "Text";
Value.prototype["@@tag"] = "Value";

// ::narrow Stream
// Body#isStream :: Boolean
Stream.prototype.isStream = true;
Text.prototype.isStream = false;
Value.prototype.isStream = false;

// ::narrow Text
// Body#isText :: Boolean
Stream.prototype.isText = false;
Text.prototype.isText = true;
Value.prototype.isText = false;

// ::narrow Value
// Body#isValue :: Boolean
Stream.prototype.isValue = false;
Text.prototype.isValue = false;
Value.prototype.isValue = true;

// Body#map :: Body a ~> (a -> b) -> Body b
Stream.prototype.map = function (f) {
  return stream (f (this.value));
};

Text.prototype.map = function (f) {
  return text (f (this.value));
};

Value.prototype.map = function (f) {
  return value (f (this.value));
};

// Body#matchWith :: Body a ~> { Stream :: a -> b, Text :: a -> b, Value :: a -> b } -> b
Stream.prototype.matchWith = function (cases) {
  return cases.Stream (this.value);
};

Text.prototype.matchWith = function (cases) {
  return cases.Text (this.value);
};

Value.prototype.matchWith = function (cases) {
  return cases.Value (this.value);
};

// Body#show :: Body a ~> () -> String
Stream.prototype.show = function () {
  return "Stream (" + show (this.value) + ")";
};

Text.prototype.show = function () {
  return "Text (" + show (this.value) + ")";
};

Value.prototype.show = function () {
  return "Value (" + show (this.value) + ")";
};

module.exports = Body;
