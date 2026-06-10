import Fastify from "fastify";
import { Pool } from "pg";

const app = Fastify({ logger: true });
const pool = new Pool({ connectionString: process.env.WHOAMI_DATABASE_URL });

app.get("/", async (req, reply) => {
  // Prove the app can reach its OWN database with its own credentials.
  let dbTime = "unavailable";
  try {
    const r = await pool.query("SELECT now() AS now");
    dbTime = String(r.rows[0].now);
  } catch (e) {
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
    <html><head><meta charset="utf-8"><title>whoami</title>
    <style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem}
    pre{background:#1e293b;padding:1rem;border-radius:8px}</style></head>
    <body>
      <h1>whoami</h1>
      <p>Identity injected by the hub via Traefik forwardAuth:</p>
      <pre>${JSON.stringify(identity, null, 2)}</pre>
      <p>My own database time: <code>${dbTime}</code></p>
      <p><a style="color:#93c5fd" href="https://hub.lvh.me/">← Back to hub</a></p>
    </body></html>`);
});

app
  .listen({ host: "0.0.0.0", port: 3000 })
  .then(() => app.log.info("whoami listening on 3000"))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
