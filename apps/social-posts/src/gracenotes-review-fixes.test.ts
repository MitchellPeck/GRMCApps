// The fixes from the Nov 2026 Grace Notes review: stale saves, multi-day dates, retiring with a handover,
// duplicate text pieces, the next issue opening at Mark sent, kept letter edits, and log redaction.
import { strict as assert } from "node:assert";
import { test, before, after, beforeEach } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { createContributor, createSection, retireContributor, setSectionOwners } from "./gracenotes/repo";
import { createIssue, fillOpenIssues, listIssues } from "./gracenotes/issues";
import { Actor, addItem, editPiece, getPiece, listPieces } from "./gracenotes/pieces";
import { markIssueSent } from "./gracenotes/sheet";
import { openNextIssue } from "./gracenotes/clock";
import { makeVersions, updateVersions } from "./gracenotes/letter-versions";
import { redactUrl } from "./redact";
import { Contributor } from "./gracenotes/types";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const GN = "gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors";
const admin: Actor = { kind: "admin", email: "admin@example.org" };

before(async () => {
  await pool.query(SCHEMA_SQL);
  await pool.query(`DROP TABLE IF EXISTS ${GN}`);
  await pool.query(SCHEMA_SQL);
});
const clean = async () => {
  await pool.query(`TRUNCATE ${GN} CASCADE`);
  await pool.query("DELETE FROM events WHERE name LIKE 'gnfix %'");
  await pool.query("DELETE FROM settings WHERE key IN ('gn_letter_signer','gn_send_dow')");
};
beforeEach(clean);
after(async () => { await clean(); await pool.query(`DROP TABLE IF EXISTS ${GN}`); await pool.end(); });

const ok = (r: { ok: boolean }) => { assert.ok(r.ok, JSON.stringify(r)); return (r as any).value; };
const sec = async (title: string, kind: "text" | "events") => ok(await createSection(pool, { title, kind })).id as string;
const issue = async (date: string) => ok(await createIssue(pool, date)).id as string;
const person = async (name: string) => ok(await createContributor(pool, { name, email: `${name.toLowerCase()}@x.org` })) as Contributor;

test("a save over someone else's newer save is refused, and the contributor isn't shown the admin's email", async () => {
  const t = await sec("Notes", "text");
  const ann = await person("Ann");
  ok(await setSectionOwners(pool, t, [ann.id]));
  const i = await issue("2026-12-02");
  const p = (await listPieces(pool, i))[0];
  const opened = p.updatedAt;
  ok(await editPiece(pool, p.id, { bodyHtml: "<p>Ann's words</p>", expectedUpdatedAt: opened }, { kind: "contributor", contributor: ann }));
  const r = await editPiece(pool, p.id, { bodyHtml: "<p>Admin's words</p>", expectedUpdatedAt: opened }, admin);
  assert.equal(r.ok, false);
  assert.match((r as any).error, /^Ann saved this while you had it open/);
  assert.equal((await getPiece(pool, p.id))!.bodyHtml, "<p>Ann's words</p>");
  const fresh = (await getPiece(pool, p.id))!.updatedAt;
  ok(await editPiece(pool, p.id, { bodyHtml: "<p>Admin's words</p>", expectedUpdatedAt: fresh }, admin));
  const r2 = await editPiece(pool, p.id, { bodyHtml: "<p>late</p>", expectedUpdatedAt: fresh }, { kind: "contributor", contributor: ann });
  assert.match((r2 as any).error, /^Someone else saved/);
});

test("a multi-day event can be moved later by sending a new last day", async () => {
  const e = await sec("Events", "events");
  const i = await issue("2026-12-02");
  const p = ok(await addItem(pool, i, e, { title: "gnfix Retreat", startDate: "2026-12-20", endDate: "2026-12-22" }, admin));
  assert.equal((await editPiece(pool, p.id, { startDate: "2026-12-27" }, admin)).ok, false); // the old end would be before the start
  ok(await editPiece(pool, p.id, { startDate: "2026-12-27", endDate: "2026-12-29" }, admin));
  const now = (await getPiece(pool, p.id))!;
  assert.deepEqual([now.eventStartDate, now.eventEndDate], ["2026-12-27", "2026-12-29"]);
  ok(await editPiece(pool, p.id, { startDate: "2026-12-28", endDate: null }, admin)); // a one-day event again
  assert.equal((await getPiece(pool, p.id))!.eventEndDate, null);
});

test("retiring someone hands their sections and open items to someone else", async () => {
  const t = await sec("Notes", "text");
  const e = await sec("Events", "events");
  const ann = await person("Ann"), bob = await person("Bob");
  ok(await setSectionOwners(pool, t, [ann.id]));
  const i = await issue("2026-12-02");
  ok(await addItem(pool, i, e, { title: "Ann's item" }, { kind: "contributor", contributor: ann }));
  const r = await retireContributor(pool, ann.id);
  assert.match((r as any).error, /Pick who takes over Notes and 1 item first/);
  ok(await retireContributor(pool, ann.id, bob.id));
  const owners = (await pool.query("SELECT contributor_id FROM gn_section_owners WHERE section_id = $1", [t])).rows.map((x) => x.contributor_id);
  assert.deepEqual(owners, [bob.id]);
  const item = (await listPieces(pool, i)).find((p) => p.title === "Ann's item")!;
  assert.equal(item.contributorId, bob.id);
  // Someone with nothing to hand over just retires; "no one" hands things to the admin.
  const cy = await person("Cy");
  ok(await retireContributor(pool, cy.id));
  ok(await setSectionOwners(pool, t, [bob.id]));
  ok(await retireContributor(pool, bob.id, null));
  assert.equal((await pool.query("SELECT count(*)::int n FROM gn_section_owners")).rows[0].n, 0);
  assert.equal((await listPieces(pool, i)).find((p) => p.title === "Ann's item")!.contributorId, null);
});

test("filling text sections from many page loads at once adds each section once", async () => {
  const i = await issue("2026-12-02");
  await sec("Late section", "text");
  await Promise.all(Array.from({ length: 8 }, () => fillOpenIssues(pool)));
  const n = (await pool.query("SELECT count(*)::int n FROM gn_pieces WHERE issue_id = $1", [i])).rows[0].n;
  assert.equal(n, 1);
});

test("Mark sent opens next week's issue, copied forward, once", async () => {
  const t = await sec("Notes", "text");
  const i = await issue("2026-12-02");
  ok(await editPiece(pool, (await listPieces(pool, i))[0].id, { bodyHtml: "<p>Carry me</p>" }, admin));
  ok(await markIssueSent(pool, i));
  const next = await openNextIssue(pool, "2026-12-02");
  assert.ok(next);
  const issues = await listIssues(pool);
  assert.equal(issues[0].issueDate, "2026-12-09");
  assert.equal(issues[0].status, "collecting");
  assert.equal((await listPieces(pool, next!)).find((p) => p.sectionId === t)!.bodyHtml, "<p>Carry me</p>");
  assert.equal(await openNextIssue(pool, "2026-12-02"), null); // already open
});

test("hand-set headline and closing survive a re-review and a remake", async () => {
  const t = await sec("Pastor's Message", "text");
  const i = await issue("2026-12-02");
  const p = (await listPieces(pool, i)).find((x) => x.sectionId === t)!;
  ok(await editPiece(pool, p.id, { bodyHtml: "<p>Family of Grace,</p><p>Hello there. Be well.</p><p>In Christ, James</p>" }, admin));
  await pool.query("INSERT INTO gn_letter_reviews (piece_id, suggestions) VALUES ($1,'[]')", [p.id]);
  const layout = (title: string) => (async () => JSON.stringify({ title, greeting: 0, quote: -1, signoffStart: 2, signoff: "In Christ, James", signer: "",
    short: [{ kind: "p", sentences: ["Hello there."] }] })) as any;
  ok(await makeVersions(pool, p.id, layout("Claude's headline")));
  ok(await updateVersions(pool, p.id, { title: "My headline" }));
  ok(await makeVersions(pool, p.id, layout("Another headline")));
  let v = (await pool.query("SELECT versions FROM gn_letter_reviews WHERE piece_id = $1", [p.id])).rows[0].versions;
  assert.equal(v.title, "My headline");
  // A re-review clears the versions but not the hand edits.
  await pool.query("UPDATE gn_letter_reviews SET versions = NULL WHERE piece_id = $1", [p.id]);
  ok(await makeVersions(pool, p.id, layout("Third headline")));
  v = (await pool.query("SELECT versions FROM gn_letter_reviews WHERE piece_id = $1", [p.id])).rows[0].versions;
  assert.equal(v.title, "My headline");
  assert.equal(v.signoff, "In Christ, James");
});

test("request logs hide contributor tokens and sign-in codes", () => {
  assert.equal(redactUrl("/gn/abc123SECRET/piece/9"), "/gn/[token]/piece/9");
  assert.equal(redactUrl("/gn/abc123SECRET"), "/gn/[token]");
  assert.equal(redactUrl("/api/youtube/callback?state=s1&code=4/xyz&scope=a"), "/api/youtube/callback?state=[redacted]&code=[redacted]&scope=a");
  assert.equal(redactUrl("/api/pipeline/content"), "/api/pipeline/content");
});
