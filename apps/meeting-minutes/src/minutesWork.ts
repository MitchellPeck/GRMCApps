import { Pool } from "pg";
import { pool } from "./db";
import { generateReportBody, summarizeItem } from "./claude";
import { listPeople, peopleNamedIn } from "./people";
import { createQueue } from "./queue";
import { buildReport, reportBodyInput, reportChanges, ReportInput, reportSources, ReportSources } from "./report";
import {
  AgendaItem, MeetingRow, getAgendaItem, getAttendeeIds, getMeeting, itemPresenterNames, listAgendaItems, listGuests,
  listPendingReports, listUnfinishedSummaries, saveReport, setAttendees, setReportStatus,
  setSummarizeStatus, updateAgendaItem,
} from "./meetings";

// Item summaries and the meeting report, produced on the server. Before this,
// the browser drove both, so closing the tab stopped them. Claude calls get
// their own serial queue: they must not wait behind an hour of whisper work,
// and a ten-item agenda should not fire ten calls at once.

function log(message: string): void {
  console.log(`[minutes] ${message}`);
}

const aiQueue = createQueue(log);

// After an edit, wait this long for the next one before summarizing, so typed
// notes are not summarized once per keystroke-pause. Closing the item in the
// browser asks for the summary straight away instead.
export const EDIT_SUMMARY_DELAY_MS = 2 * 60 * 1000;

const timers = new Map<number, NodeJS.Timeout>();
const inQueue = new Set<number>();

export function itemHasContent(it: Pick<AgendaItem, "transcript" | "notes">): boolean {
  return !!(it.transcript.trim() || it.notes.trim());
}

function isTranscribing(it: Pick<AgendaItem, "transcribe_status">): boolean {
  return it.transcribe_status === "queued" || it.transcribe_status === "processing";
}

function meetingProcessing(m: Pick<MeetingRow, "recording_status">): boolean {
  return m.recording_status === "queued" || m.recording_status === "processing";
}

// Ask for an item to be summarized after `delayMs`. A later request for the
// same item replaces the pending one, so a burst of edits costs one call.
export async function requestSummary(itemId: number, delayMs = 0): Promise<void> {
  await setSummarizeStatus(pool, itemId, "queued");
  const pending = timers.get(itemId);
  if (pending) clearTimeout(pending);
  timers.set(itemId, setTimeout(() => {
    timers.delete(itemId);
    enqueueSummary(itemId);
  }, delayMs));
}

function enqueueSummary(itemId: number): void {
  if (inQueue.has(itemId)) return;
  inQueue.add(itemId);
  aiQueue.enqueue({
    label: `summary of item ${itemId}`,
    run: async () => {
      // Leave the set before running: an edit made while Claude is working
      // must be able to queue a fresh run.
      inQueue.delete(itemId);
      await summarizeNow(itemId);
    },
    fail: async (message) => {
      await setSummarizeStatus(pool, itemId, "error", message);
      const item = await getAgendaItem(pool, itemId);
      if (item) await advanceReport(item.meeting_id);
    },
  });
}

async function summarizeNow(itemId: number): Promise<void> {
  const item = await getAgendaItem(pool, itemId);
  if (!item) return;
  const meeting = await getMeeting(pool, item.meeting_id);
  if (!meeting) return;
  // A transcription about to land would make this summary stale at once; its
  // completion asks for a summary itself.
  if (isTranscribing(item) || meetingProcessing(meeting)) {
    await setSummarizeStatus(pool, itemId, "idle");
    return;
  }
  if (!itemHasContent(item)) {
    await updateAgendaItem(pool, itemId, { summary: "", actionItems: [] });
    await setSummarizeStatus(pool, itemId, "idle");
    await advanceReport(item.meeting_id);
    return;
  }

  await setSummarizeStatus(pool, itemId, "processing");
  const people = await listPeople(pool, true);
  const names = new Map(people.map((p) => [p.id, p.name]));
  const guestNames = new Map((await listGuests(pool, item.meeting_id)).map((g) => [g.id, g.name]));
  const result = await summarizeItem(pool, {
    meetingTitle: meeting.title,
    itemTitle: item.title,
    itemDescription: item.description,
    presenters: itemPresenterNames(item, names, guestNames),
    notes: item.notes,
    transcript: item.transcript,
  });
  // An empty summary would leave the item "unsummarized" and a waiting report
  // asking for it again forever.
  if (!result.summary.trim()) throw new Error("Claude returned an empty summary. Try again.");

  // The transcript or notes changed while Claude was working. That edit
  // already queued a new run; saving this one would describe old text.
  const fresh = await getAgendaItem(pool, itemId);
  if (!fresh || fresh.transcript !== item.transcript || fresh.notes !== item.notes) return;

  // Someone an action item names is evidently part of the meeting: mark them
  // present and as a presenter of this item.
  const named = new Set<number>();
  for (const ai of result.actionItems) {
    peopleNamedIn(`${ai.owner} ${ai.task}`, people).forEach((pid) => named.add(pid));
  }
  let presenterIds = fresh.presenter_ids;
  if (named.size) {
    const attendeeIds = await getAttendeeIds(pool, item.meeting_id);
    const attSet = new Set([...attendeeIds, ...named]);
    if (attSet.size !== attendeeIds.length) await setAttendees(pool, item.meeting_id, [...attSet]);
    presenterIds = [...new Set([...presenterIds, ...named])];
  }

  await updateAgendaItem(pool, itemId, {
    summary: result.summary, actionItems: result.actionItems, status: "done", presenterIds,
  });
  // Only clear our own "processing": a request that arrived meanwhile left
  // "queued", and that run is still to come.
  await pool.query(
    "UPDATE agenda_items SET summarize_status = 'idle', summarize_error = '' WHERE id = $1 AND summarize_status = 'processing'",
    [itemId]
  );
  await advanceReport(item.meeting_id);
}

// ── Report ──────────────────────────────────────────────────────────────────

export type ReportReadiness =
  | { kind: "wait" }
  | { kind: "failed"; titles: string[] }
  | { kind: "summarize"; itemIds: number[] }
  | { kind: "ready" };

// Whether a requested report can be written yet. It waits for transcription,
// then for every item with content to have a summary, asking for any missing.
export function reportReadiness(
  meeting: Pick<MeetingRow, "recording_status">,
  items: Array<Pick<AgendaItem, "id" | "title" | "transcript" | "notes" | "summary" | "transcribe_status" | "summarize_status">>
): ReportReadiness {
  if (meetingProcessing(meeting) || items.some(isTranscribing)) return { kind: "wait" };
  const missing = items.filter((it) => itemHasContent(it) && !it.summary.trim());
  if (missing.some((it) => it.summarize_status === "queued" || it.summarize_status === "processing")) {
    return { kind: "wait" };
  }
  const failed = missing.filter((it) => it.summarize_status === "error");
  if (failed.length) return { kind: "failed", titles: failed.map((it) => it.title) };
  if (missing.length) return { kind: "summarize", itemIds: missing.map((it) => it.id) };
  return { kind: "ready" };
}

export async function reportInput(dbPool: Pool, meeting: MeetingRow, items: AgendaItem[]): Promise<ReportInput> {
  const people = await listPeople(dbPool, true);
  const names = new Map(people.map((p) => [p.id, p.name]));
  const attendeeIds = new Set(await getAttendeeIds(dbPool, meeting.id));
  const guests = await listGuests(dbPool, meeting.id);
  const guestNames = new Map(guests.map((g) => [g.id, g.name]));
  return {
    title: meeting.title,
    meetingDate: meeting.meeting_date,
    location: meeting.location,
    present: people.filter((p) => attendeeIds.has(p.id)).map((p) => p.name),
    // Everyone active in the library who was not marked present.
    absent: people.filter((p) => p.active && !attendeeIds.has(p.id)).map((p) => p.name),
    guests: guests.map((g) => ({ name: g.name, title: g.title })),
    items: items.map((it) => ({
      id: it.id,
      title: it.title,
      description: it.description,
      presenters: it.presenter_ids.map((pid) => names.get(pid) ?? "").filter(Boolean),
      guestPresenters: it.guest_presenter_ids.map((gid) => guestNames.get(gid) ?? "").filter(Boolean),
      summary: it.summary,
      notes: it.notes,
      transcript: it.transcript,
      actionItems: it.action_items,
      hasContent: itemHasContent(it),
    })),
  };
}

async function currentSources(dbPool: Pool, meeting: MeetingRow): Promise<{ sources: ReportSources; items: AgendaItem[] }> {
  const items = await listAgendaItems(dbPool, meeting.id);
  return { sources: reportSources(await reportInput(dbPool, meeting, items)), items };
}

const writing = new Set<number>();

// Claude writes the report on the AI queue, after any summaries ahead of it.
function enqueueReport(meetingId: number): void {
  if (writing.has(meetingId)) return;
  writing.add(meetingId);
  aiQueue.enqueue({
    label: `report for meeting ${meetingId}`,
    run: async () => {
      try {
        const meeting = await getMeeting(pool, meetingId);
        if (!meeting || meeting.report_status !== "pending") return;
        const items = await listAgendaItems(pool, meetingId);
        // Something it depends on changed while it waited; that will call
        // advanceReport again when it finishes.
        if (reportReadiness(meeting, items).kind !== "ready") return;
        const input = await reportInput(pool, meeting, items);
        const body = await generateReportBody(pool, reportBodyInput(input));
        const built = buildReport(input, body);
        await saveReport(pool, meetingId, built.markdown, built.sources);
        log(`report written for meeting ${meetingId}`);
      } finally {
        writing.delete(meetingId);
      }
    },
    fail: async (message) => {
      await setReportStatus(pool, meetingId, "error", `The report could not be written: ${message}`);
    },
  });
}

// Move a requested report forward: wait, ask for summaries, give up, or queue
// it to be written. Called whenever something it might be waiting on finishes.
export async function advanceReport(meetingId: number): Promise<void> {
  const meeting = await getMeeting(pool, meetingId);
  if (!meeting || meeting.report_status !== "pending") return;
  const items = await listAgendaItems(pool, meetingId);
  const ready = reportReadiness(meeting, items);
  if (ready.kind === "wait") return;
  if (ready.kind === "failed") {
    await setReportStatus(pool, meetingId, "error",
      `Could not summarize ${ready.titles.join(", ")}. Check the item${ready.titles.length === 1 ? "" : "s"}, then generate again.`);
    return;
  }
  if (ready.kind === "summarize") {
    for (const id of ready.itemIds) await requestSummary(id);
    return;
  }
  enqueueReport(meetingId);
}

// Start a report. Items whose summary failed earlier get one more try.
export async function requestReport(meetingId: number): Promise<void> {
  await setReportStatus(pool, meetingId, "pending");
  for (const it of await listAgendaItems(pool, meetingId)) {
    if (it.summarize_status === "error" && itemHasContent(it) && !it.summary.trim()) await requestSummary(it.id);
  }
  await advanceReport(meetingId);
}

export interface ReportState {
  status: string;
  error: string;
  generatedAt: string | null;
  changes: string[]; // empty when the saved report matches the meeting
}

export async function reportState(dbPool: Pool, meeting: MeetingRow): Promise<ReportState> {
  let changes: string[] = [];
  if (meeting.report) {
    const { sources, items } = await currentSources(dbPool, meeting);
    changes = reportChanges(meeting.report_sources, sources, new Map(items.map((it) => [it.id, it.title])));
    // Reports from before fingerprints were kept cannot be compared item by
    // item, but an item that never got a summary is still worth flagging.
    if (!Object.keys(meeting.report_sources).length) {
      const missing = items.filter((it) => itemHasContent(it) && !it.summary.trim()).map((it) => it.title);
      if (missing.length) changes = [`Not yet summarized: ${missing.join(", ")}`];
    }
  }
  return {
    status: meeting.report_status,
    error: meeting.report_error,
    generatedAt: meeting.report_generated_at,
    changes,
  };
}

// Re-queue summaries and reports a restart interrupted.
export async function recoverMinutesWork(dbPool: Pool = pool): Promise<number> {
  const itemIds = await listUnfinishedSummaries(dbPool);
  for (const id of itemIds) await requestSummary(id);
  const meetingIds = await listPendingReports(dbPool);
  for (const id of meetingIds) await advanceReport(id);
  return itemIds.length + meetingIds.length;
}
