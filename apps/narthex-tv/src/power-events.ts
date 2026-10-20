import { Pool } from "pg";

// An audit trail for the power hook. A TV that did not come on is the sort of
// thing somebody notices on a Sunday morning, and this is where they look.
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
