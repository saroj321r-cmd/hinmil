// Either :: Left e | Right a

// Either#value :: Either e a ~> (e | a)
// Either.of :: a -> Either e a

// Left :: e -> Either e a
function Left(value) {
  this.value = value;
  // ::private
  // Either#tag :: Either e a ~> String
  this.tag = "Left";
}

// Right :: a -> Either e a
function Right(value) {
  this.value = value;
  this.tag = "Right";
}

// _Left :: e -> Either e a
function _Left(value) {
  return new Left(value);
}

// _Right :: a -> Either e a
function _Right(value) {
  return new Right(value);
}

// Either#map :: Either e a ~> (a -> b) -> Either e b 
Right.prototype.map = function (fn) {
  return _Right(fn(this.value));
};

Left.prototype.map = function (_fn) {
  return _Left(this.value);
};

// Either#chain :: Either e a ~> (a -> Either e b) -> Either e b
Right.prototype.chain = function (fn) {
  return fn(this.value);
};

Left.prototype.chain = function (_fn) {
  return _Left(this.value);
};

// ::narrow Left
// Either#isLeft :: Either e a ~> Boolean
Left.prototype.isLeft = true

Right.prototype.isLeft = false

// either :: (a -> c, b -> d, Either a b) -> c | d
const either = (f, g, e) => {
  return e.isLeft ? g(e.value) : f(e.value)
}

// ::private
// Either#_inspect :: Either e a ~> () -> String
Right.prototype._inspect = function () {
  return "Right(" + String(this.value) + ")";
};

Left.prototype._inspect = function () {
  return "Left(" + String(this.value) + ")";
};

// Inside the prototype method, `this.tag` and `this._inspect()` are allowed.
// Outside, accessing `.tag` or `._inspect` on an Either value is a private-access error.

const right = Right(1)

module.exports = { Left, Right, of: (value) => _Right(value) };
 