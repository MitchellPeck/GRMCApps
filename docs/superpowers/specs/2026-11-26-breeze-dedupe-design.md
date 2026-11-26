# Breeze sync: one event for copies on several calendars

Follow-on to `2026-11-24-breeze-event-sync-design.md`. Short design (small change).

## Why

The same event is often on more than one of the Breeze calendars that are ticked. Breeze gives each calendar's copy its own id, and the sync matches on that id only, so each copy became its own event with its own checklist. That doubles the posts and graphics to make and the lines in the reminder email, which is exactly the "forgetting things" noise the sync was built to remove. The live app already holds such duplicates; nobody has touched them.

## Goals

- One Social Posts event per real-world event, however many ticked calendars carry it.
- Its checklist comes from the rules of every calendar it's on (plus name rules), applied once.
- It's flagged "removed from Breeze" only when every copy has gone.
- Existing duplicates in the live app are merged automatically.

## Non-goals / anti-goals

- No fuzzy matching. "Christmas Eve" and "Christmas Eve Service" stay separate; a name tweak in Breeze is the fix.
- Never delete work the user did. A duplicate with any edit is left alone and shown, not merged.
- No ranking of calendars.

## Approaches

- **A. Merge copies into one event (chosen by the user).** Copies with the same name on the same date link to one event that knows all its calendars.
- B. Rank calendars and use only the top one's copy. Simpler, but only one calendar's rules apply, and deleting the top copy flags (then recreates) an event that's still on other calendars.
- C. Hide duplicates in the views. Rejected: duplicate checklists and email lines remain.

## Design

**What counts as the same event.** Same name after trimming, collapsing inner spaces and ignoring case, on the same date. For a repeating series (mode `series`), two Breeze series are the same if their names match and they share at least one date in the sync window.

**Links.** Every Breeze copy (series id and, for per-date events, instance id, plus its calendar) is recorded as a link to one app event. The existing per-event Breeze columns can stay as the first copy's; extra copies live in a links table (builder's call on the exact shape, as long as every lookup by Breeze id finds the event through any of its copies).

**Sync order changes.** Today each calendar is fetched and saved in its own transaction. To build one checklist from several calendars' rules at creation, the sync fetches all ticked calendars first, groups copies across calendars by the match key, then saves. A calendar that fails to read simply contributes no copies this run; its copies link on the next good run. Save stays in a transaction under the existing advisory lock.

**Checklist.** `resolveChecklist` takes a list of calendar ids instead of one. Calendar rules for each of them apply first (in the order the calendars are ticked), then name rules by position, as today. When a new copy links to an event that already exists (e.g. a calendar ticked later), its calendar's rules are not auto-applied; "Apply rules" on the event uses all linked calendars.

**Removed flag.** An event is flagged only when none of its copies were seen in calendars that were read in full this run; one missing copy is not enough. Keep and Archive work as today.

**Repeating series settings.** The series list shows one row per merged series. Changing its mode applies to all linked copies.

**One-time cleanup of existing duplicates.** On the first sync after deploy (and harmlessly on later ones), find groups of Breeze events with the same match key. If every event in the group and every checklist item on them is unedited since creation, keep the oldest event, link the others' Breeze copies to it, delete the extra events with their checklist items, and rebuild the kept event's checklist from all its calendars. If anything in a group was edited, leave the group as is and show it on the dashboard as possible duplicates, so the user decides.

## Left to the builder

- How "unedited since creation" is detected (e.g. `updated_at` against `created_at`, `due_edited`, status unchanged).
- Links table shape and indexes.
- Wording of the possible-duplicates dashboard line.

## Deploy notes

- Back up the host DB first (schema change, and the cleanup deletes duplicate events).
- After deploy, run "Sync now" once and check that each duplicated event now appears once.
- The Sync now message now mentions merges ("Merged N duplicate events."); that is the cleanup working, not an error.
- A post a rule made, then deleted by hand from an untouched duplicate, comes back when the merged event's checklist is rebuilt. Delete it again from the merged event.
- After the first sync, open the dashboard's "Breeze events that look like duplicates" tile. Those are groups someone had already worked on, so the sync left them alone: keep one and archive the others.
