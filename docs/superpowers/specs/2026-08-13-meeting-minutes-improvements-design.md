# Meeting Minutes — transcription, speakers, async topics, and edit modals

**Date:** 2026-08-13
**App:** `apps/meeting-minutes`
**Status:** Approved design

## Problem

Seven issues surfaced during real use of the meeting-minutes app:

1. Speaker dropdowns inside an agenda item do not refresh when attendees are
   added; the new names only appear after a page refresh or reopening the
   meeting.
2. Transcription of a 2-minute recording takes far too long.
3. Diarization over-splits: four people in the room were labeled as eight
   distinct speakers, and one person flipped from Speaker 1 to Speaker 2
   mid-sentence.
4. You cannot reliably move on to the next topic while the previous one is
   still transcribing, a closed topic has no status indicator, and summaries
   can be triggered while transcription is still pending.
5. Meeting details are edited through chained browser `prompt()` dialogs.
6. People are edited through chained browser `prompt()` dialogs.
7. When an imported agenda names a presenter, that name only lands in the
   item's description text. It never links to a person and never influences
   speaker assignment.

## Constraints and decisions

Decisions made during design, to be treated as fixed:

- **Transcription stays in Docker.** Tune the existing `hwdsl2/whisper-server`
  container rather than moving to a natively-installed, Metal-accelerated
  Whisper on the host. The host is an 8-core Apple Silicon Mac.
- **Diarization is fixed at both layers**: raise the container's clustering
  threshold *and* add a Claude reconciliation pass. Threshold tuning alone
  cannot repair a mid-sentence speaker flip.
- **Recordings are permanently recoverable.** Audio is written to disk before
  transcription begins and is never auto-deleted, including after a successful
  transcription. It is removed only when the owning meeting is deleted.
- **One transcription runs at a time**, in a serial queue. Concurrent jobs on a
  6-thread budget would slow every job proportionally.
- **All `prompt()` dialogs are replaced by modals**, including agenda item
  add/edit, not just meetings and people.
- **Meetings can be deleted from the UI**, gated by typing the meeting title.
- **Attendance remains the gate** for speaker auto-assignment. Importing an
  agenda never silently adds someone to the attendee list.

## 1. Whisper container tuning

`docker-compose.yml`, `whisper` service. The container currently runs at close
to worst-case settings — notably `WHISPER_THREADS` defaults to 2, so it has
been using two of the host's eight cores.

| Variable | Current | New | Rationale |
|---|---|---|---|
| `WHISPER_THREADS` | 2 (default) | `6` | Largest single win. Leaves 2 cores for the rest of the stack. |
| `WHISPER_BEAM` | 5 (default) | `1` | Greedy decoding; roughly 2-3x faster with negligible loss on clean English. |
| `WHISPER_MODEL` | `small` | `small.en` | English-only weights are both faster and more accurate for English audio. |
| `WHISPER_COMPUTE_TYPE` | unset | `int8` | The image's documented recommendation for CPU inference. |
| `WHISPER_DIARIZE_THRESHOLD` | 0.5 (default) | `0.7` | Higher value clusters more aggressively, yielding fewer speakers. |

`WHISPER_LANGUAGE=en`, `WHISPER_DIARIZATION=true`, and `WHISPER_API_KEY=""`
are unchanged.

Each value is supplied from `.env` with the above as its default, so the host
can be retuned without rebuilding an image.

**Migration note:** `small.en` is a separate ~465 MB download into the
`whisperdata` volume on first boot after this change. The first transcription
following deployment will be slow while the model downloads.

**Measurement, not promises.** No speedup figure is committed to here. The
queue worker logs, per job, the audio duration, the wall-clock transcription
time, and the resulting realtime factor. The UI displays elapsed time on the
item. After one real meeting there will be a measured number and the five knobs
above are all `.env`-tunable in response.

## 2. Speaker reconciliation

New module `src/speakers.ts`. Three layers, applied in order inside the queue
worker after Whisper returns segments.

### 2.1 Micro-turn absorption (deterministic, no API call)

A speaker turn shorter than 1.2 seconds that sits between two turns belonging
to the same other speaker is absorbed into the surrounding speaker. This is the
exact signature of the reported mid-sentence Speaker 1 → Speaker 2 → Speaker 1
flip, and removing it here means the Claude pass sees cleaner input.

### 2.2 Claude reconciliation pass

Input: the diarized transcript with raw labels, the meeting's attendee list
(names and titles), and the item's presenters.

Output: a JSON object mapping each raw speaker label to a person name, where
several raw labels may map to the same name:

```json
{ "SPEAKER_00": "Alice Smith", "SPEAKER_03": "Alice Smith", "SPEAKER_05": "" }
```

Claude collapses duplicate voices onto one person and names them using
conversational evidence — direct address ("Thanks, Alice"), self-introduction,
and who answers which question. A voice it cannot confidently attribute maps to
`""` and continues to display as "Speaker N".

This pass is best-effort. If there is no Anthropic API key, or the call fails,
or the response does not parse, transcription still succeeds and the raw
diarization labels are kept. A failed reconciliation never fails a
transcription.

### 2.3 Name-based transcript merging

`renderTranscript` in `src/transcript.ts` currently merges consecutive segments
by raw speaker label. Once two raw labels can resolve to the same person, that
produces two consecutive `Alice: …` lines. Merging must key on the *resolved
display name* instead. The mirrored `renderTranscriptJS` in `app.js` changes
identically so client-side remapping stays consistent with the server.

### 2.4 Speaker mapping UI

The "Who is speaking?" section keeps **one row per raw speaker**, so a bad
automatic merge can always be overridden by hand. Each row gains:

- percentage of total talk time,
- a short representative quote from that speaker,
- ordering by talk time descending.

Without these, eight near-identical "Speaker N" rows are impossible to tell
apart.

## 3. Presenter extraction and primary-speaker assignment

### 3.1 Agenda extraction learns presenters

`EXTRACT_SYSTEM` in `src/claude.ts` gains a third field per item:

- `presenter`: the presenter's name exactly as written in the document, or
  `""` when none is named.

The prompt is also instructed to *strip* "Presented by X" phrasing from
`description` rather than leaving it embedded there.

`ExtractedItem` gains `presenter: string`. On import, each presenter name is
matched against the people library and linked into `agenda_item_presenters`.
Matching is attempted in this order, stopping at the first success:

1. Whole-word, case-insensitive match on the person's full name (the existing
   `peopleNamedIn` matcher).
2. A match on last name alone, accepted only if exactly one library person has
   that last name.
3. A match on first name alone, accepted only if exactly one library person has
   that first name.

Ambiguous matches (step 2 or 3 hitting more than one person) and unmatched
names are ignored rather than guessed at.

Importing an agenda does **not** add anyone to `meeting_attendees`.

### 3.2 Dominant-speaker assignment

After reconciliation, compute the dominant speaker: the raw speaker label with
the greatest total speaking time across all segments.

If the item has a presenter who **is a selected attendee of the meeting**, and
the Claude pass has not already assigned that person to some voice, then the
dominant speaker is mapped to that presenter.

This replaces the existing rule in `routes/meetings.ts`, which only auto-mapped
when exactly one speaker was detected.

## 4. Asynchronous transcription

### 4.1 Schema

`agenda_items` gains, via idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
statements consistent with the existing migration style in `src/schema.ts`:

| Column | Type | Default | Meaning |
|---|---|---|---|
| `transcribe_status` | text | `'idle'` | `idle` / `queued` / `processing` / `done` / `error` |
| `transcribe_error` | text | `''` | Failure message shown next to the Retry action |
| `transcribe_started_at` | timestamptz | null | Set when the worker picks the job up |
| `transcribe_finished_at` | timestamptz | null | Set on success or failure |

New table:

```sql
CREATE TABLE IF NOT EXISTS item_recordings (
  id            bigserial PRIMARY KEY,
  item_id       bigint NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  file_name     text NOT NULL,
  mime_type     text NOT NULL DEFAULT '',
  byte_size     bigint NOT NULL DEFAULT 0,
  storage_path  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS item_recordings_item_idx ON item_recordings (item_id);
```

### 4.2 Storage and recoverability

A new named volume `minutesdata` is mounted at `/data` on the `meeting-minutes`
service. Audio is stored at `/data/audio/<item_id>/<recording_id>.<ext>`.

Recordings are **never** deleted automatically — not on successful
transcription, not on re-transcription, not on transcript edits. Every
recording an item has ever received remains on disk and is listed on the item
card with:

- a **Download** link (`GET /api/recordings/:id/download`, streaming the file
  with its original filename and content type), and
- a **Re-transcribe** action that re-queues that specific recording.

Recordings are removed only when their agenda item or meeting is deleted. The
meeting delete confirmation states this explicitly.

### 4.3 Queue worker

New module `src/transcribeQueue.ts`. A single in-process FIFO worker draining
one job at a time.

`POST /api/items/:itemId/transcribe` changes behavior:

1. Read the multipart upload.
2. Write the audio to `/data/audio/...` and insert an `item_recordings` row.
3. Set the item's `transcribe_status` to `queued`.
4. Enqueue the job and return `202 { ok: true, recordingId, status: "queued" }`
   **immediately** — it no longer waits for Whisper.

The worker, per job:

1. `transcribe_status` → `processing`, stamp `transcribe_started_at`.
2. Call `transcribeAudio` against the Whisper container.
3. Apply micro-turn absorption (2.1).
4. Apply Claude reconciliation (2.2), best-effort.
5. Apply dominant-speaker presenter assignment (3.2).
6. Persist `transcript_segments` and `speaker_map` through the existing
   `updateAgendaItem`, which re-derives `transcript`.
7. `transcribe_status` → `done`, stamp `transcribe_finished_at`, log the
   duration/realtime-factor line.

On failure at any step other than 4: `transcribe_status` → `error`,
`transcribe_error` set to the message. The audio remains on disk, so Retry
re-queues the same recording.

**Restart recovery.** On boot, any `agenda_items` row left in `queued` or
`processing` is re-enqueued from its most recent stored recording. Watchtower
restarting the container mid-transcription resumes the work rather than losing
it. This is the primary reason audio is written to disk before the job starts.

`POST /api/items/:itemId/retranscribe` with a `recordingId` re-runs the
pipeline against an existing stored recording.

### 4.4 Status polling

New endpoint `GET /api/meetings/:id/status` returns a lightweight per-item
payload: item id, `transcribe_status`, `transcribe_error`, whether a summary is
present, and the current attendee id list.

The frontend polls it every 3 seconds while a meeting detail view is open and
at least one item is `queued` or `processing`, and stops polling otherwise.

### 4.5 In-place rendering

`renderItems()` currently rebuilds all item DOM and resets `state.openItemId`
to null, collapsing everything. Poll-driven updates must instead patch badges,
transcript text, and speaker rows in place, so a background update cannot
collapse the topic the user is working in.

## 5. Summary gating

Badge states shown in each item's collapsed header:

| State | Condition |
|---|---|
| *(nothing)* | Item has no transcript and no notes |
| `Queued to transcribe` | `transcribe_status = queued` |
| `Transcribing…` | `transcribe_status = processing` |
| `Transcription failed · Retry` | `transcribe_status = error` |
| `Needs summary` | Has content, no current summary, no pending transcription |
| `Summarizing…` | Summary request in flight |
| `Summary failed` | Summary request errored |
| `Summary ready` | Summary present and not invalidated |

**The gating rule:** auto-summary fires only when the item is closed **and**
its `transcribe_status` is neither `queued` nor `processing`.

Consequences:

- Closing a topic mid-transcription attempts no summary. When the queue
  finishes that item, the poller observes `done`, sees the item is closed, and
  fires the summary at that point.
- If transcription completes while the topic is still open, nothing fires; the
  summary generates when the topic is closed.
- Editing the transcript or notes still invalidates an existing summary, as
  today.
- `generateReport` waits for in-flight transcriptions before summarizing
  pending items, showing "Waiting for N transcriptions…" while it does.

## 6. Live-updating speaker dropdowns

`toggleAttendee()` in `app.js` re-renders presenter chips but never calls
`renderSpeakerMap()`. That is the reported bug. It will now re-render the
speaker dropdowns for every item as well, preserving each row's current
selection, and the poller will do the same when it reports an attendee-list
change (from another user's edit, or from action-item auto-linking during
summarization).

## 7. Modals

A single shared helper in `app.js`:

```js
openModal({ title, fields, onSave, danger })
```

Behavior: backdrop, ESC and click-outside to close, Enter to save, focus placed
on the first field, save button shows a spinner while `onSave` is pending, and
validation errors render inside the modal.

Three call sites:

- **Meeting** — title, date, location, description, status
  (draft / in progress / completed). Plus a separate danger section with
  **Delete meeting**, enabled only once the user types the meeting title
  exactly. The confirmation states that agenda items, transcripts, recordings,
  and the report are all deleted. `PATCH /api/meetings/:id` and
  `DELETE /api/meetings/:id` already support this.
- **Person** — name, role/title, email, active toggle. `PUT /api/people/:id`
  is extended to accept `active` so one save covers every field.
- **Agenda item** — title and description, used by both "Add item manually"
  and a new per-item Edit action.

All three existing `prompt()`-based flows (`editMeeting`, `editPerson`,
`addItemManually`) are removed.

## Files touched

| File | Change |
|---|---|
| `docker-compose.yml` | Whisper env tuning; `minutesdata` volume on `meeting-minutes` |
| `src/schema.ts` | Transcription-status columns; `item_recordings` table |
| `src/speakers.ts` | **New** — micro-turn absorption, Claude reconciliation, dominant speaker |
| `src/transcribeQueue.ts` | **New** — serial queue worker, restart recovery |
| `src/recordings.ts` | **New** — audio file persistence and lookup |
| `src/transcript.ts` | Merge consecutive turns by resolved name |
| `src/claude.ts` | `presenter` field in extraction; reconciliation prompt |
| `src/meetings.ts` | Transcription-status accessors; presenter linking on import |
| `src/people.ts` | Presenter name matching; `updatePerson` accepts `active` |
| `src/routes/meetings.ts` | `transcribe` returns 202; `retranscribe`; `/status`; recording download |
| `src/routes/people.ts` | `PUT /api/people/:id` accepts `active` |
| `src/public/app.js` | Modals, polling, in-place rendering, badges, speaker rows |
| `src/public/app.css` | Modal and speaker-row styles |
| `src/public/index.html` | Modal root element |

## Testing

Using the existing setup (`tsc` then `node --test` over `dist/*.test.js`):

- `speakers.test.ts` — micro-turn absorption merges the sandwiched short turn
  and leaves genuine short interjections alone; reconciliation-map parsing
  handles valid JSON, fenced JSON, malformed output, and unknown labels;
  dominant-speaker selection by total duration.
- `transcript.test.ts` — extended: two raw labels resolving to one name produce
  a single merged line.
- `claude.test.ts` — extended: `parseItems` reads `presenter`, tolerates its
  absence, and trims it.
- `meetings.test.ts` — extended: transcription-status transitions, and
  presenter linking on agenda import including the unmatched-name case.
- Queue worker: state transitions on success, on Whisper failure, and on
  restart recovery from a `processing` row.

## Out of scope

- Live/streaming transcription during recording.
- Multi-user real-time collaboration beyond the 3-second status poll.
- Speaker voice enrollment (recognizing a person across meetings).
- Any change to report generation beyond the transcription-wait gate.
