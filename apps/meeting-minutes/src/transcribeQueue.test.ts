import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import {
  createQueue, createItemQueue, saveTranscriptionResult, TranscribeJob, QueueDeps,
  MeetingJob, MeetingDeps, runMeetingJob, QueueTask,
} from "./transcribeQueue";
import { DiarizedSegment, TranscriptionResult } from "./whisper";
import { SpeakerMap } from "./transcript";

const url = process.env.TEST_DATABASE_URL;

const job = (itemId: number): TranscribeJob =>
  ({ itemId, recordingId: itemId * 10, path: `/data/audio/${itemId}/1.webm`, fileName: "a.webm", mimeType: "audio/webm" });

const seg = (text: string, speaker: string, start: number, end: number): DiarizedSegment =>
  ({ text, speaker, start, end });

function spyDeps(over: Partial<QueueDeps> = {}) {
  const events: string[] = [];
  const saved: Array<{ itemId: number; segments: DiarizedSegment[]; map: SpeakerMap }> = [];
  const deps: QueueDeps = {
    transcribe: async (j) => { events.push(`transcribe:${j.itemId}`); return { text: "", segments: [] }; },
    reconcile: async () => ({}),
    setStatus: async (itemId, status, error) => { events.push(`status:${itemId}:${status}${error ? `:${error}` : ""}`); },
    saveResult: async (j, segments, map) => { events.push(`save:${j.itemId}`); saved.push({ itemId: j.itemId, segments, map }); },
    log: () => {},
    ...over,
  };
  return { deps, events, saved };
}

test("a job runs through processing to done and saves its result", async () => {
  const { deps, events } = spyDeps();
  const q = createItemQueue(deps);
  q.enqueue(job(1));
  await q.idle();
  assert.deepEqual(events, ["status:1:processing", "transcribe:1", "save:1", "status:1:done"]);
  assert.equal(q.size(), 0);
});

test("jobs run strictly one at a time", async () => {
  let active = 0;
  let maxActive = 0;
  const { deps, events } = spyDeps({
    transcribe: async (j): Promise<TranscriptionResult> => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { text: "", segments: [seg("x", "SPEAKER_00", 0, 1)] };
    },
  });
  const q = createItemQueue(deps);
  q.enqueue(job(1)); q.enqueue(job(2)); q.enqueue(job(3));
  await q.idle();
  assert.equal(maxActive, 1);
  assert.deepEqual(events.filter((e) => e.endsWith(":done")), ["status:1:done", "status:2:done", "status:3:done"]);
});

test("a transcription failure marks the item as error and the queue continues", async () => {
  const { deps, events } = spyDeps({
    transcribe: async (j) => {
      if (j.itemId === 1) throw new Error("whisper unreachable");
      return { text: "", segments: [] };
    },
  });
  const q = createItemQueue(deps);
  q.enqueue(job(1)); q.enqueue(job(2));
  await q.idle();
  assert.ok(events.includes("status:1:error:whisper unreachable"));
  assert.ok(!events.includes("save:1"));
  assert.ok(events.includes("status:2:done"));
});

test("a reconciliation failure degrades to raw labels without failing the job", async () => {
  const { deps, events, saved } = spyDeps({
    transcribe: async (): Promise<TranscriptionResult> => ({ text: "", segments: [seg("hi", "SPEAKER_00", 0, 2)] }),
    reconcile: async () => { throw new Error("no api key"); },
  });
  const q = createItemQueue(deps);
  q.enqueue(job(1));
  await q.idle();
  assert.ok(events.includes("status:1:done"));
  assert.deepEqual(saved[0].map, {});
});

test("micro-turns are absorbed before the result is saved", async () => {
  const { deps, saved } = spyDeps({
    transcribe: async (): Promise<TranscriptionResult> => ({
      text: "",
      segments: [
        seg("So the budget for the year", "SPEAKER_00", 0, 4),
        seg("is about", "SPEAKER_01", 4, 4.6),
        seg("twelve thousand dollars.", "SPEAKER_00", 4.6, 8),
      ],
    }),
  });
  const q = createItemQueue(deps);
  q.enqueue(job(1));
  await q.idle();
  assert.deepEqual(saved[0].segments.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_00", "SPEAKER_00"]);
});

test("reconcile sees the already-absorbed segments", async () => {
  let seen: DiarizedSegment[] = [];
  const { deps } = spyDeps({
    transcribe: async (): Promise<TranscriptionResult> => ({
      text: "",
      segments: [
        seg("a", "SPEAKER_00", 0, 4),
        seg("b", "SPEAKER_01", 4, 4.5),
        seg("c", "SPEAKER_00", 4.5, 8),
      ],
    }),
    reconcile: async (_j, segments) => { seen = segments; return {}; },
  });
  const q = createItemQueue(deps);
  q.enqueue(job(1));
  await q.idle();
  assert.deepEqual(seen.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_00", "SPEAKER_00"]);
});

test("idle resolves immediately when nothing is queued", async () => {
  const { deps } = spyDeps();
  const q = createItemQueue(deps);
  await q.idle();
  assert.equal(q.size(), 0);
});

test("a throwing log dep never corrupts status or stops the queue", async () => {
  const { deps, events } = spyDeps({
    log: () => { throw new Error("EPIPE"); },
    transcribe: async (j): Promise<TranscriptionResult> => {
      if (j.itemId === 1) throw new Error("whisper unreachable");
      return { text: "", segments: [seg("x", "SPEAKER_00", 0, 1)] };
    },
  });
  const q = createItemQueue(deps);
  q.enqueue(job(1)); q.enqueue(job(2));
  await q.idle();
  assert.ok(events.includes("status:1:error:whisper unreachable"));
  assert.ok(events.includes("status:2:done"));
  assert.ok(!events.some((e) => e.startsWith("status:2:error")));
});

test("saveTranscriptionResult clears a stale summary with the new transcript", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await pool.query("DELETE FROM meetings");
  const meeting = await pool.query(
    "INSERT INTO meetings (title) VALUES ('Board') RETURNING id"
  );
  const meetingId = Number(meeting.rows[0].id);
  const item = await pool.query(
    "INSERT INTO agenda_items (meeting_id, position, title, summary, action_items, status) VALUES ($1, 0, 'Budget', 'old summary', '[{\"task\":\"x\",\"owner\":\"y\"}]', 'done') RETURNING id",
    [meetingId]
  );
  const itemId = Number(item.rows[0].id);

  await saveTranscriptionResult(itemId, [
    { text: "New content.", speaker: "SPEAKER_00", start: 0, end: 2 },
  ], {}, pool);

  const after = await pool.query("SELECT transcript, summary, action_items, status, transcript_source FROM agenda_items WHERE id = $1", [itemId]);
  assert.equal(after.rows[0].transcript, "Speaker 1: New content.");
  assert.equal(after.rows[0].summary, "");
  assert.deepEqual(after.rows[0].action_items, []);
  assert.equal(after.rows[0].status, "pending");
  assert.equal(after.rows[0].transcript_source, "topic");
  await pool.query("DELETE FROM meetings");
  await pool.end();
});

const mjob = (meetingId: number): MeetingJob =>
  ({ meetingId, recordingId: meetingId * 10, path: `/data/audio/meeting-${meetingId}/1.webm`, mimeType: "audio/webm" });

function meetingSpyDeps(over: Partial<MeetingDeps> = {}) {
  const events: string[] = [];
  const saved: Array<{ itemId: number; segments: DiarizedSegment[]; map: SpeakerMap; order: string[] }> = [];
  const maps: SpeakerMap[] = [];
  const deps: MeetingDeps = {
    transcribe: async () => ({ text: "", segments: [] }),
    reconcile: async () => ({}),
    setStatus: async (id, status, error) => { events.push(`status:${id}:${status}${error ? `:${error}` : ""}`); },
    loadMarkers: async () => [],
    fallbackItemId: async () => 500,
    presenterFor: async () => "",
    saveItem: async (itemId, segments, map, order) => { saved.push({ itemId, segments, map, order }); events.push(`save:${itemId}`); },
    saveMeetingMap: async (_id, map) => { maps.push(map); events.push("map"); },
    log: () => {},
    ...over,
  };
  return { deps, events, saved, maps };
}

test("runMeetingJob segments by markers and writes every topic with one map and order", async () => {
  const { deps, events, saved, maps } = meetingSpyDeps({
    transcribe: async () => ({ text: "", segments: [
      seg("intro", "SPEAKER_00", 0, 10),
      seg("budget", "SPEAKER_01", 12, 20),
      seg("missions", "SPEAKER_00", 32, 40),
    ] }),
    reconcile: async () => ({ SPEAKER_00: "Alice Smith" }),
    loadMarkers: async () => [
      { itemId: 7, atSeconds: 2 },
      { itemId: 9, atSeconds: 30 },
    ],
  });
  await runMeetingJob(deps, mjob(1));
  assert.deepEqual(events[0], "status:1:processing");
  assert.ok(events.includes("save:7") && events.includes("save:9"));
  assert.equal(events[events.length - 1], "status:1:done");
  assert.equal(saved.length, 2);
  const seven = saved.find((s) => s.itemId === 7)!;
  assert.deepEqual(seven.segments.map((s) => s.text), ["intro", "budget"]);
  for (const s of saved) {
    assert.deepEqual(s.map, { SPEAKER_00: "Alice Smith" });
    assert.deepEqual(s.order, ["SPEAKER_00", "SPEAKER_01"]);
  }
  assert.deepEqual(maps, [{ SPEAKER_00: "Alice Smith" }]);
});

test("runMeetingJob degrades to raw labels when reconciliation fails", async () => {
  const { deps, events, saved } = meetingSpyDeps({
    transcribe: async () => ({ text: "", segments: [seg("x", "SPEAKER_00", 0, 5)] }),
    reconcile: async () => { throw new Error("no key"); },
    loadMarkers: async () => [{ itemId: 3, atSeconds: 0 }],
  });
  await runMeetingJob(deps, mjob(2));
  assert.ok(events.includes("status:2:done"));
  assert.deepEqual(saved[0].map, {});
});

test("runMeetingJob without markers uses the fallback item", async () => {
  const { deps, saved } = meetingSpyDeps({
    transcribe: async () => ({ text: "", segments: [seg("x", "SPEAKER_00", 0, 5)] }),
  });
  await runMeetingJob(deps, mjob(3));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].itemId, 500);
});

test("runMeetingJob fills each topic's presenter onto its dominant unnamed voice", async () => {
  const { deps, saved } = meetingSpyDeps({
    transcribe: async () => ({ text: "", segments: [
      seg("a long stretch", "SPEAKER_00", 0, 20),
      seg("short reply", "SPEAKER_01", 20, 22),
      seg("second topic talk", "SPEAKER_01", 40, 60),
    ] }),
    loadMarkers: async () => [
      { itemId: 1, atSeconds: 0 },
      { itemId: 2, atSeconds: 30 },
    ],
    presenterFor: async (itemId) => (itemId === 2 ? "Bob Jones" : ""),
  });
  await runMeetingJob(deps, mjob(4));
  assert.deepEqual(saved.find((s) => s.itemId === 2)!.map, { SPEAKER_01: "Bob Jones" });
});

test("a throwing log dep never flips a finished meeting job to error", async () => {
  const { deps, events } = meetingSpyDeps({
    transcribe: async () => ({ text: "", segments: [seg("x", "SPEAKER_00", 0, 5)] }),
    log: () => { throw new Error("EPIPE"); },
  });
  await runMeetingJob(deps, mjob(6));
  assert.ok(events.includes("status:6:done"));
  assert.ok(!events.some((e) => e.startsWith("status:6:error")));
});

test("the generic queue runs meeting and item tasks strictly serially and survives failures", async () => {
  const order: string[] = [];
  const q = createQueue(() => {});
  let active = 0, maxActive = 0;
  const mk = (label: string, fails: boolean): QueueTask => ({
    label,
    run: async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      order.push(label);
      if (fails) throw new Error("boom");
    },
    fail: async (m) => { order.push(`${label}:fail:${m}`); },
  });
  q.enqueue(mk("a", false)); q.enqueue(mk("b", true)); q.enqueue(mk("c", false));
  await q.idle();
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["a", "b", "b:fail:boom", "c"]);
});
