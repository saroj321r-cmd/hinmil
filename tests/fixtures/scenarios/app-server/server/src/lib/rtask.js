// Adapter between promise-based sources (SqlKit queries, pg) and fpkit's
// RTask.  It lives in the application, not in the query builder.  RTask's
// fork takes its arguments as a tuple: fork (reject, resolve, env).
// A subpath import: only the RTask module is loaded.  Its types come straight
// from fpkit's inline `::` annotations.
import RTask from "fpkit/RTask";

// Lazy: the promise function only runs when the task is forked, and a
// cancel before it settles ignores the outcome.
// fromPromiseFn :: (a -> Promise e b) -> a -> RTask r e b
export const fromPromiseFn = RTask.fromPromise;

// Wraps a promise that is already running (eager: it exists already).
// promiseToRTask :: Promise e a -> RTask r e a
export const promiseToRTask = p => RTask.fromPromise (_x => p) (undefined);

// Runs a promise function with the task's environment as its argument, so a
// service can read the database handle or configuration from it.
// withEnv :: (r -> Promise e a) -> RTask r e a
export const withEnv = fn => RTask.ask ().chain (env => RTask.fromPromise (fn) (env));

// A task run as a promise, for the edges of the system (handlers, tests).
// forkToPromise :: r -> RTask r e a -> Promise e a
export const forkToPromise = env => task =>
  new Promise ((res, rej) => task.fork (rej, res, env));
