# Meeting Minutes — edit the minutes on the meeting page, with a chat and audio

## Why

Cleaning up a meeting's minutes today means opening the generated report in Google Docs and fixing it by hand. Three things make that painful:

1. **Misheard names, wrong in many places.** Whisper mishears a name and the mistake is copied into the transcript, the per-topic summary, the report and the action items. Each copy is fixed by hand.
2. **No way to check what was actually said.** The only way to verify a line is to dig back through the transcript text. The user wants to *hear* the part of the meeting a section came from.
3. **The report is far too long.** The last one was 15 pages. The cause is in `claude.ts` `REPORT_SYSTEM`: it asks for minutes that are "comprehensive", says "keep every concrete fact", and is given every topic's full transcript with no length budget. Action items are similarly over-collected: `SUMMARIZE_SYSTEM` says "extract every action item" and treats "we should look into X" / "let's X" as one, and `consolidateActionItems` lists all of them.

And because the Google Doc is a one-way copy (`/api/meetings/:id/google-doc`), nothing fixed there comes back, and regenerating the report makes a fresh Doc that loses the fixes.

## What we're building

The generated report becomes the **live, editable working copy of the minutes on the meeting page**. The user edits it directly, or tells a chat beside it what to fix. Every part of the report can be played back as audio. Google Docs remains the **final export**, made from the edited copy when the user is done. Alongside this, the meeting page itself is broken into short sections with a side menu (Goal 8), because today it is "just convoluted and long".

The user chose this layout (mockup "A" in the brainstorm):

- This is the **Minutes** section of the redesigned meeting page (Goal 8).
- The report takes most of the page and is typed into directly. It saves as you go.
- Each topic heading, each sub-section heading (e.g. "Schedule A — Operating") and each action item has a ▶ that plays its stretch of the recording, with its time range shown beside it. Playback works without the chat.
- A chat panel sits to the right of the report. Every change the chat makes appears in the chat as a card that says what changed and how many places, with **Undo**.
- A bar above the report shows save state, an approximate page count, and **Export to Google Docs**.

## Goals

### 1. The report is edited in place and survives changes underneath it

- After generation, the stored report is the user's document. Hand edits and chat edits are saved to it. Nothing regenerates it unless the user asks.
- **Everything in the report is frozen text after generation**, including the parts `buildReport` lays out in code today: header, attendance, guests, the action-item list. *(My call.)* Later data changes (attendees, guests, meeting details, agenda items added/removed/reordered, typed notes) do not flow in by themselves. Two exceptions: speaker renames and name fixes, below. The existing "report is out of date" notice (`reportChanges`) stays, and names what changed. The chat can be asked to bring the report up to date for those changes ("add Tom to attendance").
- **After generation, the report's action-item list is the source of truth for action items.** "Drop, merge or reassign" edits the report. The per-topic `action_items` stay as the generator's input. *(My call.)*
- **Renaming a speaker** — the user says both cases happen: the name was misspelled, or the voice was actually someone else. They "typically take care of [the second] before generating report."
  - **Before a report exists**, a rename works as today: transcripts re-render, and summaries are cleared and rewritten. That's the right thing when the voice was a different person.
  - **Once a report exists**, a rename (dropdown or chat) is treated as a correction for **that voice**. Its lines in the transcript re-render under the new name. In the summaries, action-item owners and the report, the old name is replaced where it credits that speaker (presenter lines, "X reported…", owners). Summaries are not wiped, and topics are not marked pending. A mention of the same name elsewhere ("we should ask John") is left alone. That's what "fix it everywhere" (Goal 2) is for. *(My call: the scoping. The user's words: "renaming speaker should update that name across.")*
  - Renaming a placeholder ("Speaker 3" → "Linda") follows the same rule. When several voices map to one name, renaming one voice affects only that voice's lines.
- **Transcript edits** in practice only correct how a name or reference was transcribed, not content. The user's words: "transcript updates will really only happen to update transcripted names/references so should only update in-text references. transcript updates won't be content/info updates."
  - *(My call:)* Hand-editing a transcript becomes a correction stored on the segments, not free text: click a word or phrase in a segment and correct it, or use find-and-replace (Goal 2). That way a speaker re-render never loses a fix, which the free-text box does today. Each correction is applied to the matching words in the summaries, action items and report. It does **not** wipe the summary or trigger re-summarizing.
  - Typed **notes** can change content, so notes edits still re-summarize that topic, as today. After a report exists, that only shows up in the out-of-date notice. It never rewrites the report.
- **Regenerating the report from scratch** only happens when the user asks. Because it replaces their edits, it warns first. *(My call.)*

### 2. Fix a name or word everywhere in one step

New capability (no equivalent exists today): replace a misheard name or phrase across the whole meeting — every topic's transcript (at the segment level, so re-rendering keeps the fix), summaries, action items and the report. Available through the chat ("it's Jon, not John, everywhere"). Reports how many places changed per area. Matching is whole-word and case-aware, so "John" doesn't match inside "Johnson". *(My call:)* It also updates any speaker-map value and meeting-guest name that matches, so a later re-render doesn't bring the old spelling back. If the name matches a **people-library** person, the fix doesn't change the library. Instead it flags that person ("the People list still spells this 'John Hale'") with a link to edit them, because the library is shared across meetings. *(My call: also expose it as a plain find-and-replace on the page, so it works without the chat, the way audio does.)*

### 3. Listen to any part of the report

- Each topic, sub-section and action item knows its time range in the recording.
- Topic ranges come from the data we already have: whole-meeting topics have `transcript_segments` with `start`/`end` on the meeting timeline (from topic markers). Per-item recordings (`item_recordings`) have their own timeline.
- Sub-section and action-item ranges come from the report generator: the transcript it's given must carry timestamps, and it must cite the time range each sub-section and action item came from. Those ranges are stored with the report, not shown as text in the exported Doc.
- When a range can't be determined (e.g. a topic with typed notes only), there's no ▶.
- The existing clip route caps at 45 s (`MAX_CLIP_SECONDS`) and transcodes a WAV. Topic playback runs for many minutes, so section playback needs a seekable stream of the recording (e.g. an HTTP Range-capable route, played from the start time). The builder chooses the mechanism.

### 4. A chat that can do everything the page can

The user: "I want the chat to be able to take all existing actions. For example if a user says to update a speaker, just like when they're manually updating a speaker from one person to another, it should be able to do that same functionality."

- The chat runs on the server using Claude with tool use. **Each tool calls the same server functions the page's routes already use**, so a chat action and the matching manual action behave identically. Today's meeting-scoped actions (see `routes/meetings.ts`):
  - edit meeting details; set attendees; add or remove guests
  - rename speakers meeting-wide (`speaker-map`) and per topic
  - add, edit, reorder or remove agenda items; change presenters (people and guests)
  - edit a topic's transcript or notes; re-summarize a topic
  - generate / regenerate the report
- Plus new chat-only abilities:
  - edit the report text: rewrite, shorten, move, delete or add a section ("cut item 3 to half a page")
  - fix a name or word everywhere (Goal 2)
  - drop, merge or reassign action items
  - find audio: "play where Linda talks about the roof reserve" answers with a playable clip, its time range, and the quoted transcript line(s)
  - answer questions about the meeting from its transcripts ("what did we decide about the boiler?"), with the time it was said
- The chat makes changes right away and shows a change card with Undo, rather than asking first. *(My call; the user hasn't contradicted it.)* Exceptions that ask in the chat first, because Undo can't easily put them back: removing an agenda item, reprocessing the recording, regenerating the report.
- Not available to the chat *(my call)*: deleting the meeting, Settings (API key, report instructions), and the people library. Those stay manual.
- Chat history is saved per meeting, so it's there when the meeting is reopened. *(My call.)*

### 5. Shorter reports and fewer, real action items

- The default report targets **5–7 pages at most**. Each topic gets **about half to three-quarters of a page**, unless there's a specific reason to be longer. The user's example of a valid reason: "a finance review with multiple schedules."
- Rewrite `REPORT_SYSTEM` to summarize instead of transcribe: what was reported, decided, and what happens next. Key figures stay, but there's no instruction to keep every fact. Give it an explicit word budget per topic and overall.
- Action items: only real commitments or assignments, where someone agreed to do something or was asked to. Not every "we should" or "let's". Duplicates across topics are merged.
- The organization's report instructions and example report in Settings still apply, as today.
- The page shows an approximate page count so length is visible while editing.

### 6. One editor at a time

The user: "each meeting should be edit locked to a user."

- One signed-in user (identity from `identity.ts`) holds a meeting's edit lock. Everyone else sees the meeting read-only, with "Being edited by <name>".
- The lock covers every write on the meeting, not just the report: speakers, agenda items, transcripts, chat. The chat acts as the lock holder. The server enforces it on write routes, not just the page.
- *(My call:)* The lock is taken when the user opens the meeting, and kept alive while their page is open. It lapses after a couple of minutes without a heartbeat (tab closed) or about 15 minutes with no edits. Anyone can take over a lapsed lock. The holder can release it.
- *(My call:)* **An active recording holds the lock** for the person recording, with no idle lapse while it runs. The recording routes (chunk, marker, finish) aren't refused because of an idle timer, so a two-hour meeting never loses its upload. Background server work (transcription, summaries, report writing) isn't subject to the lock.

### 8. A shorter meeting page

The user finds the current meeting page "just convoluted and long": one page holding details, attendees, guests, recording, the speaker panel, the agenda, each topic's transcript/notes/summary, and the report. They chose layout "B" from the brainstorm mockups:

- A short **menu down the left side**: **Details, People, Agenda** (each topic listed under it), **Recording, Speakers, Minutes**. Clicking an entry shows only that part. They can be visited in any order.
  - **Details**: title, date, location, description.
  - **People**: attendees and guests.
  - **Agenda**: upload or edit the agenda and its order. Clicking a topic opens just that topic: its presenters, ▶ for its time range, transcript (with word corrections, Goal 1), typed notes, and summary.
  - **Recording**: start/stop the whole-meeting recording, past recordings, reprocess.
  - **Speakers**: name each voice once for the whole meeting, with samples to play (today's meeting-wide speaker panel).
  - **Minutes**: the report editor and chat (Layout A above), with Generate / Regenerate and Export to Google Docs.
- Menu entries show small status hints where useful: People count, "1 unnamed" on Speakers, topic transcribing/summarized state, report ready or out of date.
- The page opens on **Minutes** once a report exists, otherwise on **Details** (new meeting) or **Agenda**. *(My call.)*
- *(My call:)* **While recording**, a bar stays at the top of every section with the elapsed time, the current topic and the "move to next topic" control, so you can mark topic switches from anywhere. It's today's recording banner, made persistent.
- On a phone, the menu collapses into a dropdown at the top. *(My call.)*
- Every existing capability stays. This rearranges the page; it doesn't remove features.

### 7. Export to Google Docs from the edited copy

- Export builds the Doc from the current edited report (playback ranges and other internal markers stripped).
- Today a repeat export goes to the same Doc only while `report_generated_at` is unchanged. Re-key that on the report's last change, so exporting after edits makes a new Doc with them. *(My call.)*

## Non-goals

- Several people editing the same meeting at once. The lock rules it out.
- Syncing edits made in Google Docs back into the app. Docs is the final export only.
- Voice chat, or the chat acting on other meetings.
- Changing how recording, transcription or diarization work.

## Anti-goals (would make this a failure even if it technically works)

- A rename, a transcript fix or a chat action that silently regenerates or rewrites text the user edited.
- A chat action that behaves differently from the same action done by hand.
- Reports that still come out at 10+ pages for a normal meeting.
- A find-and-fix that corrupts names it shouldn't touch (substring matches).

## Constraints

- Existing app: Fastify + Postgres (`schema.ts` idempotent DDL, `ALTER TABLE … ADD COLUMN IF NOT EXISTS` migrations), vanilla JS front end (`public/app.js`), Claude via raw `fetch` in `claude.ts`. Build on those. No front-end framework.
- The report's stored format is Markdown today (`meetings.report`), and `reportHtml` converts it for Docs. The builder may keep Markdown with embedded range markers, or move to a structured form, as long as export and printing still work.
- Existing reports (generated before this change) have no time ranges. They must still open and edit; they just have no ▶ until regenerated.
- Per [[content-pipeline-rollout]] habits: back up the host DB before shipping schema changes.

## Left to the builder

- The editor itself (contenteditable limited to the report's formatting rules, or a small editor library), and how undo of a non-latest chat change behaves when later edits touched the same text.
- How ranges are stored and how a hand-edited section keeps its range.
- Which Claude model the chat uses (check the `claude-api` skill for current models). The chat loop's limits and timeouts.
- Lock heartbeat timings, within the behavior above.
- The exact report prompt wording and word budgets that land at 5–7 pages.
