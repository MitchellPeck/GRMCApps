import { FastifyInstance } from "fastify";
import { config } from "../config";
import { listEnabledApps, getUser } from "./registry";

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
    const apps = (await listEnabledApps()).map((a) => ({
      ...a,
      host: `${a.subdomain}.${config.baseDomain}`,
    }));
    return reply.view("dashboard.ejs", { user, apps });
  });
}
