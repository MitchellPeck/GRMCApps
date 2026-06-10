import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import { config } from "./config";
import { pool } from "./db";
import { PgSessionStore } from "./session-store";
import { authRoutes } from "./auth/routes";

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
app.register(fastifySession, {
  secret: config.sessionSecret,
  store: new PgSessionStore(pool),
  cookieName: "sid",
  cookie: {
    domain: config.cookieDomain,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000,
  },
});

app.register(authRoutes);

app.get("/healthz", async () => ({ ok: true }));

app
  .listen({ host: "0.0.0.0", port: config.port })
  .then(() => app.log.info(`hub listening on ${config.port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

export { app };
