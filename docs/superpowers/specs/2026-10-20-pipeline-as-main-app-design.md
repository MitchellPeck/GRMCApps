# The Content Pipeline becomes the Social Posts app

Date: 2026-10-20 · Status: implemented

## Goal

`social.grmc.app` is one app: the Content Pipeline. The old Social Posts page
(Wednesday, Friday, Podcast, Series, Drafts and Settings tabs) is removed.
What those tabs did becomes **configuration on events, departments and
series**, so **Draft with Claude** on any post does what the matching run did,
for example pulling that week's Grace Notes issue from Mailchimp and drafting
from it.

**Success looks like:**

- Every job the old page did can be done in the pipeline: drafting Grace Notes,
  the Sunday invite, the weekly blog and podcast posts; planning a series;
  settings.
- Drafts for the weekly posts come out the same as today, because the prompts
  carry over word for word.
- A new kind of sourced post, such as another newsletter, needs configuration,
  not code.

## Decisions made

| Question | Decision |
| --- | --- |
| Where drafting configuration lives | A **profile** on each event, department or series, with **overrides** on recurring posts and single posts. |
| One source item, many posts (Podcast) | A **"Plan posts from an episode"** action on the event creates one post per angle. |
| The old page | **Removed in this change.** No `/classic` fallback. |
| How configurable | **Editable profiles seeded from today's runs.** Not fixed recipes, not placeholder templates. |
| The Saturday invite | Split into its own **Sunday worship** event with its own instructions. |

## 1. Drafting profiles

### Profile (on an event, department or series)

| Field | Meaning |
| --- | --- |
| `source` | `none`, `mailchimp`, or `buzzsprout` |
| `source.subjectContains` | Mailchimp only: campaigns whose subject contains this text (case-insensitive, "resend" excluded, as today) |
| `source.cutoff` | Mailchimp only: which issue to use. `latest`: the newest match (blog behaviour). `postDate`: the newest match created on or before the post's date. `followingSunday`: the newest match created on or before the Sunday on or after the post's date (exactly what the Wednesday run does with its Sunday date). |
| `context` | Background facts. It **is** the event's existing "notes and key messages" field (`events.notes`), not a second copy. |
| `instructions` | What each post should do, in plain English. |
| `angles` | Buzzsprout only: a list of `{ key, label, instructions, offsetDays }`, seeded from today's `podcast-angles.ts`. |

Storage: a `drafting` jsonb column on `events` holding
`{ source, instructions, angles }`; context stays in `events.notes`. The shape
is validated in `src/pipeline/drafting.ts`.

### Overrides (on a recurring post, or a single post)

`instructions` and/or `source`, stored as `drafting` jsonb on `recurrences` and
on `content_items`. A recurring post's override is copied onto each occurrence
it generates. Single-post edits to it detach that occurrence, as other template
fields already do.

The **effective profile** for a post is: the post's override, else its
recurrence's override, else the event's profile, else no source and generic
instructions. This is resolved in one pure function, `effectiveProfile()`.

### The house voice

`VOICE` moves from code into the `settings` table (`house_voice`), seeded with
today's text and editable in Settings. Platform caption guidance stays in
`config.ts`.

## 2. Drafting from the editor

- **Source panel.** When the effective profile has a source, the editor shows
  the item Draft with Claude will use, above the caption:
  - **Mailchimp:** chosen as today (the newest 30 campaigns, subject match,
    "resend" excluded, then the cutoff), showing subject, date line and
    archive link, with a **draft** marker
    when the campaign isn't sent (the same caption text `campaignSummary`
    produces today). **Change** lists recent matching campaigns.
  - **Buzzsprout:** the pinned episode, or a picker of recent episodes
    (unreleased ones marked, as today).
  - **"Use pasted content instead"** gives a text box and a URL box: the manual
    fallback the run forms have now.
- **Fetching** happens only when the panel opens or Draft is pressed. Failures
  (not configured, unreachable, no matching campaign) are shown in the panel
  with a link to Settings, and pasting by hand still works.
- **The post remembers its source item** in `content_items.source_ref` (jsonb:
  `{ kind, id, title, url, date }`, or `{ kind: "manual", url, content }`).
  Redrafting reuses it unless changed.
- **Prompt assembly** (`buildDraftPrompt()`, pure) combines:
  1. the house voice;
  2. the context (event notes);
  3. the instructions (effective);
  4. the post's title, brief and publish date;
  5. the source content: Mailchimp preview text and archive URL, or the
     episode's title, description, listen URL, duration and the not-yet-public
     note;
  6. the platform guidance for same or separate captions, X held to 280, as
     today.

  For the seeded Grace Notes profile, the prompt contains the Wednesday run's
  instruction text verbatim.
- **Draft history.** Every Draft with Claude result is written to `post_drafts`
  with a new `content_item_id` column. The editor lists "Earlier drafts" (time,
  first line) with **Restore**. This replaces the Drafts tab.

## 3. Planning, series and run data

### "Plan posts from an episode" (events whose source is Buzzsprout)

1. Pick an episode.
2. Tick angles from the profile; the "announcement" angle is ticked by default,
   as today.
3. **Create** makes one post per angle on episode date + `offsetDays`, titled
   `<angle label>: <episode title>`. Each is pinned to the episode
   (`source_ref`) with that angle's instructions as its override.
4. **Draft all** drafts each new post in turn. A failure stops nothing else and
   is reported per post.

### "Plan posts with Claude" (series events)

Number of posts, cadence and start date go in; Claude proposes
`{ date, phase, title, angle }` (today's `generateSeriesPostsWithClaude`
prompt). You edit the list, then **Save** creates content items with the angle
as the brief. A new `phase` text column on `content_items` holds the phase,
shown on the post.

### Existing series data

- Each series event's `notes` gains the series' `context` (appended, once).
- `series` and `series_posts` are kept but **no longer written to**:
  - `src/series.ts` and its routes are removed;
  - the series sync code in `sync.ts` (`applySeriesField`, `syncSeriesMeta`,
    `writeBackToSeries`) is removed;
  - the backfill stays, so a fresh database still imports old series once.

### The weekly runs, as profiles

| Event | Source | Instructions (seeded verbatim from `runs.ts`) |
| --- | --- | --- |
| Grace Notes (renamed from "Grace Notes & Sunday invite") | Mailchimp, subject contains "grace notes", cutoff `followingSunday` | the Wednesday post's instruction text |
| **Sunday worship** (new, department) | none | the Saturday invite's instruction text; the Sunday service notes go in each post's brief |
| Weekly blog | Mailchimp, subject contains "weekly blog", cutoff `latest` | the Friday instruction text |
| Podcast | Buzzsprout | per angle, from `podcast-angles.ts` |

The Saturday recurring post moves to Sunday worship, along with its untouched
future occurrences. Already-drafted Saturday posts keep their event.

## 4. Settings, removal, rollout

### Settings tab

Every field from the old Settings tab, plus the house voice:

- Anthropic key;
- Mailchimp key and server;
- Buzzsprout token and podcast (with "Load podcasts");
- Metricool token, user and brand (with "Load brands"), default time and
  timezone;
- R2 account, keys, bucket and public URL.

It uses the existing `/api/settings` API. Keys never return to the browser.

### Routing and removal

- `/` serves the pipeline page; `/pipeline` redirects to `/`.
- **Deleted:**
  - files: `index.html`, `app.js`, `app.css`, `runs.ts`, `series.ts`;
  - routes: `routes/drafts.ts`, `routes/series.ts`, `routes/mailchimp.ts`, the
    run route in `routes/podcast.ts`;
  - code: the run-only helpers in `schedule.ts` and `drafts.ts` that nothing
    else uses.
- **Kept:**
  - `mailchimp.ts`, `buzzsprout.ts` (with their tests), `claude.ts`;
  - `metricool*.ts`, `r2.ts`, `approvals-client.ts`;
  - `metricool-modal.js`, `/api/me`, `/api/settings`, the Metricool and
    Buzzsprout listing routes.
- Source lookups move to new pipeline routes:
  - `GET /api/pipeline/sources/campaigns?subject=…` and
    `GET /api/pipeline/sources/episodes` for the Change list;
  - `POST /api/pipeline/source/preview`, which takes the editor's state, saved
    or not, and returns the effective profile and the source item it resolves
    to.

### Migration (once on boot, flag `pipeline_drafting_v1`)

1. Add the columns: `events.drafting`, `recurrences.drafting`,
   `content_items.drafting`, `content_items.source_ref`, `content_items.phase`,
   `post_drafts.content_item_id`.
2. Seed the house voice setting.
3. Give run events their profiles. Create Sunday worship, and move the Saturday
   recurrence and its untouched future occurrences into it.
4. Append series context to series events' notes.
5. Copy the podcast angles into the Podcast profile.

It changes no post's dates, status or captions, and is idempotent behind the
flag.

### Testing

- **Unit:**
  - `effectiveProfile()` override order;
  - `buildDraftPrompt()` contains each run's wording for the seeded profiles;
  - campaign choice for each cutoff (`latest`, `postDate`, `followingSunday`);
  - angle offsets and titles;
  - profile validation.
- **Database:**
  - the migration on a pre-change copy (run events, Sunday worship split,
    series context, idempotence);
  - the override copy onto occurrences;
  - the draft-history log;
  - planning from an episode;
  - planning a series.
- **Drafting with the Claude call stubbed:** a Grace Notes post drafts from a
  stubbed campaign; a podcast plan creates and drafts N posts.
- **Browser** (the real image, with stand-ins for Mailchimp, Buzzsprout,
  Approvals and Claude): each old job done the new way; Settings round-trip;
  `/` is the pipeline; no console errors; phone width.

### Rollout

Back up the host database before pushing; boot runs the migration. There is no
old page to fall back to. Rolling back means redeploying the previous image,
which works because old tables are untouched and new columns are additive.

## Out of scope

- Automatic drafting on a schedule. The runs were always started by a person;
  so is Draft with Claude.
- Sources beyond Mailchimp and Buzzsprout.
- Deleting the old `series` and `series_posts` tables (a later cleanup).
