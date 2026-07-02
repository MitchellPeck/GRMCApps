import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { addPerson, updatePerson, listPeople, setPersonActive } from "./people";

const url = process.env.TEST_DATABASE_URL;

test("people add (dedup by email + reactivate), update, list, toggle", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await pool.query("DELETE FROM people");

  const a = await addPerson(pool, "Pastor Dale", "dale@x.com", "Pastor");
  assert.ok(a.ok);

  // No-email person is always a new row.
  const noEmail = await addPerson(pool, "Guest", "", "");
  assert.ok(noEmail.ok);

  // Duplicate email updates name/title + reactivates.
  const dup = await addPerson(pool, "Dale R", "dale@x.com", "Lead Pastor");
  assert.ok(dup.ok);
  assert.equal((dup as any).id, (a as any).id);

  let all = await listPeople(pool, true);
  assert.equal(all.length, 2);
  const dale = all.filter((p) => p.email === "dale@x.com")[0];
  assert.equal(dale.name, "Dale R");
  assert.equal(dale.title, "Lead Pastor");

  const upd = await updatePerson(pool, dale.id, "Dale Roberts", "dale@x.com", "Senior Pastor");
  assert.ok(upd.ok);
  all = await listPeople(pool, true);
  assert.equal(all.filter((p) => p.id === dale.id)[0].name, "Dale Roberts");

  await setPersonActive(pool, dale.id, false);
  assert.equal((await listPeople(pool, false)).filter((p) => p.id === dale.id).length, 0);
  assert.equal((await listPeople(pool, true)).filter((p) => p.id === dale.id).length, 1);

  await pool.query("DELETE FROM people");
  await pool.end();
});

test("addPerson validates name and email", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  const noName = await addPerson(pool, "  ", "a@b.com", "");
  assert.equal(noName.ok, false);
  const badEmail = await addPerson(pool, "X", "not-an-email", "");
  assert.equal(badEmail.ok, false);
  await pool.end();
});
