# Narthex TV — one schedule decides what plays and whether the TV is on

## Why

Narthex TV has two scheduling systems today:

- **Schedule tab** (`schedule_entries`, `schedule.ts`) decides *which* playlist plays.
- **Operating hours** (`operating_hours`, `power.ts`, `hours.ts`, `hoursMode` setting) decides whether there is a picture at all. The power runner (`power-runner.ts`) fires the on/off power action at each boundary.

When nothing is scheduled, a **default playlist** plays. When there is no default either, a rendered **idle screen** shows.

The user wants a single scheduling component: schedule playlists, and the TV is on exactly when something is scheduled to play. They also want to put a media item on screen right now. The prompting case was testing an item that wasn't scheduled at that moment.

## The rule

> If there is something to play, the TV is on. If there is nothing, the TV is off.

"Something to play" means, in order of precedence:

1. **Emergency takeover** (existing `takeover.ts`, unchanged). It beats everything, including Play now.
2. **Play now** (new). One media item, looping, until someone clears it.
3. **An active schedule entry** (existing resolution in `resolveSchedule`).

When none of these applies, nothing plays and the TV is off. There is no fallback.

## Goals

- One place, the Schedule tab, plans when the TV is on and what it shows.
- Play now on any media item:
  - If the TV is on, the item replaces what is playing immediately (cut, don't wait out the current slide).
  - If the TV is off, it turns on and shows the item.
  - The item loops until someone clears it, with no timeout.
  - On clear, the screen returns to whatever the schedule says. If nothing is scheduled, the TV turns off.
- Power follows the same answer the player shows. The admin "On now" card, the browser player, `playout.py` and the power runner all agree, because they all derive it from `resolveNow` / `buildPlan`.

## Non-goals

- No change to the emergency takeover's behaviour or UI.
- No change to playlists, media ingest, screens, or the power *actions* themselves (Samsung pairing, Wake-on-LAN MAC, configured on/off commands, test buttons, power event log).
- No conversion of existing operating-hours windows into schedule entries.
- No Play now for whole playlists. The user asked for a media item.

## Anti-goals (would make this a failure even if it "works")

- The TV staying on all night because of an open-ended entry or a leftover fallback.
- The TV blinking off and on between two back-to-back or overlapping entries.
- The admin UI saying one thing while the TV does another.
- Play now surviving "Clear", or silently persisting after it's cleared.

## What gets removed

| Thing | Where | Fate |
|---|---|---|
| Operating hours grid | `operating_hours` table, `hours.ts` window CRUD, `/api/hours*` window routes, `hoursMode` setting, Settings UI "operating hours" section, `resolvePower`/`mergedSpans`/`DEFAULT_WINDOWS` in `power.ts` | Removed. The table can be left in place (DDL is idempotent, nothing reads it) or dropped. Builder's choice. |
| Default playlist | `defaultPlaylistId` setting, fallback in `resolveNow`, "default" pill and selector in the UI, `source: "default"` | Removed. |
| Idle screen | `idle.ts`, `/api/idle`, idle settings UI, `idleFrames` in `buildPlan`, idle fields in `plan.display` | Removed. The player's *offline* fallback mark (shown when it can't reach the server) is not the idle screen and stays. |
| "Until the next one starts" mode | `until_next` in `ScheduleMode`, its resolution branch, its validation, its UI copy | Removed. The user confirmed it isn't used. Delete any existing `until_next` rows on boot. |
| Window with no end | `mode === "window" && !endsAt` treated as open-ended | No longer allowed. A window requires `ends_at > starts_at`. Delete existing open-ended window rows on boot. |

Keep `power_events` and `recordPowerEvent`/`listPowerEvents`. They're the "why is it dark on Sunday morning?" answer. They currently live in `hours.ts`, so move them somewhere that survives.

## Power: derived from the schedule

`resolveNow` (or a new helper next to it) returns `power: { on, changesAt }` computed from the schedule rather than operating hours:

- `on` is true when a schedule entry is active, Play now is active, or the takeover is active.
- `changesAt` is when the schedule-only answer next flips: the end of the current *merged* stretch of covered time if on, or the start of the next covered stretch if off. Back-to-back or overlapping entries, including entries of different playlists, merge into one stretch so the TV doesn't power-cycle between them. This is the same merging idea as today's `mergedSpans`, applied to schedule occurrences (one-off windows plus recurring occurrences, respecting `enabled` and effective dates). Look ahead at least 8 days, as today.
- Play now and the takeover have no end time, so while either is active, `changesAt` reflects only the schedule.

**A scheduled entry with nothing playable still means on.** Power is a pure function of the schedule rows. It does not look at playlist contents. *(User's decision.)* Examples: an empty or archived playlist, every item disabled or still converting, every item outside its show dates. In these cases:

- **Fallback between entries:** when the winning entry's playlist is archived or has no playable frames, the next entry covering the same moment (by the existing priority/recency order) takes over, if there is one. *(My call.)*
- **Nothing playable at all:** if no covering entry has anything playable, the plan has `power.on = true` and empty frames. The browser player and `playout.py` show black. The browser player shows no idle overlay; it keeps only the offline-fallback mark for when it can't reach the server.
- **Admin warning:** the On now card shows a prominent warning: "Scheduled, but *Playlist X* has nothing to show." It must never say "Playing X" over a black screen.

`tickPower` keeps its structure (persisted `power_last_state`, first tick records without firing, misconfiguration logged as a power event). The only change is where `want` comes from: it now comes from that combined answer instead of `resolvePower(hoursMode, windows)`.

Play now and Clear should feel immediate. When either is set or cleared, run a power tick right away so nobody waits up to 30 s for the TV to wake or sleep. The player and `playout.py` already react to `plan.power.on` and to `sourceKey` changes on their next poll. `playout.py` already sends Wake-on-LAN on an off→on transition (`maybe_wake`).

**Behaviour change to call out in release notes:** today `hoursMode` defaults to `"always"`, so if operating hours were never switched on, the TV is currently always on. After this change, any time without a schedule entry is dark. Check the schedule covers the hours the narthex should be lit before deploying to the host.

## Play now

**State.** Store it in a settings key (e.g. `play_now`) as JSON `{ mediaId, startedAt, startedBy }`, parsed defensively the same way `parseTakeover` is: a malformed row means "no Play now". There is only one at a time, and starting another replaces it. If the media row is deleted or isn't `ready`, treat Play now as inactive. Clearing it is still allowed.

**API.**
- `GET /api/play-now`: current state, including the media title for the UI.
- `POST /api/play-now { mediaId }` requires the `schedule` permission (same as the takeover). It rejects media that isn't `ready`.
- `DELETE /api/play-now` requires the `schedule` permission.

**Plan.** In `buildPlan`, when Play now is active and there is no takeover, the frames are that one media item, built through the same `buildFrames` path a one-item playlist would use, so decks expand to their slides and video plays at natural length. Use app-default timing, fit and transition. The frames loop. Include the Play now in `sourceKey` (e.g. `PLAYNOW:<mediaId>:<startedAt>:`) so it cuts in at once and cuts out on clear. Show/hide date bounds (`show_from`/`show_until`) don't apply, because they belong to playlist items, not media.

Play now applies only at the real current time. The what-if preview (`GET /api/schedule/now?at=<future>`) ignores it and shows what the schedule alone will do, so layer it on in callers that use the current time rather than inside the shared at-time resolution. *(My call.)*

Add a `source: "play_now"` (and keep `"schedule"` / `"none"`) so the On now card can explain itself. The player's `playlistName` can be the media title.

## Admin UI

- **Media tab:** each ready item gets a **Play now** button, visible to users with schedule permission. Confirm only if a Play now is already active ("Replace X with Y?").
- **On now tab:**
  - When Play now is active, a banner at the top says "Playing now: *title*, started by *who* at *time*" with a **Clear** button. Model it on the existing takeover banner.
  - The status line explains the current state from one of: takeover / Play now / schedule entry (label, ends at) / "Off. Nothing scheduled." It also says when the TV next comes on or goes off (from `power.changesAt`). This replaces the operating-hours wording ("outside the narthex's opening hours") and the "standing default" line.
- **Schedule tab:** remove the "until the next one starts" option and its help text. A window requires an end time.
- **Settings tab:**
  - Remove the operating-hours section, the default playlist selector, and the idle screen editor.
  - Keep the power actions (on/off commands, Samsung, test buttons) and the power event log.
  - Relabel the action prompts from "When opening hours start/end" to "When the TV should turn on/off".

## Players

`plan.power.on` keeps its meaning and shape, so `player.js` and `playout.py` need no protocol change. Remove references to the idle fields in `plan.display` where the player reads them, keeping the offline-fallback mark. Change `playout.py`'s "(outside opening hours)" log wording to something like "(nothing scheduled)".

## Tests

Existing tests that cover removed behaviour are deleted or rewritten: `power.test.ts` (hours), `idle.test.ts`, the `until_next` cases in `schedule.test.ts`, and settings tests for removed keys. New coverage:

- Schedule-derived power: on/off and `changesAt` across a single window, recurring occurrences, back-to-back and overlapping entries (no gap), disabled entries, effective-date bounds, overnight recurring.
- Precedence: takeover > Play now > schedule > off. Clearing Play now returns to the schedule, or to off.
- `parsePlayNow` on malformed, missing, and non-ready media.
- `tickPower` fires "on" when Play now starts while off and "off" when it clears with nothing scheduled.
- Validation rejects `until_next` and windows without an end.

## Decisions

**User's decisions:**
- One schedule; media scheduled means on, nothing scheduled means off.
- Default playlist and idle screen go away.
- Play now is for a single media item, loops, and lasts until cleared manually.
- Play now overrides what's on and wakes the TV if it's off; Clear returns to the schedule or turns the TV off.
- `until_next` is removed (not used).
- An entry that's scheduled but has nothing playable still turns the TV on: the screen is black and On now shows a warning.

**My calls, which the user saw and approved:**
- Emergency takeover stays on top.
- Back-to-back entries count as one stretch.
- The power event log stays.
- Operating hours are dropped, not converted.
- Play now lives on the Media tab, with Clear on the On now tab.
- Play now requires the schedule permission, and only one runs at a time.
- Play now is ignored by the what-if preview of future times.
- A lower-priority covering entry takes over when the winner's playlist is archived or empty.

## Left to the builder

- Whether to drop or leave the `operating_hours` table and dead settings keys.
- Exact file layout (e.g. a `play-now.ts` beside `takeover.ts`; where power-event helpers move).
- Wording of UI copy beyond what's above.
