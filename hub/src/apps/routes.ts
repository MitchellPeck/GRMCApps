import { FastifyInstance } from "fastify";
import { config } from "../config";
import { isSiblingOrigin } from "./host";
import { listAppsForUser, getUser, listActiveUsers, listUsersForApp } from "./registry";

// Enabled AND granted to this user. Both the dashboard and the switcher use
// this, so neither ever offers an app that answers 403.
async function appsWithHosts(userId: string) {
  const apps = await listAppsForUser(userId);
  return apps.map((a) => ({ ...a, host: `${a.subdomain}.${config.baseDomain}` }));
}

export async function appRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (req, reply) => {
    const q = req.query as { error?: string; email?: string };
    const loginView = () =>
      reply.view("login.ejs", { error: q.error ?? "", email: q.email ?? "" });

    if (!req.session.userId) return loginView();

    const user = await getUser(req.session.userId);
    // A user disabled or deleted while holding a live session loses it here.
    if (!user || !user.active) {
      await req.session.destroy();
      return reply.view("login.ejs", {
        error: user ? "disabled" : "not_provisioned",
        email: user?.email ?? "",
      });
    }
    return reply.view("dashboard.ejs", {
      user,
      apps: await appsWithHosts(user.id),
      hubHost: new URL(config.publicUrl).host,
    });
  });

  // The registry, for the cross-app switcher every app header renders. Only our
  // own app pages may read it, and only with a live session — the session cookie
  // is set on the shared parent domain, so the browser sends it along.
  app.get("/api/apps", async (req, reply) => {
    const origin = String(req.headers.origin ?? "");
    if (isSiblingOrigin(origin, config.baseDomain)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
    if (!req.session.userId) return reply.code(401).send({ ok: false, error: "Not signed in." });
    const apps = (await appsWithHosts(req.session.userId)).map((a) => ({
      slug: a.slug, name: a.name, subdomain: a.subdomain, icon: a.icon, url: `https://${a.host}/`,
    }));
    return { ok: true, hubUrl: config.publicUrl, apps };
  });

  // The user directory, for pickers inside apps (approvers, cardholders).
  // Same posture as /api/apps: a live session, and readable only from our own
  // subdomains. Any signed-in user can enumerate names and emails, which the
  // hub already allows for the app list and is acceptable on an invite-only
  // instance.
  app.get("/api/users", async (req, reply) => {
    const origin = String(req.headers.origin ?? "");
    if (isSiblingOrigin(origin, config.baseDomain)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
    if (!req.session.userId) return reply.code(401).send({ ok: false, error: "Not signed in." });

    const slug = String((req.query as { app?: string }).app ?? "").trim();
    const users = slug ? await listUsersForApp(slug) : await listActiveUsers();
    return { ok: true, users: users.map((u) => ({ email: u.email, name: u.name ?? "" })) };
  });
}
