import { FastifyInstance } from "fastify";
import { getOidcClient, generators } from "./oidc";
import { config } from "../config";
import { pool } from "../db";
import { getAppByHost, getUser } from "../apps/registry";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth/login", async (req, reply) => {
    const client = await getOidcClient();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    const state = generators.state();

    // Start a fresh session before storing pre-auth secrets (session-fixation defense).
    await req.session.regenerate();
    req.session.codeVerifier = codeVerifier;
    req.session.oauthState = state;
    req.session.returnTo =
      (req.query as { redirect?: string }).redirect ?? config.publicUrl;

    const url = client.authorizationUrl({
      scope: "openid email profile",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });
    reply.redirect(url);
  });

  app.get("/auth/callback", async (req, reply) => {
    const client = await getOidcClient();
    const params = client.callbackParams(req.raw);

    // Capture pre-auth values before any session reset.
    const codeVerifier = req.session.codeVerifier;
    const oauthState = req.session.oauthState;
    const returnTo = req.session.returnTo ?? config.publicUrl;

    let claims;
    try {
      const tokenSet = await client.callback(config.google.redirectUri, params, {
        code_verifier: codeVerifier,
        state: oauthState,
      });
      claims = tokenSet.claims();
    } catch (err) {
      req.log.warn({ err }, "oidc callback failed");
      await req.session.destroy();
      reply.redirect(`${config.publicUrl}?error=auth_failed`);
      return;
    }

    if (!claims.sub || !claims.email) {
      req.log.warn("oidc callback missing required claims");
      await req.session.destroy();
      reply.redirect(`${config.publicUrl}?error=auth_failed`);
      return;
    }

    const result = await pool.query(
      `INSERT INTO users (google_sub, email, name, last_login)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (google_sub)
       DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, last_login = now()
       RETURNING id`,
      [claims.sub, claims.email, claims.name ?? null]
    );

    // New session id now that the user is authenticated (session-fixation defense).
    await req.session.regenerate();
    req.session.userId = result.rows[0].id;
    reply.redirect(returnTo);
  });

  app.get("/auth/logout", async (req, reply) => {
    await req.session.destroy();
    reply.redirect(config.publicUrl);
  });

  // Called by Traefik's forwardAuth before routing to any app.
  app.get("/auth/verify", async (req, reply) => {
    const forwardedHost = (req.headers["x-forwarded-host"] as string) ?? "";
    const forwardedUri = (req.headers["x-forwarded-uri"] as string) ?? "/";
    const forwardedProto = (req.headers["x-forwarded-proto"] as string) ?? "https";

    if (!req.session.userId) {
      const original = `${forwardedProto}://${forwardedHost}${forwardedUri}`;
      return reply.redirect(
        `${config.publicUrl}/auth/login?redirect=${encodeURIComponent(original)}`
      );
    }

    const appRow = await getAppByHost(forwardedHost);
    if (!appRow || !appRow.enabled) {
      return reply.code(403).send("Forbidden: unknown or disabled app");
    }

    const user = await getUser(req.session.userId);
    if (!user) {
      return reply.code(403).send("Forbidden: unknown user");
    }

    // v1: any authenticated user may access any enabled app.
    reply
      .header("X-Auth-User-Id", user.id)
      .header("X-Auth-Email", user.email)
      .header("X-Auth-Name", user.name ?? "")
      .header("X-Auth-Roles", "user")
      .code(200)
      .send("ok");
  });
}
