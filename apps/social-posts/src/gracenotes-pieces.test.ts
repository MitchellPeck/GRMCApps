import { strict as assert } from "node:assert";
import { test, before, after, beforeEach } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { createContributor, createSection, setSectionOwners } from "./gracenotes/repo";
import { createIssue, pieceHash } from "./gracenotes/issues";
import { Contributor } from "./gracenotes/types";
import {
  Actor, addItem, canTouch, confirmPiece, contributorView, dropPiece, editPiece, effectiveImage, getPiece, linkEvent,
} from "./gracenotes/pieces";
import { clearEventReview, getEvent, setEventImage } from "./pipeline/repo";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const GN = "gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors";
const created: string[] = [];
const admin: Actor = { kind: "admin", email: "admin@example.org" };

before(async () => {
  await pool.query(SCHEMA_SQL);
  await pool.query(`DROP TABLE IF EXISTS ${GN}`);
  await pool.query(SCHEMA_SQL);
});
async function cleanEvents() {
  await pool.query("DELETE FROM events WHERE id = ANY($1) OR id LIKE 'gntest-%'", [created]);
  created.length = 0;
}
beforeEach(async () => { await pool.query(`TRUNCATE ${GN} CASCADE`); await cleanEvents(); });
after(async () => { await cleanEvents(); await pool.query(`DROP TABLE IF EXISTS ${GN}`); await pool.end(); });

async function sec(title: string, kind: "text" | "events" | "glance") {
  const r = await createSection(pool, { title, kind });
  assert.ok(r.ok);
  return (r as { ok: true; value: { id: string } }).value.id;
}
async function person(name: string, email: string): Promise<Contributor> {
  const r = await createContributor(pool, { name, email });
  assert.ok(r.ok);
  return (r as { ok: true; value: Contributor }).value;
}
async function issue(date: string) {
  const r = await createIssue(pool, date);
  assert.ok(r.ok);
  return (r as { ok: true; value: { id: string } }).value;
}
async function ev(id: string, name: string, start: string | null, end: string | null = null) {
  await pool.query("INSERT INTO events (id, name, start_date, end_date) VALUES ($1,$2,$3,$4)", [`gntest-${id}`, name, start, end]);
  return `gntest-${id}`;
}
async function piece(issueId: string, sectionId: string, o: Record<string, unknown> = {}) {
  const { rows } = await pool.query(
    `INSERT INTO gn_pieces (issue_id, section_id, contributor_id, event_id, title, body_html, status, carried_from, content_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [issueId, sectionId, o.contributorId ?? null, o.eventId ?? null, o.title ?? "", o.body ?? "", o.status ?? "carried", o.carriedFrom ?? null, ""]);
  return rows[0].id as string;
}
const ok = <T>(r: { ok: boolean }) => { assert.ok(r.ok, JSON.stringify(r)); return (r as unknown as { value: T }).value; };
const note = async (id: string) => (await pool.query("SELECT review_note FROM events WHERE id = $1", [id])).rows[0].review_note as string;

test("edit unchanged stays confirmed", async () => {
  const items = await sec("Events", "events");
  const eddie = await person("Eddie Rogers", "e@x.org");
  const old = await issue("2026-11-04");
  await piece(old.id, items, { contributorId: eddie.id, title: "Sign up", body: "<p>Hello</p>", status: "confirmed" });
  const cur = await issue("2026-11-11");
  const id = (await pool.query("SELECT id FROM gn_pieces WHERE issue_id=$1", [cur.id])).rows[0].id;
  const r = ok<{ status: string }>(await editPiece(pool, id, { title: "Sign up", bodyHtml: "<p>Hello</p>" }, { kind: "contributor", contributor: eddie }));
  assert.equal(r.status, "confirmed");
  const r2 = ok<{ status: string }>(await editPiece(pool, id, { bodyHtml: "<p>Hello there</p>" }, { kind: "contributor", contributor: eddie }));
  assert.equal(r2.status, "changed");
});

test("edit changed marks event", async () => {
  const items = await sec("Events", "events");
  const women = await person("Women of Grace", "w@x.org");
  const e = await ev("a", "Brunch", "2026-11-20");
  const i0 = await issue("2026-11-04");
  const src = await piece(i0.id, items, { contributorId: women.id, eventId: e, title: "Brunch", status: "confirmed" });
  await pool.query("UPDATE gn_pieces SET content_hash = $2 WHERE id = $1", [src, pieceHash({ title: "Brunch", bodyHtml: "", details: {}, imageUrl: "", eventId: e })]);
  const i1 = await issue("2026-11-11");
  const cur = (await pool.query("SELECT id FROM gn_pieces WHERE issue_id=$1", [i1.id])).rows[0].id;
  const r = ok<{ status: string }>(await editPiece(pool, cur, { title: "Spring Brunch", startDate: "2026-11-21", imageUrl: "/img/b.png" }, { kind: "contributor", contributor: women }));
  assert.equal(r.status, "changed");
  const row = (await pool.query("SELECT name, to_char(start_date,'YYYY-MM-DD') s, image_url, review_note FROM events WHERE id=$1", [e])).rows[0];
  assert.equal(row.name, "Spring Brunch");
  assert.equal(row.s, "2026-11-21");
  assert.equal(row.image_url, "/img/b.png");
  assert.equal(row.review_note, "Changed by Women of Grace");
  assert.equal(effectiveImage((await getPiece(pool, cur))!), "/img/b.png");
});

test("admin edit leaves no marker", async () => {
  const items = await sec("Events", "events");
  const women = await person("Women of Grace", "w@x.org");
  const e = await ev("b", "Brunch", "2026-11-20");
  const i = await issue("2026-11-04");
  const p = await piece(i.id, items, { contributorId: women.id, eventId: e, title: "Brunch", status: "confirmed" });
  ok(await editPiece(pool, p, { title: "Brunch 2" }, admin));
  assert.equal(await note(e), "");
});

test("add item with date creates event", async () => {
  const items = await sec("Events", "events");
  const eddie = await person("Eddie Rogers", "eddie@x.org");
  const i = await issue("2026-11-04");
  const p = ok<{ id: string; status: string; eventId: string }>(
    await addItem(pool, i.id, items, { title: "Fall Fest", startDate: "2026-11-19" }, { kind: "contributor", contributor: eddie }));
  created.push(p.eventId);
  assert.equal(p.status, "new");
  const row = (await pool.query("SELECT name, owner_email, kind, review_note FROM events WHERE id=$1", [p.eventId])).rows[0];
  assert.deepEqual(row, { name: "Fall Fest", owner_email: "eddie@x.org", kind: "event", review_note: "New from Eddie Rogers" });
  const g = await getEvent(pool, p.eventId);
  assert.ok(g.ok);
});

test("add item without date makes no event; text section refused", async () => {
  const items = await sec("Events", "events");
  const text = await sec("Pastor", "text");
  const i = await issue("2026-11-04");
  const p = ok<{ eventId: string | null; contributorId: string | null }>(await addItem(pool, i.id, items, { title: "Sign up sheet" }, admin));
  assert.equal(p.eventId, null);
  assert.equal(p.contributorId, null);
  const bad = await addItem(pool, i.id, text, { title: "x" }, admin);
  assert.equal(bad.ok, false);
});

test("editing an unlinked item with a date creates and links an event", async () => {
  const items = await sec("Events", "events");
  const eddie = await person("Eddie Rogers", "eddie@x.org");
  const i = await issue("2026-11-04");
  const a: Actor = { kind: "contributor", contributor: eddie };
  const p = ok<{ id: string }>(await addItem(pool, i.id, items, { title: "Potluck" }, a));
  const r = ok<{ eventId: string }>(await editPiece(pool, p.id, { startDate: "2026-12-01" }, a));
  created.push(r.eventId);
  assert.ok(r.eventId);
  assert.equal(await note(r.eventId), "New from Eddie Rogers");
});

test("bad dates rejected and nothing written", async () => {
  const items = await sec("Events", "events");
  const i = await issue("2026-11-04");
  const r = await addItem(pool, i.id, items, { title: "X", startDate: "2026-02-31" }, admin);
  assert.deepEqual(r, { ok: false, error: "Use a real date like 2026-11-19." });
  const n = (await pool.query("SELECT count(*)::int c FROM gn_pieces WHERE issue_id=$1", [i.id])).rows[0].c;
  assert.equal(n, 0);
  const p = ok<{ id: string }>(await addItem(pool, i.id, items, { title: "Y" }, admin));
  const r2 = await editPiece(pool, p.id, { endDate: "nope" }, admin);
  assert.equal(r2.ok, false);
});

test("not yours", async () => {
  const items = await sec("Events", "events");
  const a = await person("A", "a@x.org"); const b = await person("B", "b@x.org");
  const i = await issue("2026-11-04");
  const p = await piece(i.id, items, { contributorId: a.id, title: "Mine" });
  const bActor: Actor = { kind: "contributor", contributor: b };
  for (const r of [await confirmPiece(pool, p, bActor), await editPiece(pool, p, { title: "x" }, bActor), await dropPiece(pool, p, bActor)]) {
    assert.deepEqual(r, { ok: false, error: "That piece isn't yours." });
  }
  const pc = (await getPiece(pool, p))!;
  assert.equal(canTouch(pc, bActor, []), false);
  assert.equal(canTouch(pc, admin, []), true);
  assert.equal(canTouch(pc, { kind: "contributor", contributor: a }, []), true);
});

test("confirm and drop an item; cannot drop text", async () => {
  const items = await sec("Events", "events");
  const text = await sec("Pastor", "text");
  const a = await person("A", "a@x.org");
  await setSectionOwners(pool, text, [a.id]);
  const i = await issue("2026-11-04");
  const act: Actor = { kind: "contributor", contributor: a };
  const it = await piece(i.id, items, { contributorId: a.id, title: "Mine" });
  assert.equal(ok<{ status: string }>(await confirmPiece(pool, it, act)).status, "confirmed");
  assert.equal(ok<{ status: string }>(await dropPiece(pool, it, act)).status, "dropped");
  const tp = (await pool.query("SELECT id FROM gn_pieces WHERE section_id=$1", [text])).rows[0].id;
  assert.deepEqual(await dropPiece(pool, tp, act), { ok: false, error: "Text sections can't be dropped; clear the text instead." });
});

test("linkEvent and event helpers", async () => {
  const items = await sec("Events", "events");
  const i = await issue("2026-11-04");
  const e = await ev("l", "Linked", "2026-11-20");
  const p = await piece(i.id, items, { title: "Linked" });
  const r = ok<{ eventId: string }>(await linkEvent(pool, p, e));
  assert.equal(r.eventId, e);
  assert.equal((await linkEvent(pool, p, "gntest-nope")).ok, false);
  await pool.query("UPDATE events SET review_note='x' WHERE id=$1", [e]);
  await clearEventReview(pool, e);
  assert.equal(await note(e), "");
  await setEventImage(pool, e, "/i.png");
  const g = await getEvent(pool, e);
  assert.ok(g.ok);
  assert.equal((g as unknown as { value: { event: { imageUrl: string } } }).value.event.imageUrl, "/i.png");
});

test("contributor view with no pieces", async () => {
  const items = await sec("Events", "events");
  const a = await person("A", "a@x.org");
  const old = await issue("2026-11-04");
  await piece(old.id, items, { contributorId: a.id, title: "Done thing", body: "<p>x</p>", status: "confirmed" });
  await piece(old.id, items, { contributorId: a.id, title: "Dropped thing", status: "dropped" });
  const cur = await issue("2026-11-11");
  await pool.query("DELETE FROM gn_pieces WHERE issue_id=$1", [cur.id]);
  const v = await contributorView(pool, a);
  assert.deepEqual(v.pieces, []);
  assert.equal(v.issue?.id, cur.id);
  assert.equal(v.issue?.issueDate, "2026-11-11");
  assert.deepEqual(v.history.map((h: { title: string }) => h.title), ["Done thing"]);
  assert.deepEqual(v.sections.map((s: { title: string }) => s.title), ["Events"]);
});

test("view is private", async () => {
  const items = await sec("Events", "events");
  const text = await sec("Pastor", "text");
  const secret = await sec("Youth", "text");
  const a = await person("Alpha Person", "alpha@x.org");
  const b = await person("Bravo Person", "bravo@x.org");
  await setSectionOwners(pool, text, [a.id]);
  await setSectionOwners(pool, secret, [b.id]);
  const old = await issue("2026-11-04");
  await piece(old.id, items, { contributorId: b.id, title: "BravoOnlyTitle", status: "confirmed" });
  const cur = await issue("2026-11-11");
  await piece(cur.id, items, { contributorId: a.id, title: "Alpha item" });
  await piece(cur.id, items, { contributorId: b.id, title: "BravoSecret item" });
  await pool.query("UPDATE gn_pieces SET updated_by='Bravo Person' WHERE issue_id=$1", [cur.id]);
  const json = JSON.stringify(await contributorView(pool, a));
  for (const s of ["Bravo", "bravo@x.org", b.token, a.token, "Youth", "Alpha item"].filter((x) => x !== "Alpha item")) {
    assert.ok(!json.includes(s), `leaked ${s}`);
  }
  assert.ok(json.includes("Alpha item"));
  assert.ok(!json.includes("token"));
});
