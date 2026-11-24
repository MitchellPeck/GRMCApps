# Breeze Event Sync and Event Checklists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Events from chosen Breeze calendars flow into Social Posts, each arrives with a rule-made checklist of posts and graphics with due dates, and anything late or due soon shows as a gap and in a Monday/Thursday email.

**Architecture:** All in `apps/social-posts`. A Breeze client feeds a sync (every 3 h + "Sync now") that upserts `events` keyed by Breeze ids and tracks series in `breeze_series`. Checklist rules (calendar, then name; add/replace) are resolved once per new event into ordinary posts (`content_items`) and graphics (`media_assets` that may now belong to an event directly). Gaps and a digest email read those rows.

**Tech Stack:** TypeScript, Fastify 5, `pg`, Node's built-in `node:test` (compiled by `tsc`, run from `dist/`), vanilla JS client (`src/public/pipeline.js`), Resend via `gracenotes/mail.ts#sendMail`.

**Spec:** `docs/superpowers/specs/2026-11-24-breeze-event-sync-design.md`

## Global Constraints

- All paths below are relative to `apps/social-posts/` unless they start with `docs/`.
- Schema changes go in `src/schema.ts` as `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS` / `CREATE … INDEX IF NOT EXISTS`, appended after the existing statements. Boot runs them.
- Tests: `node:test` + `strict` assert, real Postgres via `process.env.TEST_DATABASE_URL`, each test file rebuilds the tables it touches in `before()` exactly as `src/pipeline.test.ts` does. Run all: `cd apps/social-posts && TEST_DATABASE_URL=$TEST_DATABASE_URL npm test`. Run one: `npx tsc && TEST_DATABASE_URL=$TEST_DATABASE_URL node --test dist/<name>.test.js`.
- Network is always injected as `fetchFn: FetchFn = fetch` (type from `src/gracenotes/mail.ts`); tests never hit Breeze or Resend.
- Breeze settings keys (in the `settings` table): `breeze_subdomain`, `breeze_api_key` (never returned by the API; view gets `hasBreeze` + `breezeSubdomain`), `breeze_calendars` (JSON array of calendar id strings), `breeze_default_owner` (email), `breeze_last_sync` (ISO), `digest_last_slot` (`YYYY-MM-DD`), `digest_last_sent_at` (ISO).
- Sync window: `today` through `addDays(today, 90)`. Sync interval: 3 hours. Digest: Monday and Thursday at 08:00 in the `default_timezone` setting (fallback `DEFAULT_TZ`), clock ticks every 15 minutes. "Due soon" = next 7 days. "No checklist" window = next 30 days. First digest after connecting lists new Breeze events only within the next 30 days.
- All Breeze-made events use `kind = 'event'` (never `'series'`).
- Rule-made graphics follow existing media rules unchanged: `resolveMediaStatus` (a gather date makes `needed` → `scheduled`), `DONE_MEDIA = ['captured','edited']`. No new media status.
- Nothing in this project deletes a post, a graphic or an event automatically.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `feat/breeze-sync`.
- Before deploying (not part of this plan): back up the host DB — `content_item_id` becomes nullable.

## Review Focus

1. **A Breeze outage or bad key mid-sync** — a failed calendar fetch must not flag that calendar's events "removed from Breeze". (Task 6 test `fetch failure flags nothing`.)
2. **Unticking a calendar** — its already-synced events must not be flagged missing; they just stop updating. (Task 6 test `unticked calendar flags nothing`.)
3. **Late-evening Breeze times** — `start_datetime` is church-local `YYYY-MM-DD HH:MM:SS`; the event date is its first 10 characters, never parsed through `Date` (an 11 pm event must not land on the next day). (Task 4 test `parseInstance keeps the local date`.)
4. **Repeated syncs after a date move** — due dates are recomputed from `rule_days_before`, so running the sync twice after a move doesn't shift twice, and a hand-edited date never moves. (Task 6 test `move shifts open items once`.)
5. **Name patterns with punctuation** — "VBS (Kids)" or "St. Mark's" match literally, case-insensitive, not as regex. (Task 5 test `name pattern is literal`.)

---

### Task 1: Graphic-type registry

**Files:**
- Create: `src/pipeline/graphic-types.ts`
- Modify: `src/routes/pipeline.ts` (`GET /api/pipeline/meta`, ~line 99)
- Test: `src/graphic-types.test.ts`

**Interfaces:**
- Produces: `interface GraphicType { key: string; label: string; width: number; height: number; usedFor: string; fields: string[] }`, `const GRAPHIC_TYPES: GraphicType[]`, `function graphicType(key: string): GraphicType | undefined`. Meta response gains `graphicTypes`.

- [ ] **Step 1: Write the failing test** — `registry keys are unique kebab-case`, `lower-third is 1920x280`, `ig-feed is 1080x1350`, `ig-story is 1080x1920`, `announcement-slide is 1920x1080`, `graphicType("nope") is undefined`.
- [ ] **Step 2: Run it** — FAIL, module not found.
- [ ] **Step 3: Implement.** Keys: `lower-third`, `announcement-slide`, `sermon-series`, `sermon-weekly`, `ig-feed`, `ig-story`, `fb-event-cover`, `grace-notes-banner`, `podcast-art`. Sizes not in the spec: `sermon-series`/`sermon-weekly` 1920×1080, `fb-event-cover` 1920×1005, `grace-notes-banner` 1200×400, `podcast-art` 3000×3000. `fields` lists event data a template would need (e.g. `["name","date","time","location"]`). Top-of-file comment: editing this file is how types change; the later renderer reads it. Add `graphicTypes: GRAPHIC_TYPES` to the meta payload.
- [ ] **Step 4: Run it** — PASS.
- [ ] **Step 5: Commit** — `feat(pipeline): graphic-type registry`.

### Task 2: Schema, and graphics that belong to an event

**Files:**
- Modify: `src/schema.ts`, `src/pipeline/repo.ts` (`MEDIA_SELECT`, `mediaOf`, `MediaRow`, `listMedia`, `createMedia`, `updateMedia`, `updateContent`, `getEvent`, `EventRow`/`eventOf`), `src/pipeline/rules.ts` (`MediaInput`, `parseMediaInput`)
- Test: `src/event-media.test.ts`

**Interfaces:**
- Produces (schema):
  - `events` + `source text NOT NULL DEFAULT 'manual'`, `breeze_event_id text`, `breeze_instance_id text`, `breeze_calendar_id text`, `breeze_missing_since timestamptz`, `synced_at timestamptz`, `anchor_date date`, `anchor_instance_id text`. Unique index `events_breeze_instance_idx ON events (breeze_instance_id) WHERE breeze_instance_id IS NOT NULL`; unique index `events_breeze_series_idx ON events (breeze_event_id) WHERE source = 'breeze' AND breeze_instance_id IS NULL`.
  - `breeze_series (breeze_event_id text PRIMARY KEY, name text NOT NULL, calendar_id text NOT NULL, mode text NOT NULL CHECK (mode IN ('series','each','ignore','single')), mode_source text NOT NULL DEFAULT 'auto' CHECK (mode_source IN ('auto','rule','user')), became_series_at timestamptz, first_seen_at timestamptz NOT NULL DEFAULT now())`.
  - `checklist_rules (id text PK DEFAULT gen_random_uuid()::text, match text NOT NULL CHECK (match IN ('calendar','name')), calendar_id text, name_pattern text NOT NULL DEFAULT '', effect text NOT NULL DEFAULT 'add' CHECK (effect IN ('add','replace')), repeat_mode text CHECK (repeat_mode IN ('series','each','ignore')), items jsonb NOT NULL DEFAULT '[]', position integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now())`.
  - `media_assets`: `ALTER COLUMN content_item_id DROP NOT NULL`; + `event_id text REFERENCES events(id) ON DELETE CASCADE`, `graphic_type text`, `rule_days_before integer`, `due_edited boolean NOT NULL DEFAULT false`; constraint `media_assets_owner_chk CHECK ((content_item_id IS NULL) <> (event_id IS NULL))` added via a `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = …) … $$` block; index on `event_id`.
  - `content_items` + `rule_days_before integer`, `due_edited boolean NOT NULL DEFAULT false`.
- Produces (code):
  - `MediaRow` gains `graphicType: string | null`, `ruleDaysBefore: number | null`, `dueEdited: boolean`, `onEvent: boolean`; `contentItemId: string | null`; `eventId` now `COALESCE(ma.event_id, ci.event_id)`.
  - `EventRow` gains `source: 'manual' | 'breeze'`, `breezeMissingSince: string | null`, `breezeCalendarId: string | null`, `anchorDate: string | null`.
  - `createEventMedia(db: Db, eventId: string, input: MediaInput): Promise<Result<{ media: MediaRow; warnings: string[] }>>`.
  - `MediaInput` + `graphicType?: string | null` (validated against `GRAPHIC_TYPES` keys); `graphicType` added to `MEDIA_COLUMNS`.
  - `getEvent` returns event-level media in `media` too.

- [ ] **Step 1: Write failing tests**
  - `event-level graphic is created with no post`: `createEventMedia(db, ev.id, { description: "FB cover", type: "graphic", graphicType: "fb-event-cover", gatherDate: "2026-12-01" })` → `ok`, `media.contentItemId === null`, `media.eventId === ev.id`, `media.onEvent === true`, `media.status === "scheduled"`.
  - `unknown graphicType is rejected`: `parseMediaInput({ description: "x", graphicType: "poster" }, "create")` → `ok: false`.
  - `listMedia by event includes event-level and post media` (one of each → length 2).
  - `listMedia with no filters still excludes attachments and includes event-level graphics`.
  - `listMedia({ contentItemId })` never returns event-level media.
  - `a row with both or neither owner is refused by the database` (raw INSERT throws).
  - `editing gatherDate sets due_edited; editing other fields doesn't`.
  - `editing a rule-made post's publishDate sets due_edited` (row inserted with `rule_days_before = 14`).
  - `deleting the event deletes its event-level graphics`.
  - `getEvent returns event-level graphics`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `MEDIA_SELECT` becomes `LEFT JOIN content_items ci ON ci.id = ma.content_item_id LEFT JOIN events e ON e.id = COALESCE(ma.event_id, ci.event_id)`. In `listMedia`: `eventId` filter uses `COALESCE(ma.event_id, ci.event_id)`; the not-cancelled clause becomes `(ci.id IS NULL OR ci.status <> 'cancelled')` and also excludes archived events for event-level rows (`(ma.event_id IS NULL OR NOT e.archived)`). `createEventMedia` mirrors `createMedia` minus attachments (always `kind 'collect'`, `type` defaults to `'graphic'`, `position` 0, `lateMediaWarning` not applied). `updateMedia`/`updateContent` set `due_edited = true` when the patch carries `gatherDate`/`publishDate`.
- [ ] **Step 4: Run this file and the whole suite** — PASS (existing pipeline, metricool and recurrence tests must still pass: they exercise post media through the changed `MEDIA_SELECT`).
- [ ] **Step 5: Commit** — `feat(pipeline): graphics can belong to an event; Breeze and checklist tables`.

### Task 3: Gaps

**Files:**
- Modify: `src/pipeline/rules.ts` (`GapMedia`, `computeGaps`, new `GapEvent`), `src/pipeline/repo.ts` (`dashboardGaps`)
- Test: `src/pipeline-rules.test.ts` (pure), `src/event-media.test.ts` (`dashboardGaps`)

**Interfaces:**
- Consumes: Task 2 `MediaRow` (`contentItemId` nullable, `onEvent`), `EventRow`.
- Produces: `GapMedia` = `{ id; contentItemId: string | null; gatherDate; status; itemPublishDate: string | null; itemStatus: ContentStatus | null; eventLive: boolean }`. `interface GapEvent { id: string; source: string; startDate: string | null; missing: boolean; archived: boolean; itemCount: number; graphicCount: number }`. `computeGaps(items, media, today, t, events: GapEvent[] = [])`. `Gap.kind` widens to `"content" | "media" | "event"`. `GAP_THRESHOLDS` + `dueSoonDays: 7`, `noChecklistDays: 30` in `config.ts`.

- [ ] **Step 1: Write failing tests** (pure, in `pipeline-rules.test.ts`):
  - `overdue-media includes an event-level graphic past its gather date` (`itemStatus: null, eventLive: true`).
  - `an event-level graphic on an archived or missing event is not a gap` (`eventLive: false`).
  - `due-soon lists posts not ready and graphics not done due within 7 days`; a `captured` graphic and a `ready` post are excluded; due today counts; due in 8 days doesn't.
  - `missing-from-breeze lists flagged events`.
  - `no-checklist lists Breeze events in the next 30 days with no posts and no graphics`; a manual event with none is not listed; one 31 days out is not listed.
  - existing `computeGaps` tests still pass with the extra argument defaulted.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** New gap keys and labels: `due-soon` "Posts and graphics due in the next 7 days", `missing-from-breeze` "Events removed from Breeze", `no-checklist` "Breeze events with nothing planned". Event-level media use `eventLive` where post media use `live(itemStatus)`; `unscheduled-media` and `late-media` skip event-level rows (no post date). `dashboardGaps` builds `GapEvent[]` with one query (counts of `content_items` and event-level `media_assets` per event).
- [ ] **Step 4: Run** — PASS, plus a `dashboardGaps` DB test in `event-media.test.ts` that an overdue event-level graphic appears under `overdue-media`.
- [ ] **Step 5: Commit** — `feat(pipeline): gaps for event graphics, due soon, Breeze flags`.

### Task 4: Breeze client and settings

**Files:**
- Create: `src/breeze.ts`, `src/fixtures/breeze-calendars.json`, `src/fixtures/breeze-events.json`
- Modify: `src/settings.ts` (`SettingsView` + `hasBreeze`, `breezeSubdomain`, `breezeCalendars: string[]`, `breezeDefaultOwner`), `src/routes/settings.ts` (save `breezeSubdomain`, `breezeKey`, `breezeDefaultOwner`; `breezeCalendars` array)
- Test: `src/breeze.test.ts`

**Interfaces:**
- Produces: `interface BreezeConfig { subdomain: string; apiKey: string }`, `interface BreezeCalendar { id: string; name: string }`, `interface BreezeInstance { instanceId: string; seriesId: string; name: string; calendarId: string; date: string; startRaw: string }`, `loadBreezeConfig(pool: Pool): Promise<BreezeConfig | null>`, `listCalendars(cfg, fetchFn?): Promise<BreezeCalendar[]>`, `listInstances(cfg, calendarId: string, from: string, to: string, fetchFn?): Promise<BreezeInstance[]>`, `parseInstance(raw: any): BreezeInstance`, `tickedCalendars(pool): Promise<string[]>`.

- [ ] **Step 1: Write failing tests** (fake `fetchFn` returning the fixtures):
  - `listCalendars calls /api/events/calendars/list with the Api-Key header` (assert URL `https://grmc.breezechms.com/api/events/calendars/list`, header `Api-Key`).
  - `listInstances passes start, end and category_id` and maps `{ id, event_id, name, category_id, start_datetime }`.
  - `parseInstance keeps the local date`: `start_datetime: "2026-12-06 23:30:00"` → `date === "2026-12-06"`.
  - `a non-200 reply throws an error naming Breeze and the status`, with the API key not in the message.
  - `settings view never returns the key` (`hasBreeze: true`, no `breeze_api_key` value anywhere in the JSON).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Fixtures: hand-written to the documented Breeze shapes (calendars: `[{ "id": "0", "name": "Main Calendar", … }]`; events: string ids, `event_id`, `category_id`, `start_datetime`/`end_datetime` as `YYYY-MM-DD HH:MM:SS`); confirm against the live API before deploy and replace with a recorded reply if fields differ. Use `limit=500` on `/events`. 10 s timeout. Settings page saves the key only when non-blank (as the other keys do); `breezeCalendars` is validated as an array of strings and stored as JSON.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(breeze): API client and settings`.

### Task 5: Checklist rules

**Files:**
- Create: `src/pipeline/checklist.ts` (pure: types, parsing, resolution), `src/pipeline/checklist-repo.ts` (rules CRUD, `applyChecklist`)
- Test: `src/checklist.test.ts`

**Interfaces:**
- Consumes: Task 1 `GRAPHIC_TYPES`; Task 2 schema; `createContent`, `createEventMedia`, `PLATFORMS`.
- Produces:
  - `type SeriesMode = "series" | "each" | "ignore" | "single"`.
  - `type ChecklistItem = { kind: "post"; title: string; platforms: string[]; daysBefore: number } | { kind: "graphic"; graphicType: string; daysBefore: number; forPost?: number }`.
  - `interface ChecklistRule { id: string; match: "calendar" | "name"; calendarId: string | null; namePattern: string; effect: "add" | "replace"; repeatMode: Exclude<SeriesMode, "single"> | null; items: ChecklistItem[]; position: number; active: boolean }`.
  - `parseRuleInput(raw: unknown, mode: "create" | "patch"): Result<Partial<ChecklistRule>>`.
  - `resolveChecklist(rules: ChecklistRule[], ev: { calendarId: string; name: string }): { items: ChecklistItem[]; repeatMode: Exclude<SeriesMode, "single"> | null }`.
  - `fillTitle(t: string, ev: { name: string; date: string }): string` — `{event}` → name, `{date}` → `formatMonthDayYear(date)`.
  - `listRules(db)`, `createRule(db, input)`, `updateRule(db, id, input)`, `deleteRule(db, id)` → `Result<ChecklistRule>` style as in `repo.ts`.
  - `applyChecklist(db: Db, eventId: string, items: ChecklistItem[], ev: { name: string; date: string; ownerEmail: string }, createdBy: string): Promise<{ posts: number; graphics: number }>`.

- [ ] **Step 1: Write failing tests**
  - `calendar rule then name rules in position order; add appends, replace replaces`.
  - `only active rules count`; `a calendar rule for another calendar doesn't match`.
  - `name pattern is literal`: pattern `"VBS (Kids)"` matches `"Summer vbs (kids) week"`, pattern `"St. Mark's"` doesn't match `"StX Mark's"`.
  - `forPost is rewritten to the resolved list`: calendar rule adds post A; name rule adds post B and a graphic with `forPost: 0` → resolved graphic's `forPost` points at B's index.
  - `forPost pointing at a replaced-away post is dropped (graphic goes on the event)`.
  - `repeatMode: the last matching rule that sets one wins` (name rule beats calendar rule).
  - `parseRuleInput rejects unknown platforms, unknown graphic types, negative or non-integer daysBefore, a name rule with a blank pattern, a calendar rule with no calendarId, forPost not pointing at a post item`.
  - DB: `applyChecklist creates planned posts and graphics with due dates`: event date `2026-12-20`, post `daysBefore 14` → `publish_date 2026-12-06`, `status 'planned'`, owner = event owner, `rule_days_before 14`; graphic `daysBefore 17` with `forPost` → `media_assets` on that post, `gather_date 2026-12-03`, `graphic_type` set, description = the type's label; graphic without `forPost` → on the event.
  - DB: `a rule-made post with its graphic attached is not a no-media gap`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Name match: `ev.name.toLowerCase().includes(pattern.toLowerCase())`. `applyChecklist` runs in one transaction (`BEGIN`/`COMMIT` on a pool client) and sets `rule_days_before` via an `UPDATE` after each create (keeping `createContent`/`createEventMedia` signatures unchanged). Note in `checklist.ts`: repeat mode follows stacking — the most specific (last) matching rule wins; update the spec's §3 step 1 sentence "the first matching rule that sets one" to "the last matching rule that sets one" in the same commit.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(pipeline): checklist rules`.

### Task 6: The sync

**Files:**
- Create: `src/pipeline/breeze-sync.ts`
- Test: `src/breeze-sync.test.ts`

**Interfaces:**
- Consumes: Task 4 `loadBreezeConfig`, `tickedCalendars`, `listInstances`; Task 5 `listRules`, `resolveChecklist`, `applyChecklist`; `createEvent`.
- Produces: `interface SyncReport { calendars: number; created: number; updated: number; shifted: number; flaggedMissing: number; cleared: number; becameSeries: number; failedCalendars: string[]; skipped?: "not-connected" | "no-calendars" }`, `syncBreeze(pool: Pool, today: string, fetchFn?: FetchFn): Promise<SyncReport>`, `setSeriesMode(db, breezeEventId: string, mode: Exclude<SeriesMode,"single">): Promise<Result<true>>`, `listSeries(db): Promise<Array<{ breezeEventId; name; calendarId; mode; modeSource; eventCount: number }>>`, `applyRulesToEvent(db, eventId): Promise<Result<{ posts: number; graphics: number }>>` (refuses if the event already has posts or graphics).

Per sync, per ticked calendar (instances grouped by `seriesId`):

1. Upsert `breeze_series`. New series: mode = `resolveChecklist(rules, …).repeatMode` (`mode_source 'rule'`) else `series` if >1 instance in window else `single` (`mode_source 'auto'`).
2. A `single` series (mode_source `auto`) now with >1 instance → mode `series`, `became_series_at = now()`; its event gets `breeze_instance_id = NULL` (re-keyed to the series), keeps checklist and anchor.
3. `ignore` → nothing. `single`/`each` → event per instance (find by `breeze_instance_id`). `series` → one event (find by `breeze_event_id`, `breeze_instance_id IS NULL`); `start_date` = earliest instance date ≥ today; `anchor_instance_id` = first instance seen.
4. New event: `createEvent` (kind `event`, owner = `breeze_default_owner`), set Breeze columns, `anchor_date` = its date, then `applyChecklist`. Existing: update `name`, `start_date`, `synced_at`, clear `breeze_missing_since`.
5. Move: if the anchor instance is in this fetch and its date ≠ `anchor_date`, set `anchor_date` and recompute open, not-`due_edited` rule-made items: posts not in (`scheduled`,`published`,`cancelled`) → `publish_date = date − rule_days_before`; graphics not in `DONE_MEDIA` → `gather_date = date − rule_days_before`.
6. Missing: only for calendars fetched successfully this run. An each/single event whose instance date is in the window and not returned, or a series event with no instance returned → `breeze_missing_since = now()` if null.
7. Store `breeze_last_sync`. Any per-calendar fetch error is caught, recorded in `failedCalendars`, and the next calendar continues.

- [ ] **Step 1: Write failing tests** (fake `fetchFn` keyed by `category_id`, fixed `today = "2026-12-01"`):
  - `new one-off creates one event with its checklist`.
  - `a second sync creates nothing new` (counts unchanged, `created: 0`).
  - `a weekly series becomes one event with one checklist` (4 instances → 1 event, `start_date` = next one).
  - `each mode makes one event per instance, each with a checklist`.
  - `ignore makes nothing`; `rule repeat_mode sets a new series' mode`; `setSeriesMode` to `each` then sync creates the per-instance events and leaves the series event alone.
  - `series start_date rolling forward shifts nothing` (anchor instance unchanged).
  - `move shifts open items once`: anchor moves 2026-12-20 → 2026-12-27; post `daysBefore 14` → `2026-12-13`; sync again → still `2026-12-13`; a `due_edited` post and a `published` post don't move.
  - `rename in Breeze renames the event`.
  - `single becomes series when a second instance appears`: no duplicate event, original event re-keyed, checklist kept, `became_series_at` set.
  - `a removed instance flags its event, a returning one clears it`; `one missing week doesn't flag a series event`.
  - `fetch failure flags nothing` (calendar returns 500 → `failedCalendars` lists it, no `breeze_missing_since` set).
  - `unticked calendar flags nothing` (previously synced events on it stay unflagged).
  - `not connected → skipped: "not-connected"`, no queries to Breeze.
  - `applyRulesToEvent works once on an empty event and refuses a second time`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** to the steps above.
- [ ] **Step 4: Run** — PASS, then the whole suite.
- [ ] **Step 5: Commit** — `feat(breeze): sync events and apply checklists`.

### Task 7: Reminder email

**Files:**
- Create: `src/pipeline/digest.ts`
- Test: `src/digest.test.ts`

**Interfaces:**
- Consumes: `sendMail`, `FetchFn` (`gracenotes/mail.ts`); `localDateIn`, `localTimeIn`, `weekdayOf`, `addDays` (`dates.ts`); Task 2/3 rows.
- Produces: `interface DigestLine { text: string; url: string }`, `interface Digest { to: string; overdue: DigestLine[]; dueSoon: DigestLine[]; newEvents: DigestLine[]; nowRepeating: DigestLine[]; removed: DigestLine[]; noChecklist: DigestLine[] }`, `digestSlot(now: { date: string; time: string }, lastSlot: string): string | null`, `buildDigests(db, today: string, since: string | null, baseUrl: string, defaultOwner: string): Promise<Digest[]>`, `digestText(d: Digest): { subject: string; text: string } | null`, `digestTick(pool: Pool, now?: Date, fetchFn?: FetchFn): Promise<{ sent: number; failed: number }>`.

- [ ] **Step 1: Write failing tests**
  - `digestSlot`: Monday 07:59 → null; Monday 08:00 → that date; Monday 08:00 with `lastSlot` = that date → null; Tuesday → null; Thursday 15:00 not yet sent → that date (late start still sends the same day); Friday after a missed Thursday → null.
  - `buildDigests` (DB): overdue post (publish date past, status `planned`) and overdue event graphic go under `overdue`; post due in 3 days under `dueSoon`; a post owned by B on an event owned by A goes to B; a post-attached graphic goes to the post's owner; an event-level graphic to the event owner; no owner → default owner; posts with no event are included; Breeze events created after `since` → `newEvents`; `since = null` → only those dated within 30 days; `became_series_at` after `since` → `nowRepeating`; flagged → `removed`; Breeze event in 30 days with nothing → `noChecklist`. Each line's `url` is `${baseUrl}/#event/<eventId>`; a post with no event links to `${baseUrl}/#calendar` (the client has no per-post route — `route()` in `public/pipeline.js` knows views `event/<id>`, `calendar`, …).
  - `digestText` returns null when every list is empty; otherwise a subject like `Social posts: 2 overdue, 3 due this week` and plain-text sections in the order overdue, due soon, new, now repeating, removed, nothing planned.
  - `digestTick` sends one email per owner with idempotency key `digest-<slot>-<email>`, sets `digest_last_slot` only when no send failed (a failure retries next tick), sets `digest_last_sent_at`, and does nothing when Resend isn't configured.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `since` = `digest_last_sent_at`. Overdue posts: `publish_date < today` and status not in `READY_STATUSES`/`cancelled`. Follow `gracenotes/clock.ts#tick` for timezone handling and Resend settings loading.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(pipeline): Monday/Thursday reminder email`.

### Task 8: Routes, wiring and the Claude connector

**Files:**
- Modify: `src/routes/pipeline.ts`, `src/index.ts`, `src/mcp.ts`
- Test: `src/breeze-routes.test.ts`, `src/mcp.test.ts`

**Interfaces:**
- Consumes: Tasks 4–7.
- Produces routes (all inside `guard`, same shapes as neighbours):
  - `GET /api/pipeline/breeze/calendars` → `{ ok, calendars: BreezeCalendar[], ticked: string[] }` (`ok:false` with Breeze's error if not connected).
  - `POST /api/pipeline/breeze/sync` → `{ ok, report: SyncReport }`.
  - `GET /api/pipeline/breeze/series` → `{ ok, series }`; `PATCH /api/pipeline/breeze/series/:id` `{ mode }`.
  - `GET/POST /api/pipeline/checklist-rules`, `PATCH/DELETE /api/pipeline/checklist-rules/:id`.
  - `POST /api/pipeline/events/:id/apply-rules` → `{ ok, posts, graphics }`.
  - `POST /api/pipeline/events/:id/media` → `createEventMedia`.
  - `POST /api/pipeline/digest/test` → builds and sends now to the signed-in user only (their own digest), ignoring the slot.
- Wiring in `index.ts`: `breezeSync` once at boot and every `3 * 60 * 60 * 1000` ms; `digestTick` once at boot and every `15 * 60 * 1000` ms; each wrapped like `graceNotesClock` (catch + log, never crash).
- MCP: `list_events` rows include `source`, `breezeMissingSince`; `list_media` description mentions graphics and its rows include event-level graphics with `eventId`, `graphicType`, `onEvent`.

- [ ] **Step 1: Write failing tests** — route tests using `app.inject` as `gracenotes-routes.test.ts` does: rule create → list → patch → delete round trip; invalid rule → `ok:false` with the parse error; series mode patch rejects `single`; apply-rules on an event with posts → `ok:false`; event media create returns `onEvent: true`. MCP: `list_media` returns an event-level graphic dated within 30 days.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole suite** — PASS.
- [ ] **Step 5: Commit** — `feat(breeze): routes, timers and connector fields`.

### Task 9: Screens

**Files:**
- Modify: `src/public/pipeline.js` (`renderSettings` ~line 2108, `renderEvent`, dashboard gap rendering), `src/public/pipeline.css`

**Interfaces:**
- Consumes: Task 8 routes; meta `graphicTypes`, `platforms`.

- [ ] **Step 1: Settings → Breeze section**: subdomain, API key (hint only, as the other keys), default owner, Save; when connected, the calendar list with tick boxes (saved via `/api/settings` `breezeCalendars`), "Sync now" showing the report in one line (e.g. "3 new, 1 updated, 1 removed from Breeze"), last sync time; "Send me a test reminder".
- [ ] **Step 2: Settings → Checklist rules**: list in position order; editor with calendar (select from ticked calendars) or name contains; add/replace; repeat default (none/series/each/ignore); items list — post (title with `{event}`/`{date}` hint, platform checkboxes, days before) or graphic (type select from registry, days before, "goes with" select of this rule's post items or "the event"); up/down reorder; active toggle.
- [ ] **Step 3: Settings → Repeating events**: series list with a series / each / ignore select per row.
- [ ] **Step 4: Event view**: a "From Breeze" badge with calendar name; a "Removed from Breeze" banner with Archive and Keep (Keep clears the flag via `PATCH /api/pipeline/events/:id` — add `breezeMissingSince: null` support to `parseEventInput`/`updateEvent`, with a test in `event-media.test.ts`); a Graphics section listing event-level graphics with the existing media editor (type select, due date labelled "Due", upload/Approvals, status) and "Add graphic"; an "Apply rules" button shown only when the event has no posts and no graphics.
- [ ] **Step 5: Dashboard**: the three new gaps render with the existing gap list (event gaps link to the event).
- [ ] **Step 6: Run it** — use the `run` skill to start the app against a local DB with a fake Breeze (point `breeze_subdomain` at a local stub or stub `fetch`), tick a calendar, add a rule, sync, and check: the event appears with its posts and graphics, the gap shows when a due date is past, Keep/Archive work. Screenshot each screen.
- [ ] **Step 7: Run the whole suite** — PASS.
- [ ] **Step 8: Commit** — `feat(pipeline): Breeze settings, checklist rules and event graphics screens`.

### Task 10: Memory and handoff notes

- [ ] **Step 1:** Add a "Deploy notes" section to the spec: back up the host DB first (nullable `content_item_id`, new tables); after deploy, enter the Breeze subdomain/key, tick calendars, set rules **before** the first sync matters (events synced with no rule get no checklist — use Apply rules); confirm fixture field names against the live API.
- [ ] **Step 2: Commit** — `docs: Breeze sync deploy notes`.
