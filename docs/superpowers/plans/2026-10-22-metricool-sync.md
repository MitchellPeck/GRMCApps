# Metricool Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The pipeline calendar always matches Metricool, per platform: per-platform send times, changes made in Metricool synced back (moves, splits, caption edits, deletions, Metricool-only posts), and each platform's own published/scheduled/failed state.

**Architecture:** A new `metricool_links` table holds one row per (Metricool post, network) for each pipeline post. A sync job lists Metricool's planner, reconciles it against the links with pure functions (state, moves, text, gone, grouping by time), then applies the result per post in one transaction: update, split, or import. The send route writes links and syncs the post straight away. The page reads per-platform state from the links.

**Tech Stack:** TypeScript (CommonJS), Fastify 5, `pg`, idempotent DDL in `src/schema.ts`, `node --test` over `dist/*.test.js` with `TEST_DATABASE_URL`, plain-JS front end (`src/public/pipeline.js`, `src/public/metricool-modal.js`).

**Spec:** `docs/superpowers/specs/2026-10-22-metricool-sync-design.md`

## Global Constraints

- App: `apps/social-posts`. Run tests with `cd apps/social-posts && TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/socialposts npm test` (the `grmc-pipeline-test` container).
- Every route answers `{ ok: true, ... }` or `{ ok: false, error }` with HTTP 200.
- Network keys inside the app are the pipeline's: `facebook`, `instagram`, `x`. Metricool's `twitter` is mapped at the boundary (`metricool.ts`) and nowhere else.
- Times in links are the church's local wall time, `YYYY-MM-DDTHH:MM`, in the `default_timezone` setting (fallback `DEFAULT_TZ`).
- When Metricool's answer isn't understood (unknown status, unexpected shape, failed call), change nothing and write the reason to `publish_check`. Being stale beats being wrong.
- Running the sync twice in a row changes nothing the second time.
- A split or caption overwrite never discards brief, media, owner, event or the previous caption (old captions go to `post_drafts` via `logDraft`).
- Only planner posts dated on or after the setting `metricool_import_since` (set to the local date on the first sync) are imported.
- Copy, verbatim from the spec: "Already in Metricool. Change it there; it syncs back." · "Removed from Metricool on <date>." · "Split from <original title> on <date>" · "Check Metricool now" · "From Metricool".
- Schema changes are additive (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`). Back up the host DB before deploy.

## Review Focus

1. **A post whose date is outside the listed planner range** must not be marked `gone`: only a link whose `scheduled_for` date falls inside the range just listed can go missing. (Test in Task 3: `reconcile marks gone only inside the covered range`.)
2. **Daylight-saving and time zones:** Metricool may report UTC or another zone; a 09:00 post in America/New_York stays 09:00 across a DST change. (Test in Task 1: `planner times are normalised to the church's zone across DST`.)
3. **Metricool call fails or answers in an unexpected shape mid-run:** nothing changes for any post, and every touched post gets "Couldn't check Metricool: <reason>". (Test in Task 6: `a failed planner call changes nothing`.)
4. **A split where the moving group's network has no caption of its own** (shared caption): the new post gets the shared caption, mode `same`. (Test in Task 4: `split with a shared caption copies it`.)
5. **The same unlinked planner post seen on two runs** is imported once. (Test in Task 5: `import is idempotent`.)

---

### Task 0: See what Metricool really returns (probe on the host)

This task needs the owner: the build Mac has no Metricool credentials.

**Files:**
- Modify: `apps/social-posts/src/probe-metricool.ts`
- Create: `apps/social-posts/src/fixtures/metricool-planner-before.json`, `apps/social-posts/src/fixtures/metricool-planner-after-move.json`, `apps/social-posts/src/fixtures/metricool-planner-after-edit.json`

**Interfaces:**
- Produces: the three fixture files (raw `GET /v2/scheduler/posts` bodies, tokens removed), read by Task 1's tests.

- [ ] **Step 1: Add `--list <from> <to>`** to the probe: calls `GET {BASE}/v2/scheduler/posts` with the same query as `listSchedulerPosts` and prints the raw JSON body, unparsed. Also add `--list-raw-out <file>` to write it to a file.
- [ ] **Step 2: Build and typecheck:** `npx tsc --noEmit -p .` → no output.
- [ ] **Step 3: Owner runs on the host** (send these exact steps to the owner and wait):
  1. `docker compose exec social-posts node dist/probe-metricool.js --networks facebook,instagram --send` (creates a test post ~26 hours out; note the date).
  2. `... --list <date> <date> --list-raw-out /tmp/before.json`
  3. In Metricool, move **only Instagram** of that post by one day. Then `... --list <date> <date+1> --list-raw-out /tmp/after-move.json`.
  4. In Metricool, edit **only Facebook's** text of the post. Then `... --list <date> <date+1> --list-raw-out /tmp/after-edit.json`.
  5. Delete the test post(s) in Metricool. Copy the three files off the host (`docker compose cp`).
- [ ] **Step 4: Save them as the fixtures above**, with any token or personal email replaced by `REDACTED`. Write down in a comment at the top of `src/metricool-planner.ts` (Task 1) which split case happened: (a) the move made a new id, or (b) the same id carries a per-network date. Also note where text lives per network.
- [ ] **Step 5: Commit**

```bash
git add apps/social-posts/src/probe-metricool.ts apps/social-posts/src/fixtures
git commit -m "chore(social-posts): probe Metricool's planner list; record real payloads"
```

### Task 1: Read the planner into one shape

**Files:**
- Create: `apps/social-posts/src/metricool-planner.ts`, `apps/social-posts/src/metricool-planner.test.ts`
- Modify: `apps/social-posts/src/metricool.ts` (export `BASE`, `mcHeaders`; keep `listSchedulerPosts` for now)

**Interfaces:**
- Consumes: Task 0 fixtures.
- Produces:
  - `type LinkState = "draft" | "scheduled" | "published" | "failed" | "gone"`
  - `interface PlannerNetwork { network: "facebook" | "instagram" | "x"; scheduledFor: string; state: LinkState | "unknown"; detail: string; publicUrl: string; text: string }`
  - `interface PlannerPost { id: string; networks: PlannerNetwork[]; media: string[] }`
  - `parsePlanner(body: unknown, timezone: string): PlannerPost[]` (throws `Error("Metricool's planner list wasn't readable.")` on an unexpected top-level shape)
  - `mapState(status: string, publicUrl: string, autoPublish: boolean): LinkState | "unknown"` (published if `PUBLISHED` or a public URL; failed on `/ERROR|FAIL|REJECT/i`; draft when not auto-publishing; scheduled on `/PENDING|SCHEDULED|QUEUED|PROCESSING/i`; else `unknown`)
  - `listPlanner(c: MetricoolCreds, start: string, end: string, timezone: string): Promise<PlannerPost[]>`
  - `textHash(text: string): string` (sha1 hex of the text with `\r\n`→`\n` and trimmed)

- [ ] **Step 1: Write the failing tests** in `metricool-planner.test.ts`:
  - `parsePlanner reads the real before payload`: the test post appears once with networks `["facebook","instagram"]`, both `state: "scheduled"`, the same `scheduledFor` (the date/time from Task 0), and non-empty `text`.
  - `parsePlanner reads the real after-move payload`: Facebook and Instagram now have different `scheduledFor` values (in case (a), under two ids; in case (b), under one).
  - `mapState covers every status`: `("PUBLISHED","",true)`→`published`; `("PENDING","https://x",true)`→`published`; `("ERROR","",true)`→`failed`; `("PENDING","",false)`→`draft`; `("SCHEDULED","",true)`→`scheduled`; `("WHO KNOWS","",true)`→`unknown`.
  - `planner times are normalised to the church's zone across DST`: a row at `2026-11-01T13:00:00Z` with zone `America/New_York` gives `scheduledFor: "2026-11-01T08:00"`; one at `2026-10-31T13:00:00Z` gives `"2026-10-31T09:00"`. (If the fixtures show Metricool reports local time with its own zone field, assert that shape instead; the rule is "convert to the church's zone".)
  - `twitter becomes x`: a provider `{network:"twitter"}` parses as `network: "x"`.
- [ ] **Step 2: Run, expect FAIL** (`Cannot find module './metricool-planner'`).
- [ ] **Step 3: Implement** the interfaces above, reading fields where the fixtures put them. Drop providers whose network isn't one of the three (e.g. `google`).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(social-posts): read Metricool's planner per network`.

### Task 2: Links table, writing links, and the backfill

**Files:**
- Modify: `apps/social-posts/src/schema.ts`
- Create: `apps/social-posts/src/pipeline/metricool-links.ts`
- Test: `apps/social-posts/src/pipeline.test.ts` (new section `// ── Metricool links ──`)

**Interfaces:**
- Consumes: `LinkState`, `textHash` (Task 1).
- Produces:
  - DDL: table `metricool_links (content_item_id text REFERENCES content_items(id) ON DELETE CASCADE, metricool_post_id text, network text, scheduled_for text, state text CHECK (state IN ('draft','scheduled','published','failed','gone')), detail text DEFAULT '', public_url text DEFAULT '', text_hash text DEFAULT '', last_seen_at timestamptz, gone_at timestamptz, PRIMARY KEY (metricool_post_id, network))`, index on `content_item_id`; `content_items` columns `split_from text`, `split_at timestamptz`, `from_metricool boolean NOT NULL DEFAULT false`.
  - `interface Link { contentItemId; metricoolPostId; network; scheduledFor; state: LinkState; detail; publicUrl; textHash; goneAt: string | null }`
  - `linksFor(db, itemIds: string[]): Promise<Map<string, Link[]>>`
  - `addLinks(db, itemId: string, postId: string, networks: string[], scheduledFor: string, state: "draft" | "scheduled"): Promise<void>` (text_hash left empty: the first sync sets the baseline)
  - `hasLiveLinks(db, itemId): Promise<boolean>` (any state other than `gone`)
  - `backfillLinks(db, timezone): Promise<number>`, run once guarded by setting `metricool_links_backfill`; for each pipeline post with `metricool_sends` rows (`source_type='content'`, `status='sent'`, non-empty id), take the sends within 10 minutes of the newest (the rule `latestSends` uses today) and add a link per network (`twitter`→`x`), state `scheduled`, or `published` if the post's status is `published`.

- [ ] **Step 1: Failing tests:** `addLinks then linksFor returns one link per network`; `hasLiveLinks is false once every link is gone`; `backfill turns the latest send into links once` (two sends 1 hour apart: only the newer one's id is linked; a second `backfillLinks` call returns 0).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**; call `backfillLinks` from `index.ts` `start()` after `ensureSchema`, logging the count like the other one-time jobs.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(social-posts): link pipeline posts to Metricool posts per network`.

### Task 3: Decide what changed (pure)

**Files:**
- Create: `apps/social-posts/src/pipeline/metricool-reconcile.ts`, `apps/social-posts/src/metricool-reconcile.test.ts`

**Interfaces:**
- Consumes: `Link`, `PlannerPost`, `textHash`.
- Produces:
  - `interface LinkChange { link: Link; scheduledFor?: string; state?: LinkState; detail?: string; publicUrl?: string; text?: string; newHash?: string }` (`text` set only when the hash differs from a non-empty baseline; `newHash` set whenever the baseline is empty or changed)
  - `reconcileItem(links: Link[], planner: Map<string, PlannerPost>, covered: { from: string; to: string }): { changes: LinkChange[]; groups: Array<{ scheduledFor: string; networks: string[] }>; unknown: string[] }`
  - `overallStatus(states: LinkState[], goneDate: string): { status: "published" | "scheduled" | "ready"; note: string }`, exactly the spec's table: all published → published; published + gone only → published; any published with scheduled/draft/failed → scheduled; scheduled/draft and none published → scheduled; all failed → scheduled with note naming each failure (`"Metricool couldn't publish it: Instagram: <detail>"`); all gone → ready with `"Removed from Metricool on <goneDate>."`.
  - Rules inside `reconcileItem`: a `published` link never becomes `gone`; a link becomes `gone` only if its post id is absent and its `scheduledFor` date is within `covered`; an `unknown` state changes nothing for that link and adds the reason to `unknown`; groups are the non-gone links grouped by `scheduledFor`, sorted earliest first.

- [ ] **Step 1: Failing tests:** `a move of every network is one group at the new time`; `moving only Instagram makes two groups, earliest first`; `reconcile marks gone only inside the covered range`; `a published link never goes`; `an edited text is reported once and the baseline is set first`(empty baseline → only `newHash`, no `text`; second call with that hash and a different text → `text`); `unknown status changes nothing`; `overallStatus follows the table` (one assertion per row above).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** For case (a) (new id on a split), `reconcileItem` treats the original id's missing network as `gone` here; Task 5's guard turns it back into a split before anything is written.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(social-posts): decide Metricool changes per post`.

### Task 4: Split a post

**Files:**
- Modify: `apps/social-posts/src/pipeline/repo.ts`
- Test: `apps/social-posts/src/pipeline.test.ts` (section `// ── Splitting ──`)

**Interfaces:**
- Consumes: `metricool_links` (Task 2).
- Produces: `splitContent(db: Db, id: string, groups: Array<{ scheduledFor: string; networks: string[] }>): Promise<Result<{ kept: ContentRow; created: ContentRow[] }>>`. The first group stays on `id`; each other group gets a new `content_items` row copying title, event, brief, owner, drafting, source_ref, phase, no_media_needed, caption mode; platforms = the group's networks; caption = for `separate`, only those networks' captions (and if that leaves one network, keep mode `separate`); for `same`, the shared caption; `publish_date`/`publish_time` from `scheduledFor`; `split_from = id`, `split_at = now()`; status as the original's; `recurrence_id` null. Only `kind='attachment'` media rows are copied. The group's `metricool_links` rows move to the new post. The original's platforms shrink to its group; if it has a `recurrence_id`, set `detached = true`. All in one transaction.

- [ ] **Step 1: Failing tests:** `split moves the later group to a new post` (FB+IG at 09:00, IG moved to the next day: original keeps FB at 09:00, new post has IG next day, links follow); `split copies attachments, not gathering tasks`; `split with a shared caption copies it`; `split keeps each network's own caption`; `a recurring occurrence that splits is detached and the new post isn't recurring`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(social-posts): split a post when its platforms go at different times`.

### Task 5: Import Metricool-only posts, with the duplicate guard

**Files:**
- Create: `apps/social-posts/src/pipeline/metricool-import.ts`
- Test: `apps/social-posts/src/pipeline.test.ts` (section `// ── Metricool imports ──`)

**Interfaces:**
- Consumes: `PlannerPost`, `Link`, `addLinks`, `textHash`.
- Produces:
  - `findSplitOrigin(post: PlannerPost, vanished: Link[]): Link[] | null`: the links whose network set equals the post's networks and whose original post's text hash (or media list) matches, else null.
  - `importPlannerPost(db, post: PlannerPost, timezone: string): Promise<ContentRow>`: title = first line of the text cut to 80 characters (or "From Metricool"), no event, owner blank, `from_metricool = true`, platforms and date/time from the post (one post per distinct time, split as in Task 4 if needed), caption = the text (separate captions if the networks' texts differ), status from `overallStatus`, links added with the planner's state and `text_hash` baseline.
  - `shouldImport(post: PlannerPost, linkedIds: Set<string>, sentIds: Set<string>, importSince: string): boolean`: not linked, not in `metricool_sends.metricool_post_id`, and its earliest `scheduledFor` date ≥ `importSince`.

- [ ] **Step 1: Failing tests:** `a Metricool-only post is imported with its platforms, time and text`; `posts the app sent from any page are never imported`; `posts dated before import-since are never imported`; `import is idempotent`; `a split that made a new id is matched back to its post, not imported`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(social-posts): bring in posts made only in Metricool`.

### Task 6: The sync job

**Files:**
- Create: `apps/social-posts/src/pipeline/metricool-sync.ts`
- Modify: `apps/social-posts/src/pipeline/publish-check.ts` (keep only the hand-scheduled rule: unlinked Scheduled posts become Published once their time passes; delete the Metricool half and `latestSends`), `apps/social-posts/src/index.ts` (30-minute job runs `checkPublished` then `syncMetricool`), `apps/social-posts/src/routes/pipeline.ts` (`POST /api/pipeline/publish-check` runs both; new `POST /api/pipeline/content/:id/metricool-sync`)
- Test: `apps/social-posts/src/pipeline.test.ts` (section `// ── Metricool sync ──`, stubbing `listPlanner`'s fetch with Task 0 fixtures)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `syncMetricool(pool: Pool, o?: { itemId?: string; now?: Date }): Promise<{ moved: number; split: number; edited: number; gone: number; imported: number; published: number }>`. Steps per run: set `metricool_import_since` to today's local date if unset; covered range = 30 days back to max(linked date + 1 day, today + 90 days) (one post: its links' dates ±1 day, no imports); list the planner; per linked post, `reconcileItem`, then in one transaction: apply `changes` (text → caption or that network's caption, `logDraft` of the old one first; a shared caption that now differs per network switches to `separate`), then 1 group → set `publish_date`/`publish_time`, more → `splitContent`, then `overallStatus` → `status` and `publish_check`; with `findSplitOrigin` run on unlinked posts before any `gone` is written; then imports. A failed `listPlanner` writes "Couldn't check Metricool: <reason>" on every linked, not-published post in range and changes nothing else.

- [ ] **Step 1: Failing tests:** `syncing twice changes nothing the second time`; `a post moved in Metricool moves here`; `moving only Instagram splits the post` (using the after-move fixture); `a caption edited in Metricool replaces ours and keeps the old one in history` (after-edit fixture); `a deleted post goes back to Ready with a note`; `Facebook published and Instagram scheduled shows both` (post stays Scheduled; links say published/scheduled); `a failed planner call changes nothing`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole suite, expect PASS** (the old `checkPublished` Metricool tests are replaced by these; delete them).
- [ ] **Step 5: Commit** `feat(social-posts): sync changes made in Metricool back to the pipeline`.

### Task 7: Sending: per-platform times, links, no double sends

**Files:**
- Modify: `apps/social-posts/src/routes/metricool.ts`, `apps/social-posts/src/pipeline/sync.ts` (`markSentToMetricool`), `apps/social-posts/src/public/metricool-modal.js`
- Test: `apps/social-posts/src/pipeline.test.ts` (section `// ── Sending ──`), `apps/social-posts/src/metricool.test.ts`

**Interfaces:**
- Consumes: `addLinks`, `hasLiveLinks`, `splitContent`, `syncMetricool`.
- Produces:
  - `/api/metricool/send` body gains `networkTimes?: Record<string, string>` (network → `YYYY-MM-DDTHH:MM:SS`). The route groups networks by (text, time); each group is one Metricool post. With a `contentItemId`: refuse with `"Already in Metricool. Change it there; it syncs back."` when `hasLiveLinks`; after sending, if the times differ, `splitContent` by time first, then `addLinks` per group to the right post, then `syncMetricool(pool, { itemId })` for each (errors there are logged, never returned).
  - Modal: a "Different time per platform" checkbox revealing a date and time per ticked network (default: the shared date/time).

- [ ] **Step 1: Failing tests:** `sending with two times makes two posts and links each`; `a post already in Metricool can't be sent again`; `a post whose links are all gone can be sent again`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** route and modal (the modal's `sendGroups` already handles several sends; group by text and time).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(social-posts): send each platform at its own time`.

### Task 8: Show per-platform state

**Files:**
- Modify: `apps/social-posts/src/pipeline/repo.ts` (`ContentRow` gains `links: Array<{ network; state; scheduledFor; publicUrl; detail }>`, `splitFrom: { id; title; at } | null`, `fromMetricool: boolean`, loaded in `listContent`/`getContentRow` with one extra query keyed by the ids), `apps/social-posts/src/public/pipeline.js` (`agendaPost`, `boardCard`, the calendar chip in `renderCalendar`, the drawer), `apps/social-posts/src/public/pipeline.css`
- Test: `apps/social-posts/src/pipeline.test.ts` (`listContent returns each post's links`)

**Interfaces:**
- Consumes: Task 2 links; route from Task 6.
- Produces: UI only.

- [ ] **Step 1: Failing test:** `listContent returns each post's links` (a post with FB published and IG scheduled lists both, with the public URL on FB).
- [ ] **Step 2: Run, expect FAIL.** Then implement the repo change; run, expect PASS.
- [ ] **Step 3: UI:** chips and board cards show one mark per platform (✓ published, clock scheduled, "draft", red failed) using the existing `pl-s-*` colours; the drawer gets an "In Metricool" section (each platform: time, state, public link, error) with a **Check Metricool now** button calling `POST /api/pipeline/content/:id/metricool-sync`; when `links` has a non-gone row the drawer's Send button is replaced by "Already in Metricool. Change it there; it syncs back."; "Split from <original title> on <date>" links to the original; imported posts show a "From Metricool" tag.
- [ ] **Step 4: Check by hand:** the app's DB host is hard-coded to `postgres`, so start it with a `-r` preload that wraps `pg.Pool` to use `TEST_DATABASE_URL` (set `SOCIALPOSTS_DB_*` to anything, `SOCIALPOSTS_DATA_DIR` to a temp dir), send `x-auth-email` with requests, seed a post with mixed links, and look at calendar, board and drawer at desktop and 400px width.
- [ ] **Step 5: Commit** `feat(social-posts): show each platform's Metricool state`.
