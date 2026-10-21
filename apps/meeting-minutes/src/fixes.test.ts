import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { addPerson } from "./people";
import { addAgendaItem, addGuest, createMeeting, getAgendaItem, getMeeting, listGuests, saveReport, saveReportEdit, updateAgendaItem } from "./meetings";
import { fixWords, listChanges, renameTopicSpeakers, undoChange } from "./fixes";
import { reportEdited, rewriteMeetingSpeakerMap } from "./meetings";

const url = process.env.TEST_DATABASE_URL;

async function setup(pool: Pool) {
  await pool.query("DELETE FROM meetings");
  await pool.query("DELETE FROM people");
  const person = await addPerson(pool, "John Hale", "", "");
  assert.ok(person.ok);
  const m = await createMeeting(pool, { title: "Fixes", meetingDate: "", location: "", description: "", email: "", name: "" });
  assert.ok(m.ok);
  await addGuest(pool, m.id, "John Hale", "Visitor");
  const a = await addAgendaItem(pool, m.id, "Budget", "");
  const b = await addAgendaItem(pool, m.id, "Roof", "");
  assert.ok(a.ok && b.ok);
  await updateAgendaItem(pool, a.id, {
    transcriptSegments: [{ text: "John said hello", speaker: "S0", start: 0, end: 2 }],
    transcriptSource: "meeting", transcriptRecordingId: 1,
  });
  await updateAgendaItem(pool, a.id, { summary: "John reported.", actionItems: [{ task: "Call John", owner: "John" }], status: "done" });
  await saveReport(pool, m.id, "# Fixes\n### 1. Budget\nJohn reported.\n### 2. Roof\nAsk John.\n## Action Items\n- [ ] Call John — **John** (Budget)");
  return { mid: m.id, a: a.id, b: b.id, personId: (person as any).id as number };
}

test("fixWords changes every place a name appears and keeps the summary", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const { mid, a, personId } = await setup(pool);
    const r = await fixWords(pool, mid, "John", "Jon");
    assert.deepEqual(r.counts, { transcripts: 1, summaries: 1, actionItems: 2, report: 4, speakers: 0, guests: 1 });
    assert.equal(r.total, 9);
    assert.ok(r.changeId);
    assert.deepEqual(r.libraryMatches, [{ id: personId, name: "John Hale" }]);
    const it = (await getAgendaItem(pool, a))!;
    assert.equal(it.transcript_segments[0].text, "Jon said hello");
    assert.equal(it.transcript, "Speaker 1: Jon said hello");
    assert.equal(it.summary, "Jon reported.");
    assert.equal(it.status, "done");
    assert.deepEqual(it.action_items, [{ task: "Call Jon", owner: "Jon" }]);
    assert.doesNotMatch((await getMeeting(pool, mid))!.report, /John/);
    assert.equal((await listGuests(pool, mid))[0].name, "Jon Hale");
    assert.equal((await listChanges(pool, mid))[0].summary, "“John” → “Jon”: 9 places");
  } finally { await pool.end(); }
});

test("a dry run counts without changing anything", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const { mid, a } = await setup(pool);
    const r = await fixWords(pool, mid, "John", "Jon", { dryRun: true });
    assert.equal(r.total, 9);
    assert.equal(r.changeId, null);
    assert.equal((await getAgendaItem(pool, a))!.summary, "John reported.");
    assert.deepEqual(await listChanges(pool, mid), []);
  } finally { await pool.end(); }
});

test("a fix in one topic changes only that topic and its part of the report", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const { mid, a, b } = await setup(pool);
    const r = await fixWords(pool, mid, "John", "Jon", { itemId: b });
    assert.equal(r.total, 1);
    assert.equal(r.counts.report, 1);
    const report = (await getMeeting(pool, mid))!.report;
    assert.match(report, /### 1\. Budget\nJohn reported\./);
    assert.match(report, /### 2\. Roof\nAsk Jon\./);
    assert.equal((await getAgendaItem(pool, a))!.summary, "John reported.");
  } finally { await pool.end(); }
});

test("undo puts everything back once, and refuses after a later edit", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const { mid, a } = await setup(pool);
    const r = await fixWords(pool, mid, "John", "Jon");
    assert.deepEqual(await undoChange(pool, mid, r.changeId!), { ok: true });
    const it = (await getAgendaItem(pool, a))!;
    assert.equal(it.transcript, "Speaker 1: John said hello");
    assert.equal(it.summary, "John reported.");
    assert.match((await getMeeting(pool, mid))!.report, /Ask John\./);
    assert.equal((await listGuests(pool, mid))[0].name, "John Hale");
    assert.deepEqual(await undoChange(pool, mid, r.changeId!), { ok: false, status: 409, error: "Already undone." });
    assert.equal((await listChanges(pool, mid))[0].undone, true);

    const again = await fixWords(pool, mid, "John", "Jon");
    await saveReportEdit(pool, mid, "# Rewritten by hand");
    const refused = await undoChange(pool, mid, again.changeId!);
    assert.deepEqual(refused, { ok: false, status: 409, error: "Something changed these since; undo it by hand." });
    assert.equal((await getAgendaItem(pool, a))!.summary, "Jon reported.", "nothing restored");
    assert.deepEqual(await undoChange(pool, mid, 999999), { ok: false, status: 404, error: "That change wasn't found." });
  } finally { await pool.end(); }
});

test("nothing to change records nothing", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const { mid } = await setup(pool);
    const r = await fixWords(pool, mid, "Nobody", "X");
    assert.equal(r.total, 0);
    assert.equal(r.changeId, null);
    assert.deepEqual(await listChanges(pool, mid), []);
  } finally { await pool.end(); }
});

test("a speaker name is one change, not one per topic, and relabels the transcript", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const { mid, a, b } = await setup(pool);
    const map = JSON.stringify({ S0: "Tom Smyth" });
    await pool.query("UPDATE meetings SET speaker_map = $2 WHERE id = $1", [mid, map]);
    await pool.query("UPDATE agenda_items SET speaker_map = $2 WHERE id = ANY($1)", [[a, b], map]);
    const r = await fixWords(pool, mid, "Smyth", "Smith");
    assert.equal(r.counts.speakers, 1);
    assert.equal((await getAgendaItem(pool, a))!.transcript, "Tom Smith: John said hello");
    assert.deepEqual((await getMeeting(pool, mid))!.speaker_map, { S0: "Tom Smith" });
    assert.deepEqual((await getAgendaItem(pool, b))!.speaker_map, { S0: "Tom Smith" });
  } finally { await pool.end(); }
});

test("after the report, a speaker rename updates the minutes and keeps summaries", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const { mid, a } = await setup(pool);
    await updateAgendaItem(pool, a, { summary: "Speaker 1 reported.", actionItems: [{ task: "Send figures", owner: "Speaker 1" }] });
    await saveReport(pool, mid, "### 1. Budget\nSpeaker 1 reported.\n- [ ] Send figures — **Speaker 1** (Budget)");
    await rewriteMeetingSpeakerMap(pool, mid, { S0: "Linda" });
    const it = (await getAgendaItem(pool, a))!;
    assert.equal(it.transcript, "Linda: John said hello");
    assert.equal(it.summary, "Linda reported.");
    assert.equal(it.status, "done");
    assert.deepEqual(it.action_items, [{ task: "Send figures", owner: "Linda" }]);
    const m = (await getMeeting(pool, mid))!;
    assert.equal(m.report, "### 1. Budget\nLinda reported.\n- [ ] Send figures — **Linda** (Budget)");
    assert.equal(reportEdited(m), true);
    const [change] = await listChanges(pool, mid);
    assert.equal(change.kind, "rename");
    assert.equal(change.summary, "“Speaker 1” → “Linda”");
    assert.deepEqual(await undoChange(pool, mid, change.id), { ok: true });
    assert.equal((await getAgendaItem(pool, a))!.summary, "Speaker 1 reported.");
  } finally { await pool.end(); }
});

test("before the report, a speaker rename still clears the summary for rewriting", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const { mid, a } = await setup(pool);
    await pool.query("UPDATE meetings SET report = '', report_generated_at = NULL WHERE id = $1", [mid]);
    await rewriteMeetingSpeakerMap(pool, mid, { S0: "Linda" });
    const it = (await getAgendaItem(pool, a))!;
    assert.equal(it.summary, "");
    assert.equal(it.status, "pending");
  } finally { await pool.end(); }
});

test("a topic's own speaker rename after the report changes only that topic", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const { mid, b } = await setup(pool);
    await updateAgendaItem(pool, b, { transcriptSegments: [{ text: "Roof leaks", speaker: "R0", start: 0, end: 1 }], transcriptRecordingId: 4 });
    await updateAgendaItem(pool, b, { summary: "Speaker 1 said the roof leaks.", status: "done" });
    await saveReport(pool, mid, "### 1. Budget\nSpeaker 1 spoke.\n### 2. Roof\nSpeaker 1 said the roof leaks.");
    const r = await renameTopicSpeakers(pool, b, { R0: "Tom" });
    assert.ok(r.changeId);
    const it = (await getAgendaItem(pool, b))!;
    assert.equal(it.transcript, "Tom: Roof leaks");
    assert.equal(it.summary, "Tom said the roof leaks.");
    assert.deepEqual(it.speaker_map, { R0: "Tom" });
    assert.equal((await getMeeting(pool, mid))!.report, "### 1. Budget\nSpeaker 1 spoke.\n### 2. Roof\nTom said the roof leaks.");
  } finally { await pool.end(); }
});
