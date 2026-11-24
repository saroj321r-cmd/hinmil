"use strict";

const show = require ("../more/show");

// One step of a loop driven by `chainRec`: either finished with a result
// (Done) or continuing with a new seed (Next).
// Step :: Done b | Next a
function Step() {
  throw new TypeError ("Step is abstract: use Step.Done or Step.Next");
}

// Done :: b -> Step b a
function Done(value) {
  // Step#value :: Step b a ~> (b | a)
  this.value = value;
}

// Next :: a -> Step b a
function Next(value) {
  this.value = value;
}

Done.prototype = Object.create (Step.prototype);
Next.prototype = Object.create (Step.prototype);

// done :: b -> Step b a
function done(value) {
  return new Done (value);
}

// next :: a -> Step b a
function next(value) {
  return new Next (value);
}

// done.name :: String
Object.defineProperty (done, "name", { value: "Done" });

// next.name :: String
Object.defineProperty (next, "name", { value: "Next" });

// Step.Done :: b -> Step b a
Step.Done = done;

// Step.Next :: a -> Step b a
Step.Next = next;

// Step#@@type ::Step b a ~> String
Done.prototype["@@type"] = "Step";
Next.prototype["@@type"] = "Step";

// Step#@@tag :: Step b a ~> String
Done.prototype["@@tag"] = "Done";
Next.prototype["@@tag"] = "Next";

// Step#isDone :: Step b a ~> Boolean
Done.prototype.isDone = true;
Next.prototype.isDone = false;

// Step#isNext :: Step b a ~> Boolean
Done.prototype.isNext = false;
Next.prototype.isNext = true;

// Step#show :: Step b a ~> () -> String
Done.prototype.show = function () {
  return "Done (" + show (this.value) + ")";
};

Next.prototype.show = function () {
  return "Next (" + show (this.value) + ")";
};

module.exports = Step;
