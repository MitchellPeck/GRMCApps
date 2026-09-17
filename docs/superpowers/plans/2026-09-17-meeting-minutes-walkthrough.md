# Meeting Minutes Guided Walkthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an in-app guided tour for `apps/meeting-minutes` that walks a new
user through running a real meeting, driven against a disposable per-user
practice meeting.

**Architecture:** A `is_demo` flag plus `created_by_email` ownership keeps a
seeded practice meeting out of every other user's meetings list and its demo
people out of the shared People library. The tour itself is a standalone
client module (`tour.js` + `tour-steps.js` + `tour.css`) that spotlights real
controls by CSS selector, re-anchoring every animation frame because
`renderItems()` rebuilds item DOM and a 3-second poll patches cards underneath
it. Steps gate on the app's existing globals (`meetingRec`, `state.openItemId`,
`state.meeting.recording_status`), so `app.js` needs no instrumentation.

**Tech Stack:** TypeScript + Fastify 5 + `pg` on the server; plain ES5-style
browser JavaScript (no build step, no framework) in `src/public`; `node:test`
for tests, with jsdom for browser-side tests and `TEST_DATABASE_URL` for
database tests.

**Spec:** `docs/superpowers/specs/2026-09-17-meeting-minutes-walkthrough-design.md`

## Global Constraints

- All paths below are relative to `apps/meeting-minutes` unless stated otherwise.
- Browser code in `src/public` is plain script-tag JavaScript — **no** modules,
  no imports, no arrow-function-only syntax assumptions, no build step. Match
  the `var`/`function` style already in `app.js`.
- Tests run with `npm test`, which is
  `tsc && MEETINGMINUTES_DB_USER=test MEETINGMINUTES_DB_PASSWORD=test MEETINGMINUTES_DB_NAME=test node --test --test-concurrency=1 "dist/*.test.js"`.
  Database tests skip without `TEST_DATABASE_URL`; jsdom tests skip without
  jsdom (`npm i -D jsdom` to run them).
- Demo person emails use the reserved domain `practice.invalid`.
- Seeded transcript segments use speaker ids `SPEAKER_10`–`SPEAKER_12`, outside
  the range Whisper's diarizer emits.
- The practice meeting title is exactly `PRACTICE — April Board Meeting`
  (em dash).
- Never write invented AI output to the database: with no Anthropic key, the
  tour explains and shows examples in its callout instead.
- Schema changes are idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
  statements appended to `SCHEMA_SQL`, matching the existing migration style.

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `src/demo.ts` | Practice-meeting seed content and `seedPractice` / `findPractice` / `deletePractice` |
| `src/routes/practice.ts` | `POST` / `GET` / `DELETE /api/practice` |
| `src/demo.test.ts` | Database tests for seeding, isolation and deletion |
| `src/tour.test.ts` | jsdom tests for the tour engine |
| `src/public/tour.js` | Tour engine: overlay, spotlight, callout, step advancing |
| `src/public/tour-steps.js` | The 19 steps — content only, no engine logic |
| `src/public/tour.css` | Overlay, spotlight and callout styling |

**Modified files**

| File | Change |
|---|---|
| `src/schema.ts` | Two `ADD COLUMN IF NOT EXISTS` migrations + index |
| `src/people.ts` | `isDemo` on `Person`; `listLibraryPeople`, `listDemoAttendees`, `addDemoPerson` |
| `src/meetings.ts` | `listMeetings(pool, viewerEmail)`; `setMeetingSpeakerMap` merges |
| `src/routes/people.ts` | Library excludes demo; `meetingId` includes the practice meeting's demo people |
| `src/routes/meetings.ts` | Viewer-scoped list; 404 guard on another user's practice meeting |
| `src/index.ts` | Register `practiceRoutes` |
| `src/public/index.html` | Walkthrough button, `tour.css`, two scripts |
| `README.md` | Document the walkthrough |

---

### Task 1: Demo flag in the schema and the people layer

**Files:**
- Modify: `src/schema.ts` (append to `SCHEMA_SQL`)
- Modify: `src/people.ts`
- Test: `src/demo.test.ts` (create)

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `Person` gains `isDemo: boolean`
  - `addDemoPerson(pool: Pool, name: string, email: string, title: string): Promise<number>`
  - `listLibraryPeople(pool: Pool, includeInactive: boolean): Promise<Person[]>` — excludes demo rows
  - `listDemoAttendees(pool: Pool, meetingId: number): Promise<Person[]>` — demo people attending that meeting
  - `listPeople` keeps its existing signature and keeps returning **everyone**

- [ ] **Step 1: Write the failing test**

Create `src/demo.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { addPerson, addDemoPerson, listPeople, listLibraryPeople, listDemoAttendees } from "./people";
import { createMeeting, setAttendees } from "./meetings";

const url = process.env.TEST_DATABASE_URL;

async function reset(pool: Pool) {
  await pool.query("DELETE FROM meetings");
  await pool.query("DELETE FROM people");
}

test("demo people stay out of the library but resolve for their meeting", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await reset(pool);

  const real = await addPerson(pool, "Alice", "alice@x.com", "Chair");
  assert.ok(real.ok);
  const demoId = await addDemoPerson(pool, "Pastor Dale Whitcomb", "dale@practice.invalid", "Pastor");

  const m = await createMeeting(pool, {
    title: "PRACTICE — April Board Meeting", meetingDate: "", location: "",
    description: "", email: "me@x.com", name: "Me",
  });
  assert.ok(m.ok);
  const meetingId = (m as { id: number }).id;
  await setAttendees(pool, meetingId, [demoId]);

  // The People-tab library hides demo rows...
  const library = await listLibraryPeople(pool, true);
  assert.deepEqual(library.map((p) => p.name), ["Alice"]);

  // ...but the internal list still sees everyone, so reconcile/nameMap work.
  assert.equal((await listPeople(pool, true)).length, 2);

  // ...and the meeting's own demo attendees resolve.
  const demo = await listDemoAttendees(pool, meetingId);
  assert.deepEqual(demo.map((p) => p.name), ["Pastor Dale Whitcomb"]);
  assert.equal(demo[0].isDemo, true);

  await pool.end();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/meeting-minutes && npm test
```

Expected: compile error — `addDemoPerson`, `listLibraryPeople` and
`listDemoAttendees` are not exported from `./people`.

- [ ] **Step 3: Add the migrations**

In `src/schema.ts`, append to the end of the `SCHEMA_SQL` template literal,
just before the closing backtick:

```sql
-- Migrate existing installs to the practice-meeting walkthrough. Demo rows are
-- seeded per user by the tour and are hidden from the shared library/list.
ALTER TABLE people   ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS meetings_demo_owner_idx ON meetings (is_demo, created_by_email);
```

- [ ] **Step 4: Add the people-layer functions**

In `src/people.ts`, add `isDemo` to the interface and the row mapper:

```ts
export interface Person {
  id: number;
  name: string;
  email: string;
  title: string;
  active: boolean;
  isDemo: boolean;
}

function rowToPerson(row: any): Person {
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    title: row.title,
    active: row.active,
    isDemo: row.is_demo === true,
  };
}
```

Update the existing `listPeople` query to select the new column — it must keep
returning everyone, because `realReconcile`, `realMeetingReconcile`,
`presenterNameForItem`, `nameMap` and `peopleNamedIn` all depend on it:

```ts
export async function listPeople(pool: Pool, includeInactive: boolean): Promise<Person[]> {
  const where = includeInactive ? "" : "WHERE active = true";
  const r = await pool.query(
    `SELECT id, name, email, title, active, is_demo FROM people ${where} ORDER BY name`
  );
  return r.rows.map(rowToPerson);
}
```

Then add the three new functions:

```ts
// The People tab's library view: demo rows seeded by the walkthrough never
// appear here, so a practice run cannot pollute the shared library.
export async function listLibraryPeople(pool: Pool, includeInactive: boolean): Promise<Person[]> {
  const activeOnly = includeInactive ? "" : "AND active = true";
  const r = await pool.query(
    `SELECT id, name, email, title, active, is_demo FROM people
      WHERE is_demo = false ${activeOnly} ORDER BY name`
  );
  return r.rows.map(rowToPerson);
}

// Demo people attending one meeting — the practice meeting's attendee chips and
// speaker dropdowns are built from these plus the real library.
export async function listDemoAttendees(pool: Pool, meetingId: number): Promise<Person[]> {
  const r = await pool.query(
    `SELECT p.id, p.name, p.email, p.title, p.active, p.is_demo
       FROM people p
       JOIN meeting_attendees ma ON ma.person_id = p.id
      WHERE ma.meeting_id = $1 AND p.is_demo = true
      ORDER BY p.name`,
    [meetingId]
  );
  return r.rows.map(rowToPerson);
}

// Seed one demo person. Unlike addPerson this never merges into an existing
// row: demo emails live on the reserved practice.invalid domain, so a real
// person can never be absorbed into the walkthrough's cast.
export async function addDemoPerson(
  pool: Pool, name: string, email: string, title: string
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO people (name, email, title, active, is_demo)
     VALUES ($1, $2, $3, true, true) RETURNING id`,
    [name.trim(), email.trim().toLowerCase(), title.trim()]
  );
  return Number(r.rows[0].id);
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/meeting-minutes && npm test
```

Expected: PASS (or SKIP if `TEST_DATABASE_URL` is unset — set it to run this
for real; the task is not done until it has passed at least once).

- [ ] **Step 6: Commit**

```bash
git add apps/meeting-minutes/src/schema.ts apps/meeting-minutes/src/people.ts apps/meeting-minutes/src/demo.test.ts
git commit -m "feat(minutes): flag demo people and keep them out of the library"
```

---

### Task 2: Merge, don't replace, the meeting speaker map

**Files:**
- Modify: `src/meetings.ts:479-484` (`setMeetingSpeakerMap`)
- Test: `src/meetings.test.ts` (append one test)

**Interfaces:**
- Consumes: nothing from Task 1
- Produces: `setMeetingSpeakerMap` keeps stored names for voices absent from the
  incoming map; colliding keys take the incoming value. Signature unchanged.

**Why:** `runMeetingJob` ends with `saveMeetingMap(meetingId, map)`
(`transcribeQueue.ts:217`), wired to `setMeetingSpeakerMap`. After the
walkthrough's live take, `realMeetingReconcile` returns `{}` for a single voice,
which would wipe the seeded names out of the meeting-wide panel — and a
following **Save speakers** would then strip those names from the pre-baked
transcripts through `rewriteMeetingSpeakerMap`.

- [ ] **Step 1: Write the failing test**

Append to `src/meetings.test.ts`:

```ts
test("setMeetingSpeakerMap merges rather than replacing", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await reset(pool);
  const m = await createMeeting(pool, {
    title: "Board", meetingDate: "", location: "", description: "",
    email: "me@x.com", name: "Me",
  });
  assert.ok(m.ok);
  const id = (m as any).id;

  await setMeetingSpeakerMap(pool, id, { SPEAKER_10: "Dale", SPEAKER_11: "Marian" });
  // A later run sees only its own voice and re-labels one it shares.
  await setMeetingSpeakerMap(pool, id, { SPEAKER_00: "You", SPEAKER_11: "Marian Webb" });

  assert.deepEqual((await getMeeting(pool, id))!.speaker_map, {
    SPEAKER_10: "Dale",          // survived — this run never saw that voice
    SPEAKER_11: "Marian Webb",   // overwritten — fresh value wins
    SPEAKER_00: "You",           // added
  });
  await pool.end();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/meeting-minutes && npm test
```

Expected: FAIL — `SPEAKER_10` is missing, because the current implementation
replaces the whole column.

- [ ] **Step 3: Make it merge**

Replace `setMeetingSpeakerMap` in `src/meetings.ts`:

```ts
// Merge the incoming labels into the stored map rather than replacing it.
// Processing a recording only ever observes the voices in that recording, so a
// replace would discard names already assigned to voices it never saw — which
// is exactly what happens when a short recording is added to a meeting that
// already has named speakers. Fresh keys win on collision.
export async function setMeetingSpeakerMap(pool: Pool, meetingId: number, map: SpeakerMap): Promise<void> {
  await pool.query(
    `UPDATE meetings SET speaker_map = speaker_map || $2::jsonb, updated_at = now()
      WHERE id = $1`,
    [meetingId, JSON.stringify(map)]
  );
}
```

`jsonb || jsonb` is Postgres's shallow merge with the right-hand side winning —
the same semantics as `{...existing, ...fresh}`, done in one statement so
concurrent jobs cannot interleave a read and a write.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/meeting-minutes && npm test
```

Expected: PASS. The existing `rewriteMeetingSpeakerMap` tests must also still
pass — that function sets the column directly and is intentionally a replace,
because it is the user explicitly naming every voice.

- [ ] **Step 5: Commit**

```bash
git add apps/meeting-minutes/src/meetings.ts apps/meeting-minutes/src/meetings.test.ts
git commit -m "fix(minutes): merge meeting speaker maps instead of replacing them"
```

---

### Task 3: The practice-meeting seed

**Files:**
- Create: `src/demo.ts`
- Test: `src/demo.test.ts` (append)

**Interfaces:**
- Consumes: `addDemoPerson`, `listDemoAttendees` (Task 1); `createMeeting`,
  `setAttendees`, `deleteMeeting` (existing)
- Produces:
  - `PRACTICE_TITLE: string`
  - `seedPractice(pool: Pool, identity: { email: string; name: string }): Promise<number>` — returns the meeting id, resetting any existing one
  - `findPractice(pool: Pool, email: string): Promise<number | null>`
  - `deletePractice(pool: Pool, email: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Append to `src/demo.test.ts`:

```ts
import { seedPractice, findPractice, deletePractice, PRACTICE_TITLE } from "./demo";
import { listAgendaItems, getMeeting } from "./meetings";

test("seeding a practice meeting is idempotent and reversible", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await reset(pool);
  const me = { email: "me@x.com", name: "Me" };

  const first = await seedPractice(pool, me);
  const second = await seedPractice(pool, me);
  assert.notEqual(first, second, "reset creates a fresh meeting");

  const mine = await pool.query("SELECT id FROM meetings WHERE is_demo = true");
  assert.equal(mine.rows.length, 1, "exactly one practice meeting survives");
  assert.equal(await findPractice(pool, me.email), second);

  const meeting = await getMeeting(pool, second);
  assert.equal(meeting!.title, PRACTICE_TITLE);
  assert.equal(meeting!.report, "", "report is seeded empty so step 18 generates a real one");
  assert.deepEqual(meeting!.speaker_map, {
    SPEAKER_10: "Pastor Dale Whitcomb",
    SPEAKER_11: "Marian Webb",
    SPEAKER_12: "Tom Ross",
  });

  const items = await listAgendaItems(pool, second);
  assert.equal(items.length, 3);
  assert.equal(items[0].transcript_source, "meeting");
  assert.ok(items[0].summary.length > 0, "topic 1 ships pre-baked");
  assert.equal(items[1].action_items.length, 2, "topic 2 ships inferred actions");
  assert.equal(items[2].transcript, "", "topic 3 is the live-take target");
  assert.equal(items[2].summary, "");

  // Every seeded voice is outside the range Whisper emits.
  for (const seg of items[0].transcript_segments.concat(items[1].transcript_segments)) {
    assert.ok(/^SPEAKER_1[0-2]$/.test(seg.speaker), `reserved id, got ${seg.speaker}`);
  }

  // Four demo people, all attending.
  assert.equal((await listDemoAttendees(pool, second)).length, 4);

  await deletePractice(pool, me.email);
  assert.equal(await findPractice(pool, me.email), null);
  assert.equal((await pool.query("SELECT id FROM people WHERE is_demo = true")).rows.length, 0);
  await pool.end();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/meeting-minutes && npm test
```

Expected: compile error — `./demo` does not exist.

- [ ] **Step 3: Write `src/demo.ts`**

```ts
import { Pool } from "pg";
import { DiarizedSegment } from "./whisper";
import { renderTranscript } from "./transcript";
import { addDemoPerson } from "./people";
import { createMeeting, setAttendees, deleteMeeting } from "./meetings";

export const PRACTICE_TITLE = "PRACTICE — April Board Meeting";

// Whisper's diarizer numbers each recording from SPEAKER_00, so the seeded cast
// lives in a reserved range. Without this, the live take's voice would merge
// into a seeded persona and the walkthrough would teach a lie.
const DALE = "SPEAKER_10", MARIAN = "SPEAKER_11", TOM = "SPEAKER_12";

const CAST = [
  { name: "Pastor Dale Whitcomb", email: "dale@practice.invalid",   title: "Pastor" },
  { name: "Marian Webb",          email: "marian@practice.invalid", title: "Treasurer" },
  { name: "Tom Ross",             email: "tom@practice.invalid",    title: "Trustees Chair" },
  { name: "Joyce Alden",          email: "joyce@practice.invalid",  title: "Secretary" },
];

export const SEEDED_SPEAKER_MAP: Record<string, string> = {
  [DALE]: "Pastor Dale Whitcomb",
  [MARIAN]: "Marian Webb",
  [TOM]: "Tom Ross",
};

function seg(text: string, speaker: string, start: number, end: number): DiarizedSegment {
  return { text, speaker, start, end };
}

const WELCOME_SEGMENTS: DiarizedSegment[] = [
  seg("Good evening everyone, thank you for being here. Let's open in prayer.", DALE, 0, 7),
  seg("Before we start, Joyce has the minutes from March for approval.", DALE, 7, 12),
  seg("Those were circulated last week, so we can take them as read.", DALE, 12, 17),
];

const BUDGET_SEGMENTS: DiarizedSegment[] = [
  seg("Giving came in at about four percent under budget for the quarter.", MARIAN, 20, 27),
  seg("The shortfall is almost entirely the building fund, not general giving.", MARIAN, 27, 34),
  seg("Do we need to move anything out of reserves to cover it?", TOM, 34, 39),
  seg("Not yet. I'll pull the three-year comparison before the next meeting.", MARIAN, 39, 46),
  seg("Tom, we need someone to look at the reserve policy again as well.", MARIAN, 46, 52),
  seg("I'll take that and bring a recommendation in May.", TOM, 52, 57),
];

interface SeedItem {
  title: string;
  description: string;
  presenters: string[];        // names from CAST
  segments: DiarizedSegment[]; // empty → the live-take target
  summary: string;
  actionItems: Array<{ task: string; owner: string }>;
}

const ITEMS: SeedItem[] = [
  {
    title: "Welcome & devotion",
    description: "Opening prayer and approval of March minutes.",
    presenters: ["Pastor Dale Whitcomb"],
    segments: WELCOME_SEGMENTS,
    summary:
      "Pastor Dale opened the meeting in prayer and welcomed the board. The March "
      + "minutes had been circulated in advance and were taken as read, with no "
      + "corrections offered.",
    actionItems: [],
  },
  {
    title: "Budget review",
    description: "First-quarter giving against budget.",
    presenters: ["Marian Webb"],
    segments: BUDGET_SEGMENTS,
    summary:
      "Marian reported first-quarter giving roughly four percent under budget, "
      + "attributing nearly all of the shortfall to the building fund rather than "
      + "general giving. Tom asked whether reserves would need to be drawn on; "
      + "Marian advised waiting for a longer comparison first.",
    actionItems: [
      { task: "Pull the three-year giving comparison before the next meeting", owner: "Marian Webb" },
      { task: "Review the reserve policy and bring a recommendation in May", owner: "Tom Ross" },
    ],
  },
  {
    title: "Building repairs — roof quote",
    description: "The walkthrough records this one live.",
    presenters: ["Tom Ross"],
    segments: [],
    summary: "",
    actionItems: [],
  },
];

// The caller's practice meeting id, or null.
export async function findPractice(pool: Pool, email: string): Promise<number | null> {
  const r = await pool.query(
    "SELECT id FROM meetings WHERE is_demo = true AND created_by_email = $1 ORDER BY id DESC LIMIT 1",
    [email]
  );
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

// Remove the caller's practice meeting and the demo cast that belongs to it.
// deleteMeeting already cascades items, presenters, markers and recordings and
// removes their files from the minutesdata volume.
export async function deletePractice(pool: Pool, email: string): Promise<void> {
  const id = await findPractice(pool, email);
  if (id === null) return;
  const attendees = await pool.query(
    `SELECT p.id FROM people p
       JOIN meeting_attendees ma ON ma.person_id = p.id
      WHERE ma.meeting_id = $1 AND p.is_demo = true`,
    [id]
  );
  await deleteMeeting(pool, id);
  for (const row of attendees.rows) {
    await pool.query("DELETE FROM people WHERE id = $1 AND is_demo = true", [Number(row.id)]);
  }
}

// Create the caller's practice meeting, discarding any previous one so retaking
// the walkthrough always starts from a known state.
export async function seedPractice(
  pool: Pool,
  identity: { email: string; name: string }
): Promise<number> {
  await deletePractice(pool, identity.email);

  const peopleIds = new Map<string, number>();
  for (const c of CAST) {
    peopleIds.set(c.name, await addDemoPerson(pool, c.name, c.email, c.title));
  }

  const created = await createMeeting(pool, {
    title: PRACTICE_TITLE,
    meetingDate: "Apr 14, 7:00pm",
    location: "Fellowship Hall",
    description: "A disposable meeting for the walkthrough. Delete it when you're done.",
    email: identity.email,
    name: identity.name,
  });
  if (!created.ok) throw new Error(created.error);
  const meetingId = created.id;

  await pool.query(
    "UPDATE meetings SET is_demo = true, status = 'in_progress', speaker_map = $2 WHERE id = $1",
    [meetingId, JSON.stringify(SEEDED_SPEAKER_MAP)]
  );
  await setAttendees(pool, meetingId, [...peopleIds.values()]);

  for (let i = 0; i < ITEMS.length; i++) {
    const it = ITEMS[i];
    const transcript = it.segments.length ? renderTranscript(it.segments, SEEDED_SPEAKER_MAP) : "";
    const r = await pool.query(
      `INSERT INTO agenda_items
         (meeting_id, position, title, description, status, transcript,
          transcript_segments, speaker_map, summary, action_items,
          transcript_source, transcribe_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11, 'idle')
       RETURNING id`,
      [
        meetingId, i, it.title, it.description,
        it.summary ? "done" : "pending",
        transcript,
        JSON.stringify(it.segments),
        JSON.stringify(it.segments.length ? SEEDED_SPEAKER_MAP : {}),
        it.summary,
        JSON.stringify(it.actionItems),
        // Pre-baked topics claim the meeting-wide source so they feed the
        // "Who spoke in this meeting?" panel and rewriteMeetingSpeakerMap.
        it.segments.length ? "meeting" : "",
      ]
    );
    const itemId = Number(r.rows[0].id);
    for (const name of it.presenters) {
      const pid = peopleIds.get(name);
      if (pid !== undefined) {
        await pool.query(
          "INSERT INTO agenda_item_presenters (item_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [itemId, pid]
        );
      }
    }
  }
  return meetingId;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/meeting-minutes && npm test
```

Expected: PASS. If `renderTranscript`'s signature rejects a two-argument call,
check `src/transcript.ts` — the third `order` argument is optional and only
affects positional `Speaker N` fallbacks for unmapped voices.

- [ ] **Step 5: Commit**

```bash
git add apps/meeting-minutes/src/demo.ts apps/meeting-minutes/src/demo.test.ts
git commit -m "feat(minutes): seed a disposable practice meeting for the walkthrough"
```

---

### Task 4: Practice API and viewer scoping

**Files:**
- Create: `src/routes/practice.ts`
- Modify: `src/meetings.ts` (`listMeetings`)
- Modify: `src/routes/meetings.ts` (list call site, `GET /api/meetings/:id` guard)
- Modify: `src/routes/people.ts` (library filtering, `meetingId` parameter)
- Modify: `src/index.ts` (register the routes)
- Test: `src/demo.test.ts` (append)

**Interfaces:**
- Consumes: `seedPractice`, `findPractice`, `deletePractice` (Task 3);
  `listLibraryPeople`, `listDemoAttendees` (Task 1)
- Produces:
  - `listMeetings(pool: Pool, viewerEmail: string)` — added second parameter
  - `canSeeMeeting(meeting: Pick<MeetingRow,"is_demo"|"created_by_email">, viewerEmail: string): boolean`
  - `practiceRoutes(app: FastifyInstance): Promise<void>`
  - `POST /api/practice` → `{ok:true, meetingId}`
  - `GET /api/practice` → `{ok:true, meetingId: number|null}`
  - `DELETE /api/practice` → `{ok:true}`
  - `GET /api/people?all=1&meetingId=N` → library people plus `N`'s demo attendees

- [ ] **Step 1: Write the failing test**

Append to `src/demo.test.ts`:

```ts
import { listMeetings } from "./meetings";

test("a practice meeting is visible only to the person who made it", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await reset(pool);

  await createMeeting(pool, {
    title: "Real board meeting", meetingDate: "", location: "", description: "",
    email: "alice@x.com", name: "Alice",
  });
  await seedPractice(pool, { email: "alice@x.com", name: "Alice" });

  const alice = await listMeetings(pool, "alice@x.com");
  assert.deepEqual(alice.map((m) => m.title).sort(), [PRACTICE_TITLE, "Real board meeting"].sort());

  const bob = await listMeetings(pool, "bob@x.com");
  assert.deepEqual(bob.map((m) => m.title), ["Real board meeting"]);

  await pool.end();
});

test("canSeeMeeting hides only other people's practice meetings", { skip: !url }, () => {
  const practice = { is_demo: true, created_by_email: "alice@x.com" };
  const real = { is_demo: false, created_by_email: "alice@x.com" };
  assert.equal(canSeeMeeting(practice, "alice@x.com"), true);
  assert.equal(canSeeMeeting(practice, "bob@x.com"), false, "404 for somebody else's practice run");
  assert.equal(canSeeMeeting(real, "bob@x.com"), true, "real meetings stay shared");
});
```

Add `canSeeMeeting` to this file's `./meetings` import.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/meeting-minutes && npm test
```

Expected: compile error — `listMeetings` takes one argument.

- [ ] **Step 3: Scope the meetings list**

In `src/meetings.ts`, replace `listMeetings`:

```ts
// Practice meetings belong to one person. Everything else is shared, so the
// list is "every real meeting, plus my own practice meeting".
export async function listMeetings(
  pool: Pool,
  viewerEmail: string
): Promise<Array<MeetingRow & { item_count: number; attendee_count: number }>> {
  const r = await pool.query(`
    SELECT m.*,
      (SELECT count(*) FROM agenda_items ai WHERE ai.meeting_id = m.id) AS item_count,
      (SELECT count(*) FROM meeting_attendees ma WHERE ma.meeting_id = m.id) AS attendee_count
    FROM meetings m
    WHERE m.is_demo = false OR m.created_by_email = $1
    ORDER BY m.created_at DESC
  `, [viewerEmail]);
  return r.rows.map((row) => ({
    ...row,
    id: Number(row.id),
    item_count: Number(row.item_count),
    attendee_count: Number(row.attendee_count),
  }));
}
```

Fix the existing call sites the compiler points at: `src/routes/meetings.ts`'s
`GET /api/meetings` becomes

```ts
app.get("/api/meetings", async (req) => {
  try { return { ok: true, meetings: await listMeetings(pool, getIdentity(req).email) }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
});
```

and `src/meetings.test.ts`'s existing `listMeetings(pool)` calls become
`listMeetings(pool, "me@x.com")` — that file creates its meetings with
`email: "me@x.com"`.

- [ ] **Step 4: Guard the detail route**

Route handlers in this app import the production `pool` from `../db`, so they
cannot be exercised against `TEST_DATABASE_URL`. Put the decision in a pure
predicate instead, which is testable on its own and keeps the handler to one
line. Add to `src/meetings.ts`, and add `is_demo: boolean;` to the `MeetingRow`
interface (confirm `getMeeting`'s `SELECT *` already carries the column):

```ts
// Someone else's practice meeting does not exist as far as this user is
// concerned. Every real meeting is visible to everyone, as it always was.
export function canSeeMeeting(
  meeting: Pick<MeetingRow, "is_demo" | "created_by_email">,
  viewerEmail: string
): boolean {
  return !meeting.is_demo || meeting.created_by_email === viewerEmail;
}
```

Then in `src/routes/meetings.ts`, inside `GET /api/meetings/:id`, immediately
after the existing `if (!meeting)` line:

```ts
    if (!canSeeMeeting(meeting, getIdentity(req).email)) {
      reply.code(404);
      return { ok: false, error: "Meeting not found." };
    }
```

Import `canSeeMeeting` alongside the other `../meetings` imports in that file.

- [ ] **Step 5: Filter the people endpoint**

Replace the `GET /api/people` handler in `src/routes/people.ts`:

```ts
  app.get("/api/people", async (req) => {
    try {
      const q = (req.query ?? {}) as { all?: string; meetingId?: string };
      const includeInactive = q.all === "1";
      const people = await listLibraryPeople(pool, includeInactive);
      // The practice meeting's cast is deliberately absent from the library, so
      // its attendee chips and speaker dropdowns would come up empty without
      // this. Only the caller's own practice meeting adds them back.
      const meetingId = Number(q.meetingId);
      if (Number.isFinite(meetingId) && meetingId > 0) {
        const meeting = await getMeeting(pool, meetingId);
        if (meeting && meeting.is_demo && meeting.created_by_email === getIdentity(req).email) {
          return { ok: true, people: people.concat(await listDemoAttendees(pool, meetingId)) };
        }
      }
      return { ok: true, people };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
```

Update that file's imports to add `listLibraryPeople`, `listDemoAttendees`,
`getMeeting` and `getIdentity`.

- [ ] **Step 6: Add the practice routes**

Create `src/routes/practice.ts`:

```ts
import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { seedPractice, findPractice, deletePractice } from "../demo";

export async function practiceRoutes(app: FastifyInstance): Promise<void> {
  // The walkthrough's practice meeting for the caller, or null.
  app.get("/api/practice", async (req) => {
    try { return { ok: true, meetingId: await findPractice(pool, getIdentity(req).email) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  // Create or reset it. Retaking the walkthrough always starts clean.
  app.post("/api/practice", async (req, reply) => {
    try {
      const id = getIdentity(req);
      return { ok: true, meetingId: await seedPractice(pool, { email: id.email, name: id.name }) };
    } catch (e) {
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });

  app.delete("/api/practice", async (req, reply) => {
    try {
      await deletePractice(pool, getIdentity(req).email);
      return { ok: true };
    } catch (e) {
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });
}
```

Register it in `src/index.ts`, next to the other `app.register` calls:

```ts
import { practiceRoutes } from "./routes/practice";
// ...
app.register(practiceRoutes);
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/meeting-minutes && npm test
```

Expected: PASS, including the pre-existing `meetings.test.ts` suite.

- [ ] **Step 8: Commit**

```bash
git add apps/meeting-minutes/src
git commit -m "feat(minutes): practice meeting API, scoped to its owner"
```

---

### Task 5: The tour engine

**Files:**
- Create: `src/public/tour.js`, `src/public/tour.css`
- Modify: `src/public/index.html`
- Test: `src/tour.test.ts` (create)

**Interfaces:**
- Consumes: `POST /api/practice`, `GET /api/practice` (Task 4); `app.js`
  globals `state`, `meetingRec`, `openMeeting`, `showList`, `switchTab`,
  `meetingElapsedSeconds`
- Produces: `window.GrmcTour` with
  - `start()` — seed/reset the practice meeting, then run from step 0
  - `resume(): boolean` — continue from stored progress; false when there is none
  - `autoOffer(): boolean` — one dismissible first-visit offer; never auto-starts
  - `next()`, `back()`, `skip()`, `end()`
  - `_tick()` — one re-anchor + advance-check pass, called by the rAF loop and
    directly by tests
  - `_state()` → `{active, index, docked, canAdvance}`
  - reads its steps from `window.TOUR_STEPS` (Task 6)

- [ ] **Step 1: Write the failing test**

Create `src/tour.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let JSDOM: any = null;
try { ({ JSDOM } = require("jsdom")); } catch { /* not installed — tests skip */ }

const PUBLIC_DIRS = [join(__dirname, "..", "src", "public"), join(__dirname, "public")];
const publicDir = PUBLIC_DIRS.find((d) => existsSync(join(d, "tour.js"))) ?? "";
const skip = !JSDOM || !publicDir;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const openWindows: any[] = [];
after(() => {
  for (const w of openWindows) { try { w.close(); } catch { /* already torn down */ } }
  openWindows.length = 0;
});

// Boot the page exactly as index.html does: app.js, then the steps, then the
// engine — tour.js resumes or offers on load, so it must see TOUR_STEPS.
function boot(stepsJs: string, pre?: (w: any) => void): { w: any; doc: any } {
  const dom = new JSDOM(readFileSync(join(publicDir, "index.html"), "utf8"), {
    runScripts: "outside-only",
    url: "https://minutes.test/",
  });
  const w = dom.window;
  openWindows.push(w);
  w.fetch = (path: string) => Promise.resolve({
    json: () => Promise.resolve(
      path === "/api/practice" ? { ok: true, meetingId: 42 } : { ok: true }
    ),
  });
  w.MediaRecorder = function () { /* app.js feature-detects this on load */ };
  // jsdom lays nothing out, so every getBoundingClientRect is all zeros — which
  // the engine reads as "no anchor" and docks. Give elements a real rect so the
  // floating and docked paths are actually distinguishable in these tests.
  w.Element.prototype.getBoundingClientRect = function () {
    return { top: 100, left: 100, bottom: 140, right: 300, width: 200, height: 40, x: 100, y: 100 };
  };
  w.eval(readFileSync(join(publicDir, "app.js"), "utf8"));
  w.eval(stepsJs);
  if (pre) pre(w);
  w.eval(readFileSync(join(publicDir, "tour.js"), "utf8"));
  return { w, doc: w.document };
}

const GATED_STEPS = `
  window.TOUR_STEPS = [
    { anchor:'#btn-new-meeting', title:'One', body:'first',
      advance:{ until: function(){ return window.__unlocked === true; }, hint:'waiting' } },
    { anchor:'#btn-new-meeting', title:'Two', body:'second', optional:true }
  ];
`;

// Most tests drive the tour directly rather than through the practice-meeting
// round trip; seed:false skips that POST.
function started(stepsJs = GATED_STEPS): { w: any; doc: any } {
  const b = boot(stepsJs);
  b.w.GrmcTour.start({ seed: false });
  return b;
}

test("a gated step blocks Next until the app state flips", { skip }, () => {
  const { w, doc } = started();
  assert.equal(w.GrmcTour._state().canAdvance, false);
  assert.equal(doc.getElementById("tour-next").disabled, true);

  w.__unlocked = true;
  w.GrmcTour._tick();

  assert.equal(w.GrmcTour._state().index, 1, "satisfying the condition advances");
});

test("the callout docks when its anchor leaves the DOM", { skip }, () => {
  const { w, doc } = started();
  assert.equal(w.GrmcTour._state().docked, false, "starts floating beside a present anchor");

  // renderItems() rebuilds item DOM wholesale; this is that, in miniature.
  doc.getElementById("btn-new-meeting").remove();
  w.GrmcTour._tick();

  assert.equal(w.GrmcTour._state().docked, true);
  assert.equal(doc.getElementById("tour-callout").classList.contains("docked"), true);
  assert.equal(doc.getElementById("tour-mask-top").hidden, true);
});

test("an optional step can always be skipped", { skip }, () => {
  const { w, doc } = started();
  w.__unlocked = true;
  w.GrmcTour._tick();                       // now on the optional step
  doc.getElementById("tour-skip").dispatchEvent(new w.Event("click", { bubbles: true }));
  assert.equal(w.GrmcTour._state().active, false, "skipping the last step ends the tour");
});

test("Esc during a recording asks before abandoning it", { skip }, () => {
  const { w, doc } = started();
  let asked = false;
  w.confirm = () => { asked = true; return false; };
  w.eval("meetingRec = { meetingId: 42, topic: '' }");
  doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  assert.equal(asked, true);
  assert.equal(w.GrmcTour._state().active, true, "declining the confirm keeps the tour up");
});

test("a first visit is offered the tour, and never hijacked by it", { skip }, () => {
  const { w, doc } = boot(GATED_STEPS);
  assert.ok(doc.getElementById("tour-offer"), "the offer bar is shown");
  assert.equal(w.GrmcTour._state().active, false, "but the tour does not start on its own");

  doc.getElementById("tour-offer-no").dispatchEvent(new w.Event("click", { bubbles: true }));
  assert.equal(doc.getElementById("tour-offer"), null, "dismissing removes it");

  // A second visit in the same browser is not pestered again.
  const again = boot(GATED_STEPS, (win) =>
    win.localStorage.setItem("grmc.minutes.tour", JSON.stringify({ step: 0, done: true })));
  assert.equal(again.doc.getElementById("tour-offer"), null);
});

test("a half-finished walkthrough resumes where it left off", { skip }, async () => {
  const { w, doc } = boot(GATED_STEPS, (win) =>
    win.localStorage.setItem("grmc.minutes.tour", JSON.stringify({ step: 1, done: false })));

  await Promise.resolve();   // let the GET /api/practice promise chain settle
  await Promise.resolve();

  assert.equal(w.GrmcTour._state().active, true);
  assert.equal(w.GrmcTour._state().index, 1);
  assert.equal(doc.getElementById("tour-offer"), null, "resuming replaces the first-visit offer");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/meeting-minutes && npm i -D jsdom && npm test
```

Expected: FAIL — `publicDir` resolves to `""` because `tour.js` does not exist,
so every test skips. Treat "all six skipped" as the failing state here; they
must run and pass by Step 6.

- [ ] **Step 3: Write `src/public/tour.css`**

```css
/* Guided walkthrough — overlay, spotlight and callout. */
#tour-mask-top,#tour-mask-right,#tour-mask-bottom,#tour-mask-left{
  position:fixed;background:rgba(9,45,62,.55);z-index:9000;pointer-events:auto}
#tour-ring{position:fixed;z-index:9001;border-radius:var(--r);pointer-events:none;
  box-shadow:0 0 0 3px var(--gold),0 0 0 9px var(--gold-ring)}
#tour-callout{position:fixed;z-index:9002;width:min(360px,calc(100vw - 32px));
  background:var(--card);border:1px solid var(--rule);border-radius:var(--r-lg);
  box-shadow:var(--shadow-lg);padding:16px}
#tour-callout.docked{right:16px;bottom:16px;left:auto;top:auto}
#tour-callout h3{font-size:16px;margin-bottom:6px}
#tour-callout .tour-count{font-size:10px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--gold-d);font-weight:700;margin-bottom:6px}
#tour-callout .tour-body{font-size:13px;line-height:1.55;color:var(--ink)}
#tour-callout .tour-hint{font-size:11.5px;color:var(--hint);margin-top:8px}
#tour-callout .tour-actions{display:flex;gap:8px;align-items:center;margin-top:14px}
#tour-callout .tour-actions .spacer{flex:1}
#tour-offer{position:fixed;left:16px;right:16px;bottom:16px;z-index:8999;display:flex;
  gap:12px;align-items:center;flex-wrap:wrap;background:var(--card);border:1px solid var(--rule);
  border-radius:var(--r-lg);box-shadow:var(--shadow-lg);padding:12px 16px;font-size:13px}
#tour-offer span{flex:1;min-width:220px}
@media (max-width:700px){#tour-callout{right:16px;bottom:16px;left:auto;top:auto}}
```

- [ ] **Step 4: Write `src/public/tour.js`**

```js
// Guided walkthrough engine. Steps live in tour-steps.js (window.TOUR_STEPS);
// this file knows nothing about their content.
//
// The dim overlay is four panels framing the anchor rather than one sheet with
// a CSS cut-out, so the hole is genuinely empty and the spotlighted control
// stays clickable with no pointer-events handling.
var GrmcTour = (function(){
  var steps=[], idx=0, active=false, docked=false, raf=null;
  var STORE='grmc.minutes.tour';

  function save(){
    try { localStorage.setItem(STORE, JSON.stringify({ step: idx, done: !active })); } catch(e){}
  }
  function load(){
    try { return JSON.parse(localStorage.getItem(STORE)||'{}')||{}; } catch(e){ return {}; }
  }

  function el(id){ return document.getElementById(id); }
  function step(){ return steps[idx]||null; }

  function buildChrome(){
    if(el('tour-callout')) return;
    var frag='';
    ['top','right','bottom','left'].forEach(function(side){
      frag+='<div id="tour-mask-'+side+'" hidden></div>';
    });
    frag+='<div id="tour-ring" hidden></div>'
      +'<div id="tour-callout" hidden>'
      +'<div class="tour-count" id="tour-count"></div>'
      +'<h3 id="tour-title"></h3>'
      +'<div class="tour-body" id="tour-body"></div>'
      +'<div class="tour-hint" id="tour-hint"></div>'
      +'<div class="tour-actions">'
      +'<button class="btn-sm" id="tour-back">Back</button>'
      +'<span class="spacer"></span>'
      +'<button class="btn-sm" id="tour-skip">Skip</button>'
      +'<button class="btn btn-primary btn-sm" id="tour-next">Next</button>'
      +'</div></div>';
    var host=document.createElement('div');
    host.id='tour-root';
    host.innerHTML=frag;
    document.body.appendChild(host);
    el('tour-next').addEventListener('click', next);
    el('tour-back').addEventListener('click', back);
    el('tour-skip').addEventListener('click', skip);
    document.addEventListener('keydown', onKey);
  }

  function onKey(e){
    if(!active || e.key!=='Escape') return;
    if(window.meetingRec && !window.confirm('A practice recording is still running. Leave the walkthrough?')) return;
    end();
  }

  function setMasks(rect){
    var W=window.innerWidth, H=window.innerHeight, pad=6;
    var t=Math.max(0,rect.top-pad), b=Math.min(H,rect.bottom+pad);
    var l=Math.max(0,rect.left-pad), r=Math.min(W,rect.right+pad);
    place('tour-mask-top',    0, 0, W, t);
    place('tour-mask-bottom', 0, b, W, H-b);
    place('tour-mask-left',   0, t, l, b-t);
    place('tour-mask-right',  r, t, W-r, b-t);
    var ring=el('tour-ring');
    ring.hidden=false;
    ring.style.left=l+'px'; ring.style.top=t+'px';
    ring.style.width=(r-l)+'px'; ring.style.height=(b-t)+'px';
  }
  function place(id,x,y,w,h){
    var n=el(id); n.hidden=false;
    n.style.left=x+'px'; n.style.top=y+'px';
    n.style.width=Math.max(0,w)+'px'; n.style.height=Math.max(0,h)+'px';
  }
  function hideMasks(){
    ['top','right','bottom','left'].forEach(function(s){ el('tour-mask-'+s).hidden=true; });
    el('tour-ring').hidden=true;
  }

  function dock(){
    docked=true;
    hideMasks();
    var c=el('tour-callout');
    c.classList.add('docked');
    c.style.left=''; c.style.top='';
  }
  function floatBy(rect){
    docked=false;
    var c=el('tour-callout');
    c.classList.remove('docked');
    var below=rect.bottom+12;
    var fits=below+c.offsetHeight < window.innerHeight;
    c.style.top=(fits?below:Math.max(12, rect.top-c.offsetHeight-12))+'px';
    c.style.left=Math.max(12, Math.min(rect.left, window.innerWidth-c.offsetWidth-12))+'px';
  }

  // Can the current step's Next button fire?
  function canAdvance(){
    var s=step();
    if(!s) return false;
    if(!s.advance || typeof s.advance.until!=='function') return true;
    try { return s.advance.until()===true; } catch(e){ return false; }
  }

  function render(){
    var s=step();
    if(!s){ end(); return; }
    el('tour-callout').hidden=false;
    el('tour-count').textContent='Step '+(idx+1)+' of '+steps.length;
    el('tour-title').textContent=s.title;
    el('tour-body').innerHTML=s.body;
    var gated=!!(s.advance && s.advance.until);
    el('tour-hint').textContent=(gated && !canAdvance() && s.advance.hint) ? s.advance.hint : '';
    el('tour-back').disabled = idx===0;
    el('tour-skip').hidden = !s.optional;
    el('tour-next').disabled = !canAdvance();
    if(typeof s.before==='function'){ try { s.before(); } catch(e){} }
  }

  // One pass: re-resolve the anchor (renderItems() rebuilds item DOM and the
  // 3s poll patches cards, so a cached node goes stale within seconds), then
  // check whether the step's condition has been satisfied.
  function tick(){
    if(!active) return;
    var s=step();
    if(!s) return;
    if(typeof s.skipIf==='function'){
      var bail=false;
      try { bail=s.skipIf()===true; } catch(e){}
      if(bail){ next(true); return; }
    }
    var node=s.anchor ? document.querySelector(s.anchor) : null;
    var rect=node && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    if(rect && rect.width>0 && rect.height>0 && window.innerWidth>700){
      setMasks(rect); floatBy(rect);
    } else {
      dock();
    }
    var n=el('tour-next');
    if(n) n.disabled=!canAdvance();
    var h=el('tour-hint');
    if(h && s.advance && s.advance.until) h.textContent=canAdvance()?'':(s.advance.hint||'');
    if(s.advance && s.advance.until && canAdvance() && s.advance.auto!==false) next(true);
  }

  function loop(){
    tick();
    if(active && typeof requestAnimationFrame==='function') raf=requestAnimationFrame(loop);
  }

  function goTo(i){
    idx=Math.max(0, Math.min(steps.length-1, i));
    var s=step();
    if(s && s.view==='list' && typeof showList==='function') showList();
    if(s && s.view==='detail' && typeof openMeeting==='function'
       && (!window.state || !state.meeting || state.meeting.id!==GrmcTour.practiceId)){
      openMeeting(GrmcTour.practiceId);
    }
    if(s && s.tab && typeof switchTab==='function') switchTab(s.tab);
    render(); save(); tick();
  }

  function next(auto){
    if(!auto && !canAdvance()) return;
    if(idx>=steps.length-1){ end(); return; }
    goTo(idx+1);
  }
  function back(){ if(idx>0) goTo(idx-1); }
  function skip(){
    var s=step();
    if(!s || !s.optional) return;
    if(idx>=steps.length-1){ end(); return; }
    goTo(idx+1);
  }

  function begin(){
    steps=(window.TOUR_STEPS||[]).slice();
    if(!steps.length) return;
    // Starting from the header button while the first-visit bar is still up
    // would leave the offer sitting under the tour it already accepted.
    var offer=el('tour-offer');
    if(offer && offer.parentNode) offer.parentNode.removeChild(offer);
    active=true;
    buildChrome();
    goTo(0);
    loop();
  }

  // seed:false is for tests — the real entry point resets the practice meeting
  // first so a retake always starts from a known state.
  function start(opts){
    if(opts && opts.seed===false){ GrmcTour.practiceId=42; begin(); return; }
    fetch('/api/practice', { method:'POST' })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if(!res.ok){ window.alert('Could not set up the practice meeting: '+(res.error||'')); return; }
        GrmcTour.practiceId=res.meetingId;
        begin();
      })['catch'](function(e){ window.alert('Could not set up the practice meeting: '+e.message); });
  }

  function end(){
    active=false;
    if(raf && typeof cancelAnimationFrame==='function') cancelAnimationFrame(raf);
    raf=null;
    hideMasks();
    var c=el('tour-callout');
    if(c) c.hidden=true;
    save();
  }

  // Pick a half-finished walkthrough back up. Returns false when there is
  // nothing to resume, so the caller can fall through to the first-visit offer.
  function resume(){
    var st=load();
    if(!st || st.done || typeof st.step!=='number' || st.step<1) return false;
    fetch('/api/practice').then(function(r){ return r.json(); }).then(function(res){
      if(!res.ok || !res.meetingId) return;   // practice meeting was deleted — nothing to resume
      GrmcTour.practiceId=res.meetingId;
      steps=(window.TOUR_STEPS||[]).slice();
      if(!steps.length) return;
      active=true;
      buildChrome();
      goTo(st.step);
      loop();
    })['catch'](function(){});
    return true;
  }

  // A browser that has never seen the walkthrough gets one dismissible offer.
  // It never auto-starts: a tour that seizes the page on first load is rude,
  // and this app is sometimes opened mid-meeting.
  function autoOffer(){
    var st=load();
    if(st && (st.done || typeof st.step==='number')) return false;
    var bar=document.createElement('div');
    bar.id='tour-offer';
    bar.innerHTML='<span>First time here? Take the walkthrough — it uses a practice '
      +'meeting, so nothing you do affects real minutes.</span>'
      +'<button class="btn btn-primary btn-sm" id="tour-offer-yes">Take the walkthrough</button>'
      +'<button class="btn-sm" id="tour-offer-no">Not now</button>';
    document.body.appendChild(bar);
    function dismiss(){
      try { localStorage.setItem(STORE, JSON.stringify({ step:0, done:true })); } catch(e){}
      if(bar.parentNode) bar.parentNode.removeChild(bar);
    }
    document.getElementById('tour-offer-yes').addEventListener('click', function(){
      if(bar.parentNode) bar.parentNode.removeChild(bar);
      start();
    });
    document.getElementById('tour-offer-no').addEventListener('click', dismiss);
    return true;
  }

  return {
    practiceId: null,
    start: start, end: end, next: function(){ next(false); }, back: back, skip: skip,
    resume: resume, autoOffer: autoOffer,
    _tick: tick,
    _state: function(){ return { active:active, index:idx, docked:docked, canAdvance:canAdvance() }; },
    _stored: load
  };
})();
window.GrmcTour = GrmcTour;

// Header launcher, then resume a half-finished run, or offer the tour once.
(function(){
  var b=document.getElementById('btn-tour');
  if(b) b.addEventListener('click', function(){ GrmcTour.start(); });
  if(!GrmcTour.resume()) GrmcTour.autoOffer();
})();
```

- [ ] **Step 5: Wire it into `src/public/index.html`**

Add the stylesheet next to the existing `<link>` tags:

```html
<link rel="stylesheet" href="/tour.css">
```

Put the launcher in the header's right-hand group:

```html
  <div class="hright"><button class="btn-sm" id="btn-tour">Walkthrough</button>
    <span class="hlabel" id="me-label">&hellip;</span></div>
```

And load the tour after `app.js`, so its globals exist:

```html
<script src="/app.js"></script>
<script src="/tour-steps.js"></script>
<script src="/tour.js"></script>
```

`tour-steps.js` does not exist until Task 6. Create it now as a one-line
placeholder so the page does not 404 — Task 6 replaces its contents:

```js
window.TOUR_STEPS = [];
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd apps/meeting-minutes && npm test
```

Expected: all six `tour.test.ts` tests PASS (not skip).

- [ ] **Step 7: Commit**

```bash
git add apps/meeting-minutes/src/public apps/meeting-minutes/src/tour.test.ts
git commit -m "feat(minutes): guided-tour engine with spotlight and gated steps"
```

---

### Task 6: The walkthrough content

**Files:**
- Modify: `src/public/tour-steps.js` (replace the placeholder)
- Test: `src/tour.test.ts` (append)

**Interfaces:**
- Consumes: the engine's step shape (Task 5) — `{view, tab, anchor, title, body,
  advance:{until,hint,auto}, optional, skipIf, before}`
- Produces: `window.TOUR_STEPS` — 19 steps; `window.TOUR_CAN_RECORD()` —
  microphone feature-detection used by `skipIf`

- [ ] **Step 1: Write the failing test**

Append to `src/tour.test.ts`:

```ts
function bootReal(): { w: any; doc: any } {
  return boot(readFileSync(join(publicDir, "tour-steps.js"), "utf8"));
}

test("the walkthrough covers the whole meeting lifecycle", { skip }, () => {
  const { w } = bootReal();
  const steps = w.TOUR_STEPS;
  assert.equal(steps.length, 19);
  for (const s of steps) {
    assert.ok(s.title && s.body, "every step has copy: " + JSON.stringify(s.title));
  }
  // The live block is steps 9-15 (indices 8-14) and every one of them is
  // escapable, or a user with no microphone is stuck forever.
  for (let i = 8; i <= 14; i++) {
    assert.ok(steps[i].optional === true, "live step " + (i + 1) + " must be optional");
  }
});

test("the live block skips itself when the browser cannot record", { skip }, () => {
  const { w } = bootReal();
  w.navigator.mediaDevices = undefined;
  w.MediaRecorder = undefined;
  assert.equal(w.TOUR_CAN_RECORD(), false);
  for (let i = 8; i <= 14; i++) {
    assert.equal(w.TOUR_STEPS[i].skipIf(), true, "step " + (i + 1) + " self-skips with no mic");
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/meeting-minutes && npm test
```

Expected: FAIL — `TOUR_STEPS` has length 0 and `TOUR_CAN_RECORD` is undefined.

- [ ] **Step 3: Write `src/public/tour-steps.js`**

Replace the placeholder entirely. The engine calls `skipIf` before anchoring, so
a browser with no microphone walks straight past the live block.

```js
// The walkthrough's content. The engine (tour.js) knows nothing about these;
// this file knows nothing about spotlight mechanics.
window.TOUR_CAN_RECORD = function(){
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
};
function tourNoMic(){ return !window.TOUR_CAN_RECORD(); }
function tourItem(n){
  var items=(window.state&&state.items)||[];
  return items[n] ? items[n].id : 0;
}

window.TOUR_STEPS = [
  // ── Before the meeting ────────────────────────────────────────────────────
  { view:'list', title:'Welcome to Meeting Minutes',
    body:'This takes about ten minutes and uses a <strong>practice meeting</strong> — '
       + 'nobody else can see it, and you can delete it at the end.<br><br>'
       + 'The one thing to remember: you press record <strong>once</strong> for the whole '
       + 'meeting, and <strong>opening a topic</strong> is what files the audio under it.' },

  { view:'list', tab:'people', anchor:'.tab[data-tab="people"]',
    title:'The people library',
    body:'Everyone who might attend lives here, once. You pick from this list for every '
       + 'meeting, so you only ever type a name in a single time.' },

  { view:'list', tab:'settings', anchor:'.tab[data-tab="settings"]',
    title:'One key, and what it does',
    body:'The Anthropic key reads your agenda, writes the summaries and builds the report. '
       + '<strong>Transcription does not use it</strong> — that runs on your own server, so '
       + 'the audio never leaves the building and costs nothing per minute.' },

  { view:'list', tab:'meetings', anchor:'#btn-new-meeting',
    title:'Creating a real meeting',
    body:'Title, date and location. That is the whole form — everything else happens inside '
       + 'the meeting. We have already made a practice one for you below.' },

  { view:'list', tab:'meetings', anchor:'.mcard',
    title:'Open the practice meeting',
    body:'Click it to go in.',
    advance:{ until:function(){ return !!(window.state&&state.meeting&&state.meeting.id===GrmcTour.practiceId); },
              hint:'Waiting for you to open the practice meeting…' } },

  { view:'detail', anchor:'#attendee-chips', title:'Who is present?',
    body:'Tick everyone in the room. This does two jobs: attendees become selectable as '
       + 'presenters, and they become the list of names you can attach to voices later.' },

  { view:'detail', anchor:'#btn-upload-agenda', title:'The agenda',
    body:'Upload the agenda as a PDF, a photo, or a text file and it is read into an ordered '
       + 'list of topics. Re-uploading <strong>replaces</strong> the topics, so do it before '
       + 'the meeting, not during. <em>Add item manually</em> covers the ones that come up.' },

  { view:'detail', anchor:'#items-wrap', title:'Who is presenting each topic',
    body:'Open a topic and set <em>Presented by</em>. It is worth doing: the presenter is how '
       + 'the app works out which voice belongs to whom without you labelling anything.',
    before:function(){ var w=document.getElementById('items-wrap'); if(w) w.scrollIntoView({block:'center'}); } },

  // ── During the meeting ────────────────────────────────────────────────────
  { view:'detail', anchor:'#btn-meeting-rec', title:'Press record once',
    body:'One recording for the entire meeting — not one per topic. Press it now and talk for '
       + 'a few seconds as if the meeting had started.',
    optional:true, skipIf:tourNoMic,
    advance:{ until:function(){ return !!window.meetingRec; },
              hint:'Waiting for the recording to start… (your browser will ask for the microphone)' } },

  { view:'detail', anchor:'#rec-banner', title:'The bar that follows you',
    body:'This stays on screen wherever you scroll — even back on the meetings list. '
       + '<strong>Filing under:</strong> tells you which topic the audio is going to right now. '
       + 'If it is amber and says no topic is open, everything is landing on the first item.',
    optional:true, skipIf:tourNoMic },

  { view:'detail', anchor:'#items-wrap', title:'Open each topic as it comes up',
    body:'This is the whole trick. Open the third topic now and watch the bar change to '
       + '<em>Filing under: Building repairs</em>.<br><br>Opening a topic lays down a marker; '
       + 'collapsing one does not. Come back to a topic later and the audio joins up in order.',
    optional:true, skipIf:tourNoMic,
    advance:{ until:function(){ return !!(window.state&&state.openItemId&&state.openItemId===tourItem(2)); },
              hint:'Waiting for you to open “Building repairs — roof quote”…' } },

  { view:'detail', anchor:'#rec-banner', title:'Say something about the roof',
    body:'Talk for about twenty seconds — anything at all, it is a practice meeting. Two voices '
       + 'work better than one if someone is nearby.',
    optional:true, skipIf:tourNoMic,
    advance:{ until:function(){ return typeof meetingElapsedSeconds==='function' && meetingElapsedSeconds()>20; },
              hint:'Keep talking…' } },

  { view:'detail', anchor:'#items-wrap', title:'Typed notes still matter',
    body:'The <em>Notes</em> box under each topic is yours — motions, figures, anything the '
       + 'microphone will mangle. Notes and transcript both feed the summary.',
    optional:true, skipIf:tourNoMic },

  { view:'detail', anchor:'#btn-meeting-rec', title:'Stop and process',
    body:'Press <strong>Stop &amp; process</strong>. Keep this tab open until the bar stops '
       + 'saying “Finishing upload” — the last few seconds of audio are still on their way.',
    optional:true, skipIf:tourNoMic,
    advance:{ until:function(){ var m=window.state&&state.meeting; return !!m &&
              (m.recording_status==='queued'||m.recording_status==='processing'||m.recording_status==='done'); },
              hint:'Waiting for the recording to stop…' } },

  // ── After the meeting ─────────────────────────────────────────────────────
  { view:'detail', anchor:'#mrec-extra', title:'What happens now',
    body:'The recording is transcribed on your own server and split across the topics using '
       + 'the markers you laid down. One job at a time, so a long meeting queues rather than '
       + 'fighting itself. You can leave the page — it keeps going.',
    optional:true, skipIf:tourNoMic },

  { view:'detail', anchor:'#meeting-speakers', title:'Name each voice once',
    body:'Every voice in the meeting is listed here with how much it spoke and a line it said — '
       + 'use that line to recognise who it is. Name it once and <strong>every topic</strong> '
       + 'updates. If one person got split into two voices, give both rows the same name and '
       + 'they merge.',
    before:function(){ var p=document.getElementById('meeting-speakers'); if(p) p.scrollIntoView({block:'center'}); } },

  { view:'detail', anchor:'#items-wrap', title:'Summaries write themselves',
    body:'A topic is summarised when you collapse it or open another one — so working down the '
       + 'agenda summarises as you go. Edit a transcript or a note and the summary clears itself '
       + 'and regenerates, rather than leaving you with minutes that no longer match.'
       + '<br><br>Action items are pulled out of ordinary speech — “Tom will bring a '
       + 'recommendation in May” becomes a task with Tom’s name on it.' },

  { view:'detail', anchor:'#btn-report', title:'The report',
    body:'One document: every topic with its summary, then a single consolidated checklist of '
       + 'action items with an owner against each. Download it as Markdown, or print it to PDF '
       + 'for the minute book.'
       + '<br><br><em>No Anthropic key set? This button will tell you so rather than inventing '
       + 'minutes. Add the key under Settings and come back.</em>' },

  { view:'detail', anchor:'#btn-edit-meeting', title:'That is the whole job',
    body:'Before: people, meeting, agenda. During: record once, open each topic as you reach it. '
       + 'After: name the voices, generate the report.'
       + '<br><br>When you are done here, open <em>Edit details</em> and delete this practice '
       + 'meeting — it takes its demo people with it. You can retake this any time from the '
       + '<strong>Walkthrough</strong> button in the header.' }
];
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/meeting-minutes && npm test
```

Expected: PASS — 19 steps, all with copy, indices 8–14 optional and self-skipping.

- [ ] **Step 5: Commit**

```bash
git add apps/meeting-minutes/src/public/tour-steps.js apps/meeting-minutes/src/tour.test.ts
git commit -m "feat(minutes): the nineteen-step walkthrough content"
```

---

### Task 7: Documentation and end-to-end verification

**Files:**
- Modify: `README.md` (repo root)

**Interfaces:**
- Consumes: everything above
- Produces: no code

- [ ] **Step 1: Document the walkthrough**

In `README.md`, in the **Meeting Minutes** bullet under *Apps*, append a
paragraph after the existing description:

```markdown
  First time in? The **Walkthrough** button in the header runs a guided tour
  against a disposable **practice meeting** seeded just for you — two of its
  topics arrive already transcribed and summarised, and the third is one you
  record yourself so the during-the-meeting rhythm (record once, open each topic
  as you reach it) is muscle memory before the real thing. Nobody else sees your
  practice meeting, its demo people never enter the shared people library, and
  deleting it removes both. The tour works with no Anthropic key and no
  microphone — the steps that need them say so and step aside.
```

- [ ] **Step 2: Run the whole suite**

```bash
cd apps/meeting-minutes && npm test
```

Expected: PASS, with the database and jsdom tests actually running
(`TEST_DATABASE_URL` set, jsdom installed) rather than skipping.

- [ ] **Step 3: Verify in the real app**

```bash
docker compose up -d --build meeting-minutes
```

Then at `https://minutes.grmc.app`:
1. Press **Walkthrough**; confirm the practice meeting appears and opens.
2. Confirm the demo cast is **absent** from the People tab.
3. Walk the live block: record, open topic 3 mid-recording, confirm the banner
   reads *Filing under: Building repairs*, stop, wait for processing.
4. Confirm the meeting-wide speaker panel lists the seeded voices **and** yours,
   and that the seeded names survived processing (this is the Task 2 merge).
5. Generate the report.
6. Delete the practice meeting from *Edit details*; confirm the demo people are
   gone from the database.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the meeting-minutes walkthrough"
```
