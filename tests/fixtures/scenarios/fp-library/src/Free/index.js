"use strict";

const chain = require ("../fl/chain");
const of = require ("../fl/of");
const reduce = require ("../fl/reduce");
const show = require ("../more/show");

// Free a — a program that yields `a` once interpreted.  It keeps one
// instruction and the operations applied to it (map, ap, chain, …), and
// replays them (`go`) in the monad the interpreter translates instructions
// into.  A program may mix instruction types (the interpreter chooses per
// instruction at runtime, see `dispatch`), so the instruction and the
// operation payloads are existential, typed `Any`; only the result type `a`
// is tracked, through the typed public API (`liftF`/`of`, the methods, `go`).

// Op :: (String, Any) -> Op
function Op(name, payload) {
  // Op#name :: Op ~> String
  this.name = name;
  // Op#payload :: Op ~> Any
  this.payload = payload;
}

// op :: String -> Any -> Op
function op(name) {
  return payload => new Op (name, payload);
}

// Free :: Functor m => (m a, [Op]) -> Free a
function Free(instruction, ops) {
  // Free#value :: Free a ~> Any
  this.value = instruction;
  // Free#calls :: Free a ~> [Op]
  this.calls = ops;
}

// program :: Functor m => m a -> [Op] -> Free a
function program(instruction) {
  return ops => new Free (instruction, ops);
}

// withOp :: Free a -> Op -> Free b
const withOp = prog => next => program (prog.value) (prog.calls.concat ([next]));

// An instruction yields its element when interpreted; a plain value (run
// through the interpreter's `of`) yields itself.  Overloads are tried in
// order: the instruction first.
// program.liftF :: Functor m => m a -> Free a
// program.liftF :: a -> Free a
// program.of :: Functor m => m a -> Free a
// program.of :: a -> Free a
program.liftF = Free.liftF = program.of = Free.of = function (instruction) {
  return program (instruction) ([]);
};

// program.name :: String
Object.defineProperty (program, "name", { value: "Free" });

// Free#@@type :: Free a ~> String
Free.prototype["@@type"] = "Free";

// Free#map :: Free a ~> (a -> b) -> Free b
Free.prototype.map = function (f) {
  return withOp (this) (op ("map") (f));
};

// Free#mapLeft :: Free a ~> (e -> c) -> Free a
Free.prototype.mapLeft = function (f) {
  return withOp (this) (op ("mapLeft") (f));
};

// Free#bimap :: Free a ~> (e -> c) -> (a -> b) -> Free b
Free.prototype.bimap = function (onLeft) {
  return onRight => withOp (this) (op ("bimap") ([onLeft, onRight]));
};

// Free#ap :: Free a ~> Free (a -> b) -> Free b
Free.prototype.ap = function (fns) {
  return withOp (this) (op ("ap") (fns));
};

// Free#chain :: Free a ~> (a -> Free b) -> Free b
Free.prototype.chain = function (f) {
  return withOp (this) (op ("chain") (f));
};

// The method `name` of a value, by its runtime name: its own, or one
// derived from `chain` and `of` when the monad lacks it.
// methodOf :: a -> String -> Any
const methodOf = target => name => {
  const own = target[name];
  return own ? own.bind (target) : derived[name] (target);
};

const derived = {
  map: target => f => chain (x => of (target.constructor) (f (x))) (target),
  ap: target => fns => chain (f => methodOf (target) ("map") (f)) (fns)
};

// Replays one operation.  The interpreter is a natural transformation
// (`forall x. m x -> u x`): the operations change the element type along
// the way, so it has to work for every element type; the explicit `forall`
// makes that checkable.
// replay :: (Functor m, Chainable u) => (forall x. m x -> u x) -> u Any -> Op -> u Any
const replay = interpret => current => next => {
  const method = methodOf (current) (next.name);
  switch (next.name) {
    case "ap": return method (next.payload.go (interpret));
    case "chain": return method (value => next.payload (value).go (interpret));
    case "bimap": return method (next.payload[0]) (next.payload[1]);
    default: return method (next.payload);
  }
};

// Free#go :: (Functor m, Chainable u) => Free a ~> (forall x. m x -> u x) -> u a
Free.prototype.go = function (interpret) {
  return reduce (replay (interpret)) (interpret (this.value)) (this.calls);
};

// Free#show :: Free a ~> () -> String
Free.prototype.show = function () {
  return "Free (" + show (this.value) + ") (" + show (this.calls) + ")";
};

module.exports = program;
