import { Pool } from "pg";
import { renameTopicSpeakers } from "./fixes";
import { getAgendaItem, getMeeting, listAgendaItems, rewriteMeetingSpeakerMap, updateAgendaItem } from "./meetings";
import { EDIT_SUMMARY_DELAY_MS, itemHasContent, requestSummary } from "./minutesWork";

// Actions shared by the page's routes and the chat, so the same request does
// the same thing whichever way it arrives.

export type ActionResult = { status: number; body: Record<string, unknown> };

// Change an agenda item: title, description, notes, transcript, presenters,
// speaker names. New words or names make its summary stale; once the minutes
// exist, a speaker rename corrects them in place instead.
export async function patchItem(pool: Pool, itemId: number, input: Record<string, any>, by = ""): Promise<ActionResult> {
  const b = { ...input };
  const existing = await getAgendaItem(pool, itemId);
  if (!existing) return { status: 404, body: { ok: false, error: "Agenda item not found." } };
  // A recorded transcript is rendered from its segments; free text written
  // over it would be lost at the next re-render.
  if (typeof b.transcript === "string" && b.transcript !== existing.transcript && existing.transcript_segments.length) {
    return { status: 409, body: { ok: false, error: "This transcript comes from the recording; fix words with “Fix a name or word”." } };
  }
  const meeting = await getMeeting(pool, existing.meeting_id);
  if (meeting?.report_generated_at && b.speakerMap && typeof b.speakerMap === "object"
      && JSON.stringify(b.speakerMap) !== JSON.stringify(existing.speaker_map)) {
    await renameTopicSpeakers(pool, itemId, b.speakerMap, by);
    delete b.speakerMap;
  }
  const contentChanged =
    (typeof b.transcript === "string" && b.transcript !== existing.transcript)
    || (typeof b.notes === "string" && b.notes !== existing.notes)
    || (typeof b.appendTranscript === "string" && !!b.appendTranscript.trim())
    || (!!b.speakerMap && typeof b.speakerMap === "object"
      && JSON.stringify(b.speakerMap) !== JSON.stringify(existing.speaker_map));
  if (contentChanged) { b.summary = ""; b.actionItems = []; b.status = "pending"; }
  const r = await updateAgendaItem(pool, itemId, {
    title: b.title,
    description: b.description,
    status: b.status,
    notes: b.notes,
    transcript: b.transcript,
    appendTranscript: b.appendTranscript,
    speakerMap: b.speakerMap && typeof b.speakerMap === "object" ? b.speakerMap : undefined,
    summary: b.summary,
    actionItems: Array.isArray(b.actionItems) ? b.actionItems : undefined,
    presenterIds: b.presenterIds ? (b.presenterIds as any[]).map(Number) : undefined,
    guestPresenterIds: Array.isArray(b.guestPresenterIds) ? (b.guestPresenterIds as any[]).map(Number) : undefined,
  });
  if (!r.ok) return { status: r.status, body: r as any };
  if (contentChanged) await requestSummary(itemId, EDIT_SUMMARY_DELAY_MS);
  return { status: 200, body: { ...r, summaryQueued: contentChanged } };
}

// Name the meeting's voices. Without minutes yet, every whole-meeting summary
// is cleared and written again; with minutes, they are corrected in place.
export async function saveMeetingSpeakers(pool: Pool, meetingId: number, map: Record<string, unknown>): Promise<void> {
  const hadReport = !!(await getMeeting(pool, meetingId))?.report_generated_at;
  await rewriteMeetingSpeakerMap(pool, meetingId, map);
  if (hadReport) return;
  for (const it of await listAgendaItems(pool, meetingId)) {
    if (it.transcript_source === "meeting" && itemHasContent(it)) await requestSummary(it.id);
  }
}
