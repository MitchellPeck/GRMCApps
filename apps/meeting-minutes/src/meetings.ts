import { Pool } from "pg";
import { ExtractedItem, ActionItem } from "./claude";
import { DiarizedSegment } from "./whisper";
import { SpeakerMap, renderTranscript } from "./transcript";
import { listPeople, matchPersonByName } from "./people";
import { SpeakerStat, speakerStats } from "./speakers";
import { removeRecordingFiles, removeMeetingRecordingFiles } from "./recordings";
import { chronologicalSpeakerOrder } from "./segmentation";

export type MeetingRecordingStatus = "idle" | "recording" | "queued" | "processing" | "done" | "error";

export interface MeetingRow {
  id: number;
  title: string;
  meeting_date: string;
  location: string;
  description: string;
  status: string;
  agenda_file_name: string;
  report: string;
  report_generated_at: string | null;
  recording_status: MeetingRecordingStatus;
  recording_error: string;
  speaker_map: SpeakerMap;
  created_by_email: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
}

export type TranscribeStatus = "idle" | "queued" | "processing" | "done" | "error";

export interface AgendaItem {
  id: number;
  meeting_id: number;
  position: number;
  title: string;
  description: string;
  status: string;
  notes: string;
  transcript: string;
  transcript_segments: DiarizedSegment[];
  speaker_map: SpeakerMap;
  summary: string;
  action_items: ActionItem[];
  transcribe_status: TranscribeStatus;
  transcribe_error: string;
  speaker_stats: SpeakerStat[];
  transcript_source: string;
  presenter_ids: number[];
}

function mapItemRow(row: any, presenterIds: number[]): AgendaItem {
  return {
    id: Number(row.id),
    meeting_id: Number(row.meeting_id),
    position: Number(row.position),
    title: row.title,
    description: row.description,
    status: row.status,
    notes: row.notes,
    transcript: row.transcript,
    transcript_segments: Array.isArray(row.transcript_segments) ? row.transcript_segments : [],
    speaker_map: row.speaker_map && typeof row.speaker_map === "object" ? row.speaker_map : {},
    summary: row.summary,
    action_items: Array.isArray(row.action_items) ? row.action_items : [],
    transcribe_status: (row.transcribe_status ?? "idle") as TranscribeStatus,
    transcribe_error: row.transcribe_error ?? "",
    speaker_stats: speakerStats(Array.isArray(row.transcript_segments) ? row.transcript_segments : []),
    transcript_source: row.transcript_source ?? "",
    presenter_ids: presenterIds,
  };
}

export type Result<T> = { ok: true; status: number } & T | { ok: false; status: number; error: string };

// ── Meetings ────────────────────────────────────────────────────────────────

export async function createMeeting(
  pool: Pool,
  input: { title: string; meetingDate: string; location: string; description: string; email: string; name: string }
): Promise<Result<{ id: number }>> {
  const title = input.title.trim();
  if (!title) return { ok: false, status: 400, error: "A meeting title is required." };
  const r = await pool.query(
    `INSERT INTO meetings (title, meeting_date, location, description, created_by_email, created_by_name)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [title, input.meetingDate.trim(), input.location.trim(), input.description.trim(), input.email, input.name]
  );
  return { ok: true, status: 200, id: Number(r.rows[0].id) };
}

export async function listMeetings(pool: Pool): Promise<Array<MeetingRow & { item_count: number; attendee_count: number }>> {
  const r = await pool.query(`
    SELECT m.*,
      (SELECT count(*) FROM agenda_items ai WHERE ai.meeting_id = m.id) AS item_count,
      (SELECT count(*) FROM meeting_attendees ma WHERE ma.meeting_id = m.id) AS attendee_count
    FROM meetings m
    ORDER BY m.created_at DESC
  `);
  return r.rows.map((row) => ({
    ...row,
    id: Number(row.id),
    item_count: Number(row.item_count),
    attendee_count: Number(row.attendee_count),
  }));
}

export async function getMeeting(pool: Pool, id: number): Promise<MeetingRow | null> {
  const r = await pool.query("SELECT * FROM meetings WHERE id = $1", [id]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    recording_status: (row.recording_status ?? "idle") as MeetingRecordingStatus,
    recording_error: row.recording_error ?? "",
    speaker_map: row.speaker_map && typeof row.speaker_map === "object" ? row.speaker_map : {},
  };
}

export async function updateMeeting(
  pool: Pool,
  id: number,
  fields: { title?: string; meetingDate?: string; location?: string; description?: string; status?: string }
): Promise<Result<{}>> {
  const sets: string[] = [];
  const vals: any[] = [id];
  const add = (col: string, val: string) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
  if (fields.title !== undefined) {
    if (!fields.title.trim()) return { ok: false, status: 400, error: "Title cannot be empty." };
    add("title", fields.title.trim());
  }
  if (fields.meetingDate !== undefined) add("meeting_date", fields.meetingDate.trim());
  if (fields.location !== undefined) add("location", fields.location.trim());
  if (fields.description !== undefined) add("description", fields.description.trim());
  if (fields.status !== undefined) add("status", fields.status.trim());
  if (!sets.length) return { ok: true, status: 200 };
  const r = await pool.query(
    `UPDATE meetings SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING id`,
    vals
  );
  if (!r.rows[0]) return { ok: false, status: 404, error: "Meeting not found." };
  return { ok: true, status: 200 };
}

export async function deleteMeeting(pool: Pool, id: number): Promise<void> {
  const items = await pool.query("SELECT id FROM agenda_items WHERE meeting_id = $1", [id]);
  await removeRecordingFiles(pool, items.rows.map((r) => Number(r.id)));
  await removeMeetingRecordingFiles(pool, id);
  await pool.query("DELETE FROM meetings WHERE id = $1", [id]);
}

// ── Attendees ───────────────────────────────────────────────────────────────

export async function setAttendees(pool: Pool, meetingId: number, personIds: number[]): Promise<void> {
  const ids = [...new Set(personIds.filter((n) => Number.isFinite(n)))];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM meeting_attendees WHERE meeting_id = $1", [meetingId]);
    for (const pid of ids) {
      await client.query(
        "INSERT INTO meeting_attendees (meeting_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [meetingId, pid]
      );
    }
    await client.query("UPDATE meetings SET updated_at = now() WHERE id = $1", [meetingId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function getAttendeeIds(pool: Pool, meetingId: number): Promise<number[]> {
  const r = await pool.query("SELECT person_id FROM meeting_attendees WHERE meeting_id = $1", [meetingId]);
  return r.rows.map((row) => Number(row.person_id));
}

// ── Agenda items ────────────────────────────────────────────────────────────

// Replace the meeting's agenda items with a freshly-extracted set. Called after
// an agenda upload. Existing items (and their notes/transcripts) are discarded.
export async function replaceAgendaItems(
  pool: Pool,
  meetingId: number,
  items: ExtractedItem[],
  agendaFileName: string
): Promise<void> {
  // Resolve presenter names up front, outside the transaction. Unresolvable
  // names are dropped. Attendance is untouched: an import never adds anyone to
  // meeting_attendees.
  const people = await listPeople(pool, true);
  const presenterIds = items.map((it) => (it.presenter ? matchPersonByName(it.presenter, people) : null));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM agenda_items WHERE meeting_id = $1", [meetingId]);
    let pos = 0;
    for (const it of items) {
      const inserted = await client.query(
        "INSERT INTO agenda_items (meeting_id, position, title, description) VALUES ($1, $2, $3, $4) RETURNING id",
        [meetingId, pos, it.title, it.description]
      );
      const pid = presenterIds[pos];
      if (pid !== null) {
        await client.query(
          "INSERT INTO agenda_item_presenters (item_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [Number(inserted.rows[0].id), pid]
        );
      }
      pos++;
    }
    await client.query("UPDATE meetings SET agenda_file_name = $2, updated_at = now() WHERE id = $1", [
      meetingId,
      agendaFileName,
    ]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function addAgendaItem(
  pool: Pool,
  meetingId: number,
  title: string,
  description: string
): Promise<Result<{ id: number }>> {
  const t = title.trim();
  if (!t) return { ok: false, status: 400, error: "An item title is required." };
  const posR = await pool.query(
    "SELECT COALESCE(MAX(position) + 1, 0) AS next FROM agenda_items WHERE meeting_id = $1",
    [meetingId]
  );
  const pos = Number(posR.rows[0].next);
  const r = await pool.query(
    "INSERT INTO agenda_items (meeting_id, position, title, description) VALUES ($1, $2, $3, $4) RETURNING id",
    [meetingId, pos, t, description.trim()]
  );
  return { ok: true, status: 200, id: Number(r.rows[0].id) };
}

export async function listAgendaItems(pool: Pool, meetingId: number): Promise<AgendaItem[]> {
  const r = await pool.query(
    "SELECT * FROM agenda_items WHERE meeting_id = $1 ORDER BY position, id",
    [meetingId]
  );
  if (!r.rows.length) return [];
  const ids = r.rows.map((row) => Number(row.id));
  const pres = await pool.query(
    "SELECT item_id, person_id FROM agenda_item_presenters WHERE item_id = ANY($1)",
    [ids]
  );
  const byItem = new Map<number, number[]>();
  for (const row of pres.rows) {
    const k = Number(row.item_id);
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k)!.push(Number(row.person_id));
  }
  return r.rows.map((row) => mapItemRow(row, byItem.get(Number(row.id)) ?? []));
}

export async function getAgendaItem(pool: Pool, itemId: number): Promise<AgendaItem | null> {
  const r = await pool.query("SELECT * FROM agenda_items WHERE id = $1", [itemId]);
  const row = r.rows[0];
  if (!row) return null;
  const pres = await pool.query("SELECT person_id FROM agenda_item_presenters WHERE item_id = $1", [itemId]);
  return mapItemRow(row, pres.rows.map((p) => Number(p.person_id)));
}

// Patch mutable fields on an agenda item. `presenterIds` (when provided)
// replaces the presenter set. `appendTranscript` adds to the existing
// transcript rather than overwriting (used by live speech chunks).
export async function updateAgendaItem(
  pool: Pool,
  itemId: number,
  fields: {
    title?: string;
    description?: string;
    status?: string;
    notes?: string;
    transcript?: string;
    appendTranscript?: string;
    transcriptSegments?: DiarizedSegment[];
    speakerMap?: SpeakerMap;
    summary?: string;
    actionItems?: ActionItem[];
    presenterIds?: number[];
    transcriptSource?: string;
    speakerOrder?: string[];
  }
): Promise<Result<{}>> {
  const existing = await getAgendaItem(pool, itemId);
  if (!existing) return { ok: false, status: 404, error: "Agenda item not found." };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sets: string[] = [];
    const vals: any[] = [itemId];
    const add = (col: string, val: any) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if (fields.title !== undefined && fields.title.trim()) add("title", fields.title.trim());
    if (fields.description !== undefined) add("description", fields.description);
    if (fields.status !== undefined) add("status", fields.status);
    if (fields.transcriptSource !== undefined) add("transcript_source", fields.transcriptSource);
    if (fields.notes !== undefined) add("notes", fields.notes);
    if (fields.summary !== undefined) add("summary", fields.summary);
    if (fields.actionItems !== undefined) add("action_items", JSON.stringify(fields.actionItems));

    // Diarized segments and/or the speaker→name map drive the rendered
    // transcript. When either is supplied, re-derive `transcript` from them so
    // remapping a speaker relabels the whole transcript.
    if (fields.transcriptSegments !== undefined || fields.speakerMap !== undefined) {
      const segs = fields.transcriptSegments !== undefined ? fields.transcriptSegments : existing.transcript_segments;
      const map = fields.speakerMap !== undefined ? fields.speakerMap : existing.speaker_map;
      if (fields.transcriptSegments !== undefined) add("transcript_segments", JSON.stringify(segs));
      if (fields.speakerMap !== undefined) add("speaker_map", JSON.stringify(map));
      add("transcript", renderTranscript(segs, map, fields.speakerOrder));
    } else if (fields.transcript !== undefined) add("transcript", fields.transcript);
    else if (fields.appendTranscript !== undefined && fields.appendTranscript.trim()) {
      const joined = existing.transcript
        ? existing.transcript + "\n" + fields.appendTranscript.trim()
        : fields.appendTranscript.trim();
      add("transcript", joined);
    }
    if (sets.length) {
      await client.query(`UPDATE agenda_items SET ${sets.join(", ")} WHERE id = $1`, vals);
    }
    if (fields.presenterIds !== undefined) {
      const ids = [...new Set(fields.presenterIds.filter((n) => Number.isFinite(n)))];
      await client.query("DELETE FROM agenda_item_presenters WHERE item_id = $1", [itemId]);
      for (const pid of ids) {
        await client.query(
          "INSERT INTO agenda_item_presenters (item_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [itemId, pid]
        );
      }
    }
    await client.query("UPDATE meetings SET updated_at = now() WHERE id = $1", [existing.meeting_id]);
    await client.query("COMMIT");
    return { ok: true, status: 200 };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteAgendaItem(pool: Pool, itemId: number): Promise<void> {
  await removeRecordingFiles(pool, [itemId]);
  await pool.query("DELETE FROM agenda_items WHERE id = $1", [itemId]);
}

// A filesystem- and header-safe download filename for a meeting's report.
// Output contains only [a-z0-9-] plus the .md suffix, so it can be embedded
// in a Content-Disposition header without escaping.
export function reportFileName(title: string, meetingDate: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const parts = [slug(meetingDate), slug(title) || "meeting"].filter(Boolean);
  return `${parts.join("-")}-minutes.md`;
}

export async function saveReport(pool: Pool, meetingId: number, report: string): Promise<void> {
  await pool.query(
    "UPDATE meetings SET report = $2, report_generated_at = now(), status = 'completed', updated_at = now() WHERE id = $1",
    [meetingId, report]
  );
}

// ── Transcription job state ─────────────────────────────────────────────────

// Move an item's transcription job to a new state. Entering `processing`
// stamps the start time; entering a terminal state stamps the finish time.
// Any state other than `error` clears the stored error message.
export async function setTranscribeStatus(
  pool: Pool,
  itemId: number,
  status: TranscribeStatus,
  error = ""
): Promise<void> {
  await pool.query(
    `UPDATE agenda_items
        SET transcribe_status = $2,
            transcribe_error  = CASE WHEN $2 = 'error' THEN $3 ELSE '' END,
            transcribe_started_at  = CASE WHEN $2 = 'processing' THEN now() ELSE transcribe_started_at END,
            transcribe_finished_at = CASE WHEN $2 IN ('done','error') THEN now() ELSE transcribe_finished_at END
      WHERE id = $1`,
    [itemId, status, error]
  );
}

// Item ids whose transcription never finished — used on boot to re-enqueue
// work that a container restart interrupted.
export async function listUnfinishedTranscriptions(pool: Pool): Promise<number[]> {
  const r = await pool.query(
    "SELECT id FROM agenda_items WHERE transcribe_status IN ('queued','processing') ORDER BY id"
  );
  return r.rows.map((row) => Number(row.id));
}

// Lightweight per-item state for the frontend status poll.
export async function listItemStatuses(
  pool: Pool,
  meetingId: number
): Promise<Array<{ id: number; transcribeStatus: TranscribeStatus; transcribeError: string; hasSummary: boolean }>> {
  const r = await pool.query(
    `SELECT id, transcribe_status, transcribe_error, (summary <> '') AS has_summary
       FROM agenda_items WHERE meeting_id = $1 ORDER BY position, id`,
    [meetingId]
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    transcribeStatus: (row.transcribe_status ?? "idle") as TranscribeStatus,
    transcribeError: row.transcribe_error ?? "",
    hasSummary: !!row.has_summary,
  }));
}

// ── Whole-meeting recording state ───────────────────────────────────────────

// Any status other than `error` clears the stored error message.
export async function setMeetingRecordingStatus(
  pool: Pool,
  meetingId: number,
  status: MeetingRecordingStatus,
  error = ""
): Promise<void> {
  await pool.query(
    `UPDATE meetings
        SET recording_status = $2,
            recording_error  = CASE WHEN $2 = 'error' THEN $3 ELSE '' END,
            updated_at = now()
      WHERE id = $1`,
    [meetingId, status, error]
  );
}

// Meetings whose whole-recording processing never finished — used on boot to
// re-enqueue work a restart interrupted.
export async function listUnfinishedMeetingProcessing(pool: Pool): Promise<number[]> {
  const r = await pool.query(
    "SELECT id FROM meetings WHERE recording_status IN ('queued','processing') ORDER BY id"
  );
  return r.rows.map((row) => Number(row.id));
}

export async function addTopicMarker(
  pool: Pool,
  recordingId: number,
  itemId: number,
  atSeconds: number
): Promise<void> {
  await pool.query(
    "INSERT INTO topic_markers (recording_id, item_id, at_seconds) VALUES ($1, $2, $3)",
    [recordingId, itemId, atSeconds]
  );
}

export async function listTopicMarkers(
  pool: Pool,
  recordingId: number
): Promise<Array<{ itemId: number; atSeconds: number }>> {
  const r = await pool.query(
    "SELECT item_id, at_seconds FROM topic_markers WHERE recording_id = $1 ORDER BY at_seconds, id",
    [recordingId]
  );
  return r.rows.map((row) => ({ itemId: Number(row.item_id), atSeconds: Number(row.at_seconds) }));
}

export async function setMeetingSpeakerMap(pool: Pool, meetingId: number, map: SpeakerMap): Promise<void> {
  await pool.query("UPDATE meetings SET speaker_map = $2, updated_at = now() WHERE id = $1", [
    meetingId,
    JSON.stringify(map),
  ]);
}

// Store the meeting-wide speaker map and re-render every meeting-sourced
// topic against it in one transaction. New names invalidate summaries.
export async function rewriteMeetingSpeakerMap(
  pool: Pool,
  meetingId: number,
  rawMap: Record<string, unknown>
): Promise<void> {
  const map: SpeakerMap = {};
  for (const [k, v] of Object.entries(rawMap ?? {})) {
    const name = String(v ?? "").trim();
    if (name) map[k] = name;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE meetings SET speaker_map = $2, updated_at = now() WHERE id = $1", [
      meetingId, JSON.stringify(map),
    ]);
    const r = await client.query(
      `SELECT id, transcript_segments FROM agenda_items
        WHERE meeting_id = $1 AND transcript_source = 'meeting' ORDER BY position, id`,
      [meetingId]
    );
    const perItem = r.rows.map((row) =>
      (Array.isArray(row.transcript_segments) ? row.transcript_segments : []) as DiarizedSegment[]
    );
    const order = chronologicalSpeakerOrder(perItem);
    for (let i = 0; i < r.rows.length; i++) {
      await client.query(
        `UPDATE agenda_items
            SET speaker_map = $2, transcript = $3, summary = '', action_items = '[]'::jsonb, status = 'pending'
          WHERE id = $1`,
        [Number(r.rows[i].id), JSON.stringify(map), renderTranscript(perItem[i], map, order)]
      );
    }
    await client.query("UPDATE meetings SET updated_at = now() WHERE id = $1", [meetingId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
