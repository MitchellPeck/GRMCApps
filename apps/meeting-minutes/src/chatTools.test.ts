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

test("removing a topic or regenerating only offers a Confirm button; nothing happens yet", { skip: !url }, async () => {
  const { mid, item } = await setup();
  const r1 = await run(mid, "remove_topic", { item_id: item });
  assert.ok(!r1.isError, r1.content);
  assert.deepEqual(r1.card, { kind: "confirm", action: "remove_topic", itemId: item, label: "Remove the topic “Budget” and what was recorded under it" });
  assert.ok(await m.getAgendaItem(pool, item), "still there");
  const r2 = await run(mid, "regenerate_report", {});
  assert.equal(r2.card.kind, "confirm");
  assert.equal(r2.card.action, "regenerate_report");
});

test("reprocessing is only offered for a finished recording", { skip: !url }, async () => {
  const { mid } = await setup();
  await pool.query("UPDATE meetings SET recording_status = 'recording' WHERE id = $1", [mid]);
  const busy = await run(mid, "reprocess_recording", {});
  assert.equal(busy.isError, true);
  await pool.query("UPDATE meetings SET recording_status = 'done' WHERE id = $1", [mid]);
  const ok = await run(mid, "reprocess_recording", {});
  assert.equal(ok.card.kind, "confirm");
});

test("undoing a notes edit also puts the summary back", { skip: !url }, async () => {
  const { mid, item } = await setup();
  await m.updateAgendaItem(pool, item, { summary: "Old summary.", actionItems: [{ task: "A", owner: "B" }] });
  const r = await run(mid, "update_topic", { item_id: item, title: null, description: null, notes: "New notes", transcript: null,
    presenter_person_ids: null, presenter_guest_ids: null });
  assert.equal((await m.getAgendaItem(pool, item)).summary, "", "notes edits re-summarize, like the page");
  const { undoChange } = await import("./changes");
  assert.deepEqual(await undoChange(pool, mid, r.card.changeId), { ok: true });
  const it = await m.getAgendaItem(pool, item);
  assert.equal(it.notes, "");
  assert.equal(it.summary, "Old summary.");
});

test("presenters and a topic's action items can be set", { skip: !url }, async () => {
  const { mid, item } = await setup();
  const pid = Number((await pool.query("INSERT INTO people (name) VALUES ('Linda') RETURNING id")).rows[0].id);
  const r = await run(mid, "update_topic", { item_id: item, title: null, description: null, notes: null, transcript: null,
    presenter_person_ids: [pid], presenter_guest_ids: null });
  assert.ok(!r.isError, r.content);
  assert.deepEqual((await m.getAgendaItem(pool, item)).presenter_ids, [pid]);
  const a = await run(mid, "set_action_items", { item_id: item, items: [{ task: "Send figures", owner: "Linda" }] });
  assert.ok(a.card.changeId);
  assert.deepEqual((await m.getAgendaItem(pool, item)).action_items, [{ task: "Send figures", owner: "Linda" }]);
});

test("a call that changes nothing makes no card", { skip: !url }, async () => {
  const { mid } = await setup();
  const r = await run(mid, "update_meeting_details", { title: null, meeting_date: null, location: null, description: null });
  assert.equal(r.isError, true);
  assert.equal(r.card, undefined);
  const u = await run(mid, "rename_speakers", { renames: [{ voice: "S9", name: "Nobody" }] });
  assert.equal(u.isError, true, "unknown voice");
});

test("a pasted (▶) or line number doesn't end up in the minutes", { skip: !url }, async () => {
  const { mid } = await setup();
  await run(mid, "edit_report", { edits: [{ line: 3, text: "3: ### 1. Budget and Finance (▶)" }] });
  assert.match((await m.getMeeting(pool, mid)).report, /\n### 1\. Budget and Finance <!--t:m7:600\.0-1200\.0-->/);
});

test("a very long transcript is trimmed with a note", { skip: !url }, async () => {
  const { mid, item } = await setup();
  await pool.query("UPDATE agenda_items SET transcript = $2, transcript_segments = '[]' WHERE id = $1", [item, "word ".repeat(20000)]);
  const r = JSON.parse((await run(mid, "get_transcript", { item_id: item })).content);
  assert.ok(r.transcript.length <= 40100);
  assert.match(r.note, /trimmed/i);
});

test("ids from another meeting are refused", { skip: !url }, async () => {
  const { mid, item } = await setup();
  const other = Number((await pool.query("INSERT INTO meetings (title) VALUES ('Other') RETURNING id")).rows[0].id);
  const r = await run(other, "update_topic", { item_id: item, title: "Hijack", description: null, notes: null, transcript: null,
    presenter_person_ids: null, presenter_guest_ids: null });
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
