import { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { config } from "./config";

// A transparent WebSocket relay: the browser connects to /ws/transcribe
// (same-origin, already gated by the hub's forward-auth on the upgrade
// request) and this proxies its frames to the internal WhisperLive container,
// keeping that container off the public network. The browser speaks the
// WhisperLive protocol directly (JSON config, then binary 16-bit PCM); we just
// pass frames through in both directions.
export async function transcribeSocket(app: FastifyInstance): Promise<void> {
  app.get("/ws/transcribe", { websocket: true }, (socket) => {
    const upstream = new WebSocket(config.whisperWsUrl);
    const queue: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
    let upstreamOpen = false;

    upstream.on("open", () => {
      upstreamOpen = true;
      for (const m of queue) upstream.send(m.data, { binary: m.binary });
      queue.length = 0;
    });

    // Browser → upstream (buffer until upstream is open).
    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else {
        queue.push({ data, binary: isBinary });
      }
    });

    // Upstream → browser (WhisperLive replies with JSON text frames).
    upstream.on("message", (data: WebSocket.RawData) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(typeof data === "string" ? data : data.toString());
      }
    });

    const closeBoth = () => {
      try { upstream.close(); } catch { /* noop */ }
      try { socket.close(); } catch { /* noop */ }
    };
    socket.on("close", () => { try { upstream.close(); } catch { /* noop */ } });
    socket.on("error", closeBoth);
    upstream.on("close", () => { try { socket.close(); } catch { /* noop */ } });
    upstream.on("error", () => {
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ error: "transcription service unavailable" })); } catch { /* noop */ }
      }
      closeBoth();
    });
  });
}
