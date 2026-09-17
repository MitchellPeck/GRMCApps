# Meeting Minutes — guided walkthrough with a practice meeting

**Date:** 2026-09-17
**App:** `apps/meeting-minutes`
**Status:** Approved design
**Builds on:** `2026-08-14-whole-meeting-recording-design.md` (topic markers,
meeting-wide speaker naming, serial transcription queue — all shipped)

## Problem

A new user opening Meeting Minutes for the first time cannot tell how the app
is meant to be driven *while a meeting is happening*. The critical mechanic is
invisible: you press record **once** for the whole meeting, and **opening** an
agenda item is what files the audio under it. Nothing on screen teaches that
collapsing a topic lays down no marker, that the amber "No topic opened yet"
banner means audio is going to the first item, or that summaries fire when a
topic collapses. The README explains it; the app does not.

The fix is a guided walkthrough the user can *take*, driven against a real,
disposable practice meeting rather than a screenshot tour.

## Decisions (fixed)

- **Guided tour, not a written guide.** An overlay spotlights real controls in
  the real app, step by step.
- **Practice meeting is real data.** It is a genuine meeting row the user can
  click, record into, and delete — not client-side fixture data.
- **Pre-baked, plus one live take.** Two of its three topics ship finished
  (transcripts, speaker labels, summaries, action items) so the tour works with
  no API key and no microphone. The third is empty and is where the user
  actually presses record, opens a topic mid-recording, and watches the real
  pipeline run. The live portion is skippable.
- **Per-user isolation.** `people`, `meetings` and `settings` are shared across
  all hub users. Demo rows are flagged and scoped so one person's practice
  meeting never appears in anybody else's meetings list, and demo people never
  enter the shared People library.
- **The tour never writes fake AI output.** When no Anthropic key is set, the
  affected steps say so and show an example inside the callout rather than
  storing invented minutes.

## 1. Data model and isolation

Two idempotent migrations in `schema.ts`, in the style of the existing ones:

```sql
ALTER TABLE people   ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS meetings_demo_owner_idx ON meetings (is_demo, created_by_email);
```

Ownership is `meetings.created_by_email`, already populated on create.

**Filtering is deliberately shallow.** `listPeople()` keeps returning every
person, so the five internal consumers — `realReconcile`,
`realMeetingReconcile`, `presenterNameForItem`, `nameMap`, `peopleNamedIn` —
are untouched and continue to resolve demo attendees during the live take.
Only the client-facing shapes filter:

| Endpoint | Behaviour |
|---|---|
| `GET /api/people` (People tab) | excludes `is_demo` rows |
| `GET /api/people?all=1&meetingId=N` | non-demo, plus demo people when `N` is the caller's practice meeting |
| `GET /api/meetings` | `WHERE NOT is_demo OR created_by_email = $viewer` |
| `GET /api/meetings/:id` | 404 when the meeting is demo and owned by another email |

`renderAttendeeChips` and the speaker dropdowns are built from whatever
`/api/people?all=1&meetingId=N` returns, so they need no special-casing.

Demo people carry reserved emails (`dale@practice.invalid`). `addPerson`
de-duplicates on exact email, so a real person can never be merged into a demo
row, and re-seeding stays idempotent.

## 2. Seed content (`src/demo.ts`)

`seedPractice(pool, identity)` and `deletePractice(pool, email)`.

Four demo people, all set as attendees: **Pastor Dale Whitcomb** (Pastor),
**Marian Webb** (Treasurer), **Tom Ross** (Trustees Chair), **Joyce Alden**
(Secretary).

Meeting: `PRACTICE — April Board Meeting`, `Apr 14, 7:00pm`,
`Fellowship Hall`, `is_demo = true`, `created_by_email = <viewer>`.

Three agenda items:

1. **Welcome & devotion** — presenter Dale. Pre-baked: `transcript_segments`,
   `speaker_map`, rendered `transcript`, `summary`, no action items.
2. **Budget review** — presenter Marian. Pre-baked with two voices and two
   owner-attributed action items, so the user sees what inferred actions look
   like.
3. **Building repairs — roof quote** — empty. The live-take target.

Both pre-baked items set `transcript_source = 'meeting'` so they feed the
meeting-wide speaker panel and are covered by `rewriteMeetingSpeakerMap`.

**Reserved speaker ids.** Seeded segments use `SPEAKER_10`–`SPEAKER_12`.
Whisper's diarizer numbers each recording from `SPEAKER_00`, so the live take's
voice cannot merge into a seeded persona. `meetings.speaker_map` is seeded with
the three names; speaker labels shown to users are positional
(`chronologicalSpeakerOrder`), so the reserved range is invisible.

`report` is seeded empty, so the final step generates a real one.

**Panel visibility and ordering.** `meetingSpeakerStats` is derived purely from
items with `transcript_source = 'meeting'` (`routes/meetings.ts`), so the
meeting-wide speaker panel appears from the seed alone — no `meeting_recordings`
row required. That same code sorts all segments by `start`, and a live take's
segments restart at 0, so after the live take the positional `Speaker N` labels
interleave with the seeded times. This is cosmetic: each panel row also shows a
share percentage and a sample quote, which is how a voice is actually
identified. Step 16's copy therefore points at the sample quote, never at a
specific speaker number.

## 3. Practice API (`src/routes/practice.ts`)

- `POST /api/practice` — create or reset the caller's practice meeting; returns
  `{ok:true, meetingId}`. Reset deletes the existing demo meeting for that email
  (cascading items, recordings, markers, files via `deleteMeeting`) and its demo
  people, then re-seeds. Idempotent: two calls leave exactly one practice
  meeting.
- `GET /api/practice` — `{ok:true, meetingId|null}`, so the tour can resume
  after a reload.
- `DELETE /api/practice` — removes the meeting and its demo people.

## 4. Change to shared behaviour: merging speaker maps

`runMeetingJob` currently ends with `saveMeetingMap(meetingId, map)`, which
**replaces** `meetings.speaker_map`. After the live take, `realMeetingReconcile`
returns `{}` for a single voice, which would wipe the seeded names out of the
meeting-wide panel — and a subsequent **Save speakers** would then strip those
names from the pre-baked transcripts through `rewriteMeetingSpeakerMap`.

`saveMeetingMap` therefore **merges**: `{...existing, ...fresh}`. Fresh keys win
on collision, so reprocessing the same recording still overwrites its own
labels, while names assigned to voices a given run never observed survive. This
is correct beyond the demo: reprocessing should not discard prior naming work.

## 5. Tour engine (`src/public/tour.js`, `tour.css`)

The dim overlay is **four absolutely-positioned panels** framing the anchor's
rect, not one sheet with a CSS cut-out — the hole is genuinely empty, so the
spotlighted control stays clickable with no `pointer-events` handling.

A `requestAnimationFrame` loop re-resolves `document.querySelector(step.anchor)`
and repositions the panels and callout every frame. This is mandatory, not
defensive: `renderItems()` rebuilds item DOM wholesale and the 3-second poll
patches cards underneath the overlay. When the anchor is absent or zero-width,
the spotlight hides and the callout docks bottom-right; the same docking applies
below 700px viewport width.

Steps are data:

```js
{ view:'detail', anchor:'#btn-meeting-rec', title:'…', body:'…',
  advance:{ until: () => !!window.meetingRec, hint:'Waiting for the recording to start…' },
  optional:true }
```

- `view` — `'list'` or `'detail'`; the engine calls the existing globals
  (`switchTab`, `showList`, `openMeeting(practiceId)`) to reach the right screen
  before rendering the step.
- `advance` — omitted means a plain **Next**; `{until}` disables Next and
  auto-advances the instant real app state flips; `optional:true` adds
  **Skip this step**.
- The engine reads `window.meetingRec`, `state.openItemId`,
  `state.meeting.recording_status` and `meetingElapsedSeconds()` — all already
  globals in `app.js`, which therefore needs no instrumentation.

Chrome: a **Walkthrough** button in the header, a one-time dismissible offer on
first visit (it never auto-starts), Back / Next / Skip, "Step *n* of *N*", and
Esc to exit — with a confirm when a recording is running.

Progress is stored in `localStorage` under `grmc.minutes.tour`
(`{done, step}`) — per browser, which is enough to offer the tour once and to
resume after a reload. No per-user server state is added.

## 6. The walkthrough (`src/public/tour-steps.js`)

Nineteen steps, ordered as a real meeting happens.

**Before — list view**

1. Welcome, and the one-sentence model: *one recording for the whole meeting;
   opening a topic is what files the audio under it.*
2. **People** tab — the library is reusable across meetings.
3. **Settings** tab — the Anthropic key drives agenda extraction, summaries and
   the report; transcription is self-hosted and needs no key.
4. The new-meeting form.
5. Open the practice meeting — gated on the real click.

**Before — detail view**

6. *Who is present?* — attendees become selectable presenters and the candidate
   names for voices.
7. Agenda upload extracts ordered items and **replaces** existing ones; manual
   add covers the rest.
8. *Presented by* — what lets processing auto-claim that topic's dominant voice.

**During the meeting**

9. Press **● Record meeting** — once, for the whole meeting. Gated on
   `meetingRec`; optional, for no microphone.
10. The fixed banner: the *Filing under:* line, and the amber
    "No topic opened yet" warning meaning audio lands on the first item.
11. **Open topic 3 as it comes up** — gated on `state.openItemId`, so the user
    watches the banner flip. Explains that collapsing lays down no marker and
    that revisiting a topic concatenates in time order.
12. Talk for ~20 seconds — gated on `meetingElapsedSeconds()`.
13. Typed notes sit alongside the transcript and feed the same summary.
14. **Stop & process** — keep the tab open while the last chunks upload.

**After the meeting**

15. Processing: one serial queue, Whisper on your own server. Skippable.
16. **Who spoke in this meeting?** — name each voice once; Save relabels every
    topic and regenerates summaries. The three seeded voices and the user's own
    appear together here.
17. Summaries fire when a topic collapses or another opens; editing the
    transcript or notes clears the summary so it regenerates.
18. **Generate report** — full minutes plus one consolidated, owner-attributed
    action-item checklist; Download .md and Print / PDF.
19. Finish, with **Delete practice meeting** and a note that the Walkthrough
    button retakes it any time.

## 7. Degradation

No step may dead-end.

- **No microphone, or access denied** — steps 9–15 auto-skip with a callout
  describing what would have happened; the tour continues on the pre-baked
  topics.
- **No Anthropic key** — steps 17 and 18 say what is missing and show an
  example report inside the callout. Nothing invented is written to the
  database.
- **Whisper slow or failed** — step 15 is skippable, and the existing
  retry/reprocess affordances are pointed at rather than hidden.
- **Reload mid-tour** — `GET /api/practice` plus the stored step index offers
  **Resume walkthrough**.

## 8. Testing

Both harnesses already exist in this app.

**jsdom** (as `modal.test.ts` does — boots `index.html` + `app.js` with `fetch`
stubbed; skips when jsdom is absent):

- a step with `until` blocks Next, then auto-advances when the condition flips
- the callout docks and the spotlight hides when the anchor disappears
  mid-step (simulating a `renderItems()` rebuild)
- `optional` steps can always be skipped
- Esc during a running recording asks for confirmation

**`TEST_DATABASE_URL`** (as the existing DB tests do):

- `POST /api/practice` twice leaves exactly one practice meeting
- another user's practice meeting is absent from `GET /api/meetings`
- `GET /api/meetings/:id` 404s for another user's practice meeting
- `DELETE /api/practice` removes the meeting and its demo people
- demo people are absent from `GET /api/people` but present in
  `GET /api/people?all=1&meetingId=<practice>`
- `saveMeetingMap` merges: a fresh map missing a key keeps the stored name,
  and a colliding key takes the fresh value

## Out of scope

- Walkthroughs for the other hub apps (approvals, expenses, social-posts).
- Server-side per-user tour completion state; `localStorage` is sufficient.
- Localisation of the step copy.
- Any change to the transcription pipeline itself beyond the `saveMeetingMap`
  merge.

## Files touched (summary)

**New:** `src/demo.ts`, `src/routes/practice.ts`, `src/demo.test.ts`,
`src/tour.test.ts`, `src/public/tour.js`, `src/public/tour-steps.js`,
`src/public/tour.css`

**Edited:** `src/schema.ts` (migrations), `src/meetings.ts` (`listMeetings`
viewer scoping, `getMeeting` guard, `saveMeetingMap` merge), `src/people.ts`
(`is_demo` on rows and queries), `src/routes/people.ts` (filtering),
`src/routes/meetings.ts` (viewer scoping), `src/transcribeQueue.ts` (merge
call site), `src/index.ts` (register `practiceRoutes`),
`src/public/index.html` (Walkthrough button, `tour.css`, two scripts),
`README.md` (document the walkthrough)
