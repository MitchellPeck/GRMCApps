# Minutes Chat Implementation Plan (plan 5 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat beside the minutes that can do everything the page can (same server functions), plus edit the report, fix names everywhere, answer questions about the meeting and find audio — with a card for every change and Undo.

**Architecture:** `POST /api/meetings/:id/chat` (a guarded write, so it runs as the lock holder) runs a manual tool-use loop on the Anthropic TypeScript SDK (`@anthropic-ai/sdk@0.131.0`), model `claude-opus-5-5`, `output_config.effort: "medium"`, server-side refusal fallback (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`). Meeting content is fetched through read tools (not pasted into the prompt) so the system prompt and tool list are a stable cached prefix (top-level `cache_control: {type:"ephemeral"}`). Each assistant response is stored **unchanged and append-only** in `chat_messages` (thinking blocks included) and replayed as history. Write tools call the existing functions (`updateMeeting`, `setAttendees`, `addGuest`, `rewriteMeetingSpeakerMap`, `renameTopicSpeakers`, `updateAgendaItem`, `addAgendaItem`, `deleteAgendaItem`, `requestSummary`, `requestReport`, `fixWords`, report edits) and return cards; text changes record `meeting_changes` rows so the card's Undo uses the existing undo route.

**Tech Stack:** TypeScript, Fastify 5, pg, `@anthropic-ai/sdk` 0.131.0, node:test, vanilla JS.

**Spec:** `docs/superpowers/specs/2026-10-21-meeting-minutes-live-edit-design.md` — Goal 4.

## Global Constraints

- Model `claude-opus-5-5`; no `thinking` param (adaptive is always on); `output_config: { effort: "medium" }`; `tool_choice` auto only (forced choice 400s on this model); `max_tokens: 16000`; at most **12** model calls per user message.
- Refusal fallback on by default; a final `stop_reason: "refusal"` replies "I can't help with that one." and records nothing else.
- History is append-only: store `response.content` exactly as returned; never edit or drop earlier turns.
- Asks in the chat before (tool takes `confirmed: true`, prompt says to ask first): removing an agenda item, reprocessing the recording, regenerating the report.
- Never available: deleting the meeting, Settings, the people library.
- Every write tool returns a card `{ kind: "change", summary, changeId | null }`; text changes (report edits, fixes, renames, details, attendees, topic notes/titles/descriptions) are undoable through `meeting_changes`; adding/removing guests or topics is not (`changeId: null`, card says so).
- Clips: `play_clip` returns `{ kind: "clip", source, recordingId, start, end, quote }` rendered as the page's existing `.sec-play` button.
- The API key is the existing Settings `anthropic_api_key`.

## Review Focus

1. **Tool input from the model that doesn't validate** (missing field, wrong type, unknown item id, item from another meeting) → `is_error` tool result, nothing written. *Test in Task 2.*
2. **The model asks to delete or regenerate without `confirmed`** → refused with "Ask the person first", nothing done. *Test in Task 2.*
3. **The loop never ends / API error / no key** → capped at 12 calls, a clear reply, history stays valid (no dangling `tool_use` without its `tool_result`). *Test in Task 3.*
4. **Someone else takes the lock mid-chat** → the chat route is guarded (423 before running); tools re-check nothing else. *Test in Task 3.*
5. **Report line edits on a report with markers** → markers kept, same rules as the page editor. *Test in Task 2.*

---

### Task 1: Report lines on the server, and chat storage

**Files:** Modify `src/report.ts`, `src/schema.ts`; Create `src/chatStore.ts`; Tests `src/report.test.ts`, `src/chatStore.test.ts` (DB)

**Produces:**
- In `report.ts`: `reportLines(md)`, `joinReportLines(lines)`, `replaceLine(lines, index, newText)` — same behaviour as the browser editor's functions of the same names (plan 4).
- Table:
  ```sql
  CREATE TABLE IF NOT EXISTS chat_messages (
    id bigserial PRIMARY KEY,
    meeting_id bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    role text NOT NULL,              -- 'user' | 'assistant'
    content jsonb NOT NULL,          -- API content, exactly as sent/returned
    cards jsonb NOT NULL DEFAULT '[]',
    created_by text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS chat_messages_meeting_idx ON chat_messages (meeting_id, id);
  ```
- `chatStore.ts`: `appendChat(pool, meetingId, role, content, cards?, by?)`, `loadChatHistory(pool, meetingId): Promise<Array<{ id, role, content, cards, created_at }>>`.

- [ ] Steps: failing tests (line helpers mirror the browser cases; append/load round-trip keeps content byte-identical) → FAIL → implement → PASS → commit `feat(meeting-minutes): report lines on the server; chat history storage`.

---

### Task 2: Chat tools

**Files:** Create `src/chatTools.ts`, `src/chatTools.test.ts` (DB)

**Produces:**
- `export const CHAT_TOOLS: Anthropic.Tool[]` — each with `strict: true`, `additionalProperties: false`, all properties `required` (optional fields typed `["string","null"]`). Read: `get_meeting`, `get_transcript {item_id}`, `search_transcripts {query}`, `get_report`. Write: `update_meeting_details`, `set_attendance {present_person_ids}`, `add_guest {name,title}`, `remove_guest {guest_id}`, `rename_speakers {renames:[{voice,name}]}`, `rename_topic_speaker {item_id, voice, name}`, `update_topic {item_id, title, description, notes}`, `add_topic {title, description}`, `remove_topic {item_id, confirmed}`, `resummarize_topic {item_id}`, `regenerate_report {confirmed}`, `fix_words {from, to, item_id}`, `edit_report {edits:[{line, text}]}` (text "" deletes; applied from the highest line down), `play_clip {item_id, start, end, quote}` (times `mm:ss` / `h:mm:ss`).
- `export async function runChatTool(pool, meetingId, name, input, who): Promise<{ content: string; isError?: boolean; card?: ChatCard }>` — validates input (ids belong to this meeting), calls the existing functions, records `meeting_changes` for undoable text changes (report edits as kind `chat`), returns compact JSON text for the model and a card for the page.

- [ ] Steps: failing DB tests: `get_meeting` lists topics with ids/voices; `edit_report` keeps a marker and returns an undoable card; `fix_words` returns its counts card; `remove_topic` without `confirmed` is refused and deletes nothing; an item id from another meeting is an error; `play_clip` returns a clip card on the topic's recording; `rename_speakers` renames meeting-wide → FAIL → implement → PASS → commit `feat(meeting-minutes): the chat's tools are the page's actions`.

---

### Task 3: The chat loop and route

**Files:** Modify `package.json` (`@anthropic-ai/sdk` `0.131.0`); Create `src/chat.ts`, `src/chat.test.ts`; Modify `src/routes/meetings.ts`

**Produces:**
- `export const CHAT_SYSTEM: string` — who it helps (a church secretary editing minutes), what it can do, ask-first rules, keep answers short, cite times as `mm:ss`, never invent, report edits keep minutes concise (5–7 pages), prefer `fix_words` for misheard names.
- `export interface ChatModel { create(params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage> }` and `export async function chatTurn(pool, meetingId, text, who, model: ChatModel): Promise<{ reply: string; cards: ChatCard[] }>` — appends the user message, loops (≤ 12 calls) executing all `tool_use` blocks of a response and returning **all** `tool_result`s in one user message, stores every message, stops on `end_turn`/`refusal`/no tool calls/`max_tokens`; on the cap or an API error stores a final assistant text so history ends cleanly.
- Routes: `GET /api/meetings/:id/chat` → `{ ok, messages: [{ role, text, cards, created_at }] }` (display form: user text, assistant text blocks joined; tool turns hidden); `POST /api/meetings/:id/chat {message}` → `{ ok, reply, cards }`; 400 on empty message; 503 "Add an Anthropic API key in Settings." without a key.

- [ ] Steps: failing tests with a fake `ChatModel` (scripted responses): a tool turn then text → both tool results in one user message, reply + cards; parallel tool calls answered together; 12-call cap ends with a stored assistant text and no dangling tool_use; refusal reply; history replayed append-only on the next turn (second call's messages start with the first turn's stored content unchanged) → FAIL → implement → PASS → commit `feat(meeting-minutes): chat with the meeting`.

---

### Task 4: The chat panel

**Files:** Modify `src/public/app.js`, `src/public/app.css`; Test `src/modal.test.ts`

**Produces:** `#chat-panel` (shown in Minutes when the meeting has content): message list `#chat-log`, textarea `#chat-input`, button `#btn-chat-send`; Enter sends, Shift+Enter newline; "Working…" while waiting; change cards with **Undo** (`.chat-undo[data-change]` → existing undo route, then `refreshMeeting`); clip cards render `.sec-play` with the quote; after any change card, `refreshMeeting` (drafts kept). Read-only (lock) disables the input with the banner's reason.

- [ ] Steps: failing tests: history loads into `#chat-log`; sending posts `{message}` and renders reply + cards; a clip card has a working `.sec-play`; Undo posts to `/changes/:id/undo`; read-only disables input → FAIL → implement → PASS → commit `feat(meeting-minutes): chat panel beside the minutes`.
