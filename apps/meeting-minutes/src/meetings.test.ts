import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { addPerson, listPeople } from "./people";
import {
  createMeeting, listMeetings, getMeeting, updateMeeting, deleteMeeting,
  setAttendees, getAttendeeIds, replaceAgendaItems, addAgendaItem,
  listAgendaItems, getAgendaItem, updateAgendaItem, deleteAgendaItem, saveReport,
} from "./meetings";

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
