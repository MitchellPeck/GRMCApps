import { strict as assert } from "node:assert";
import { test, before, after, beforeEach } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { setSetting } from "./settings";
import { createContributor, createSection, setSectionOwners, updateSection } from "./gracenotes/repo";
import { contributorStatus, createIssue } from "./gracenotes/issues";
import { dueActions, scheduleFrom, tick } from "./gracenotes/clock";
import { remind } from "./gracenotes/mail";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const GN = "gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors";
const KEYS = ["resend_api_key", "mail_from", "public_base_url", "default_timezone", "gn_send_dow", "gn_create_at", "gn_remind_at", "gn_deadline_at"];
const S = scheduleFrom(3, "18:00", "08:00", "12:00");

before(async () => {
  await pool.query(SCHEMA_SQL);
  await pool.query(`DROP TABLE IF EXISTS ${GN}`);
  await pool.query(SCHEMA_SQL);
});
const wipe = () => pool.query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
beforeEach(async () => { await pool.query(`TRUNCATE ${GN} CASCADE`); await wipe(); });
after(async () => { await wipe(); await pool.query(`DROP TABLE IF EXISTS ${GN}`); await pool.end(); });

async function mailOn() {
  await setSetting(pool, "resend_api_key", "re_x");
  await setSetting(pool, "mail_from", "Grace <g@example.org>");
  await setSetting(pool, "public_base_url", "https://notes.example.org/");
  await setSetting(pool, "default_timezone", "America/New_York");
}
function stub() {
  const calls: Array<{ url: string; body: string; key: string }> = [];
  const fn = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ url, body: init.body, key: init.headers["idempotency-key"] ?? "" });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
// A contributor owning a text section, with the issue's carried piece in `status`.
async function setup(statusByName: Record<string, string>) {
  const sec = (await createSection(pool, { title: "Pastor", kind: "text" }) as { value: { id: string } }).value.id;
  const issue = (await createIssue(pool, "2026-11-11") as { value: { id: string } }).value;
  const ids: Record<string, string> = {};
  for (const [name, st] of Object.entries(statusByName)) {
    const c = (await createContributor(pool, { name, email: `${name.toLowerCase()}@example.org` }) as { value: { id: string } }).value;
    ids[name] = c.id;
    if (st !== "none") {
      await pool.query("INSERT INTO gn_pieces (issue_id, section_id, contributor_id, title, status, content_hash) VALUES ($1,$2,$3,'t',$4,'')", [issue.id, sec, c.id, st]);
    }
  }
  return { issueId: issue.id, ids };
}
const MON_0810 = new Date("2026-11-09T13:10:00Z");
const TUE_1300 = new Date("2026-11-10T18:00:00Z");

test("dueActions Sunday evening", () => {
  assert.deepEqual(dueActions({ date: "2026-11-08", time: "18:05" }, S, true), [{ kind: "create", issueDate: "2026-11-11" }]);
  assert.deepEqual(dueActions({ date: "2026-11-08", time: "17:55" }, S, true), []);
  assert.deepEqual(dueActions({ date: "2026-11-08", time: "18:05" }, S, false), []);
});

test("dueActions catch-up Tuesday", () => {
  assert.deepEqual(dueActions({ date: "2026-11-10", time: "13:00" }, S, true),
    [{ kind: "create", issueDate: "2026-11-11" }, { kind: "deadline", issueDate: "2026-11-11" }]);
  assert.deepEqual(dueActions({ date: "2026-11-10", time: "13:00" }, S, false), [{ kind: "deadline", issueDate: "2026-11-11" }]);
  assert.deepEqual(dueActions({ date: "2026-11-10", time: "11:00" }, S, true).map((a) => a.kind), ["create", "monday"]);
  assert.deepEqual(dueActions({ date: "2026-11-11", time: "13:00" }, S, true), []);
});

test("tick is idempotent", async () => {
  await mailOn();
  const { issueId, ids } = await setup({ Ann: "carried", Bob: "carried" });
  const { fn, calls } = stub();
  const r1 = await tick(pool, MON_0810, fn);
  const r2 = await tick(pool, MON_0810, fn);
  assert.equal(r1.reminded, 2);
  assert.equal(r2.reminded, 0);
  assert.equal(calls.length, 2);
  const { rows } = await pool.query("SELECT contributor_id, status FROM gn_reminders WHERE issue_id = $1", [issueId]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.status === "sent") && rows.some((x) => x.contributor_id === ids.Ann));
});

test("tick creates the issue Sunday evening", async () => {
  await mailOn();
  await createIssue(pool, "2026-11-04");
  const r = await tick(pool, new Date("2026-11-08T23:05:00Z"), stub().fn);
  assert.equal(r.created, "2026-11-11");
  assert.equal((await tick(pool, new Date("2026-11-08T23:10:00Z"), stub().fn)).created, undefined);
});

test("no reminder without pieces", async () => {
  await mailOn();
  await setup({ Ann: "carried", Cy: "none" });
  const { fn, calls } = stub();
  await tick(pool, MON_0810, fn);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.includes("ann@example.org") && !calls[0].body.includes("cy@"));
});

test("deadline only outstanding", async () => {
  await mailOn();
  await setup({ Ann: "carried", Bob: "confirmed" });
  await pool.query("UPDATE gn_pieces SET status = 'confirmed' WHERE status = 'confirmed'");
  const { fn, calls } = stub();
  await tick(pool, MON_0810, fn);
  calls.length = 0;
  await tick(pool, TUE_1300, fn);
  // Bob already had Monday's email; Tuesday nudges only Ann.
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.includes("ann@example.org"));
});

test("mail off is skipped not failed", async () => {
  const { issueId, ids } = await setup({ Ann: "carried" });
  const { fn, calls } = stub();
  assert.equal((await remind(pool, issueId, ids.Ann, "monday", fn)).status, "skipped");
  assert.equal(calls.length, 0);
  assert.equal((await pool.query("SELECT 1 FROM gn_reminders")).rows.length, 0);
  // Switching mail on later still sends.
  await mailOn();
  assert.equal((await remind(pool, issueId, ids.Ann, "monday", fn)).status, "sent");
});

test("failed send is recorded", async () => {
  await mailOn();
  const { issueId, ids } = await setup({ Ann: "carried" });
  const bad = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const r = await remind(pool, issueId, ids.Ann, "monday", bad);
  assert.equal(r.status, "failed");
  assert.equal((await pool.query("SELECT status FROM gn_reminders")).rows[0].status, "failed");
});

test("reminder body has link and copy", async () => {
  await mailOn();
  const { issueId, ids } = await setup({ Ann: "carried" });
  const { fn, calls } = stub();
  await remind(pool, issueId, ids.Ann, "monday", fn);
  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.subject, "Grace Notes for Wed Nov 11: please check your piece");
  assert.ok(sent.text.startsWith("Grace Notes goes out Wednesday. Check your piece by Tuesday noon:"));
  const tok = (await pool.query("SELECT token FROM gn_contributors")).rows[0].token;
  assert.ok(sent.text.includes(`https://notes.example.org/gn/${tok}`));
});

test("two manual nudges use distinct idempotency keys", async () => {
  await mailOn();
  const { issueId, ids } = await setup({ Ann: "carried" });
  const { fn, calls } = stub();
  assert.equal((await remind(pool, issueId, ids.Ann, "manual", fn)).status, "sent");
  assert.equal((await remind(pool, issueId, ids.Ann, "manual", fn)).status, "sent");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].key && calls[1].key && calls[0].key !== calls[1].key, JSON.stringify(calls.map((c) => c.key)));
  // Automatic kinds keep one key per issue, contributor and kind.
  await remind(pool, issueId, ids.Ann, "monday", fn);
  assert.equal(calls[2].key, `gn-${issueId}-${ids.Ann}-monday`);
});

test("a later first issue: no stray issue, reminders go to the live one", async () => {
  await mailOn();
  const sec = (await createSection(pool, { title: "Pastor", kind: "text" }) as { value: { id: string } }).value.id;
  const ann = (await createContributor(pool, { name: "Ann", email: "ann@example.org" }) as { value: { id: string } }).value.id;
  await setSectionOwners(pool, sec, [ann]);
  const first = (await createIssue(pool, "2026-11-18") as { value: { id: string } }).value.id;
  const { fn, calls } = stub();
  const r = await tick(pool, MON_0810, fn);
  assert.equal(r.created, undefined);
  assert.deepEqual((await pool.query("SELECT to_char(issue_date,'YYYY-MM-DD') d FROM gn_issues")).rows.map((x) => x.d), ["2026-11-18"]);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].body).subject, "Grace Notes for Wed Nov 18: please check your piece");
  assert.equal((await pool.query("SELECT issue_id FROM gn_reminders")).rows[0].issue_id, first);
  // Tuesday's deadline nudge waits for Nov 18's own deadline.
  calls.length = 0;
  await tick(pool, TUE_1300, fn);
  assert.equal(calls.length, 0);
  assert.equal((await tick(pool, new Date("2026-11-17T18:00:00Z"), fn)).reminded, 1);
  // Sunday evening before Nov 18 creates nothing either.
  assert.equal((await tick(pool, new Date("2026-11-15T23:05:00Z"), fn)).created, undefined);
});

test("no reminder for a sent issue", async () => {
  await mailOn();
  const { issueId } = await setup({ Ann: "carried" });
  await pool.query("UPDATE gn_issues SET status = 'sent' WHERE id = $1", [issueId]);
  const { fn, calls } = stub();
  await tick(pool, MON_0810, fn);
  assert.equal(calls.length, 0);
});

test("events-section owners get the Monday email with no pieces, not the deadline nudge", async () => {
  await mailOn();
  const ev = (await createSection(pool, { title: "Events", kind: "events" }) as { value: { id: string } }).value.id;
  const { ids } = await setup({ Ann: "none", Bob: "none" });
  await setSectionOwners(pool, ev, [ids.Ann]);
  const { fn, calls } = stub();
  await tick(pool, MON_0810, fn);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.includes("ann@example.org"));
  calls.length = 0;
  await tick(pool, TUE_1300, fn);
  assert.equal(calls.length, 0);
});

test("contributorStatus ignores pieces in retired sections and says who has email", async () => {
  const { issueId, ids } = await setup({ Ann: "carried" });
  const noMail = (await createContributor(pool, { name: "Dee" }) as { value: { id: string } }).value.id;
  let st = await contributorStatus(pool, issueId);
  assert.equal(st.find((c) => c.contributorId === ids.Ann)!.state, "outstanding");
  assert.equal(st.find((c) => c.contributorId === ids.Ann)!.hasEmail, true);
  assert.equal(st.find((c) => c.contributorId === noMail)!.hasEmail, false);
  const sec = (await pool.query("SELECT section_id FROM gn_pieces WHERE issue_id = $1 LIMIT 1", [issueId])).rows[0].section_id;
  await updateSection(pool, sec, { retired: true });
  st = await contributorStatus(pool, issueId);
  assert.deepEqual([st.find((c) => c.contributorId === ids.Ann)!.state, st.find((c) => c.contributorId === ids.Ann)!.pieces], ["none", 0]);
});
