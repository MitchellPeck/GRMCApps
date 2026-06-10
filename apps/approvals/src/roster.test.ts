import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { addRosterEntry, listRoster, setRosterActive } from "./roster";

const url = process.env.TEST_DATABASE_URL;

test("roster add (unique + reactivate), list, toggle", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await pool.query("DELETE FROM roster");

  const a = await addRosterEntry(pool, "Pastor Dale", "dale@x.com");
  assert.ok(a.ok);

  // duplicate email updates name + reactivates rather than erroring
  const dup = await addRosterEntry(pool, "Dale R", "dale@x.com");
  assert.ok(dup.ok);

  const all = await listRoster(pool, true);
  assert.equal(all.length, 1);
  assert.equal(all[0].name, "Dale R");
  assert.equal(all[0].active, true);

  await setRosterActive(pool, all[0].id, false);
  const activeOnly = await listRoster(pool, false);
  assert.equal(activeOnly.length, 0);
  const withInactive = await listRoster(pool, true);
  assert.equal(withInactive.length, 1);
  assert.equal(withInactive[0].active, false);

  await pool.query("DELETE FROM roster");
  await pool.end();
});
