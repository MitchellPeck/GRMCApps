import { strict as assert } from "node:assert";
import { test, before, after, beforeEach } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { createSection } from "./gracenotes/repo";
import { createIssue } from "./gracenotes/issues";
import { getPiece } from "./gracenotes/pieces";
import { applySuggestion, buildReviewPrompt, decideSuggestion, reviewLetter, Suggestion } from "./gracenotes/letter";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const GN = "gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors";

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
  return (r as { ok: true; value: { id: string } }).value.id;
}
async function issue(date: string) {
  const r = await createIssue(pool, date);
  assert.ok(r.ok);
  return (r as { ok: true; value: { id: string } }).value.id;
}
async function piece(issueId: string, sectionId: string, body: string, title = "") {
  const { rows } = await pool.query(
    `INSERT INTO gn_pieces (issue_id, section_id, title, body_html, status, content_hash) VALUES ($1,$2,$3,$4,'carried','') RETURNING id`,
    [issueId, sectionId, title, body]);
  return rows[0].id as string;
}
const sug = (o: Partial<Suggestion> = {}): Suggestion => ({
  id: "s1", kind: "fact", original: "Commitment Sunday", replacement: "Stewardship Sunday", reason: "r", source: "src", state: "open", ...o,
});

test("prompt carries facts", () => {
  const { system, user } = buildReviewPrompt("Hello church", {
    glance: "Sun Nov 8 · Stewardship Sunday", sermon: "Sermon on giving", events: ["Nov 19: Dinner"], previousLetter: "Last week's letter text",
  });
  assert.match(user, /Stewardship Sunday/);
  assert.match(user, /Last week's letter text/);
  assert.match(system, /25/);
});

test("applySuggestion replaces in text only", () => {
  const html = '<p>Commitment Sunday is <a href="/commitment">here</a></p>';
  const r = applySuggestion(html, sug());
  assert.ok(r.applied);
  assert.equal(r.html, '<p>Stewardship Sunday is <a href="/commitment">here</a></p>');
  const r2 = applySuggestion('<a title="Commitment Sunday">x</a>', sug());
  assert.equal(r2.applied, false);
});

test("applySuggestion escapes and misses cleanly", () => {
  const html = "<p>Tom &amp; Jerry</p>";
  const r = applySuggestion(html, sug({ original: "Tom & Jerry", replacement: "Tom & <Jerry>" }));
  assert.ok(r.applied);
  assert.equal(r.html, "<p>Tom &amp; &lt;Jerry&gt;</p>");
  const m = applySuggestion(html, sug({ original: "nothing" }));
  assert.equal(m.applied, false);
  assert.equal(m.html, html);
});

test("review stores suggestions; accept updates piece and state; stale marks missed", async () => {
  const letters = await sec("Pastor's Letter", "text");
  const sermon = await sec("Sermon", "text");
  const i = await issue("2026-11-08");
  await piece(i, sermon, "<p>Giving</p>");
  const p = await piece(i, letters, "<p>Commitment Sunday is here. Teh end.</p>");
  await pool.query("INSERT INTO events (id, name, start_date) VALUES ('gntest-a','Stewardship Sunday','2026-11-08')");
  let seen = "";
  const call = async (_p: Pool, _s: string, user: string) => {
    seen = user;
    return JSON.stringify({ suggestions: [
      { kind: "fact", original: "Commitment Sunday", replacement: "Stewardship Sunday", reason: "x", source: "Grace at a Glance: Stewardship Sunday, Nov 8" },
      { kind: "grammar", original: "Teh", replacement: "The", reason: "typo", source: "" },
    ] });
  };
  const list = await reviewLetter(pool, p, call);
  assert.match(seen, /Stewardship Sunday/);
  assert.equal(list.length, 2);
  assert.ok(list[0].id && list[0].id !== list[1].id);
  assert.ok(list.every((s) => s.state === "open"));

  const r = await decideSuggestion(pool, p, list[0].id, "accepted", "a@b.org");
  assert.ok(r.ok);
  assert.match((await getPiece(pool, p))!.bodyHtml, /Stewardship Sunday is here/);
  const stored = (await pool.query("SELECT suggestions FROM gn_letter_reviews WHERE piece_id=$1", [p])).rows[0].suggestions;
  assert.equal(stored[0].state, "accepted");

  await pool.query("UPDATE gn_pieces SET body_html='<p>All different.</p>' WHERE id=$1", [p]);
  const m = await decideSuggestion(pool, p, list[1].id, "accepted", "a@b.org");
  assert.deepEqual(m, { ok: false, error: "That sentence has changed since the review. Edit it by hand." });
  const stored2 = (await pool.query("SELECT suggestions FROM gn_letter_reviews WHERE piece_id=$1", [p])).rows[0].suggestions;
  assert.equal(stored2[1].state, "missed");
});

test("reject marks rejected without touching the piece", async () => {
  const letters = await sec("Message", "text");
  const i = await issue("2026-11-08");
  const p = await piece(i, letters, "<p>Teh end.</p>");
  const list = await reviewLetter(pool, p, async () => JSON.stringify({ suggestions: [{ kind: "grammar", original: "Teh", replacement: "The", reason: "", source: "" }] }));
  const r = await decideSuggestion(pool, p, list[0].id, "rejected", "a@b.org");
  assert.ok(r.ok);
  assert.equal((await getPiece(pool, p))!.bodyHtml, "<p>Teh end.</p>");
});

test("applySuggestion matches decoded text against stored entities", () => {
  for (const [html, original, replacement, out] of [
    ["<p>we&rsquo;re here</p>", "we\u2019re", "we are", "<p>we are here</p>"],
    ["<p>Pastor&nbsp;Tom speaks</p>", "Pastor Tom", "Pastor Thomas", "<p>Pastor Thomas speaks</p>"],
    ["<p>it&#39;s fine</p>", "it's", "it is", "<p>it is fine</p>"],
  ]) {
    const r = applySuggestion(html, sug({ original, replacement }));
    assert.ok(r.applied, html);
    assert.equal(r.html, out);
  }
  const span = "<p>Commitment <strong>Sunday</strong></p>";
  const m = applySuggestion(span, sug());
  assert.equal(m.applied, false);
  assert.equal(m.html, span);
});

test("applySuggestion prefers a whole word", () => {
  const r = applySuggestion("<p>Tehran. Teh end.</p>", sug({ original: "Teh", replacement: "The" }));
  assert.equal(r.html, "<p>Tehran. The end.</p>");
});

test("reviewLetter drops suggestions that do not occur in the body", async () => {
  const letters = await sec("Letter", "text");
  const i = await issue("2026-11-08");
  const p = await piece(i, letters, "<p>Teh end.</p>");
  const list = await reviewLetter(pool, p, async () => JSON.stringify({ suggestions: [
    { kind: "grammar", original: "Teh", replacement: "The", reason: "", source: "" },
    { kind: "grammar", original: "ghost", replacement: "spirit", reason: "", source: "" },
  ] }));
  assert.equal(list.length, 1);
});
