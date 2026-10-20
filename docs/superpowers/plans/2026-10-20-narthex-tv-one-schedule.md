# Narthex TV One Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Schedule tab the only thing that decides what plays and whether the TV is on, and add a "Play now" override for a single media item.

**Architecture:**
- Schedule coverage (merged spans of window and recurring occurrences) replaces operating hours as the source of `power.on`.
- A new `play_now` setting sits between the emergency takeover and the schedule, mirroring `takeover.ts`.
- `resolveNow` walks the ranked covering entries, skipping archived or unplayable playlists, and no longer falls back to a default playlist or idle screen.

**Tech Stack:** TypeScript, Fastify 5, pg, `node:test`; vanilla JS admin/player pages; Python `playout.py`.

**Spec:** `docs/superpowers/specs/2026-10-20-narthex-tv-one-schedule-design.md`

## Global Constraints

- Precedence, highest first: emergency takeover > Play now > active schedule entry > off. No other fallback.
- `power.on` is true iff a schedule entry covers now OR Play now is active OR the takeover is active. Playlist contents never affect power.
- Back-to-back or overlapping schedule occurrences (any playlist) merge into one stretch, and touching ends count as one stretch. Look ahead at least 8 days.
- Schedule modes are `window` and `recurring` only. A `window` requires `endsAt > startsAt`.
- Play now: one media item, loops until cleared, and only one at a time (a new one replaces the old). It needs the `schedule` permission and media `status === "ready"`. It applies only at the real current time; previews at `?at=` ignore it.
- `plan.power` keeps its shape `{ wakeMac, on, changesAt }`, so `player.js` and `playout.py` need no protocol change.
- Takeover behaviour, power actions (Samsung, WOL, test buttons) and the `power_events` log are unchanged.
- Run tests from `apps/narthex-tv`: `npm test` (it compiles with `tsc` first, so type errors fail the run).

## Review Focus

1. **A media item deleted or re-ingested while it is Play now.** Play now becomes inactive, the screen returns to the schedule, and if nothing is scheduled the TV turns off at the next tick. It must not show black forever or crash `buildPlan`. Owned by Task 2 (`getPlayNow` test) and Task 4.
2. **Container restart during Play now.** The state is in `settings`, so it survives, and the first tick after a restart must not fire a spurious "off". `tickPower` already persists `power_last_state`; Task 3's test pins `desiredPower` with Play now on and nothing scheduled.
3. **Takeover cleared while Play now is active.** The screen goes back to the Play now item, not the schedule, and power stays on. Task 4 test `sourceKeyFor` plus the `desiredPower` test in Task 3.
4. **Overnight recurring entry (22:00–02:00) next to a morning entry.** The span has to be computed from yesterday's occurrence, or the TV switches off at midnight. Task 1 test.
5. **Replacing one Play now with another.** The player has to cut immediately, so the `sourceKey` must differ when only the media id or `startedAt` changes. Task 4 test.

---

### Task 1: Schedule — drop `until_next`, require window ends, ranked candidates, coverage

**Files:**
- Modify: `apps/narthex-tv/src/schedule.ts`
- Modify: `apps/narthex-tv/src/tz.ts` (add `mergeSpans`)
- Modify: `apps/narthex-tv/src/schema.ts`
- Test: `apps/narthex-tv/src/schedule.test.ts`

**Interfaces:**
- Produces:
  - `type ScheduleMode = "window" | "recurring"`.
  - `Resolution` gains `candidates: ScheduleEntry[]`: every entry covering `now`, in winning order. `entry` stays `candidates[0] ?? null`.
  - `mergeSpans(spans: Span[]): Span[]` in `tz.ts`. It sorts and merges overlapping or touching spans.
  - `scheduleCoverage(entries: ScheduleEntry[], now: Date, timeZone: string): { on: boolean; changesAt: Date | null }` in `schedule.ts`.

- [ ] **Step 1: Rewrite the failing tests in `schedule.test.ts`**

Change the `entry()` helper default `mode` to `"window"`. Delete the tests that rely on `until_next` (`"an open-ended entry keeps playing…"`, `"a window borrows the screen from the standing content…"`, and any other `until_next` or open-ended-window cases). Add:

```ts
test("validation rejects until_next and windows without an end", () => {
  assert.equal(validateEntry({ mode: "until_next" as any, playlistId: 1, startsAt: "2026-01-15T10:00:00Z" }).ok, false);
  assert.equal(validateEntry({ mode: "window", playlistId: 1, startsAt: "2026-01-15T10:00:00Z", endsAt: null }).ok, false);
  assert.equal(validateEntry({ mode: "window", playlistId: 1, startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T10:00:00Z" }).ok, false);
});

test("candidates lists every covering entry in winning order", () => {
  const low = entry({ id: 1, priority: 0, startsAt: "2026-01-15T09:00:00Z", endsAt: "2026-01-15T12:00:00Z" });
  const high = entry({ id: 2, priority: 5, startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" });
  const r = resolveSchedule([low, high], at("2026-01-15T10:30:00Z"), CHI);
  assert.deepEqual(r.candidates.map((e) => e.id), [2, 1]);
  assert.equal(r.entry?.id, 2);
});

test("coverage is off with nothing scheduled and names the next start", () => {
  const e = entry({ startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" });
  const c = scheduleCoverage([e], at("2026-01-15T09:00:00Z"), CHI);
  assert.equal(c.on, false);
  assert.equal(c.changesAt?.toISOString(), "2026-01-15T10:00:00.000Z");
});

test("back-to-back and overlapping entries are one stretch", () => {
  const a = entry({ id: 1, playlistId: 10, startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" });
  const b = entry({ id: 2, playlistId: 20, startsAt: "2026-01-15T11:00:00Z", endsAt: "2026-01-15T12:00:00Z" });
  const c = entry({ id: 3, playlistId: 30, startsAt: "2026-01-15T11:30:00Z", endsAt: "2026-01-15T13:00:00Z" });
  const cov = scheduleCoverage([a, b, c], at("2026-01-15T10:30:00Z"), CHI);
  assert.equal(cov.on, true);
  assert.equal(cov.changesAt?.toISOString(), "2026-01-15T13:00:00.000Z");
});

test("an overnight recurring entry keeps coverage on past midnight", () => {
  // Thursday 2026-01-15, 22:00-02:00 Chicago (04:00-08:00Z next day)
  const night = entry({ mode: "recurring", days: [4], startTime: "22:00", endTime: "02:00" });
  const cov = scheduleCoverage([night], at("2026-01-16T07:00:00Z"), CHI); // 01:00 Friday local
  assert.equal(cov.on, true);
  assert.equal(cov.changesAt?.toISOString(), "2026-01-16T08:00:00.000Z");
});

test("disabled entries and dates outside effective bounds give no coverage", () => {
  const off = entry({ enabled: false, startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" });
  const bounded = entry({ id: 2, mode: "recurring", days: [], startTime: "09:00", endTime: "17:00", effectiveFrom: "2026-02-01" });
  assert.equal(scheduleCoverage([off, bounded], at("2026-01-15T16:30:00Z"), CHI).on, false);
});

test("no entries at all is off with no next change", () => {
  assert.deepEqual(scheduleCoverage([], at("2026-01-15T10:00:00Z"), CHI), { on: false, changesAt: null });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/narthex-tv && npm test`
Expected: `tsc` errors (`scheduleCoverage` not exported, `candidates` missing).

- [ ] **Step 3: Implement**

- In `tz.ts`, add `mergeSpans`. Lift the merge loop from `power.ts` `mergedSpans`.
- In `schedule.ts`:
  - Remove `until_next` everywhere: the type, the `openEnded` branch in `resolveSchedule`, `validateEntry`, and `describeEntries`.
  - `validateEntry` requires `endsAt` for `window`, and `endsAt > startsAt`.
  - Populate `candidates` from the sorted `bounded` list.
  - Add `scheduleCoverage`. Collect every occurrence of enabled entries from yesterday through `HORIZON_DAYS` ahead: windows as `{start, end}`, recurring via `occurrenceOn` per day key. Merge them with `mergeSpans`. If `now` is inside a span, return `{on: true, changesAt: span.end}`. Otherwise return `{on: false, changesAt: next span start or null}`.
  - Update the precedence doc comment so it says there is no fallback.
- In `schema.ts`, append to `SCHEMA_SQL`:

```sql
-- One schedule now decides both what plays and whether the TV is on, so an
-- entry with no end would keep the narthex lit indefinitely.
DELETE FROM schedule_entries WHERE mode = 'until_next' OR (mode = 'window' AND ends_at IS NULL);
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd apps/narthex-tv && npm test`
Expected: the schedule tests pass. Other files may still fail to compile only if they reference `until_next`. Fix those references here: `routes/schedule.ts` passes `mode` through, which is fine.

- [ ] **Step 5: Commit**

```bash
git add apps/narthex-tv/src/schedule.ts apps/narthex-tv/src/schedule.test.ts apps/narthex-tv/src/tz.ts apps/narthex-tv/src/schema.ts
git commit -m "feat(narthex-tv): schedule coverage, ranked candidates, no open-ended entries"
```

---

### Task 2: Play now state

**Files:**
- Create: `apps/narthex-tv/src/play-now.ts`
- Test: `apps/narthex-tv/src/play-now.test.ts`

**Interfaces:**
- Consumes: `getSetting`/`setSetting` (`settings.ts`), `getMedia` (`media.ts`).
- Produces:
  ```ts
  export interface PlayNow { active: boolean; mediaId: number; title: string; startedAt: string | null; startedBy: string; }
  export const NO_PLAY_NOW: PlayNow;
  export function parsePlayNow(raw: string): PlayNow;          // title is "" here
  export async function getPlayNow(pool: Pool): Promise<PlayNow>; // inactive unless media exists and status === "ready"; fills title
  export async function startPlayNow(pool: Pool, mediaId: number, by: string): Promise<PlayNow>;
  export async function clearPlayNow(pool: Pool): Promise<void>;
  ```
  The settings key is `"play_now"`, and its JSON is `{ active: true, mediaId, startedAt, startedBy }`.

- [ ] **Step 1: Write the failing tests**

```ts
test("an empty or malformed row is no Play now", () => {
  assert.equal(parsePlayNow("").active, false);
  assert.equal(parsePlayNow("{not json").active, false);
  assert.equal(parsePlayNow(JSON.stringify({ active: false, mediaId: 3 })).active, false);
});

test("a row without a usable media id is no Play now", () => {
  assert.equal(parsePlayNow(JSON.stringify({ active: true, mediaId: 0 })).active, false);
  assert.equal(parsePlayNow(JSON.stringify({ active: true, mediaId: "x" })).active, false);
});

test("a good row is read back", () => {
  const p = parsePlayNow(JSON.stringify({ active: true, mediaId: 7, startedAt: "2026-10-20T15:00:00.000Z", startedBy: "Pat" }));
  assert.deepEqual(p, { active: true, mediaId: 7, title: "", startedAt: "2026-10-20T15:00:00.000Z", startedBy: "Pat" });
});
```

`getPlayNow` touches the DB, so it is covered by Review Focus 1 through a fake pool. Add:

```ts
test("Play now of a deleted or unready item is inactive", async () => {
  const row = JSON.stringify({ active: true, mediaId: 7, startedAt: "2026-10-20T15:00:00.000Z", startedBy: "Pat" });
  const pool = fakePool({ play_now: row }, { 7: null });              // media gone
  assert.equal((await getPlayNow(pool)).active, false);
  const pool2 = fakePool({ play_now: row }, { 7: { status: "processing", title: "X" } });
  assert.equal((await getPlayNow(pool2)).active, false);
});
```

`fakePool` is a small local helper with a `query(sql, params)` method. It answers the settings `SELECT value FROM settings WHERE key = $1` lookup and the `getMedia` `SELECT … FROM media WHERE id = $1` lookup from the two maps. Check the exact SQL in `settings.ts:146` and `media.ts:73`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/narthex-tv && npm test`
Expected: compile error, because `./play-now` doesn't exist yet.

- [ ] **Step 3: Implement `play-now.ts`**

Model it on `takeover.ts`'s shape and defensive parsing. There's no rendering. `startPlayNow` writes a fresh `startedAt = new Date().toISOString()`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd apps/narthex-tv && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/narthex-tv/src/play-now.ts apps/narthex-tv/src/play-now.test.ts
git commit -m "feat(narthex-tv): Play now state"
```

---

### Task 3: Power follows the schedule; operating hours removed

**Files:**
- Modify: `apps/narthex-tv/src/power.ts` (gut it down to `desiredPower`)
- Create: `apps/narthex-tv/src/power-events.ts` (move `recordPowerEvent`, `PowerEvent`, `listPowerEvents` from `hours.ts`)
- Delete: `apps/narthex-tv/src/hours.ts`
- Modify: `apps/narthex-tv/src/power-runner.ts`
- Modify: `apps/narthex-tv/src/schema.ts` (remove the `operating_hours` CREATE and index; leave the existing table alone; no DROP)
- Modify: `apps/narthex-tv/src/settings.ts` and `settings.test.ts` (remove `hoursMode`)
- Modify: `apps/narthex-tv/src/routes/power.ts` (remove `/api/hours*`; add `GET /api/power`; update the takeover routes' import of `recordPowerEvent`)
- Test: `apps/narthex-tv/src/power.test.ts` (rewritten)

**Interfaces:**
- Consumes: `scheduleCoverage` (Task 1), `getPlayNow` (Task 2), `getTakeover`.
- Produces:
  - `desiredPower(scheduleOn: boolean, playNowActive: boolean, takeoverActive: boolean): "on" | "off"` in `power.ts`.
  - `kickPower(): void` in `power-runner.ts`. It runs one tick now if the runner is started, and does nothing otherwise.
  - `GET /api/power` → `{ ok, timezone, events: PowerEvent[], onAction, offAction }`. These are the non-hours fields `/api/hours` used to return.
  - Power-event actions `play-now-on` and `play-now-off` (used in Task 5).

- [ ] **Step 1: Rewrite `power.test.ts`**

```ts
test("the TV is on exactly when something is set to play", () => {
  assert.equal(desiredPower(false, false, false), "off");
  assert.equal(desiredPower(true, false, false), "on");
  assert.equal(desiredPower(false, true, false), "on");   // Play now with nothing scheduled
  assert.equal(desiredPower(false, false, true), "on");   // takeover
  assert.equal(desiredPower(false, true, true), "on");    // takeover cleared later -> still Play now
});
```

In `settings.test.ts`, delete `"choosing scheduled hours is actually saved — the reported bug"` and any other `hoursMode` assertions.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/narthex-tv && npm test`
Expected: compile error, because `desiredPower` isn't exported yet.

- [ ] **Step 3: Implement**

- `tickPower`:

  ```ts
  want = desiredPower(scheduleCoverage(await listEntries(pool), deps.now(), settings.timezone).on, (await getPlayNow(pool)).active, (await getTakeover(pool)).active)
  ```

  Everything after `want` stays as it is.
- `startPowerRunner` stores its `run` in a module-level variable so `kickPower` can call it.
- Remove `hoursMode` from `AppSettings`, `DEFAULT_SETTINGS`, `KEYS`, `SETTING_VALIDATORS` and `SETTABLE_KEYS`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd apps/narthex-tv && npm test`
Expected: PASS for power and settings. `resolve.ts` will now fail to compile on `resolvePower` and `listWindows`. Stub `power` in `resolveNow` as `scheduleCoverage(entries, at, tz)` so the build is green; Task 4 finishes it.

- [ ] **Step 5: Commit**

```bash
git add -A apps/narthex-tv/src
git commit -m "feat(narthex-tv): the TV's power follows the schedule; operating hours removed"
```

---

### Task 4: Resolution and plan — fallback across entries, Play now, no default/idle

**Files:**
- Modify: `apps/narthex-tv/src/resolve.ts`
- Modify: `apps/narthex-tv/src/plan.ts` (add `sourceKeyFor`; drop the idle fields from `PlanDisplay`)
- Modify: `apps/narthex-tv/src/settings.ts` (remove `getDefaultPlaylistId`/`setDefaultPlaylistId`, `idleMessage`, and `"defaultPlaylistId"` in `SETTABLE_KEYS`) and `settings.test.ts`
- Delete: `apps/narthex-tv/src/idle.ts`, `apps/narthex-tv/src/idle.test.ts`
- Modify: `apps/narthex-tv/src/routes/settings.ts` (remove `/api/idle` and the default-playlist handling), `routes/player.ts` (remove the idle-slide route)
- Test: `apps/narthex-tv/src/plan.test.ts`

**Interfaces:**
- Consumes: `Resolution.candidates`, `scheduleCoverage` (Task 1); `getPlayNow` (Task 2).
- Produces:
  - `type PlanSource = "takeover" | "play_now" | "schedule" | "none"`.
  - `NowPlaying` becomes `{ resolution, playlist, source, settings, power: { on, changesAt }, playNow: PlayNow, nothingPlayable: boolean, frames: Frame[] }`. `playlist` is the playing playlist. When `nothingPlayable`, it is the winning entry's playlist, so the UI can name it.
  - `resolveNow(pool: Pool, at: Date, opts?: { live?: boolean }): Promise<NowPlaying>`. When `live` is true, Play now and the takeover are layered on. `routes/schedule.ts` passes `live: !rawAt`. `buildPlan` always passes `live: true`.
  - `sourceKeyFor(p: { takeoverStartedAt: string | null; playNow: { mediaId: number; startedAt: string } | null; powerOn: boolean; source: PlanSource; entryId: number; playlistId: number; startedAt: string }): string` in `plan.ts`.

- [ ] **Step 1: Write the failing tests in `plan.test.ts`**

```ts
const base = { takeoverStartedAt: null, playNow: null, powerOn: true, source: "schedule" as const, entryId: 3, playlistId: 9, startedAt: "2026-10-20T15:00:00.000Z" };

test("replacing one Play now with another changes the source key", () => {
  const a = sourceKeyFor({ ...base, source: "play_now", playNow: { mediaId: 1, startedAt: "2026-10-20T15:00:00.000Z" } });
  const b = sourceKeyFor({ ...base, source: "play_now", playNow: { mediaId: 2, startedAt: "2026-10-20T15:00:00.000Z" } });
  const c = sourceKeyFor({ ...base, source: "play_now", playNow: { mediaId: 1, startedAt: "2026-10-20T15:05:00.000Z" } });
  assert.notEqual(a, b); assert.notEqual(a, c);
});

test("starting and clearing Play now or a takeover changes the source key", () => {
  const sched = sourceKeyFor(base);
  const pn = sourceKeyFor({ ...base, source: "play_now", playNow: { mediaId: 1, startedAt: "x" } });
  const to = sourceKeyFor({ ...base, source: "takeover", takeoverStartedAt: "y", playNow: { mediaId: 1, startedAt: "x" } });
  assert.notEqual(sched, pn); assert.notEqual(pn, to);
});
```

In `settings.test.ts`, remove the idle and default-playlist assertions.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/narthex-tv && npm test`
Expected: compile error, because `sourceKeyFor` isn't exported.

- [ ] **Step 3: Implement**

- `sourceKeyFor`: concatenate the parts with prefixes (`TAKEOVER:`, `PLAYNOW:<id>:<startedAt>:`, `awake`/`dark`, then `source:entryId:playlistId:startedAt`). It must stay a superset of today's key so the existing cut-in behaviour holds.
- Extract `framesForPlaylist(pool, playlist, seedStart: Date | null, settings, at): Promise<Frame[]>` inside `resolve.ts` from the current `buildPlan` body.
- `resolveNow`:
  1. `coverage = scheduleCoverage(entries, at, tz)`.
  2. For each `resolution.candidates` entry in order, load the playlist. Skip archived. Build frames. Take the first with `frames.length > 0` as `source: "schedule"`.
  3. If candidates exist but none had frames, set `nothingPlayable: true`, `frames: []`, and use the first non-archived candidate's playlist (or null).
  4. If no candidates, `source: "none"`.
  5. If `live`: when `getPlayNow` is active, build frames by calling `buildFrames` with one `PlanItem` for that media (`seconds: 0`, `fit: ""`, `enabled: true`, no show dates) and a `PlaylistDefaults` of zeros and empty strings. Then `source: "play_now"` and `nothingPlayable: false`. When the takeover is active, `source: "takeover"`.
  6. `power.on = desiredPower(coverage.on, playNow.active, takeover.active) === "on"` (only Play now and the takeover when `live`). `power.changesAt = coverage.changesAt`.
- `buildPlan`:
  - Use `resolveNow(..., { live: true })` and `sourceKeyFor`.
  - Remove all idle code, including `loadIdle`/`ensureIdleSlide` and the idle `display` fields.
  - `frames` = takeover frames if the takeover is active, else `resolved.frames`.
  - `playlistName` is the media title during Play now.
  - `power.on` comes from `resolved.power.on`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd apps/narthex-tv && npm test`
Expected: PASS, and `tsc` is clean.

- [ ] **Step 5: Commit**

```bash
git add -A apps/narthex-tv/src
git commit -m "feat(narthex-tv): plan resolves takeover > Play now > schedule, no default or idle"
```

---

### Task 5: Play now and On now API

**Files:**
- Create: `apps/narthex-tv/src/routes/play-now.ts`
- Modify: `apps/narthex-tv/src/index.ts` (register `playNowRoutes`)
- Modify: `apps/narthex-tv/src/routes/schedule.ts` (`/api/schedule/now`)

**Interfaces:**
- Consumes: Task 2 functions, `kickPower` and `recordPowerEvent` (Task 3), `resolveNow(..., { live })` (Task 4), `requirePermission("schedule")`, `getIdentity`.
- Produces:
  - `GET /api/play-now` → `{ ok, playNow: PlayNow }`.
  - `POST /api/play-now { mediaId }`. It returns 400 `"That item isn't ready to play yet."` when the media is missing or not ready, and otherwise `{ ok, playNow }`.
  - `DELETE /api/play-now` → `{ ok }`.
  - POST and DELETE each record a power event (`play-now-on` with `"<title> — by <name>"`, and `play-now-off` with `"cleared by <name>"`), then call `kickPower()`.
  - `GET /api/schedule/now` adds `source` (now including `play_now` and `takeover`), `playNow: { mediaId, title, startedAt, startedBy } | null` and `nothingPlayable: boolean`. `live` is true only when `at` was not supplied.

- [ ] **Step 1: Implement the routes**

Copy the shape from `takeoverRoutes` in `routes/power.ts:203-244`.

- [ ] **Step 2: Build and run the tests**

Run: `cd apps/narthex-tv && npm test`
Expected: PASS.

- [ ] **Step 3: Exercise it against a running app**

Use the `run` skill, or `docker compose up narthex-tv`.
- With nothing scheduled, `POST /api/play-now` with a ready media id. Expect `GET /api/player/plan?t=<token>` to show `power.on: true`, frames for that media, and a `power_events` row `play-now-on`.
- `DELETE /api/play-now`. Expect `power.on: false` and empty frames.
- `GET /api/schedule/now?at=<future>` while Play now is active. Expect `source` to come from the schedule, not `play_now`.

- [ ] **Step 4: Commit**

```bash
git add apps/narthex-tv/src/routes/play-now.ts apps/narthex-tv/src/index.ts apps/narthex-tv/src/routes/schedule.ts
git commit -m "feat(narthex-tv): Play now API"
```

---

### Task 6: Admin UI

**Files:**
- Modify: `apps/narthex-tv/src/public/index.html`, `apps/narthex-tv/src/public/app.js`, `apps/narthex-tv/src/public/app.css` (only if needed)

**Interfaces:**
- Consumes: Task 5 endpoints, `GET /api/power`.

- [ ] **Step 1: Media tab**

Each item with `status === "ready"` gets a **Play now** button, shown only to users with schedule permission (use the same check the takeover controls use). If a Play now is already active for a different item, `confirm("Replace <current> with <new> on the screen?")` first. On success, switch to the On now tab.

- [ ] **Step 2: On now tab**

- **Play now banner.** Modelled on `#takeover-banner`: "Playing now: *title*, started by *who* at *time*", with a **Clear** button that calls `DELETE /api/play-now`.
- **Rewrite `describeNow`.**
  - `source === "takeover"` → leave it to the takeover banner.
  - `"play_now"` → the title, with the line "Playing because someone pressed Play now. It stays on until cleared."
  - `"schedule"` → today's entry wording, without `until_next`.
  - `nothingPlayable` → a red `alert` that reads exactly "Scheduled, but *<playlist name>* has nothing to show. The screen is black." It must not show the "Playing" title.
  - `"none"` → "Off. Nothing scheduled", plus ", coming on <fmtWhen(power.changesAt)>" when `changesAt` is set.
  - When on, also say "Turns off <fmtWhen(changesAt)>" if `power.changesAt` is set and no Play now or takeover is active.
- Remove the "outside the narthex's opening hours" and "standing default" copy.

- [ ] **Step 3: Schedule tab**

Remove the `until_next` option and its help text (`app.js:335` area). Make the window end time required in the form.

- [ ] **Step 4: Settings tab**

- Remove the operating-hours section (`hours-mode`, `hours-box`, `hours-list`, seed button, and the `/api/hours` calls). Load power data from `GET /api/power` instead.
- Remove `set-default-playlist` and the `defaultPlaylistId` state, the "default" pill on playlists (`app.js:495`), and the idle screen editor.
- Relabel the action prompts to "When the TV should turn on" and "When the TV should turn off".
- Keep the power actions, Samsung controls, test buttons and the event log. Add labels for `play-now-on` and `play-now-off` next to the existing `takeover-on` and `takeover-off` labels.

- [ ] **Step 5: Verify in a browser**

Use the `run` skill to start the app and open the admin.
- Press Play now on a media item and check that the banner appears and that the Clear button empties it.
- Check that the Settings tab has no hours, default playlist or idle sections.
- Check that the schedule form offers only "Between two times" and "Weekly".
- Check the browser console for errors.

- [ ] **Step 6: Commit**

```bash
git add apps/narthex-tv/src/public
git commit -m "feat(narthex-tv): Play now in the admin; one schedule, no hours/default/idle settings"
```

---

### Task 7: Players and docs

**Files:**
- Modify: `apps/narthex-tv/src/public/player.js`, `apps/narthex-tv/src/public/player.html`
- Modify: `scripts/narthex-tv/playout.py` (log wording at lines ~746 and ~1028, and the docstring at ~287)
- Modify: `scripts/narthex-tv/README.md`

- [ ] **Step 1: `player.js`**

When online with `frames.length === 0`, render plain black (hide `#idle`) and do not show the idle overlay. Keep the overlay only for the offline fallback, showing just `#idle-mark`. Remove the reads of `display.idleHeadline`, `idleMessage` and `idleShowMark`, and the matching `#idle-headline` and `#idle-text` elements if nothing else uses them.

- [ ] **Step 2: `playout.py`**

Change "(outside opening hours)" to "(nothing scheduled)", and the comment "Outside the narthex's opening hours" to "Nothing scheduled". Drop "the idle screen" from the docstring.

Run: `cd scripts/narthex-tv && python3 -m unittest test_playout -v`
Expected: PASS. Update any assertion that matches the old wording.

- [ ] **Step 3: README**

Replace the operating-hours wording with: "The TV is on whenever the schedule has something on, or Play now or an emergency takeover is active." Add a release note: "Before deploying, make sure the schedule covers every hour the narthex screen should be lit. Time with no entry is now dark."

- [ ] **Step 4: Full verification**

Run: `cd apps/narthex-tv && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/narthex-tv/src/public scripts/narthex-tv
git commit -m "feat(narthex-tv): players go black, not idle, when nothing is playable"
```
