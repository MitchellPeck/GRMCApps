import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import {
  contributorByToken, createContributor, createSection, listContributors, listSections,
  reorderSections, retireContributor, setSectionOwners,
} from "./gracenotes/repo";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

before(async () => {
  await pool.query("DROP TABLE IF EXISTS gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors");
  await pool.query(SCHEMA_SQL);
});

after(async () => {
  await pool.query("DROP TABLE IF EXISTS gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors");
  await pool.end();
});

test("contributor gets a long token", async () => {
  const a = await createContributor(pool, { name: "Ann", email: "a@x.org" });
  const b = await createContributor(pool, { name: "Bob", email: "" });
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.ok(a.value.token.length >= 32);
  assert.notEqual(a.value.token, b.value.token);
});

test("retire kills the link", async () => {
  const c = await createContributor(pool, { name: "Cy", email: "" });
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.equal((await contributorByToken(pool, c.value.token))?.id, c.value.id);
  const r = await retireContributor(pool, c.value.id);
  assert.ok(r.ok);
  assert.equal(await contributorByToken(pool, c.value.token), null);
  const stored = (await listContributors(pool)).find((x) => x.id === c.value.id);
  assert.ok(stored?.retired);
  assert.notEqual(stored?.token, c.value.token);
});

test("sections keep order and owners", async () => {
  const mk = async (title: string) => {
    const r = await createSection(pool, { title, kind: "text" });
    assert.ok(r.ok);
    return (r as { ok: true; value: { id: string } }).value.id;
  };
  const A = await mk("A"), B = await mk("B"), C = await mk("C");
  const o = await createContributor(pool, { name: "Owner", email: "" });
  assert.ok(o.ok);
  if (!o.ok) return;
  assert.ok((await reorderSections(pool, [C, A, B])).ok);
  assert.ok((await setSectionOwners(pool, A, [o.value.id])).ok);
  const list = await listSections(pool);
  const ours = list.filter((s) => [A, B, C].includes(s.id));
  assert.deepEqual(ours.map((s) => s.title), ["C", "A", "B"]);
  assert.deepEqual(ours[1].ownerIds, [o.value.id]);
});

test("partial reorder keeps the rest after; unknown ids fail", async () => {
  await pool.query("DELETE FROM gn_sections");
  const ids: string[] = [];
  for (const t of ["A", "B", "C", "D"]) {
    const r = await createSection(pool, { title: t, kind: "text" });
    assert.ok(r.ok);
    if (r.ok) ids.push(r.value.id);
  }
  const [A, B, C, D] = ids;
  assert.ok((await reorderSections(pool, [C, C])).ok);
  assert.deepEqual((await listSections(pool)).map((s) => s.title), ["C", "A", "B", "D"]);
  assert.deepEqual((await listSections(pool)).map((s) => s.position), [0, 1, 2, 3]);
  const bad = await reorderSections(pool, [D, "nope"]);
  assert.equal(bad.ok, false);
  assert.deepEqual((await listSections(pool)).map((s) => s.title), ["C", "A", "B", "D"]);
  void A; void B;
});

test("owners must exist and not be retired", async () => {
  const s = await createSection(pool, { title: "S", kind: "text" });
  const c = await createContributor(pool, { name: "Gone", email: "" });
  assert.ok(s.ok && c.ok);
  if (!s.ok || !c.ok) return;
  await retireContributor(pool, c.value.id);
  const r = await setSectionOwners(pool, s.value.id, [c.value.id]);
  assert.deepEqual(r, { ok: false, error: "That person has been retired." });
});

test("contributor needs a name", async () => {
  const r = await createContributor(pool, { name: "  ", email: "" });
  assert.equal(r.ok, false);
});

test("schema is rerunnable", async () => {
  await pool.query(SCHEMA_SQL);
  await pool.query(SCHEMA_SQL);
});
