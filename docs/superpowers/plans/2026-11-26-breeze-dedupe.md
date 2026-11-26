# Breeze Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Breeze event that sits on several ticked calendars becomes one Social Posts event with one checklist, and the duplicates already in the app are merged.

**Architecture:** A new `breeze_links` table records every Breeze copy (series id, instance id or NULL for a series link, calendar) against one app event; all sync lookups go through it. The sync reads every ticked calendar first, clusters copies by normalized name + shared date (pure code in a new `pipeline/breeze-dedupe.ts`), then saves everything in one transaction. A cleanup step at the start of each save merges existing duplicate events that nobody has touched.

**Tech Stack:** TypeScript, Fastify 5, `pg`, `node:test` (compiled by `tsc`, run from `dist`), vanilla JS client in `src/public/pipeline.js`.

**Spec:** `docs/superpowers/specs/2026-11-26-breeze-dedupe-design.md` (builds on `docs/superpowers/specs/2026-11-24-breeze-event-sync-design.md`)

## Global Constraints

- All paths below are under `apps/social-posts/`.
- Test command (from `apps/social-posts`): `TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/socialposts SOCIALPOSTS_DB_USER=x SOCIALPOSTS_DB_PASSWORD=x SOCIALPOSTS_DB_NAME=x npm test`. Baseline: 438 pass, 0 fail.
- Schema changes are idempotent statements appended to `src/schema.ts` (`CREATE … IF NOT EXISTS`, `ALTER … IF NOT EXISTS`, `INSERT … ON CONFLICT DO NOTHING`); they run on every boot.
- Match key: name trimmed, inner whitespace collapsed to one space, lower-cased. No other fuzziness.
- Same event = same match key on the same date. Two series are the same if same match key and at least one shared date in the 90-day window.
- Nothing the user edited is ever deleted. Merging only happens when every event in the group is untouched (definition in Task 5).
- Sync never goes through `updateContent`/`updateMedia` for date shifts (they mark dates hand-edited) — unchanged from the existing sync.
- Breeze dates are local `YYYY-MM-DD` strings; never parse them through `Date`.
- User-facing copy: plain words, no jargon.

## Review Focus

1. A calendar that fails to read while its copy of a merged event is missing → the event must not be flagged removed (Task 4 test `a copy on a failed calendar keeps the event unflagged`).
2. Same name, different date on two calendars → two events, not one (Task 2 test `same name on different dates stays apart`; Task 3 test `same name different dates on two calendars makes two events`).
3. A duplicate group where one event has a hand-added post or a changed status → nothing deleted, gap shown (Task 5 test `a touched group is left alone and shown as possible duplicates`).
4. Running the sync twice after a merge → no new events, no checklist rebuilt again (Task 5 test `cleanup is a no-op on the second run`).
5. Posts on a deleted duplicate: `content_items.event_id` is `ON DELETE SET NULL`, so deleting an event would orphan its posts as loose posts → the cleanup must delete the posts explicitly (Task 5 test asserts `count("content_items")` after merge).

---

### Task 1: Links table and multi-calendar checklist resolution

**Files:**
- Modify: `src/schema.ts` (append after the Breeze block)
- Modify: `src/pipeline/checklist.ts` (`resolveChecklist`)
- Modify: `src/pipeline/breeze-sync.ts` (callers of `resolveChecklist`; `applyRulesIn`)
- Modify: `src/pipeline/repo.ts` (event view gets `breezeCalendarIds`)
- Test: `src/checklist.test.ts`, `src/breeze-sync.test.ts`

**Interfaces:**
- Produces: table `breeze_links (id text PK default gen_random_uuid()::text, event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE, breeze_event_id text NOT NULL, breeze_instance_id text, calendar_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`; unique index on `breeze_instance_id WHERE breeze_instance_id IS NOT NULL`; unique index on `breeze_event_id WHERE breeze_instance_id IS NULL`; index on `event_id`.
- Produces: column `breeze_series.merged_into text` (the primary series' `breeze_event_id`, NULL for a primary).
- Produces: `resolveChecklist(rules, ev: { calendarIds: string[]; name: string })` — calendar rules for each id in the given order, then name rules by position; everything else unchanged.
- Produces: `async function eventCalendarIds(db: Db, eventId: string): Promise<string[]>` exported from `breeze-sync.ts` — the event's linked calendar ids, ordered by their position in the ticked list (`tickedCalendars`), unticked ones last by id.
- Produces: event view field `breezeCalendarIds: string[]` (from links; `[]` for manual events).

- [ ] **Step 1: Write failing tests**

In `src/checklist.test.ts`, change the shared `EV` to `{ calendarIds: ["c"], name: … }` (and the two inline calls on lines ~57–58), then add:

```ts
test("calendar rules for every linked calendar apply, in the given order", () => {
  const rules = [rule({ match: "calendar", calendarId: "b", items: [p("B")] }),
                 rule({ match: "calendar", calendarId: "a", items: [p("A")] })];
  assert.deepEqual(titles(resolveChecklist(rules, { calendarIds: ["a", "b"], name: "x" }).items), ["A", "B"]);
  assert.deepEqual(titles(resolveChecklist(rules, { calendarIds: ["b"], name: "x" }).items), ["B"]);
});
```
(Use the file's existing rule/post helpers; adjust names to match them.)

In `src/breeze-sync.test.ts` add the table to the `before` DROP list and the `beforeEach` TRUNCATE (`breeze_links`), and add:

```ts
test("a synced event gets one link per Breeze copy", async () => {
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24")];
  await sync();
  const [ev] = await events();
  const links = (await pool.query("SELECT * FROM breeze_links WHERE event_id = $1", [ev.id])).rows;
  assert.equal(links.length, 1);
  assert.equal(links[0].breeze_instance_id, "i1");
  assert.equal(links[0].calendar_id, "10");
});

test("schema backfills a link for a Breeze event made before links existed", async () => {
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24")];
  await sync();
  await pool.query("TRUNCATE breeze_links");
  await pool.query(SCHEMA_SQL);
  assert.equal(await count("breeze_links"), 1);
});
```

- [ ] **Step 2: Run tests, verify they fail** (`resolveChecklist` type error / `breeze_links` missing).

- [ ] **Step 3: Implement**
  - Schema: the table, indexes, `merged_into` column, and a backfill `INSERT INTO breeze_links (event_id, breeze_event_id, breeze_instance_id, calendar_id) SELECT id, breeze_event_id, breeze_instance_id, breeze_calendar_id FROM events WHERE source = 'breeze' AND breeze_event_id IS NOT NULL AND breeze_calendar_id IS NOT NULL ON CONFLICT DO NOTHING` (needs the unique indexes to be in place first; `ON CONFLICT DO NOTHING` with no target covers both partial indexes).
  - `createSynced` inserts the link row. (The `events.breeze_*` columns stay, holding the first copy, so existing UI/MCP keep working.)
  - `resolveChecklist` takes `calendarIds`; callers pass `[cal]` for now (Task 3 passes the cluster's list). `applyRulesIn` uses `eventCalendarIds`.
  - Event view: add `breezeCalendarIds` (one subquery `ARRAY(SELECT DISTINCT calendar_id FROM breeze_links WHERE event_id = e.id)` or equivalent in the event select).
  - `pipeline.js` line ~736: the "From Breeze" badge lists every name in `e.breezeCalendarIds` (fall back to `breezeCalendarId` when empty), joined with `, `.

- [ ] **Step 4: Run the full suite** — expected all pass (438 + new).

- [ ] **Step 5: Commit** `feat(breeze): links table for every Breeze copy; checklist rules for several calendars`

---

### Task 2: Clustering copies (pure)

**Files:**
- Create: `src/pipeline/breeze-dedupe.ts`
- Test: `src/breeze-dedupe.test.ts`

**Interfaces:**
- Consumes: `BreezeInstance` from `src/breeze.ts` (`{ instanceId, seriesId, calendarId, name, date }`).
- Produces:
  ```ts
  export function matchKey(name: string): string;
  export interface Cluster {
    key: string;                       // matchKey of the name
    seriesIds: string[];               // every Breeze series in it, in input order
    calendarIds: string[];             // distinct, in the order of the `calendarOrder` argument
    byDate: Map<string, BreezeInstance[]>; // date → the copies on that date, date order
  }
  export function clusterCopies(groups: Map<string, BreezeInstance[]>, calendarOrder: string[]): Cluster[];
  ```
  `groups` is the output of `groupBySeries` over all calendars together. Two series join one cluster when their match keys are equal and they share at least one date; joining is transitive (A shares a date with B, B with C → one cluster). Clusters come back ordered by their earliest date, then key.

- [ ] **Step 1: Write failing tests**

```ts
test("matchKey ignores case and extra spaces only", () => {
  assert.equal(matchKey("  Christmas   Eve "), "christmas eve");
  assert.notEqual(matchKey("Christmas Eve"), matchKey("Christmas Eve Service"));
});
test("the same name on the same date on two calendars is one cluster", () => { /* s1 on cal 10, s2 on cal 20, both 2026-12-24 → 1 cluster, seriesIds [s1,s2], calendarIds ["10","20"], byDate.get("2026-12-24").length === 2 */ });
test("same name on different dates stays apart", () => { /* 2026-12-24 vs 2026-12-31 → 2 clusters */ });
test("different names on the same date stay apart", () => { /* → 2 clusters */ });
test("weekly series on two calendars sharing dates is one cluster", () => { /* s1: 3 Sundays on 10; s2: 2 of the same Sundays on 20 → 1 cluster, byDate has 3 dates */ });
test("joining is transitive", () => { /* A{d1}, B{d1,d2}, C{d2} same name → 1 cluster */ });
test("calendarIds follow the ticked order", () => { /* calendarOrder ["20","10"] → ["20","10"] */ });
```
Write each body with `inst()`-style `BreezeInstance` literals and exact `assert.deepEqual`s on the fields named in the comment.

- [ ] **Step 2: Run, verify fail** (module not found).
- [ ] **Step 3: Implement** with a small union-find over series ids keyed by `(matchKey, date)`.
- [ ] **Step 4: Run** `node --test dist/breeze-dedupe.test.js` after `npm run build` — all pass.
- [ ] **Step 5: Commit** `feat(breeze): group Breeze copies of the same event`

---

### Task 3: Sync reads every calendar, then saves clusters through links

**Files:**
- Modify: `src/pipeline/breeze-sync.ts` (`syncBreeze`, `syncSeries`, `upsertSeries`, `rekeyToSeries`, `createSynced`, `refresh`, `setSeriesMode`, `listSeries`)
- Test: `src/breeze-sync.test.ts`

**Interfaces:**
- Consumes: `clusterCopies`, `Cluster` (Task 2); `breeze_links`, `merged_into`, `resolveChecklist({calendarIds})` (Task 1).
- Produces: unchanged `syncBreeze(pool, today, fetchFn): Promise<SyncReport>` signature and report fields. `listSeries` returns only primary series (`merged_into IS NULL`), `eventCount` counted through links. `setSeriesMode(db, id, mode)` updates the series and every series with `merged_into = id`.

Behaviour to build:
1. Fetch every ticked calendar first (failures go to `failedCalendars` as now; their copies are simply absent this run). Group all instances with `groupBySeries`, then `clusterCopies(groups, tickedOrder)`.
2. One transaction under the existing advisory lock for the whole save. If the save throws, every calendar read this run goes into `failedCalendars` and nothing is flagged.
3. Per cluster: the **primary series** is the cluster's series that already has a `breeze_series` row with `merged_into IS NULL`, earliest `first_seen_at`; else the first in `seriesIds`. New series rows for the others get `merged_into = primary`; an existing primary row that now sits under another primary is set `merged_into` too. Mode is the primary's. A new primary's mode comes from `newSeriesMode(resolveChecklist(rules, { calendarIds: cluster.calendarIds, name }).repeatMode, cluster.byDate.size)`; `becomesSeries` uses `cluster.byDate.size`.
4. Mode `series`: the event is the one linked (`breeze_instance_id IS NULL`) to any of `cluster.seriesIds`. If none, create it (checklist from all `cluster.calendarIds`) and link every series id. If found, add missing series links and refresh it from the earliest date's first copy.
5. Mode `each`/`single`: per date in `byDate`, the event is the one linked to any instance id on that date. If none, create it with all of that date's copies linked and the checklist from the calendars of those copies. If found, link the missing copies and refresh.
6. Never merge two existing events here: if the copies of one date (or one series cluster) already point at two different events, link new copies to the event of the earliest-linked copy and leave both events as they are (Task 5 handles merging).
7. `refresh` keeps updating name/date; `breeze_calendar_id` stays the first copy's.

- [ ] **Step 1: Write failing tests** (fake feed has calendars `"10"` and `"20"` ticked):

```ts
test("the same event on two calendars makes one event with both calendars' rules", async () => {
  await calRule([post("A {event}", 7)], "10");
  await calRule([post("B {event}", 3)], "20");
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24", "10")];
  feed["20"] = [inst("i2", "s2", "christmas  eve", "2026-12-24", "20")];
  const r = await sync();
  assert.equal(r.created, 1);
  const [ev] = await events();
  assert.deepEqual((await postsOf(ev.id)).map((p) => p.title), ["A Christmas Eve", "B Christmas Eve"]);
  assert.equal(await count("breeze_links"), 2);
});
test("a second sync of merged copies creates nothing", async () => { /* same feed, sync twice → second r.created === 0, count("events") === 1 */ });
test("same name different dates on two calendars makes two events", async () => { /* 12-24 on 10, 12-31 on 20 → 2 events */ });
test("a copy appearing later links to the existing event without new posts", async () => { /* sync with only feed 10, then add feed 20 copy, sync → 1 event, 2 links, posts unchanged (only calendar 10's rule items) */ });
test("a weekly series on two calendars is one series event", async () => { /* s1 3 Sundays on 10, s2 same Sundays on 20, mode series → 1 event, 2 series links; listSeries() has 1 row */ });
test("setting a merged series' mode applies to its copies", async () => { /* setSeriesMode(primary, "each"), sync → one event per Sunday, each linked to 2 instances; breeze_series rows both mode each */ });
test("a failed calendar still lets the other calendar's events sync", async () => { /* feed["20"] = 500 → event from 10 created, failedCalendars ["20"] */ });
```
Fill each body from its comment with exact assertions.

- [ ] **Step 2: Run, verify the new tests fail.**
- [ ] **Step 3: Implement** as described. Keep existing tests green — the per-calendar behaviours they pin (move shifts once, rename, single → series, ignore) must still hold.
- [ ] **Step 4: Full suite passes.**
- [ ] **Step 5: Commit** `feat(breeze): one event for the same Breeze event on several calendars`

---

### Task 4: Removed flag across copies

**Files:**
- Modify: `src/pipeline/breeze-sync.ts` (`markMissing`)
- Test: `src/breeze-sync.test.ts`

**Interfaces:**
- Consumes: `breeze_links` (Task 1); the run's read calendars, seen instance ids and seen series ids (Task 3 collects them across all read calendars).

Rule: a link is **seen** if its instance id (instance link) or series id (series link) came back this run. An event is **cleared** if any of its links is seen. An event is **flagged** only if none of its links is seen, **every** link's calendar was read in full this run, and the existing date conditions hold (instance events: `start_date BETWEEN today AND window end`; series events: `start_date >= today`). Archived and kept events are never flagged (unchanged).

- [ ] **Step 1: Write failing tests**

```ts
test("one copy gone while the other remains keeps the event unflagged", async () => { /* merged 10+20 event; next sync feed 20 = [] → breeze_missing_since null */ });
test("every copy gone flags the event", async () => { /* both feeds empty → flagged */ });
test("a copy on a failed calendar keeps the event unflagged", async () => { /* feed 10 = [], feed 20 = 500 → not flagged */ });
test("a flagged merged event clears when either copy returns", async () => { /* flag, then feed 20 returns its copy → cleared */ });
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `markMissing` as two set-based queries over `events JOIN breeze_links`.
- [ ] **Step 4: Full suite passes** (existing flag/keep tests included).
- [ ] **Step 5: Commit** `feat(breeze): an event is removed only when every Breeze copy is gone`

---

### Task 5: Merge existing duplicates; show the ones we can't

**Files:**
- Modify: `src/pipeline/breeze-dedupe.ts` (add `mergeDuplicates`)
- Modify: `src/pipeline/breeze-sync.ts` (call it at the start of the save transaction; report count)
- Modify: `src/pipeline/rules.ts` (`GapEvent` gains `name: string`; new gap)
- Modify: `src/pipeline/repo.ts:672` (fill `name`)
- Modify: `src/public/pipeline.js` (sync result line mentions merges)
- Test: `src/breeze-dedupe.test.ts` (DB tests in the same file or `src/breeze-sync.test.ts` — implementer's call), `src/rules.test.ts` or wherever `computeGaps` is tested

**Interfaces:**
- Consumes: `matchKey` (Task 2); `eventCalendarIds`, `resolveChecklist`, `applyChecklist`, `listRules`.
- Produces: `export async function mergeDuplicates(c: PoolClient, rules: ChecklistRule[], calendarOrder: string[]): Promise<number>` (number of events removed by merging). `SyncReport` gains `merged: number`.
- Produces: gap `{ key: "possible-duplicates", label: "Breeze events that look like duplicates", kind: "event" }`, listed after `no-checklist`.

Definitions:
- **Group:** non-archived events with `source = 'breeze'`, same `matchKey(name)` and same `start_date`, 2 or more of them.
- **Untouched event:** `notes = ''`, `image_url = ''`, `NOT breeze_kept`; every post on it has `rule_days_before IS NOT NULL`, `status = 'planned'`, `NOT due_edited`, `brief = ''`, `caption = ''`, `draft_id IS NULL`, and no `metricool_links` row; every graphic on it or its posts has `rule_days_before IS NOT NULL`, `status = 'needed'`, `NOT due_edited`, `file_link = ''`, `notes = ''`, `assignee_email = ''`. An event with no posts or graphics is untouched if the event fields above hold.
- **Merge (every event in the group untouched):** keep the oldest (`created_at`, then `id`); move all other events' links to it (series of moved series links get `merged_into` = the kept event's `breeze_event_id`); delete the other events' posts (explicitly — `content_items.event_id` is `ON DELETE SET NULL`) and then the events (their graphics cascade); delete the kept event's posts and graphics and re-apply rules with `resolveChecklist(rules, { calendarIds: await eventCalendarIds(...), name })` anchored on `anchor_date ?? start_date`, created by `"Breeze sync"`, then set `rule_days_before` exactly as `applyChecklist` already does.
- **Touched group:** leave every row alone.
- **Gap:** `computeGaps` lists every event in a group (same `matchKey(name)` + `startDate`, `source === "breeze"`, not archived) as `possible-duplicates`. After a successful merge the group no longer exists, so only touched groups show.

- [ ] **Step 1: Write failing tests**

```ts
test("untouched duplicates merge into the oldest with every calendar's rules", async () => {
  // Build the pre-fix state: two Breeze events, same name/date, cal 10 and cal 20, each with its own link + checklist from its own calendar rule.
  // Run sync with both copies in the feed.
  // → count("events") === 1; links 2; posts are exactly calendar 10's + calendar 20's items, once each; count("content_items") equals that number (no orphans); report.merged === 1.
});
test("a touched group is left alone and shown as possible duplicates", async () => {
  // Same setup, then updateContent one post's status to "drafted".
  // → after sync count("events") === 2, nothing deleted; computeGaps(...) possible-duplicates ids are both event ids.
});
test("cleanup is a no-op on the second run", async () => { /* merge, sync again → merged 0, posts unchanged (same ids) */ });
test("archived duplicates are not grouped", async () => { /* archive one → no merge, no gap */ });
test("computeGaps lists Breeze events with the same name and date", () => { /* pure: 3 GapEvents, two matching (different case/spaces) + one other date → ids of the two */ });
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `mergeDuplicates` and wire it as the first thing in the save transaction (before clusters are saved, so step 4/5 lookups find a single event). Add `name` to `GapEvent` and the gap. In `pipeline.js`, where the sync result is shown, add `merged` to the message (e.g. "Merged 3 duplicate events.") only when > 0. The existing event-gap rendering handles the new gap key; check the dashboard shows it.
- [ ] **Step 4: Full suite passes.**
- [ ] **Step 5: Commit** `feat(breeze): merge duplicate Breeze events nobody has touched; flag the rest`

---

### Task 6: Browser check and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-11-26-breeze-dedupe-design.md` (Deploy notes: mention `merged` in the sync message)

- [ ] **Step 1:** `npm run build`, copy `src/public` into `dist/public` if the build doesn't, start the app against the test DB with a fake Breeze returning one event on two calendars plus a pre-made duplicate pair; click "Sync now". Expected: the message mentions the merge; the event page badge lists both calendar names; the dashboard shows no possible-duplicates gap. Then make a touched duplicate pair and sync: the gap appears and links to both events.
- [ ] **Step 2:** Full suite passes.
- [ ] **Step 3: Commit** `docs: Breeze dedupe deploy notes`
