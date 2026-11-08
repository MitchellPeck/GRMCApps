# Grace Notes in the social posts app — design

Date: 2026-11-05 · Status: draft for review

## Why

Mitchell now produces Grace Notes, GRMC's weekly Mailchimp email (example issue:
https://mailchi.mp/graceresurrection/grace-notes-weekly-update-10340823-okn0r8n881-10344999).
Each week he duplicates last week's campaign and edits it block by block. Content arrives
from roughly 6–8 recurring people (the senior pastor, event coordinators, the prayer
ministry director, NextGen, missions) by email, often at the last minute, and sometimes
only in hallway conversations on the same day. He has to remember who still owes him
what, dig each piece out of email, fix the pastor's letter for grammar and accuracy,
and make graphics for new events.

The social posts app (`apps/social-posts`) already holds GRMC's events and social
pipeline. Today it reads Grace Notes only as source material for drafting posts
(`src/mailchimp.ts`, `src/pipeline/sources.ts`). This project reverses that: content is
collected once, in the app, and feeds both the email and social.

**Success:** on Tuesday afternoon Mitchell opens one page and sees that everyone has
confirmed or changed their piece. He reviews the pastor's letter with suggested fixes,
then builds the email by copying each block in order into the duplicated Mailchimp
draft. No email digging, and no remembering who to chase.

## Goals

1. Each contributor has **one permanent link** with no login. It shows their piece(s)
   for the upcoming issue (confirm in one tap, or edit) and their pieces from past
   issues. They can add something new from the same page.
2. Mitchell has a **people list**: add, edit or retire contributors and say which
   sections each one owns.
3. A **weekly issue** is created automatically, with every piece copied from last
   week's. The contributor confirms it as is, edits it, or drops it.
4. **Automatic reminders** by email on a fixed schedule, plus a manual "nudge" button
   for each person.
5. **Pastor's letter review:** Claude suggests grammar fixes and flags factual mismatches
   with the issue's own data (names, dates, event titles). Mitchell accepts or rejects
   each suggestion.
6. A **ready-to-paste sheet** in the same order as the email. Each block has a Copy
   button that keeps formatting, unchanged blocks are marked "same as last week," and
   event images can be downloaded.
7. **Shared with social:** event pieces are the app's existing `events`. Anything new a
   contributor submits is clearly flagged in the social posts app ("New from Women of
   Grace · needs graphic"). Grace at a Glance is generated from event dates.

## Non-goals

- **Writing into Mailchimp.** The Grace Notes campaign is built in Mailchimp's new
  drag-and-drop builder (the archive HTML has `mceText`/`data-block-id` markers, and no
  `mc:edit` regions). The API can't fill individual blocks in that builder, and
  replacing the whole HTML would turn the campaign into code-only. Mitchell keeps
  duplicating the campaign, pasting the blocks in, sending the preview and scheduling
  the send himself.
- **Automating anything on social.** A new submission creates no posts and no drafts.
- **Making graphics.** Mitchell makes them in his existing Claude design artifact and
  uploads the finished image.
- **Contributor accounts or logins.**

## Anti-goals (it would count as failure even if it technically worked)

- Contributors find it harder than sending an email. The link has to work on a phone
  in under a minute, with no instructions.
- The prayer list or anyone's piece is visible to people who shouldn't see it.
- Mitchell has to keep two lists of events (one for social, one for Grace Notes).
- Claude rewrites the pastor's voice. It suggests, the suggestions are small, and
  nothing changes without Mitchell accepting it.
- Pasted text needs cleanup in Mailchimp (lost links, lost bold, broken line breaks).

## Weekly rhythm (agreed)

The email sends **Wednesday at 6pm**, and the preview goes out **before noon Wednesday**.

| When | What happens |
|---|---|
| Sunday evening | The app creates next week's issue. Every piece is copied from last week's, and recurring dates move forward. |
| Monday morning | Automatic reminder to every contributor with their link: "Grace Notes goes out Wednesday. Check your piece by Tuesday noon." |
| Tuesday noon | Deadline. Anyone who hasn't confirmed or edited gets one more automatic nudge and is flagged on Mitchell's page. |
| Tuesday afternoon | Mitchell reviews the pastor's letter and builds the email from the paste sheet. |
| Wednesday | Preview before noon, send at 6pm (in Mailchimp, by hand). |

Times are configurable settings. Mitchell agreed to the times above.

## The pieces

### Sections (the email's skeleton)

An ordered list matching the email, taken from the Nov 4 issue: pastor's letter ·
Sunday sermon · Grace at a Glance · weekly schedule · featured events · Bible study ·
outreach & missions · Grace Cares (prayer list) · NextGen · Sunday School · Listen/Read/
Connect · giving · (masthead, social links and footer stay in the Mailchimp template and
are out of scope).

Each section has one or more owners (contributors, or Mitchell) and a kind:
- **text** (letter, prayer list, NextGen…): one rich-text body per issue.
- **events** (featured events, Bible study, outreach): a list of event items, each one
  backed by an `events` row.
- **generated** (Grace at a Glance): built from **every dated event** in the app
  (`events` rows with a `start_date`, not archived) in the next ~4 weeks, whether or
  not it has a Grace Notes item. Nobody types it. Mitchell decided this.

**Ownership (my call):** a section owner owns that section's text piece. Each event item
has its own owner: whoever submitted it, or the contributor Mitchell assigns. A
contributor's page shows the text sections they own plus the event items they own.
Reminders and the status strip work per person, across everything they own.

Mitchell can reorder, add or retire sections, because the email will change over time.

### Contributors

Each contributor has a name, an email, the sections they own, and a permanent link token.
Retiring someone revokes the link. Mitchell can edit any piece himself, for example
typing in a hallway update for someone, and the change shows on that person's page.

### Issues and pieces

An issue is one Wednesday's email: its date and status (collecting → assembling → sent).
A piece is one section's content (or one event item) in one issue, with a status:
*carried over* (copied, not yet confirmed) · *confirmed* · *changed* · *dropped* ·
*new*. History is the earlier issues' pieces, read-only.

### Contributor page (layout A, chosen)

On a phone, top to bottom:
1. "Next issue · Wed Nov 11 · please check by Tue noon"
2. Each of their pieces, showing what will appear in the email (text and image), with
   **Looks right** and **Change something**. Event items also get **Drop it**.
3. **+ Add something new for this issue** (for an event: title, date/time, place, cost,
   registration link, contact, description, optional image).
4. **Earlier issues**: a short list (date + title), expandable to show what ran.

It shows only that contributor's own sections, and the page includes no other names.

### Mitchell's issue page

- A status strip for each contributor (confirmed / changed / outstanding / new
  submission), with a **Nudge** button and the time of the last reminder.
- **Pastor's letter review:** Claude's suggestions shown inline, each one accept/reject.
  The final text is what goes to the paste sheet. Accuracy checks compare against this
  issue's events, sermon block and the previous issue (for example the Nov 4 letter said
  "Commitment Sunday" where the calendar said "Stewardship Sunday").
- **Paste sheet:** the sections in email order. Each one shows its final content, a
  **Copy** button (puts `text/html` *and* `text/plain` on the clipboard so links, bold
  and line breaks survive a paste into a Mailchimp text block), a "same as last week ·
  skip" badge when nothing changed, and **Download image** for event graphics.
- **Mark sent** closes the issue and puts its pieces into history.

### Social posts integration

- Event items in Grace Notes **are** rows in the existing `events` table, plus the extra
  fields the email needs (time, place, cost, registration link, contact, blurb, image).
  An event created on the social side can be added to an issue, and an event submitted
  by a contributor appears on the social side.
- Not every Grace Notes item has to be a social event. One-off dated items (CPR
  Training, Art of Grace, Hanging of the Greens) are backed by an `events` row.
  Ongoing items (the Tuesday Bible study, Nursery) can stay Grace Notes-only, so the
  social board doesn't fill with weekly clutter. An item can be linked to an event
  later. (My call, refining "event items are rows in `events`" above.)
- A contributor's edit to a shared event takes effect immediately and shows the same
  marker, **"Changed by {contributor} · review"** (my call; nothing is staged).
- A contributor's new submission shows a visible **"New from {contributor} · needs
  review"** marker in the social posts app (for example on the events list and the
  board), with **needs graphic** while there's no image. Mitchell clears it once he has
  checked it.
- One image per event, uploaded once (to R2, like the existing media uploads), used in
  the email paste sheet and available to social posts.
- No posts are created automatically.

### Reminders

Email through Resend, following the pattern in `apps/expenses/src/mailer.ts`
(key + from address in settings, idempotent sends). Each reminder includes the person's
link and what's needed. Reminders are logged so the issue page can show "reminded Mon
8:00." If mail isn't configured, the page says so and the Nudge button offers
"copy link" instead.

## First issue and go-live

Mitchell decided: **build the whole thing**, with no reduced first version and no Nov 11 deadline.

The first issue has nothing to copy from. **My call:** a one-time setup screen where
Mitchell creates the sections in order, assigns owners, and pastes each section's current
content from the latest Mailchimp email. Event items get added like new submissions.
After that, every issue is copied from the one before. Parsing the drag-and-drop HTML
automatically is not worth building for a one-time job.

## Constraints

- Lives in `apps/social-posts`: same database, same app, same Mitchell-facing UI style
  (`shared/ui`).
- Mitchell's pages stay behind the hub login (Traefik `hub-forward-auth`).
- Contributor pages need a **non-gated path** with the token in the URL as the
  credential. This is the same pattern as `/ical/<token>/` and `/mcp/<token>` in
  `docker-compose.yml`: a longer-prefix router that skips forward-auth, and the app
  checks the token. Tokens are long and random, and only revocation changes them.
- Schema changes are additive (`CREATE TABLE IF NOT EXISTS` / `ALTER … ADD COLUMN IF NOT
  EXISTS` in `src/schema.ts`). Take a **DB backup before deploy**, as for every recent
  rollout.
- Dates are plain calendar dates in the church's timezone (`default_timezone`), the same
  as the rest of the pipeline.
- Claude calls use the existing Anthropic key and `src/claude.ts`.

## Left to the builder

- Table and column names, and whether event-only fields live on `events` or in a side
  table.
- How "carried over" detects that a piece is unchanged (content hash is fine).
- The rich-text editor on the contributor page. It should be simple: bold, italic, links,
  line breaks, lists. Nothing that produces markup Mailchimp mangles.
- Rolling recurring dates forward ("Sundays at 5pm" stays as is; "Nov 19" stays until
  the event passes, then the item drops off). Use sensible rules and show what was
  rolled.
- Exact prompt for the letter review, as long as it suggests rather than rewrites and
  cites the source of each factual flag.
- Image sizing for the email download (Mailchimp's content width is ~600px; offer a
  2× version).

## Calls made without explicit sign-off (please check)

- Reminders are automatic (Mitchell said "looks good" to the schedule, and the
  auto-vs-manual question wasn't answered directly).
- Sunday-evening issue creation, Monday-morning reminder, Tuesday-noon deadline.
- One image per event, shared by the email and social.
- Grace at a Glance looks ~4 weeks ahead.
- Ownership: each event item has its own owner; sections can have several owners.
- Contributor edits to shared events go live with a "Changed by" review marker.
- Ongoing items (weekly Bible study, Nursery) don't have to become social events.
- The first issue is loaded by hand on a setup screen, not parsed from Mailchimp.
- Masthead, social links and footer are left to the Mailchimp template.
