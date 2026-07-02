import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { listPeople } from "../people";
import {
  extractAgendaItems, isSupportedAgendaType, summarizeItem, generateReport,
} from "../claude";
import { transcribeAudio, hasAudioExtension } from "../whisper";
import { distinctSpeakers } from "../transcript";
import {
  createMeeting, listMeetings, getMeeting, updateMeeting, deleteMeeting,
  setAttendees, getAttendeeIds, replaceAgendaItems, addAgendaItem,
  listAgendaItems, getAgendaItem, updateAgendaItem, deleteAgendaItem, saveReport,
} from "../meetings";

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
    return {
      ok: true,
      meeting,
      attendeeIds: await getAttendeeIds(pool, id),
      items: await listAgendaItems(pool, id),
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

  // Transcribe (and diarize) a recording for an item. Replaces the item's
  // transcript with the speaker-attributed result. When exactly one speaker is
  // detected and the item has presenter(s), auto-map that speaker to the first
  // presenter so the transcript is named without manual mapping.
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
      const result = await transcribeAudio(file);
      const speakers = distinctSpeakers(result.segments);

      const names = await nameMap();
      const speakerMap: Record<string, string> = {};
      if (speakers.length === 1 && item.presenter_ids.length) {
        const name = names.get(item.presenter_ids[0]);
        if (name) speakerMap[speakers[0]] = name;
      }

      await updateAgendaItem(pool, itemId, { transcriptSegments: result.segments, speakerMap });
      const updated = await getAgendaItem(pool, itemId);
      return {
        ok: true,
        transcript: updated?.transcript ?? result.text,
        speakers,
        speakerMap: updated?.speaker_map ?? speakerMap,
      };
    } catch (e) {
      return uploadErrorResponse(reply, e);
    }
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
      await updateAgendaItem(pool, itemId, { summary: result.summary, actionItems: result.actionItems, status: "done" });
      return { ok: true, summary: result.summary, actionItems: result.actionItems };
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
}
