# Minutes Name Corrections Implementation Plan (plan 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a misheard name or word everywhere in one step (with Undo), make transcript fixes stick to the segments, and once a report exists make speaker renames update the text instead of wiping summaries.

**Architecture:** A pure `corrections.ts` does whole-word, case-aware replacement over text, segments and action items. A DB-level `fixWords` applies it across a meeting (or one topic) inside a transaction and records a snapshot in a new `meeting_changes` table, which `undoChange` restores from — this change log is what plan 5's chat cards reuse. Speaker renames branch on whether a report exists.

**Tech Stack:** TypeScript, Fastify 5, pg, node:test, vanilla JS.

**Spec:** `docs/superpowers/specs/2026-10-21-meeting-minutes-live-edit-design.md` — Goal 1 (renames and transcript fixes after a report exists) and Goal 2 (fix it everywhere). The UI here is deliberately small (a "Fix a name or word" panel and read-only segment transcripts); plan 4 rebuilds the page.

## Global Constraints

- Whole-word, case-aware matching: "John" never matches inside "Johnson"; "john" (lower case) is a different word from "John".
- Fix-everywhere covers: every topic's transcript **segments** (so re-render keeps it) and rendered transcript, summaries, action-item tasks and owners, the report, meeting and topic speaker-map values, meeting-guest names. It never edits the people library; a library person whose name contains the old text is reported back as a flag.
- Corrections never wipe summaries or trigger re-summarizing.
- Before a report exists, speaker renames behave exactly as today (re-render, wipe summaries, re-summarize). Once a report exists (`report_generated_at` set), a rename re-renders the transcript and replaces the old display name with the new one in summaries, action-item owners and the report — no wipe.
- Typed notes edits still re-summarize, as today.
- Every bulk change is undoable while the fields it touched are unchanged since; otherwise Undo refuses with a message, never a partial restore.

## Review Focus

1. **Name inside another word or with punctuation/possessive** ("John's", "John.", "Johnson") → "John's"→"Jon's", "Johnson" untouched. *Test in Task 1.*
2. **Replacement text containing regex/`$` characters** ("$5", "A&B") → inserted literally. *Test in Task 1.*
3. **Undo after a later edit touched the same field** → refused with a clear message, nothing restored. *Test in Task 2.*
4. **Rename of a voice whose old name another voice still uses** → that name stays in text (it still legitimately exists). *Test in Task 3.*
5. **Empty or identical from/to, or no matches** → 400 / "Nothing to change", no change row recorded. *Test in Task 2.*

---

### Task 1: Whole-word replacement (`corrections.ts`)

**Files:** Create `src/corrections.ts`, `src/corrections.test.ts`

**Interfaces — Produces:**
- `export function replaceWords(text: string, from: string, to: string): { text: string; count: number }` — Unicode-aware whole-word match: `from` must not be preceded or followed by a letter or digit (`(?<![\p{L}\p{N}])` … `(?![\p{L}\p{N}])`, flag `u`); `from` is regex-escaped; `to` inserted literally (function replacer).
- `export function replaceInSegments(segs: DiarizedSegment[], from: string, to: string): { segments: DiarizedSegment[]; count: number }`
- `export function replaceInActionItems(items: ActionItem[], from: string, to: string, fields?: Array<"task" | "owner">): { items: ActionItem[]; count: number }` — default both fields.

- [ ] **Step 1: Failing tests:**

```ts
test("replaceWords matches whole words only, keeps possessives and punctuation", () => {
  assert.deepEqual(replaceWords("John met Johnson. John's car, john.", "John", "Jon"),
    { text: "Jon met Johnson. Jon's car, john.", count: 2 });
});
test("replaceWords inserts the replacement literally", () => {
  assert.deepEqual(replaceWords("cost: X", "X", "$5 & $1"), { text: "cost: $5 & $1", count: 1 });
  assert.deepEqual(replaceWords("a.b a b", "a.b", "c"), { text: "c a b", count: 1 });
});
test("replaceWords handles multi-word names and non-Latin text", () => {
  assert.equal(replaceWords("Pastor Jon Hale spoke", "Jon Hale", "John Hale").text, "Pastor John Hale spoke");
  assert.equal(replaceWords("예배 위원회", "예배", "X").count, 1);
});
test("segments and action items report how many places changed", () => {
  const s = replaceInSegments([{ text: "John said", speaker: "S0", start: 0, end: 1 }, { text: "ok", speaker: "S1", start: 1, end: 2 }], "John", "Jon");
  assert.equal(s.count, 1); assert.equal(s.segments[0].text, "Jon said");
  const a = replaceInActionItems([{ task: "Call John", owner: "John", start: 1, end: 2 }], "John", "Jon", ["owner"]);
  assert.deepEqual(a, { items: [{ task: "Call John", owner: "Jon", start: 1, end: 2 }], count: 1 });
});
```

- [ ] **Step 2:** Run `npm test` → FAIL (module missing). **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `feat(meeting-minutes): whole-word name and word replacement`.

---

### Task 2: Fix it everywhere, with Undo

**Files:** Modify `src/schema.ts`, Create `src/fixes.ts`, `src/fixes.test.ts` (DB), Modify `src/routes/meetings.ts`

**Interfaces — Produces:**
- Table:
  ```sql
  CREATE TABLE IF NOT EXISTS meeting_changes (
    id bigserial PRIMARY KEY,
    meeting_id bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    kind text NOT NULL,            -- 'fix', later 'report-edit', 'chat', …
    summary text NOT NULL,         -- "John → Jon: 7 places"
    before jsonb NOT NULL,         -- Snapshot
    after jsonb NOT NULL,          -- Snapshot
    undone_at timestamptz,
    created_by text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS meeting_changes_meeting_idx ON meeting_changes (meeting_id, id);
  ```
- `export interface Snapshot { meeting?: { report?: string; speaker_map?: SpeakerMap }; items?: Record<string, { transcript?: string; transcript_segments?: DiarizedSegment[]; summary?: string; action_items?: ActionItem[]; speaker_map?: SpeakerMap }>; guests?: Record<string, { name: string }> }` — only the fields a change touched.
- `export interface FixCounts { transcripts: number; summaries: number; actionItems: number; report: number; speakers: number; guests: number }`
- `export async function fixWords(pool: Pool, meetingId: number, from: string, to: string, opts?: { itemId?: number; dryRun?: boolean; by?: string }): Promise<{ counts: FixCounts; total: number; changeId: number | null; libraryMatches: Array<{ id: number; name: string }> }>` — one transaction. With `itemId`: that topic's segments/transcript/summary/action items/topic speaker map, and only that topic's section of the report (from its `### ` heading to the next `##`/`###`, located with `topicFor` from `report.ts`, exported). `dryRun` counts without writing. No change row when `total === 0`.
  - Transcript: segments replaced; `transcript` re-rendered from segments with the same speaker order rendering uses (meeting-wide `chronologicalSpeakerOrder` for meeting-sourced topics); topics without segments get `replaceWords` on `transcript`.
  - Report edit goes through the same column write as `saveReportEdit` (bumps `report_updated_at`).
- `export async function undoChange(pool: Pool, meetingId: number, changeId: number): Promise<{ ok: true } | { ok: false; status: number; error: string }>` — 404 unknown/other meeting; 409 `"Already undone."`; 409 `"Something changed these since; undo it by hand."` when any field's current value ≠ `after`; else restores `before`, sets `undone_at`. One transaction.
- `export async function listChanges(pool: Pool, meetingId: number, limit = 20): Promise<Array<{ id: number; kind: string; summary: string; undone: boolean; created_at: string }>>`
- Routes: `POST /api/meetings/:id/fix` body `{ from, to, itemId?, dryRun? }` → `{ ok, counts, total, changeId, libraryMatches }`; 400 `"Say what to replace and what with."` when either is blank after trim or they're equal; 422 `"Nothing to change: “<from>” isn't in this meeting."` when total is 0 and not dryRun. `POST /api/meetings/:id/changes/:cid/undo`. `GET /api/meetings/:id/changes`.

- [ ] **Step 1: Failing DB tests** (`fixes.test.ts`, skip without `TEST_DATABASE_URL`): a meeting with a meeting-sourced topic whose segments say "John", a summary and action item naming John (owner John), a report with "John" under `### 1.` and under `### 2.`, a guest "John Hale", a library person "John Hale":
  - `fixWords(…, "John", "Jon")` → counts `{ transcripts: 1, summaries: 1, actionItems: 2, report: 2, speakers: 0, guests: 1 }`, segments say "Jon", transcript re-rendered, summary unchanged otherwise and **not wiped**, `libraryMatches` = the library person; a change row exists.
  - dry run returns the same counts and writes nothing.
  - `itemId` = topic 2 changes only topic 2's report section.
  - `undoChange` restores every field; a second undo → "Already undone."; undo after `saveReportEdit` changed the report → 409 "Something changed these since", nothing restored.
  - `fixWords(…, "Nobody", "X")` → total 0, `changeId` null.
- [ ] **Step 2:** FAIL. **Step 3:** implement `fixes.ts` + schema + routes (export `topicFor` from `report.ts`). **Step 4:** PASS. **Step 5:** commit `feat(meeting-minutes): fix a name everywhere, with undo`.

---

### Task 3: Speaker renames after a report exists

**Files:** Modify `src/meetings.ts` (`rewriteMeetingSpeakerMap`), `src/routes/meetings.ts` (`PUT …/speaker-map`, `PATCH /api/items/:itemId`), Test `src/meetings.test.ts`

**Interfaces — Produces:**
- `export function renamedVoices(oldMap: SpeakerMap, newMap: SpeakerMap, order: string[]): Array<{ from: string; to: string }>` (in `corrections.ts`) — for each label whose display name (`resolveSpeakerName`) changes, `{ from: oldDisplay, to: newDisplay }`, **skipping** a pair when the old display name is still used by another label in the new map, and de-duplicating.
- `rewriteMeetingSpeakerMap(pool, meetingId, rawMap)` keeps its signature. When the meeting has `report_generated_at`: re-render transcripts, then for each renamed pair replace whole words in summaries, action-item **owners**, and the report (bumping `report_updated_at` when it changed); summaries/status are **not** cleared. Records a `meeting_changes` row (`kind: 'rename'`). Without a report: unchanged behaviour.
- `PUT /api/meetings/:id/speaker-map`: only re-requests summaries when there was no report.
- `PATCH /api/items/:itemId` with `speakerMap` on a meeting that has a report: same rename propagation for that topic (summary, owners, that topic's report section); not `contentChanged`.
- `PATCH /api/items/:itemId` with `transcript` on a topic that has segments → 409 `"This transcript comes from the recording; fix words with “Fix a name or word”."` (a free-text overwrite would be lost on the next re-render).

- [ ] **Step 1: Failing tests:**
  - `renamedVoices({S0:"John"}, {S0:"Jon"}, ["S0"])` → `[{from:"John",to:"Jon"}]`; `renamedVoices({}, {S1:"Linda"}, ["S0","S1"])` → `[{from:"Speaker 2",to:"Linda"}]`; `renamedVoices({S0:"John",S1:"John"}, {S0:"Linda",S1:"John"}, ["S0","S1"])` → `[]`.
  - DB: with a report saved, `rewriteMeetingSpeakerMap` renaming "Speaker 1" → "Linda" keeps the summary (now saying Linda), status unchanged, report text says Linda, `reportEdited` true. Without a report, existing test behaviour (summary wiped) still holds.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `feat(meeting-minutes): speaker renames update the minutes instead of wiping them`.

---

### Task 4: "Fix a name or word" on the page; recorded transcripts read-only

**Files:** Modify `src/public/app.js`, `src/public/app.css`, Test `src/modal.test.ts`

**Interfaces — Consumes:** Task 2 routes.
**Produces in app.js:**
- A panel `#fix-panel` above the Report section: inputs `#fix-from`, `#fix-to`, a scope select `#fix-scope` (`Whole meeting` + each topic), button `#btn-fix-preview` ("Check") → `POST …/fix` with `dryRun:true`, shows "Will change N places: …"; button `#btn-fix-apply` ("Fix") → real call; result line "Changed N places." with an **Undo** button (`.fix-undo[data-change]`) → `POST …/changes/:cid/undo`; then `openMeeting(id)` reload to show new text. Library flag shows "The People list still spells this “John Hale”." Errors via `msg('fix-msg','err',…)`.
- A topic whose `transcript_segments` is non-empty renders its transcript textarea `readonly` with hint "From the recording. Use “Fix a name or word” to correct it." and does not save on blur.

- [ ] **Step 1: Failing browser tests:** preview call sends `{from,to,dryRun:true}` and renders the counts; apply then Undo sends the undo POST with the change id; a topic with segments has a readonly transcript and blur sends no PATCH.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `feat(meeting-minutes): fix a name or word from the meeting page`.
