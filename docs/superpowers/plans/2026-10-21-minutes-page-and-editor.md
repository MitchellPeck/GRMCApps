# Meeting Page Redesign and Minutes Editor Implementation Plan (plan 4 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The meeting page becomes short sections behind a left side menu, and the Minutes section is where the report is edited in place (saved as you go), with ▶ on every part and room for plan 5's chat beside it.

**Architecture:** Keep every existing element id and render function — they are wired into polling, the recorder and the summary flow. `renderDetail` wraps today's blocks in `<section data-sec="…">` panels inside a two-column shell; the menu toggles `hidden`, so nothing is re-rendered on a switch and a recording is never disturbed. The editor treats the report as **lines**: each non-blank Markdown line is a block shown rendered; clicking a block swaps in a textarea holding that line's text **without its range marker**; on blur the text (possibly several lines) replaces the line, the marker is re-attached to its first line, and a debounced `PUT /api/meetings/:id/report` saves.

**Tech Stack:** vanilla JS (`src/public/app.js`), CSS (`src/public/app.css`), jsdom tests in `src/modal.test.ts`.

**Spec:** `docs/superpowers/specs/2026-10-21-meeting-minutes-live-edit-design.md` — Goal 8 (shorter page) and the Minutes-section layout (Layout A) of "What we're building"; plan 1 already built saving, ▶ and export.

## Global Constraints

- Menu entries, in order: **Details, People, Agenda** (each topic listed under it, numbered), **Recording, Speakers, Minutes**. Every existing capability stays; this only rearranges.
  - Details: header, edit details. People: attendees + guests. Agenda: agenda upload + add item + the topics list. Recording: meeting recording card. Speakers: meeting-wide speaker panel + "Fix a name or word". Minutes: report controls + editor + `#chat-panel` (empty `<aside>` for plan 5, hidden while empty).
- Opens on **Minutes** when a report exists, else **Details** when there are no agenda items, else **Agenda**. The choice persists while the meeting stays open (re-renders keep the current section).
- Clicking a topic in the menu shows Agenda with **only that topic** (others hidden), opened (which, while recording, lays down its topic marker as today). Clicking "Agenda" shows all topics.
- Status hints in the menu: People count (present + guests), "N unnamed" on Speakers when meeting-wide voices have no name, each topic's existing badge text (transcribing / summarized), Minutes "out of date" when the report has changes, "generating…" while pending.
- The recording banner gains **Next topic ›** (opens the following agenda item; hidden on the last).
- Narrow screens (≤ 720px): the menu becomes a `<select id="mtg-nav-select">` above the section.
- Editor: never shows marker text; ▶ survives edits of its line; saves ≤ 1 s after the last change and on leaving; shows "Saving…" / "Saved" / the server error; refuses to edit while the report is generating or the page is read-only (plan 3 lock). Approximate page count updates live (same formula as `estimatePages`: words / 400, nearest 0.5).

## Review Focus

1. **Recording in progress while switching sections or editing minutes** → recorder, banner and timer unaffected. *Test in Task 1.*
2. **Editing a line that carries a ▶** → marker kept on the same block, not shown in the textarea. *Test in Task 3.*
3. **Clearing a block's text** → the line is removed, no blank Markdown line left behind; pasting several lines → several blocks. *Test in Task 3.*
4. **Save fails (409 pending, 423 locked, network)** → the error is shown and the edit stays on screen, not silently lost. *Test in Task 3.*
5. **Old report without markers / empty report** → editor works; empty report shows the Generate prompt, not a blank editor. *Test in Task 3.*

---

### Task 1: Sections and the side menu

**Files:** Modify `src/public/app.js` (`renderDetail`, new `renderMeetingNav`, `showSection`), `src/public/app.css`; Test `src/modal.test.ts`

**Produces:**
- `state.section` (`'details'|'people'|'agenda'|'recording'|'speakers'|'minutes'`), `state.topicFocus` (item id or null).
- `function defaultSection(): string`, `function showSection(sec, topicId?)` — sets state, toggles `hidden` on `#detail-body section[data-sec]`, marks the active menu entry, hides other `.item`s when `topicId`, opens that topic via the existing `toggleItemOpen` path when it isn't open.
- Shell markup: `<div class="mtg-shell"><nav class="mtg-nav" id="mtg-nav">…</nav><select id="mtg-nav-select">…</select><div class="mtg-main">…sections…</div></div>`; nav entries are `<a href="#" data-sec="…">` and topic entries `<a href="#" data-topic="<id>">`.
- `renderMeetingNav()` re-renders only the nav (called by `renderDetail` and wherever item badges/report state refresh).
- Recording banner: `<button class="btn-sm" id="rb-next">Next topic ›</button>` when there is a following item.

- [ ] **Step 1: Failing tests:** default section is Minutes with a report, Details with no items, Agenda otherwise; clicking `[data-sec="people"]` shows only the People section; clicking a topic entry shows only that `.item` and opens it; a re-render keeps the section; the narrow `<select>` switches sections; with `meetingRec` active, switching sections does not call `stopRecording`; `#rb-next` opens the next topic.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS (all existing browser tests too). **Step 5:** commit `feat(meeting-minutes): meeting page in sections with a side menu`.

---

### Task 2: Menu status hints

**Files:** Modify `src/public/app.js`; Test `src/modal.test.ts`

**Produces:** `function navHints(): { people: string; speakers: string; minutes: string; topics: Record<number, string> }` used by `renderMeetingNav`.

- [ ] **Step 1: Failing tests:** 2 attendees + 1 guest → People "3"; meeting speaker stats with one unmapped voice → Speakers "1 unnamed"; report with `changes` → Minutes "out of date"; pending → "generating…"; a topic transcribing → its hint.
- [ ] **Step 2:** FAIL. **Step 3:** implement; call `renderMeetingNav()` from `refreshBadge`, `renderReportState`, `renderMeetingSpeakerPanel`, `renderAttendeeChips`, `renderGuests`. **Step 4:** PASS. **Step 5:** commit `feat(meeting-minutes): status hints in the meeting menu`.

---

### Task 3: The Minutes editor

**Files:** Modify `src/public/app.js` (replace the read-only `#report-box` render), `src/public/app.css`; Test `src/modal.test.ts`

**Produces (pure, exposed on `window` like `renderMarkdown`):**
- `function reportLines(md): Array<{ text: string; marker: string }>` — non-blank lines; `marker` is the trailing `<!--t:…-->` (or ''), `text` the rest.
- `function joinReportLines(lines): string` — back to Markdown: blank line before each `#`-heading line (except the first), lines joined with `\n`, marker appended with one space.
- `function replaceLine(lines, index, newText): lines` — `newText` split on newlines, blank pieces dropped; none left → line removed; first piece keeps the old marker.
- `function estimatePagesJS(md): number`.
- Editor DOM: `#report-editor` with one `.rblock[data-line="i"]` per line rendered via `renderMarkdown(text + marker)` (list lines grouped visually by CSS, not `<ul>`). Click (not on `.sec-play`) → textarea `.rblock-edit`, autosized; Escape cancels; blur commits. `#report-save` shows "Saving…/Saved/<error>". Debounced `saveReportText(md)` (800 ms) → `PUT /api/meetings/:id/report`; on failure keeps `state.meeting.report` as edited, shows the error, retries on next edit. `#report-pages` updates from `estimatePagesJS` after every commit.
- When `state.report.status === 'pending'` or read-only: blocks render but are not clickable; a hint says why.

- [ ] **Step 1: Failing tests:** `reportLines`/`joinReportLines` round-trip a report with markers and headings; `replaceLine` keeps the marker on the first piece, removes on empty, splits on paste; clicking a block opens a textarea without marker text; blur with new text sends one PUT (after debounce) whose markdown has the edited text and the original marker; a 409 reply shows its error in `#report-save` and the edited text stays rendered; a pending report's blocks don't open; an empty report shows no editor.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `feat(meeting-minutes): edit the minutes in place`.
