import { strict as assert } from "node:assert";
import { test, before, after, beforeEach } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { createSection } from "./gracenotes/repo";
import { createIssue } from "./gracenotes/issues";
import { assemble, buildVersionsPrompt, makeVersions, splitParagraphs, updateVersions, viewOf } from "./gracenotes/letter-versions";
import { reviewLetter } from "./gracenotes/letter";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const GN = "gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors";

before(async () => {
  await pool.query(SCHEMA_SQL);
  await pool.query(`DROP TABLE IF EXISTS ${GN}`);
  await pool.query(SCHEMA_SQL);
});
beforeEach(async () => {
  await pool.query(`TRUNCATE ${GN} CASCADE`);
  await pool.query("DELETE FROM settings WHERE key = 'gn_letter_signer'");
});
after(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${GN}`);
  await pool.query("DELETE FROM settings WHERE key = 'gn_letter_signer'");
  await pool.end();
});

const LETTER = [
  "<p>Family of Grace,</p>",
  "<p>What a wonderful sight it was this past Sunday! I was deeply moved. Grace Resurrection is truly a special place.</p>",
  "<p>Every commitment matters. You can give at <a href=\"https://graceresurrection.org/give\">graceresurrection.org/give</a>. Thank you.</p>",
  "<p>“It’s not equal giving, but equal sacrifice.”</p>",
  "<p>Please make worship a priority. I love you all.</p>",
  "<p>In Christ,<br>James</p>",
].join("");

const LAYOUT = {
  title: "Preparing for our most significant year.", greeting: 0, quote: 3, signoffStart: 5, signoff: "In Christ, James", signer: "",
  short: [
    { kind: "greeting", sentences: ["Family of Grace,"] },
    { kind: "p", sentences: ["What a wonderful sight it was this past Sunday!", "Grace Resurrection is truly a special place."] },
    { kind: "p", sentences: ["You can give at graceresurrection.org/give.", "I made this sentence up."] },
    { kind: "quote", sentences: ["\"It's not equal giving, but equal sacrifice.\""] },
  ],
};

test("splitParagraphs splits <p>, lists and blank lines", () => {
  assert.deepEqual(splitParagraphs("<p>a</p><ul><li>x</li></ul>loose<p>b<br><br>c</p><p> </p>"),
    ["a", "<ul><li>x</li></ul>", "loose", "b", "c"]);
});

test("prompt numbers the paragraphs as plain text", () => {
  const { user, system } = buildVersionsPrompt(splitParagraphs(LETTER));
  assert.match(user, /\[2\] Every commitment matters\. You can give at graceresurrection\.org\/give\./);
  assert.match(system, /character for character/);
});

test("assemble keeps the full letter word for word and only quoted sentences in the short cut", () => {
  const v = assemble(LETTER, LAYOUT, "Rev. James Williams, Senior Pastor");
  assert.equal(v.title, "Preparing for our most significant year");
  assert.deepEqual(v.full.map((b) => b.kind), ["greeting", "p", "p", "quote", "p"]);
  assert.equal(v.full[2].html, LETTER.match(/<p>(Every[\s\S]*?)<\/p>/)![1]);
  assert.equal(v.signoff, "In Christ, James");
  assert.equal(v.signer, "Rev. James Williams, Senior Pastor"); // not in the letter, so the saved one
  assert.equal(v.short.length, 4);
  assert.equal(v.short[1].html, "What a wonderful sight it was this past Sunday! Grace Resurrection is truly a special place.");
  // the invented sentence is dropped; the link comes back
  assert.equal(v.short[2].html, 'You can give at <a href="https://graceresurrection.org/give">graceresurrection.org/give</a>.');
  // straight quotes from Claude are matched, and the letter's curly ones are kept
  assert.equal(v.short[3].html, "“It’s not equal giving, but equal sacrifice.”");
});

test("assemble fails when nothing in the short cut is quoted", () => {
  assert.throws(() => assemble(LETTER, { ...LAYOUT, short: [{ kind: "p", sentences: ["Totally new words."] }] }, ""), /didn't quote/);
});

test("rendered versions carry inline styles and escape the headline", () => {
  const v = assemble(LETTER, { ...LAYOUT, title: "Faith & <works>" }, "Rev. J");
  const view = viewOf(v, LETTER);
  assert.equal(view.stale, false);
  assert.match(view.fullHtml, /<h1 style="[^"]*DM Serif Display[^"]*">Faith &amp; &lt;works&gt;<\/h1>/);
  assert.match(view.fullHtml, /<p style="[^"]*text-align:center[^"]*">“It’s not equal giving/);
  assert.match(view.fullHtml, /<a href="https:\/\/graceresurrection.org\/give" style="color:#3f6e78;font-weight:700;text-decoration:underline">/);
  assert.match(view.fullHtml, /font-style:italic[^"]*">In Christ, James<\/p><p style="[^"]*">Rev\. J<\/p><\/div>$/);
  assert.ok(view.shortHtml.length < view.fullHtml.length);
  assert.match(view.shortText, /^Faith & <works>\n\nFamily of Grace,/);
  assert.equal(viewOf(v, LETTER + "<p>x</p>").stale, true);
});

test("signer spelled out in the closing is used", () => {
  const html = LETTER.replace("<p>In Christ,<br>James</p>", "<p>In Christ, James</p><p>Rev. James Williams, Senior Pastor</p>");
  const v = assemble(html, { ...LAYOUT, signer: "Rev. James Williams, Senior Pastor" }, "Someone Else");
  assert.equal(v.signer, "Rev. James Williams, Senior Pastor");
  assert.equal(v.signoff, "In Christ, James");
});

async function letterPiece(body = LETTER) {
  const sec = await createSection(pool, { title: "Pastor's Message", kind: "text" });
  assert.ok(sec.ok);
  const iss = await createIssue(pool, "2026-11-18");
  assert.ok(iss.ok);
  const { rows } = await pool.query(
    `INSERT INTO gn_pieces (issue_id, section_id, title, body_html, status, content_hash) VALUES ($1,$2,'',$3,'carried','') RETURNING id`,
    [(iss as any).value.id, (sec as any).value.id, body]);
  return rows[0].id as string;
}
const fake = (out: unknown) => (async () => JSON.stringify(out)) as any;

test("makeVersions waits for the review to be finished, then stores; re-review clears them", async () => {
  const id = await letterPiece();
  assert.match((await makeVersions(pool, id, fake(LAYOUT)) as any).error, /Review the letter first/);
  await reviewLetter(pool, id, fake({ suggestions: [{ kind: "grammar", original: "deeply moved", replacement: "deeply touched", reason: "", source: "" }] }));
  assert.match((await makeVersions(pool, id, fake(LAYOUT)) as any).error, /every suggestion/);
  await pool.query("UPDATE gn_letter_reviews SET suggestions = jsonb_set(suggestions, '{0,state}', '\"rejected\"') WHERE piece_id = $1", [id]);
  const r = await makeVersions(pool, id, fake({ ...LAYOUT, signer: "" }));
  assert.ok(r.ok);
  const stored = (await pool.query("SELECT versions FROM gn_letter_reviews WHERE piece_id = $1", [id])).rows[0].versions;
  assert.equal(stored.title, "Preparing for our most significant year");

  const u = await updateVersions(pool, id, { title: "  New   headline ", signer: "Rev. A, Pastor" });
  assert.ok(u.ok);
  assert.equal((u as any).value.title, "New headline");
  assert.equal((await pool.query("SELECT value FROM settings WHERE key = 'gn_letter_signer'")).rows[0].value, "Rev. A, Pastor");

  await reviewLetter(pool, id, fake({ suggestions: [] }));
  assert.equal((await pool.query("SELECT versions FROM gn_letter_reviews WHERE piece_id = $1", [id])).rows[0].versions, null);
});
