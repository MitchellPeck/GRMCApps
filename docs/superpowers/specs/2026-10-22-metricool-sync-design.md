# Metricool sync — design

## Why

The pipeline's calendar is supposed to say what is going out, when, and
whether it went. Today it only half knows. A post is sent to Metricool once,
and from then on the app checks just one thing: has every network published?
Changes made in Metricool never come back. If someone moves Instagram to
Thursday in Metricool, the calendar still shows Tuesday for both. If Facebook
went out and Instagram failed, the post just says "Scheduled" with a note.
Posts made directly in Metricool don't appear at all.

The aim: **the calendar always matches Metricool**, per platform, without
anyone keeping the two in step by hand.

## Goals

1. **Per-platform dates from the app.** When sending, each platform can go at
   its own date and time.
2. **One post = one date and time.** A pipeline post holds the platforms that
   go out together. Platforms at different dates/times are different posts,
   edited separately, matching how Metricool treats a split post.
3. **Changes in Metricool come back,** on the existing 30-minute check and on a
   "Check Metricool now" button:
   - **Moved:** if every platform of a post moved together, the post's date and
     time move. If only some moved, the post **splits**: the original keeps the
     platforms that stayed, and a new post holds the ones that moved (see
     Splitting).
   - **Caption edited:** Metricool wins. The app's caption becomes Metricool's,
     and the old one goes into the post's draft history (`post_drafts`,
     restorable from the drawer as now).
   - **Deleted in Metricool:** the post goes back to Ready, with the note
     "Removed from Metricool on <date>." Nothing disappears silently.
   - **Made only in Metricool:** imported as a new post with no event, status
     Scheduled or Published, its text as the caption, and its platforms and
     date/time.
4. **Per-platform status.** Each platform of a post carries its own state:
   draft, scheduled, published (with its public link), or failed (with
   Metricool's reason). The post as a whole is Published only when every
   platform is. A post with some platforms out shows that, e.g.
   "Facebook ✓ published · Instagram scheduled", on the calendar chip, the
   board card and the drawer.

## Non-goals

- Recombining posts. If two split posts are moved back to the same time in
  Metricool, they stay two posts.
- Writing app edits back to Metricool. Changing a caption or date in the app
  after sending doesn't update Metricool (as today). The drawer says so on a
  sent post: "Already in Metricool. Change it there; it syncs back."
- Deleting anything in Metricool from the app.
- Analytics (likes, reach).

## Anti-goals (would make this a failure even if it technically works)

- **A sync that guesses wrong and rewrites a post.** When Metricool's answer
  isn't understood (an unknown status, an unrecognised shape, a failed call),
  the app changes nothing and records why in `publish_check`, as the current
  check does. Being stale is better than being wrong.
- **Duplicates.** A post the app sent must never also be imported as a
  Metricool-only post, and running the sync twice must change nothing the
  second time.
- **Losing work.** A split or a caption overwrite never discards the app's
  brief, media, owner, event or previous caption.

## Constraints

- The app is `apps/social-posts` (Fastify, `pg`, idempotent DDL in
  `src/schema.ts`, `node --test`). See the content pipeline design for the
  conventions; follow them.
- Metricool credentials live only on the host's database. The build Mac can't
  call the real API; anything learned about Metricool's live behaviour comes
  from running `probe-metricool` on the host (see
  [[grmcapps-host-migration]] in the project memory: scripts run by hand on the
  host).
- Deploy = push; Watchtower restarts the container and the schema runs on boot.
  Back up the host DB first.
- Today `metricool_sends` is a log. The current check maps a post to its
  Metricool ids through it, grouping sends within 10 minutes of the latest as
  "the current send". That stays readable for old posts; new links go in a
  proper table.

## What isn't known yet (Step 0, before building)

Metricool's public docs describe only creating posts. Two things the design
depends on must be observed against the live account first:

1. **The planner list's shape** (`GET /v2/scheduler/posts`): per post, where
   the date/time, text, media and per-network status, public link and error
   live; whether drafts appear; how far `extendedRange` reaches.
2. **What a split looks like.** Schedule one test post to Facebook and
   Instagram, move only Instagram in Metricool's UI, and list again. Either
   (a) the original id keeps Facebook and Instagram turns up under a **new
   id**, or (b) the **same id** carries a per-network date. Also edit a
   caption on one network only, to see whether that splits too.

Extend `probe-metricool.ts` with a `--list <from> <to>` mode that prints the
raw planner rows, run it on the host before and after those UI steps, and save
the payloads (with ids, but no tokens) as test fixtures. The sync is written
against those fixtures. The design below handles both (a) and (b); the probe
says which code path is real and which is dead.

## How

### Data

New table `metricool_links`: one row per platform of a post as Metricool
knows it.

| column | meaning |
| --- | --- |
| `content_item_id` | the pipeline post |
| `metricool_post_id` | Metricool's post id |
| `network` | `facebook`, `instagram` or `x` (the app's keys; Metricool's `twitter` is mapped) |
| `scheduled_for` | Metricool's date/time for this network, local to the church's time zone |
| `state` | `draft`, `scheduled`, `published`, `failed`, `gone` |
| `detail` | Metricool's error text when failed |
| `public_url` | the live post, once published |
| `text_hash` | hash of the text last seen, to spot edits made in Metricool |
| `last_seen_at` | when the sync last saw it |

Unique on `(metricool_post_id, network)`. The send route writes these rows
(it knows the networks, the id Metricool returned and the time). On first
boot, a one-time backfill turns existing `metricool_sends` rows for pipeline
posts into links, using the current "latest send" grouping, so posts already
in Metricool keep being tracked.

`content_items.status` stays as is: it's the post's overall state, derived
from its links whenever they change (all published → Published; otherwise
stays Scheduled; all gone → Ready). The per-platform state is read from the
links.

### Sending with different times

The send dialog gets a per-platform date and time (default: all the same, as
now, so the common case is unchanged). Each distinct date/time becomes its
own Metricool post. If the dialog's times differ, the app splits the pipeline
post the same way the sync does (below) before recording the links, so the
calendar shows the split straight away.

### The sync

`syncMetricool(pool)` replaces `checkPublished`'s Metricool half (posts marked
Scheduled by hand, with no links, still become Published when their time
passes, as now). Per run:

1. List the planner from 30 days back to the last linked date plus a margin
   (and up to 90 days ahead, for imports).
2. For each linked Metricool post, for each network:
   - **state:** map Metricool's status to `state` (unknown → leave as is and
     note it).
   - **moved:** a new date/time → update `scheduled_for`.
   - **text changed** (hash differs) → overwrite the caption (for separate
     captions, only that network's), logging the old one to draft history.
   - **missing** from the planner (and the range covered its date) → `gone`.
3. Group each post's links by `scheduled_for`. One group → set the post's
   `publish_date`/`publish_time` to it. Several groups → **split**.
4. Any planner post not linked to anything → **import**, unless the
   duplicate guard (below) says it's one of ours.
5. Recompute each touched post's overall status.

All writes for one post happen in one transaction. A Metricool call failing
changes nothing and notes "Couldn't check Metricool: <reason>" as now.

### Splitting

The group holding the earliest time stays on the original post (so its id,
URL and history stay put). Each other group becomes a new post that copies the
original's title, event, brief, owner, drafting settings, source and media
(the media rows are copied, not moved), takes only its platforms, that
group's caption (from separate captions, or the shared one), and the group's
date/time. Its links move to it. The original's platforms shrink to its own
group. The drawer of a split post says "Split from <original title> on
<date>" with a link back.

A recurring post that splits detaches the original occurrence (as any edit
does), and the new post isn't part of the recurrence.

### Import and the duplicate guard

A planner post becomes an import only if no link has its id. In case (a)
above, a split creates a **new** id in Metricool, which would otherwise look
like a Metricool-only post. The guard: a new id whose networks are exactly the
ones that just disappeared from a linked post, with the same text (or the
same media), is treated as that post's split, not an import. Imports land
with no event, owner blank, and a "From Metricool" marker so they're findable.

**Only posts scheduled from go-live onward are imported** (the owner's
decision). The first sync stores today's date as the setting
`metricool_import_since`; planner posts dated before it are never imported,
so nothing already in Metricool floods the calendar. Metricool drafts dated
after it are imported, as drafts.

### Showing it

- Calendar chip and board card: platform icons each marked published (✓),
  scheduled, draft or failed (red), instead of one status for all.
- Drawer: a "In Metricool" section listing each platform with its time,
  state, public link and any error, plus "Check Metricool now".
- The Board's columns still use the overall status.

### Decided after review (builder's calls, made by the designer)

- **Re-sending.** While a post has any link that isn't `gone`, the drawer's
  "Send to Metricool" is replaced by "Already in Metricool. Change it there;
  it syncs back." Once every link is gone (deleted in Metricool), sending is
  allowed again and makes fresh links. This is what keeps one post from
  tracking two Metricool posts, and an old Metricool post from coming back as
  an import.
- **Media on a split.** Only `attachment` rows (files on the post) are copied
  to the new post. `collect` rows (gathering tasks with assignees) stay on the
  original: the photos are gathered once and shared, so volunteers never see
  duplicate tasks.
- **Overall status, from the platforms' states:**

  | platforms | post status |
  | --- | --- |
  | all published | Published |
  | some published, the rest gone | Published |
  | some published, some still scheduled/draft/failed | Scheduled (the chip shows which are out) |
  | any scheduled or draft, none published | Scheduled |
  | all failed | Scheduled, note naming each failure |
  | all gone | Ready, note "Removed from Metricool on <date>" |

  A published platform never becomes `gone`: dropping out of the list (out of
  range, or deleted after it went out) doesn't undo publishing, and a
  Published post never goes back. A Metricool draft counts as scheduled for
  the post's status (as today) and shows as "draft" on its platform.
- **One-network edit of a shared caption.** If Metricool shows different text
  per network for a post with one shared caption, the post switches to
  separate captions: each network gets its Metricool text, and the old shared
  caption goes to draft history. Nothing splits for a text change.
- **Edit baseline.** The text Metricool reports is the baseline, never the
  text the app sent, so Metricool's own formatting never reads as an edit.
  To avoid missing an edit made before the first look, the send route syncs
  that post right after sending, which sets the baseline straight away.
  Backfilled posts take their baseline from the first sync after deploy (an
  edit made in Metricool before then is treated as the starting text, not as
  an edit).
- **Not imported:** any Metricool id in `metricool_sends` (sent from any page
  of the app, pipeline or not).

## Left to the builder

- Exact visuals for the per-platform marks (follow the existing status
  colours in `pipeline.css`).
- The import window and the "range covered its date" rule for `gone`, within
  the limits above.
- Whether "Check Metricool now" syncs one post or everything (one post is
  enough for the drawer; the 30-minute job does everything).
