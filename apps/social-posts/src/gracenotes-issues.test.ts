import { strict as assert } from "node:assert";
import { test, before, after, beforeEach } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { createContributor, createSection, setSectionOwners, updateSection } from "./gracenotes/repo";
import { contributorStatus, createIssue, fillOpenIssues, currentIssue, glanceHtml, listIssues, nextIssueDate, pieceHash, pieceOwnerIds } from "./gracenotes/issues";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const GN = "gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors";
const EV = "gntest-%";

before(async () => {
  await pool.query(SCHEMA_SQL);
  await pool.query(`DROP TABLE IF EXISTS ${GN}`);
  await pool.query(SCHEMA_SQL);
});
beforeEach(async () => {
  await pool.query(`TRUNCATE ${GN} CASCADE`);
  await pool.query("DELETE FROM events WHERE id LIKE $1", [EV]);
});
after(async () => {
  await pool.query("DELETE FROM events WHERE id LIKE $1", [EV]);
  await pool.query(`DROP TABLE IF EXISTS ${GN}`);
  await pool.end();
});

async function sec(title: string, kind: "text" | "events" | "glance") {
  const r = await createSection(pool, { title, kind });
  assert.ok(r.ok);
  return (r as { ok: true; value: { id: string } }).value.id;
}
async function ev(id: string, name: string, start: string | null, end: string | null = null, archived = false) {
  await pool.query("INSERT INTO events (id, name, start_date, end_date, archived) VALUES ($1,$2,$3,$4,$5)", [`gntest-${id}`, name, start, end, archived]);
  return `gntest-${id}`;
}
async function piece(issueId: string, sectionId: string, o: Record<string, unknown> = {}) {
  const { rows } = await pool.query(
    `INSERT INTO gn_pieces (issue_id, section_id, contributor_id, event_id, title, body_html, details, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [issueId, sectionId, o.contributorId ?? null, o.eventId ?? null, o.title ?? "", o.body ?? "", JSON.stringify(o.details ?? {}), o.status ?? "confirmed"]);
  return rows[0].id as string;
}
async function issue(date: string) {
  const r = await createIssue(pool, date);
  assert.ok(r.ok);
  return (r as { ok: true; value: { id: string } }).value;
}

test("first issue gets empty text pieces", async () => {
  await sec("Pastor", "text"); await sec("Youth", "text"); await sec("Events", "events");
  const i = await issue("2026-11-04");
  const { rows } = await pool.query("SELECT status, body_html, carried_from FROM gn_pieces WHERE issue_id = $1", [i.id]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === "carried" && r.body_html === "" && r.carried_from === null));
});

test("carry copies and drops passed events", async () => {
  const text = await sec("Pastor", "text"); const items = await sec("Events", "events"); await sec("Glance", "glance");
  const old = await issue("2026-11-04");
  const past = await ev("past", "Past", "2026-11-07", "2026-11-07");
  const future = await ev("future", "Future", "2026-11-19");
  const t = await piece(old.id, text, { title: "Hi", body: "<p>Hello</p>" });
  await piece(old.id, items, { eventId: past, title: "Past" });
  const f = await piece(old.id, items, { eventId: future, title: "Future" });
  await piece(old.id, items, { title: "Gone", status: "dropped" });
  await piece(old.id, items, { title: "Undated" });
  const n = await issue("2026-11-11");
  const { rows } = await pool.query("SELECT * FROM gn_pieces WHERE issue_id = $1 AND title <> '' ORDER BY title", [n.id]);
  assert.deepEqual(rows.map((r) => r.title), ["Future", "Hi", "Undated"]);
  assert.ok(rows.every((r) => r.status === "carried"));
  assert.equal(rows.find((r) => r.title === "Hi").carried_from, t);
  assert.equal(rows.find((r) => r.title === "Future").carried_from, f);
  assert.equal(rows.find((r) => r.title === "Future").event_id, future);
});

test("carry drops unlinked items whose details.endDate has passed", async () => {
  const items = await sec("Events", "events");
  const old = await issue("2026-11-04");
  await piece(old.id, items, { title: "Old", details: { endDate: "2026-11-10" } });
  await piece(old.id, items, { title: "Live", details: { endDate: "2026-11-11" } });
  const n = await issue("2026-11-11");
  const { rows } = await pool.query("SELECT title FROM gn_pieces WHERE issue_id = $1", [n.id]);
  assert.deepEqual(rows.map((r) => r.title), ["Live"]);
});

test("duplicate issue refused", async () => {
  await issue("2026-11-11");
  const r = await createIssue(pool, "2026-11-11");
  assert.deepEqual(r, { ok: false, error: "There's already an issue for 2026-11-11." });
});

test("glance lists every dated event 4 weeks out", async () => {
  await ev("a", "Before", "2026-11-10"); await ev("b", "Start", "2026-11-11");
  await ev("c", "Last", "2026-12-08"); await ev("d", "After", "2026-12-09");
  await ev("e", "Archived", "2026-11-20", null, true);
  await ev("f", "Camp <b>", "2026-11-18", "2026-11-20"); await ev("g", "Undated", null);
  const html = await glanceHtml(pool, "2026-11-11");
  assert.equal(html,
    "<ul><li><strong>Wed Nov 11</strong> · Start</li>" +
    "<li><strong>Wed Nov 18 – Fri Nov 20</strong> · Camp &lt;b&gt;</li>" +
    "<li><strong>Tue Dec 8</strong> · Last</li></ul>");
});

test("status per contributor", async () => {
  const a = await createContributor(pool, { name: "Ann" }); const b = await createContributor(pool, { name: "Bob" });
  const c = await createContributor(pool, { name: "Cy" });
  assert.ok(a.ok && b.ok && c.ok); if (!a.ok || !b.ok || !c.ok) return;
  const text = await sec("Pastor", "text"); const items = await sec("Events", "events");
  await setSectionOwners(pool, text, [a.value.id]);
  const i = await issue("2026-11-11");
  await piece(i.id, items, { contributorId: b.value.id, status: "confirmed" });
  const st = await contributorStatus(pool, i.id);
  const by = (id: string) => st.find((s) => s.contributorId === id)!;
  assert.equal(by(a.value.id).state, "outstanding");
  assert.equal(by(a.value.id).pieces, 1);
  assert.equal(by(b.value.id).state, "confirmed");
  assert.equal(by(c.value.id).state, "none");
  assert.equal(by(c.value.id).lastReminder, null);
  const cur = await currentIssue(pool);
  assert.equal(cur?.id, i.id);
  assert.equal((await listIssues(pool)).length, 1);
});

test("pieceOwnerIds prefers the item owner", () => {
  const sections = [{ id: "s", title: "", kind: "text" as const, position: 0, retired: false, ownerIds: ["x", "y"] }];
  assert.deepEqual(pieceOwnerIds({ contributorId: "c", sectionId: "s" }, sections), ["c"]);
  assert.deepEqual(pieceOwnerIds({ contributorId: null, sectionId: "s" }, sections), ["x", "y"]);
});

test("pieceHash is stable and sensitive", () => {
  const p = { title: "t", bodyHtml: "b", details: { when: "x" }, imageUrl: "", eventId: null };
  assert.equal(pieceHash(p), pieceHash({ ...p }));
  assert.notEqual(pieceHash(p), pieceHash({ ...p, title: "u" }));
});

test("nextIssueDate", () => {
  assert.equal(nextIssueDate("2026-11-08", 3), "2026-11-11");
  assert.equal(nextIssueDate("2026-11-11", 3), "2026-11-18");
});

test("carry keeps an event-linked piece whose event has no dates", async () => {
  const items = await sec("Events", "events");
  const old = await issue("2026-11-04");
  const e = await ev("nodate", "Nodate", null);
  await piece(old.id, items, { eventId: e, title: "Nodate" });
  const n = await issue("2026-11-11");
  const { rows } = await pool.query("SELECT title FROM gn_pieces WHERE issue_id = $1", [n.id]);
  assert.deepEqual(rows.map((r) => r.title), ["Nodate"]);
});

test("carry does not throw on an impossible details.endDate", async () => {
  const items = await sec("Events", "events");
  const old = await issue("2026-11-04");
  await piece(old.id, items, { title: "Odd", details: { endDate: "2026-02-31" } });
  const n = await issue("2026-11-11");
  const { rows } = await pool.query("SELECT title FROM gn_pieces WHERE issue_id = $1", [n.id]);
  assert.deepEqual(rows.map((r) => r.title), []);
});

test("a text section added after an issue opens is filled into open issues only", async () => {
  const sentR = await createIssue(pool, "2026-11-04");
  assert.ok(sentR.ok);
  await pool.query("UPDATE gn_issues SET status='sent' WHERE id=$1", [sentR.value.id]);
  const openR = await createIssue(pool, "2026-11-11");
  assert.ok(openR.ok);
  const letter = await sec("Pastor Message", "text");
  await sec("Missions", "events");
  await sec("Grace at a Glance", "glance");
  const added = await fillOpenIssues(pool);
  assert.equal(added, 1);
  const open = await pool.query("SELECT section_id, status FROM gn_pieces WHERE issue_id=$1", [openR.value.id]);
  assert.deepEqual(open.rows, [{ section_id: letter, status: "carried" }]);
  const sent = await pool.query("SELECT 1 FROM gn_pieces WHERE issue_id=$1", [sentR.value.id]);
  assert.equal(sent.rows.length, 0);
  assert.equal(await fillOpenIssues(pool), 0, "running again adds nothing");
  const retired = await updateSection(pool, letter, { retired: true });
  assert.ok(retired.ok);
  const other = await sec("Prayer List", "text");
  assert.equal(await fillOpenIssues(pool), 1);
  const after = await pool.query("SELECT section_id FROM gn_pieces WHERE issue_id=$1 ORDER BY section_id", [openR.value.id]);
  assert.deepEqual(after.rows.map((r) => r.section_id).sort(), [letter, other].sort());
});
