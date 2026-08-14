# Whole-Meeting Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One recording for the entire meeting, topic markers laid down by the clicks the user already makes, whole-meeting diarization segmented back onto agenda items at processing time, and one meeting-wide speaker-naming panel.

**Architecture:** The existing serial transcription queue generalizes to a runner of `{run, fail}` tasks so a new meeting-level pipeline (transcribe whole file → absorb micro-turns → one Claude reconciliation → marker segmentation → per-item writes with a meeting-wide speaker order) shares the same single-consumer lane as per-topic jobs. Capture is client-driven: `MediaRecorder` with a 20s timeslice, chunks appended server-side so a crash loses seconds. Naming moves up a level: `meetings.speaker_map` + one panel; saving rewrites every meeting-sourced item transactionally.

**Tech Stack:** unchanged — TypeScript 5.6 strict/CommonJS, Fastify 5, pg, node:test, vanilla ES5 browser JS, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-14-whole-meeting-recording-design.md`

## Global Constraints

- All work inside `apps/meeting-minutes/`. No new npm dependencies.
- Tests: `node:test` + `node:assert/strict`, compiled first. Full suite: `npm test`. Every command needs the dummy env prefix `MEETINGMINUTES_DB_USER=x MEETINGMINUTES_DB_PASSWORD=x MEETINGMINUTES_DB_NAME=x`; DB-gated tests additionally need `TEST_DATABASE_URL` and use `{ skip: !url }`. Never write a test needing live network.
- Browser code in `src/public/app.js` is ES5 only: `var`, `function(){}`, no arrows/template literals/const/let/destructuring. Every user-supplied string interpolated into HTML goes through `esc()`.
- Browser verification is deferred to the user's acceptance pass (established ruling): frontend tasks verify via `node --check src/public/app.js`, a green suite, and a written line-by-line trace of the listed behaviors.
- The queue stays strictly serial across ALL job kinds — never two whisper calls at once.
- Meeting recordings and their files are never deleted except by meeting deletion. Reprocessing replaces meeting-sourced item transcripts.
- No auto-summary fires when the meeting job settles; items arrive `done` + `Needs summary` and summarize through the existing gate (close / Generate report).
- `pollGen` staleness semantics must be preserved by every poller change.
- Speaker-label numbering for meeting-sourced items uses the meeting-wide chronological first-appearance order in BOTH transcripts and the meeting panel.
- Commit per task: `type(meeting-minutes): subject`.

---

### Task 1: Schema and meeting-recording accessors

**Files:**
- Modify: `apps/meeting-minutes/src/schema.ts`
- Modify: `apps/meeting-minutes/src/meetings.ts`
- Test: `apps/meeting-minutes/src/meetings.test.ts`

**Interfaces:**
- Consumes: existing schema/meetings patterns.
- Produces, exported from `./meetings`: `type MeetingRecordingStatus = "idle" | "recording" | "queued" | "processing" | "done" | "error"`; `MeetingRow` gains `recording_status: MeetingRecordingStatus`, `recording_error: string`, `speaker_map: SpeakerMap`; `AgendaItem` gains `transcript_source: string`; `updateAgendaItem` accepts `transcriptSource?: string`; `setMeetingRecordingStatus(pool, meetingId, status, error?)`; `listUnfinishedMeetingProcessing(pool): Promise<number[]>`; `addTopicMarker(pool, recordingId, itemId, atSeconds)`; `listTopicMarkers(pool, recordingId): Promise<Array<{itemId: number; atSeconds: number}>>`; `setMeetingSpeakerMap(pool, meetingId, map)`.

- [ ] **Step 1: Write the failing test**

Append to `apps/meeting-minutes/src/meetings.test.ts` (add the new names to the existing `./meetings` import):

```typescript
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
```

- [ ] **Step 2: Run to verify it fails**

`cd apps/meeting-minutes && npx tsc` (with env prefix) — Expected: FAIL, `'"./meetings"' has no exported member 'setMeetingRecordingStatus'`.

- [ ] **Step 3: Schema**

In `apps/meeting-minutes/src/schema.ts`:

Inside `CREATE TABLE IF NOT EXISTS meetings (...)`, after `report_generated_at timestamptz,` add:

```sql
  recording_status    text NOT NULL DEFAULT 'idle',
  recording_error     text NOT NULL DEFAULT '',
  speaker_map         jsonb NOT NULL DEFAULT '{}',
```

Inside `CREATE TABLE IF NOT EXISTS agenda_items (...)`, after the `transcribe_finished_at` line add:

```sql
  transcript_source  text NOT NULL DEFAULT '',
```

Next to the existing ALTER migration blocks add:

```sql
-- Migrate existing installs to whole-meeting recording.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recording_status text NOT NULL DEFAULT 'idle';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recording_error text NOT NULL DEFAULT '';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS speaker_map jsonb NOT NULL DEFAULT '{}';
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS transcript_source text NOT NULL DEFAULT '';
```

Before the trailing `agenda_items_meeting_idx` index line add:

```sql
-- One audio file per whole-meeting recording session. Chunks are appended as
-- they arrive; files live on the minutesdata volume and are removed only when
-- the meeting is deleted.
CREATE TABLE IF NOT EXISTS meeting_recordings (
  id            bigserial PRIMARY KEY,
  meeting_id    bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  mime_type     text NOT NULL DEFAULT '',
  byte_size     bigint NOT NULL DEFAULT 0,
  storage_path  text NOT NULL DEFAULT '',
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS meeting_recordings_meeting_idx ON meeting_recordings (meeting_id, id);

-- Topic switches observed while recording: "at second N the meeting moved to
-- item X". Processing turns these into per-item audio windows.
CREATE TABLE IF NOT EXISTS topic_markers (
  id            bigserial PRIMARY KEY,
  recording_id  bigint NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE,
  item_id       bigint NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  at_seconds    double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS topic_markers_recording_idx ON topic_markers (recording_id, at_seconds);
```

- [ ] **Step 4: Accessors**

In `apps/meeting-minutes/src/meetings.ts`:

Add above `MeetingRow`:

```typescript
export type MeetingRecordingStatus = "idle" | "recording" | "queued" | "processing" | "done" | "error";
```

Add to the `MeetingRow` interface after `report_generated_at`:

```typescript
  recording_status: MeetingRecordingStatus;
  recording_error: string;
  speaker_map: SpeakerMap;
```

In `getMeeting`, replace the return with a normalized row (jsonb arrives parsed; guard shape):

```typescript
  const row = r.rows[0];
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    recording_status: (row.recording_status ?? "idle") as MeetingRecordingStatus,
    recording_error: row.recording_error ?? "",
    speaker_map: row.speaker_map && typeof row.speaker_map === "object" ? row.speaker_map : {},
  };
```

Add `transcript_source: string;` to `AgendaItem` (after `speaker_stats`), and in `mapItemRow` add `transcript_source: row.transcript_source ?? "",`.

In `updateAgendaItem`'s fields type add `transcriptSource?: string;` and in the body, next to the `status` handling, add:

```typescript
    if (fields.transcriptSource !== undefined) add("transcript_source", fields.transcriptSource);
```

Append to the file:

```typescript
// ── Whole-meeting recording state ───────────────────────────────────────────

// Any status other than `error` clears the stored error message.
export async function setMeetingRecordingStatus(
  pool: Pool,
  meetingId: number,
  status: MeetingRecordingStatus,
  error = ""
): Promise<void> {
  await pool.query(
    `UPDATE meetings
        SET recording_status = $2,
            recording_error  = CASE WHEN $2 = 'error' THEN $3 ELSE '' END,
            updated_at = now()
      WHERE id = $1`,
    [meetingId, status, error]
  );
}

// Meetings whose whole-recording processing never finished — used on boot to
// re-enqueue work a restart interrupted.
export async function listUnfinishedMeetingProcessing(pool: Pool): Promise<number[]> {
  const r = await pool.query(
    "SELECT id FROM meetings WHERE recording_status IN ('queued','processing') ORDER BY id"
  );
  return r.rows.map((row) => Number(row.id));
}

export async function addTopicMarker(
  pool: Pool,
  recordingId: number,
  itemId: number,
  atSeconds: number
): Promise<void> {
  await pool.query(
    "INSERT INTO topic_markers (recording_id, item_id, at_seconds) VALUES ($1, $2, $3)",
    [recordingId, itemId, atSeconds]
  );
}

export async function listTopicMarkers(
  pool: Pool,
  recordingId: number
): Promise<Array<{ itemId: number; atSeconds: number }>> {
  const r = await pool.query(
    "SELECT item_id, at_seconds FROM topic_markers WHERE recording_id = $1 ORDER BY at_seconds, id",
    [recordingId]
  );
  return r.rows.map((row) => ({ itemId: Number(row.item_id), atSeconds: Number(row.at_seconds) }));
}

export async function setMeetingSpeakerMap(pool: Pool, meetingId: number, map: SpeakerMap): Promise<void> {
  await pool.query("UPDATE meetings SET speaker_map = $2, updated_at = now() WHERE id = $1", [
    meetingId,
    JSON.stringify(map),
  ]);
}
```

- [ ] **Step 5: Re-apply schema, run**

Re-apply SCHEMA_SQL to the test DB (the usual node one-liner), then `npm test` with both env prefixes. Expected: PASS, 81 total / 0 fail.

- [ ] **Step 6: Commit** — `feat(meeting-minutes): add whole-meeting recording schema and accessors`

---

### Task 2: Marker segmentation and meeting-wide speaker order

**Files:**
- Create: `apps/meeting-minutes/src/segmentation.ts`
- Create: `apps/meeting-minutes/src/segmentation.test.ts`
- Modify: `apps/meeting-minutes/src/transcript.ts` (`renderTranscript` optional order)
- Modify: `apps/meeting-minutes/src/meetings.ts` (`updateAgendaItem` gains `speakerOrder`)
- Test: `apps/meeting-minutes/src/transcript.test.ts`

**Interfaces:**
- Produces: `renderTranscript(segments, map, order?: string[])` — when `order` is a non-empty array it replaces the derived first-appearance order (fallback numbering AND the unlabelled-segment default speaker). `updateAgendaItem` accepts `speakerOrder?: string[]`, passed straight to `renderTranscript`. From `./segmentation`: `interface TopicMarker { itemId: number; atSeconds: number }`, `segmentByMarkers(segments, markers, fallbackItemId): Map<number, DiarizedSegment[]>`, `chronologicalSpeakerOrder(itemSegments: DiarizedSegment[][]): string[]`.

- [ ] **Step 1: Failing tests**

Create `apps/meeting-minutes/src/segmentation.test.ts`:

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { segmentByMarkers, chronologicalSpeakerOrder } from "./segmentation";
import { DiarizedSegment } from "./whisper";

const seg = (text: string, speaker: string, start: number, end: number): DiarizedSegment =>
  ({ text, speaker, start, end });

test("segmentByMarkers windows segments by midpoint between markers", () => {
  const segments = [
    seg("intro", "SPEAKER_00", 0, 10),
    seg("budget one", "SPEAKER_00", 12, 20),
    seg("budget two", "SPEAKER_01", 20, 28),
    seg("missions", "SPEAKER_00", 32, 40),
  ];
  const out = segmentByMarkers(segments, [
    { itemId: 7, atSeconds: 2 },
    { itemId: 9, atSeconds: 30 },
  ], 99);
  assert.deepEqual([...out.keys()].sort(), [7, 9]);
  assert.deepEqual(out.get(7)!.map((s) => s.text), ["intro", "budget one", "budget two"]);
  assert.deepEqual(out.get(9)!.map((s) => s.text), ["missions"]);
});

test("segmentByMarkers sends pre-first-marker audio to the first marker's topic", () => {
  const segments = [seg("early", "SPEAKER_00", 0, 4), seg("later", "SPEAKER_00", 60, 70)];
  const out = segmentByMarkers(segments, [{ itemId: 5, atSeconds: 50 }], 99);
  assert.deepEqual(out.get(5)!.map((s) => s.text), ["early", "later"]);
});

test("segmentByMarkers with no markers sends everything to the fallback item", () => {
  const segments = [seg("a", "SPEAKER_00", 0, 5)];
  const out = segmentByMarkers(segments, [], 42);
  assert.deepEqual(out.get(42)!.map((s) => s.text), ["a"]);
  assert.deepEqual(segmentByMarkers([], [], 42).size, 0);
});

test("segmentByMarkers concatenates windows when a topic is revisited", () => {
  const segments = [
    seg("first visit", "SPEAKER_00", 0, 8),
    seg("interlude", "SPEAKER_01", 12, 18),
    seg("second visit", "SPEAKER_00", 22, 30),
  ];
  const out = segmentByMarkers(segments, [
    { itemId: 1, atSeconds: 0 },
    { itemId: 2, atSeconds: 10 },
    { itemId: 1, atSeconds: 20 },
  ], 99);
  assert.deepEqual(out.get(1)!.map((s) => s.text), ["first visit", "second visit"]);
  assert.deepEqual(out.get(2)!.map((s) => s.text), ["interlude"]);
});

test("segmentByMarkers boundary: a midpoint exactly on a marker belongs to that marker", () => {
  const segments = [seg("edge", "SPEAKER_00", 8, 12)]; // midpoint 10
  const out = segmentByMarkers(segments, [
    { itemId: 1, atSeconds: 0 },
    { itemId: 2, atSeconds: 10 },
  ], 99);
  assert.deepEqual([...out.keys()], [2]);
});

test("chronologicalSpeakerOrder orders by first appearance across all items", () => {
  const itemA = [seg("late", "SPEAKER_02", 30, 35)];
  const itemB = [seg("first", "SPEAKER_01", 0, 5), seg("second", "SPEAKER_00", 5, 9)];
  assert.deepEqual(chronologicalSpeakerOrder([itemA, itemB]), ["SPEAKER_01", "SPEAKER_00", "SPEAKER_02"]);
  assert.deepEqual(chronologicalSpeakerOrder([]), []);
});
```

Append to `apps/meeting-minutes/src/transcript.test.ts`:

```typescript
test("renderTranscript numbers unmapped speakers from an explicit meeting-wide order", () => {
  const segs = [seg("Hi.", "SPEAKER_03")];
  assert.equal(renderTranscript(segs, {}, ["SPEAKER_00", "SPEAKER_03"]), "Speaker 2: Hi.");
  // Without the explicit order, local numbering applies.
  assert.equal(renderTranscript(segs, {}), "Speaker 1: Hi.");
});
```

- [ ] **Step 2: RED** — `npx tsc` fails: no module `./segmentation`; `renderTranscript` takes 2 args.

- [ ] **Step 3: Implement**

`apps/meeting-minutes/src/transcript.ts` — change `renderTranscript`'s signature and the two `order` uses:

```typescript
export function renderTranscript(
  segments: DiarizedSegment[],
  map: SpeakerMap,
  order?: string[]
): string {
  if (!segments.length) return "";
  const ord = order && order.length ? order : distinctSpeakers(segments);
  if (!ord.length) {
    return segments.map((s) => s.text).join(" ").trim();
  }
  const lines: string[] = [];
  let curName: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (curName === null || !buf.length) return;
    lines.push(`${curName}: ${buf.join(" ").trim()}`);
    buf = [];
  };
  for (const s of segments) {
    const spk = s.speaker || (ord[0] ?? "SPEAKER_00");
    const name = resolveSpeakerName(spk, map, ord);
    if (name !== curName) { flush(); curName = name; }
    buf.push(s.text);
  }
  flush();
  return lines.join("\n");
}
```

Create `apps/meeting-minutes/src/segmentation.ts`:

```typescript
import { DiarizedSegment } from "./whisper";
import { distinctSpeakers } from "./transcript";

export interface TopicMarker {
  itemId: number;
  atSeconds: number;
}

// Assign whole-meeting segments to agenda items using the topic markers laid
// down while recording. Sorted markers define windows [at_i, at_{i+1}); a
// segment belongs to the window holding its midpoint. Audio before the first
// marker belongs to the first marker's item; with no markers at all everything
// belongs to fallbackItemId. Revisited topics concatenate in time order.
export function segmentByMarkers(
  segments: DiarizedSegment[],
  markers: TopicMarker[],
  fallbackItemId: number
): Map<number, DiarizedSegment[]> {
  const out = new Map<number, DiarizedSegment[]>();
  const sorted = [...markers].sort((a, b) => a.atSeconds - b.atSeconds);
  if (!sorted.length) {
    if (segments.length) out.set(fallbackItemId, [...segments]);
    return out;
  }
  for (const s of segments) {
    const mid = (s.start + s.end) / 2;
    let owner = sorted[0].itemId;
    for (const m of sorted) {
      if (m.atSeconds <= mid) owner = m.itemId;
      else break;
    }
    if (!out.has(owner)) out.set(owner, []);
    out.get(owner)!.push(s);
  }
  return out;
}

// First-appearance speaker order across the chronological concatenation of
// every item's segments — the meeting-wide "Speaker N" numbering.
export function chronologicalSpeakerOrder(itemSegments: DiarizedSegment[][]): string[] {
  const all = itemSegments.flat().slice().sort((a, b) => a.start - b.start);
  return distinctSpeakers(all);
}
```

`apps/meeting-minutes/src/meetings.ts` — `updateAgendaItem` fields gain `speakerOrder?: string[];` and the render call becomes:

```typescript
      add("transcript", renderTranscript(segs, map, fields.speakerOrder));
```

- [ ] **Step 4: GREEN** — `node --test dist/segmentation.test.js` and `dist/transcript.test.js` pass; full suite 88 (with DB) / 0 fail.

- [ ] **Step 5: Commit** — `feat(meeting-minutes): segment whole-meeting audio by topic markers`

---

### Task 3: Meeting-recording file layer

**Files:**
- Modify: `apps/meeting-minutes/src/recordings.ts`
- Modify: `apps/meeting-minutes/src/meetings.ts` (`deleteMeeting`)
- Test: `apps/meeting-minutes/src/recordings.test.ts`, `apps/meeting-minutes/src/meetings.test.ts`

**Interfaces:**
- Produces, exported from `./recordings`: `interface MeetingRecording { id; meeting_id; mime_type; byte_size; storage_path; started_at: string; finished_at: string | null }`; `meetingRecordingPath(root, meetingId, recordingId, ext)`; `createMeetingRecording(pool, meetingId, mimeType): Promise<MeetingRecording>` (insert row → derive path → mkdir → create empty file → update path); `appendMeetingChunk(pool, recordingId, buffer): Promise<number>` (append + byte_size accumulate; throws "Recording not found." on a missing row); `finishMeetingRecording(pool, recordingId)`; `getMeetingRecording`, `latestMeetingRecording(pool, meetingId)`, `listMeetingRecordings(pool, meetingId)`; `removeMeetingRecordingFiles(pool, meetingId)`.
- `deleteMeeting` additionally calls `removeMeetingRecordingFiles` before the row delete.

- [ ] **Step 1: Failing tests**

Append to `apps/meeting-minutes/src/recordings.test.ts` (import `meetingRecordingPath`):

```typescript
test("meetingRecordingPath nests by meeting id", () => {
  assert.equal(meetingRecordingPath("/data", 4, 11, "webm"), "/data/audio/meeting-4/11.webm");
});
```

Append to `apps/meeting-minutes/src/meetings.test.ts` (needs `appendMeetingChunk`, `getMeetingRecording` from `./recordings` and node:fs/promises pieces as shown):

```typescript
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
```

- [ ] **Step 2: RED** — tsc: missing exports.

- [ ] **Step 3: Implement**

Append to `apps/meeting-minutes/src/recordings.ts` (extend the fs/promises import with `appendFile`):

```typescript
export interface MeetingRecording {
  id: number;
  meeting_id: number;
  mime_type: string;
  byte_size: number;
  storage_path: string;
  started_at: string;
  finished_at: string | null;
}

export function meetingRecordingPath(root: string, meetingId: number, recordingId: number, ext: string): string {
  return join(root, "audio", `meeting-${meetingId}`, `${recordingId}.${ext}`);
}

function rowToMeetingRecording(row: any): MeetingRecording {
  return {
    id: Number(row.id),
    meeting_id: Number(row.meeting_id),
    mime_type: row.mime_type,
    byte_size: Number(row.byte_size),
    storage_path: row.storage_path,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
  };
}

// Create the recording row and its (empty) file up front; chunks append to it.
export async function createMeetingRecording(
  pool: Pool,
  meetingId: number,
  mimeType: string
): Promise<MeetingRecording> {
  const inserted = await pool.query(
    "INSERT INTO meeting_recordings (meeting_id, mime_type) VALUES ($1, $2) RETURNING id",
    [meetingId, mimeType || ""]
  );
  const id = Number(inserted.rows[0].id);
  const path = meetingRecordingPath(config.dataDir, meetingId, id, extensionFor("", mimeType));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.alloc(0));
  const updated = await pool.query(
    "UPDATE meeting_recordings SET storage_path = $2 WHERE id = $1 RETURNING *",
    [id, path]
  );
  return rowToMeetingRecording(updated.rows[0]);
}

export async function appendMeetingChunk(pool: Pool, recordingId: number, buffer: Buffer): Promise<number> {
  const r = await pool.query("SELECT storage_path FROM meeting_recordings WHERE id = $1", [recordingId]);
  const row = r.rows[0];
  if (!row || !row.storage_path) throw new Error("Recording not found.");
  await appendFile(row.storage_path, buffer);
  const upd = await pool.query(
    "UPDATE meeting_recordings SET byte_size = byte_size + $2 WHERE id = $1 RETURNING byte_size",
    [recordingId, buffer.byteLength]
  );
  return Number(upd.rows[0].byte_size);
}

export async function finishMeetingRecording(pool: Pool, recordingId: number): Promise<void> {
  await pool.query("UPDATE meeting_recordings SET finished_at = now() WHERE id = $1", [recordingId]);
}

export async function getMeetingRecording(pool: Pool, recordingId: number): Promise<MeetingRecording | null> {
  const r = await pool.query("SELECT * FROM meeting_recordings WHERE id = $1", [recordingId]);
  return r.rows[0] ? rowToMeetingRecording(r.rows[0]) : null;
}

export async function latestMeetingRecording(pool: Pool, meetingId: number): Promise<MeetingRecording | null> {
  const r = await pool.query(
    "SELECT * FROM meeting_recordings WHERE meeting_id = $1 ORDER BY id DESC LIMIT 1",
    [meetingId]
  );
  return r.rows[0] ? rowToMeetingRecording(r.rows[0]) : null;
}

export async function listMeetingRecordings(pool: Pool, meetingId: number): Promise<MeetingRecording[]> {
  const r = await pool.query(
    "SELECT * FROM meeting_recordings WHERE meeting_id = $1 ORDER BY id",
    [meetingId]
  );
  return r.rows.map(rowToMeetingRecording);
}

// Best-effort file cleanup, meeting-level analogue of removeRecordingFiles.
export async function removeMeetingRecordingFiles(pool: Pool, meetingId: number): Promise<void> {
  const r = await pool.query("SELECT storage_path FROM meeting_recordings WHERE meeting_id = $1", [meetingId]);
  for (const row of r.rows) {
    if (row.storage_path) {
      try { await unlink(row.storage_path); } catch { /* already gone */ }
    }
  }
  try { await rmdir(join(config.dataDir, "audio", `meeting-${meetingId}`)); } catch { /* not empty or missing */ }
}
```

In `apps/meeting-minutes/src/meetings.ts`, extend the recordings import with `removeMeetingRecordingFiles` and make `deleteMeeting`:

```typescript
export async function deleteMeeting(pool: Pool, id: number): Promise<void> {
  const items = await pool.query("SELECT id FROM agenda_items WHERE meeting_id = $1", [id]);
  await removeRecordingFiles(pool, items.rows.map((r) => Number(r.id)));
  await removeMeetingRecordingFiles(pool, id);
  await pool.query("DELETE FROM meetings WHERE id = $1", [id]);
}
```

- [ ] **Step 4: GREEN** — full suite 89 (with DB) / 0 fail.
- [ ] **Step 5: Commit** — `feat(meeting-minutes): store whole-meeting recordings as appended chunks`

---

### Task 4: Generic queue and the meeting processing pipeline

**Files:**
- Modify: `apps/meeting-minutes/src/transcribeQueue.ts`
- Modify: `apps/meeting-minutes/src/transcribeQueue.test.ts`
- Modify: `apps/meeting-minutes/src/index.ts`

**Interfaces:**
- Produces, exported from `./transcribeQueue`:
  - `interface QueueTask { label: string; run(): Promise<void>; fail(message: string): Promise<void> }`; `createQueue(log): Queue` now takes a log fn and enqueues `QueueTask`s (still strictly serial, still `size()`/`idle()`; a task whose `run` throws gets `fail(message)` called, guarded, and the queue continues; a throwing `log` is always swallowed).
  - `createItemQueue(deps: QueueDeps): { enqueue(job: TranscribeJob); size(); idle() }` — test shim preserving the existing injected-deps item semantics; `runItemJob(deps, job)` exported (the former per-item pipeline body, unchanged behavior incl. timing log).
  - `interface MeetingJob { meetingId; recordingId; path; mimeType }`; `interface MeetingDeps { transcribe(job); reconcile(job, segments); setStatus(meetingId, status, error?); loadMarkers(recordingId); fallbackItemId(meetingId); presenterFor(itemId); saveItem(itemId, segments, map, order); saveMeetingMap(meetingId, map); log(m) }`; `runMeetingJob(deps: MeetingDeps, job: MeetingJob)` implementing spec §3 steps 1-8 (reconcile failure degrades to `{}`; presenter fill per item via `assignPresenterToDominant`; meeting-wide order via `chronologicalSpeakerOrder`; timing log).
  - `enqueueMeetingProcessing(meetingId, recordingId): Promise<boolean>` — loads the recording, guards empty `storage_path` (false), sets status `queued`, enqueues the real meeting task.
  - `recoverPendingMeetingJobs(dbPool = pool): Promise<number>` — for each unfinished meeting: latest recording with a path → `queued` + enqueue; otherwise `error` "Processing was interrupted and no recording was stored.".
  - `saveTranscriptionResult` additionally sets `transcriptSource: "topic"`.
- `index.ts` calls `recoverPendingMeetingJobs()` next to `recoverPendingJobs()` and logs a combined count.
- Real wiring: ONE shared `transcribeQueue` instance carries both kinds. Real `MeetingDeps`: `transcribe` reads the file → `transcribeAudio({fileName: \`meeting-${job.meetingId}.webm\`, mimeType, buffer})`; `reconcile` mirrors the item version at meeting scope (skip → `{}` when <2 distinct speakers or no attendees; `itemTitle: "Full meeting"`; presenters = deduped names across all items' presenter_ids); `presenterFor` = the presenter-if-attendee name (extract the existing lookup from `withPresenterAssignment` into `presenterNameForItem(itemId, dbPool = pool)` and reuse it in both); `saveItem` = `updateAgendaItem(pool, itemId, { transcriptSegments, speakerMap: map, summary: "", actionItems: [], status: "pending", transcriptSource: "meeting", speakerOrder: order })` then `setTranscribeStatus(pool, itemId, "done")`; `fallbackItemId` = first agenda item by position, else `addAgendaItem(pool, meetingId, "Meeting recording", "")`; `saveMeetingMap` = `setMeetingSpeakerMap`.

**Steps (TDD):**

- [ ] **Step 1:** Mechanically update the existing 8+2 tests: `createQueue(deps)` call sites become `createItemQueue(deps)` (import rename included); the DB-gated `saveTranscriptionResult` test additionally asserts `transcript_source === 'topic'` (add `transcript_source` to its SELECT). Then append new tests:

```typescript
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
```

(Add `MeetingJob`, `MeetingDeps`, `runMeetingJob`, `QueueTask`, `createQueue`, `createItemQueue` to the test file's imports.)

- [ ] **Step 2: RED** — tsc: missing exports / changed signatures.
- [ ] **Step 3:** Implement per the Interfaces block. `runMeetingJob` body:

```typescript
export async function runMeetingJob(d: MeetingDeps, job: MeetingJob): Promise<void> {
  await d.setStatus(job.meetingId, "processing");
  const started = Date.now();
  const result = await d.transcribe(job);
  const segments = absorbMicroTurns(result.segments);
  let map: SpeakerMap = {};
  try { map = await d.reconcile(job, segments); } catch { map = {}; }
  const markers = await d.loadMarkers(job.recordingId);
  const fallback = await d.fallbackItemId(job.meetingId);
  const byItem = segmentByMarkers(segments, markers, fallback);
  // Each topic's presenter claims that topic's dominant unnamed voice.
  for (const [itemId, segs] of byItem) {
    const presenter = await d.presenterFor(itemId);
    if (presenter) map = assignPresenterToDominant(segs, map, presenter);
  }
  const order = chronologicalSpeakerOrder([...byItem.values()]);
  for (const [itemId, segs] of byItem) {
    await d.saveItem(itemId, segs, map, order);
  }
  await d.saveMeetingMap(job.meetingId, map);
  await d.setStatus(job.meetingId, "done");
  const audioSeconds = segments.length ? segments[segments.length - 1].end : 0;
  const elapsed = (Date.now() - started) / 1000;
  const factor = audioSeconds > 0 ? (elapsed / audioSeconds).toFixed(2) : "n/a";
  d.log(`processed meeting ${job.meetingId}: ${byItem.size} topic(s), ${audioSeconds.toFixed(1)}s audio in ${elapsed.toFixed(1)}s (realtime factor ${factor})`);
}
```

The generic queue keeps the current drain/idle/size machinery; `runOne` becomes `await task.run()` with the catch calling `task.fail(message)` (guarded) and `safeLog`. `createItemQueue(deps)` wraps a fresh generic queue whose log is `deps.log`, translating `TranscribeJob → QueueTask` via `runItemJob(deps, job)` / `deps.setStatus(job.itemId, "error", m)`. The real module-level queue is one `createQueue(m => console.log(\`[transcribe] ${m}\`))`; `enqueueTranscription`/`enqueueStoredRecording` wrap real item deps the same way; `recoverPendingJobs` unchanged in behavior.

- [ ] **Step 4: GREEN** — full suite (with DB): 94 / 0 fail (89 + 5 new).
- [ ] **Step 5:** `index.ts`:

```typescript
  const recovered = await recoverPendingJobs();
  const recoveredMeetings = await recoverPendingMeetingJobs();
  if (recovered || recoveredMeetings) {
    app.log.info(`re-queued ${recovered} item and ${recoveredMeetings} meeting transcription job(s)`);
  }
```

- [ ] **Step 6: Commit** — `feat(meeting-minutes): process whole-meeting recordings on the shared serial queue`

---

### Task 5: Routes, speaker-map rewrite, detail/status extensions

**Files:**
- Modify: `apps/meeting-minutes/src/routes/meetings.ts`
- Modify: `apps/meeting-minutes/src/meetings.ts` (`rewriteMeetingSpeakerMap`)
- Test: `apps/meeting-minutes/src/meetings.test.ts`

**Interfaces (HTTP, consumed by Tasks 6-8):**
- `POST /api/meetings/:id/recording/start` `{mimeType}` → `{ok, recordingId}`; sets recording_status `recording`.
- `POST /api/meeting-recordings/:rid/chunk` (multipart file) → `{ok, byteSize}`; 404 unknown recording.
- `POST /api/meeting-recordings/:rid/marker` `{itemId, atSeconds}` → `{ok}`; 400 non-finite numbers; 404 unknown recording.
- `POST /api/meeting-recordings/:rid/finish` → stamps finished, 202 `{ok, status:"queued"}` via `enqueueMeetingProcessing` (404 when it returns false).
- `POST /api/meeting-recordings/:rid/reprocess` → 202 `{ok, status:"queued"}` (no finished stamp).
- `GET /api/meeting-recordings/:rid/download` → streams with the established header hygiene; filename `meeting-<meetingId>-recording-<rid>.<ext of storage_path>`.
- `PUT /api/meetings/:id/speaker-map` `{speakerMap}` → `{ok}`; body values coerced to trimmed strings, empties dropped.
- `GET /api/meetings/:id` additionally returns `meetingRecordings` (list) and `meetingSpeakerStats` (`speakerStats` over the chronological concatenation of meeting-sourced items' segments); the `meeting` object now carries `recording_status`/`recording_error`/`speaker_map` via `getMeeting`.
- `GET /api/meetings/:id/status` additionally returns `meeting: {recordingStatus, recordingError}`.
- `rewriteMeetingSpeakerMap(pool, meetingId, map)` exported from `./meetings`: one transaction — store the map on the meeting; for every item with `transcript_source='meeting'` (position order) set `speaker_map`, `transcript = renderTranscript(segments, map, chronologicalSpeakerOrder(all meeting-sourced segments))`, `summary=''`, `action_items='[]'`, `status='pending'`.

- [ ] **Step 1: Failing test** — append to `meetings.test.ts` (import `rewriteMeetingSpeakerMap`):

```typescript
test("rewriteMeetingSpeakerMap renames every meeting-sourced topic with meeting-wide numbering", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await reset(pool);
  const m = await createMeeting(pool, { title: "Board", meetingDate: "", location: "", description: "", email: "", name: "" });
  assert.ok(m.ok);
  const meetingId = (m as { ok: true; status: number; id: number }).id;
  const a = await addAgendaItem(pool, meetingId, "Budget", "");
  const b = await addAgendaItem(pool, meetingId, "Missions", "");
  assert.ok(a.ok && b.ok);
  const aId = (a as { ok: true; status: number; id: number }).id;
  const bId = (b as { ok: true; status: number; id: number }).id;

  const order = ["SPEAKER_00", "SPEAKER_01"];
  await updateAgendaItem(pool, aId, {
    transcriptSegments: [{ text: "Numbers look good.", speaker: "SPEAKER_00", start: 0, end: 5 }],
    speakerMap: {}, transcriptSource: "meeting", speakerOrder: order, summary: "stale A",
  });
  await updateAgendaItem(pool, bId, {
    transcriptSegments: [{ text: "Trip is planned.", speaker: "SPEAKER_01", start: 30, end: 35 }],
    speakerMap: {}, transcriptSource: "meeting", speakerOrder: order, summary: "stale B",
  });
  // Meeting-wide numbering: item B's only voice is Speaker 2, not Speaker 1.
  assert.equal((await getAgendaItem(pool, bId))!.transcript, "Speaker 2: Trip is planned.");

  await rewriteMeetingSpeakerMap(pool, meetingId, { SPEAKER_00: "Alice", IGNORED: "" });
  const aAfter = (await getAgendaItem(pool, aId))!;
  const bAfter = (await getAgendaItem(pool, bId))!;
  assert.equal(aAfter.transcript, "Alice: Numbers look good.");
  assert.equal(bAfter.transcript, "Speaker 2: Trip is planned.");
  assert.equal(aAfter.summary, "");
  assert.equal(aAfter.status, "pending");
  assert.deepEqual((await getMeeting(pool, meetingId))!.speaker_map, { SPEAKER_00: "Alice" });

  await reset(pool);
  await pool.end();
});
```

- [ ] **Step 2: RED**, **Step 3: implement** `rewriteMeetingSpeakerMap` in `meetings.ts` (import `chronologicalSpeakerOrder` from `./segmentation`):

```typescript
// Store the meeting-wide speaker map and re-render every meeting-sourced
// topic against it in one transaction. New names invalidate summaries.
export async function rewriteMeetingSpeakerMap(
  pool: Pool,
  meetingId: number,
  rawMap: Record<string, unknown>
): Promise<void> {
  const map: SpeakerMap = {};
  for (const [k, v] of Object.entries(rawMap ?? {})) {
    const name = String(v ?? "").trim();
    if (name) map[k] = name;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE meetings SET speaker_map = $2, updated_at = now() WHERE id = $1", [
      meetingId, JSON.stringify(map),
    ]);
    const r = await client.query(
      `SELECT id, transcript_segments FROM agenda_items
        WHERE meeting_id = $1 AND transcript_source = 'meeting' ORDER BY position, id`,
      [meetingId]
    );
    const perItem = r.rows.map((row) =>
      (Array.isArray(row.transcript_segments) ? row.transcript_segments : []) as DiarizedSegment[]
    );
    const order = chronologicalSpeakerOrder(perItem);
    for (let i = 0; i < r.rows.length; i++) {
      await client.query(
        `UPDATE agenda_items
            SET speaker_map = $2, transcript = $3, summary = '', action_items = '[]'::jsonb, status = 'pending'
          WHERE id = $1`,
        [Number(r.rows[i].id), JSON.stringify(map), renderTranscript(perItem[i], map, order)]
      );
    }
    await client.query("UPDATE meetings SET updated_at = now() WHERE id = $1", [meetingId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
```

Routes: implement the seven endpoints per the Interfaces block, reusing `readMultipart`, `uploadErrorResponse`, and the download hygiene pattern (`existsSync` + `createReadStream` + ASCII-stripped filename). Detail route additions after `withRecordings`:

```typescript
    const meetingSourced = withRecordings.filter((it) => it.transcript_source === "meeting");
    const meetingSpeakerStats = speakerStats(
      meetingSourced.flatMap((it) => it.transcript_segments).slice().sort((a, b) => a.start - b.start)
    );
    return {
      ok: true,
      meeting,
      attendeeIds: await getAttendeeIds(pool, id),
      items: withRecordings,
      meetingRecordings: await listMeetingRecordings(pool, id),
      meetingSpeakerStats,
    };
```

Status route addition:

```typescript
      meeting: { recordingStatus: meeting.recording_status, recordingError: meeting.recording_error },
```

(Imports to add in the route file: `speakerStats` from `../speakers`; `createMeetingRecording`, `appendMeetingChunk`, `finishMeetingRecording`, `getMeetingRecording`, `listMeetingRecordings` from `../recordings`; `enqueueMeetingProcessing` from `../transcribeQueue`; `setMeetingRecordingStatus`, `addTopicMarker`, `rewriteMeetingSpeakerMap` from `../meetings`; `extname` from `node:path`.)

- [ ] **Step 4: GREEN** — full suite 95 (with DB) / 0 fail; boot-load check `node -e "require('./dist/routes/meetings')"` clean.
- [ ] **Step 5: Commit** — `feat(meeting-minutes): whole-meeting recording routes and speaker-map rewrite`

---

### Task 6: Client capture manager

**Files:** `apps/meeting-minutes/src/public/app.js`

Implements spec §1 client-side: the Meeting recording card in `renderDetail` (between Attendees and Agenda), `meetingRec` state, `toggleMeetingRecording`/`stopMeetingRecording`/`finalizeMeetingRecording`, ordered chunk chain with one retry + carry-forward, `postTopicMarker` (called from `toggleItemOpen` after `state.openItemId=it.id`, and at start for the open item, and ONLY when `meetingRec.meetingId === state.meeting.id`), elapsed timer, `beforeunload` guard, mutual exclusion with per-topic recording both ways, interrupted-recovery button (uses `state.meetingRecordings` from the detail payload; POST finish on the latest). `openMeeting` stores `state.meetingRecordings = det.meetingRecordings || []` and `state.meetingSpeakerStats = det.meetingSpeakerStats || []`. `meetingRec` carries `{meetingId, recordingId, mr, stream, t0, chain, failedChunk, timer}`.

The exact code for every function is in the spec-review packet the controller supplies with the brief; behaviors that MUST hold: chunks strictly ordered (promise chain), a failed chunk retries once after 2s then carries into the next upload, stop flushes the chain THEN the carried chunk THEN posts finish, finalize clears `beforeunload`/timer/tracks and sets `recording_status='queued'` + `startPolling()` if defined, per-topic `toggleRecording` refuses while `meetingRec` and `toggleMeetingRecording` refuses while `activeRec`.

Verification: `node --check`, suite green, and a written trace of: start→chunks→markers on topic clicks→stop→finish; the retry/carry path; the interrupted-recovery path; both exclusion messages.

- [ ] Implement, verify, commit — `feat(meeting-minutes): record the whole meeting with chunked upload and topic markers`

---

### Task 7: Meeting processing status, poller, report gate

**Files:** `apps/meeting-minutes/src/public/app.js`

- `meetingProcessing()` = recording_status queued/processing; `anyPendingWork()` = `anyTranscribing() || meetingProcessing()`; replace the polling-continuation checks (`afterPollRound`, poll `.catch`, `openMeeting` start condition, `!res.ok` reschedule) and `generateReport`'s busy check with `anyPendingWork()` (report waiting message covers both kinds).
- `pollOnce` consumes `res.meeting`: update `state.meeting.recording_status/recording_error` (inside the `gen` guard); `meetingSettled` = was queued/processing → isn't. The settled-refetch triggers when `settled.length || meetingSettled`; inside `det.ok` also refresh `state.meetingRecordings`/`state.meetingSpeakerStats` and call `renderMeetingRecUi()` plus `renderMeetingSpeakerPanel()` if defined. `onTranscriptionSettled` still runs ONLY for settled items (meeting-sourced items never enter queued/processing client-side, so no auto-summaries — assert this in the trace).
- `renderMeetingRecUi`'s non-capturing branch renders processing state into `#mrec-extra`: queued → "Queued for processing…", processing → spinner "Processing the meeting recording…", error → red `recording_error` + a Retry button (`POST /api/meeting-recordings/<latest>/reprocess` → status queued → `startPolling()`), done → "Processed." plus a Download link `/api/meeting-recordings/<latest>/download` when `state.meetingRecordings.length`.

Verification: `node --check`, suite green, trace of: stop→queued badge→poll→processing→done→detail refetch with items showing "Needs summary" and NO summarize POSTs; the error→Retry path; report clicked during processing waits then auto-proceeds; stale-gen responses still discarded.

- [ ] Implement, verify, commit — `feat(meeting-minutes): track whole-meeting processing in the poller and report flow`

---

### Task 8: Meeting speaker panel

**Files:** `apps/meeting-minutes/src/public/app.js`, `apps/meeting-minutes/src/public/app.css`

- `renderDetail` adds `<div id="meeting-speakers"></div>` immediately after the Meeting recording card; `openMeeting` and the settle-refetch call `renderMeetingSpeakerPanel()`.
- `renderMeetingSpeakerPanel()`: empty container when no `state.meetingSpeakerStats`; otherwise a card "Who spoke in this meeting?" with the same talk-time/sample rows (selects `data-mspk`, options = attendees + keep-current, built like `renderSpeakerMap`), the hint "One set of voices for the whole meeting — assign a name once and every topic updates. Saving re-labels all topic transcripts.", and a **Save speakers** button: collect `{spk: value}` for non-empty values → `PUT /api/meetings/:id/speaker-map {speakerMap}` → on ok refetch the detail, update `state.meeting`/`state.meetingSpeakerStats`/`state.meetingRecordings`, `syncItems(det.items)`, re-render the panel, success message "Speakers saved — transcripts updated." (errors render in the panel's msg slot, button re-enabled).
- `renderSpeakerMap(it)`: first line — when `it.transcript_source === 'meeting'`, render `<div class="hint">Speakers for this topic are labeled meeting-wide — use "Who spoke in this meeting?" above.</div>` and return.
- `syncItems` copies `transcript_source` from fresh items.
- CSS: none new required (reuses `.spk-row` family); add nothing unless `node --check`/trace shows a need.

Verification: `node --check`, suite green, trace of: panel renders post-processing with meeting-wide labels matching item transcripts; save → PUT body → refetch → transcripts/badges update in place without collapsing the open item; per-item panels replaced by the pointer note for meeting-sourced items and unchanged for topic-recorded ones.

- [ ] Implement, verify, commit — `feat(meeting-minutes): meeting-wide speaker naming panel`

---

## Final verification

1. Full suite green (with DB: expect 95 / 0 fail).
2. Final whole-branch review (per SDD), one fix wave if needed.
3. User acceptance on a real deploy: record a short meeting clicking through 3 topics, stop, watch Queued→Processing→Processed, confirm per-topic transcripts with consistent Speaker N numbering, name speakers once in the panel, confirm every topic renames, close topics → summaries, generate report.
