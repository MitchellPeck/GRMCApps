import { Pool } from "pg";
import { DEFAULT_WINDOWS, HoursWindow } from "./power";

interface HoursRow {
  id: number;
  day: number;
  start_time: string;
  end_time: string;
  enabled: boolean;
}

const toWindow = (row: HoursRow): HoursWindow => ({
  id: Number(row.id),
  day: Number(row.day),
  startTime: row.start_time,
  endTime: row.end_time,
  enabled: Boolean(row.enabled),
});

export async function listWindows(pool: Pool): Promise<HoursWindow[]> {
  const r = await pool.query<HoursRow>(
    "SELECT id, day, start_time, end_time, enabled FROM operating_hours ORDER BY day, start_time, id"
  );
  return r.rows.map(toWindow);
}

export async function addWindow(
  pool: Pool,
  w: { day: number; startTime: string; endTime: string }
): Promise<HoursWindow> {
  const r = await pool.query<HoursRow>(
    `INSERT INTO operating_hours (day, start_time, end_time)
     VALUES ($1, $2, $3) RETURNING id, day, start_time, end_time, enabled`,
    [w.day, w.startTime, w.endTime]
  );
  return toWindow(r.rows[0]);
}

export async function updateWindow(
  pool: Pool,
  id: number,
  w: { day?: number; startTime?: string; endTime?: string; enabled?: boolean }
): Promise<void> {
  await pool.query(
    `UPDATE operating_hours SET
       day        = COALESCE($2, day),
       start_time = COALESCE($3, start_time),
       end_time   = COALESCE($4, end_time),
       enabled    = COALESCE($5, enabled)
     WHERE id = $1`,
    [id, w.day ?? null, w.startTime ?? null, w.endTime ?? null, w.enabled ?? null]
  );
}

export async function removeWindow(pool: Pool, id: number): Promise<boolean> {
  const r = await pool.query("DELETE FROM operating_hours WHERE id = $1 RETURNING id", [id]);
  return r.rowCount !== null && r.rowCount > 0;
}

/**
 * Seeds the grid the first time somebody switches operating hours on, so they
 * are editing a sensible week rather than staring at an empty table. Only ever
 * runs against an empty table, so a deliberately cleared grid stays cleared.
 */
export async function seedDefaultWindows(pool: Pool): Promise<HoursWindow[]> {
  const existing = await listWindows(pool);
  if (existing.length) return existing;
  for (const w of DEFAULT_WINDOWS) {
    await addWindow(pool, { day: w.day, startTime: w.startTime, endTime: w.endTime });
  }
  return listWindows(pool);
}

export async function recordPowerEvent(
  pool: Pool,
  action: string,
  ok: boolean,
  detail: string
): Promise<void> {
  await pool.query("INSERT INTO power_events (action, ok, detail) VALUES ($1, $2, $3)", [
    action,
    ok,
    detail.slice(0, 500),
  ]);
}

export interface PowerEvent {
  action: string;
  ok: boolean;
  detail: string;
  firedAt: string;
}

export async function listPowerEvents(pool: Pool, limit = 20): Promise<PowerEvent[]> {
  const r = await pool.query<{ action: string; ok: boolean; detail: string; fired_at: string }>(
    "SELECT action, ok, detail, fired_at FROM power_events ORDER BY fired_at DESC LIMIT $1",
    [limit]
  );
  return r.rows.map((row) => ({
    action: row.action,
    ok: row.ok,
    detail: row.detail,
    firedAt: row.fired_at,
  }));
}
