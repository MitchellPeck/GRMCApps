import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { extname } from "node:path";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { config } from "../config";
import { extractAgendaItems, isSupportedAgendaType } from "../claude";
import { reportHtml } from "../report";
import { stripRangeMarkers } from "../ranges";
import {
  EDIT_SUMMARY_DELAY_MS, itemHasContent, reportState, requestReport, requestSummary,
} from "../minutesWork";
import {
  GoogleClient, NeedsConsentError, accessToken, consentUrl, createDoc, exchangeCode, finishConsent, startConsent,
} from "../google";
import { hasAudioExtension } from "../whisper";
import { speakerStats } from "../speakers";
import { extractClip, openSection } from "../chunking";
import {
  createMeeting, listMeetings, getMeeting, updateMeeting, deleteMeeting,
  setAttendees, getAttendeeIds, replaceAgendaItems, addAgendaItem,
  listAgendaItems, getAgendaItem, updateAgendaItem, deleteAgendaItem,
  setTranscribeStatus, listItemStatuses, reportFileName,
  setMeetingRecordingStatus, addTopicMarker, rewriteMeetingSpeakerMap,
  listGuests, addGuest, removeGuest, reportEdited, saveReportEdit, cancelReport,
} from "../meetings";
import { enqueueTranscription, enqueueStoredRecording, enqueueMeetingProcessing } from "../transcribeQueue";
import {
  saveRecording, getRecording, listRecordings,
  createMeetingRecording, appendMeetingChunk, finishMeetingRecording, getMeetingRecording, listMeetingRecordings,
} from "../recordings";

interface UploadFile { fileName: string; mimeType: string; buffer: Buffer }

// Pull a single file part + text fields out of a multipart request.
async function readMultipart(req: FastifyRequest): Promise<{ fields: Record<string, string>; file: UploadFile | null }> {
  const fields: Record<string, string> = {};
  let file: UploadFile | null = null;
  for await (const part of req.parts()) {
    if (part.type === "file") {
      const buffer = await part.toBuffer();
      file = { fileName: part.filename, mimeType: part.mimetype, buffer };
    } else {
      fields[part.fieldname] = String(part.value ?? "");
    }
  }
  return { fields, file };
}

function uploadErrorResponse(reply: FastifyReply, e: unknown): { ok: false; error: string } {
  if ((e as { code?: string })?.code === "FST_REQ_FILE_TOO_LARGE") {
    reply.code(400);
    return { ok: false, error: "File is too large (max 50 MB)." };
  }
  reply.code(500);
  return { ok: false, error: (e as Error).message };
}

function googleClient(): GoogleClient | null {
  if (!config.googleClientId || !config.googleClientSecret || !config.publicUrl) return null;
  return {
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: `${config.publicUrl}/api/google/callback`,
  };
}

// A minimal page for the Google Docs tab when something goes wrong: that tab
// was opened just for the export, so a JSON error there would be a dead end.
function messagePage(reply: FastifyReply, status: number, title: string, text: string): FastifyReply {
  const e = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return reply.code(status).type("text/html; charset=utf-8").send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${e(title)}</title>`
    + `<link rel="stylesheet" href="/assets/grmc.css"></head>`
    + `<body style="padding:32px;max-width:640px;margin:auto"><h2>${e(title)}</h2><p>${e(text)}</p>`
    + `<p><a href="/">Back to Meeting Minutes</a></p></body></html>`
  );
}

// One section of a stored recording as MP3, streamed, for the ▶ on a part of
// the minutes. start/end are seconds on that recording's timeline.
export async function sendSection(
  reply: FastifyReply,
  storagePath: string | undefined,
  query: { start?: string; end?: string }
): Promise<unknown> {
  const start = Number(query.start), end = Number(query.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) {
    reply.code(400); return { ok: false, error: "Give a start and end time." };
  }
  if (!storagePath) { reply.code(404); return { ok: false, error: "Recording not found." }; }
  if (!existsSync(storagePath)) { reply.code(404); return { ok: false, error: "Recording file is missing." }; }
  try {
    const sec = await openSection(storagePath, start, end - start);
    if (!sec) { reply.code(416); return { ok: false, error: "That part of the recording doesn't exist." }; }
    // Stop cutting when the listener stops or moves to another section.
    reply.raw.on("close", sec.kill);
    reply.header("content-type", "audio/mpeg");
    reply.header("cache-control", "private, max-age=3600");
    return reply.send(sec.stream);
  } catch (e) {
    reply.code(500); return { ok: false, error: (e as Error).message };
  }
}

export async function meetingsRoutes(app: FastifyInstance): Promise<void> {
  // List all meetings.
  app.get("/api/meetings", async () => {
    try { return { ok: true, meetings: await listMeetings(pool) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  // Full detail: meeting + attendee ids + agenda items (with presenter ids).
  app.get("/api/meetings/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const meeting = await getMeeting(pool, id);
    if (!meeting) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    const items = await listAgendaItems(pool, id);
    const withRecordings = await Promise.all(
      items.map(async (it) => ({ ...it, recordings: await listRecordings(pool, it.id) }))
    );
    const meetingSourced = withRecordings.filter((it) => it.transcript_source === "meeting");
    const meetingSpeakerStats = speakerStats(
      meetingSourced.flatMap((it) => it.transcript_segments).slice().sort((a, b) => a.start - b.start)
    );
    return {
      ok: true,
      meeting,
      attendeeIds: await getAttendeeIds(pool, id),
      items: withRecordings,
      meetingRecordings: await listMeetingRecordings(pool, id),
      meetingSpeakerStats,
      guests: await listGuests(pool, id),
      report: await reportState(pool, meeting),
    };
  });

  // Create a meeting.
  app.post("/api/meetings", async (req, reply) => {
    const idn = getIdentity(req);
    const b = (req.body ?? {}) as { title?: string; meetingDate?: string; location?: string; description?: string };
    const r = await createMeeting(pool, {
      title: b.title ?? "",
      meetingDate: b.meetingDate ?? "",
      location: b.location ?? "",
      description: b.description ?? "",
      email: idn.email,
      name: idn.name,
    });
    if (!r.ok) reply.code(r.status);
    return r;
  });

  // Update meeting fields (title/date/location/description/status).
  app.patch("/api/meetings/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as any;
    const r = await updateMeeting(pool, id, b);
    if (!r.ok) reply.code(r.status);
    return r;
  });

  // Deleting is idempotent — an id that is already gone is a success — but a
  // malformed id or a failed delete must say so. Returning {ok:true} while the
  // meeting is still there is the worst possible outcome here.
  app.delete("/api/meetings/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      reply.code(400);
      return { ok: false, error: "Invalid meeting id." };
    }
    try {
      await deleteMeeting(pool, id);
      return { ok: true };
    } catch (e) {
      req.log.error(e, `failed to delete meeting ${id}`);
      reply.code(500);
      return { ok: false, error: `Could not delete the meeting: ${(e as Error).message}` };
    }
  });

  // Set the attendee list (person ids present at the meeting).
  app.put("/api/meetings/:id/attendees", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!(await getMeeting(pool, id))) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    const b = (req.body ?? {}) as { personIds?: number[] };
    await setAttendees(pool, id, (b.personIds ?? []).map(Number));
    return { ok: true };
  });

  // Guests: people at this one meeting who are not in the library.
  app.post("/api/meetings/:id/guests", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id) || !(await getMeeting(pool, id))) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    const b = (req.body ?? {}) as { name?: string; title?: string };
    const r = await addGuest(pool, id, b.name ?? "", b.title ?? "");
    if (!r.ok) { reply.code(r.status); return r; }
    return { ok: true, id: r.id, guests: await listGuests(pool, id) };
  });

  app.delete("/api/guests/:gid", async (req, reply) => {
    const gid = Number((req.params as { gid: string }).gid);
    if (!Number.isSafeInteger(gid) || gid <= 0) { reply.code(400); return { ok: false, error: "Invalid guest id." }; }
    await removeGuest(pool, gid);
    return { ok: true };
  });

  // Save the meeting-wide speaker→name map and re-render every meeting-sourced
  // topic against it (one transaction; see rewriteMeetingSpeakerMap).
  app.put("/api/meetings/:id/speaker-map", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id) || !(await getMeeting(pool, id))) {
      reply.code(404);
      return { ok: false, error: "Meeting not found." };
    }
    const b = (req.body ?? {}) as { speakerMap?: unknown };
    if (!b.speakerMap || typeof b.speakerMap !== "object" || Array.isArray(b.speakerMap)) {
      reply.code(400);
      return { ok: false, error: "speakerMap must be an object." };
    }
    await rewriteMeetingSpeakerMap(pool, id, b.speakerMap as Record<string, unknown>);
    // The rewrite cleared every meeting-sourced summary; write them again.
    for (const it of await listAgendaItems(pool, id)) {
      if (it.transcript_source === "meeting" && itemHasContent(it)) await requestSummary(it.id);
    }
    return { ok: true };
  });

  // Upload an agenda file → extract items → replace the meeting's agenda.
  app.post("/api/meetings/:id/agenda", async (req, reply) => {
    try {
      const id = Number((req.params as { id: string }).id);
      if (!(await getMeeting(pool, id))) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
      const { file } = await readMultipart(req);
      if (!file) { reply.code(400); return { ok: false, error: "An agenda file is required." }; }
      if (!isSupportedAgendaType(file.mimeType)) {
        reply.code(400);
        return { ok: false, error: "Unsupported file type. Upload a PDF, image, or plain-text agenda." };
      }
      const items = await extractAgendaItems(pool, file);
      if (!items.length) {
        reply.code(422);
        return { ok: false, error: "No agenda items could be extracted from that file." };
      }
      await replaceAgendaItems(pool, id, items, file.fileName);
      return { ok: true, items: await listAgendaItems(pool, id) };
    } catch (e) {
      return uploadErrorResponse(reply, e);
    }
  });

  // Manually add a single agenda item.
  app.post("/api/meetings/:id/items", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!(await getMeeting(pool, id))) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    const b = (req.body ?? {}) as { title?: string; description?: string };
    const r = await addAgendaItem(pool, id, b.title ?? "", b.description ?? "");
    if (!r.ok) reply.code(r.status);
    return r;
  });

  // Patch an agenda item: presenters, notes, transcript, status, speaker map.
  app.patch("/api/items/:itemId", async (req, reply) => {
    const itemId = Number((req.params as { itemId: string }).itemId);
    const b = (req.body ?? {}) as any;
    const existing = await getAgendaItem(pool, itemId);
    if (!existing) { reply.code(404); return { ok: false, error: "Agenda item not found." }; }
    // New words or new speaker names make the summary stale. Clear it and
    // summarize again once the edits settle, whether or not the page stays open.
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
    if (!r.ok) { reply.code(r.status); return r; }
    if (contentChanged) await requestSummary(itemId, EDIT_SUMMARY_DELAY_MS);
    return { ...r, summaryQueued: contentChanged };
  });

  app.delete("/api/items/:itemId", async (req, reply) => {
    const itemId = Number((req.params as { itemId: string }).itemId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      reply.code(400);
      return { ok: false, error: "Invalid item id." };
    }
    try {
      await deleteAgendaItem(pool, itemId);
      return { ok: true };
    } catch (e) {
      req.log.error(e, `failed to delete agenda item ${itemId}`);
      reply.code(500);
      return { ok: false, error: `Could not remove the item: ${(e as Error).message}` };
    }
  });

  // Accept a recording for an item and queue it for transcription. The audio is
  // written to the data volume BEFORE the job is queued, so a container restart
  // can resume it and the recording is always recoverable. Returns immediately —
  // the caller polls /api/meetings/:id/status for progress.
  app.post("/api/items/:itemId/transcribe", async (req, reply) => {
    try {
      const itemId = Number((req.params as { itemId: string }).itemId);
      const item = await getAgendaItem(pool, itemId);
      if (!item) { reply.code(404); return { ok: false, error: "Agenda item not found." }; }
      const { file } = await readMultipart(req);
      if (!file) { reply.code(400); return { ok: false, error: "An audio file is required." }; }
      if (!file.mimeType.startsWith("audio/") && !file.mimeType.startsWith("video/") && !hasAudioExtension(file.fileName)) {
        reply.code(400);
        return { ok: false, error: "Upload an audio recording (mp3, m4a, wav, webm, …)." };
      }
      const rec = await saveRecording(pool, itemId, file);
      await setTranscribeStatus(pool, itemId, "queued");
      enqueueTranscription({
        itemId,
        recordingId: rec.id,
        path: rec.storage_path,
        fileName: rec.file_name,
        mimeType: rec.mime_type,
      });
      reply.code(202);
      return { ok: true, recordingId: rec.id, status: "queued" };
    } catch (e) {
      return uploadErrorResponse(reply, e);
    }
  });

  // Re-run transcription on a recording that is already stored.
  app.post("/api/items/:itemId/retranscribe", async (req, reply) => {
    const itemId = Number((req.params as { itemId: string }).itemId);
    const b = (req.body ?? {}) as { recordingId?: number };
    const recordingId = Number(b.recordingId);
    if (!Number.isFinite(recordingId)) { reply.code(400); return { ok: false, error: "A recordingId is required." }; }
    const queued = await enqueueStoredRecording(itemId, recordingId);
    if (!queued) { reply.code(404); return { ok: false, error: "That recording is no longer available." }; }
    reply.code(202);
    return { ok: true, status: "queued" };
  });

  // Start a whole-meeting recording: create the (empty) file + row and flip
  // the meeting into "recording". Chunks then append via /chunk below.
  app.post("/api/meetings/:id/recording/start", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id) || !(await getMeeting(pool, id))) {
      reply.code(404);
      return { ok: false, error: "Meeting not found." };
    }
    const b = (req.body ?? {}) as { mimeType?: string };
    const rec = await createMeetingRecording(pool, id, b.mimeType ?? "");
    await setMeetingRecordingStatus(pool, id, "recording");
    return { ok: true, recordingId: rec.id };
  });

  // Append one uploaded chunk to a whole-meeting recording (multipart file).
  app.post("/api/meeting-recordings/:rid/chunk", async (req, reply) => {
    try {
      const rid = Number((req.params as { rid: string }).rid);
      if (!Number.isFinite(rid)) { reply.code(404); return { ok: false, error: "Recording not found." }; }
      const { file } = await readMultipart(req);
      if (!file) { reply.code(400); return { ok: false, error: "An audio chunk is required." }; }
      const byteSize = await appendMeetingChunk(pool, rid, file.buffer);
      return { ok: true, byteSize };
    } catch (e) {
      if ((e as Error).message === "Recording not found.") {
        reply.code(404);
        return { ok: false, error: "Recording not found." };
      }
      return uploadErrorResponse(reply, e);
    }
  });

  // Record a topic switch while capturing: "at second N the meeting moved to
  // item X". Processing turns these into per-item audio windows.
  app.post("/api/meeting-recordings/:rid/marker", async (req, reply) => {
    const rid = Number((req.params as { rid: string }).rid);
    const b = (req.body ?? {}) as { itemId?: number; atSeconds?: number };
    const itemId = Number(b.itemId);
    const atSeconds = Number(b.atSeconds);
    if (!Number.isFinite(itemId) || !Number.isFinite(atSeconds)) {
      reply.code(400);
      return { ok: false, error: "itemId and atSeconds must be numbers." };
    }
    const rec = Number.isFinite(rid) ? await getMeetingRecording(pool, rid) : null;
    if (!rec) {
      reply.code(404);
      return { ok: false, error: "Recording not found." };
    }
    const item = await getAgendaItem(pool, itemId);
    if (!item || item.meeting_id !== rec.meeting_id) {
      reply.code(400);
      return { ok: false, error: "That agenda item does not belong to this recording's meeting." };
    }
    await addTopicMarker(pool, rid, itemId, atSeconds);
    return { ok: true };
  });

  // Stop capturing: stamp the recording finished and queue it for processing.
  app.post("/api/meeting-recordings/:rid/finish", async (req, reply) => {
    const rid = Number((req.params as { rid: string }).rid);
    const rec = Number.isFinite(rid) ? await getMeetingRecording(pool, rid) : null;
    if (!rec) { reply.code(404); return { ok: false, error: "Recording not found." }; }
    await finishMeetingRecording(pool, rid);
    const queued = await enqueueMeetingProcessing(rec.meeting_id, rid);
    if (!queued) { reply.code(404); return { ok: false, error: "That recording is no longer available." }; }
    reply.code(202);
    return { ok: true, status: "queued" };
  });

  // Retry / reprocess a stored whole-meeting recording without re-stamping it
  // finished (used after a processing failure, or to redo a segmentation).
  app.post("/api/meeting-recordings/:rid/reprocess", async (req, reply) => {
    const rid = Number((req.params as { rid: string }).rid);
    const rec = Number.isFinite(rid) ? await getMeetingRecording(pool, rid) : null;
    if (!rec) { reply.code(404); return { ok: false, error: "Recording not found." }; }
    const queued = await enqueueMeetingProcessing(rec.meeting_id, rid);
    if (!queued) { reply.code(404); return { ok: false, error: "That recording is no longer available." }; }
    reply.code(202);
    return { ok: true, status: "queued" };
  });

  // Lightweight poll for the meeting detail view: per-item job state plus the
  // attendee list, which summarization can change behind the user's back.
  app.get("/api/meetings/:id/status", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const meeting = await getMeeting(pool, id);
    if (!meeting) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    return {
      ok: true,
      items: await listItemStatuses(pool, id),
      attendeeIds: await getAttendeeIds(pool, id),
      guests: await listGuests(pool, id),
      meeting: { recordingStatus: meeting.recording_status, recordingError: meeting.recording_error },
      report: await reportState(pool, meeting),
    };
  });

  // Stream a stored recording back. Recordings are kept for the life of the
  // meeting so the original audio is always retrievable.
  app.get("/api/recordings/:id/download", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rec = await getRecording(pool, id);
    if (!rec || !rec.storage_path) { reply.code(404); return { ok: false, error: "Recording not found." }; }
    if (!existsSync(rec.storage_path)) { reply.code(404); return { ok: false, error: "Recording file is missing." }; }
    // Header-safe: strip quote/backslash/CR/LF and any non-ASCII (Node rejects
    // chars > 0xFF in header values), falling back to a generated name.
    const cleaned = (rec.file_name || "").replace(/["\\\r\n]/g, "").replace(/[^\x20-\x7E]/g, "").trim();
    const safeName = cleaned || `recording-${rec.id}`;
    reply.header("content-type", rec.mime_type || "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${safeName}"`);
    return reply.send(createReadStream(rec.storage_path));
  });

  // Stream a stored whole-meeting recording back, same lifetime/hygiene as
  // the per-item download above. There is no stored file_name, so the
  // filename is built from the ids plus the extension already on disk.
  app.get("/api/meeting-recordings/:rid/download", async (req, reply) => {
    const rid = Number((req.params as { rid: string }).rid);
    const rec = Number.isFinite(rid) ? await getMeetingRecording(pool, rid) : null;
    if (!rec || !rec.storage_path) { reply.code(404); return { ok: false, error: "Recording not found." }; }
    if (!existsSync(rec.storage_path)) { reply.code(404); return { ok: false, error: "Recording file is missing." }; }
    const ext = extname(rec.storage_path).replace(/^\./, "") || "webm";
    const rawName = `meeting-${rec.meeting_id}-recording-${rec.id}.${ext}`;
    const cleaned = rawName.replace(/["\\\r\n]/g, "").replace(/[^\x20-\x7E]/g, "").trim();
    const safeName = cleaned || `meeting-recording-${rec.id}`;
    reply.header("content-type", rec.mime_type || "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${safeName}"`);
    return reply.send(createReadStream(rec.storage_path));
  });

  // A few seconds of a whole-meeting recording, for listening to one speaker
  // sample in "Who spoke in this meeting?". start/end are seconds from the
  // start of the recording (the transcript's timeline); capped server-side.
  app.get("/api/meeting-recordings/:rid/clip", async (req, reply) => {
    const rid = Number((req.params as { rid: string }).rid);
    const q = req.query as { start?: string; end?: string };
    const start = Number(q.start), end = Number(q.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) {
      reply.code(400); return { ok: false, error: "Give a start and end time." };
    }
    const rec = Number.isFinite(rid) ? await getMeetingRecording(pool, rid) : null;
    if (!rec || !rec.storage_path) { reply.code(404); return { ok: false, error: "Recording not found." }; }
    if (!existsSync(rec.storage_path)) { reply.code(404); return { ok: false, error: "Recording file is missing." }; }
    try {
      const wav = await extractClip(rec.storage_path, start, end - start);
      reply.header("content-type", "audio/wav");
      reply.header("cache-control", "private, max-age=3600");
      return reply.send(wav);
    } catch (e) {
      reply.code(500); return { ok: false, error: (e as Error).message };
    }
  });

  app.get("/api/meeting-recordings/:rid/section", async (req, reply) => {
    const rid = Number((req.params as { rid: string }).rid);
    const rec = Number.isFinite(rid) ? await getMeetingRecording(pool, rid) : null;
    return sendSection(reply, rec?.storage_path, req.query as { start?: string; end?: string });
  });

  app.get("/api/recordings/:id/section", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rec = Number.isFinite(id) ? await getRecording(pool, id) : null;
    return sendSection(reply, rec?.storage_path, req.query as { start?: string; end?: string });
  });

  // Summarize one agenda item now (the browser asks when an item is closed).
  // Queued on the server; the status poll reports when it lands.
  app.post("/api/items/:itemId/summarize", async (req, reply) => {
    const itemId = Number((req.params as { itemId: string }).itemId);
    const item = Number.isFinite(itemId) ? await getAgendaItem(pool, itemId) : null;
    if (!item) { reply.code(404); return { ok: false, error: "Agenda item not found." }; }
    if (!itemHasContent(item)) return { ok: true, status: "idle" };
    await requestSummary(itemId);
    reply.code(202);
    return { ok: true, status: "queued" };
  });

  // Generate (or regenerate) the report. It waits on the server for any
  // transcription and summaries still to come, then writes itself.
  app.post("/api/meetings/:id/report", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const meeting = Number.isFinite(id) ? await getMeeting(pool, id) : null;
    if (!meeting) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    const items = await listAgendaItems(pool, id);
    if (!items.length) { reply.code(422); return { ok: false, error: "Add agenda items before generating a report." }; }
    const b = (req.body ?? {}) as { replaceEdits?: unknown };
    if (reportEdited(meeting) && b.replaceEdits !== true) {
      reply.code(409);
      return { ok: false, edited: true, error: "Regenerating replaces the edits you've made to these minutes." };
    }
    await requestReport(id);
    const after = await getMeeting(pool, id);
    if (!after) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    return {
      ok: true,
      report: await reportState(pool, after),
      markdown: after.report_status === "idle" ? after.report : undefined,
    };
  });

  // Stop writing a report, e.g. one stuck waiting on a topic.
  app.post("/api/meetings/:id/report/cancel", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const meeting = Number.isFinite(id) ? await getMeeting(pool, id) : null;
    if (!meeting) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    await cancelReport(pool, id);
    return { ok: true, report: await reportState(pool, (await getMeeting(pool, id))!) };
  });

  // Save the minutes after editing them on the page.
  app.put("/api/meetings/:id/report", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const meeting = Number.isFinite(id) ? await getMeeting(pool, id) : null;
    if (!meeting) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    const b = (req.body ?? {}) as { markdown?: unknown };
    if (typeof b.markdown !== "string") { reply.code(400); return { ok: false, error: "markdown must be text." }; }
    if (meeting.report_status === "pending") {
      reply.code(409); return { ok: false, error: "The report is being written. Try again when it finishes, or cancel it." };
    }
    if (!meeting.report_generated_at) { reply.code(409); return { ok: false, error: "Generate the report first." }; }
    await saveReportEdit(pool, id, b.markdown);
    const after = await getMeeting(pool, id);
    return { ok: true, report: await reportState(pool, after!) };
  });

  // "Open in Google Docs": opened in its own tab. Sends the user through
  // Google consent the first time, then creates the Doc and redirects to it.
  app.get("/api/meetings/:id/google-doc", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const meeting = Number.isFinite(id) ? await getMeeting(pool, id) : null;
    if (!meeting) return messagePage(reply, 404, "Meeting not found", "That meeting no longer exists.");
    if (!meeting.report || !meeting.report_generated_at) {
      return messagePage(reply, 404, "No report yet", "Generate the report first, then open it in Google Docs.");
    }
    const client = googleClient();
    if (!client) {
      return messagePage(reply, 503, "Google Docs export is not set up",
        "The server needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and BASE_DOMAIN. Ask the administrator.");
    }
    const { email } = getIdentity(req);
    if (!email) return messagePage(reply, 401, "Not signed in", "Sign in through the GRMC hub and try again.");

    // The same report opened twice goes to the same Doc; once it has been
    // edited, the next export is a new Doc with the edits.
    const reportAt = meeting.report_updated_at ?? meeting.report_generated_at;
    const existing = await pool.query(
      "SELECT doc_url FROM report_docs WHERE meeting_id = $1 AND email = $2 AND report_at = $3",
      [id, email, reportAt]
    );
    if (existing.rows[0]) return reply.redirect(existing.rows[0].doc_url);

    try {
      const token = await accessToken(pool, client, email);
      const name = [meeting.title, "Minutes", meeting.meeting_date].filter(Boolean).join(" — ");
      const url = await createDoc(token, name, reportHtml(meeting.report, name));
      await pool.query(
        `INSERT INTO report_docs (meeting_id, email, doc_url, report_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (meeting_id, email) DO UPDATE SET doc_url = $3, report_at = $4`,
        [id, email, url, reportAt]
      );
      return reply.redirect(url);
    } catch (e) {
      if (e instanceof NeedsConsentError) return reply.redirect(consentUrl(client, startConsent(email, id), email));
      req.log.error(e, `google doc export failed for meeting ${id}`);
      return messagePage(reply, 502, "Could not create the Google Doc", (e as Error).message);
    }
  });

  // Google sends the user back here after consent.
  app.get("/api/google/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const client = googleClient();
    if (!client) return messagePage(reply, 503, "Google Docs export is not set up", "Ask the administrator.");
    const { email } = getIdentity(req);
    const meetingId = q.state ? finishConsent(q.state, email) : null;
    if (q.error) {
      return messagePage(reply, 400, "Google Drive access was not granted",
        "Without it the report cannot be saved to Google Docs. Close this tab, or try the button again.");
    }
    if (meetingId === null || !q.code) {
      return messagePage(reply, 400, "That sign-in link has expired", "Close this tab and click “Open in Google Docs” again.");
    }
    try {
      await exchangeCode(pool, client, email, q.code);
    } catch (e) {
      req.log.error(e, "google consent exchange failed");
      return messagePage(reply, 502, "Could not connect Google Drive", (e as Error).message);
    }
    return reply.redirect(`/api/meetings/${meetingId}/google-doc`);
  });

  // Download the generated report as a Markdown file.
  app.get("/api/meetings/:id/report.md", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const meeting = await getMeeting(pool, id);
    if (!meeting) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    if (!meeting.report) { reply.code(404); return { ok: false, error: "No report has been generated yet." }; }
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${reportFileName(meeting.title, meeting.meeting_date)}"`);
    return reply.send(stripRangeMarkers(meeting.report));
  });
}
