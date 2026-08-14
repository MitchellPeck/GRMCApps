# Meeting Minutes — whole-meeting recording with topic tracking

**Date:** 2026-08-14
**App:** `apps/meeting-minutes`
**Status:** Approved design
**Builds on:** `2026-08-13-meeting-minutes-improvements-design.md` (async queue,
diarization pipeline, speaker stats, status polling — all shipped)

## Problem

Per-topic recording requires starting and stopping the microphone for every
agenda item. The user wants to press record once for the entire meeting, click
through topics as the meeting progresses (which the app already requires for
note-taking), and have processing attribute each stretch of audio to the topic
that was open at the time. Because one long recording gives diarization far
more voice data per speaker, speaker separation improves and — critically —
speaker labels become consistent across the whole meeting: assign a name once
and it applies everywhere. Names are assigned after the fact, then summaries
generate.

## Decisions (fixed)

- **Both modes stay.** The meeting-level recorder is added; per-topic
  record/upload remains for single-item use, but the two are mutually
  exclusive while capturing (one microphone).
- **No auto-summaries after processing.** Items come back with transcripts,
  meeting-wide `Speaker N` labels, and a `Needs summary` badge. Summaries fire
  through the existing gate — closing a reviewed item, or Generate report.
- **Chunked upload.** The browser uploads ~20-second chunks as it records; a
  crash loses at most the last chunk. An interrupted recording can be
  processed from what was captured.
- **Recordings are never deleted** except when the owning meeting is deleted
  (files included), matching the existing recordings policy.
- **Reprocessing replaces.** Re-recording creates a new recording row;
  processing (or reprocessing) a recording overwrites the meeting-sourced
  transcripts it produces, exactly as per-topic re-transcribe does.

## 1. Capture

A **Record meeting** button lives with the meeting header/attendees area.

- Start: `getUserMedia` (same constraints as per-topic), then
  `POST /api/meetings/:id/recording/start {mimeType}` creates a
  `meeting_recordings` row and an empty file on the `minutesdata` volume and
  sets the meeting's `recording_status = 'recording'`. `MediaRecorder` runs
  with a 20-second timeslice.
- Each chunk POSTs to `/api/meeting-recordings/:rid/chunk` (multipart) and is
  appended server-side (`appendFile`). Uploads are strictly serialized on a
  client promise chain to preserve order; a failed chunk retries once after
  2s, then is carried in memory and prepended to the next chunk's upload, so
  ordering is never violated.
- **Topic markers:** whenever a topic is opened while capturing — including
  the one already open at start — the client posts
  `/api/meeting-recordings/:rid/marker {itemId, atSeconds}`, where
  `atSeconds` is elapsed time since capture start (`performance.now()`
  based). Marker/audio skew is bounded by the sub-second gap between the
  start POST and `MediaRecorder.start`, acceptable because topic switches
  have natural pauses.
- Stop: `MediaRecorder.stop()`, flush the final chunk through the chain, then
  `POST /api/meeting-recordings/:rid/finish` → recording stamped finished,
  `recording_status = 'queued'`, job enqueued. Returns 202.
- While capturing: elapsed timer on the button, `beforeunload` warning,
  per-topic record buttons refuse with a message (and vice versa).
- **Interrupted recovery:** if a meeting loads with
  `recording_status = 'recording'` and the client is not capturing, the UI
  offers **Process interrupted recording**, which calls `finish` on the
  latest recording — the chunks already uploaded are processed.

## 2. Data model

Idempotent DDL, matching existing migration style:

- `meetings` gains `recording_status text NOT NULL DEFAULT 'idle'`
  (`idle|recording|queued|processing|done|error`), `recording_error text NOT
  NULL DEFAULT ''`, and `speaker_map jsonb NOT NULL DEFAULT '{}'` (the
  meeting-wide label→name map).
- `agenda_items` gains `transcript_source text NOT NULL DEFAULT ''`
  (`'' | 'topic' | 'meeting'`) — which pipeline produced the current
  transcript. The per-topic path sets `'topic'`; segmentation sets
  `'meeting'`.
- New `meeting_recordings` (id, meeting_id FK CASCADE, mime_type, byte_size,
  storage_path, started_at, finished_at) with files at
  `/data/audio/meeting-<meetingId>/<recordingId>.<ext>`.
- New `topic_markers` (id, recording_id FK CASCADE, item_id FK CASCADE,
  at_seconds double precision), indexed by (recording_id, at_seconds).

Deleting a meeting also unlinks its meeting-recording files (extending the
existing best-effort cleanup).

## 3. Processing pipeline

One new job kind on the **same serial queue** (never two whisper jobs at
once). The queue generalizes to a serial runner of `{run, fail}` tasks; the
existing item pipeline keeps its injected-deps shape and tests.

`runMeetingJob` (all side effects injected, unit-tested without DB/fs/network):

1. `recording_status = 'processing'`.
2. Transcribe the whole file (one whisper call).
3. `absorbMicroTurns` over the full segment list.
4. One Claude reconciliation pass over the entire meeting transcript
   (positional labels, attendee list with titles, the union of item
   presenters as "expected to lead"). Best-effort: failure degrades to raw
   labels, never fails the job.
5. Load markers; **segment**: markers sorted by time define windows
   `[at_i, at_{i+1})`; a segment belongs to the window holding its midpoint;
   audio before the first marker joins the first marker's topic; with no
   markers at all, everything goes to the first agenda item (created as
   "Meeting recording" if the meeting has none). Revisited topics get their
   windows concatenated in time order.
6. Per-topic presenter fill: for each item with segments, the dominant voice
   within *that item's* audio is assigned to the item's presenter (only if
   the presenter is a selected attendee, never overwriting a name Claude
   already placed) — into the one meeting-wide map.
7. Compute the **meeting-wide speaker order** (first appearance across the
   chronological concatenation) and write each item through the existing
   update path: segments, the meeting map as its `speaker_map`, transcript
   rendered against the meeting-wide order (so `Speaker N` numbering is
   identical in every topic), summary/action items cleared, status pending,
   `transcript_source = 'meeting'`, `transcribe_status = 'done'`.
8. Save the map to `meetings.speaker_map`; `recording_status = 'done'`; log
   audio seconds / elapsed / realtime factor.

Boot recovery extends to meeting jobs: `recording_status IN
('queued','processing')` re-enqueues from the latest stored recording;
missing file → `error`.

`renderTranscript` gains an optional explicit speaker-order parameter (default
unchanged: first appearance within the given segments) so meeting-sourced
items number speakers meeting-wide.

## 4. Naming after the fact

- The meeting detail payload gains: recording status/error, the meeting
  `speaker_map`, the meeting recordings list, per-item `transcript_source`,
  and `meeting_speaker_stats` — talk-time stats over the chronological
  concatenation of all meeting-sourced items' segments (labels therefore
  match the transcripts).
- A **"Who spoke in this meeting?"** card renders under Attendees once stats
  exist: the same talk-time/sample rows, one per meeting-wide voice, each
  with an attendee dropdown, and a single **Save speakers** button.
- Saving calls `PUT /api/meetings/:id/speaker-map`, which in one
  transaction updates `meetings.speaker_map` and rewrites every
  meeting-sourced item: new map, transcript re-rendered against the
  meeting-wide order, summary/action items cleared, status pending. The
  client refetches the detail and patches in place (`syncItems`).
- Per-item "Who is speaking?" panels: items with `transcript_source ===
  'meeting'` show a pointer to the meeting-level card instead of their own
  dropdowns (one source of truth). Per-topic-recorded items keep their local
  panel unchanged.

## 5. Status & flow

- Meeting header badge: **Recording (m:ss)** → **Queued** → **Processing…** →
  **Processed** / **Processing failed · Retry** (retry = `POST
  /api/meeting-recordings/:rid/reprocess`, re-queuing the stored file).
- `GET /api/meetings/:id/status` gains
  `meeting: {recordingStatus, recordingError}`; the poller runs while items
  transcribe **or** the meeting job is queued/processing. When the meeting
  job settles, the client refetches the detail — items arrive `done` +
  `Needs summary`; the existing settle-driven auto-summarize does **not**
  fire for them (they were never `queued`/`processing` client-side).
- Generate report already waits on pending work; its busy check extends to
  the meeting job, then proceeds automatically (summarizing pending items —
  which by then carry assigned names if the user did the review pass).
- A meeting-recording download link (`GET
  /api/meeting-recordings/:rid/download`) with the established header
  hygiene.

## Out of scope

- Live transcription during capture; pause/resume; multiple simultaneous
  recordings; editing marker times after the fact (re-record or per-topic
  re-record covers mistakes); speaker enrollment across meetings.

## Files touched (summary)

`schema.ts`, `meetings.ts` (+accessors, `updateAgendaItem` gains
`transcriptSource`/`speakerOrder`), `transcript.ts` (order param), new
`segmentation.ts`, `recordings.ts` (+meeting-file layer, delete cleanup),
`transcribeQueue.ts` (generic queue + meeting pipeline + recovery),
`routes/meetings.ts` (six new routes + detail/status extensions +
speaker-map PUT), `public/app.js` (capture manager, meeting badge/poller,
speaker panel), `public/app.css`, `index.ts` (recovery call).
