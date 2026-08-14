import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { extname } from "node:path";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { listPeople, peopleNamedIn } from "../people";
import {
  extractAgendaItems, isSupportedAgendaType, summarizeItem, generateReport,
} from "../claude";
import { hasAudioExtension } from "../whisper";
import { speakerStats } from "../speakers";
import {
  createMeeting, listMeetings, getMeeting, updateMeeting, deleteMeeting,
  setAttendees, getAttendeeIds, replaceAgendaItems, addAgendaItem,
  listAgendaItems, getAgendaItem, updateAgendaItem, deleteAgendaItem, saveReport,
  setTranscribeStatus, listItemStatuses, reportFileName,
  setMeetingRecordingStatus, addTopicMarker, rewriteMeetingSpeakerMap,
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

// Names for a set of person ids, in library order — used to build AI prompts.
async function nameMap(): Promise<Map<number, string>> {
  const people = await listPeople(pool, true);
  return new Map(people.map((p) => [p.id, p.name]));
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

  app.delete("/api/meetings/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    await deleteMeeting(pool, id);
    return { ok: true };
  });

  // Set the attendee list (person ids present at the meeting).
  app.put("/api/meetings/:id/attendees", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!(await getMeeting(pool, id))) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    const b = (req.body ?? {}) as { personIds?: number[] };
    await setAttendees(pool, id, (b.personIds ?? []).map(Number));
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
    });
    if (!r.ok) reply.code(r.status);
    return r;
  });

  app.delete("/api/items/:itemId", async (req) => {
    const itemId = Number((req.params as { itemId: string }).itemId);
    await deleteAgendaItem(pool, itemId);
    return { ok: true };
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
    if (!Number.isFinite(rid) || !(await getMeetingRecording(pool, rid))) {
      reply.code(404);
      return { ok: false, error: "Recording not found." };
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
      meeting: { recordingStatus: meeting.recording_status, recordingError: meeting.recording_error },
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

  // Summarize a single agenda item with Claude.
  app.post("/api/items/:itemId/summarize", async (req, reply) => {
    try {
      const itemId = Number((req.params as { itemId: string }).itemId);
      const item = await getAgendaItem(pool, itemId);
      if (!item) { reply.code(404); return { ok: false, error: "Agenda item not found." }; }
      const meeting = await getMeeting(pool, item.meeting_id);
      const names = await nameMap();
      const result = await summarizeItem(pool, {
        meetingTitle: meeting?.title ?? "",
        itemTitle: item.title,
        itemDescription: item.description,
        presenters: item.presenter_ids.map((pid) => names.get(pid) ?? "").filter(Boolean),
        notes: item.notes,
        transcript: item.transcript,
      });

      // Link people named in the action items: if an action item names someone
      // in the library, ensure they're a meeting attendee and a presenter of
      // this item.
      const people = await listPeople(pool, true);
      const named = new Set<number>();
      for (const ai of result.actionItems) {
        peopleNamedIn(`${ai.owner} ${ai.task}`, people).forEach((pid) => named.add(pid));
      }
      let attendeeIds = await getAttendeeIds(pool, item.meeting_id);
      let presenterIds = item.presenter_ids.slice();
      if (named.size) {
        const attSet = new Set(attendeeIds);
        named.forEach((pid) => attSet.add(pid));
        if (attSet.size !== attendeeIds.length) { attendeeIds = [...attSet]; await setAttendees(pool, item.meeting_id, attendeeIds); }
        const presSet = new Set(presenterIds);
        named.forEach((pid) => presSet.add(pid));
        presenterIds = [...presSet];
      }

      await updateAgendaItem(pool, itemId, { summary: result.summary, actionItems: result.actionItems, status: "done", presenterIds });
      return { ok: true, summary: result.summary, actionItems: result.actionItems, attendeeIds, presenterIds };
    } catch (e) {
      reply.code(400);
      return { ok: false, error: (e as Error).message };
    }
  });

  // Generate (or regenerate) the full meeting report.
  app.post("/api/meetings/:id/report", async (req, reply) => {
    try {
      const id = Number((req.params as { id: string }).id);
      const meeting = await getMeeting(pool, id);
      if (!meeting) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
      const items = await listAgendaItems(pool, id);
      if (!items.length) { reply.code(422); return { ok: false, error: "Add agenda items before generating a report." }; }
      const names = await nameMap();
      const attendeeIds = await getAttendeeIds(pool, id);
      const report = await generateReport(pool, {
        title: meeting.title,
        meetingDate: meeting.meeting_date,
        location: meeting.location,
        attendees: attendeeIds.map((pid) => names.get(pid) ?? "").filter(Boolean),
        items: items.map((it) => ({
          title: it.title,
          presenters: it.presenter_ids.map((pid) => names.get(pid) ?? "").filter(Boolean),
          summary: it.summary,
          notes: it.notes,
          transcript: it.transcript,
          actionItems: it.action_items,
        })),
      });
      await saveReport(pool, id, report);
      return { ok: true, report };
    } catch (e) {
      reply.code(400);
      return { ok: false, error: (e as Error).message };
    }
  });

  // Download the generated report as a Markdown file.
  app.get("/api/meetings/:id/report.md", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const meeting = await getMeeting(pool, id);
    if (!meeting) { reply.code(404); return { ok: false, error: "Meeting not found." }; }
    if (!meeting.report) { reply.code(404); return { ok: false, error: "No report has been generated yet." }; }
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${reportFileName(meeting.title, meeting.meeting_date)}"`);
    return reply.send(meeting.report);
  });
}
