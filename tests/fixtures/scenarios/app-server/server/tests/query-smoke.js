// ::types sqlkit
// Smoke test: runs the sample queries against the sample database.
// Run: `npx babel-node tests/query-smoke.js` from server/.
import { ok, strictEqual } from "assert";
import { end } from "./company/db";
import { selectMembers, selectMemberById, memberByIdOrdered } from "./company/members";

// run :: () -> Promise e ()
const run = async () => {
  try {
    const members = await selectMembers ({ limit: 3, offset: 0 });
    strictEqual (members.length, 3, "verwacht 3 spelers (limit)");
    ok (members[0].id != null, "speler heeft id");
    ok (typeof members[0].firstName === "string", "speler heeft firstName");
    ok (members[0].department && members[0].department.name, "geneste department-relatie aanwezig");

    const [member] = await selectMemberById ({ memberId: members[0].id });
    strictEqual (member.id, members[0].id, "eq-filter werkt");

    const [ordered] = await memberByIdOrdered ({ memberId: members[0].id });
    strictEqual (ordered.id, members[0].id, "concat-tag draait");

    console.log ("query-smoke OK");
  } catch (e) {
    console.error ("query-smoke FAALT:", e.message);
    process.exitCode = 1;
  } finally {
    await end ();
  }
};

run ();
