import { Pool } from "pg";

// One editor per meeting. Whoever has a meeting open holds its lock and keeps
// it alive with a heartbeat from the page; everyone else sees the meeting
// read-only. A lock lets go by itself when the tab is closed (no heartbeat)
// or when its holder stops editing — except while the meeting is being
// recorded, when the recorder may go a whole meeting without typing a thing.

export const HEARTBEAT_LAPSE_MS = 2 * 60 * 1000;
export const IDLE_LAPSE_MS = 15 * 60 * 1000;

export interface Lock {
  meetingId: number;
  email: string;
  name: string;
  acquiredAt: Date;
  heartbeatAt: Date;
  editedAt: Date;
}

export type LockResult = { held: true; lock: Lock } | { held: false; lock: Lock };

export function lockLive(lock: Lock | null, now: Date, recording: boolean): boolean {
  if (!lock) return false;
  if (now.getTime() - lock.heartbeatAt.getTime() > HEARTBEAT_LAPSE_MS) return false;
  if (!recording && now.getTime() - lock.editedAt.getTime() > IDLE_LAPSE_MS) return false;
  return true;
}

function rowToLock(r: any): Lock {
  return {
    meetingId: Number(r.meeting_id), email: r.email, name: r.name,
    acquiredAt: new Date(r.acquired_at), heartbeatAt: new Date(r.heartbeat_at), editedAt: new Date(r.edited_at),
  };
}

// Take a free or lapsed lock, or refresh your own (`edit` also counts as
// activity). Refused when someone else holds a live one.
export async function acquireLock(
  pool: Pool,
  meetingId: number,
  who: { email: string; name: string },
  opts: { edit?: boolean; now?: Date } = {}
): Promise<LockResult> {
  const now = opts.now ?? new Date();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const ins = await c.query(
      `INSERT INTO meeting_locks (meeting_id, email, name, acquired_at, heartbeat_at, edited_at)
       VALUES ($1, $2, $3, $4, $4, $4) ON CONFLICT (meeting_id) DO NOTHING RETURNING *`,
      [meetingId, who.email, who.name, now]
    );
    if (ins.rows[0]) { await c.query("COMMIT"); return { held: true, lock: rowToLock(ins.rows[0]) }; }
    const r = await c.query(
      `SELECT l.*, m.recording_status FROM meeting_locks l JOIN meetings m ON m.id = l.meeting_id
        WHERE l.meeting_id = $1 FOR UPDATE OF l`,
      [meetingId]
    );
    const current = rowToLock(r.rows[0]);
    const mine = current.email === who.email;
    if (!mine && lockLive(current, now, r.rows[0].recording_status === "recording")) {
      await c.query("COMMIT");
      return { held: false, lock: current };
    }
    const u = mine
      ? await c.query(
          `UPDATE meeting_locks SET heartbeat_at = $2, name = $3, edited_at = CASE WHEN $4 THEN $2 ELSE edited_at END
            WHERE meeting_id = $1 RETURNING *`,
          [meetingId, now, who.name || current.name, !!opts.edit])
      : await c.query(
          `UPDATE meeting_locks SET email = $2, name = $3, acquired_at = $4, heartbeat_at = $4, edited_at = $4
            WHERE meeting_id = $1 RETURNING *`,
          [meetingId, who.email, who.name, now]);
    await c.query("COMMIT");
    return { held: true, lock: rowToLock(u.rows[0]) };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

export async function releaseLock(pool: Pool, meetingId: number, email: string): Promise<void> {
  await pool.query("DELETE FROM meeting_locks WHERE meeting_id = $1 AND email = $2", [meetingId, email]);
}

export async function getLock(pool: Pool, meetingId: number, now = new Date()): Promise<{ lock: Lock; live: boolean } | null> {
  const r = await pool.query(
    `SELECT l.*, m.recording_status FROM meeting_locks l JOIN meetings m ON m.id = l.meeting_id WHERE l.meeting_id = $1`,
    [meetingId]
  );
  if (!r.rows[0]) return null;
  const lock = rowToLock(r.rows[0]);
  return { lock, live: lockLive(lock, now, r.rows[0].recording_status === "recording") };
}
