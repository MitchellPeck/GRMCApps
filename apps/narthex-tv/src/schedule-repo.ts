import { Pool } from "pg";
import { ScheduleEntry, ScheduleMode } from "./schedule";

export interface ScheduleRow {
  id: number;
  playlist_id: number;
  mode: ScheduleMode;
  label: string;
  starts_at: Date | null;
  ends_at: Date | null;
  days: number[];
  start_time: string;
  end_time: string;
  effective_from: Date | string | null;
  effective_to: Date | string | null;
  priority: number;
  enabled: boolean;
  created_by_email: string;
  created_at: string;
  updated_at: string;
  playlist_name?: string;
}

const COLUMNS = `e.id, e.playlist_id, e.mode, e.label, e.starts_at, e.ends_at, e.days,
                 e.start_time, e.end_time, e.effective_from, e.effective_to, e.priority,
                 e.enabled, e.created_by_email, e.created_at, e.updated_at,
                 p.name AS playlist_name`;

const dateKey = (value: Date | string | null): string | null => {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  // node-postgres hands back a Date at local midnight for a `date` column, so
  // the key has to come from the local parts, not from toISOString().
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
    value.getDate()
  ).padStart(2, "0")}`;
};

export function toEntry(row: ScheduleRow): ScheduleEntry {
  return {
    id: Number(row.id),
    playlistId: Number(row.playlist_id),
    mode: row.mode,
    label: row.label ?? "",
    startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
    days: (row.days ?? []).map(Number),
    startTime: row.start_time ?? "",
    endTime: row.end_time ?? "",
    effectiveFrom: dateKey(row.effective_from),
    effectiveTo: dateKey(row.effective_to),
    priority: Number(row.priority ?? 0),
    enabled: Boolean(row.enabled),
  };
}

export async function listScheduleRows(pool: Pool): Promise<ScheduleRow[]> {
  const r = await pool.query<ScheduleRow>(
    `SELECT ${COLUMNS} FROM schedule_entries e JOIN playlists p ON p.id = e.playlist_id
      ORDER BY e.enabled DESC, e.starts_at NULLS LAST, e.id`
  );
  return r.rows;
}

export async function listEntries(pool: Pool): Promise<ScheduleEntry[]> {
  return (await listScheduleRows(pool)).map(toEntry);
}

export async function getScheduleRow(pool: Pool, id: number): Promise<ScheduleRow | null> {
  const r = await pool.query<ScheduleRow>(
    `SELECT ${COLUMNS} FROM schedule_entries e JOIN playlists p ON p.id = e.playlist_id
      WHERE e.id = $1`,
    [id]
  );
  return r.rows[0] ?? null;
}

export interface ScheduleInput {
  playlistId: number;
  mode: ScheduleMode;
  label: string;
  startsAt: string | null;
  endsAt: string | null;
  days: number[];
  startTime: string;
  endTime: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  priority: number;
  enabled: boolean;
}

export async function createEntry(
  pool: Pool,
  input: ScheduleInput,
  createdByEmail: string
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO schedule_entries
       (playlist_id, mode, label, starts_at, ends_at, days, start_time, end_time,
        effective_from, effective_to, priority, enabled, created_by_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      input.playlistId, input.mode, input.label.slice(0, 120),
      input.startsAt, input.endsAt, input.days,
      input.startTime, input.endTime,
      input.effectiveFrom, input.effectiveTo,
      input.priority, input.enabled, createdByEmail,
    ]
  );
  return Number(r.rows[0].id);
}

export async function updateEntry(
  pool: Pool,
  id: number,
  input: Partial<ScheduleInput>
): Promise<void> {
  await pool.query(
    `UPDATE schedule_entries SET
       playlist_id    = COALESCE($2, playlist_id),
       mode           = COALESCE($3, mode),
       label          = COALESCE($4, label),
       starts_at      = CASE WHEN $5::boolean THEN $6::timestamptz ELSE starts_at END,
       ends_at        = CASE WHEN $7::boolean THEN $8::timestamptz ELSE ends_at END,
       days           = COALESCE($9, days),
       start_time     = COALESCE($10, start_time),
       end_time       = COALESCE($11, end_time),
       effective_from = CASE WHEN $12::boolean THEN $13::date ELSE effective_from END,
       effective_to   = CASE WHEN $14::boolean THEN $15::date ELSE effective_to END,
       priority       = COALESCE($16, priority),
       enabled        = COALESCE($17, enabled),
       updated_at     = now()
     WHERE id = $1`,
    [
      id,
      input.playlistId ?? null,
      input.mode ?? null,
      input.label?.slice(0, 120) ?? null,
      // The four nullable columns need an explicit "was this field sent?" flag:
      // COALESCE cannot tell "clear this" from "leave it alone".
      input.startsAt !== undefined, input.startsAt ?? null,
      input.endsAt !== undefined, input.endsAt ?? null,
      input.days ?? null,
      input.startTime ?? null,
      input.endTime ?? null,
      input.effectiveFrom !== undefined, input.effectiveFrom ?? null,
      input.effectiveTo !== undefined, input.effectiveTo ?? null,
      input.priority ?? null,
      input.enabled ?? null,
    ]
  );
}

export async function deleteEntry(pool: Pool, id: number): Promise<boolean> {
  const r = await pool.query("DELETE FROM schedule_entries WHERE id = $1 RETURNING id", [id]);
  return r.rowCount !== null && r.rowCount > 0;
}
