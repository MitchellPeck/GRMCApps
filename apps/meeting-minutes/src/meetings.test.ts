import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { addPerson, listPeople } from "./people";
import {
  createMeeting, listMeetings, getMeeting, updateMeeting, deleteMeeting,
  setAttendees, getAttendeeIds, replaceAgendaItems, addAgendaItem,
  listAgendaItems, getAgendaItem, updateAgendaItem, deleteAgendaItem, saveReport,
  setTranscribeStatus, listUnfinishedTranscriptions, listItemStatuses, reportFileName,
  setMeetingRecordingStatus, listUnfinishedMeetingProcessing, addTopicMarker,
  listTopicMarkers, setMeetingSpeakerMap,
} from "./meetings";
import { appendMeetingChunk, getMeetingRecording } from "./recordings";

const url = process.env.TEST_DATABASE_URL;

async function reset(pool: Pool) {
  await pool.query("DELETE FROM meetings"); // cascades to attendees/items/presenters
  await pool.query("DELETE FROM people");
}

test("full meeting lifecycle: attendees, agenda, presenters, summary, report", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await reset(pool);

  // Library
  const p1 = await addPerson(pool, "Alice", "alice@x.com", "Chair");
  const p2 = await addPerson(pool, "Bob", "bob@x.com", "Treasurer");
  assert.ok(p1.ok && p2.ok);
  const ids = (await listPeople(pool, true)).map((p) => p.id);

  // Create + read
  const m = await createMeeting(pool, {
    title: "Board", meetingDate: "2026-04-01", location: "Hall", description: "", email: "me@x.com", name: "Me",
  });
  assert.ok(m.ok);
  const meetingId = (m as any).id;
  assert.equal((await listMeetings(pool)).length, 1);

  // Attendees (setAttendees is idempotent replace)
  await setAttendees(pool, meetingId, ids);
  assert.deepEqual((await getAttendeeIds(pool, meetingId)).sort(), ids.slice().sort());
  await setAttendees(pool, meetingId, [ids[0]]);
  assert.deepEqual(await getAttendeeIds(pool, meetingId), [ids[0]]);

  // Agenda extraction replace
  await replaceAgendaItems(pool, meetingId, [
    { title: "Budget", description: "Q2", presenter: "" },
    { title: "Missions", description: "", presenter: "" },
  ], "agenda.pdf");
  let items = await listAgendaItems(pool, meetingId);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Budget");
  assert.equal((await getMeeting(pool, meetingId))!.agenda_file_name, "agenda.pdf");

  // Re-upload replaces
  await replaceAgendaItems(pool, meetingId, [{ title: "Only", description: "", presenter: "" }], "a2.pdf");
  items = await listAgendaItems(pool, meetingId);
  assert.equal(items.length, 1);

  // Manual add
  const added = await addAgendaItem(pool, meetingId, "Manual", "notes");
  assert.ok(added.ok);
  items = await listAgendaItems(pool, meetingId);
  assert.equal(items.length, 2);
  assert.equal(items[1].position, 1); // appended after existing

  const item = items[0];

  // Presenters replace + transcript append + notes
  await updateAgendaItem(pool, item.id, { presenterIds: ids });
  assert.deepEqual((await getAgendaItem(pool, item.id))!.presenter_ids.sort(), ids.slice().sort());
  await updateAgendaItem(pool, item.id, { presenterIds: [ids[1]] });
  assert.deepEqual((await getAgendaItem(pool, item.id))!.presenter_ids, [ids[1]]);

  await updateAgendaItem(pool, item.id, { appendTranscript: "hello" });
  await updateAgendaItem(pool, item.id, { appendTranscript: "world" });
  assert.equal((await getAgendaItem(pool, item.id))!.transcript, "hello\nworld");

  await updateAgendaItem(pool, item.id, { transcript: "overwritten" });
  assert.equal((await getAgendaItem(pool, item.id))!.transcript, "overwritten");

  // Diarized segments render a speaker-attributed transcript; remapping a
  // speaker relabels it without re-uploading audio.
  await updateAgendaItem(pool, item.id, {
    transcriptSegments: [
      { text: "We need to book the hall.", speaker: "SPEAKER_00", start: 0, end: 2 },
      { text: "I'll do it.", speaker: "SPEAKER_01", start: 2, end: 3 },
    ],
    speakerMap: { SPEAKER_00: "Alice" },
  });
  let diar = (await getAgendaItem(pool, item.id))!;
  assert.equal(diar.transcript, "Alice: We need to book the hall.\nSpeaker 2: I'll do it.");
  assert.equal(diar.transcript_segments.length, 2);

  await updateAgendaItem(pool, item.id, { speakerMap: { SPEAKER_00: "Alice", SPEAKER_01: "Bob" } });
  diar = (await getAgendaItem(pool, item.id))!;
  assert.equal(diar.transcript, "Alice: We need to book the hall.\nBob: I'll do it.");

  // Structured action items round-trip through jsonb.
  await updateAgendaItem(pool, item.id, {
    actionItems: [{ task: "Book the hall", owner: "Bob" }],
  });
  assert.deepEqual((await getAgendaItem(pool, item.id))!.action_items, [{ task: "Book the hall", owner: "Bob" }]);

  await updateAgendaItem(pool, item.id, { notes: "typed", summary: "sum", status: "done" });
  const done = (await getAgendaItem(pool, item.id))!;
  assert.equal(done.notes, "typed");
  assert.equal(done.summary, "sum");
  assert.equal(done.status, "done");

  // Delete an item
  await deleteAgendaItem(pool, items[1].id);
  assert.equal((await listAgendaItems(pool, meetingId)).length, 1);

  // Update meeting fields
  const upd = await updateMeeting(pool, meetingId, { title: "Board Mtg", status: "in_progress" });
  assert.ok(upd.ok);
  assert.equal((await getMeeting(pool, meetingId))!.title, "Board Mtg");

  // Report
  await saveReport(pool, meetingId, "# Minutes");
  const withReport = (await getMeeting(pool, meetingId))!;
  assert.equal(withReport.report, "# Minutes");
  assert.equal(withReport.status, "completed");
  assert.ok(withReport.report_generated_at);

  // Delete meeting cascades
  await deleteMeeting(pool, meetingId);
  assert.equal((await listMeetings(pool)).length, 0);

  await reset(pool);
  await pool.end();
});

test("createMeeting/addAgendaItem require titles", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  const noTitle = await createMeeting(pool, { title: " ", meetingDate: "", location: "", description: "", email: "", name: "" });
  assert.equal(noTitle.ok, false);
  await pool.end();
});

test("replaceAgendaItems links resolvable presenters and ignores the rest", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await reset(pool);

  const a = await addPerson(pool, "Jane Doe", "jane@x.com", "Treasurer");
  const b = await addPerson(pool, "Bob Jones", "bob@x.com", "Clerk");
  assert.ok(a.ok && b.ok);
  const janeId = (a as { ok: true; id: number }).id;

  const m = await createMeeting(pool, {
    title: "Board", meetingDate: "", location: "", description: "", email: "", name: "",
  });
  assert.ok(m.ok);
  const meetingId = (m as { ok: true; status: number; id: number }).id;

  await replaceAgendaItems(pool, meetingId, [
    { title: "Budget", description: "Q2", presenter: "Jane Doe" },
    { title: "Grounds", description: "", presenter: "Doe" },        // unique last name
    { title: "Missions", description: "", presenter: "Carlos Vega" }, // not in the library
    { title: "Open floor", description: "", presenter: "" },
  ], "agenda.pdf");

  const items = await listAgendaItems(pool, meetingId);
  assert.equal(items.length, 4);
  assert.deepEqual(items[0].presenter_ids, [janeId]);
  assert.deepEqual(items[1].presenter_ids, [janeId]);
  assert.deepEqual(items[2].presenter_ids, []);
  assert.deepEqual(items[3].presenter_ids, []);

  // Importing an agenda must never add attendees.
  assert.deepEqual(await getAttendeeIds(pool, meetingId), []);

  await reset(pool);
  await pool.end();
});

test("transcription status transitions and speaker stats", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await reset(pool);
  const m = await createMeeting(pool, {
    title: "Board", meetingDate: "", location: "", description: "", email: "", name: "",
  });
  assert.ok(m.ok);
  const meetingId = (m as { ok: true; status: number; id: number }).id;
  const added = await addAgendaItem(pool, meetingId, "Budget", "");
  assert.ok(added.ok);
  const itemId = (added as { ok: true; status: number; id: number }).id;

  // A brand-new item is idle with no error.
  let item = (await getAgendaItem(pool, itemId))!;
  assert.equal(item.transcribe_status, "idle");
  assert.equal(item.transcribe_error, "");
  assert.deepEqual(item.speaker_stats, []);

  await setTranscribeStatus(pool, itemId, "queued");
  assert.deepEqual(await listUnfinishedTranscriptions(pool), [itemId]);

  await setTranscribeStatus(pool, itemId, "processing");
  assert.deepEqual(await listUnfinishedTranscriptions(pool), [itemId]);

  await setTranscribeStatus(pool, itemId, "error", "whisper unreachable");
  item = (await getAgendaItem(pool, itemId))!;
  assert.equal(item.transcribe_status, "error");
  assert.equal(item.transcribe_error, "whisper unreachable");
  assert.deepEqual(await listUnfinishedTranscriptions(pool), []);

  // Moving to done clears the previous error message.
  await setTranscribeStatus(pool, itemId, "done");
  item = (await getAgendaItem(pool, itemId))!;
  assert.equal(item.transcribe_status, "done");
  assert.equal(item.transcribe_error, "");

  // Stats are derived from the stored segments, sorted by talk time.
  await updateAgendaItem(pool, itemId, {
    transcriptSegments: [
      { text: "Short.", speaker: "SPEAKER_00", start: 0, end: 1 },
      { text: "A considerably longer contribution.", speaker: "SPEAKER_01", start: 1, end: 9 },
    ],
    speakerMap: {},
  });
  item = (await getAgendaItem(pool, itemId))!;
  assert.equal(item.speaker_stats.length, 2);
  assert.equal(item.speaker_stats[0].speaker, "SPEAKER_01");
  assert.equal(item.speaker_stats[0].label, "Speaker 2");

  const statuses = await listItemStatuses(pool, meetingId);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].id, itemId);
  assert.equal(statuses[0].transcribeStatus, "done");
  assert.equal(statuses[0].hasSummary, false);

  await updateAgendaItem(pool, itemId, { summary: "We discussed the budget." });
  assert.equal((await listItemStatuses(pool, meetingId))[0].hasSummary, true);

  await reset(pool);
  await pool.end();
});

test("deleteMeeting removes the recordings' audio files", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await reset(pool);
  const m = await createMeeting(pool, { title: "Board", meetingDate: "", location: "", description: "", email: "", name: "" });
  assert.ok(m.ok);
  const meetingId = (m as { ok: true; status: number; id: number }).id;
  const added = await addAgendaItem(pool, meetingId, "Budget", "");
  assert.ok(added.ok);
  const itemId = (added as { ok: true; status: number; id: number }).id;

  const { mkdtemp, writeFile: writeTmp, access } = await import("node:fs/promises");
  const { join: joinPath } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(joinPath(tmpdir(), "mm-rec-"));
  const audioPath = joinPath(dir, "1.webm");
  await writeTmp(audioPath, Buffer.from("fake-audio"));
  await pool.query(
    "INSERT INTO item_recordings (item_id, file_name, mime_type, byte_size, storage_path) VALUES ($1,'a.webm','audio/webm',10,$2)",
    [itemId, audioPath]
  );

  await deleteMeeting(pool, meetingId);
  await assert.rejects(access(audioPath)); // file gone
  assert.equal((await listMeetings(pool)).length, 0);
  await reset(pool);
  await pool.end();
});

test("reportFileName slugs the title and date into a safe filename", () => {
  assert.equal(reportFileName("April Board Meeting", "2026-04-14"), "2026-04-14-april-board-meeting-minutes.md");
  assert.equal(reportFileName("Budget & Finance!!", ""), "budget-finance-minutes.md");
  assert.equal(reportFileName("Board", "Apr 14, 7pm"), "apr-14-7pm-board-minutes.md");
});

test("reportFileName falls back when the title has no usable characters", () => {
  assert.equal(reportFileName("###", ""), "meeting-minutes.md");
  assert.equal(reportFileName("", ""), "meeting-minutes.md");
});

test("meeting recording status, markers and transcript_source", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await reset(pool);
  const m = await createMeeting(pool, { title: "Board", meetingDate: "", location: "", description: "", email: "", name: "" });
  assert.ok(m.ok);
  const meetingId = (m as { ok: true; status: number; id: number }).id;
  const added = await addAgendaItem(pool, meetingId, "Budget", "");
  assert.ok(added.ok);
  const itemId = (added as { ok: true; status: number; id: number }).id;

  let meeting = (await getMeeting(pool, meetingId))!;
  assert.equal(meeting.recording_status, "idle");
  assert.equal(meeting.recording_error, "");
  assert.deepEqual(meeting.speaker_map, {});

  await setMeetingRecordingStatus(pool, meetingId, "queued");
  assert.deepEqual(await listUnfinishedMeetingProcessing(pool), [meetingId]);
  await setMeetingRecordingStatus(pool, meetingId, "error", "whisper down");
  meeting = (await getMeeting(pool, meetingId))!;
  assert.equal(meeting.recording_status, "error");
  assert.equal(meeting.recording_error, "whisper down");
  assert.deepEqual(await listUnfinishedMeetingProcessing(pool), []);
  await setMeetingRecordingStatus(pool, meetingId, "done");
  assert.equal((await getMeeting(pool, meetingId))!.recording_error, "");

  await setMeetingSpeakerMap(pool, meetingId, { SPEAKER_00: "Alice" });
  assert.deepEqual((await getMeeting(pool, meetingId))!.speaker_map, { SPEAKER_00: "Alice" });

  // Markers need a recording row; insert one directly.
  const rec = await pool.query(
    "INSERT INTO meeting_recordings (meeting_id, mime_type, storage_path) VALUES ($1, 'audio/webm', '') RETURNING id",
    [meetingId]
  );
  const recordingId = Number(rec.rows[0].id);
  await addTopicMarker(pool, recordingId, itemId, 12.5);
  await addTopicMarker(pool, recordingId, itemId, 0);
  assert.deepEqual(await listTopicMarkers(pool, recordingId), [
    { itemId, atSeconds: 0 },
    { itemId, atSeconds: 12.5 },
  ]);

  // transcript_source round-trips through updateAgendaItem.
  assert.equal((await getAgendaItem(pool, itemId))!.transcript_source, "");
  await updateAgendaItem(pool, itemId, { transcriptSource: "meeting" });
  assert.equal((await getAgendaItem(pool, itemId))!.transcript_source, "meeting");

  await reset(pool);
  await pool.end();
});

test("meeting chunks append in order and deleteMeeting removes the file", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await reset(pool);
  const m = await createMeeting(pool, { title: "Board", meetingDate: "", location: "", description: "", email: "", name: "" });
  assert.ok(m.ok);
  const meetingId = (m as { ok: true; status: number; id: number }).id;

  const { mkdtemp, writeFile: writeTmp, readFile: readTmp, access } = await import("node:fs/promises");
  const { join: joinPath } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(joinPath(tmpdir(), "mm-mrec-"));
  const audioPath = joinPath(dir, "1.webm");
  await writeTmp(audioPath, Buffer.alloc(0));
  const rec = await pool.query(
    "INSERT INTO meeting_recordings (meeting_id, mime_type, storage_path) VALUES ($1, 'audio/webm', $2) RETURNING id",
    [meetingId, audioPath]
  );
  const recordingId = Number(rec.rows[0].id);

  assert.equal(await appendMeetingChunk(pool, recordingId, Buffer.from("abc")), 3);
  assert.equal(await appendMeetingChunk(pool, recordingId, Buffer.from("def")), 6);
  assert.equal((await readTmp(audioPath)).toString(), "abcdef");
  assert.equal((await getMeetingRecording(pool, recordingId))!.byte_size, 6);
  await assert.rejects(appendMeetingChunk(pool, 999999, Buffer.from("x")));

  await deleteMeeting(pool, meetingId);
  await assert.rejects(access(audioPath));
  await reset(pool);
  await pool.end();
});
