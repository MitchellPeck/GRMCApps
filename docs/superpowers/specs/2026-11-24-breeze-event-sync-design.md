# Breeze event sync and event checklists — design

Date: 2026-11-24
App: `apps/social-posts` (the content pipeline)

## Why

The hard part of getting a week's social content out is not forgetting
anything: an event goes by with no graphic made, or no post. The pipeline
already shows gaps, but only for posts and media someone has already entered.
Two misses are invisible to it today:

1. An event that is on the church calendar (Breeze) but was never entered in
   Social Posts.
2. A graphic nobody planned — nothing says a Facebook event needs a cover or a
   Sunday needs a slide.

This project closes both: events flow in from Breeze, each one arrives with a
checklist of the posts and graphics it needs (with due dates), unfinished items
show as gaps, and a reminder email brings them to the user instead of waiting
for the dashboard to be opened.

It is the first step of a larger plan (Social Posts as the hub; a graphic-type
registry; templated graphic rendering; an MCP tool to generate graphics; a
dashboard view). Only the pieces needed to stop forgetting are in scope here.

## Goals

- Events from a chosen few Breeze calendars appear in Social Posts on their
  own, without duplicates, and stay current when edited in Breeze.
- Each new event gets its checklist automatically, from rules set per Breeze
  calendar and per event-name match, editable per event afterwards.
- Repeating Breeze events: a choice per series — one checklist for the series,
  one per occurrence, or ignore.
- Every checklist item has a due date; anything late or coming due is a gap on
  the dashboard, in `find_gaps`, and in a twice-weekly email.
- A graphic-type registry exists in the repo as the shared reference.

## Non-goals (this project)

- Planning Center. Breeze only for now.
- Grace Notes as an event source.
- Rendering graphics from templates, a `generate_graphic` MCP tool, a file
  naming convention enforced on upload, a separate asset library. (Later
  projects; the registry is shaped so they can build on it.)
- Writing anything back to Breeze.

## Anti-goals

- Burying real events under noise: rehearsals, meetings, and 52 weekly copies
  of a Bible study must not flood the board. Unticked calendars are ignored;
  a new repeating series defaults to one checklist for the series.
- Losing work: a Breeze deletion or a rule change must never delete posts or
  graphics, and must never overwrite a checklist someone edited by hand.
- A second to-do list beside posts. Checklist posts are ordinary posts;
  checklist graphics are ordinary media items.

## Approaches considered

Every media item today belongs to a post (`media_assets.content_item_id NOT
NULL`). That doesn't fit graphics that aren't social posts (a Sunday slide, a
Facebook event cover).

- **A. Posts and media only.** Graphics with no real post sit under a
  placeholder post. Least code, but placeholders clutter the board and counts.
- **B. A new per-event checklist table** linking to posts/files once they
  exist. Cleanest model, but a second list beside posts, with its own screens,
  gap logic and connector tools, and keeping the two in step is where things
  get forgotten.
- **C. (Chosen.) Posts stay posts; graphics are media items that may belong to
  a post or directly to an event.** Reuses uploads, Approvals linking and the
  media status flow; the gap checker learns one new rule.

The user picked C.

## What the user decided

- Breeze only; only a few Breeze calendars count, chosen by the user.
- Which social channels and which graphic types an event needs, and when each
  is due, are set by rules **per calendar** and **per event name**, and can be
  changed **per event**.
- Repeating events: the choice (series / each occurrence / ignore) is made
  **per repeating series**.
- A reminder email that comes to them, Monday and Thursday, only when there's
  something to say.

## Design

### 1. Graphic-type registry

`src/pipeline/graphic-types.ts`, exported like `PLATFORMS` in `config.ts` and
served through `GET /api/pipeline/meta`. Each type:

```ts
interface GraphicType {
  key: string;          // "ig-feed"
  label: string;        // "Instagram feed post"
  width: number; height: number;
  usedFor: string;      // where it appears
  fields: string[];     // event data a template would need (for the later renderer)
}
```

Starting set: lower-third (1920×280), announcement slide (1920×1080), sermon
series graphic, weekly sermon graphic, IG feed (1080×1350), IG story
(1080×1920), Facebook event cover, Grace Notes banner, podcast episode art.
Sizes not given here are the builder's to fill in from each platform's current
spec. Editing the file is how types change.

### 2. Breeze connection

- Settings page gets a Breeze section: subdomain and API key (stored in the
  `settings` table like the Mailchimp/Metricool keys, shown as a hint, never
  echoed), and, once connected, the list of Breeze calendars with a tick box
  each. Ticked calendar ids are stored as a setting.
- Breeze API: `https://<subdomain>.breezechms.com/api`, `Api-Key` header.
  Calendars from `/events/calendars/list`; events from
  `/events?start=&end=&category_id=` (an instance has its own `id` and the
  series' `event_id`). Breeze rate-limits (about 20 requests/minute); one
  request per ticked calendar per sync is well inside that. The builder
  should confirm field names against the live API and keep a recorded
  fixture for tests, as the Metricool work did.

### 3. The sync

Runs every 3 hours (a `setInterval` in `index.ts` like the others) and from a
"Sync now" button. Window: today through 90 days ahead.

New tables/columns (written as `CREATE … IF NOT EXISTS` / `ALTER … ADD COLUMN
IF NOT EXISTS` in `schema.ts`, as the rest of the schema is):

- `breeze_series` — one row per Breeze `event_id` seen on a ticked calendar:
  `breeze_event_id` (pk), `name`, `calendar_id`, `mode` (`series` | `each` |
  `ignore` | `single`), `mode_source` (`auto` | `rule` | `user`),
  `first_seen_at`.
- `events` gains `source` (`manual` default | `breeze`),
  `breeze_event_id`, `breeze_instance_id`, `breeze_calendar_id`,
  `breeze_missing_since timestamptz` (null = present), `synced_at`,
  `anchor_date date` (the date the checklist is counted from).
  Unique on `breeze_instance_id` (each-occurrence events) and on
  `breeze_event_id` where it's a series-mode event, so nothing duplicates.

Per instance pulled:

1. Upsert its series in `breeze_series`. A new series gets its mode from the
   last matching rule that sets one, otherwise: `series` if the series has
   more than one instance in the window, else `single` (a one-off: an
   ordinary event, one checklist), both with `mode_source 'auto'`.
2. `ignore` → skip. `single` and `each` → one Social Posts event per instance,
   keyed by `breeze_instance_id`. `series` → one Social Posts event for the
   whole series, keyed by `breeze_event_id`; its `start_date` tracks the next
   occurrence. All Breeze events use kind `event` (not `series`: in this app
   `series` means a sermon series or standing run and brings "Plan posts with
   Claude", series-position drafting and exclusion from the dashboard's
   upcoming list). The `source`/Breeze columns distinguish them.
3. Creating an event applies the checklist (section 4) once, counted from
   `anchor_date` = the event's date (for a series, the first occurrence seen).
   Updating an existing one (rename, date move) updates name/dates. A
   **move** is only a change of the anchored instance's own date; a series
   event's `start_date` rolling forward to the next week is not a move, so a
   series checklist does not roll week to week (that is what `each` is for).
4. A `single` series whose second instance later appears (and whose mode is
   still `auto`) becomes `series`: its existing event is re-keyed to the
   series (`breeze_event_id`), keeps its checklist and anchor, and is listed
   in the next email as "now repeating — choose series / each / ignore".
   The mode decision is otherwise made once.
5. **Missing:** a single/each event whose instance is no longer returned (its
   date still inside the window), or a series event with no instances left
   in the window, gets `breeze_missing_since` set. One cancelled week of a
   series doesn't flag it. Flagged events show on the board and in the email
   ("removed from Breeze — cancel or keep?"), never deleted. If it reappears,
   the flag clears.

Changing a series' mode later: `ignore → series/each` creates what's missing
on the next sync; `series ↔ each` or `→ ignore` does not delete existing
events or their items (they can be archived by hand). Builder's call how to
present this in the UI.

Hand-made events (Sunday worship, Grace Notes, Weekly blog, Podcast and
others) are untouched. Breeze events get the default owner (setting:
"Default owner for synced events", defaulting to the user who connected
Breeze).

### 4. Checklist rules

Table `checklist_rules`: `id`, `match` (`calendar` | `name`), `calendar_id`,
`name_pattern` (case-insensitive "contains"), `effect` (`add` | `replace`),
`repeat_mode` (nullable: sets the default mode for a new series it matches),
`items jsonb`, `position`, `active`.

An item is one of:

```jsonc
{ "kind": "post", "title": "{event} — save the date", "platforms": ["instagram","facebook"], "daysBefore": 14 }
{ "kind": "graphic", "graphicType": "ig-feed", "daysBefore": 17, "forPost": 0 }
```

- `title` may use `{event}` and `{date}`.
- `forPost` (index of a post item in the same resolved list) attaches the
  graphic to that post as a "collect" media item; without it the graphic
  belongs to the event directly.

Resolution for an event: the calendar rule's items, then each matching name
rule in `position` order — `add` appends, `replace` replaces everything so
far. No matching rule → no checklist (the event still appears, so it isn't
missed).

Applying the checklist creates, once, at event creation:

- a **post** → an ordinary `content_items` row, status `planned`, the given
  platforms, `publish_date` = event date − `daysBefore`, owner = event owner.
- a **graphic** → a `media_assets` row: `type 'graphic'`, `graphic_type`,
  `kind 'collect'`, status `needed`, `gather_date` = event date −
  `daysBefore` (gather date acts as the graphic's due date), attached to its
  post or to the event.

Both get `rule_days_before` (the offset they were made with) and
`due_edited boolean`. When Breeze moves the anchored date (section 3), open
items whose due date wasn't edited by hand shift with it. Finished items
(posts scheduled/published/cancelled; graphics captured/edited) and
hand-edited dates don't move.

Graphic status follows the existing media rules unchanged: setting a gather
date moves `needed` to `scheduled` (`resolveMediaStatus`), so a rule-made
graphic starts as `scheduled`; `captured` and `edited` both count as done
(`DONE_MEDIA`). Removing a checklist item deletes it (a post can also be set
to cancelled, as today); graphics get no cancelled status.

Rules apply only at creation. Editing a rule never changes checklists already
made. Per event, the drawer shows the checklist (its posts and its graphics,
including event-level graphics) with add/remove and date editing — the per-event
override. An "Apply rules again" action on an event that has no checklist yet
(e.g. rules written after it synced) is in scope; re-applying over an
existing checklist is not.

Rules are edited on a settings page (pipeline settings): pick calendar or type
a name pattern, add/replace, repeat default, and the items list (post: title,
platforms, days before; graphic: type from the registry, days before, which
post it goes with). A "would match" preview listing upcoming synced events
the rule hits is the builder's call.

### 5. Graphics on events (approach C)

- `media_assets.content_item_id` becomes nullable; add `event_id text
  REFERENCES events(id) ON DELETE CASCADE` and `graphic_type text`. A check:
  exactly one of `content_item_id`, `event_id` is set.
- Existing media code that assumes a post (Metricool send ordering, attachment
  lists, the post editor's Media field, `list_media`, recurrence copying) must
  keep working for post media and simply not see event-level media where it
  doesn't apply. The event drawer gets a Graphics section using the same media
  editor (upload, Approvals pick, status).
- Graphic status uses the existing flow and rules (section 4); `captured`
  or `edited` is done. Approvals linking is how a graphic is marked approved,
  as today.

### 6. Gaps

`computeGaps` gains event-level media: a graphic belongs to an event that is
live (not archived, not `breeze_missing_since`) instead of a post. New and
changed gaps:

- **overdue-media** already covers "past its due date and not done"; it must
  include event-level graphics.
- **due-soon-media** (new): graphics not done whose `gather_date` falls
  within the next 7 days. (Posts due soon are already the "not ready" gap, so
  there is no separate posts list.)
- **missing-from-breeze** (new): synced events flagged as removed in Breeze.
- **no-checklist** (new): synced events in the next 30 days with no posts and
  no graphics — catches an event no rule covered.

The existing "no media planned" gap must not fire for a rule-made post whose
graphic is attached to it (that already holds) — builder confirms.

`find_gaps` and the dashboard pick these up through `dashboardGaps`.
`list_events` (MCP) adds `source` and the Breeze flags; `list_media` includes
event-level graphics with their `event_id` and `graphic_type`.

### 7. Reminder email

Monday and Thursday, 8:00 America/New_York (the app's `defaultTimezone`
setting governs), sent through Resend with the existing `sendMail`
(`gracenotes/mail.ts`) and an idempotency key per day + recipient. One email
per owner. An item's owner is the post's owner (posts) or the event's owner
(event-level graphics; a post's graphics follow the post); items with no owner
go to the default owner. It covers every event, hand-made or Breeze, and
posts with no event:

- overdue, limited to the last 30 days (posts past publish date not
  published/scheduled, so a Ready post that never went out counts; graphics
  past due not done)
- due in the next 7 days
- Breeze events added since the last email (the first email after connecting
  lists only those in the next 30 days), series that became repeating, and
  any flagged removed
- events with no checklist (cancelled posts don't count as planned)

Event-level lines (new, removed, no checklist) go to the event owner. Each line links to the item in the app (`publicBaseUrl`). Nothing to report →
no email. Last-sent time stored in `settings`. A "Send a test now" button on
settings. The clock follows the Grace Notes clock pattern (15-minute tick,
send once per due slot, retry a failed send on the next tick).

## Constraints

- Shipping is `docker compose build && push` from the build Mac; Watchtower
  restarts the host and boot runs the schema changes. Schema changes here
  (nullable `content_item_id`, new columns/tables) mean **back up the host DB
  before pushing**.
- Breeze API key lives in the DB `settings` table, not the repo.
- Tests use the existing Vitest setup and the test database the other
  pipeline tests use; Breeze is faked with recorded fixtures.

## Left to the builder

- Exact Breeze field names and pagination; how a "one-off" is detected.
- Sizes for registry types not given above.
- UI layout of the Breeze settings, the rules editor and the event checklist.
- Whether the mode-change UI warns about existing events.
- Exact email wording and layout (plain text, like the Grace Notes reminder).

## Deploy notes

- **Before pushing:** back up the host DB with `pg_dump` on the host. This
  release changes the schema: `media_assets.content_item_id` becomes nullable;
  new tables `breeze_series` and `checklist_rules`; new columns on `events`
  (including `breeze_kept`), on `media_assets` and on `content_items`.
- **Shipping:** `docker compose build && push` from the build Mac. Watchtower
  restarts the host, and boot runs the schema changes.
- **Settings → Breeze, after deploy:** enter the subdomain and API key, tick
  the calendars, and check the default owner.
- **Write checklist rules before the first sync.** Events synced with no
  matching rule get no checklist. If that happens, use "Apply rules" on the
  event afterwards. Then press "Sync now".
- **Fixtures:** `apps/social-posts/src/fixtures/breeze-*.json` are hand-written
  to Breeze's documented shapes. On the first sync, confirm the field names
  (`id`, `event_id`, `category_id`, `start_datetime`) against the live API. If
  the sync reports errors, record a real reply as a fixture.
- **Calendar names** are saved when calendars are ticked. Re-save the ticks
  once so outage messages can name the calendars.
- **Reminder email** needs Resend (`resend_api_key`, `mail_from`) and
  `public_base_url` already set. Use "Send me a test reminder" to check it.
- **Also on this branch, unrelated to Breeze:** the Metricool send popup now
  closes after a successful send. Posts can now be saved without a publish
  date; Scheduled and Published still need one.
