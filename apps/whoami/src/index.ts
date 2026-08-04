import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { Pool } from "pg";

const app = Fastify({ logger: true });
const pool = new Pool({ connectionString: process.env.WHOAMI_DATABASE_URL });

// Shared design system + cross-app switcher, same as every other GRMC app. The
// switcher derives the hub URL from the host, so nothing here needs BASE_DOMAIN.
app.register(fastifyStatic, { root: join(__dirname, "public", "assets"), prefix: "/assets/" });

function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

app.get("/api/me", async (req) => ({
  ok: true,
  email: (req.headers["x-auth-email"] as string) ?? "",
  name: (req.headers["x-auth-name"] as string) ?? "",
}));

app.get("/", async (req, reply) => {
  // Prove the app can reach its OWN database with its own credentials.
  let dbTime = "unavailable";
  let dbOk = true;
  try {
    const r = await pool.query("SELECT now() AS now");
    dbTime = String(r.rows[0].now);
  } catch (e) {
    dbOk = false;
    dbTime = `error: ${(e as Error).message}`;
  }

  // Identity headers are injected by Traefik forwardAuth (from the hub).
  const identity = {
    userId: req.headers["x-auth-user-id"] ?? null,
    email: req.headers["x-auth-email"] ?? null,
    name: req.headers["x-auth-name"] ?? null,
    roles: req.headers["x-auth-roles"] ?? null,
  };

  reply.type("text/html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GRMC Who Am I</title>
<link rel="stylesheet" href="/assets/grmc.css">
</head>
<body>
<header>
  <div class="logo">
    <div class="seal">G</div>
    <div><h1>Who Am I</h1><p>Identity &amp; connectivity check</p></div>
  </div>
  <div class="hright"></div>
</header>
<div class="layout">
  <div class="card">
    <div class="ct">Identity from the hub</div>
    <div class="hint" style="margin:-8px 0 12px">Injected by Traefik forwardAuth on every request.</div>
    <pre style="font-size:12.5px;line-height:1.7;white-space:pre-wrap;background:var(--paper);border:1px solid var(--rule);border-radius:var(--r);padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${esc(JSON.stringify(identity, null, 2))}</pre>
  </div>
  <div class="card">
    <div class="ct">Database</div>
    <div class="hint" style="margin:-8px 0 12px">This app's own credentials against its own database.</div>
    <div class="alert ${dbOk ? "alert-ok" : "alert-err"}" style="margin:0">${esc(dbTime)}</div>
  </div>
</div>
<script src="/assets/grmc-nav.js"></script>
</body>
</html>`);
});

app
  .listen({ host: "0.0.0.0", port: 3000 })
  .then(() => app.log.info("whoami listening on 3000"))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
