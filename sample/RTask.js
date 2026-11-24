// A lazy task that reads an environment, then fails or succeeds.  Callable
// with or without `new`; its prototype is an object literal that points at
// named functions, called `Type$prototype$method` so that the `Type#method`
// annotation above each one applies (all forms this sample exercises).

const TYPE_NAME = "RTask";

// RTask :: ((e -> (), a -> (), r) -> *) -> RTask r e a
function RTask(fork) {
  if (!(this instanceof RTask)) return new RTask (fork);

  // RTask#fork :: RTask r e a ~> (e -> (), a -> (), r) -> *
  this.fork = fork;
}

// cancelOf :: a -> (() -> ())
const cancelOf = returned => (typeof returned === "function" ? returned : () => {});

RTask.prototype = {
  constructor: RTask,
  "@@type": TYPE_NAME,
  map: RTask$prototype$map
};

// RTask#map :: RTask r e a ~> (a -> b) -> RTask r e b
function RTask$prototype$map(f) {
  const source = this;
  return new RTask ((reject, resolve, env) => {
    let stopped = false;
    const stopSource = cancelOf (source.fork (
      failure => { if (!stopped) reject (failure); },
      value => { if (!stopped) resolve (f (value)); },
      env
    ));
    return () => {
      stopped = true;
      stopSource ();
    };
  });
}

// The promise function runs on the next tick after the fork; a cancel
// before it settles ignores the outcome.
// fromPromise :: (* -> Promise e a) -> * -> RTask r e a
export const fromPromise = RTask.fromPromise = function (start) {
  return (...input) => new RTask ((reject, resolve, _env) => {
    let stopped = false;
    Promise.resolve ()
      .then (() => start (...input))
      .then (value => { if (!stopped) resolve (value); }, failure => { if (!stopped) reject (failure); });
    return () => { stopped = true; };
  });
};

export default RTask;
