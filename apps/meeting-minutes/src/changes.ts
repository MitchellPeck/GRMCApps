import { Pool, PoolClient } from "pg";
import { ActionItem } from "./claude";
import { SpeakerMap } from "./transcript";
import { DiarizedSegment } from "./whisper";

// The change log behind Undo. A bulk change (fix a name everywhere, a speaker
// rename, a chat edit) records the fields it touched, before and after. Undo
// puts `before` back, but only while every one of those fields still holds
// `after`: restoring over a later edit would silently throw that edit away.

export interface ItemFields {
  title?: string;
  description?: string;
  notes?: string;
  transcript?: string;
  transcript_segments?: DiarizedSegment[];
  summary?: string;
  action_items?: ActionItem[];
  speaker_map?: SpeakerMap;
  presenter_ids?: number[];
  guest_presenter_ids?: number[];
}

export interface Snapshot {
  meeting?: { report?: string; speaker_map?: SpeakerMap; title?: string; meeting_date?: string; location?: string; description?: string };
  attendees?: number[];
  items?: Record<string, ItemFields>;
  guests?: Record<string, { name: string }>;
}

const ITEM_COLUMNS = ["title", "description", "notes", "transcript", "transcript_segments", "summary", "action_items", "speaker_map"] as const;
const MEETING_TEXT = ["title", "meeting_date", "location", "description"] as const;
const JSON_COLUMNS = new Set(["transcript_segments", "action_items", "speaker_map"]);

// JSON with sorted keys: jsonb hands keys back in its own order.
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val
  );
}

// The current values of exactly the fields `shape` names. `lock` holds those
// rows until the transaction ends (Undo checks, then writes).
async function readFields(c: PoolClient, meetingId: number, shape: Snapshot, lock = false): Promise<Snapshot> {
  const fu = lock ? " FOR UPDATE" : "";
  const out: Snapshot = {};
  if (shape.meeting) {
    const r = (await c.query(
      "SELECT report, speaker_map, title, meeting_date, location, description FROM meetings WHERE id = $1" + fu, [meetingId]
    )).rows[0] ?? {};
    out.meeting = {};
    for (const k of Object.keys(shape.meeting) as Array<keyof NonNullable<Snapshot["meeting"]>>) {
      (out.meeting as any)[k] = r[k];
    }
  }
  if (shape.items) {
    out.items = {};
    for (const [id, fields] of Object.entries(shape.items)) {
      const r = (await c.query(
        `SELECT ${ITEM_COLUMNS.join(", ")} FROM agenda_items WHERE id = $1 AND meeting_id = $2` + fu,
        [Number(id), meetingId]
      )).rows[0] ?? {};
      out.items[id] = {};
      for (const k of Object.keys(fields)) {
        if (k === "presenter_ids") {
          (out.items[id] as any)[k] = (await c.query("SELECT person_id FROM agenda_item_presenters WHERE item_id = $1 ORDER BY person_id", [Number(id)]))
            .rows.map((x) => Number(x.person_id));
        } else if (k === "guest_presenter_ids") {
          (out.items[id] as any)[k] = (await c.query("SELECT guest_id FROM agenda_item_guest_presenters WHERE item_id = $1 ORDER BY guest_id", [Number(id)]))
            .rows.map((x) => Number(x.guest_id));
        } else (out.items[id] as any)[k] = r[k];
      }
    }
  }
  if (shape.attendees) {
    out.attendees = (await c.query(
      "SELECT person_id FROM meeting_attendees WHERE meeting_id = $1 ORDER BY person_id", [meetingId]
    )).rows.map((r) => Number(r.person_id));
  }
  if (shape.guests) {
    out.guests = {};
    for (const id of Object.keys(shape.guests)) {
      const r = (await c.query("SELECT name FROM meeting_guests WHERE id = $1 AND meeting_id = $2" + fu, [Number(id), meetingId])).rows[0];
      out.guests[id] = { name: r?.name };
    }
  }
  return out;
}

// Write a snapshot's fields. A report written here is an edit of the minutes.
export async function writeFields(c: PoolClient, meetingId: number, snap: Snapshot): Promise<void> {
  if (snap.meeting?.report !== undefined) {
    await c.query(
      `UPDATE meetings SET report = $2, updated_at = now(),
              report_updated_at = GREATEST(clock_timestamp(), report_generated_at + interval '1 millisecond')
        WHERE id = $1`,
      [meetingId, snap.meeting.report]
    );
  }
  for (const col of MEETING_TEXT) {
    const v = snap.meeting?.[col];
    if (v !== undefined) await c.query(`UPDATE meetings SET ${col} = $2, updated_at = now() WHERE id = $1`, [meetingId, v]);
  }
  if (snap.attendees !== undefined) {
    await c.query("DELETE FROM meeting_attendees WHERE meeting_id = $1", [meetingId]);
    for (const pid of snap.attendees) {
      await c.query("INSERT INTO meeting_attendees (meeting_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [meetingId, pid]);
    }
  }
  if (snap.meeting?.speaker_map !== undefined) {
    await c.query("UPDATE meetings SET speaker_map = $2, updated_at = now() WHERE id = $1",
      [meetingId, JSON.stringify(snap.meeting.speaker_map)]);
  }
  for (const [id, fields] of Object.entries(snap.items ?? {})) {
    const sets: string[] = [];
    const vals: unknown[] = [Number(id), meetingId];
    for (const col of ITEM_COLUMNS) {
      if (fields[col] === undefined) continue;
      vals.push(JSON_COLUMNS.has(col) ? JSON.stringify(fields[col]) : fields[col]);
      sets.push(`${col} = $${vals.length}`);
    }
    if (sets.length) await c.query(`UPDATE agenda_items SET ${sets.join(", ")} WHERE id = $1 AND meeting_id = $2`, vals);
    if (fields.presenter_ids !== undefined) {
      await c.query("DELETE FROM agenda_item_presenters WHERE item_id = $1", [Number(id)]);
      for (const pid of fields.presenter_ids) {
        await c.query("INSERT INTO agenda_item_presenters (item_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [Number(id), pid]);
      }
    }
    if (fields.guest_presenter_ids !== undefined) {
      await c.query("DELETE FROM agenda_item_guest_presenters WHERE item_id = $1", [Number(id)]);
      for (const gid of fields.guest_presenter_ids) {
        await c.query("INSERT INTO agenda_item_guest_presenters (item_id, guest_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [Number(id), gid]);
      }
    }
  }
  for (const [id, g] of Object.entries(snap.guests ?? {})) {
    await c.query("UPDATE meeting_guests SET name = $3 WHERE id = $1 AND meeting_id = $2", [Number(id), meetingId, g.name]);
  }
}

export async function recordChange(
  c: PoolClient,
  meetingId: number,
  kind: string,
  summary: string,
  before: Snapshot,
  after: Snapshot,
  by = "",
  params: Record<string, unknown> = {}
): Promise<number> {
  const r = await c.query(
    `INSERT INTO meeting_changes (meeting_id, kind, summary, before, after, created_by, params)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [meetingId, kind, summary, JSON.stringify(before), JSON.stringify(after), by, JSON.stringify(params)]
  );
  return Number(r.rows[0].id);
}

export async function undoChange(
  pool: Pool,
  meetingId: number,
  changeId: number
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const row = (await c.query(
      "SELECT before, after, undone_at FROM meeting_changes WHERE id = $1 AND meeting_id = $2 FOR UPDATE",
      [changeId, meetingId]
    )).rows[0];
    if (!row) { await c.query("ROLLBACK"); return { ok: false, status: 404, error: "That change wasn't found." }; }
    if (row.undone_at) { await c.query("ROLLBACK"); return { ok: false, status: 409, error: "Already undone." }; }
    const after = row.after as Snapshot;
    if (canonical(await readFields(c, meetingId, after, true)) !== canonical(after)) {
      await c.query("ROLLBACK");
      return { ok: false, status: 409, error: "Something changed these since; undo it by hand." };
    }
    await writeFields(c, meetingId, row.before as Snapshot);
    await c.query("UPDATE meeting_changes SET undone_at = now() WHERE id = $1", [changeId]);
    await c.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

export async function listChanges(
  pool: Pool,
  meetingId: number,
  limit = 20
): Promise<Array<{ id: number; kind: string; summary: string; undone: boolean; created_at: string }>> {
  const r = await pool.query(
    "SELECT id, kind, summary, undone_at, created_at FROM meeting_changes WHERE meeting_id = $1 ORDER BY id DESC LIMIT $2",
    [meetingId, limit]
  );
  return r.rows.map((row) => ({
    id: Number(row.id), kind: row.kind, summary: row.summary, undone: !!row.undone_at, created_at: row.created_at,
  }));
}

// The current values of the fields `shape` names: taken before and after an
// action, the pair is that action's change.
export async function readSnapshot(pool: Pool, meetingId: number, shape: Snapshot): Promise<Snapshot> {
  const c = await pool.connect();
  try { return await readFields(c, meetingId, shape); } finally { c.release(); }
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return canonical(a) === canonical(b);
}

// Record an action done outside a transaction from its before/after snapshots.
export async function recordSnapshotChange(
  pool: Pool, meetingId: number, kind: string, summary: string, before: Snapshot, after: Snapshot, by = ""
): Promise<number | null> {
  if (sameSnapshot(before, after)) return null;
  const c = await pool.connect();
  try { return await recordChange(c, meetingId, kind, summary, before, after, by); } finally { c.release(); }
}
