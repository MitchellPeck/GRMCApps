import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { createQueue, saveTranscriptionResult, TranscribeJob, QueueDeps } from "./transcribeQueue";
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
  const q = createQueue(deps);
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
  const q = createQueue(deps);
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
  const q = createQueue(deps);
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
  const q = createQueue(deps);
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
  const q = createQueue(deps);
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
  const q = createQueue(deps);
  q.enqueue(job(1));
  await q.idle();
  assert.deepEqual(seen.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_00", "SPEAKER_00"]);
});

test("idle resolves immediately when nothing is queued", async () => {
  const { deps } = spyDeps();
  const q = createQueue(deps);
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
  const q = createQueue(deps);
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

  const after = await pool.query("SELECT transcript, summary, action_items, status FROM agenda_items WHERE id = $1", [itemId]);
  assert.equal(after.rows[0].transcript, "Speaker 1: New content.");
  assert.equal(after.rows[0].summary, "");
  assert.deepEqual(after.rows[0].action_items, []);
  assert.equal(after.rows[0].status, "pending");
  await pool.query("DELETE FROM meetings");
  await pool.end();
});
