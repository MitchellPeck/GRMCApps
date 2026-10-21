import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { patchItem, saveMeetingSpeakers } from "./actions";
import { Snapshot, readSnapshot, recordSnapshotChange, writeFields } from "./changes";
import { fixWords } from "./fixes";
import {
  AgendaItem, addAgendaItem, addGuest, getAttendeeIds, getMeeting, listAgendaItems, listGuests,
  removeGuest, reportEdited, setAttendees, updateAgendaItem, updateMeeting,
} from "./meetings";
import { requestSummary } from "./minutesWork";
import { listPeople } from "./people";
import { formatClock, parseClock } from "./ranges";
import { latestMeetingRecording, listRecordings } from "./recordings";
import { joinReportLines, replaceLine, reportLines } from "./report";
import { chronologicalSpeakerOrder } from "./segmentation";
import { distinctSpeakers, resolveSpeakerName, transcriptForAi } from "./transcript";

// What the chat can do. Every write calls the same function the page's own
// route does, so "rename Speaker 3 to Linda" in the chat and the dropdown on
// the page behave identically. Each write returns a card for the page: what
// changed, and an Undo when the change is in the change log.

export type ChatCard =
  | { kind: "change"; summary: string; changeId: number | null; undone?: boolean }
  // Something that can't easily be undone: the page shows a Confirm button,
  // and only the person pressing it makes it happen (through the page's own
  // route). The model can't do it on its own.
  | { kind: "confirm"; id: string; action: "remove_topic" | "regenerate_report" | "reprocess_recording"; itemId?: number; recordingId?: number; label: string; done?: boolean }
  | { kind: "clip"; source: "m" | "i"; recordingId: number; start: number; end: number; quote: string; topic: string };

export interface ToolOutcome { content: string; isError?: boolean; card?: ChatCard }

// ── Tool definitions ────────────────────────────────────────────────────────
// Strict schemas: every property listed and required; optional ones take null.

const str = { type: "string" };
const nstr = { type: ["string", "null"] };
const int = { type: "integer" };
const nint = { type: ["integer", "null"] };
const nints = { type: ["array", "null"], items: int };

function tool(name: string, description: string, properties: Record<string, unknown> = {}): Anthropic.Tool {
  return {
    name, description, strict: true,
    input_schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
  } as Anthropic.Tool;
}

export const CHAT_TOOLS: Anthropic.Tool[] = [
  tool("get_meeting", "The meeting at a glance: details, who was present, guests, the agenda topics (with ids), the voices in the recording and their names, and the state of the minutes."),
  tool("get_transcript", "One topic's transcript, each turn stamped with its [mm:ss] time in the recording.", { item_id: int }),
  tool("search_transcripts", "Find where something was said across every topic's transcript. Returns matching lines with topic, time and speaker.", { query: str }),
  tool("get_report", "The minutes as numbered lines (Markdown). Lines marked (▶) can be played. Use the numbers with edit_report.", {}),
  tool("update_meeting_details", "Change the meeting's title, date, location or description. Pass null to leave one as it is.",
    { title: nstr, meeting_date: nstr, location: nstr, description: nstr }),
  tool("set_attendance", "Set who from the people list was present (everyone else is recorded absent). Use the person ids from get_meeting.",
    { present_person_ids: { type: "array", items: int } }),
  tool("add_guest", "Add a visitor who isn't in the people list.", { name: str, title: nstr }),
  tool("remove_guest", "Remove a guest.", { guest_id: int }),
  tool("rename_speakers", "Name voices in the whole-meeting recording (voice ids from get_meeting). An empty name clears it. Same as naming them in the Speakers section.",
    { renames: { type: "array", items: { type: "object", properties: { voice: str, name: str }, required: ["voice", "name"], additionalProperties: false } } }),
  tool("rename_topic_speaker", "Name a voice in one topic's own recording (not the whole-meeting recording).", { item_id: int, voice: str, name: str }),
  tool("update_topic", "Change a topic's title, description, typed notes, typed transcript (only when it wasn't recorded) or presenters (person ids from the people list, guest ids from the guests). Pass null to leave one as it is. New notes or transcript text means its summary is written again.",
    { item_id: int, title: nstr, description: nstr, notes: nstr, transcript: nstr, presenter_person_ids: nints, presenter_guest_ids: nints }),
  tool("set_action_items", "Replace a topic's own list of action items (what the minutes are generated from). To change the action items in the current minutes, use edit_report.",
    { item_id: int, items: { type: "array", items: { type: "object", properties: { task: str, owner: str }, required: ["task", "owner"], additionalProperties: false } } }),
  tool("add_topic", "Add an agenda topic at the end.", { title: str, description: nstr }),
  tool("remove_topic", "Offer to remove an agenda topic and everything recorded under it. This shows the person a Confirm button; it only happens if they press it.",
    { item_id: int }),
  tool("resummarize_topic", "Write a topic's summary again from its transcript and notes.", { item_id: int }),
  tool("regenerate_report", "Offer to write the minutes again from scratch, replacing every edit made to them. This shows the person a Confirm button; it only happens if they press it."),
  tool("reprocess_recording", "Offer to transcribe the whole-meeting recording again, replacing every topic's transcript, speaker names and summary. Shows a Confirm button; it only happens if they press it."),
  tool("fix_words", "Correct a misheard name or word everywhere at once: transcripts, summaries, action items, speaker names, guests and the minutes. Matching is whole-word and case-sensitive. item_id limits it to one topic.",
    { from: str, to: str, item_id: nint }),
  tool("edit_report", "Change lines of the minutes, by number from get_report. text replaces the line (it may hold several lines); an empty text deletes it. Keep the minutes concise.",
    { edits: { type: "array", items: { type: "object", properties: { line: int, text: str }, required: ["line", "text"], additionalProperties: false } } }),
  tool("play_clip", "Show the person a playable stretch of the recording, e.g. where something was said. Times as mm:ss or h:mm:ss from the transcript stamps.",
    { item_id: int, start: str, end: str, quote: nstr }),
];

// ── Helpers ─────────────────────────────────────────────────────────────────

class ToolError extends Error {}
const cardId = () => randomBytes(6).toString("hex");
const fail = (msg: string): never => { throw new ToolError(msg); };
const ok = (data: unknown, card?: ChatCard): ToolOutcome => ({ content: JSON.stringify(data), card });

function need<T>(v: T | null | undefined, msg: string): T { return v === null || v === undefined ? fail(msg) : v; }
function isStr(v: unknown): v is string { return typeof v === "string"; }
function isInt(v: unknown): v is number { return typeof v === "number" && Number.isInteger(v); }
function optStr(v: unknown, field: string): string | undefined {
  if (v === null || v === undefined) return undefined;
  return isStr(v) ? v : fail(`${field} must be text or null.`);
}

async function itemOf(pool: Pool, meetingId: number, id: unknown): Promise<AgendaItem> {
  if (!isInt(id)) fail("item_id must be a topic id from get_meeting.");
  const it = (await listAgendaItems(pool, meetingId)).find((x) => x.id === id);
  return need(it, `There is no topic ${id} in this meeting.`);
}

// The recording a topic's segment times are on, as the report's ▶ uses it.
async function topicRecording(pool: Pool, meetingId: number, it: AgendaItem): Promise<{ source: "m" | "i"; id: number } | null> {
  const source = it.transcript_source === "meeting" ? "m" : "i";
  if (it.transcript_recording_id !== null) return { source, id: it.transcript_recording_id };
  if (source === "m") {
    const rec = await latestMeetingRecording(pool, meetingId);
    return rec ? { source, id: rec.id } : null;
  }
  const recs = await listRecordings(pool, it.id);
  return recs.length === 1 ? { source, id: recs[0].id } : null;
}

function speakerOrderFor(items: AgendaItem[], it: AgendaItem): string[] | undefined {
  return it.transcript_source === "meeting"
    ? chronologicalSpeakerOrder(items.filter((x) => x.transcript_source === "meeting").map((x) => x.transcript_segments))
    : undefined;
}

// Run an action and record what it changed. No card when nothing changed.
async function changed(
  pool: Pool, meetingId: number, shape: Snapshot, summary: string, by: string, act: () => Promise<void>
): Promise<ChatCard | undefined> {
  const before = await readSnapshot(pool, meetingId, shape);
  await act();
  const after = await readSnapshot(pool, meetingId, shape);
  const changeId = await recordSnapshotChange(pool, meetingId, "chat", summary, before, after, by);
  return changeId === null ? undefined : { kind: "change", summary, changeId };
}
const done = (card: ChatCard | undefined) => ok(card ? { done: true } : { done: true, note: "Nothing needed changing." }, card);

// Cap on a transcript handed to the model, so one long topic doesn't swamp
// the conversation (and the cost of every later turn).
const TRANSCRIPT_LIMIT = 40000;

// ── Running a tool ──────────────────────────────────────────────────────────

export async function runChatTool(
  pool: Pool,
  meetingId: number,
  name: string,
  input: any,
  who: { email: string; name: string }
): Promise<ToolOutcome> {
  try {
    const meeting = need(await getMeeting(pool, meetingId), "The meeting no longer exists.");
    const by = who.email;
    input = input ?? {};
    switch (name) {
      case "get_meeting": {
        const items = await listAgendaItems(pool, meetingId);
        const people = await listPeople(pool, true);
        const present = new Set(await getAttendeeIds(pool, meetingId));
        const order = chronologicalSpeakerOrder(items.filter((x) => x.transcript_source === "meeting").map((x) => x.transcript_segments));
        return ok({
          title: meeting.title, date: meeting.meeting_date, location: meeting.location, description: meeting.description,
          people: people.filter((p) => p.active || present.has(p.id)).map((p) => ({ id: p.id, name: p.name, title: p.title, present: present.has(p.id) })),
          guests: (await listGuests(pool, meetingId)).map((g) => ({ id: g.id, name: g.name, title: g.title })),
          topics: items.map((it, i) => ({
            id: it.id, number: i + 1, title: it.title, description: it.description,
            has_transcript: !!it.transcript.trim(), recorded: it.transcript_source || null,
            notes: it.notes || null, summary: it.summary || null, action_items: it.action_items.map((a) => `${a.task} — ${a.owner}`),
          })),
          voices: order.map((label) => ({ voice: label, shown_as: resolveSpeakerName(label, meeting.speaker_map, order), name: meeting.speaker_map[label] ?? null })),
          report: { exists: !!meeting.report, status: meeting.report_status, edited: reportEdited(meeting), lines: reportLines(meeting.report).length },
        });
      }
      case "get_transcript": {
        const items = await listAgendaItems(pool, meetingId);
        const it = await itemOf(pool, meetingId, input.item_id);
        const t = transcriptForAi(it, speakerOrderFor(items, it)) || "(no transcript)";
        if (t.length <= TRANSCRIPT_LIMIT) return ok({ topic: it.title, transcript: t });
        return ok({ topic: it.title, transcript: t.slice(0, TRANSCRIPT_LIMIT),
          note: `Trimmed to the first ${TRANSCRIPT_LIMIT} characters of ${t.length}; use search_transcripts to find later parts.` });
      }
      case "search_transcripts": {
        const q = need(isStr(input.query) && input.query.trim() ? input.query.trim().toLowerCase() : null, "Say what to search for.");
        const items = await listAgendaItems(pool, meetingId);
        const matches: unknown[] = [];
        for (const it of items) {
          if (matches.length >= 25) break;
          const order = speakerOrderFor(items, it) ?? distinctSpeakers(it.transcript_segments);
          for (const sgm of it.transcript_segments) {
            if (!sgm.text.toLowerCase().includes(q)) continue;
            matches.push({ item_id: it.id, topic: it.title, at: formatClock(sgm.start), speaker: resolveSpeakerName(sgm.speaker, it.speaker_map, order), text: sgm.text.trim() });
            if (matches.length >= 25) break;
          }
          if (!it.transcript_segments.length && it.transcript.toLowerCase().includes(q)) {
            matches.push({ item_id: it.id, topic: it.title, at: null, speaker: null, text: "(typed transcript mentions it)" });
          }
        }
        return ok({ matches });
      }
      case "get_report": {
        if (!meeting.report) return ok({ lines: [], note: "No minutes yet. They can be generated with regenerate_report." });
        return ok({ lines: reportLines(meeting.report).map((l, i) => `${i}: ${l.text}${l.marker ? " (▶)" : ""}`) });
      }
      case "update_meeting_details": {
        const fields = {
          title: optStr(input.title, "title"), meetingDate: optStr(input.meeting_date, "meeting_date"),
          location: optStr(input.location, "location"), description: optStr(input.description, "description"),
        };
        if (Object.values(fields).every((v) => v === undefined)) fail("Nothing to change: give at least one field.");
        const card = await changed(pool, meetingId, { meeting: { title: "", meeting_date: "", location: "", description: "" } },
          "Meeting details updated", by, async () => {
            const r = await updateMeeting(pool, meetingId, fields);
            if (!r.ok) fail(r.error);
          });
        return done(card);
      }
      case "set_attendance": {
        const ids = Array.isArray(input.present_person_ids) && input.present_person_ids.every(isInt)
          ? input.present_person_ids as number[] : fail("present_person_ids must be a list of person ids.");
        const known = new Set((await listPeople(pool, true)).map((p) => p.id));
        const unknown = ids.filter((id) => !known.has(id));
        if (unknown.length) fail(`No such people: ${unknown.join(", ")}.`);
        const card = await changed(pool, meetingId, { attendees: [] }, `Attendance set (${ids.length} present)`, by,
          () => setAttendees(pool, meetingId, ids));
        return done(card);
      }
      case "add_guest": {
        const r = await addGuest(pool, meetingId, need(isStr(input.name) ? input.name : null, "Give the guest's name."), optStr(input.title, "title") ?? "");
        if (!r.ok) fail(r.error);
        return ok({ done: true }, { kind: "change", summary: `Guest added: ${input.name}`, changeId: null });
      }
      case "remove_guest": {
        const g = (await listGuests(pool, meetingId)).find((x) => x.id === input.guest_id);
        need(g, "There is no such guest in this meeting.");
        await removeGuest(pool, g!.id);
        return ok({ done: true }, { kind: "change", summary: `Guest removed: ${g!.name}`, changeId: null });
      }
      case "rename_speakers": {
        const renames = Array.isArray(input.renames) && input.renames.length ? input.renames : fail("renames must be a non-empty list.");
        const items = await listAgendaItems(pool, meetingId);
        const voices = new Set(chronologicalSpeakerOrder(items.filter((x) => x.transcript_source === "meeting").map((x) => x.transcript_segments)));
        const map: Record<string, string> = { ...meeting.speaker_map };
        for (const r of renames) {
          if (!isStr(r?.voice) || !isStr(r?.name)) fail("Each rename needs a voice and a name.");
          if (!voices.has(r.voice)) fail(`There is no voice “${r.voice}” in this meeting's recording; see get_meeting.`);
          if (r.name.trim()) map[r.voice] = r.name.trim(); else delete map[r.voice];
        }
        const before = await listChangeIds(pool, meetingId);
        await saveMeetingSpeakers(pool, meetingId, map);
        const changeId = await newestChangeSince(pool, meetingId, before);
        return ok({ done: true }, { kind: "change", summary: `Speakers named: ${renames.map((r: any) => `${r.voice} → ${r.name || "(unnamed)"}`).join(", ")}`, changeId });
      }
      case "rename_topic_speaker": {
        const it = await itemOf(pool, meetingId, input.item_id);
        if (!isStr(input.voice) || !isStr(input.name)) fail("Give the voice and the name.");
        const map: Record<string, string> = { ...it.speaker_map };
        if (input.name.trim()) map[input.voice] = input.name.trim(); else delete map[input.voice];
        const before = await listChangeIds(pool, meetingId);
        const r = await patchItem(pool, it.id, { speakerMap: map }, by);
        if (r.status !== 200) fail(String(r.body.error));
        return ok({ done: true }, { kind: "change", summary: `${it.title}: ${input.voice} → ${input.name || "(unnamed)"}`, changeId: await newestChangeSince(pool, meetingId, before) });
      }
      case "update_topic": {
        const it = await itemOf(pool, meetingId, input.item_id);
        const body: Record<string, unknown> = {
          title: optStr(input.title, "title"), description: optStr(input.description, "description"),
          notes: optStr(input.notes, "notes"), transcript: optStr(input.transcript, "transcript"),
        };
        if (input.presenter_person_ids !== null && input.presenter_person_ids !== undefined) {
          const ids = Array.isArray(input.presenter_person_ids) && input.presenter_person_ids.every(isInt)
            ? input.presenter_person_ids as number[] : fail("presenter_person_ids must be a list of person ids.");
          const known = new Set((await listPeople(pool, true)).map((p) => p.id));
          if (ids.some((id) => !known.has(id))) fail("Some of those people aren't in the people list.");
          body.presenterIds = ids;
        }
        if (input.presenter_guest_ids !== null && input.presenter_guest_ids !== undefined) {
          const ids = Array.isArray(input.presenter_guest_ids) && input.presenter_guest_ids.every(isInt)
            ? input.presenter_guest_ids as number[] : fail("presenter_guest_ids must be a list of guest ids.");
          const known = new Set((await listGuests(pool, meetingId)).map((g) => g.id));
          if (ids.some((id) => !known.has(id))) fail("Some of those guests aren't at this meeting.");
          body.guestPresenterIds = ids;
        }
        if (Object.values(body).every((v) => v === undefined)) fail("Nothing to change: give at least one field.");
        // The summary and action items too: new notes clear them for rewriting,
        // and Undo should put them back with the notes.
        const card = await changed(pool, meetingId,
          { items: { [it.id]: { title: "", description: "", notes: "", transcript: "", summary: "", action_items: [], presenter_ids: [], guest_presenter_ids: [] } } },
          `Topic updated: ${(body.title as string | undefined) ?? it.title}`, by, async () => {
            const r = await patchItem(pool, it.id, body, by);
            if (r.status !== 200) fail(String(r.body.error));
          });
        return done(card);
      }
      case "set_action_items": {
        const it = await itemOf(pool, meetingId, input.item_id);
        const list = Array.isArray(input.items) ? input.items : fail("items must be a list.");
        const items = list.map((a: any) => {
          if (!isStr(a?.task) || !a.task.trim()) fail("Each action item needs a task.");
          return { task: a.task.trim(), owner: isStr(a?.owner) && a.owner.trim() ? a.owner.trim() : "Unassigned" };
        });
        const card = await changed(pool, meetingId, { items: { [it.id]: { action_items: [] } } },
          `${it.title}: action items updated (${items.length})`, by, async () => {
            const r = await updateAgendaItem(pool, it.id, { actionItems: items });
            if (!r.ok) fail(r.error);
          });
        return done(card);
      }
      case "add_topic": {
        const r = await addAgendaItem(pool, meetingId, need(isStr(input.title) ? input.title : null, "Give the topic a title."), optStr(input.description, "description") ?? "");
        if (!r.ok) return fail(r.error);
        return ok({ done: true, item_id: r.id }, { kind: "change", summary: `Topic added: ${input.title}`, changeId: null });
      }
      case "remove_topic": {
        const it = await itemOf(pool, meetingId, input.item_id);
        return ok({ shown: "A Confirm button. Nothing happens unless they press it." },
          { kind: "confirm", id: cardId(), action: "remove_topic", itemId: it.id, label: `Remove the topic “${it.title}” and what was recorded under it` });
      }
      case "resummarize_topic": {
        const it = await itemOf(pool, meetingId, input.item_id);
        await requestSummary(it.id);
        return ok({ done: true, note: "The summary is being written; it appears in a minute or so." },
          { kind: "change", summary: `${it.title}: summary being written again`, changeId: null });
      }
      case "regenerate_report": {
        if (!(await listAgendaItems(pool, meetingId)).length) fail("Add agenda topics before generating minutes.");
        return ok({ shown: "A Confirm button. Nothing happens unless they press it." },
          { kind: "confirm", id: cardId(), action: "regenerate_report", label: "Write the minutes again from scratch, replacing every edit made to them" });
      }
      case "reprocess_recording": {
        const rec = need(await latestMeetingRecording(pool, meetingId), "This meeting has no whole-meeting recording.");
        if (meeting.recording_status !== "done" && meeting.recording_status !== "error") {
          fail("The recording is still being made or processed; it can be reprocessed once that's finished.");
        }
        return ok({ shown: "A Confirm button. Nothing happens unless they press it." },
          { kind: "confirm", id: cardId(), action: "reprocess_recording", recordingId: rec.id,
            label: "Transcribe the recording again, replacing every topic's transcript, speaker names and summary" });
      }
      case "fix_words": {
        if (!isStr(input.from) || !isStr(input.to) || !input.from.trim() || !input.to.trim() || input.from.trim() === input.to.trim()) {
          fail("Say what to replace and what with.");
        }
        let itemId: number | undefined;
        if (input.item_id !== null && input.item_id !== undefined) itemId = (await itemOf(pool, meetingId, input.item_id)).id;
        const r = await fixWords(pool, meetingId, input.from.trim(), input.to.trim(), { itemId, by });
        if (!r.total) fail(`“${input.from}” isn't in this meeting (capital letters count).`);
        return ok({ counts: r.counts, total: r.total, people_list_still_says: r.libraryMatches.map((p) => p.name) },
          { kind: "change", summary: `“${input.from.trim()}” → “${input.to.trim()}”: ${r.total} place${r.total === 1 ? "" : "s"}`, changeId: r.changeId });
      }
      case "edit_report": {
        if (!meeting.report) fail("There are no minutes to edit yet.");
        if (meeting.report_status === "pending") fail("The minutes are being written right now; try again when they're done.");
        const edits = Array.isArray(input.edits) && input.edits.length ? input.edits : fail("edits must be a non-empty list.");
        let lines = reportLines(meeting.report);
        for (const e of edits) {
          if (!isInt(e?.line) || e.line < 0 || e.line >= lines.length) fail(`There is no line ${e?.line}; get_report has ${lines.length} lines (0–${lines.length - 1}).`);
          if (!isStr(e.text)) fail("Each edit needs text (empty deletes the line).");
          // get_report's "N: " numbers and "(▶)" marks aren't part of the text.
          e.text = e.text.split(/\r?\n/).map((l: string) => l.replace(/^\s*\d+:\s/, "").replace(/\s*\(▶\)\s*$/, "")).join("\n");
        }
        if (new Set(edits.map((e: any) => e.line)).size !== edits.length) fail("Edit each line once per call.");
        // From the bottom up, so earlier line numbers stay put.
        for (const e of [...edits].sort((a: any, b: any) => b.line - a.line)) lines = replaceLine(lines, e.line, e.text);
        const md = joinReportLines(lines);
        const card = await changed(pool, meetingId, { meeting: { report: "" } },
          `Minutes edited (${edits.length} line${edits.length === 1 ? "" : "s"})`, by, async () => {
            const c = await pool.connect();
            try {
              await writeFields(c, meetingId, { meeting: { report: md } });
            } finally { c.release(); }
          });
        return card ? ok({ done: true, lines: lines.length }, card) : done(card);
      }
      case "play_clip": {
        const it = await itemOf(pool, meetingId, input.item_id);
        const start = parseClock(isStr(input.start) ? input.start : ""), end = parseClock(isStr(input.end) ? input.end : "");
        if (start === null || end === null || end <= start) fail("Give start and end as mm:ss (or h:mm:ss), end after start.");
        const rec = need(await topicRecording(pool, meetingId, it), `“${it.title}” has no recording to play.`);
        return ok({ shown: true }, {
          kind: "clip", source: rec.source, recordingId: rec.id, start: start!, end: end!,
          quote: optStr(input.quote, "quote") ?? "", topic: it.title,
        });
      }
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (e) {
    if (e instanceof ToolError) return { content: e.message, isError: true };
    throw e;
  }
}

// Renames record their own change rows; find the one this call made.
async function listChangeIds(pool: Pool, meetingId: number): Promise<number> {
  const r = await pool.query("SELECT COALESCE(MAX(id), 0) AS id FROM meeting_changes WHERE meeting_id = $1", [meetingId]);
  return Number(r.rows[0].id);
}
async function newestChangeSince(pool: Pool, meetingId: number, since: number): Promise<number | null> {
  const r = await pool.query("SELECT MAX(id) AS id FROM meeting_changes WHERE meeting_id = $1 AND id > $2", [meetingId, since]);
  return r.rows[0].id === null ? null : Number(r.rows[0].id);
}
