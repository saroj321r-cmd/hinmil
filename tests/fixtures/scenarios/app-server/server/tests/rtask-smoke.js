// Smoke test of the promise/RTask adapter against the sample database.
// Run: `npx babel-node tests/rtask-smoke.js` from server/.
import { ok, strictEqual } from "assert";
import { forkToPromise, fromPromiseFn, promiseToRTask, withEnv } from "../src/lib/rtask";
import { end } from "./company/db";
import { selectMembers } from "./company/members";

// run :: () -> Promise e ()
const run = async () => {
  try {
    // fromPromiseFn: a lazy wrapper around a SqlKit query
    const membersTask = fromPromiseFn (selectMembers) ({ limit: 3, offset: 0 });
    const members = await forkToPromise (undefined) (membersTask);
    strictEqual (members.length, 3, "verwacht 3 spelers (limit)");
    ok (members[0].id != null, "speler heeft id");

    // withEnv: query parameters read from the environment
    const envTask = withEnv (env => selectMembers (env.memberParams));
    const fromEnv = await forkToPromise ({ memberParams: { limit: 2, offset: 0 } }) (envTask);
    strictEqual (fromEnv.length, 2, "withEnv geeft environment door");

    // map and chain over a real query
    const firstNameTask = fromPromiseFn (selectMembers) ({ limit: 1, offset: 0 })
      .map (rows => rows[0].firstName);
    const firstName = await forkToPromise (undefined) (firstNameTask);
    ok (typeof firstName === "string", "map over queryresultaat werkt");

    // promiseToRTask: wraps a running promise
    const wrapped = await forkToPromise (undefined) (promiseToRTask (selectMembers ({ limit: 1, offset: 0 })));
    strictEqual (wrapped.length, 1, "promiseToRTask wikkelt een lopende promise");

    // a failing promise rejects the task
    const failing = fromPromiseFn (_x => Promise.reject (new Error ("boem"))) (undefined);
    const settled = await forkToPromise (undefined) (failing).then (
      _v => "resolved",
      e => "rejected: " + e.message
    );
    strictEqual (settled, "rejected: boem", "rejection propageert");

    console.log ("rtask-smoke OK");
  } catch (e) {
    console.error ("rtask-smoke FAALT:", e.message);
    process.exitCode = 1;
  } finally {
    await end ();
  }
};

run ();
