# Meeting Sections Redesign (follow-up to plan 4)

**Goal:** each section of the meeting page is built for its own job, as approved in the brainstorm mockup (`sections.html`), not a slice of the old long page.

**Why:** user feedback on plan 4: "it feels like you took the existing UI and just split it into these different sections … make the UI feel like it actually belongs in each of those sections and has better functional purpose." Plus: Details showed only a header until Edit; a topic in the side menu opened as its own page instead of scrolling to it in the list.

## Changes (each with jsdom tests in `src/modal.test.ts`)

1. **Header** — the meeting title and date/location sit above every section (not inside Details).
2. **Details** — every field always shown as rows (title, date, location, about, status, created by); **Edit** turns the same rows into inline fields with Save / Cancel (same `PATCH /api/meetings/:id` as before) and a "Delete meeting…" link (delete-only dialog, same gate as before). Below: stats tiles — topics, present (people + guests / everyone), time recorded, minutes length (+ "edited").
3. **People** — roll call: one row per person with a check, counts ("9 present · 3 absent"), **Everyone present** and **Clear**; guests listed with role and the topics they presented, remove ✕, add row.
4. **Agenda** — toolbar "N topics · Replace from file · + Add topic" (the upload card is shown only on demand or when there are no topics); each topic row shows presenters, a status chip and a ▶ for its stretch of the recording; clicking a topic in the side menu shows the **whole** list, scrolls to that topic and opens it (no single-topic view).
5. **Recording** — big record button + timer; while recording, the topics are big buttons (tap = file the audio under that topic; same marker as opening it) with the current one highlighted; past recordings listed with date, length, download, reprocess.
6. **Speakers** — one card per voice: name, talk time, share, samples, quote; unnamed voices first; "Fix a name or word" its own card.
