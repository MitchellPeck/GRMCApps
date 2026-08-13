# Meeting Minutes Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make transcription fast and asynchronous, stop diarization from splitting one person into many speakers, gate summaries on transcription completion, and replace every `prompt()` dialog with real modals.

**Architecture:** The Fastify app keeps its current shape — plain TypeScript modules under `src/`, thin route files, a vanilla-JS single-page frontend in `src/public/app.js`. Transcription moves from a blocking request handler into a single in-process FIFO queue whose state lives in Postgres, with audio persisted to a Docker volume so jobs survive a container restart. Speaker cleanup becomes a three-layer pipeline (deterministic micro-turn absorption → Claude reconciliation → presenter auto-assignment) implemented as pure functions plus one Claude call.

**Tech Stack:** TypeScript 5.6 (CommonJS, strict), Fastify 5, `pg`, node's built-in test runner (`node --test`), vanilla ES5-style browser JS, Docker Compose, `hwdsl2/whisper-server` (faster-whisper + sherpa-onnx diarization), Anthropic Messages API (`claude-sonnet-4-6`).

**Spec:** `docs/superpowers/specs/2026-08-13-meeting-minutes-improvements-design.md`

## Global Constraints

- All work is inside `apps/meeting-minutes/` except Task 1, which edits `docker-compose.yml` at the repo root.
- TypeScript is `strict: true`, `target: es2022`, `module: commonjs`, `rootDir: src`, `outDir: dist`. No new npm dependencies — everything uses node built-ins, `fastify`, and `pg`, which are already present.
- Tests use `node:test` + `node:assert/strict`, compiled first. Full suite: `npm test` (runs `tsc && node --test --test-concurrency=1 "dist/*.test.js"`). Single file: `npx tsc && node --test dist/<name>.test.js`.
- Tests that need Postgres are gated on `process.env.TEST_DATABASE_URL` and use `{ skip: !url }`. Never write a test that requires a live database or a live network call without that gate.
- Browser code in `src/public/app.js` is ES5-flavoured: `var`, `function(){}`, no arrow functions, no `const`/`let`, no template literals, no `async`/`await`. Match the surrounding style exactly.
- Every string rendered into HTML in `app.js` goes through the existing `esc()` helper.
- Whisper diarization labels are raw strings like `SPEAKER_00`. The user-facing label is `Speaker 1`, `Speaker 2`, … numbered by **first appearance order**, produced by the existing `friendlyLabel()`.
- Recordings are **never** deleted by any code path except cascade from deleting an agenda item or meeting.
- Auto-summary must never fire while an item's `transcribe_status` is `queued` or `processing`.
- Importing an agenda must never add anyone to `meeting_attendees`.
- Commit after every task, using the repo's `type(scope): subject` convention, e.g. `feat(meeting-minutes): …`, `fix(meeting-minutes): …`.

---

### Task 1: Tune the Whisper container

**Files:**
- Modify: `docker-compose.yml` (the `whisper` service, currently around lines 200-220)
- Modify: `README.md` (the meeting-minutes bullet, around line 85)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by code. Later tasks assume the container returns `verbose_json` with per-segment `speaker` fields, which is unchanged.

**Context:** The container currently runs at close to worst-case settings. `WHISPER_THREADS` defaults to **2** (of the host's 8 cores), `WHISPER_BEAM` defaults to **5**, and the model is multilingual `small` rather than the faster English-only `small.en`. `WHISPER_DIARIZE_THRESHOLD` defaults to 0.5, where a *higher* value clusters more aggressively and yields *fewer* speakers.

- [ ] **Step 1: Replace the `whisper` service environment block**

In `docker-compose.yml`, find the `whisper:` service and replace its `environment:` block with:

```yaml
    environment:
      # English-only weights: faster AND more accurate than multilingual `small`
      # for English audio. NOTE: first boot after changing this downloads a
      # fresh ~465 MB model into the whisperdata volume.
      WHISPER_MODEL: "${WHISPER_MODEL:-small.en}"
      WHISPER_LANGUAGE: "en"
      # The host is an 8-core Apple Silicon Mac. The image defaults to 2
      # threads, which was the single biggest cause of slow transcription.
      # 6 leaves two cores for the rest of the stack.
      WHISPER_THREADS: "${WHISPER_THREADS:-6}"
      # Greedy decoding. Roughly 2-3x faster than the default beam of 5, with
      # negligible accuracy loss on clean English speech.
      WHISPER_BEAM: "${WHISPER_BEAM:-1}"
      # The image's documented recommendation for CPU inference.
      WHISPER_COMPUTE_TYPE: "${WHISPER_COMPUTE_TYPE:-int8}"
      WHISPER_DIARIZATION: "true"      # label who is speaking (SPEAKER_00, 01, …)
      # Clustering threshold: lower = more speakers, higher = fewer. The 0.5
      # default split four people in a room into eight voices.
      WHISPER_DIARIZE_THRESHOLD: "${WHISPER_DIARIZE_THRESHOLD:-0.7}"
      # Empty = auth disabled. With the whisperdata volume mounted the server
      # otherwise auto-generates a Bearer token and rejects unauthenticated
      # calls ("missing authorization header"). Safe here: no published ports,
      # reachable only by the app on the private hubnet.
      WHISPER_API_KEY: ""
```

- [ ] **Step 2: Verify the compose file still parses and the values resolved**

Run: `cd /Users/mitchellpeck/WebstormProjects/GRMCApps && docker compose config --services`
Expected: the service list prints without error, including `whisper`.

Run: `docker compose config | grep -A 12 'WHISPER_MODEL'`
Expected: `WHISPER_MODEL: small.en`, `WHISPER_THREADS: "6"`, `WHISPER_BEAM: "1"`, `WHISPER_COMPUTE_TYPE: int8`, `WHISPER_DIARIZE_THRESHOLD: "0.7"`.

If `docker compose` is unavailable on this machine, run `python3 -c "import yaml,sys; yaml.safe_load(open('docker-compose.yml'))"` instead and confirm it exits 0.

- [ ] **Step 3: Document the tunables in the README**

In `README.md`, find the meeting-minutes bullet that mentions the self-hosted Whisper service and append this paragraph directly after it:

```markdown
  Transcription speed is tuned through the `whisper` service in
  `docker-compose.yml`, and every value can be overridden from `.env` without a
  rebuild: `WHISPER_MODEL` (default `small.en`), `WHISPER_THREADS` (default
  `6`, sized for an 8-core host), `WHISPER_BEAM` (default `1`, greedy),
  `WHISPER_COMPUTE_TYPE` (default `int8`), and `WHISPER_DIARIZE_THRESHOLD`
  (default `0.7` — raise it if one person is still split across several
  speakers, lower it if two people are being merged). Changing `WHISPER_MODEL`
  triggers a one-time model download into the `whisperdata` volume, so the
  first transcription after that change is slow.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add docker-compose.yml README.md
git commit -m "perf(meeting-minutes): tune whisper threads, beam, model and diarization threshold"
```

---

### Task 2: Merge transcript turns by resolved speaker name

**Files:**
- Modify: `apps/meeting-minutes/src/transcript.ts`
- Modify: `apps/meeting-minutes/src/public/app.js:484-501` (the `renderTranscriptJS` mirror)
- Test: `apps/meeting-minutes/src/transcript.test.ts`

**Interfaces:**
- Consumes: `DiarizedSegment` from `./whisper`, `distinctSpeakers` and `friendlyLabel` from `./transcript` (all exist).
- Produces: `resolveSpeakerName(speaker: string, map: SpeakerMap, order: string[]): string`, exported from `./transcript`. `renderTranscript(segments: DiarizedSegment[], map: SpeakerMap): string` keeps its signature but now merges consecutive turns that resolve to the same **display name**.

**Context:** Once Claude reconciliation can map `SPEAKER_00` and `SPEAKER_02` both to "Alice Smith", the current label-keyed merge emits two consecutive `Alice Smith:` lines. Merging must key on the resolved name.

- [ ] **Step 1: Write the failing tests**

Append to `apps/meeting-minutes/src/transcript.test.ts`:

```typescript
test("renderTranscript merges consecutive turns that resolve to the same name", () => {
  const segs = [
    seg("I move we approve it.", "SPEAKER_00"),
    seg("Seconded, if that helps.", "SPEAKER_02"),
    seg("Any discussion?", "SPEAKER_00"),
  ];
  const out = renderTranscript(segs, { SPEAKER_00: "Alice", SPEAKER_02: "Alice" });
  assert.equal(out, "Alice: I move we approve it. Seconded, if that helps. Any discussion?");
});

test("renderTranscript still separates turns resolving to different names", () => {
  const segs = [
    seg("I move we approve it.", "SPEAKER_00"),
    seg("Seconded.", "SPEAKER_02"),
  ];
  const out = renderTranscript(segs, { SPEAKER_00: "Alice", SPEAKER_02: "Bob" });
  assert.equal(out, "Alice: I move we approve it.\nBob: Seconded.");
});

test("resolveSpeakerName prefers the mapped name and falls back to Speaker N", () => {
  const order = ["SPEAKER_01", "SPEAKER_00"];
  assert.equal(resolveSpeakerName("SPEAKER_01", { SPEAKER_01: "Alice" }, order), "Alice");
  assert.equal(resolveSpeakerName("SPEAKER_00", { SPEAKER_01: "Alice" }, order), "Speaker 2");
  assert.equal(resolveSpeakerName("SPEAKER_00", { SPEAKER_00: "   " }, order), "Speaker 2");
});
```

Update the import line at the top of that file to:

```typescript
import { renderTranscript, distinctSpeakers, friendlyLabel, resolveSpeakerName } from "./transcript";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/transcript.test.js`
Expected: FAIL — `tsc` errors with `Module '"./transcript"' has no exported member 'resolveSpeakerName'`.

- [ ] **Step 3: Implement**

In `apps/meeting-minutes/src/transcript.ts`, add `resolveSpeakerName` after `friendlyLabel` and rewrite `renderTranscript`:

```typescript
// The display name for a raw diarization label: the mapped person's name when
// one is set, otherwise the positional "Speaker N" fallback.
export function resolveSpeakerName(speaker: string, map: SpeakerMap, order: string[]): string {
  const mapped = map[speaker];
  if (mapped && mapped.trim()) return mapped.trim();
  return friendlyLabel(speaker, order);
}

// Render diarized segments into a readable, speaker-attributed transcript.
// Consecutive segments that resolve to the SAME DISPLAY NAME are merged into
// one line — several raw labels can map to one person after reconciliation.
// When no segment carries a speaker label, falls back to plain joined text.
export function renderTranscript(segments: DiarizedSegment[], map: SpeakerMap): string {
  if (!segments.length) return "";
  const order = distinctSpeakers(segments);
  if (!order.length) {
    // No diarization labels — just the text.
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
    const spk = s.speaker || (order[0] ?? "SPEAKER_00");
    const name = resolveSpeakerName(spk, map, order);
    if (name !== curName) { flush(); curName = name; }
    buf.push(s.text);
  }
  flush();
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/transcript.test.js`
Expected: PASS — all 9 tests, including the 4 pre-existing ones.

- [ ] **Step 5: Mirror the change in the browser**

In `apps/meeting-minutes/src/public/app.js`, replace the whole `renderTranscriptJS` function (currently at lines 484-501) with:

```javascript
// Mirror of server transcript.ts resolveSpeakerName.
function resolveSpeakerNameJS(speaker, map, order){
  var mapped = map ? map[speaker] : '';
  if(mapped && mapped.trim()) return mapped.trim();
  var idx = order.indexOf(speaker);
  return idx >= 0 ? ('Speaker '+(idx+1)) : 'Speaker';
}
// Mirror of server transcript.ts renderTranscript so remapping updates
// instantly. Merges consecutive turns that resolve to the same display name.
function renderTranscriptJS(segments, map){
  if(!segments || !segments.length) return '';
  var order=distinctSpeakersJS(segments);
  if(!order.length) return segments.map(function(s){return s.text;}).join(' ').trim();
  var lines=[], curName=null, buf=[];
  function flush(){
    if(curName===null || !buf.length) return;
    lines.push(curName+': '+buf.join(' ').trim()); buf=[];
  }
  segments.forEach(function(s){
    var spk = s.speaker || order[0];
    var name = resolveSpeakerNameJS(spk, map||{}, order);
    if(name!==curName){ flush(); curName=name; }
    buf.push(s.text);
  });
  flush();
  return lines.join('\n');
}
```

- [ ] **Step 6: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/transcript.ts apps/meeting-minutes/src/transcript.test.ts apps/meeting-minutes/src/public/app.js
git commit -m "feat(meeting-minutes): merge transcript turns by resolved speaker name"
```

---

### Task 3: Absorb micro-turns from diarization

**Files:**
- Create: `apps/meeting-minutes/src/speakers.ts`
- Test: `apps/meeting-minutes/src/speakers.test.ts` (create)

**Interfaces:**
- Consumes: `DiarizedSegment` from `./whisper`.
- Produces, exported from `./speakers`:
  - `MICRO_TURN_SECONDS: number` (= `1.2`)
  - `interface Turn { speaker: string; start: number; end: number; indexes: number[] }`
  - `buildTurns(segments: DiarizedSegment[]): Turn[]`
  - `absorbMicroTurns(segments: DiarizedSegment[], maxSeconds?: number): DiarizedSegment[]`

**Context:** The reported bug is one person flipping from Speaker 1 to Speaker 2 mid-sentence. Its signature is a very short turn sandwiched between two turns of the *same* other speaker. Removing those deterministically, before any AI is involved, both fixes the common case for free and gives the Claude pass cleaner input.

- [ ] **Step 1: Write the failing tests**

Create `apps/meeting-minutes/src/speakers.test.ts`:

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildTurns, absorbMicroTurns } from "./speakers";
import { DiarizedSegment } from "./whisper";

const seg = (text: string, speaker: string, start: number, end: number): DiarizedSegment =>
  ({ text, speaker, start, end });

test("buildTurns groups consecutive segments sharing a speaker", () => {
  const segs = [
    seg("a", "SPEAKER_00", 0, 1),
    seg("b", "SPEAKER_00", 1, 2),
    seg("c", "SPEAKER_01", 2, 3),
  ];
  const turns = buildTurns(segs);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0], { speaker: "SPEAKER_00", start: 0, end: 2, indexes: [0, 1] });
  assert.deepEqual(turns[1], { speaker: "SPEAKER_01", start: 2, end: 3, indexes: [2] });
});

test("absorbMicroTurns reassigns a short sandwiched turn to its neighbours", () => {
  const segs = [
    seg("So the budget for the year", "SPEAKER_00", 0, 4),
    seg("is about", "SPEAKER_01", 4, 4.6),
    seg("twelve thousand dollars.", "SPEAKER_00", 4.6, 8),
  ];
  const out = absorbMicroTurns(segs);
  assert.deepEqual(out.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_00", "SPEAKER_00"]);
});

test("absorbMicroTurns leaves a genuinely long sandwiched turn alone", () => {
  const segs = [
    seg("What do you think?", "SPEAKER_00", 0, 2),
    seg("I think we should wait until the next quarter before committing.", "SPEAKER_01", 2, 8),
    seg("Fair enough.", "SPEAKER_00", 8, 9),
  ];
  const out = absorbMicroTurns(segs);
  assert.deepEqual(out.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_01", "SPEAKER_00"]);
});

test("absorbMicroTurns leaves a short turn between two DIFFERENT speakers alone", () => {
  const segs = [
    seg("Ready?", "SPEAKER_00", 0, 1),
    seg("Yes.", "SPEAKER_01", 1, 1.4),
    seg("Then let's go.", "SPEAKER_02", 1.4, 3),
  ];
  const out = absorbMicroTurns(segs);
  assert.deepEqual(out.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_01", "SPEAKER_02"]);
});

test("absorbMicroTurns leaves leading and trailing short turns alone", () => {
  const segs = [
    seg("Uh.", "SPEAKER_01", 0, 0.4),
    seg("Welcome everyone to the meeting.", "SPEAKER_00", 0.4, 5),
    seg("Mm.", "SPEAKER_01", 5, 5.3),
  ];
  const out = absorbMicroTurns(segs);
  assert.deepEqual(out.map((s) => s.speaker), ["SPEAKER_01", "SPEAKER_00", "SPEAKER_01"]);
});

test("absorbMicroTurns collapses repeated flips within one sentence", () => {
  const segs = [
    seg("We need", "SPEAKER_00", 0, 0.8),
    seg("to book", "SPEAKER_01", 0.8, 1.4),
    seg("the hall", "SPEAKER_00", 1.4, 2.0),
    seg("for June.", "SPEAKER_01", 2.0, 2.6),
    seg("Agreed, I will call them tomorrow morning.", "SPEAKER_00", 2.6, 8),
  ];
  const out = absorbMicroTurns(segs);
  assert.deepEqual(out.map((s) => s.speaker),
    ["SPEAKER_00", "SPEAKER_00", "SPEAKER_00", "SPEAKER_00", "SPEAKER_00"]);
});

test("absorbMicroTurns does not mutate its input", () => {
  const segs = [
    seg("a", "SPEAKER_00", 0, 4),
    seg("b", "SPEAKER_01", 4, 4.5),
    seg("c", "SPEAKER_00", 4.5, 8),
  ];
  absorbMicroTurns(segs);
  assert.equal(segs[1].speaker, "SPEAKER_01");
});

test("absorbMicroTurns handles empty and single-segment input", () => {
  assert.deepEqual(absorbMicroTurns([]), []);
  const one = [seg("a", "SPEAKER_00", 0, 1)];
  assert.deepEqual(absorbMicroTurns(one).map((s) => s.speaker), ["SPEAKER_00"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/speakers.test.js`
Expected: FAIL — `tsc` errors with `Cannot find module './speakers'`.

- [ ] **Step 3: Implement**

Create `apps/meeting-minutes/src/speakers.ts`:

```typescript
import { DiarizedSegment } from "./whisper";

// A turn shorter than this, sandwiched between two turns of the same other
// speaker, is treated as a diarization glitch rather than a real interjection.
export const MICRO_TURN_SECONDS = 1.2;

// A maximal run of consecutive segments sharing one speaker label.
export interface Turn {
  speaker: string;
  start: number;
  end: number;
  indexes: number[]; // positions in the source segment array
}

export function buildTurns(segments: DiarizedSegment[]): Turn[] {
  const turns: Turn[] = [];
  segments.forEach((s, i) => {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker) {
      last.end = s.end;
      last.indexes.push(i);
    } else {
      turns.push({ speaker: s.speaker, start: s.start, end: s.end, indexes: [i] });
    }
  });
  return turns;
}

// Repair mid-sentence speaker flips. When a short turn sits between two turns
// belonging to the SAME other speaker, it is almost always the diarizer
// wobbling rather than a real interjection, so reassign it to the surrounding
// speaker. Repeats until no more merges are possible: each pass strictly
// reduces the turn count, so this always terminates.
export function absorbMicroTurns(
  segments: DiarizedSegment[],
  maxSeconds: number = MICRO_TURN_SECONDS
): DiarizedSegment[] {
  const out = segments.map((s) => ({ ...s }));
  for (;;) {
    const turns = buildTurns(out);
    let merged = false;
    for (let i = 1; i < turns.length - 1; i++) {
      const prev = turns[i - 1];
      const cur = turns[i];
      const next = turns[i + 1];
      if (prev.speaker !== next.speaker) continue;
      if (cur.speaker === prev.speaker) continue;
      if (cur.end - cur.start > maxSeconds) continue;
      for (const idx of cur.indexes) out[idx].speaker = prev.speaker;
      merged = true;
      break; // turns are stale now — rebuild and rescan
    }
    if (!merged) return out;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/speakers.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/speakers.ts apps/meeting-minutes/src/speakers.test.ts
git commit -m "feat(meeting-minutes): absorb micro-turns that flip speakers mid-sentence"
```

---

### Task 4: Speaker statistics, dominant speaker, and presenter assignment

**Files:**
- Modify: `apps/meeting-minutes/src/speakers.ts`
- Test: `apps/meeting-minutes/src/speakers.test.ts`

**Interfaces:**
- Consumes: `DiarizedSegment` from `./whisper`, `SpeakerMap` and `distinctSpeakers` from `./transcript`, `buildTurns` from Task 3.
- Produces, exported from `./speakers`:
  - `interface SpeakerStat { speaker: string; label: string; seconds: number; share: number; sample: string }`
  - `speakerStats(segments: DiarizedSegment[]): SpeakerStat[]` — sorted by `seconds` descending
  - `dominantSpeaker(segments: DiarizedSegment[]): string` — `""` when there are no labelled segments
  - `assignPresenterToDominant(segments: DiarizedSegment[], map: SpeakerMap, presenterName: string): SpeakerMap`

**Context:** `speakerStats` feeds the UI so eight near-identical "Speaker N" dropdown rows become distinguishable by talk-time share and a sample quote. `assignPresenterToDominant` replaces the current rule in `routes/meetings.ts`, which only auto-mapped when exactly one speaker was detected. `label` is the positional `Speaker N` string, numbered by first-appearance order — **not** by talk time, so it agrees with `friendlyLabel`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/meeting-minutes/src/speakers.test.ts`:

```typescript
test("speakerStats ranks by talk time and keeps first-appearance labels", () => {
  const segs = [
    seg("Short opener.", "SPEAKER_00", 0, 2),
    seg("A much longer explanation of the budget position.", "SPEAKER_01", 2, 12),
    seg("Right.", "SPEAKER_00", 12, 13),
  ];
  const stats = speakerStats(segs);
  assert.equal(stats.length, 2);
  assert.equal(stats[0].speaker, "SPEAKER_01");
  assert.equal(stats[0].label, "Speaker 2");   // second to appear
  assert.equal(stats[0].seconds, 10);
  assert.equal(stats[1].speaker, "SPEAKER_00");
  assert.equal(stats[1].label, "Speaker 1");
  assert.equal(stats[1].seconds, 3);
  assert.equal(Math.round(stats[0].share * 100), 77);
  assert.equal(stats[0].sample, "A much longer explanation of the budget position.");
});

test("speakerStats ignores unlabelled segments and returns empty for none", () => {
  assert.deepEqual(speakerStats([]), []);
  assert.deepEqual(speakerStats([seg("hi", "", 0, 1)]), []);
});

test("speakerStats truncates a long sample quote", () => {
  const long = "x".repeat(200);
  const stats = speakerStats([seg(long, "SPEAKER_00", 0, 5)]);
  assert.equal(stats[0].sample.length, 81); // 80 chars + the single "…" character
  assert.ok(stats[0].sample.endsWith("…"));
});

test("dominantSpeaker picks the label with the most total speaking time", () => {
  const segs = [
    seg("a", "SPEAKER_00", 0, 2),
    seg("b", "SPEAKER_01", 2, 3),
    seg("c", "SPEAKER_01", 3, 4),
    seg("d", "SPEAKER_00", 4, 9),
  ];
  assert.equal(dominantSpeaker(segs), "SPEAKER_00");
  assert.equal(dominantSpeaker([]), "");
});

test("assignPresenterToDominant maps the busiest voice to the presenter", () => {
  const segs = [
    seg("a", "SPEAKER_00", 0, 10),
    seg("b", "SPEAKER_01", 10, 12),
  ];
  assert.deepEqual(assignPresenterToDominant(segs, {}, "Alice Smith"), { SPEAKER_00: "Alice Smith" });
});

test("assignPresenterToDominant is a no-op when the presenter already has a voice", () => {
  const segs = [
    seg("a", "SPEAKER_00", 0, 10),
    seg("b", "SPEAKER_01", 10, 12),
  ];
  const map = { SPEAKER_01: "alice smith" };
  assert.deepEqual(assignPresenterToDominant(segs, map, "Alice Smith"), map);
});

test("assignPresenterToDominant never overwrites an existing name on the busiest voice", () => {
  const segs = [seg("a", "SPEAKER_00", 0, 10), seg("b", "SPEAKER_01", 10, 12)];
  const map = { SPEAKER_00: "Bob Jones" };
  assert.deepEqual(assignPresenterToDominant(segs, map, "Alice Smith"), map);
});

test("assignPresenterToDominant is a no-op without a presenter or segments", () => {
  const segs = [seg("a", "SPEAKER_00", 0, 10)];
  assert.deepEqual(assignPresenterToDominant(segs, {}, "  "), {});
  assert.deepEqual(assignPresenterToDominant([], {}, "Alice Smith"), {});
});
```

Update the import line at the top of `speakers.test.ts` to:

```typescript
import {
  buildTurns, absorbMicroTurns, speakerStats, dominantSpeaker, assignPresenterToDominant,
} from "./speakers";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/speakers.test.js`
Expected: FAIL — `tsc` errors: `'"./speakers"' has no exported member 'speakerStats'` (and the other three).

- [ ] **Step 3: Implement**

Append to `apps/meeting-minutes/src/speakers.ts`, and add the import at the top of the file:

```typescript
import { SpeakerMap, distinctSpeakers, friendlyLabel } from "./transcript";
```

```typescript
const SAMPLE_MAX_CHARS = 80;

// Per-voice talk time and a representative quote. Rendered in the "Who is
// speaking?" rows so several near-identical "Speaker N" entries can be told
// apart. `label` is positional (first-appearance order), matching
// friendlyLabel; the array itself is sorted by talk time descending.
export interface SpeakerStat {
  speaker: string;  // raw diarization label, e.g. "SPEAKER_00"
  label: string;    // "Speaker 1", "Speaker 2", …
  seconds: number;
  share: number;    // 0..1 of total labelled speaking time
  sample: string;
}

export function speakerStats(segments: DiarizedSegment[]): SpeakerStat[] {
  const order = distinctSpeakers(segments);
  if (!order.length) return [];
  const seconds = new Map<string, number>();
  const longest = new Map<string, string>();
  for (const s of segments) {
    if (!s.speaker) continue;
    seconds.set(s.speaker, (seconds.get(s.speaker) ?? 0) + Math.max(0, s.end - s.start));
    const best = longest.get(s.speaker) ?? "";
    if (s.text.length > best.length) longest.set(s.speaker, s.text);
  }
  const total = [...seconds.values()].reduce((a, b) => a + b, 0);
  return order
    .map((speaker) => {
      const raw = longest.get(speaker) ?? "";
      const sample = raw.length > SAMPLE_MAX_CHARS ? `${raw.slice(0, SAMPLE_MAX_CHARS)}…` : raw;
      const secs = seconds.get(speaker) ?? 0;
      return { speaker, label: friendlyLabel(speaker, order), seconds: secs, share: total > 0 ? secs / total : 0, sample };
    })
    .sort((a, b) => b.seconds - a.seconds);
}

// The label that spoke the most. Ties resolve to whichever appeared first.
export function dominantSpeaker(segments: DiarizedSegment[]): string {
  const stats = speakerStats(segments);
  return stats.length ? stats[0].speaker : "";
}

// Map the busiest voice to the agenda item's presenter. Callers must only pass
// a presenter who is a selected attendee of the meeting. Never overwrites an
// existing assignment, and does nothing if the presenter already owns a voice.
export function assignPresenterToDominant(
  segments: DiarizedSegment[],
  map: SpeakerMap,
  presenterName: string
): SpeakerMap {
  const name = presenterName.trim();
  if (!name) return map;
  const taken = Object.values(map).some((n) => n.trim().toLowerCase() === name.toLowerCase());
  if (taken) return map;
  const dom = dominantSpeaker(segments);
  if (!dom) return map;
  if (map[dom] && map[dom].trim()) return map;
  return { ...map, [dom]: name };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/speakers.test.js`
Expected: PASS — 16 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/speakers.ts apps/meeting-minutes/src/speakers.test.ts
git commit -m "feat(meeting-minutes): add speaker stats, dominant speaker and presenter assignment"
```

---

### Task 5: Extract the presenter during agenda import

**Files:**
- Modify: `apps/meeting-minutes/src/claude.ts` (the `ExtractedItem` interface, `EXTRACT_SYSTEM`, `parseItems`)
- Modify: `apps/meeting-minutes/src/meetings.test.ts:43-46,53` (existing `ExtractedItem` literals)
- Test: `apps/meeting-minutes/src/claude.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ExtractedItem` gains a required `presenter: string` field. `parseItems(raw: string): ExtractedItem[]` returns it, defaulting to `""`.

**Context:** Today a document that says "Budget Report — presented by Jane Doe" produces an item whose *description* contains that phrase, which is why the name only ever shows as subtitle text. The prompt must pull the name into its own field and remove the phrasing from the description.

- [ ] **Step 1: Write the failing tests**

Append to `apps/meeting-minutes/src/claude.test.ts`:

```typescript
test("parseItems reads the presenter field", () => {
  const raw = '[{"title":"Budget","description":"Q2 numbers","presenter":"Jane Doe"}]';
  assert.deepEqual(parseItems(raw), [{ title: "Budget", description: "Q2 numbers", presenter: "Jane Doe" }]);
});

test("parseItems defaults a missing or blank presenter to an empty string", () => {
  const raw = '[{"title":"Budget","description":""},{"title":"Missions","description":"","presenter":"   "}]';
  assert.deepEqual(parseItems(raw), [
    { title: "Budget", description: "", presenter: "" },
    { title: "Missions", description: "", presenter: "" },
  ]);
});

test("parseItems trims a padded presenter name", () => {
  assert.equal(parseItems('[{"title":"T","description":"","presenter":"  Jane Doe  "}]')[0].presenter, "Jane Doe");
});
```

`claude.test.ts` already imports `parseItems` from `./claude`, so no import change is needed here.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/claude.test.js`
Expected: FAIL — `tsc` errors that the object literals are missing the `presenter` property (or the assertions fail on the missing key).

- [ ] **Step 3: Implement**

In `apps/meeting-minutes/src/claude.ts`, replace the `ExtractedItem` interface:

```typescript
export interface ExtractedItem {
  title: string;
  description: string;
  presenter: string; // as written in the document; "" when none is named
}
```

Replace `EXTRACT_SYSTEM`:

```typescript
const EXTRACT_SYSTEM = `You extract the agenda items from a meeting agenda document.
Return ONLY a JSON array. Each element is an object with:
  "title": a short label for the agenda item (required)
  "description": any sub-points, context, or details for that item ("" if none)
  "presenter": the name of the person presenting, leading, or reporting on this
    item, written exactly as it appears in the document ("" if none is named)
Put a presenter's name in "presenter" ONLY. Strip phrasing like "Presented by
Jane Doe", "— Jane Doe", "(Jane Doe)", or "Report from Jane Doe" out of both
"title" and "description"; do not leave the name duplicated there.
Preserve the order items appear in the document. Do not invent items or
presenters. Ignore headers, footers, page numbers, and boilerplate. If the
document has no discernible agenda items, return [].`;
```

Replace the mapping inside `parseItems`:

```typescript
  return parsed
    .map((el) => ({
      title: String(el?.title ?? "").trim(),
      description: String(el?.description ?? "").trim(),
      presenter: String(el?.presenter ?? "").trim(),
    }))
    .filter((el) => el.title.length > 0);
```

- [ ] **Step 4: Fix the now-broken literals in the meetings test**

In `apps/meeting-minutes/src/meetings.test.ts`, update the three `ExtractedItem` literals:

```typescript
  await replaceAgendaItems(pool, meetingId, [
    { title: "Budget", description: "Q2", presenter: "" },
    { title: "Missions", description: "", presenter: "" },
  ], "agenda.pdf");
```

and

```typescript
  await replaceAgendaItems(pool, meetingId, [{ title: "Only", description: "", presenter: "" }], "a2.pdf");
```

- [ ] **Step 5: Run the full suite to verify everything passes**

Run: `cd apps/meeting-minutes && npm test`
Expected: PASS — no `tsc` errors; the DB-backed tests in `meetings.test.js` report as skipped unless `TEST_DATABASE_URL` is set.

- [ ] **Step 6: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/claude.ts apps/meeting-minutes/src/claude.test.ts apps/meeting-minutes/src/meetings.test.ts
git commit -m "feat(meeting-minutes): extract the presenter name during agenda import"
```

---

### Task 6: Match an agenda presenter name to a library person

**Files:**
- Modify: `apps/meeting-minutes/src/people.ts`
- Test: `apps/meeting-minutes/src/people.test.ts`

**Interfaces:**
- Consumes: `Person` and `peopleNamedIn` from `./people` (both exist).
- Produces: `matchPersonByName(name: string, people: Person[]): number | null`, exported from `./people`.

**Context:** An agenda writes "Jane", "Doe", or "Jane Doe" — the library holds full names. Match in a fixed order and refuse to guess when ambiguous, per the spec: full name → unique last name → unique first name → `null`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/meeting-minutes/src/people.test.ts`:

```typescript
const person = (id: number, name: string): Person =>
  ({ id, name, email: "", title: "", active: true });

test("matchPersonByName matches a full name case-insensitively", () => {
  const people = [person(1, "Jane Doe"), person(2, "Bob Jones")];
  assert.equal(matchPersonByName("jane doe", people), 1);
  assert.equal(matchPersonByName("  Jane Doe  ", people), 1);
});

test("matchPersonByName falls back to a unique last name", () => {
  const people = [person(1, "Jane Doe"), person(2, "Bob Jones")];
  assert.equal(matchPersonByName("Doe", people), 1);
});

test("matchPersonByName falls back to a unique first name", () => {
  const people = [person(1, "Jane Doe"), person(2, "Bob Jones")];
  assert.equal(matchPersonByName("Bob", people), 2);
});

test("matchPersonByName refuses an ambiguous last name", () => {
  const people = [person(1, "Jane Doe"), person(2, "John Doe")];
  assert.equal(matchPersonByName("Doe", people), null);
});

test("matchPersonByName refuses an ambiguous first name", () => {
  const people = [person(1, "Jane Doe"), person(2, "Jane Smith")];
  assert.equal(matchPersonByName("Jane", people), null);
});

test("matchPersonByName returns null for unknown, blank, and one-character names", () => {
  const people = [person(1, "Jane Doe")];
  assert.equal(matchPersonByName("Carlos Vega", people), null);
  assert.equal(matchPersonByName("   ", people), null);
  assert.equal(matchPersonByName("J", people), null);
  assert.equal(matchPersonByName("Jane Doe", []), null);
});

test("matchPersonByName finds a full name embedded in a longer phrase", () => {
  const people = [person(1, "Jane Doe")];
  assert.equal(matchPersonByName("Treasurer Jane Doe", people), 1);
});
```

`people.test.ts` already imports `Person` and `peopleNamedIn` from `./people`. Add `matchPersonByName` to that same existing import, leaving the rest of the line intact:

```typescript
import { addPerson, updatePerson, listPeople, setPersonActive, peopleNamedIn, matchPersonByName, Person } from "./people";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/people.test.js`
Expected: FAIL — `tsc` errors with `'"./people"' has no exported member 'matchPersonByName'`.

- [ ] **Step 3: Implement**

Append to `apps/meeting-minutes/src/people.ts`:

```typescript
function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? "";
}

function lastNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

// Resolve a presenter name written in an agenda document to a library person.
// Tries the full name, then a last name, then a first name, and accepts a
// fallback only when exactly one person matches. Ambiguous or unknown names
// return null rather than being guessed at.
export function matchPersonByName(name: string, people: Person[]): number | null {
  const raw = name.trim();
  if (raw.length < 2) return null;

  const byFull = peopleNamedIn(raw, people);
  if (byFull.length === 1) return byFull[0];

  const lower = raw.toLowerCase();
  const byLast = people.filter((p) => lastNameOf(p.name).toLowerCase() === lower);
  if (byLast.length === 1) return byLast[0].id;

  const byFirst = people.filter((p) => firstNameOf(p.name).toLowerCase() === lower);
  if (byFirst.length === 1) return byFirst[0].id;

  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/people.test.js`
Expected: PASS — the 7 new tests plus the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/people.ts apps/meeting-minutes/src/people.test.ts
git commit -m "feat(meeting-minutes): resolve agenda presenter names to library people"
```

---

### Task 7: Link presenters when replacing agenda items

**Files:**
- Modify: `apps/meeting-minutes/src/meetings.ts` (`replaceAgendaItems`)
- Test: `apps/meeting-minutes/src/meetings.test.ts`

**Interfaces:**
- Consumes: `ExtractedItem` (with `presenter`) from Task 5, `matchPersonByName` and `listPeople` from Task 6.
- Produces: `replaceAgendaItems(pool, meetingId, items, agendaFileName)` keeps its signature and now also inserts `agenda_item_presenters` rows for resolvable presenter names.

**Context:** `replaceAgendaItems` already runs inside a transaction; presenter linking joins that transaction. It must **not** touch `meeting_attendees` — attendance stays a manual gate.

- [ ] **Step 1: Write the failing test**

Append to `apps/meeting-minutes/src/meetings.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/meeting-minutes && TEST_DATABASE_URL=$TEST_DATABASE_URL npm test`
Expected: FAIL on the new test with `presenter_ids` coming back as `[]` for the first two items.

If `TEST_DATABASE_URL` is not set in your environment the test skips, which is not a verification. Start a throwaway Postgres and point at it:

```bash
docker run -d --rm --name mm-test-db -e POSTGRES_PASSWORD=test -e POSTGRES_DB=mmtest -p 55432:5432 postgres:16
export TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/mmtest
# create the schema once:
cd apps/meeting-minutes && npx tsc && node -e "const{Pool}=require('pg');const{SCHEMA_SQL}=require('./dist/schema');new Pool({connectionString:process.env.TEST_DATABASE_URL}).query(SCHEMA_SQL).then(()=>process.exit(0))"
```

Tear it down with `docker rm -f mm-test-db` when the task is done.

- [ ] **Step 3: Implement**

In `apps/meeting-minutes/src/meetings.ts`, add to the imports at the top:

```typescript
import { listPeople, matchPersonByName } from "./people";
```

Then replace the body of `replaceAgendaItems`:

```typescript
export async function replaceAgendaItems(
  pool: Pool,
  meetingId: number,
  items: ExtractedItem[],
  agendaFileName: string
): Promise<void> {
  // Resolve presenter names up front, outside the transaction. Unresolvable
  // names are dropped. Attendance is untouched: an import never adds anyone to
  // meeting_attendees.
  const people = await listPeople(pool, true);
  const presenterIds = items.map((it) => (it.presenter ? matchPersonByName(it.presenter, people) : null));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM agenda_items WHERE meeting_id = $1", [meetingId]);
    let pos = 0;
    for (const it of items) {
      const inserted = await client.query(
        "INSERT INTO agenda_items (meeting_id, position, title, description) VALUES ($1, $2, $3, $4) RETURNING id",
        [meetingId, pos, it.title, it.description]
      );
      const pid = presenterIds[pos];
      if (pid !== null) {
        await client.query(
          "INSERT INTO agenda_item_presenters (item_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [Number(inserted.rows[0].id), pid]
        );
      }
      pos++;
    }
    await client.query("UPDATE meetings SET agenda_file_name = $2, updated_at = now() WHERE id = $1", [
      meetingId,
      agendaFileName,
    ]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/meeting-minutes && npm test`
Expected: PASS — all tests, with the DB tests actually executing (not skipped) while `TEST_DATABASE_URL` is exported.

- [ ] **Step 5: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/meetings.ts apps/meeting-minutes/src/meetings.test.ts
git commit -m "feat(meeting-minutes): link agenda presenters to library people on import"
```

---

### Task 8: Claude speaker reconciliation

**Files:**
- Modify: `apps/meeting-minutes/src/claude.ts`
- Test: `apps/meeting-minutes/src/claude.test.ts`

**Interfaces:**
- Consumes: `callClaude` and `stripJsonFences` (both already in `claude.ts`), `SpeakerMap` from `./transcript`.
- Produces, exported from `./claude`:
  - `interface ReconcileInput { meetingTitle: string; itemTitle: string; transcript: string; speakerOrder: string[]; attendees: string[]; presenters: string[] }`
  - `parseSpeakerMap(raw: string, speakerOrder: string[], allowedNames: string[]): SpeakerMap`
  - `reconcileSpeakers(pool: Pool, input: ReconcileInput): Promise<SpeakerMap>`

**Context:** Claude sees the transcript with positional `Speaker N` labels — it never sees raw `SPEAKER_00` strings. `parseSpeakerMap` translates its answer back into raw labels using `speakerOrder` (first-appearance order). Names not in `allowedNames` are dropped, so Claude cannot invent an attendee.

- [ ] **Step 1: Write the failing tests**

Append to `apps/meeting-minutes/src/claude.test.ts`:

```typescript
const ORDER = ["SPEAKER_00", "SPEAKER_01", "SPEAKER_02"];
const NAMES = ["Alice Smith", "Bob Jones"];

test("parseSpeakerMap translates positional labels back to raw labels", () => {
  const raw = '{"Speaker 1":"Alice Smith","Speaker 2":"Bob Jones","Speaker 3":""}';
  assert.deepEqual(parseSpeakerMap(raw, ORDER, NAMES), {
    SPEAKER_00: "Alice Smith",
    SPEAKER_01: "Bob Jones",
  });
});

test("parseSpeakerMap merges several labels onto one person", () => {
  const raw = '{"Speaker 1":"Alice Smith","Speaker 3":"Alice Smith"}';
  assert.deepEqual(parseSpeakerMap(raw, ORDER, NAMES), {
    SPEAKER_00: "Alice Smith",
    SPEAKER_02: "Alice Smith",
  });
});

test("parseSpeakerMap normalizes casing to the canonical attendee name", () => {
  assert.deepEqual(parseSpeakerMap('{"Speaker 1":"alice smith"}', ORDER, NAMES), { SPEAKER_00: "Alice Smith" });
});

test("parseSpeakerMap drops invented names and out-of-range labels", () => {
  const raw = '{"Speaker 1":"Carlos Vega","Speaker 9":"Alice Smith","nonsense":"Bob Jones"}';
  assert.deepEqual(parseSpeakerMap(raw, ORDER, NAMES), {});
});

test("parseSpeakerMap tolerates fenced JSON and malformed output", () => {
  const fenced = '```json\n{"Speaker 2":"Bob Jones"}\n```';
  assert.deepEqual(parseSpeakerMap(fenced, ORDER, NAMES), { SPEAKER_01: "Bob Jones" });
  assert.deepEqual(parseSpeakerMap("I could not tell.", ORDER, NAMES), {});
  assert.deepEqual(parseSpeakerMap('["Speaker 1"]', ORDER, NAMES), {});
  assert.deepEqual(parseSpeakerMap("", ORDER, NAMES), {});
});
```

Add `parseSpeakerMap` to the existing import from `./claude` at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/claude.test.js`
Expected: FAIL — `tsc` errors with `'"./claude"' has no exported member 'parseSpeakerMap'`.

- [ ] **Step 3: Implement**

In `apps/meeting-minutes/src/claude.ts`, add to the imports at the top:

```typescript
import { SpeakerMap } from "./transcript";
```

Append to the file:

```typescript
export interface ReconcileInput {
  meetingTitle: string;
  itemTitle: string;
  transcript: string;      // rendered with positional "Speaker N" labels
  speakerOrder: string[];  // raw labels in first-appearance order
  attendees: string[];     // "Name (Title)" strings for everyone present
  presenters: string[];    // names of this item's presenters
}

const RECONCILE_SYSTEM = `You clean up automatic speaker diarization of a meeting recording.

The transcript labels each turn "Speaker 1", "Speaker 2", and so on. Those
labels are UNRELIABLE in two specific ways: one person is frequently split
across several different labels, and a label sometimes changes in the middle of
a single person's sentence.

You are given the list of people present. Decide which person each label
belongs to. SEVERAL LABELS MAY MAP TO THE SAME PERSON — that is the common case
and the main thing you are here to fix. Merge labels whenever the content reads
as one continuous speaker. Evidence to use: direct address ("Thanks, Alice"),
self-introduction, who answers which question, a person's stated role, and who
owns which topic.

Respond with ONLY a JSON object, no prose around it, mapping every label to a
person's name copied EXACTLY from the list of people present, or to "" when you
genuinely cannot tell:
{ "Speaker 1": "Alice Smith", "Speaker 2": "Alice Smith", "Speaker 3": "" }

Never output a name that is not in the list of people present. Prefer "" over a
guess. Include every label exactly once.`;

// Translate Claude's positional answer back into raw diarization labels.
// Labels outside speakerOrder and names outside allowedNames are dropped, so a
// malformed or hallucinated response degrades to "no opinion" rather than
// corrupting the speaker map.
export function parseSpeakerMap(raw: string, speakerOrder: string[], allowedNames: string[]): SpeakerMap {
  let data: any;
  try { data = JSON.parse(stripJsonFences(raw)); } catch { return {}; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const allowed = new Map(allowedNames.map((n) => [n.trim().toLowerCase(), n.trim()]));
  const out: SpeakerMap = {};
  for (const [key, value] of Object.entries(data)) {
    const m = /^\s*speaker\s*(\d+)\s*$/i.exec(key);
    if (!m) continue;
    const label = speakerOrder[Number(m[1]) - 1];
    if (!label) continue;
    const name = allowed.get(String(value ?? "").trim().toLowerCase());
    if (name) out[label] = name;
  }
  return out;
}

// Ask Claude which person each diarized voice belongs to, merging voices that
// the diarizer split apart. Best-effort by contract: every failure path returns
// {} so a transcription is never lost to a reconciliation problem.
export async function reconcileSpeakers(pool: Pool, input: ReconcileInput): Promise<SpeakerMap> {
  if (!input.speakerOrder.length || !input.transcript.trim() || !input.attendees.length) return {};
  const names = input.attendees.map((a) => a.replace(/\s*\(.*\)\s*$/, "").trim()).filter(Boolean);
  const parts = [
    `Meeting: ${input.meetingTitle}`,
    `Agenda item: ${input.itemTitle}`,
    `People present: ${input.attendees.join(", ")}`,
    input.presenters.length
      ? `Expected to lead this item: ${input.presenters.join(", ")}`
      : "Expected to lead this item: unspecified",
    `Labels to assign: ${input.speakerOrder.map((_, i) => `Speaker ${i + 1}`).join(", ")}`,
    "",
    "Transcript:",
    input.transcript,
  ];
  try {
    const raw = await callClaude(pool, RECONCILE_SYSTEM, parts.join("\n"), 1024);
    return parseSpeakerMap(raw, input.speakerOrder, names);
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/claude.test.js`
Expected: PASS — the 5 new tests plus the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/claude.ts apps/meeting-minutes/src/claude.test.ts
git commit -m "feat(meeting-minutes): reconcile over-split diarization speakers with Claude"
```

---

### Task 9: Transcription status columns and the recordings table

**Files:**
- Modify: `apps/meeting-minutes/src/schema.ts`
- Modify: `apps/meeting-minutes/src/meetings.ts`
- Test: `apps/meeting-minutes/src/meetings.test.ts`

**Interfaces:**
- Consumes: `speakerStats` from `./speakers` (Task 4).
- Produces, exported from `./meetings`:
  - `type TranscribeStatus = "idle" | "queued" | "processing" | "done" | "error"`
  - `AgendaItem` gains `transcribe_status: TranscribeStatus`, `transcribe_error: string`, `speaker_stats: SpeakerStat[]`
  - `setTranscribeStatus(pool: Pool, itemId: number, status: TranscribeStatus, error?: string): Promise<void>`
  - `listUnfinishedTranscriptions(pool: Pool): Promise<number[]>` — item ids stuck in `queued`/`processing`
  - `listItemStatuses(pool: Pool, meetingId: number): Promise<Array<{ id: number; transcribeStatus: TranscribeStatus; transcribeError: string; hasSummary: boolean }>>`

**Context:** `speaker_stats` is computed server-side in `mapItemRow` so the browser has one source of truth for talk-time ordering. `setTranscribeStatus` stamps `transcribe_started_at` on `processing` and `transcribe_finished_at` on `done`/`error`.

- [ ] **Step 1: Write the failing test**

Append to `apps/meeting-minutes/src/meetings.test.ts`:

```typescript
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
```

Add `setTranscribeStatus`, `listUnfinishedTranscriptions`, and `listItemStatuses` to the existing import from `./meetings` at the top of the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/meeting-minutes && npm test`
Expected: FAIL — `tsc` errors with `'"./meetings"' has no exported member 'setTranscribeStatus'`.

- [ ] **Step 3: Add the schema**

In `apps/meeting-minutes/src/schema.ts`, add these four columns to the `CREATE TABLE IF NOT EXISTS agenda_items` body, immediately after the `action_items` line:

```sql
  transcribe_status  text NOT NULL DEFAULT 'idle',
  transcribe_error   text NOT NULL DEFAULT '',
  transcribe_started_at  timestamptz,
  transcribe_finished_at timestamptz,
```

Then, next to the existing `ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS` block, add the matching migrations for existing installs:

```sql
-- Migrate existing installs to asynchronous transcription.
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS transcribe_status text NOT NULL DEFAULT 'idle';
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS transcribe_error text NOT NULL DEFAULT '';
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS transcribe_started_at timestamptz;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS transcribe_finished_at timestamptz;
```

Finally, add the recordings table just before the trailing `CREATE INDEX` line:

```sql
-- Every audio recording ever attached to an agenda item. Files live on the
-- minutesdata volume; rows are never deleted except by cascade, so a recording
-- stays downloadable and re-transcribable for the life of the meeting.
CREATE TABLE IF NOT EXISTS item_recordings (
  id            bigserial PRIMARY KEY,
  item_id       bigint NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  file_name     text NOT NULL DEFAULT '',
  mime_type     text NOT NULL DEFAULT '',
  byte_size     bigint NOT NULL DEFAULT 0,
  storage_path  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS item_recordings_item_idx ON item_recordings (item_id, id);
```

- [ ] **Step 4: Implement the accessors**

In `apps/meeting-minutes/src/meetings.ts`, add to the imports:

```typescript
import { SpeakerStat, speakerStats } from "./speakers";
```

Add the status type above `AgendaItem`:

```typescript
export type TranscribeStatus = "idle" | "queued" | "processing" | "done" | "error";
```

Add three fields to the `AgendaItem` interface, after `action_items`:

```typescript
  transcribe_status: TranscribeStatus;
  transcribe_error: string;
  speaker_stats: SpeakerStat[];
```

In `mapItemRow`, add the corresponding lines to the returned object (place them after `action_items`):

```typescript
    transcribe_status: (row.transcribe_status ?? "idle") as TranscribeStatus,
    transcribe_error: row.transcribe_error ?? "",
    speaker_stats: speakerStats(Array.isArray(row.transcript_segments) ? row.transcript_segments : []),
```

Append the three new functions to the file:

```typescript
// ── Transcription job state ─────────────────────────────────────────────────

// Move an item's transcription job to a new state. Entering `processing`
// stamps the start time; entering a terminal state stamps the finish time.
// Any state other than `error` clears the stored error message.
export async function setTranscribeStatus(
  pool: Pool,
  itemId: number,
  status: TranscribeStatus,
  error = ""
): Promise<void> {
  await pool.query(
    `UPDATE agenda_items
        SET transcribe_status = $2,
            transcribe_error  = CASE WHEN $2 = 'error' THEN $3 ELSE '' END,
            transcribe_started_at  = CASE WHEN $2 = 'processing' THEN now() ELSE transcribe_started_at END,
            transcribe_finished_at = CASE WHEN $2 IN ('done','error') THEN now() ELSE transcribe_finished_at END
      WHERE id = $1`,
    [itemId, status, error]
  );
}

// Item ids whose transcription never finished — used on boot to re-enqueue
// work that a container restart interrupted.
export async function listUnfinishedTranscriptions(pool: Pool): Promise<number[]> {
  const r = await pool.query(
    "SELECT id FROM agenda_items WHERE transcribe_status IN ('queued','processing') ORDER BY id"
  );
  return r.rows.map((row) => Number(row.id));
}

// Lightweight per-item state for the frontend status poll.
export async function listItemStatuses(
  pool: Pool,
  meetingId: number
): Promise<Array<{ id: number; transcribeStatus: TranscribeStatus; transcribeError: string; hasSummary: boolean }>> {
  const r = await pool.query(
    `SELECT id, transcribe_status, transcribe_error, (summary <> '') AS has_summary
       FROM agenda_items WHERE meeting_id = $1 ORDER BY position, id`,
    [meetingId]
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    transcribeStatus: (row.transcribe_status ?? "idle") as TranscribeStatus,
    transcribeError: row.transcribe_error ?? "",
    hasSummary: !!row.has_summary,
  }));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/meeting-minutes && npm test`
Expected: PASS. If the throwaway Postgres from Task 7 is still running, drop and recreate its schema first so the new DDL applies:

```bash
node -e "const{Pool}=require('pg');const{SCHEMA_SQL}=require('./dist/schema');new Pool({connectionString:process.env.TEST_DATABASE_URL}).query(SCHEMA_SQL).then(()=>process.exit(0))"
```

- [ ] **Step 6: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/schema.ts apps/meeting-minutes/src/meetings.ts apps/meeting-minutes/src/meetings.test.ts
git commit -m "feat(meeting-minutes): add transcription job state and the recordings table"
```

---

### Task 10: Persist recordings to disk

**Files:**
- Create: `apps/meeting-minutes/src/recordings.ts`
- Create: `apps/meeting-minutes/src/recordings.test.ts`
- Modify: `apps/meeting-minutes/src/config.ts`
- Modify: `docker-compose.yml` (the `meeting-minutes` service and the `volumes:` block)

**Interfaces:**
- Consumes: `config` from `./config`, `Pool` from `pg`.
- Produces, exported from `./recordings`:
  - `interface Recording { id: number; item_id: number; file_name: string; mime_type: string; byte_size: number; storage_path: string }`
  - `extensionFor(fileName: string, mimeType: string): string`
  - `recordingPath(root: string, itemId: number, recordingId: number, ext: string): string`
  - `saveRecording(pool, itemId, file: { fileName: string; mimeType: string; buffer: Buffer }): Promise<Recording>`
  - `getRecording(pool, recordingId): Promise<Recording | null>`
  - `listRecordings(pool, itemId): Promise<Recording[]>`
  - `latestRecording(pool, itemId): Promise<Recording | null>`
- `config` gains `dataDir: string` (from `MINUTES_DATA_DIR`, default `/data`).

**Context:** Audio must hit disk *before* the job is queued, so a container restart can resume it. Files are never deleted by application code. The extension is whitelisted from a known set so a hostile filename cannot escape the directory.

- [ ] **Step 1: Write the failing tests**

Create `apps/meeting-minutes/src/recordings.test.ts`:

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extensionFor, recordingPath } from "./recordings";

test("extensionFor prefers a recognised filename extension", () => {
  assert.equal(extensionFor("item-4.m4a", "audio/webm"), "m4a");
  assert.equal(extensionFor("Recording.WAV", ""), "wav");
});

test("extensionFor falls back to the mime type", () => {
  assert.equal(extensionFor("blob", "audio/webm"), "webm");
  assert.equal(extensionFor("blob", "audio/mp4"), "m4a");
  assert.equal(extensionFor("blob", "audio/ogg"), "ogg");
  assert.equal(extensionFor("blob", "audio/mpeg"), "mp3");
  assert.equal(extensionFor("blob", "audio/wav"), "wav");
  assert.equal(extensionFor("blob", "audio/x-wav"), "wav");
  assert.equal(extensionFor("blob", "video/webm"), "webm");
});

test("extensionFor defaults to webm for anything unrecognised", () => {
  assert.equal(extensionFor("", ""), "webm");
  assert.equal(extensionFor("weird.xyz", "application/octet-stream"), "webm");
});

test("extensionFor cannot be used to escape the audio directory", () => {
  assert.equal(extensionFor("../../etc/passwd", ""), "webm");
  assert.equal(extensionFor("x.wav/../../evil", ""), "webm");
});

test("recordingPath nests by item id and names the file by recording id", () => {
  assert.equal(recordingPath("/data", 12, 34, "webm"), "/data/audio/12/34.webm");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/recordings.test.js`
Expected: FAIL — `tsc` errors with `Cannot find module './recordings'`.

- [ ] **Step 3: Add the data directory to config**

In `apps/meeting-minutes/src/config.ts`, add one entry to the exported `config` object:

```typescript
  // Persistent storage for meeting audio, mounted from the `minutesdata`
  // volume. Recordings are kept for the life of the meeting so a transcription
  // can always be retried or the original audio downloaded.
  dataDir: process.env.MINUTES_DATA_DIR || "/data",
```

- [ ] **Step 4: Implement the module**

Create `apps/meeting-minutes/src/recordings.ts`:

```typescript
import { Pool } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "./config";

export interface Recording {
  id: number;
  item_id: number;
  file_name: string;
  mime_type: string;
  byte_size: number;
  storage_path: string;
}

// Extensions we are willing to write to disk. Anything else becomes "webm",
// so a hostile upload filename can never influence the path we open.
const KNOWN_EXTENSIONS = ["mp3", "mp4", "m4a", "wav", "webm", "ogg", "oga", "mpeg", "mpga", "flac"];

const MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/mp4": "m4a",
  "video/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
};

export function extensionFor(fileName: string, mimeType: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(fileName.trim());
  const fromName = m ? m[1].toLowerCase() : "";
  if (KNOWN_EXTENSIONS.includes(fromName)) return fromName;
  const fromMime = MIME_EXTENSIONS[mimeType.trim().toLowerCase().split(";")[0]];
  return fromMime ?? "webm";
}

export function recordingPath(root: string, itemId: number, recordingId: number, ext: string): string {
  return join(root, "audio", String(itemId), `${recordingId}.${ext}`);
}

function rowToRecording(row: any): Recording {
  return {
    id: Number(row.id),
    item_id: Number(row.item_id),
    file_name: row.file_name,
    mime_type: row.mime_type,
    byte_size: Number(row.byte_size),
    storage_path: row.storage_path,
  };
}

// Write an uploaded recording to the data volume and record it. The row is
// inserted first so the filename can use its id, then updated with the final
// path. Callers must persist audio through this BEFORE queueing a job, so a
// restart can always resume from disk.
export async function saveRecording(
  pool: Pool,
  itemId: number,
  file: { fileName: string; mimeType: string; buffer: Buffer }
): Promise<Recording> {
  const inserted = await pool.query(
    `INSERT INTO item_recordings (item_id, file_name, mime_type, byte_size, storage_path)
     VALUES ($1, $2, $3, $4, '') RETURNING id`,
    [itemId, file.fileName || "recording", file.mimeType || "", file.buffer.byteLength]
  );
  const id = Number(inserted.rows[0].id);
  const path = recordingPath(config.dataDir, itemId, id, extensionFor(file.fileName, file.mimeType));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.buffer);
  const updated = await pool.query(
    "UPDATE item_recordings SET storage_path = $2 WHERE id = $1 RETURNING *",
    [id, path]
  );
  return rowToRecording(updated.rows[0]);
}

export async function getRecording(pool: Pool, recordingId: number): Promise<Recording | null> {
  const r = await pool.query("SELECT * FROM item_recordings WHERE id = $1", [recordingId]);
  return r.rows[0] ? rowToRecording(r.rows[0]) : null;
}

export async function listRecordings(pool: Pool, itemId: number): Promise<Recording[]> {
  const r = await pool.query("SELECT * FROM item_recordings WHERE item_id = $1 ORDER BY id", [itemId]);
  return r.rows.map(rowToRecording);
}

export async function latestRecording(pool: Pool, itemId: number): Promise<Recording | null> {
  const r = await pool.query(
    "SELECT * FROM item_recordings WHERE item_id = $1 ORDER BY id DESC LIMIT 1",
    [itemId]
  );
  return r.rows[0] ? rowToRecording(r.rows[0]) : null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/recordings.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 6: Mount the volume**

In `docker-compose.yml`, in the `meeting-minutes` service, add a `volumes:` key after `environment:`:

```yaml
    volumes:
      - minutesdata:/data
```

and add `MINUTES_DATA_DIR: "/data"` to that service's `environment:` block.

Then add `minutesdata:` to the top-level `volumes:` block at the bottom of the file, alongside `whisperdata:`.

Run: `docker compose config --services`
Expected: exits 0 with the service list. (Or the `python3 -c "import yaml…"` check from Task 1 if compose is unavailable.)

- [ ] **Step 7: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/recordings.ts apps/meeting-minutes/src/recordings.test.ts apps/meeting-minutes/src/config.ts docker-compose.yml
git commit -m "feat(meeting-minutes): persist meeting recordings to the data volume"
```

---

### Task 11: The serial transcription queue

**Files:**
- Create: `apps/meeting-minutes/src/transcribeQueue.ts`
- Create: `apps/meeting-minutes/src/transcribeQueue.test.ts`
- Modify: `apps/meeting-minutes/src/index.ts`

**Interfaces:**
- Consumes: `absorbMicroTurns` and `assignPresenterToDominant` from `./speakers`, `reconcileSpeakers` from `./claude`, `renderTranscript`/`distinctSpeakers` from `./transcript`, `transcribeAudio` from `./whisper`, `setTranscribeStatus`/`updateAgendaItem`/`getAgendaItem`/`getMeeting`/`getAttendeeIds`/`listUnfinishedTranscriptions` from `./meetings`, `latestRecording`/`getRecording` from `./recordings`, `listPeople` from `./people`.
- Produces, exported from `./transcribeQueue`:
  - `interface TranscribeJob { itemId: number; recordingId: number; path: string; fileName: string; mimeType: string }`
  - `interface QueueDeps { transcribe(job): Promise<TranscriptionResult>; reconcile(job, segments): Promise<SpeakerMap>; setStatus(itemId, status, error?): Promise<void>; saveResult(job, segments, map): Promise<void>; log(message: string): void }`
  - `createQueue(deps: QueueDeps): { enqueue(job: TranscribeJob): void; size(): number; idle(): Promise<void> }`
  - `enqueueTranscription(job: TranscribeJob): void` — the real, module-level queue
  - `recoverPendingJobs(pool: Pool): Promise<number>` — returns how many jobs were re-enqueued

**Context:** `createQueue` takes every side effect as an injected dependency so the state machine is testable with no database, no filesystem, and no network. The reconciliation step is wrapped in a `catch` **inside the queue**, so a Claude failure degrades to raw speaker labels rather than failing the job — that behaviour is tested.

- [ ] **Step 1: Write the failing tests**

Create `apps/meeting-minutes/src/transcribeQueue.test.ts`:

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createQueue, TranscribeJob, QueueDeps } from "./transcribeQueue";
import { DiarizedSegment, TranscriptionResult } from "./whisper";
import { SpeakerMap } from "./transcript";

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/transcribeQueue.test.js`
Expected: FAIL — `tsc` errors with `Cannot find module './transcribeQueue'`.

- [ ] **Step 3: Implement**

Create `apps/meeting-minutes/src/transcribeQueue.ts`:

```typescript
import { Pool } from "pg";
import { pool } from "./db";
import { DiarizedSegment, TranscriptionResult, transcribeAudio } from "./whisper";
import { SpeakerMap, distinctSpeakers, renderTranscript } from "./transcript";
import { absorbMicroTurns, assignPresenterToDominant } from "./speakers";
import { reconcileSpeakers } from "./claude";
import { listPeople } from "./people";
import {
  TranscribeStatus, getAgendaItem, getAttendeeIds, getMeeting, listUnfinishedTranscriptions,
  setTranscribeStatus, updateAgendaItem,
} from "./meetings";
import { getRecording, latestRecording } from "./recordings";
import { readFile } from "node:fs/promises";

export interface TranscribeJob {
  itemId: number;
  recordingId: number;
  path: string;
  fileName: string;
  mimeType: string;
}

// Every side effect is injected so the state machine can be tested with no
// database, filesystem, or network.
export interface QueueDeps {
  transcribe(job: TranscribeJob): Promise<TranscriptionResult>;
  reconcile(job: TranscribeJob, segments: DiarizedSegment[]): Promise<SpeakerMap>;
  setStatus(itemId: number, status: TranscribeStatus, error?: string): Promise<void>;
  saveResult(job: TranscribeJob, segments: DiarizedSegment[], map: SpeakerMap): Promise<void>;
  log(message: string): void;
}

export interface Queue {
  enqueue(job: TranscribeJob): void;
  size(): number;
  idle(): Promise<void>;
}

// A single-consumer FIFO. One transcription runs at a time: concurrent jobs
// would split the whisper container's thread budget and slow every one of them.
export function createQueue(deps: QueueDeps): Queue {
  const pending: TranscribeJob[] = [];
  const idleWaiters: Array<() => void> = [];
  let running = false;

  function releaseIdle(): void {
    while (idleWaiters.length) idleWaiters.shift()!();
  }

  async function runOne(job: TranscribeJob): Promise<void> {
    await deps.setStatus(job.itemId, "processing");
    const started = Date.now();
    const result = await deps.transcribe(job);
    const segments = absorbMicroTurns(result.segments);
    // Reconciliation is advisory: never let it fail a transcription.
    let map: SpeakerMap = {};
    try { map = await deps.reconcile(job, segments); } catch { map = {}; }
    await deps.saveResult(job, segments, map);
    await deps.setStatus(job.itemId, "done");
    const audioSeconds = segments.length ? segments[segments.length - 1].end : 0;
    const elapsed = (Date.now() - started) / 1000;
    const factor = audioSeconds > 0 ? (elapsed / audioSeconds).toFixed(2) : "n/a";
    deps.log(
      `transcribed item ${job.itemId}: ${audioSeconds.toFixed(1)}s audio in ${elapsed.toFixed(1)}s (realtime factor ${factor})`
    );
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const job = pending.shift()!;
        try {
          await runOne(job);
        } catch (e) {
          const message = (e as Error).message || "Transcription failed.";
          deps.log(`transcription failed for item ${job.itemId}: ${message}`);
          try { await deps.setStatus(job.itemId, "error", message); } catch { /* nothing left to do */ }
        }
      }
    } finally {
      running = false;
      releaseIdle();
    }
  }

  return {
    enqueue(job: TranscribeJob): void {
      pending.push(job);
      void drain();
    },
    size(): number {
      return pending.length + (running ? 1 : 0);
    },
    idle(): Promise<void> {
      if (!running && !pending.length) return Promise.resolve();
      return new Promise<void>((resolve) => { idleWaiters.push(resolve); });
    },
  };
}

// ── The real queue ──────────────────────────────────────────────────────────

async function realReconcile(job: TranscribeJob, segments: DiarizedSegment[]): Promise<SpeakerMap> {
  const item = await getAgendaItem(pool, job.itemId);
  if (!item) return {};
  const order = distinctSpeakers(segments);
  if (order.length < 2) return {};
  const meeting = await getMeeting(pool, item.meeting_id);
  const attendeeIds = await getAttendeeIds(pool, item.meeting_id);
  const people = await listPeople(pool, true);
  const byId = new Map(people.map((p) => [p.id, p]));
  const attendees = attendeeIds
    .map((id) => byId.get(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => (p.title ? `${p.name} (${p.title})` : p.name));
  if (!attendees.length) return {};
  const presenters = item.presenter_ids.map((id) => byId.get(id)?.name ?? "").filter(Boolean);
  return reconcileSpeakers(pool, {
    meetingTitle: meeting?.title ?? "",
    itemTitle: item.title,
    transcript: renderTranscript(segments, {}), // positional "Speaker N" labels
    speakerOrder: order,
    attendees,
    presenters,
  });
}

// Give the busiest voice to this item's presenter, but only when that presenter
// is actually marked present at the meeting.
async function withPresenterAssignment(
  itemId: number,
  segments: DiarizedSegment[],
  map: SpeakerMap
): Promise<SpeakerMap> {
  const item = await getAgendaItem(pool, itemId);
  if (!item || !item.presenter_ids.length) return map;
  const attendeeIds = new Set(await getAttendeeIds(pool, item.meeting_id));
  const presentPresenter = item.presenter_ids.find((id) => attendeeIds.has(id));
  if (presentPresenter === undefined) return map;
  const people = await listPeople(pool, true);
  const name = people.find((p) => p.id === presentPresenter)?.name ?? "";
  return assignPresenterToDominant(segments, map, name);
}

export const transcribeQueue: Queue = createQueue({
  transcribe: async (job) => {
    const buffer = await readFile(job.path);
    return transcribeAudio({ fileName: job.fileName, mimeType: job.mimeType, buffer });
  },
  reconcile: realReconcile,
  setStatus: (itemId, status, error) => setTranscribeStatus(pool, itemId, status, error ?? ""),
  saveResult: async (job, segments, map) => {
    const withPresenter = await withPresenterAssignment(job.itemId, segments, map);
    await updateAgendaItem(pool, job.itemId, { transcriptSegments: segments, speakerMap: withPresenter });
  },
  log: (message) => { console.log(`[transcribe] ${message}`); },
});

export function enqueueTranscription(job: TranscribeJob): void {
  transcribeQueue.enqueue(job);
}

// Re-enqueue any item whose transcription a restart interrupted. This is why
// audio is written to disk before a job is queued.
export async function recoverPendingJobs(dbPool: Pool = pool): Promise<number> {
  const itemIds = await listUnfinishedTranscriptions(dbPool);
  let recovered = 0;
  for (const itemId of itemIds) {
    const rec = await latestRecording(dbPool, itemId);
    if (!rec || !rec.storage_path) {
      await setTranscribeStatus(dbPool, itemId, "error", "Transcription was interrupted and no recording was stored.");
      continue;
    }
    await setTranscribeStatus(dbPool, itemId, "queued");
    enqueueTranscription({
      itemId,
      recordingId: rec.id,
      path: rec.storage_path,
      fileName: rec.file_name,
      mimeType: rec.mime_type,
    });
    recovered++;
  }
  return recovered;
}

// Queue a specific stored recording (used by the Retry / Re-transcribe action).
export async function enqueueStoredRecording(itemId: number, recordingId: number): Promise<boolean> {
  const rec = await getRecording(pool, recordingId);
  if (!rec || rec.item_id !== itemId || !rec.storage_path) return false;
  await setTranscribeStatus(pool, itemId, "queued");
  enqueueTranscription({
    itemId,
    recordingId: rec.id,
    path: rec.storage_path,
    fileName: rec.file_name,
    mimeType: rec.mime_type,
  });
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/meeting-minutes && npx tsc && node --test dist/transcribeQueue.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Recover interrupted jobs on boot**

In `apps/meeting-minutes/src/index.ts`, add the import:

```typescript
import { recoverPendingJobs } from "./transcribeQueue";
```

and extend `start()`:

```typescript
async function start() {
  await ensureSchema();
  const recovered = await recoverPendingJobs();
  if (recovered) app.log.info(`re-queued ${recovered} interrupted transcription(s)`);
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`meeting-minutes listening on ${config.port}`);
}
```

- [ ] **Step 6: Run the full suite**

Run: `cd apps/meeting-minutes && npm test`
Expected: PASS — everything, no `tsc` errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/transcribeQueue.ts apps/meeting-minutes/src/transcribeQueue.test.ts apps/meeting-minutes/src/index.ts
git commit -m "feat(meeting-minutes): run transcription through a serial queue that survives restarts"
```

---

### Task 12: Asynchronous transcription routes

**Files:**
- Modify: `apps/meeting-minutes/src/routes/meetings.ts`

**Interfaces:**
- Consumes: `enqueueTranscription` and `enqueueStoredRecording` from `./transcribeQueue`, `saveRecording`/`getRecording`/`listRecordings` from `./recordings`, `setTranscribeStatus`/`listItemStatuses`/`getAttendeeIds` from `./meetings`.
- Produces these HTTP contracts, consumed by the frontend in Tasks 16-18:
  - `POST /api/items/:itemId/transcribe` → `202 { ok: true, recordingId: number, status: "queued" }`
  - `POST /api/items/:itemId/retranscribe` body `{ recordingId: number }` → `202 { ok: true, status: "queued" }`
  - `GET /api/meetings/:id/status` → `{ ok: true, items: Array<{ id, transcribeStatus, transcribeError, hasSummary }>, attendeeIds: number[] }`
  - `GET /api/recordings/:id/download` → the audio bytes
  - `GET /api/meetings/:id` items now also carry `recordings: Recording[]`

**Context:** The current handler blocks on `transcribeAudio` and does the single-speaker auto-map inline. All of that moves to the queue. The route's only remaining job is: persist the audio, mark the item queued, enqueue, return.

- [ ] **Step 1: Replace the transcribe route**

In `apps/meeting-minutes/src/routes/meetings.ts`, replace the whole `app.post("/api/items/:itemId/transcribe", …)` handler with:

```typescript
  // Accept a recording for an item and queue it for transcription. The audio is
  // written to the data volume BEFORE the job is queued, so a container restart
  // can resume it and the recording is always recoverable. Returns immediately —
  // the caller polls /api/meetings/:id/status for progress.
  app.post("/api/items/:itemId/transcribe", async (req, reply) => {
    try {
      const itemId = Number((req.params as { itemId: string }).itemId);
      const item = await getAgendaItem(pool, itemId);
      if (!item) { reply.code(404); return { ok: false, error: "Agenda item not found." }; }
      const { file } = await readMultipart(req);
      if (!file) { reply.code(400); return { ok: false, error: "An audio file is required." }; }
      if (!file.mimeType.startsWith("audio/") && !file.mimeType.startsWith("video/") && !hasAudioExtension(file.fileName)) {
        reply.code(400);
        return { ok: false, error: "Upload an audio recording (mp3, m4a, wav, webm, …)." };
      }
      const rec = await saveRecording(pool, itemId, file);
      await setTranscribeStatus(pool, itemId, "queued");
      enqueueTranscription({
        itemId,
        recordingId: rec.id,
        path: rec.storage_path,
        fileName: rec.file_name,
        mimeType: rec.mime_type,
      });
      reply.code(202);
      return { ok: true, recordingId: rec.id, status: "queued" };
    } catch (e) {
      return uploadErrorResponse(reply, e);
    }
  });

  // Re-run transcription on a recording that is already stored.
  app.post("/api/items/:itemId/retranscribe", async (req, reply) => {
    const itemId = Number((req.params as { itemId: string }).itemId);
    const b = (req.body ?? {}) as { recordingId?: number };
    const recordingId = Number(b.recordingId);
    if (!Number.isFinite(recordingId)) { reply.code(400); return { ok: false, error: "A recordingId is required." }; }
    const queued = await enqueueStoredRecording(itemId, recordingId);
    if (!queued) { reply.code(404); return { ok: false, error: "That recording is no longer available." }; }
    reply.code(202);
    return { ok: true, status: "queued" };
  });

  // Lightweight poll for the meeting detail view: per-item job state plus the
  // attendee list, which summarization can change behind the user's back.
  app.get("/api/meetings/:id/status", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!(await getMeeting(pool, id))) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    return {
      ok: true,
      items: await listItemStatuses(pool, id),
      attendeeIds: await getAttendeeIds(pool, id),
    };
  });

  // Stream a stored recording back. Recordings are kept for the life of the
  // meeting so the original audio is always retrievable.
  app.get("/api/recordings/:id/download", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rec = await getRecording(pool, id);
    if (!rec || !rec.storage_path) { reply.code(404); return { ok: false, error: "Recording not found." }; }
    if (!existsSync(rec.storage_path)) { reply.code(404); return { ok: false, error: "Recording file is missing." }; }
    const safeName = (rec.file_name || `recording-${rec.id}`).replace(/["\\\r\n]/g, "");
    reply.header("content-type", rec.mime_type || "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${safeName}"`);
    return reply.send(createReadStream(rec.storage_path));
  });
```

- [ ] **Step 2: Update the imports**

At the top of `apps/meeting-minutes/src/routes/meetings.ts`:

- Add `import { createReadStream, existsSync } from "node:fs";`
- Add `import { enqueueTranscription, enqueueStoredRecording } from "../transcribeQueue";`
- Add `import { saveRecording, getRecording, listRecordings } from "../recordings";`
- Add `setTranscribeStatus` and `listItemStatuses` to the existing import from `"../meetings"`.
- Remove `transcribeAudio` from the `"../whisper"` import, keeping `hasAudioExtension`.
- Remove the now-unused `distinctSpeakers` import from `"../transcript"`.

- [ ] **Step 3: Include recordings in the meeting detail payload**

Replace the `GET /api/meetings/:id` handler body so each item carries its recordings:

```typescript
  app.get("/api/meetings/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const meeting = await getMeeting(pool, id);
    if (!meeting) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    const items = await listAgendaItems(pool, id);
    const withRecordings = await Promise.all(
      items.map(async (it) => ({ ...it, recordings: await listRecordings(pool, it.id) }))
    );
    return {
      ok: true,
      meeting,
      attendeeIds: await getAttendeeIds(pool, id),
      items: withRecordings,
    };
  });
```

- [ ] **Step 4: Verify it compiles and the suite still passes**

Run: `cd apps/meeting-minutes && npm test`
Expected: PASS, with no `tsc` errors and no "declared but never read" complaints (which would mean an import was left behind in Step 2).

- [ ] **Step 5: Smoke-test the endpoints against a running stack**

Run: `cd /Users/mitchellpeck/WebstormProjects/GRMCApps && docker compose up -d --build meeting-minutes && sleep 10 && docker compose logs --tail 30 meeting-minutes`
Expected: the log shows `meeting-minutes listening on 3000` and no schema errors.

If Docker is not available on this machine, skip this step and note it — Task 18 ends with a full manual verification pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/routes/meetings.ts
git commit -m "feat(meeting-minutes): queue transcriptions asynchronously and expose job status"
```

---

### Task 13: Let one save update every field of a person

**Files:**
- Modify: `apps/meeting-minutes/src/people.ts` (`updatePerson`)
- Modify: `apps/meeting-minutes/src/routes/people.ts`
- Test: `apps/meeting-minutes/src/people.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `updatePerson(pool, id, name, email, title, active?: boolean): Promise<AddResult>`. When `active` is omitted the current value is preserved. `PUT /api/people/:id` accepts an optional `active` boolean.

**Context:** The person edit modal saves all fields at once. Today activation lives behind a separate `POST /api/people/:id/active` endpoint, which stays for the list-row toggle.

- [ ] **Step 1: Write the failing test**

Append to `apps/meeting-minutes/src/people.test.ts`:

```typescript
test("updatePerson can set active and leaves it alone when omitted", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await pool.query("DELETE FROM people");

  const added = await addPerson(pool, "Jane Doe", "jane@x.com", "Treasurer");
  assert.ok(added.ok);
  const id = (added as { ok: true; id: number }).id;

  await updatePerson(pool, id, "Jane Doe", "jane@x.com", "Chair", false);
  let found = (await listPeople(pool, true)).find((p) => p.id === id)!;
  assert.equal(found.title, "Chair");
  assert.equal(found.active, false);

  // Omitting `active` must preserve the stored value.
  await updatePerson(pool, id, "Jane R Doe", "jane@x.com", "Chair");
  found = (await listPeople(pool, true)).find((p) => p.id === id)!;
  assert.equal(found.name, "Jane R Doe");
  assert.equal(found.active, false);

  await pool.query("DELETE FROM people");
  await pool.end();
});
```

`people.test.ts` already imports `Pool`, `addPerson`, `updatePerson`, and `listPeople`, and already defines `const url = process.env.TEST_DATABASE_URL;` at the top. No import change is needed here.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/meeting-minutes && npm test`
Expected: FAIL — `tsc` errors that `updatePerson` expects 5 arguments but got 6.

- [ ] **Step 3: Implement**

In `apps/meeting-minutes/src/people.ts`, replace `updatePerson`:

```typescript
// Update every editable field of a person in one call. `active` is optional:
// when omitted the stored value is preserved, so a plain profile edit never
// silently reactivates someone.
export async function updatePerson(
  pool: Pool,
  id: number,
  name: string,
  email: string,
  title: string,
  active?: boolean
): Promise<AddResult> {
  const n = name.trim();
  const e = email.trim().toLowerCase();
  if (!n) return { ok: false, error: "Name is required." };
  if (e && !e.includes("@")) return { ok: false, error: "Enter a valid email or leave it blank." };
  try {
    const r = await pool.query(
      `UPDATE people
          SET name = $2, email = $3, title = $4,
              active = COALESCE($5, active)
        WHERE id = $1 RETURNING id`,
      [id, n, e, title.trim(), active === undefined ? null : active]
    );
    if (!r.rows[0]) return { ok: false, error: "Person not found." };
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
```

In `apps/meeting-minutes/src/routes/people.ts`, change the `AddBody` interface and the `PUT` handler:

```typescript
interface AddBody { name?: string; email?: string; title?: string; active?: boolean }
```

```typescript
  app.put("/api/people/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) { reply.code(400); return { ok: false, error: "Bad id." }; }
    const b = (req.body ?? {}) as AddBody;
    const active = typeof b.active === "boolean" ? b.active : undefined;
    const r = await updatePerson(pool, id, b.name ?? "", b.email ?? "", b.title ?? "", active);
    if (!r.ok) reply.code(400);
    return r;
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/meeting-minutes && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/people.ts apps/meeting-minutes/src/routes/people.ts apps/meeting-minutes/src/people.test.ts
git commit -m "feat(meeting-minutes): let one update set every field of a person"
```

---

### Task 14: The shared modal component

**Files:**
- Modify: `apps/meeting-minutes/src/public/index.html`
- Modify: `apps/meeting-minutes/src/public/app.css`
- Modify: `apps/meeting-minutes/src/public/app.js`

**Interfaces:**
- Consumes: the existing `esc()` helper in `app.js`.
- Produces, in `app.js`:
  - `openModal(opts)` where `opts` is
    `{ title: string, fields: Field[], saveLabel?: string, onSave: function(values, done), danger?: { label, hint, confirmText, onConfirm(done) } }`
  - `Field` is `{ id: string, label: string, type: 'text'|'textarea'|'select'|'checkbox', value: any, options?: [{value,label}], placeholder?: string, required?: boolean }`
  - `done(errorMessageOrNull)` closes the modal on `null`, or shows the message inside it.
  - `closeModal()`

**Context:** Three call sites in Task 15 need identical behaviour, so the component is built and verified on its own first. Browser JS in this file is ES5-flavoured — `var`, `function(){}`, no template literals.

- [ ] **Step 1: Add the modal root to the page**

In `apps/meeting-minutes/src/public/index.html`, immediately before the closing `</body>` tag (and before any `<script>` tag that loads `app.js`, if it sits at the end), add:

```html
<div id="modal-root"></div>
```

- [ ] **Step 2: Add the styles**

Append to `apps/meeting-minutes/src/public/app.css`:

```css
/* ── Modal ───────────────────────────────────────────────────────────────── */
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(15, 23, 42, .55);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 40px 16px; overflow-y: auto; z-index: 100;
}
.modal {
  background: #fff; border-radius: 10px; width: 100%; max-width: 520px;
  box-shadow: 0 20px 50px rgba(15, 23, 42, .3); padding: 20px;
}
.modal h3 { margin: 0 0 14px; font-size: 18px; }
.modal .field { margin-bottom: 12px; }
.modal .modal-actions {
  display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px;
}
.modal .modal-check { display: flex; align-items: center; gap: 8px; }
.modal .modal-check input { width: auto; }
.modal-danger {
  margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line, #e2e8f0);
}
.modal-danger .hint { margin-bottom: 8px; }
```

- [ ] **Step 3: Implement the component**

Add to `apps/meeting-minutes/src/public/app.js`, directly after the `fmtDate` helper near the top:

```javascript
// ── Modal ───────────────────────────────────────────────────────────────────
// One shared dialog for every edit flow. Fields are declared as data; onSave
// receives the collected values plus a done(errorOrNull) callback so it can
// keep the modal open and show a server error.
var modalEsc = null;

function closeModal(){
  var root=document.getElementById('modal-root');
  if(root) root.innerHTML='';
  if(modalEsc){ document.removeEventListener('keydown', modalEsc); modalEsc=null; }
}

function modalFieldHtml(f){
  var id='mf-'+f.id;
  if(f.type==='checkbox'){
    return '<div class="field modal-check"><input type="checkbox" id="'+id+'"'+(f.value?' checked':'')+'>'
      +'<label for="'+id+'" style="margin:0">'+esc(f.label)+'</label></div>';
  }
  var input;
  if(f.type==='textarea'){
    input='<textarea id="'+id+'" placeholder="'+esc(f.placeholder||'')+'">'+esc(f.value||'')+'</textarea>';
  } else if(f.type==='select'){
    input='<select id="'+id+'">'+(f.options||[]).map(function(o){
      return '<option value="'+esc(o.value)+'"'+(String(o.value)===String(f.value)?' selected':'')+'>'+esc(o.label)+'</option>';
    }).join('')+'</select>';
  } else {
    input='<input type="text" id="'+id+'" value="'+esc(f.value||'')+'" placeholder="'+esc(f.placeholder||'')+'">';
  }
  return '<div class="field"><label for="'+id+'">'+esc(f.label)+'</label>'+input+'</div>';
}

function openModal(opts){
  closeModal();
  var root=document.getElementById('modal-root');
  if(!root) return;
  var fields=opts.fields||[];
  var h='<div class="modal-backdrop" id="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">'
    +'<h3>'+esc(opts.title)+'</h3>'
    +'<div id="modal-msg"></div>'
    +fields.map(modalFieldHtml).join('');
  if(opts.danger){
    h+='<div class="modal-danger"><div class="hint">'+esc(opts.danger.hint)+'</div>'
      +'<div class="field"><input type="text" id="mf-danger-confirm" placeholder="'+esc(opts.danger.confirmText)+'"></div>'
      +'<button class="btn btn-danger" id="modal-danger-btn" data-default="'+esc(opts.danger.label)+'" disabled>'+esc(opts.danger.label)+'</button></div>';
  }
  h+='<div class="modal-actions">'
    +'<button class="btn btn-secondary" id="modal-cancel">Cancel</button>'
    +'<button class="btn btn-primary" id="modal-save" data-default="'+esc(opts.saveLabel||'Save')+'">'+esc(opts.saveLabel||'Save')+'</button>'
    +'</div></div></div>';
  root.innerHTML=h;

  function values(){
    var out={};
    fields.forEach(function(f){
      var el=document.getElementById('mf-'+f.id);
      if(!el) return;
      out[f.id] = f.type==='checkbox' ? el.checked : el.value;
    });
    return out;
  }
  function done(err){
    if(err){ setBtn('modal-save', false); msg('modal-msg','err',err); return; }
    closeModal();
  }
  function save(){
    var vals=values();
    var missing=fields.filter(function(f){ return f.required && !String(vals[f.id]||'').trim(); })[0];
    if(missing){ msg('modal-msg','err',missing.label+' is required.'); return; }
    msg('modal-msg','',''); setBtn('modal-save', true, 'Saving...');
    opts.onSave(vals, done);
  }

  document.getElementById('modal-save').addEventListener('click', save);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', function(e){
    if(e.target && e.target.id==='modal-backdrop') closeModal();
  });
  modalEsc=function(e){
    if(e.key==='Escape'){ closeModal(); return; }
    if(e.key==='Enter' && e.target && e.target.tagName!=='TEXTAREA'){ save(); }
  };
  document.addEventListener('keydown', modalEsc);

  if(opts.danger){
    var confirmEl=document.getElementById('mf-danger-confirm');
    var dangerBtn=document.getElementById('modal-danger-btn');
    confirmEl.addEventListener('input', function(){
      dangerBtn.disabled = confirmEl.value.trim() !== opts.danger.confirmText;
    });
    dangerBtn.addEventListener('click', function(){
      if(dangerBtn.disabled) return;
      setBtn('modal-danger-btn', true, 'Deleting...');
      opts.danger.onConfirm(done);
    });
  }

  var first=fields[0];
  if(first){ var fe=document.getElementById('mf-'+first.id); if(fe) fe.focus(); }
}
```

- [ ] **Step 4: Verify the component in a browser**

Start the app (`cd /Users/mitchellpeck/WebstormProjects/GRMCApps && docker compose up -d meeting-minutes`), open `https://minutes.<BASE_DOMAIN>`, open the browser console, and run:

```javascript
openModal({
  title: 'Smoke test',
  fields: [
    { id: 'a', label: 'Text', type: 'text', value: 'hi', required: true },
    { id: 'b', label: 'Notes', type: 'textarea', value: '' },
    { id: 'c', label: 'Status', type: 'select', value: 'x', options: [{value:'x',label:'X'},{value:'y',label:'Y'}] },
    { id: 'd', label: 'Active', type: 'checkbox', value: true }
  ],
  onSave: function(v, done){ console.log(v); done('pretend server error'); }
});
```

Expected, all of which you must confirm by hand:
- The dialog appears centred over a dimmed backdrop, with focus in the Text field.
- Pressing Enter saves; the values log to the console and the error message appears inside the modal without closing it.
- Clearing the Text field and saving shows "Text is required." and does not call `onSave`.
- Pressing Escape closes it. Clicking the dimmed backdrop closes it. Clicking inside the white panel does not.

- [ ] **Step 5: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/public/index.html apps/meeting-minutes/src/public/app.css apps/meeting-minutes/src/public/app.js
git commit -m "feat(meeting-minutes): add a shared modal component"
```

---

### Task 15: Replace every prompt() with a modal

**Files:**
- Modify: `apps/meeting-minutes/src/public/app.js` (`editMeeting`, `editPerson`, `addItemManually`, `itemHtml`, `wireItem`, `renderDetail`)

**Interfaces:**
- Consumes: `openModal` from Task 14; `PATCH /api/meetings/:id`, `DELETE /api/meetings/:id`, `PUT /api/people/:id` (with `active`, Task 13), `POST /api/meetings/:id/items`, `PATCH /api/items/:itemId`.
- Produces: `editItem(it)` in `app.js`, wired to a per-item Edit button.

**Context:** Three `prompt()` chains disappear. The meeting modal gains a status field and a delete action gated on typing the meeting title exactly.

- [ ] **Step 1: Replace `editMeeting`**

Replace the whole `editMeeting` function in `app.js` with:

```javascript
function editMeeting(){
  var m=state.meeting;
  openModal({
    title: 'Edit meeting',
    fields: [
      { id:'title', label:'Title', type:'text', value:m.title, required:true },
      { id:'date', label:'Date', type:'text', value:m.meeting_date||'', placeholder:'e.g. 2026-04-14 or Apr 14, 7pm' },
      { id:'loc', label:'Location', type:'text', value:m.location||'', placeholder:'e.g. Fellowship Hall / Zoom' },
      { id:'desc', label:'Description', type:'textarea', value:m.description||'' },
      { id:'status', label:'Status', type:'select', value:m.status||'draft', options:[
        { value:'draft', label:'Draft' },
        { value:'in_progress', label:'In progress' },
        { value:'completed', label:'Completed' }
      ]}
    ],
    onSave: function(v, done){
      api('/api/meetings/'+m.id, { method:'PATCH', body:{
        title:v.title, meetingDate:v.date, location:v.loc, description:v.desc, status:v.status
      }}).then(function(res){
        if(!res.ok){ done(res.error||'Could not save.'); return; }
        m.title=v.title.trim(); m.meeting_date=v.date.trim();
        m.location=v.loc.trim(); m.description=v.desc; m.status=v.status;
        document.getElementById('d-title-txt').textContent=m.title;
        document.getElementById('d-meta-txt').innerHTML=[m.meeting_date,m.location].filter(Boolean).map(esc).join(' &middot; ');
        done(null);
      }).catch(function(e){ done(e.message); });
    },
    danger: {
      label: 'Delete meeting',
      hint: 'Deleting this meeting also deletes its agenda items, transcripts, recordings, and report. This cannot be undone. Type the meeting title to confirm.',
      confirmText: m.title,
      onConfirm: function(done){
        api('/api/meetings/'+m.id, { method:'DELETE' }).then(function(res){
          if(res && res.ok===false){ done(res.error||'Could not delete.'); return; }
          done(null);
          showList();
        }).catch(function(e){ done(e.message); });
      }
    }
  });
}
```

- [ ] **Step 2: Replace `editPerson`**

Replace the whole `editPerson` function with:

```javascript
function editPerson(id, people){
  var p = people.filter(function(x){ return x.id===id; })[0]; if(!p) return;
  openModal({
    title: 'Edit person',
    fields: [
      { id:'name', label:'Name', type:'text', value:p.name, required:true },
      { id:'title', label:'Role / title', type:'text', value:p.title||'', placeholder:'e.g. Treasurer' },
      { id:'email', label:'Email', type:'text', value:p.email||'', placeholder:'name@grmc.org' },
      { id:'active', label:'Active (appears in attendee lists)', type:'checkbox', value:!!p.active }
    ],
    onSave: function(v, done){
      api('/api/people/'+id, { method:'PUT', body:{
        name:v.name, title:v.title, email:v.email, active:v.active
      }}).then(function(res){
        if(!res.ok){ done(res.error||'Could not save.'); return; }
        done(null);
        loadPeople();
      }).catch(function(e){ done(e.message); });
    }
  });
}
```

- [ ] **Step 3: Replace `addItemManually` and add `editItem`**

Replace the whole `addItemManually` function with:

```javascript
function addItemManually(){
  openModal({
    title: 'Add agenda item',
    saveLabel: 'Add item',
    fields: [
      { id:'title', label:'Title', type:'text', value:'', required:true },
      { id:'desc', label:'Details (optional)', type:'textarea', value:'' }
    ],
    onSave: function(v, done){
      api('/api/meetings/'+state.meeting.id+'/items', { method:'POST', body:{ title:v.title, description:v.desc } })
        .then(function(res){
          if(!res.ok){ done(res.error||'Could not add the item.'); return; }
          done(null);
          return api('/api/meetings/'+state.meeting.id).then(function(det){
            if(det.ok){ state.items=det.items; renderItems(); }
          });
        }).catch(function(e){ done(e.message); });
    }
  });
}

function editItem(it){
  openModal({
    title: 'Edit agenda item',
    fields: [
      { id:'title', label:'Title', type:'text', value:it.title, required:true },
      { id:'desc', label:'Details (optional)', type:'textarea', value:it.description||'' }
    ],
    onSave: function(v, done){
      api('/api/items/'+it.id, { method:'PATCH', body:{ title:v.title, description:v.desc } })
        .then(function(res){
          if(!res.ok){ done(res.error||'Could not save.'); return; }
          it.title=v.title.trim(); it.description=v.desc.trim();
          done(null);
          renderItems();
        }).catch(function(e){ done(e.message); });
    }
  });
}
```

- [ ] **Step 4: Add the per-item Edit button**

In `itemHtml`, inside the `<div class="btn-row">` near the bottom, add an Edit button before the Remove button so the row reads:

```javascript
      +'<div class="btn-row">'
        +'<button class="btn-sm" data-edit-item="'+it.id+'">Edit item</button>'
        +'<button class="btn btn-danger btn-sm" data-del-item="'+it.id+'">Remove item</button>'
        +'<span id="imsg-'+it.id+'"></span>'
      +'</div>'
```

In `wireItem`, add the listener next to the existing `data-del-item` one:

```javascript
  document.querySelector('[data-edit-item="'+it.id+'"]').addEventListener('click', function(){ editItem(it); });
```

- [ ] **Step 5: Verify by hand in the browser**

Rebuild and reload (`docker compose up -d --build meeting-minutes`), then confirm each of these:

- **Meeting:** open a meeting → "Edit details" → change title, date, location, description, and status → Save. The header updates immediately; reopening the modal shows the saved values; the meetings list shows the new status badge.
- **Meeting delete:** open the modal, type a wrong title → the Delete button stays disabled. Type the exact title → it enables → Delete returns you to the list and the meeting is gone.
- **Person:** People tab → Edit → change name, role, email, untick Active → Save. The row updates and shows as deactivated. Re-edit and tick Active → the row is normal again.
- **Agenda item:** "Add item manually" → the modal creates the item. "Edit item" on an existing item → renames it and updates the card.
- Confirm no browser `prompt()` box appears anywhere in these flows.

- [ ] **Step 6: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/public/app.js
git commit -m "feat(meeting-minutes): replace prompt() dialogs with edit modals"
```

---

### Task 16: Item status badges and in-place rendering

**Files:**
- Modify: `apps/meeting-minutes/src/public/app.js` (`itemBadgeInner`, `renderItems`, `itemHtml`, plus a new `syncItems`)

**Interfaces:**
- Consumes: `transcribe_status` / `transcribe_error` on each item from Task 12's payload.
- Produces, in `app.js`:
  - `isTranscribing(it)` → `true` while `transcribe_status` is `queued` or `processing`
  - `syncItems(freshItems)` — patches existing item DOM in place, rebuilding only when the set of item ids changed
  - `refreshItemView(it)` — updates one item's badge, transcript textarea, speaker rows, and recordings list

**Context:** `renderItems()` currently sets `state.openItemId = null` and rebuilds all item DOM, which would collapse whatever the user is working in every time the 3-second poll fires. Polling must patch instead.

- [ ] **Step 1: Extend the badge state machine**

Replace `itemBadgeInner` in `app.js` with:

```javascript
// True while this item's audio is queued or being transcribed.
function isTranscribing(it){
  return it.transcribe_status==='queued' || it.transcribe_status==='processing';
}

// The header status badge for an item's current transcription + summary state.
function itemBadgeInner(it){
  if(it.transcribe_status==='queued') return '<span class="badge b-pending">Queued to transcribe</span>';
  if(it.transcribe_status==='processing') return '<span class="badge b-pending"><span class="spin" style="border-top-color:var(--pending-fg)"></span> Transcribing&hellip;</span>';
  if(it.transcribe_status==='error') return '<span class="badge b-rejected">Transcription failed</span>';
  if(it._summarizing) return '<span class="badge b-pending"><span class="spin" style="border-top-color:var(--pending-fg)"></span> Summarizing&hellip;</span>';
  if(it._summaryError) return '<span class="badge b-rejected">Summary failed</span>';
  if(it.summary && !it._dirty) return '<span class="badge b-approved">Summary ready</span>';
  if(itemHasContent(it)) return '<span class="badge b-changes_requested">Needs summary</span>';
  return '';
}
```

- [ ] **Step 2: Add in-place refresh and sync**

Add these functions to `app.js` immediately after `renderItems`:

```javascript
// Update everything about one already-rendered item without touching the
// open/collapsed state — the poll runs every 3s and must never collapse the
// topic the user is typing in.
function refreshItemView(it){
  refreshBadge(it);
  renderSpeakerMap(it);
  renderRecordings(it);
  var tx=document.getElementById('tx-'+it.id);
  if(tx && document.activeElement!==tx && tx.value!==it.transcript) tx.value=it.transcript;
  var sumEl=document.getElementById('sum-'+it.id);
  if(sumEl) sumEl.innerHTML=summaryHtml(it);
  var rs=document.getElementById('recstat-'+it.id);
  if(rs){
    if(it.transcribe_status==='queued') rs.textContent='Queued — transcription starts when the one ahead finishes.';
    else if(it.transcribe_status==='processing') rs.innerHTML='<span class="spin" style="border-top-color:var(--navy)"></span> Transcribing &amp; identifying speakers&hellip;';
    else if(it.transcribe_status==='error') rs.innerHTML='<span style="color:var(--rej-fg)">'+esc(it.transcribe_error||'Transcription failed.')+'</span>';
    else rs.textContent='';
  }
}

// Merge a freshly fetched item list into state. Rebuilds the DOM only when the
// set of items actually changed; otherwise patches each card in place.
function syncItems(fresh){
  var sameSet = state.items.length===fresh.length && state.items.every(function(old, i){ return old.id===fresh[i].id; });
  if(!sameSet){ state.items=fresh; renderItems(); return; }
  fresh.forEach(function(f, i){
    var it=state.items[i];
    it.title=f.title; it.description=f.description;
    it.transcribe_status=f.transcribe_status; it.transcribe_error=f.transcribe_error;
    it.transcript_segments=f.transcript_segments; it.speaker_map=f.speaker_map;
    it.speaker_stats=f.speaker_stats; it.recordings=f.recordings||[];
    it.presenter_ids=f.presenter_ids;
    // Never clobber text the user is actively editing.
    var tx=document.getElementById('tx-'+it.id);
    if(!tx || document.activeElement!==tx) it.transcript=f.transcript;
    var nt=document.getElementById('nt-'+it.id);
    if(!nt || document.activeElement!==nt) it.notes=f.notes;
    if(!it._summarizing && !it._dirty){ it.summary=f.summary; it.action_items=f.action_items; }
    refreshItemView(it);
    renderPresenterChips(it);
  });
}
```

- [ ] **Step 3: Add a recordings list to the item card**

In `itemHtml`, immediately after the `<div class="speakers" id="spk-…">` line, add:

```javascript
      +'<div class="recordings" id="rec-'+it.id+'"></div>'
```

Add the renderer next to `renderSpeakerMap` in `app.js`:

```javascript
// Every recording ever attached to this item. They are kept for the life of
// the meeting, so the original audio is always downloadable. Task 17 adds the
// "Transcribe again" action here, once the poller exists to watch the job.
function renderRecordings(it){
  var el=document.getElementById('rec-'+it.id); if(!el) return;
  var recs=it.recordings||[];
  if(!recs.length){ el.innerHTML=''; return; }
  el.innerHTML='<div class="sublbl">Recordings</div><ul class="rec-list">'
    + recs.map(function(r){
        var size=r.byte_size ? (Math.round(r.byte_size/1024/102.4)/10)+' MB' : '';
        return '<li><span class="rec-name">'+esc(r.file_name||('recording '+r.id))+'</span>'
          +(size?'<span class="rec-size">'+esc(size)+'</span>':'')
          +'<a class="btn-sm" href="/api/recordings/'+r.id+'/download">Download</a></li>';
      }).join('')
    + '</ul>';
}
```

Add the matching styles to `apps/meeting-minutes/src/public/app.css`:

```css
.rec-list { list-style: none; margin: 4px 0 0; padding: 0; }
.rec-list li { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; }
.rec-list .rec-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rec-list .rec-size { color: var(--muted, #64748b); }
```

- [ ] **Step 4: Call the renderer from `wireItem`**

In `wireItem`, add `renderRecordings(it);` immediately after the existing `renderSpeakerMap(it);` call.

- [ ] **Step 5: Verify by hand**

Rebuild and reload. With no polling wired up yet (that is Task 17), confirm:

- An item that has never been recorded shows no badge and no Recordings section.
- Typing notes into an item and collapsing it still produces a "Summary ready" badge (existing behaviour must not have regressed).
- Recording an item, then reloading the page, shows the Recordings list with a Download link that plays back the original audio.

- [ ] **Step 6: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/public/app.js apps/meeting-minutes/src/public/app.css
git commit -m "feat(meeting-minutes): add transcription badges, in-place item sync and a recordings list"
```

---

### Task 17: Status polling and summary gating

**Files:**
- Modify: `apps/meeting-minutes/src/public/app.js` (`transcribeBlob`, `summarizeIfNeeded`, `collapseItem`, `showList`, `openMeeting`, `generateReport`, plus new polling functions)

**Interfaces:**
- Consumes: `GET /api/meetings/:id/status` and the `202` response from `POST /api/items/:itemId/transcribe` (Task 12); `syncItems` and `isTranscribing` (Task 16).
- Produces, in `app.js`: `startPolling()`, `stopPolling()`, `onTranscriptionSettled(it)`.

**Context:** This is the heart of the request. Recording no longer blocks. A closed item whose transcription later finishes gets summarized at that moment. An item that is transcribing is never summarized.

- [ ] **Step 1: Make recording fire-and-forget**

Replace `transcribeBlob` in `app.js` with:

```javascript
// Hand a recorded/selected audio blob to the server and return immediately.
// The serial queue does the work; the status poll reports progress, so the
// user can move straight on to the next topic.
function transcribeBlob(it, blob, mime){
  var rs=document.getElementById('recstat-'+it.id);
  if(!blob || !blob.size){ if(rs) rs.innerHTML='<span style="color:var(--rej-fg)">No audio captured.</span>'; return; }
  if(rs) rs.innerHTML='<span class="spin" style="border-top-color:var(--navy)"></span> Uploading audio&hellip;';
  var ext=(mime||'').indexOf('mp4')>=0?'m4a':(mime||'').indexOf('ogg')>=0?'ogg':'webm';
  var fd=new FormData(); fd.append('file', blob, 'item-'+it.id+'.'+ext);
  apiForm('/api/items/'+it.id+'/transcribe', fd).then(function(res){
    if(!res.ok){ if(rs) rs.innerHTML='<span style="color:var(--rej-fg)">'+esc(res.error)+'</span>'; return; }
    it.transcribe_status='queued'; it.transcribe_error='';
    refreshItemView(it);
    startPolling();
  }).catch(function(e){ if(rs) rs.innerHTML='<span style="color:var(--rej-fg)">'+esc(e.message)+'</span>'; });
}
```

- [ ] **Step 2a: Add the "Transcribe again" action to the recordings list**

Now that a poller exists to watch the resulting job, extend `renderRecordings` from Task 16. Change the `<li>` template to append a button after the Download link:

```javascript
          +'<a class="btn-sm" href="/api/recordings/'+r.id+'/download">Download</a>'
          +'<button class="btn-sm" data-retry="'+it.id+'" data-rec-id="'+r.id+'">Transcribe again</button></li>';
```

and add this listener block immediately before the closing brace of `renderRecordings`, after the `el.innerHTML=...` assignment:

```javascript
  el.querySelectorAll('[data-retry]').forEach(function(b){
    b.addEventListener('click', function(){
      api('/api/items/'+it.id+'/retranscribe', { method:'POST', body:{ recordingId: Number(b.getAttribute('data-rec-id')) } })
        .then(function(res){
          if(!res.ok){ msg('imsg-'+it.id,'err',res.error); return; }
          it.transcribe_status='queued'; it.transcribe_error='';
          refreshItemView(it);
          startPolling();
        }).catch(function(e){ msg('imsg-'+it.id,'err',e.message); });
    });
  });
```

- [ ] **Step 2b: Add the poller**

Add to `app.js`, just before the Report section:

```javascript
// ── Status polling ──────────────────────────────────────────────────────────
// Runs only while a meeting is open AND something is queued or transcribing.
var pollTimer=null;

function anyTranscribing(){
  return state.items.some(function(it){ return isTranscribing(it); });
}

function stopPolling(){
  if(pollTimer){ clearTimeout(pollTimer); pollTimer=null; }
}

function startPolling(){
  if(pollTimer) return;
  pollTimer=setTimeout(pollOnce, 3000);
}

function pollOnce(){
  pollTimer=null;
  if(!state.meeting){ return; }
  api('/api/meetings/'+state.meeting.id+'/status').then(function(res){
    if(!res.ok) return;
    var settled=[];
    res.items.forEach(function(s){
      var it=state.items.filter(function(x){ return x.id===s.id; })[0];
      if(!it) return;
      var was=it.transcribe_status;
      it.transcribe_status=s.transcribeStatus;
      it.transcribe_error=s.transcribeError;
      if((was==='queued'||was==='processing') && !isTranscribing(it)) settled.push(it);
      else refreshItemView(it);
    });
    // Attendees can change behind our back: another user, or auto-linked people
    // from action items. Keep the chips and the speaker dropdowns honest.
    if(res.attendeeIds && res.attendeeIds.join(',')!==state.attendeeIds.join(',')){
      state.attendeeIds=res.attendeeIds;
      renderAttendeeChips();
      state.items.forEach(function(x){ renderPresenterChips(x); renderSpeakerMap(x); });
    }
    if(!settled.length){ afterPollRound(); return; }
    // Something finished — pull the full detail so we get segments, speaker map
    // and the rendered transcript, then decide about summaries.
    return api('/api/meetings/'+state.meeting.id).then(function(det){
      if(det.ok){ state.meeting=det.meeting; syncItems(det.items); }
      settled.forEach(function(it){
        var live=state.items.filter(function(x){ return x.id===it.id; })[0];
        if(live) onTranscriptionSettled(live);
      });
      afterPollRound();
    });
  }).catch(function(){ if(anyTranscribing()) startPolling(); });
}

// Keep polling while work remains; once the queue drains, honour a pending
// "Generate report" click by re-invoking it automatically.
function afterPollRound(){
  if(anyTranscribing()){ startPolling(); return; }
  if(state.reportPending){ state.reportPending=false; generateReport(); }
}

// A transcription just finished. Its content is new, so any old summary is
// stale. If the topic is CLOSED, summarize it now — this is the deferred
// auto-summary the user asked for. If it is open, leave it: closing it will.
function onTranscriptionSettled(it){
  if(it.transcribe_status==='error'){ refreshItemView(it); return; }
  it._dirty=true; it._summaryError=false;
  refreshItemView(it);
  if(state.openItemId!==it.id) summarizeIfNeeded(it);
}
```

- [ ] **Step 3: Gate summarization on transcription**

Replace `summarizeIfNeeded` in `app.js` with:

```javascript
// Generate the summary when there is something to summarize AND no
// transcription is pending for this item. A queued or in-flight transcription
// always wins: summarizing now would describe a transcript about to change.
function summarizeIfNeeded(it){
  if(isTranscribing(it)) return Promise.resolve();
  if(!itemHasContent(it)) return Promise.resolve();
  if(it.summary && !it._dirty) return Promise.resolve();
  if(it._summarizing) return it._summarizing;
  return autoSummarize(it);
}
```

- [ ] **Step 4: Start and stop polling with the meeting view**

In `openMeeting`, add `stopPolling(); state.reportPending=false;` next to the existing `stopRecording();` call at the top, and add this line at the end of the `.then()` callback, right after `renderDetail();`:

```javascript
    if(anyTranscribing()) startPolling();
```

In `showList`, add `stopPolling(); state.reportPending=false;` immediately after the existing `stopRecording();` call.

- [ ] **Step 5: Make the report wait for transcriptions**

Replace the first half of `generateReport` — everything from `setBtn('btn-report', true, 'Preparing…');` down to and including the `if(pending.length) msg(...)` line — with:

```javascript
  setBtn('btn-report', true, 'Preparing…');
  if(state.openItemId){ var open=state.items.filter(function(x){return x.id===state.openItemId;})[0]; if(open) collapseItem(open); }
  var busy=state.items.filter(function(it){ return isTranscribing(it); });
  if(busy.length){
    // Wait for the queue: the poller re-invokes generateReport once the last
    // transcription settles, so the user clicks once and the report follows.
    msg('report-msg','info','Waiting for '+busy.length+' transcription'+(busy.length===1?'':'s')+' to finish&hellip;');
    setBtn('btn-report', true, 'Waiting…');
    state.reportPending=true;
    startPolling();
    return;
  }
  var pending=state.items.filter(function(it){ return itemHasContent(it) && (!it.summary || it._dirty || it._summarizing); });
  if(pending.length) msg('report-msg','info','Summarizing '+pending.length+' item'+(pending.length===1?'':'s')+' before the report…');
```

- [ ] **Step 6: Verify the whole flow by hand**

This is the acceptance test for the user's main complaint. Rebuild, then:

1. Open a meeting with at least three agenda items and several attendees selected.
2. Open item 1, record ~20 seconds, stop. Confirm the status reads "Uploading audio…" then the badge shows **Queued to transcribe** or **Transcribing…** within a few seconds, and that the UI is responsive throughout.
3. **Immediately** collapse item 1 and open item 2. Confirm item 1's badge keeps updating while you work in item 2, and that **no summary is generated for item 1 while it is transcribing**.
4. Record item 2 while item 1 is still transcribing. Confirm item 2 shows **Queued to transcribe** and only starts once item 1 finishes.
5. When item 1's transcription lands, confirm its badge goes to **Summarizing…** on its own (it is closed), then **Summary ready**, and that its transcript textarea is filled in with named speakers.
6. Open item 3, record, and leave it **open** when transcription finishes. Confirm no summary fires until you collapse it.
7. Click "Generate report" while something is still transcribing. Confirm it shows "Waiting for N transcriptions…", keeps the button disabled, and then proceeds automatically — summaries first, then the report — once the last transcription lands, without another click.
8. Reload the page mid-transcription. Confirm the badge still shows the correct state and the result still arrives.
9. Click "Transcribe again" on a stored recording. Confirm the badge returns to **Queued to transcribe**, the job runs, and the transcript is regenerated from the original audio.
10. Restart the container mid-transcription (`docker compose restart meeting-minutes`). Confirm the app log reports `re-queued 1 interrupted transcription(s)` and the transcript still arrives without re-recording.

- [ ] **Step 7: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/public/app.js
git commit -m "feat(meeting-minutes): poll transcription status and gate auto-summary on it"
```

---

### Task 18: Live speaker dropdowns with talk-time context

**Files:**
- Modify: `apps/meeting-minutes/src/public/app.js` (`renderSpeakerMap`, `toggleAttendee`)
- Modify: `apps/meeting-minutes/src/public/app.css`

**Interfaces:**
- Consumes: `speaker_stats` on each item (Task 9), `resolveSpeakerNameJS` (Task 2).
- Produces: no new exports.

**Context:** This closes the original reported bug — selecting an attendee did not refresh the speaker dropdowns. It also makes several "Speaker N" rows distinguishable by talk-time share and a sample quote, ordered by talk time, which is what makes correcting a bad automatic merge practical.

- [ ] **Step 1: Rewrite `renderSpeakerMap`**

Replace the whole `renderSpeakerMap` function in `app.js` with:

```javascript
function renderSpeakerMap(it){
  var el=document.getElementById('spk-'+it.id); if(!el) return;
  var stats=it.speaker_stats||[];
  if(!stats.length){ el.innerHTML=''; return; }
  var attendees=state.attendeeIds.map(function(id){ return state.peopleById[id]; }).filter(Boolean);
  var opts=function(sel){
    var o='<option value="">— unlabeled —</option>';
    attendees.forEach(function(p){ o+='<option value="'+esc(p.name)+'"'+(sel===p.name?' selected':'')+'>'+esc(p.name)+'</option>'; });
    // Keep a currently-set name that isn't in the attendee list as an option too.
    if(sel && attendees.every(function(p){return p.name!==sel;})) o+='<option value="'+esc(sel)+'" selected>'+esc(sel)+'</option>';
    return o;
  };
  el.innerHTML='<div class="sublbl">Who is speaking?</div><div class="spk-rows">'
    + stats.map(function(st){
        var cur=(it.speaker_map||{})[st.speaker]||'';
        var pct=Math.round(st.share*100);
        return '<div class="spk-row"><span class="spk-tag">'+esc(st.label)+'</span>'
          +'<span class="spk-share">'+pct+'%</span>'
          +'<select data-spk="'+esc(st.speaker)+'">'+opts(cur)+'</select>'
          +(st.sample?'<div class="spk-sample">&ldquo;'+esc(st.sample)+'&rdquo;</div>':'')
          +'</div>';
      }).join('')
    + '</div><div class="hint">Voices are listed by how much they spoke. Several rows can be the same person — set them to the same name and their lines merge. Remapping relabels the transcript.</div>';
  el.querySelectorAll('select[data-spk]').forEach(function(sel){
    sel.addEventListener('change', function(){
      var spk=sel.getAttribute('data-spk');
      it.speaker_map=it.speaker_map||{};
      if(sel.value) it.speaker_map[spk]=sel.value; else delete it.speaker_map[spk];
      // Instant local re-render, then persist (server renders identically).
      var tx=document.getElementById('tx-'+it.id);
      tx.value=renderTranscriptJS(it.transcript_segments, it.speaker_map);
      it.transcript=tx.value;
      saveItemField(it, { speakerMap: it.speaker_map });
      invalidateSummary(it);
    });
  });
}
```

- [ ] **Step 2: Fix the attendee toggle**

Replace `toggleAttendee` in `app.js` with:

```javascript
function toggleAttendee(pid){
  var i=state.attendeeIds.indexOf(pid);
  if(i>=0) state.attendeeIds.splice(i,1); else state.attendeeIds.push(pid);
  api('/api/meetings/'+state.meeting.id+'/attendees', { method:'PUT', body:{ personIds:state.attendeeIds } });
  renderAttendeeChips();
  // Both presenter chips and the speaker dropdowns are built from the attendee
  // list, so both have to be rebuilt the moment it changes.
  state.items.forEach(function(it){
    renderPresenterChips(it);
    renderSpeakerMap(it);
  });
}
```

- [ ] **Step 3: Style the new rows**

Append to `apps/meeting-minutes/src/public/app.css`:

```css
.spk-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 4px 0; }
.spk-row .spk-share {
  font-size: 12px; color: var(--muted, #64748b); min-width: 38px; text-align: right;
}
.spk-row .spk-sample {
  flex-basis: 100%; font-size: 12px; color: var(--muted, #64748b);
  font-style: italic; padding-left: 4px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
```

- [ ] **Step 4: Verify the reported bug is fixed**

Rebuild and reload, then confirm:

1. Open a meeting with a transcribed item that has two or more detected speakers. Open that item — the "Who is speaking?" rows show talk-time percentages and sample quotes, ordered with the most talkative first.
2. **Without reloading the page**, scroll up and select an additional attendee. The new person appears in every speaker dropdown **immediately** — no refresh, no reopening the meeting. This is the original bug.
3. Deselect an attendee — they disappear from the dropdowns, except where they were already the selected value for a speaker.
4. Set two different speaker rows to the same person. The transcript textarea immediately merges their consecutive lines under one name.
5. Reload the page and confirm the merged mapping and merged transcript persisted.

- [ ] **Step 5: Run the full suite one last time**

Run: `cd apps/meeting-minutes && npm test`
Expected: PASS — every test file, no `tsc` errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/mitchellpeck/WebstormProjects/GRMCApps
git add apps/meeting-minutes/src/public/app.js apps/meeting-minutes/src/public/app.css
git commit -m "fix(meeting-minutes): refresh speaker dropdowns when attendees change"
```

---

## Final verification

After Task 18, run the whole thing end to end against a real deployment before calling it done:

1. `cd apps/meeting-minutes && npm test` — all tests pass.
2. `docker compose up -d --build meeting-minutes whisper` and wait for the `small.en` model to download (watch `docker compose logs -f whisper`).
3. Record a ~2 minute item with three or four people speaking. Note the `[transcribe]` log line's realtime factor — that is the measured speedup, and the five `.env` knobs from Task 1 are how you tune it further.
4. Confirm the number of detected speakers matches the number of people who actually spoke, and that no speaker changes mid-sentence.
5. Confirm the item's presenter was auto-assigned to the dominant voice.
6. Generate the report and confirm every speaker is named and no action items were lost.
