import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { pool } from "../db";
import { getUser, listEnabledApps } from "../apps/registry";
import { isValidEmail, normalizeEmail } from "../users/email";
import { AdminCandidate, AdminChange, checkAdminChange } from "../users/admin-guard";
import { decideAdminRequest } from "./guard";

export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  is_admin: boolean;
  active: boolean;
  last_login: string | null;
  google_sub: string | null;
  app_ids: string[];
}

async function listUsers(): Promise<AdminUserRow[]> {
  const r = await pool.query<AdminUserRow>(
    `SELECT u.id, u.email, u.name, u.is_admin, u.active, u.last_login, u.google_sub,
            COALESCE(array_agg(ua.app_id) FILTER (WHERE ua.app_id IS NOT NULL), '{}') AS app_ids
       FROM users u
       LEFT JOIN user_app_access ua ON ua.user_id = u.id
      GROUP BY u.id
      ORDER BY u.is_admin DESC, lower(u.email)`
  );
  return r.rows;
}

async function adminCandidates(): Promise<AdminCandidate[]> {
  const r = await pool.query<AdminCandidate>(`SELECT id, is_admin, active FROM users`);
  return r.rows;
}

// Refuses a change that would remove the last account able to reach this
// screen. Returns an error string, or null when the change may proceed.
async function guard(change: AdminChange): Promise<string | null> {
  const result = checkAdminChange(await adminCandidates(), change);
  return result.ok ? null : result.error;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Every route below is admin-only, and every mutation must come from the hub
  // itself. The session cookie is SameSite=Lax, which already stops a
  // cross-site POST from carrying it; the Origin check is belt-and-braces on
  // the one surface that hands out access.
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.session.userId ? await getUser(req.session.userId) : null;
    const decision = decideAdminRequest(
      user,
      req.method,
      String(req.headers.origin ?? ""),
      config.publicUrl
    );
    if (decision.ok) return;

    req.log.warn(
      { userId: req.session.userId ?? null, url: req.url, error: decision.error },
      "admin request refused"
    );

    // The JSON endpoints are called by fetch and need a machine-readable body;
    // /admin/users is a browser navigation and gets the styled page.
    if (req.url.startsWith("/api/")) {
      return reply.code(decision.status).send({ ok: false, error: decision.error });
    }
    return reply.code(decision.status).view("denied.ejs", {
      message: decision.error,
      hubHost: new URL(config.publicUrl).host,
    });
  });

  app.get("/admin/users", async (_req, reply) =>
    reply.view("admin-users.ejs", {
      users: await listUsers(),
      apps: await listEnabledApps(),
      hubHost: new URL(config.publicUrl).host,
    })
  );

  app.get("/api/admin/users", async () => ({
    ok: true,
    users: await listUsers(),
    apps: await listEnabledApps(),
  }));

  app.post("/api/admin/users", async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; name?: string };
    const raw = String(body.email ?? "");
    if (!isValidEmail(raw)) {
      return reply.code(400).send({ ok: false, error: "Enter a valid email address." });
    }
    const email = normalizeEmail(raw);
    const name = String(body.name ?? "").trim() || null;

    const existing = await pool.query(`SELECT id FROM users WHERE lower(email) = $1`, [email]);
    if (existing.rows[0]) {
      return reply.code(409).send({ ok: false, error: "That address already has an account." });
    }

    const created = await pool.query(
      `INSERT INTO users (email, name, invited_by) VALUES ($1, $2, $3) RETURNING id`,
      [email, name, req.session.userId]
    );
    return { ok: true, id: created.rows[0].id };
  });

  app.patch("/api/admin/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { is_admin?: boolean; active?: boolean; name?: string };

    // `undefined` means "not being changed" — only an explicit false can strip
    // an administrator, so only that needs the guard.
    if (body.is_admin === false) {
      const error = await guard({ type: "demote", userId: id });
      if (error) return reply.code(409).send({ ok: false, error });
    }
    if (body.active === false) {
      const error = await guard({ type: "disable", userId: id });
      if (error) return reply.code(409).send({ ok: false, error });
    }

    const r = await pool.query(
      `UPDATE users
          SET is_admin = COALESCE($2, is_admin),
              active   = COALESCE($3, active),
              name     = COALESCE($4, name)
        WHERE id = $1
      RETURNING id`,
      [
        id,
        body.is_admin ?? null,
        body.active ?? null,
        body.name === undefined ? null : String(body.name).trim() || null,
      ]
    );
    if (!r.rows[0]) return reply.code(404).send({ ok: false, error: "User not found." });
    return { ok: true };
  });

  app.delete("/api/admin/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const error = await guard({ type: "delete", userId: id });
    if (error) return reply.code(409).send({ ok: false, error });

    // user_app_access cascades on this delete.
    const r = await pool.query(`DELETE FROM users WHERE id = $1 RETURNING id`, [id]);
    if (!r.rows[0]) return reply.code(404).send({ ok: false, error: "User not found." });
    return { ok: true };
  });

  app.put("/api/admin/users/:id/apps/:appId", async (req, reply) => {
    const { id, appId } = req.params as { id: string; appId: string };
    try {
      await pool.query(
        `INSERT INTO user_app_access (user_id, app_id, granted_by)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [id, appId, req.session.userId]
      );
    } catch (err) {
      req.log.warn({ err, id, appId }, "grant failed");
      return reply.code(400).send({ ok: false, error: "Unknown user or app." });
    }
    return { ok: true };
  });

  app.delete("/api/admin/users/:id/apps/:appId", async (req) => {
    const { id, appId } = req.params as { id: string; appId: string };
    await pool.query(`DELETE FROM user_app_access WHERE user_id = $1 AND app_id = $2`, [id, appId]);
    return { ok: true };
  });
}
