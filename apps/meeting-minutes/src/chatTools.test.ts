// The chat's tools against the test database. Like lockRoutes.test.ts, point
// the app's own pool at TEST_DATABASE_URL before anything imports db.ts.
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { config } from "./config";

const url = process.env.TEST_DATABASE_URL;
if (url) config.databaseUrl = url;

let pool: any = null, tools: any = null, m: any = null;
async function setup() {
  if (!pool) {
    ({ pool } = await import("./db"));
    tools = await import("./chatTools");
    m = await import("./meetings");
  }
  await pool.query("DELETE FROM meetings");
  await pool.query("DELETE FROM people");
  const mid = Number((await pool.query(
    "INSERT INTO meetings (title, report, report_generated_at, report_updated_at, speaker_map) VALUES ('Board', $1, now(), now(), '{\"S0\":\"Ann\"}') RETURNING id",
    ["# Board\n\n## Summary\nJohn reported.\n\n### 1. Budget <!--t:m7:600.0-1200.0-->\n- [ ] Send — **John** (Budget)"])).rows[0].id);
  const rec = Number((await pool.query("INSERT INTO meeting_recordings (meeting_id, storage_path) VALUES ($1, '/tmp/x.webm') RETURNING id", [mid])).rows[0].id);
  const a = await m.addAgendaItem(pool, mid, "Budget", "");
  await m.updateAgendaItem(pool, a.id, {
    transcriptSegments: [{ text: "John said the budget is fine", speaker: "S0", start: 610, end: 640 }, { text: "Agreed", speaker: "S1", start: 641, end: 650 }],
    transcriptSource: "meeting", transcriptRecordingId: rec, speakerMap: { S0: "Ann" },
  });
  return { mid, item: a.id, rec };
}
after(async () => { if (pool) await pool.end(); });
const who = { email: "a@x", name: "Ann" };
const run = (mid: number, name: string, input: unknown) => tools.runChatTool(pool, mid, name, input, who);

test("the tool list is valid strict JSON schema", { skip: !url }, async () => {
  await setup();
  for (const t of tools.CHAT_TOOLS) {
    assert.equal(t.strict, true, t.name);
    assert.equal(t.input_schema.additionalProperties, false, t.name);
    assert.deepEqual([...(t.input_schema.required ?? [])].sort(), Object.keys(t.input_schema.properties ?? {}).sort(), t.name);
  }
});

test("get_meeting describes topics, voices and the report", { skip: !url }, async () => {
  const { mid, item } = await setup();
  const r = JSON.parse((await run(mid, "get_meeting", {})).content);
  assert.equal(r.topics[0].id, item);
  assert.deepEqual(r.voices.map((v: any) => [v.voice, v.name]), [["S0", "Ann"], ["S1", null]]);
  assert.equal(r.report.exists, true);
});

test("search_transcripts finds where something was said, with its time", { skip: !url }, async () => {
  const { mid, item } = await setup();
  const r = JSON.parse((await run(mid, "search_transcripts", { query: "budget" })).content);
  assert.deepEqual(r.matches[0], { item_id: item, topic: "Budget", at: "10:10", speaker: "Ann", text: "John said the budget is fine" });
});

test("edit_report changes lines, keeps their ▶, and can be undone", { skip: !url }, async () => {
  const { mid } = await setup();
  const res = await run(mid, "edit_report", { edits: [{ line: 3, text: "### 1. Budget and Finance" }, { line: 2, text: "" }] });
  assert.ok(!res.isError, res.content);
  const report = (await m.getMeeting(pool, mid)).report;
  assert.match(report, /### 1\. Budget and Finance <!--t:m7:600\.0-1200\.0-->/);
  assert.doesNotMatch(report, /John reported/);
  assert.equal(res.card.kind, "change");
  assert.ok(res.card.changeId);
  const { undoChange } = await import("./changes");
  assert.deepEqual(await undoChange(pool, mid, res.card.changeId), { ok: true });
  assert.match((await m.getMeeting(pool, mid)).report, /John reported/);
});

test("edit_report refuses a line that isn't there", { skip: !url }, async () => {
  const { mid } = await setup();
  const res = await run(mid, "edit_report", { edits: [{ line: 99, text: "x" }] });
  assert.equal(res.isError, true);
});

test("fix_words corrects a name everywhere and says how many places", { skip: !url }, async () => {
  const { mid } = await setup();
  const res = await run(mid, "fix_words", { from: "John", to: "Jon", item_id: null });
  assert.ok(!res.isError, res.content);
  assert.match(res.card.summary, /“John” → “Jon”/);
  assert.doesNotMatch((await m.getMeeting(pool, mid)).report, /John/);
});

test("removing a topic or regenerating needs the person's say-so first", { skip: !url }, async () => {
  const { mid, item } = await setup();
  const r1 = await run(mid, "remove_topic", { item_id: item, confirmed: false });
  assert.equal(r1.isError, true);
  assert.match(r1.content, /Ask the person first/);
  assert.ok(await m.getAgendaItem(pool, item), "still there");
  const r2 = await run(mid, "regenerate_report", { confirmed: false });
  assert.equal(r2.isError, true);
});

test("ids from another meeting are refused", { skip: !url }, async () => {
  const { mid, item } = await setup();
  const other = Number((await pool.query("INSERT INTO meetings (title) VALUES ('Other') RETURNING id")).rows[0].id);
  const r = await run(other, "update_topic", { item_id: item, title: "Hijack", description: null, notes: null });
  assert.equal(r.isError, true);
  assert.equal((await m.getAgendaItem(pool, item)).title, "Budget");
  void mid;
});

test("play_clip returns a playable stretch of the topic's recording", { skip: !url }, async () => {
  const { mid, item, rec } = await setup();
  const r = await run(mid, "play_clip", { item_id: item, start: "10:10", end: "10:40", quote: "the budget is fine" });
  assert.deepEqual(r.card, { kind: "clip", source: "m", recordingId: rec, start: 610, end: 640, quote: "the budget is fine", topic: "Budget" });
  const bad = await run(mid, "play_clip", { item_id: item, start: "soon", end: "10:40", quote: null });
  assert.equal(bad.isError, true);
});

test("rename_speakers names a voice for the whole meeting and the minutes follow", { skip: !url }, async () => {
  const { mid, item } = await setup();
  const r = await run(mid, "rename_speakers", { renames: [{ voice: "S1", name: "Tom" }] });
  assert.ok(!r.isError, r.content);
  assert.deepEqual((await m.getMeeting(pool, mid)).speaker_map, { S0: "Ann", S1: "Tom" });
  assert.match((await m.getAgendaItem(pool, item)).transcript, /Tom: Agreed/);
});

test("details and attendance changes are undoable", { skip: !url }, async () => {
  const { mid } = await setup();
  const r = await run(mid, "update_meeting_details", { title: "Board (Oct)", meeting_date: null, location: "Hall", description: null });
  assert.ok(r.card.changeId);
  const { undoChange } = await import("./changes");
  await undoChange(pool, mid, r.card.changeId);
  const after = await m.getMeeting(pool, mid);
  assert.equal(after.title, "Board");
  assert.equal(after.location, "");
});
