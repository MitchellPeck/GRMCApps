import { FastifyInstance } from "fastify";
import { config } from "../config";
import { isSiblingOrigin } from "./host";
import { listEnabledApps, getUser } from "./registry";

async function appsWithHosts() {
  const apps = await listEnabledApps();
  return apps.map((a) => ({ ...a, host: `${a.subdomain}.${config.baseDomain}` }));
}

export async function appRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (req, reply) => {
    if (!req.session.userId) {
      return reply.view("login.ejs", {});
    }
    const user = await getUser(req.session.userId);
    if (!user) {
      await req.session.destroy();
      return reply.view("login.ejs", {});
    }
    return reply.view("dashboard.ejs", { user, apps: await appsWithHosts() });
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
    const apps = (await appsWithHosts()).map((a) => ({
      slug: a.slug, name: a.name, subdomain: a.subdomain, icon: a.icon, url: `https://${a.host}/`,
    }));
    return { ok: true, hubUrl: config.publicUrl, apps };
  });
}
