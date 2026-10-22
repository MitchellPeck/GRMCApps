import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { setSetting } from "../settings";
import { handleMessage } from "../mcp";
import { sameSecret } from "./pipeline";

// Each person has their own connector link, so what Claude does is recorded
// as theirs. The link is the credential (Claude's connector can't sign in
// through the hub), kept as the setting mcp_token:<email>, and can be reset.
const PREFIX = "mcp_token:";

async function tokenFor(email: string, fresh = false): Promise<string> {
  const key = PREFIX + email.toLowerCase();
  if (!fresh) {
    const r = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
    if (r.rows[0]?.value) return r.rows[0].value;
  }
  const token = randomBytes(24).toString("base64url");
  await setSetting(pool, key, token);
  return token;
}

async function emailFor(token: string): Promise<string | null> {
  const r = await pool.query("SELECT key, value FROM settings WHERE starts_with(key, $1)", [PREFIX]);
  const row = r.rows.find((x) => sameSecret(token, x.value));
  return row ? row.key.slice(PREFIX.length) : null;
}

function linkFor(req: FastifyRequest, token: string): string {
  return `https://${req.hostname}/mcp/${token}`;
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/mcp", async (req) => {
    const { email } = getIdentity(req);
    if (!email) return { ok: false, error: "Sign in through the hub to get your link." };
    return { ok: true, url: linkFor(req, await tokenFor(email)) };
  });

  app.post("/api/mcp/reset", async (req) => {
    const { email } = getIdentity(req);
    if (!email) return { ok: false, error: "Sign in through the hub to get your link." };
    return { ok: true, url: linkFor(req, await tokenFor(email, true)) };
  });

  // Reached WITHOUT the hub login (its own Traefik router), so it checks the
  // token itself, and never trusts identity headers on this path.
  app.post("/mcp/:token", async (req, reply) => {
    const email = await emailFor((req.params as { token: string }).token);
    if (!email) return reply.code(404).send({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unknown link." } });
    const ctx = { db: pool, email };
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
      return out.length ? out : reply.code(202).send();
    }
    const out = await handleMessage(body, ctx);
    return out ?? reply.code(202).send();
  });

  // Stateless: no event stream to open and no session to end.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header("allow", "POST").send();
  app.get("/mcp/:token", notAllowed);
  app.delete("/mcp/:token", notAllowed);
}
