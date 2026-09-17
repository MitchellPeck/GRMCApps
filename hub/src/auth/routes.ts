import { FastifyInstance } from "fastify";
import type { AuthorizationParameters } from "openid-client";
import { getOidcClient, generators } from "./oidc";
import { config } from "../config";
import { subdomainFromHost } from "../apps/host";
import { decideAccess, roleHeader } from "../users/access-decision";
import { decideLogin } from "../users/login-decision";
import { normalizeEmail } from "../users/email";
import {
  bindGoogleIdentity,
  findByEmail,
  findBySub,
  loadVerifyContext,
  touchLogin,
} from "../users/repo";

// Short-lived marker cookie set on logout. It survives the destroyed session
// cookie and tells the next /auth/login to force a Google prompt instead of
// letting Google silently re-authenticate the still-active account session.
const REAUTH_COOKIE = "grmc_reauth";

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

    const authParams: AuthorizationParameters = {
      scope: "openid email profile",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    };

    // If the user just logged out, force Google to show the account chooser
    // rather than silently re-authenticating, then consume the marker.
    if (req.cookies[REAUTH_COOKIE]) {
      authParams.prompt = "select_account";
      reply.clearCookie(REAUTH_COOKIE, { domain: config.cookieDomain, path: "/" });
    }

    reply.redirect(client.authorizationUrl(authParams));
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

    // Invite-only: an account must already exist. This replaces the previous
    // just-in-time INSERT, which let any Google account in.
    const email = normalizeEmail(claims.email);
    const bySub = await findBySub(claims.sub);
    const byEmail = bySub ? null : await findByEmail(email);
    const name = claims.name ?? null;
    const decision = decideLogin(bySub, byEmail, { sub: claims.sub, email, name });

    if (decision.kind === "deny") {
      req.log.warn(
        { email, sub: claims.sub, reason: decision.reason },
        "login denied by user management"
      );
      await req.session.destroy();
      reply.redirect(
        `${config.publicUrl}?error=${decision.reason}&email=${encodeURIComponent(claims.email)}`
      );
      return;
    }

    if (decision.kind === "bind") {
      await bindGoogleIdentity(decision.userId, claims.sub, claims.email, name);
    } else {
      await touchLogin(decision.userId, claims.email, name);
    }

    // New session id now that the user is authenticated (session-fixation defense).
    await req.session.regenerate();
    req.session.userId = decision.userId;
    reply.redirect(returnTo);
  });

  app.get("/auth/logout", async (req, reply) => {
    await req.session.destroy();
    // @fastify/session sets request.session = null on destroy, so its onSend
    // hook skips clearing the cookie — clear it explicitly so the browser
    // drops the dangling sid cookie.
    reply.clearCookie("sid", { domain: config.cookieDomain, path: "/" });
    // Mark this as an explicit logout so the next login forces a Google prompt.
    reply.setCookie(REAUTH_COOKIE, "1", {
      domain: config.cookieDomain,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600,
    });
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

    const hubHost = new URL(config.publicUrl).host;
    const deny = (message: string) =>
      reply.code(403).view("denied.ejs", { message, hubHost });

    const subdomain = subdomainFromHost(forwardedHost, config.baseDomain);
    if (!subdomain) return deny("That address is not a GRMC app.");

    // One query: identity, app and grant together, on the gateway hot path.
    const ctx = await loadVerifyContext(req.session.userId, subdomain);
    if (!ctx) return deny("Your account could not be found. Sign in again.");
    if (ctx.app_id === null) return deny("That address is not a GRMC app.");

    const decision = decideAccess({
      userActive: ctx.user_active,
      appEnabled: ctx.app_enabled === true,
      hasGrant: ctx.has_grant,
    });

    if (!decision.allowed) {
      req.log.warn(
        { userId: ctx.id, subdomain, reason: decision.reason },
        "app access denied"
      );
      if (decision.reason === "app_disabled") return deny("That app is turned off.");
      if (decision.reason === "user_disabled") {
        return deny("Your account has been disabled. Ask an administrator.");
      }
      return deny("You do not have access to this app. Ask an administrator.");
    }

    reply
      .header("X-Auth-User-Id", ctx.id)
      .header("X-Auth-Email", ctx.email)
      .header("X-Auth-Name", ctx.name ?? "")
      .header("X-Auth-Roles", roleHeader(ctx.is_admin))
      .code(200)
      .send("ok");
  });
}
