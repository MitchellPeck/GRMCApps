import { Pool } from "pg";

type Callback = (err?: Error | null, session?: any) => void;

// Minimal Postgres-backed store compatible with @fastify/session's
// callback interface (get/set/destroy). Sessions are JSON in the `session` table.
export class PgSessionStore {
  constructor(private pool: Pool) {}

  get(sid: string, cb: Callback): void {
    this.pool
      .query("SELECT sess FROM session WHERE sid = $1 AND expire > now()", [sid])
      .then((r) => cb(null, r.rows[0] ? r.rows[0].sess : null))
      .catch((e) => cb(e));
  }

  set(sid: string, session: any, cb: Callback): void {
    const expires =
      session?.cookie?.expires ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
    this.pool
      .query(
        `INSERT INTO session (sid, sess, expire) VALUES ($1, $2, $3)
         ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
        [sid, JSON.stringify(session), new Date(expires)]
      )
      .then(() => cb(null))
      .catch((e) => cb(e));
  }

  destroy(sid: string, cb: Callback): void {
    this.pool
      .query("DELETE FROM session WHERE sid = $1", [sid])
      .then(() => cb(null))
      .catch((e) => cb(e));
  }
}
