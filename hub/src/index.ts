import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import fastifyStatic from "@fastify/static";
import fastifyView from "@fastify/view";
import ejs from "ejs";
import { join } from "node:path";
import { config } from "./config";
import { pool } from "./db";
import { PgSessionStore } from "./session-store";
import { authRoutes } from "./auth/routes";
import { appRoutes } from "./apps/routes";

declare module "fastify" {
  interface Session {
    userId?: string;
    codeVerifier?: string;
    oauthState?: string;
    returnTo?: string;
  }
}

const app = Fastify({ logger: true, trustProxy: true });

app.register(fastifyCookie);
app.register(fastifyView, {
  engine: { ejs },
  root: join(__dirname, "views"),
});
const sessionStore = new PgSessionStore(pool);
app.register(fastifySession, {
  secret: config.sessionSecret,
  store: sessionStore,
  cookieName: "sid",
  // Don't persist sessions that were never written to. Without this, every
  // unauthenticated forwardAuth check (/auth/verify) would create an orphan
  // session row on the gateway hot path. The login flow mutates the session
  // (PKCE/state, then userId), so real sessions are still saved.
  saveUninitialized: false,
  cookie: {
    domain: config.cookieDomain,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000,
  },
});

app.register(fastifyStatic, { root: join(__dirname, "public", "assets"), prefix: "/assets/", decorateReply: false });
app.register(authRoutes);
app.register(appRoutes);

app.get("/healthz", async () => ({ ok: true }));

app
  .listen({ host: "0.0.0.0", port: config.port })
  .then(() => {
    app.log.info(`hub listening on ${config.port}`);
    // Periodically reclaim expired session rows (hourly).
    const prune = setInterval(() => {
      sessionStore
        .pruneExpired()
        .then((n) => n > 0 && app.log.info(`pruned ${n} expired sessions`))
        .catch((err) => app.log.warn({ err }, "session prune failed"));
    }, 60 * 60 * 1000);
    prune.unref();
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

export { app };
