import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { addPerson, updatePerson, listPeople, setPersonActive, peopleNamedIn, matchPersonByName, Person } from "./people";

const url = process.env.TEST_DATABASE_URL;

test("peopleNamedIn matches library names as whole words", () => {
  const people: Person[] = [
    { id: 1, name: "Alice", email: "", title: "", active: true },
    { id: 2, name: "Bob", email: "", title: "", active: true },
    { id: 3, name: "Pastor Dale", email: "", title: "", active: true },
    { id: 4, name: "Al", email: "", title: "", active: true },
  ];
  // owner + task text
  assert.deepEqual(peopleNamedIn("Bob to pull the Q2 numbers", people).sort(), [2]);
  assert.deepEqual(peopleNamedIn("Pastor Dale will open in prayer", people).sort(), [3]);
  // multiple names
  assert.deepEqual(peopleNamedIn("Alice and Bob to coordinate", people).sort(), [1, 2]);
  // substring must NOT match (Alice should not hit on "Malice"; Al not in "false")
  assert.deepEqual(peopleNamedIn("There was no malice; it was false", people), []);
  // case-insensitive
  assert.deepEqual(peopleNamedIn("bob follows up", people), [2]);
  // no match
  assert.deepEqual(peopleNamedIn("Unassigned to review", people), []);
});

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

const person = (id: number, name: string): Person =>
  ({ id, name, email: "", title: "", active: true });

test("matchPersonByName matches a full name case-insensitively", () => {
  const people = [person(1, "Jane Doe"), person(2, "Bob Jones")];
  assert.equal(matchPersonByName("jane doe", people), 1);
  assert.equal(matchPersonByName("  Jane Doe  ", people), 1);
});

test("matchPersonByName falls back to a unique last name", () => {
  const people = [person(1, "Jane Doe"), person(2, "Bob Jones")];
  assert.equal(matchPersonByName("Doe", people), 1);
});

test("matchPersonByName falls back to a unique first name", () => {
  const people = [person(1, "Jane Doe"), person(2, "Bob Jones")];
  assert.equal(matchPersonByName("Bob", people), 2);
});

test("matchPersonByName refuses an ambiguous last name", () => {
  const people = [person(1, "Jane Doe"), person(2, "John Doe")];
  assert.equal(matchPersonByName("Doe", people), null);
});

test("matchPersonByName refuses an ambiguous first name", () => {
  const people = [person(1, "Jane Doe"), person(2, "Jane Smith")];
  assert.equal(matchPersonByName("Jane", people), null);
});

test("matchPersonByName returns null for unknown, blank, and one-character names", () => {
  const people = [person(1, "Jane Doe")];
  assert.equal(matchPersonByName("Carlos Vega", people), null);
  assert.equal(matchPersonByName("   ", people), null);
  assert.equal(matchPersonByName("J", people), null);
  assert.equal(matchPersonByName("Jane Doe", []), null);
});

test("matchPersonByName finds a full name embedded in a longer phrase", () => {
  const people = [person(1, "Jane Doe")];
  assert.equal(matchPersonByName("Treasurer Jane Doe", people), 1);
});

test("updatePerson can set active and leaves it alone when omitted", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await pool.query("DELETE FROM people");

  const added = await addPerson(pool, "Jane Doe", "jane@x.com", "Treasurer");
  assert.ok(added.ok);
  const id = (added as { ok: true; id: number }).id;

  await updatePerson(pool, id, "Jane Doe", "jane@x.com", "Chair", false);
  let found = (await listPeople(pool, true)).find((p) => p.id === id)!;
  assert.equal(found.title, "Chair");
  assert.equal(found.active, false);

  // Omitting `active` must preserve the stored value.
  await updatePerson(pool, id, "Jane R Doe", "jane@x.com", "Chair");
  found = (await listPeople(pool, true)).find((p) => p.id === id)!;
  assert.equal(found.name, "Jane R Doe");
  assert.equal(found.active, false);

  // Explicitly setting active back to true must also stick.
  await updatePerson(pool, id, "Jane R Doe", "jane@x.com", "Chair", true);
  found = (await listPeople(pool, true)).find((p) => p.id === id)!;
  assert.equal(found.active, true);

  // Omitting `active` again must preserve `true` too — a naive implementation
  // that forces active to false on every omission would fail this leg.
  await updatePerson(pool, id, "Jane R Doe", "jane@x.com", "Moderator");
  found = (await listPeople(pool, true)).find((p) => p.id === id)!;
  assert.equal(found.title, "Moderator");
  assert.equal(found.active, true);

  await pool.query("DELETE FROM people");
  await pool.end();
});
