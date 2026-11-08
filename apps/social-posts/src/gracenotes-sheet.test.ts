import { strict as assert } from "node:assert";
import { test, before, after, beforeEach } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { createSection, reorderSections } from "./gracenotes/repo";
import { createIssue } from "./gracenotes/issues";
import { buildSheet } from "./gracenotes/sheet";
import { Actor, confirmPiece, dropPiece, editPiece, addItem, listPieces } from "./gracenotes/pieces";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const GN = "gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors";
const admin: Actor = { kind: "admin", email: "admin@example.org" };

before(async () => {
  await pool.query(SCHEMA_SQL);
  await pool.query(`DROP TABLE IF EXISTS ${GN}`);
  await pool.query(SCHEMA_SQL);
});
beforeEach(async () => { await pool.query(`TRUNCATE ${GN} CASCADE`); await pool.query("DELETE FROM events WHERE id LIKE 'gntest-%'"); });
after(async () => { await pool.query("DELETE FROM events WHERE id LIKE 'gntest-%'"); await pool.query(`DROP TABLE IF EXISTS ${GN}`); await pool.end(); });

async function sec(title: string, kind: "text" | "events" | "glance") {
  const r = await createSection(pool, { title, kind });
  assert.ok(r.ok);
  return (r as unknown as { value: { id: string } }).value.id;
}
async function issue(date: string) {
  const r = await createIssue(pool, date);
  assert.ok(r.ok);
  return (r as unknown as { value: { id: string } }).value.id;
}
async function piece(issueId: string, sectionId: string, o: Record<string, unknown> = {}) {
  const { rows } = await pool.query(
    `INSERT INTO gn_pieces (issue_id, section_id, title, body_html, details, status, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [issueId, sectionId, o.title ?? "", o.body ?? "", JSON.stringify(o.details ?? {}), o.status ?? "new", o.position ?? 0]);
  return rows[0].id as string;
}

test("sheet follows section order", async () => {
  const a = await sec("Alpha", "text");
  const b = await sec("Beta", "text");
  const c = await sec("Gamma", "glance");
  await reorderSections(pool, [c, a, b]);
  const i = await issue("2026-11-11");
  const sheet = await buildSheet(pool, i);
  assert.deepEqual(sheet.map((s) => s.title), ["Gamma", "Alpha", "Beta"]);
  assert.equal(sheet[1].sectionId, a);
});

async function twoWeeks() {
  const t = await sec("Pastor", "text");
  const e = await sec("Events", "events");
  const i1 = await issue("2026-11-04");
  const tp = (await listPieces(pool, i1)).find((p) => p.sectionId === t)!;
  assert.ok(tp);
  ok(await editPiece(pool, tp.id, { bodyHtml: "<p>Hello</p>" }, admin));
  const a = ok(await addItem(pool, i1, e, { title: "Supper" }, admin));
  const b = ok(await addItem(pool, i1, e, { title: "Choir" }, admin));
  const i2 = await issue("2026-11-11");
  return { t, e, i1, i2, a, b };
}
const ok = <T>(r: { ok: boolean }) => { assert.ok(r.ok, JSON.stringify(r)); return (r as unknown as { value: T }).value as any; };
const by = (s: Awaited<ReturnType<typeof buildSheet>>, id: string) => s.find((x) => x.sectionId === id)!;

test("untouched section is unchanged", async () => {
  const { t, e, i2 } = await twoWeeks();
  const s = await buildSheet(pool, i2);
  assert.equal(by(s, t).unchanged, true);
  assert.equal(by(s, e).unchanged, true);
  assert.ok(by(s, t).html.includes("Hello"));
  assert.equal(by(s, t).text, "Hello");
});

test("confirmed-but-same is unchanged", async () => {
  const { e, i2 } = await twoWeeks();
  for (const p of await listPieces(pool, i2)) ok(await confirmPiece(pool, p.id, admin));
  assert.equal(by(await buildSheet(pool, i2), e).unchanged, true);
});

test("edited item makes section changed", async () => {
  const { e, t, i2 } = await twoWeeks();
  const p = (await listPieces(pool, i2)).find((x) => x.sectionId === e)!;
  ok(await editPiece(pool, p.id, { bodyHtml: "<p>new</p>" }, admin));
  const s = await buildSheet(pool, i2);
  assert.equal(by(s, e).unchanged, false);
  assert.equal(by(s, t).unchanged, true);
});

test("dropped item makes section changed", async () => {
  const { e, i2 } = await twoWeeks();
  const p = (await listPieces(pool, i2)).find((x) => x.sectionId === e)!;
  ok(await dropPiece(pool, p.id, admin));
  const s = await buildSheet(pool, i2);
  assert.equal(by(s, e).unchanged, false);
  assert.ok(!by(s, e).html.includes(p.title));
});

test("added item makes section changed; first issue is changed", async () => {
  const { e, i1, i2 } = await twoWeeks();
  ok(await addItem(pool, i2, e, { title: "Extra" }, admin));
  assert.equal(by(await buildSheet(pool, i2), e).unchanged, false);
  assert.equal(by(await buildSheet(pool, i1), e).unchanged, false);
});

test("event block format", async () => {
  const e = await sec("Events", "events");
  const i = await issue("2026-11-11");
  await piece(i, e, {
    title: "Fall <Supper>", body: "<p>Come eat</p>",
    details: { when: "Sat Nov 7, 10:30am", place: "Mickler Hall", cost: "$25", link: "https://x", contact: "Eddie Rogers" },
  });
  const h = (await buildSheet(pool, i))[0].html;
  assert.ok(h.includes("<p><strong>Fall &lt;Supper&gt;</strong></p>"));
  assert.ok(h.includes("Sat Nov 7, 10:30am · Mickler Hall · $25"));
  assert.ok(h.includes(">Register here</a>"));
  assert.ok(h.includes("<p>Contact: Eddie Rogers</p>"));
});

test("event block omits empty parts and unsafe links", async () => {
  const e = await sec("Events", "events");
  const i = await issue("2026-11-11");
  await piece(i, e, { title: "A", details: { place: "Hall", link: "javascript:alert(1)", linkLabel: "Go" } });
  const h = (await buildSheet(pool, i))[0].html;
  assert.ok(h.includes("<p>Hall</p>"));
  assert.ok(!h.includes("javascript"));
  assert.ok(!h.includes("Contact"));
});

test("glance compares with previous issue", async () => {
  await sec("Glance", "glance");
  await pool.query("INSERT INTO events (id, name, start_date) VALUES ('gntest-g1','Picnic','2026-11-20')");
  const i1 = await issue("2026-11-04");
  const i2 = await issue("2026-11-11");
  const s = await buildSheet(pool, i2);
  assert.equal(s[0].unchanged, true);
  assert.ok(s[0].html.includes("Picnic"));
  await pool.query("INSERT INTO events (id, name, start_date) VALUES ('gntest-g2','Concert','2026-12-08')");
  assert.equal((await buildSheet(pool, i2))[0].unchanged, false);
  void i1;
});
