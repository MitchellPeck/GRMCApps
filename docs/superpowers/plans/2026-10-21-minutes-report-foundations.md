# Minutes Report Foundations Implementation Plan (plan 1 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reports come out at 5–7 pages with only real action items, every topic / sub-section / action item carries a playable time range, the report can be saved after editing, and Google Docs export uses the edited copy.

**Architecture:** The report stays Markdown in `meetings.report`. Time ranges ride along as invisible HTML-comment markers at the end of heading and action-item lines (`<!--t:m12:742.0-1450.5-->`), written by code after Claude returns — Claude only cites `[mm:ss-mm:ss]`, which code validates and converts. Markers are stripped for Google Docs and the `.md` download. Section audio is transcoded on demand by ffmpeg to MP3 (cue-less MediaRecorder WebM can't be seeked by the browser).

**Tech Stack:** TypeScript, Fastify 5, pg, node:test, ffmpeg, vanilla JS front end (`src/public/app.js`).

**Spec:** `docs/superpowers/specs/2026-10-21-meeting-minutes-live-edit-design.md` — this plan covers Goal 3 (listen), Goal 5 (length, action items), Goal 7 (export), and the storage half of Goal 1 (save edits, warn before regenerate). Later plans: 2 name corrections, 3 edit lock, 4 page redesign + Minutes editor, 5 chat.

## Global Constraints

- Report target: "5–7 pages at most"; each topic "about half to three-quarters of a page", unless there's a specific reason, e.g. "a finance review with multiple schedules."
- Action items: only real commitments or assignments — someone agreed to do something, or was asked to. Not every "we should" / "let's". Duplicates across topics are merged.
- Settings `report_instructions` / `report_example` still apply (`reportSystemPrompt` unchanged in shape).
- Reports generated before this change have no markers; they must still render, save and export, just without ▶.
- When a range can't be determined (typed notes only, item with more than one recording, citation outside the topic), there is no ▶ — never a guessed one.
- Regenerating a report that has been edited since generation warns first.
- Schema changes are idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `schema.ts`. Back up the host DB before shipping.
- Tests: `npm test` from `apps/meeting-minutes`. DB tests need `TEST_DATABASE_URL`; browser tests need `jsdom` installed locally (`npm i -D jsdom`, don't commit it); ffmpeg tests skip without ffmpeg. Run with all three available.

## Review Focus

1. **Claude cites a malformed or out-of-range time** (`[99:00-99:30]` in a 10-minute topic, `[soon]`, reversed range) → citation is dropped silently, heading text kept, no ▶, no crash. *Test in Task 4.*
2. **Transcript hand-edited** (text no longer equals the segment rendering) → the edited text is what Claude sees, with no invented timestamps; the topic heading still gets its segment range. *Test in Task 2 and Task 4.*
3. **Old report without markers** → renders without ▶, saves, exports byte-identical to before. *Tests in Task 6 and Task 7.*
4. **Recording file missing, or `start` past the end of the audio** → 404 / clean error JSON, never a hung request or 500 with an ffmpeg dump. *Test in Task 5.*
5. **Marker text leaking** into the Google Doc, the `.md` download or the printed page. *Tests in Task 6 and Task 7.*

---

## File Structure

- Create `src/ranges.ts` — the `AudioRange` type, marker format/parse/strip, clock parsing, a topic's range from its segments. One responsibility: time ranges as text.
- Create `src/ranges.test.ts`.
- Modify `src/transcript.ts` — add `renderTimedTranscript`.
- Modify `src/claude.ts` — new `SUMMARIZE_SYSTEM`, `REPORT_SYSTEM`; `ActionItem` gains optional times; `parseSummary` reads them.
- Modify `src/report.ts` — `ReportItemInput` gains `range` and `timedTranscript`; `attachRanges`; cross-topic dedupe with markers; `estimatePages`; `reportHtml` strips markers.
- Modify `src/minutesWork.ts` — pass timed transcripts and ranges into summaries and the report.
- Modify `src/chunking.ts` — `extractSection`.
- Modify `src/schema.ts`, `src/meetings.ts` — `report_updated_at`, `saveReportEdit`.
- Modify `src/routes/meetings.ts` — section audio routes, `PUT /api/meetings/:id/report`, regenerate guard, export keyed on last change, `.md` stripped.
- Modify `src/public/app.js`, `src/public/app.css` — ▶ in the rendered report, section player, page count, regenerate warning.

---

### Task 1: Time ranges as text (`ranges.ts`)

**Files:**
- Create: `src/ranges.ts`
- Test: `src/ranges.test.ts`

**Interfaces:**
- Produces:
  - `export interface AudioRange { source: "m" | "i"; recordingId: number; start: number; end: number }` — `"m"` = `meeting_recordings.id`, `"i"` = `item_recordings.id`; seconds on that recording's timeline.
  - `export function formatRangeMarker(r: AudioRange): string` → `<!--t:m12:742.0-1450.5-->` (one decimal).
  - `export function splitRangeMarker(line: string): { text: string; range: AudioRange | null }` — removes a trailing marker (and the whitespace before it).
  - `export function stripRangeMarkers(markdown: string): string` — every marker, anywhere.
  - `export function parseClock(s: string): number | null` — `"12:40"` → 760, `"1:02:05"` → 3725; anything else null.
  - `export function formatClock(seconds: number): string` — 760 → `"12:40"`, 3725 → `"1:02:05"`.
  - `export function segmentsRange(segments: DiarizedSegment[], source: "m" | "i", recordingId: number): AudioRange | null` — min `start` to max `end`; null when no segments.

- [ ] **Step 1: Write the failing tests** in `src/ranges.test.ts`:

```ts
test("range markers round-trip and strip", () => {
  const r = { source: "m" as const, recordingId: 12, start: 742, end: 1450.46 };
  assert.equal(formatRangeMarker(r), "<!--t:m12:742.0-1450.5-->");
  assert.deepEqual(splitRangeMarker("### 3. Budget <!--t:m12:742.0-1450.5-->"),
    { text: "### 3. Budget", range: { source: "m", recordingId: 12, start: 742, end: 1450.5 } });
  assert.deepEqual(splitRangeMarker("### 3. Budget"), { text: "### 3. Budget", range: null });
  assert.equal(stripRangeMarkers("a <!--t:i4:1.0-2.0-->\nb"), "a\nb");
});

test("parseClock and formatClock", () => {
  assert.equal(parseClock("12:40"), 760);
  assert.equal(parseClock("1:02:05"), 3725);
  assert.equal(parseClock("soon"), null);
  assert.equal(parseClock("12:75"), null);
  assert.equal(formatClock(760), "12:40");
  assert.equal(formatClock(3725), "1:02:05");
});

test("segmentsRange spans the segments, null when empty", () => {
  const segs = [{ text: "a", speaker: "S0", start: 30, end: 40 }, { text: "b", speaker: "S1", start: 10, end: 20 }];
  assert.deepEqual(segmentsRange(segs, "i", 4), { source: "i", recordingId: 4, start: 10, end: 40 });
  assert.equal(segmentsRange([], "m", 1), null);
});
```

- [ ] **Step 2: Run** `npm test` from `apps/meeting-minutes`. Expected: FAIL to compile, `Cannot find module './ranges'`.
- [ ] **Step 3: Implement** the interfaces above in `src/ranges.ts`. Marker regex: `/\s*<!--t:([mi])(\d+):(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)-->/`. `splitRangeMarker` only honours a marker at end of line; `stripRangeMarkers` removes all.
- [ ] **Step 4: Run** `npm test`. Expected: the three new tests PASS, existing tests unchanged.
- [ ] **Step 5: Commit** `feat(meeting-minutes): time-range markers for report lines`.

---

### Task 2: Timestamped transcript for the AI

**Files:**
- Modify: `src/transcript.ts`
- Test: `src/transcript.test.ts`

**Interfaces:**
- Consumes: `formatClock` (Task 1).
- Produces: `export function renderTimedTranscript(segments: DiarizedSegment[], map: SpeakerMap, order?: string[]): string` — same turn-merging as `renderTranscript`, each line prefixed `[mm:ss] ` with the turn's first segment start: `"[12:40] Linda: …"`. Empty string for no segments.
- Produces: `export function transcriptForAi(item: Pick<AgendaItem, "transcript" | "transcript_segments" | "speaker_map">, order?: string[]): string` — `renderTimedTranscript(...)` when `renderTranscript(segments, map, order) === item.transcript.trim()`, otherwise `item.transcript` unchanged (it was hand-edited; times can't be trusted).

- [ ] **Step 1: Write the failing tests:**

```ts
test("renderTimedTranscript prefixes each turn with its start", () => {
  const segs = [
    { text: "Hello", speaker: "S0", start: 760, end: 762 },
    { text: "all.", speaker: "S0", start: 762, end: 763 },
    { text: "Hi.", speaker: "S1", start: 765, end: 766 },
  ];
  assert.equal(renderTimedTranscript(segs, { S0: "Linda" }), "[12:40] Linda: Hello all.\n[12:45] Speaker 2: Hi.");
});

test("transcriptForAi falls back to the stored text once it has been edited", () => {
  const segs = [{ text: "Jon spoke.", speaker: "S0", start: 5, end: 6 }];
  const map = { S0: "Linda" };
  assert.equal(transcriptForAi({ transcript: "Linda: Jon spoke.", transcript_segments: segs, speaker_map: map }), "[0:05] Linda: Jon spoke.");
  assert.equal(transcriptForAi({ transcript: "Linda: John spoke.", transcript_segments: segs, speaker_map: map }), "Linda: John spoke.");
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL, `renderTimedTranscript` not exported.
- [ ] **Step 3: Implement** both in `src/transcript.ts`. Share the turn-building loop with `renderTranscript` rather than copying it (extract a private `turns()` returning `{ name, start, text }[]`). `formatClock` is `m:ss` under an hour, so `[0:05]`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, existing `renderTranscript` tests still pass.
- [ ] **Step 5: Commit** `feat(meeting-minutes): timestamped transcript for summaries and report`.

---

### Task 3: Fewer, real action items, with times

**Files:**
- Modify: `src/claude.ts` (`ActionItem`, `SUMMARIZE_SYSTEM`, `parseSummary`, `salvageSummary`)
- Modify: `src/minutesWork.ts` (`summarizeNow` passes `transcriptForAi`)
- Test: `src/claude.test.ts`

**Interfaces:**
- Consumes: `parseClock` (Task 1), `transcriptForAi` (Task 2).
- Produces: `export interface ActionItem { task: string; owner: string; start?: number; end?: number }` — seconds on the topic's recording timeline, both present or both absent.

- [ ] **Step 1: Write the failing tests** in `src/claude.test.ts`:

```ts
test("parseSummary reads an action item's time range", () => {
  const r = parseSummary(JSON.stringify({ summary: "s", actionItems: [
    { task: "Send figures", owner: "Bob", at: "12:40-13:05" },
    { task: "Book hall", owner: "Ann", at: "soon" },
    { task: "Call roofer", owner: "Tom", at: "13:05-12:40" },
  ] }));
  assert.deepEqual(r.actionItems, [
    { task: "Send figures", owner: "Bob", start: 760, end: 785 },
    { task: "Book hall", owner: "Ann" },
    { task: "Call roofer", owner: "Tom" },
  ]);
});

test("the summary prompt asks only for real commitments", () => {
  assert.match(SUMMARIZE_SYSTEM, /agreed to do|was asked to/);
  assert.doesNotMatch(SUMMARIZE_SYSTEM, /extract every action item/i);
});
```

(Export `SUMMARIZE_SYSTEM` for the second test.)

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Rewrite `SUMMARIZE_SYSTEM`.** Keep the JSON contract; change the action-item rules to: an action item is a specific task that a named person **agreed to do** or **was asked to do** (or was assigned to a group, e.g. "the trustees"). Not suggestions, ideas, "we should look into", "let's think about", or general aspirations without someone taking it on. One entry per task — merge restatements. Each item has `"at": "mm:ss-mm:ss"`, the stretch where it was agreed, taken from the `[mm:ss]` stamps; `""` when the transcript has no stamps. Keep the summary to "a few sentences and/or short bullets". Update `parseSummary` and `salvageSummary` to read `at` via `parseClock` on each half, keeping the range only when both parse and `end > start`.
- [ ] **Step 4:** In `summarizeNow` (`minutesWork.ts`), pass `transcriptForAi(item, order)` as `transcript`, where `order` is `chronologicalSpeakerOrder` of the meeting's meeting-sourced items when `item.transcript_source === "meeting"`, else undefined. Note the transcript header line in `summarizeItem` to say "(each turn starts with its [mm:ss] time where known)".
- [ ] **Step 5: Run** `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(meeting-minutes): action items are real commitments, with where they were said`.

---

### Task 4: Shorter report with ranges on every section

**Files:**
- Modify: `src/claude.ts` (`REPORT_SYSTEM`, `ReportBodyItem`, `generateReportBody`)
- Modify: `src/report.ts`
- Modify: `src/minutesWork.ts` (`reportInput`)
- Test: `src/report.test.ts`, `src/claude.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces in `report.ts`:
  - `ReportItemInput` gains `range: AudioRange | null` and `timedTranscript: string`.
  - `export function attachRanges(body: string, items: ReportItemInput[]): string`
  - `consolidateActionItems(items)` unchanged signature; lines now end with a marker when the item has `start/end` and the topic has a `range`.
  - `export function estimatePages(markdown: string): number` — words (markers stripped) / 400, rounded to the nearest 0.5, minimum 0.5 for non-empty.
- `reportSources` must **not** hash `range` or `timedTranscript` (so existing saved fingerprints still match).

- [ ] **Step 1: Write the failing tests** in `src/report.test.ts`:

```ts
const R = { source: "m" as const, recordingId: 12, start: 600, end: 1200 };

test("attachRanges marks topic headings by number and converts in-range sub-section cites", () => {
  const items = [item({ id: 1, title: "Budget", range: R }), item({ id: 2, title: "Roof", range: null })];
  const body = [
    "### 1. Budget",
    "#### Schedule A — Operating [10:30-12:00]",
    "#### Schedule B [99:00-99:30]",
    "#### Schedule C [soon]",
    "### 2. Roof",
  ].join("\n");
  assert.equal(attachRanges(body, items), [
    "### 1. Budget <!--t:m12:600.0-1200.0-->",
    "#### Schedule A — Operating <!--t:m12:630.0-720.0-->",
    "#### Schedule B",
    "#### Schedule C",
    "### 2. Roof",
  ].join("\n"));
});

test("action items merge across topics and carry their time", () => {
  const items = [
    item({ id: 1, title: "Budget", range: R, actionItems: [{ task: "Send figures", owner: "Bob", start: 700, end: 720 }] }),
    item({ id: 2, title: "Roof", range: null, actionItems: [{ task: "send figures", owner: "bob" }] }),
  ];
  assert.deepEqual(consolidateActionItems(items), ["- [ ] Send figures — **Bob** (Budget) <!--t:m12:700.0-720.0-->"]);
});

test("estimatePages ignores markers", () => {
  assert.equal(estimatePages("word ".repeat(800) + "<!--t:m1:0.0-1.0-->"), 2);
  assert.equal(estimatePages(""), 0);
});

test("reportSources ignores range and timedTranscript", () => {
  const a = reportSources(input());
  const b = reportSources(input({ items: input().items.map((it) => ({ ...it, range: R, timedTranscript: "[0:01] x" })) }));
  assert.deepEqual(a, b);
});
```

Update the `item()` helper defaults with `range: null, timedTranscript: ""`. In `claude.test.ts`:

```ts
test("the report prompt sets a length budget and asks for cited times", () => {
  const p = reportSystemPrompt("", "");
  assert.match(p, /5[–-]7 pages/);
  assert.match(p, /\[mm:ss-mm:ss\]/);
  assert.doesNotMatch(p, /comprehensive/i);
  assert.doesNotMatch(p, /Keep every concrete/);
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Rewrite `REPORT_SYSTEM`.** Keep the section list, headings, formatting rules, the "never invent" rule and the "don't write title/attendance/action items" rule. Replace the "comprehensive… keep every concrete fact" paragraph with a summarizing brief:
  - Minutes record what was reported, what was decided and what happens next — not a retelling of the discussion.
  - The whole body is at most about **2,500 words** so the finished minutes are **5–7 pages at most**. Each agenda item gets **about 150–300 words** (half to three-quarters of a page). Go longer only when the item genuinely needs it, such as a financial report walking through several schedules; even then, keep each schedule to its key figures and comments.
  - Keep the figures that matter (totals, balances, amounts approved, votes with mover/seconder/outcome, dates and deadlines). Leave out figures that were only read through without comment.
  - Each "####" sub-heading ends with the time range it covers, as `[mm:ss-mm:ss]` taken from the `[mm:ss]` stamps in that item's transcript; leave it off when the transcript has no stamps. Never put a time anywhere else.
  - The `### <n>. <title>` heading line carries no time (code adds it).
- [ ] **Step 4:** `reportBodyInput` sends `timedTranscript || transcript` as the item's transcript; `generateReportBody`'s transcript label says "(each turn starts with its [mm:ss] time where known)".
- [ ] **Step 5: Implement `attachRanges`:** walk lines; a line matching `^### (\d+)\.` gets `formatRangeMarker(items[n-1].range)` when that range exists; while inside item *n*, a `####` line ending in `\[([\d:]+)-([\d:]+)\]` is converted to a marker when both clocks parse, `end > start`, and the range lies within the topic range widened by 5 s; otherwise the bracket is removed. Brackets on non-`####` lines are left alone. `buildReport` calls `attachRanges(body, input.items)` before assembling.
- [ ] **Step 6: Update `consolidateActionItems`:** dedupe key is `task.toLowerCase()|owner.toLowerCase()` (no item id), first occurrence wins and keeps its item title; append a marker from `{ ...item.range, start, end }` when both exist.
- [ ] **Step 7: Update `reportInput` (`minutesWork.ts`):** for each item set `timedTranscript = transcriptForAi(it, order)` and `range`:
  - `transcript_source === "meeting"` → `segmentsRange(it.transcript_segments, "m", latest meeting recording id)`.
  - Otherwise, when `listRecordings(pool, it.id)` has exactly one recording → `segmentsRange(segs, "i", thatId)`.
  - Else null.
- [ ] **Step 8: Run** `npm test`. Expected: PASS, including the existing `buildReport` tests (update their expected action-item line only where dedupe-across-topics changes it).
- [ ] **Step 9: Commit** `feat(meeting-minutes): 5–7 page report with time ranges on topics, sections and action items`.

---

### Task 5: Section audio

**Files:**
- Modify: `src/chunking.ts`
- Modify: `src/routes/meetings.ts`
- Test: `src/chunking.test.ts`

**Interfaces:**
- Produces:
  - `export const MAX_SECTION_SECONDS = 1800;`
  - `export function extractSection(inputPath: string, start: number, seconds: number): Promise<Buffer>` — MP3, mono, 64 kbit/s (`-c:a libmp3lame -b:a 64k -ac 1 -f mp3`), duration capped at `MAX_SECTION_SECONDS`. Rejects with a short message (last ffmpeg line, no full log) on failure. Resolves to an empty buffer when `start` is past the end.
  - `GET /api/meeting-recordings/:rid/section?start=&end=` and `GET /api/recordings/:id/section?start=&end=` → `audio/mpeg`, `cache-control: private, max-age=3600`. 400 when start/end are not finite, `start < 0` or `end <= start`; 404 when the recording row or file is missing; 416 with `{ ok:false, error:"That part of the recording doesn't exist." }` when the result is empty.

- [ ] **Step 1: Write the failing test** next to the existing `extractClip` test (same fixture, same `hasFfmpeg` skip):

```ts
test("extractSection returns MP3 of the requested stretch and nothing past the end", { skip: !hasFfmpeg }, async () => {
  const { extractSection } = await import("./chunking");
  const mp3 = await extractSection(input, 600, 90);
  assert.ok(mp3.length > 0);
  assert.equal(mp3.subarray(0, 3).toString("latin1") === "ID3" || (mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0), true);
  const past = await extractSection(input, 1e6, 10);
  assert.equal(past.length, 0);
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL, `extractSection` not exported.
- [ ] **Step 3: Implement** `extractSection` beside `extractClip` (same spawn pattern, `-ss` before `-i`).
- [ ] **Step 4: Add the two routes** after the existing `/clip` route, sharing one `sendSection(reply, storagePath, start, end)` helper with the validation and status codes above.
- [ ] **Step 5: Run** `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(meeting-minutes): play any section of a recording`.

---

### Task 6: Save edits, warn before regenerating, export the edited copy

**Files:**
- Modify: `src/schema.ts`, `src/meetings.ts`, `src/report.ts` (`reportHtml`), `src/minutesWork.ts` (`ReportState`), `src/routes/meetings.ts`
- Test: `src/meetings.test.ts` (DB), `src/report.test.ts`

**Interfaces:**
- Produces:
  - Column `meetings.report_updated_at timestamptz` (`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS report_updated_at timestamptz;`). `MeetingRow.report_updated_at: string | null`.
  - `saveReport` also sets `report_updated_at = now()`.
  - `export async function saveReportEdit(pool: Pool, meetingId: number, markdown: string): Promise<void>` — sets `report` and `report_updated_at = now()`; leaves `report_generated_at` and `report_sources` alone.
  - `export function reportEdited(m: Pick<MeetingRow, "report_generated_at" | "report_updated_at">): boolean` — true when `report_updated_at` is later than `report_generated_at`.
  - `ReportState` gains `edited: boolean`, `updatedAt: string | null`, `pages: number` (`estimatePages(meeting.report)`).
  - `PUT /api/meetings/:id/report` body `{ markdown: string }` → `{ ok: true, report: ReportState }`. 404 no meeting; 400 when `markdown` isn't a string; 409 `"The report is being written. Try again when it finishes."` while `report_status === "pending"`; 409 `"Generate the report first."` when there's no report yet.
  - `POST /api/meetings/:id/report`: when `reportEdited(meeting)` and the body lacks `replaceEdits: true` → 409 `{ ok:false, edited:true, error:"Regenerating replaces the edits you've made to these minutes." }`.
  - Google export: dedupe compares `report_docs.report_at` with `COALESCE(report_updated_at, report_generated_at)` and stores that value; the Doc HTML is `reportHtml(stripRangeMarkers(meeting.report), name)`.
  - `GET /api/meetings/:id/report.md` sends `stripRangeMarkers(meeting.report)`.

- [ ] **Step 1: Write the failing tests.** In `report.test.ts`:

```ts
test("reportHtml never shows range markers", () => {
  const html = reportHtml("### 1. Budget <!--t:m12:600.0-1200.0-->\n- [ ] Send — **Bob** <!--t:m12:700.0-720.0-->", "x");
  assert.doesNotMatch(html, /<!--t:|t:m12/);
  assert.match(html, /<h3>1\. Budget<\/h3>/);
});
```

(`reportHtml` strips markers itself, so every caller is safe; the route-level strip in Step 4 is then just `reportHtml(meeting.report, …)`.) In `meetings.test.ts` (skips without `TEST_DATABASE_URL`):

```ts
test("an edited report keeps its generation time and reads as edited", { skip: !url }, async () => {
  // create meeting → saveReport(pool, id, "# A") → reportEdited false
  // saveReportEdit(pool, id, "# B") → getMeeting: report "# B", report_generated_at unchanged,
  //   report_updated_at > report_generated_at, reportEdited true
  // saveReport(pool, id, "# C") → reportEdited false again
});
```

Write it out with real assertions following the file's existing lifecycle test.
- [ ] **Step 2: Run** `npm test` with `TEST_DATABASE_URL` set. Expected: FAIL.
- [ ] **Step 3: Implement** schema column, `MeetingRow` field + row mapping, `saveReport` change, `saveReportEdit`, `reportEdited`, `ReportState` fields, `reportHtml` stripping.
- [ ] **Step 4: Implement** the PUT route, the POST guard, the export change, and the `.md` strip in `routes/meetings.ts`.
- [ ] **Step 5: Run** `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(meeting-minutes): save edited minutes; export and download the edited copy`.

---

### Task 7: ▶ in the report view, page count, regenerate warning

**Files:**
- Modify: `src/public/app.js` (`renderMarkdown`, report section of `renderDetail`, `generateReport`, `renderReportState`), `src/public/app.css`
- Test: `src/modal.test.ts` (jsdom; or a new `src/reportView.test.ts` reusing its `boot()` pattern)

**Interfaces:**
- Consumes: section routes (Task 5), `ReportState.edited/pages` and the 409 `edited` response (Task 6).
- Produces in `app.js`:
  - `renderMarkdown(md)` strips each line's trailing marker; a heading or list item that had one gets, before its text, `<button type="button" class="sec-play" data-src="m|i" data-rec="12" data-start="742.0" data-end="1450.5" title="Play 12:22–24:10">▶</button>` and after it `<span class="sec-time">12:22–24:10</span>`. Lines without a marker render exactly as today.
  - One shared `<audio>` for sections, separate from `samplePlayer`. Clicking a `.sec-play` loads `/api/meeting-recordings/<rec>/section?…` (`m`) or `/api/recordings/<rec>/section?…` (`i`) and plays; clicking the playing button stops it (shows ■ while playing); starting a speaker sample stops a section and vice versa.
  - The report action row shows `≈ N pages` from `state.report.pages`.
  - `generateReport` on a 409 with `edited:true` asks `confirm("Regenerating replaces the edits you've made to these minutes. Regenerate anyway?")` and on yes re-posts with `{ replaceEdits: true }`.
  - `@media print { .sec-play, .sec-time { display: none } }` in `app.css`.

- [ ] **Step 1: Write the failing browser tests:**

```ts
test("report lines with a time range get a play button; plain lines don't", { skip }, () => {
  const { w } = boot();
  const html = w.renderMarkdown("### 1. Budget <!--t:m12:600.0-1200.0-->\n### 2. Roof\n- [ ] Send — **Bob** <!--t:i4:5.0-9.0-->");
  assert.equal((html.match(/class="sec-play"/g) || []).length, 2);
  assert.match(html, /data-src="i" data-rec="4" data-start="5.0" data-end="9.0"/);
  assert.doesNotMatch(html, /<!--t:/);
  assert.match(html, /<h3>2\. Roof<\/h3>/);
});

test("regenerating edited minutes asks first and sends replaceEdits", { skip }, async () => {
  // boot with a meeting whose report exists; stub POST /report to answer 409 {edited:true} once, then 200;
  // stub confirm → true; click #btn-report; assert two POSTs, the second body has replaceEdits: true.
  // With confirm → false: one POST only.
});
```

Expose `renderMarkdown` on `window` only if the existing tests reach app functions that way; otherwise assert on `#report-box` innerHTML after rendering a detail with that report.
- [ ] **Step 2: Run** `npm test` with jsdom installed. Expected: FAIL.
- [ ] **Step 3: Implement** the `app.js` and `app.css` changes above. Parse the marker in JS with the same regex as `ranges.ts`; format times with a JS `fmtClock` that handles hours (the existing `fmtClock` is `m:ss` only — extend it).
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Manual check** with the `run` skill: generate a report on a meeting with a whole-meeting recording, press ▶ on a topic, a `####` section and an action item; print preview shows no ▶ or times; Open in Google Docs shows no marker text; page count shows.
- [ ] **Step 6: Commit** `feat(meeting-minutes): play report sections, page count, warn before regenerating edited minutes`.
