import Fastify from "fastify";
import { config } from "./config";

const app = Fastify({ logger: true, trustProxy: true });

app.get("/healthz", async () => ({ ok: true }));

app
  .listen({ host: "0.0.0.0", port: config.port })
  .then(() => app.log.info(`hub listening on ${config.port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
