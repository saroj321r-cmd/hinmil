"use strict";

// A validation result.  Unlike Either, failures ACCUMULATE: `ap` and
// `concat` on two Errs join their values (a Semigroup, typically a list of
// messages), so every problem of an input is reported at once.

const concat = require ("../fl/concat");
const equals = require ("../fl/equals");
const show = require ("../more/show");

// Result :: Err e | Ok a
function Result() {
  throw new TypeError ("Result is abstract: use Result.Ok or Result.Err");
}

// Err :: e -> Result e a
function Err(value) {
  // Result#value :: Result e a ~> e | a
  this.value = value;
}

// Ok :: a -> Result e a
function Ok(value) {
  this.value = value;
}

Err.prototype = Object.create (Result.prototype);
Ok.prototype = Object.create (Result.prototype);

// err :: e -> Result e a
function err(problems) {
  return new Err (problems);
}

// ok :: a -> Result e a
function ok(value) {
  return new Ok (value);
}

// err.name :: String
Object.defineProperty (err, "name", { value: "Err" });

// ok.name :: String
Object.defineProperty (ok, "name", { value: "Ok" });

// Result.Err :: e -> Result e a
Result.Err = err;

// Result.Ok :: a -> Result e a
Result.Ok = ok;

// Result.of :: a -> Result e a
Result.of = function (value) {
  return ok (value);
};

// Result#@@type :: Result e a ~> String
Err.prototype["@@type"] = "Result";
Ok.prototype["@@type"] = "Result";

// Result#@@tag :: Result e a ~> String
Err.prototype["@@tag"] = "Err";
Ok.prototype["@@tag"] = "Ok";

// ::narrow Err
// Result#isErr :: Result e a ~> Boolean
Err.prototype.isErr = true;
Ok.prototype.isErr = false;

// Result#isOk :: Result e a ~> Boolean
Err.prototype.isOk = false;
Ok.prototype.isOk = true;

// Result#caseOf :: Result e a ~> { Err :: e -> b, Ok :: a -> b } -> b
Err.prototype.caseOf = function (cases) {
  return cases.Err (this.value);
};

Ok.prototype.caseOf = function (cases) {
  return cases.Ok (this.value);
};

// The same as `caseOf`, under the name the other sum types use.
// Result#matchWith :: Result e a ~> { Err :: e -> b, Ok :: a -> b } -> b
Err.prototype.matchWith = Err.prototype.caseOf;
Ok.prototype.matchWith = Ok.prototype.caseOf;

/* Result#equals :: (Setoid e, Setoid a)
                 => Result e a ~> Result e a -> Boolean */
Err.prototype.equals = function (other) {
  return other.caseOf ({ Err: problems => equals (problems) (this.value), Ok: _value => false });
};

Ok.prototype.equals = function (other) {
  return other.caseOf ({ Err: _problems => false, Ok: value => equals (value) (this.value) });
};

// Result#map :: Result e a ~> (a -> b) -> Result e b
Err.prototype.map = function (_f) {
  return this;
};

Ok.prototype.map = function (f) {
  return ok (f (this.value));
};

// Result#mapErr :: Result e a ~> (e -> c) -> Result c a
Err.prototype.mapErr = function (f) {
  return err (f (this.value));
};

Ok.prototype.mapErr = function (_f) {
  return this;
};

// Result#mapLeft :: Result e a ~> (e -> c) -> Result c a
Err.prototype.mapLeft = Err.prototype.mapErr;
Ok.prototype.mapLeft = Ok.prototype.mapErr;

// Result#bimap :: Result e a ~> (e -> c) -> (a -> b) -> Result c b
Err.prototype.bimap = function (onErr) {
  return _onOk => err (onErr (this.value));
};

Ok.prototype.bimap = function (_onErr) {
  return onOk => ok (onOk (this.value));
};

// Result#chain :: Result e a ~> (a -> Result e b) -> Result e b
Err.prototype.chain = function (_f) {
  return this;
};

Ok.prototype.chain = function (f) {
  return f (this.value);
};

// Two failures join (the function side first); otherwise as Either.
/* Result#ap :: Semigroup e
             => Result e a ~> Result e (a -> b) -> Result e b */
Err.prototype.ap = function (fns) {
  return fns.isErr ? err (concat (this.value) (fns.value)) : this;
};

Ok.prototype.ap = function (fns) {
  return fns.isErr ? fns : ok (fns.value (this.value));
};

// Errs join (the left one first); an Ok gives way to the other side.
/* Result#concat :: Semigroup e
                 => Result e a ~> Result e a -> Result e a */
Err.prototype.concat = function (other) {
  return other.isErr ? err (concat (other.value) (this.value)) : this;
};

Ok.prototype.concat = function (other) {
  return other;
};

// Result#show :: Result e a ~> () -> String
Err.prototype.show = function () {
  return "Err (" + show (this.value) + ")";
};

Ok.prototype.show = function () {
  return "Ok (" + show (this.value) + ")";
};

module.exports = Result;
