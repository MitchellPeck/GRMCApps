import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { config } from "../config";
import { getSettingsView, setSetting } from "../settings";

interface SaveBody {
  anthropicKey?: string;
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async () => {
    try {
      return { ok: true, ...(await getSettingsView(pool)) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.post("/api/settings", async (req) => {
    try {
      const s = (req.body ?? {}) as SaveBody;
      if (s.anthropicKey && s.anthropicKey.trim())
        await setSetting(pool, "anthropic_api_key", s.anthropicKey.trim());
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // Public (within the authed host) transcription config so the browser client
  // sends the same model the whisper container has loaded.
  app.get("/api/transcription-config", async () => {
    return { ok: true, model: config.whisperModel };
  });
}
