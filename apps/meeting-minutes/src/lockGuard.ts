import { FastifyReply, FastifyRequest } from "fastify";
import { Pool } from "pg";
import { getIdentity } from "./identity";
import { acquireLock } from "./locks";

// Every write on a meeting goes through its lock: the first person to change
// something takes the lock if it is free, and anyone else is refused with 423
// while it is held. Recording uploads are exempt — a two-hour recording must
// never lose a chunk to a lock — and so are reads and creating a meeting.

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EXEMPT = new Set([
  "POST /api/meetings",
  "POST /api/meeting-recordings/:rid/chunk",
  "POST /api/meeting-recordings/:rid/marker",
  "POST /api/meeting-recordings/:rid/finish",
  // The lock routes manage the lock themselves.
  "POST /api/meetings/:id/lock",
  "DELETE /api/meetings/:id/lock",
]);

// The meeting a request writes to, from whichever id its route carries.
export async function meetingIdForRequest(pool: Pool, route: string, params: Record<string, string>): Promise<number | null> {
  const n = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
  const one = async (sql: string, id: number | null) =>
    id === null ? null : ((await pool.query(sql, [id])).rows[0]?.meeting_id ?? null) as number | null;
  if (route.startsWith("/api/meetings/:id")) return n(params.id);
  if (params.itemId !== undefined) return one("SELECT meeting_id FROM agenda_items WHERE id = $1", n(params.itemId));
  if (params.gid !== undefined) return one("SELECT meeting_id FROM meeting_guests WHERE id = $1", n(params.gid));
  if (params.rid !== undefined) return one("SELECT meeting_id FROM meeting_recordings WHERE id = $1", n(params.rid));
  return null;
}

export function lockGuard(pool: Pool) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!WRITE_METHODS.has(req.method)) return;
    const route = req.routeOptions.url ?? "";
    if (EXEMPT.has(`${req.method} ${route}`)) return;
    const meetingId = await meetingIdForRequest(pool, route, (req.params ?? {}) as Record<string, string>);
    if (meetingId === null) return;
    const exists = await pool.query("SELECT 1 FROM meetings WHERE id = $1", [Number(meetingId)]);
    if (!exists.rows[0]) return; // the route answers 404 itself
    const who = getIdentity(req);
    const r = await acquireLock(pool, Number(meetingId), who, { edit: true });
    if (r.held) return;
    const holder = r.lock.name || r.lock.email || "Someone else";
    reply.code(423).send({ ok: false, locked: true, holder, error: `${holder} is editing this meeting.` });
    return reply;
  };
}
