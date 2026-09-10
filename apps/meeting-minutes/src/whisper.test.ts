import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer, Server, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { hasAudioExtension, parseVerboseJson, transcribeAudio, uploadName } from "./whisper";
import { config } from "./config";

// Start a stand-in whisper server, point config at it, and return a stop().
// `handler` receives the raw request body so tests can assert on the multipart.
async function withWhisper(
  handler: (body: Buffer, req: IncomingMessage, res: ServerResponse) => void
): Promise<{ stop: () => Promise<void>; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(Buffer.concat(chunks), req, res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const previous = config.whisperRestUrl;
  config.whisperRestUrl = `http://127.0.0.1:${port}`;
  return {
    server,
    stop: async () => {
      config.whisperRestUrl = previous;
      await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    },
  };
}

const CLIP = { fileName: "item-3.webm", mimeType: "audio/webm", buffer: Buffer.from("fake audio bytes") };

test("hasAudioExtension recognizes common audio containers", () => {
  ["rec.mp3", "clip.m4a", "a.wav", "b.webm", "c.ogg", "d.flac", "e.MP4"].forEach((n) => {
    assert.ok(hasAudioExtension(n), n);
  });
});

test("hasAudioExtension rejects non-audio names", () => {
  ["agenda.pdf", "notes.txt", "image.png", "noext"].forEach((n) => {
    assert.ok(!hasAudioExtension(n), n);
  });
});

test("parseVerboseJson extracts diarized segments", () => {
  const raw = JSON.stringify({
    text: "We should launch next week. I think QA needs two more days.",
    segments: [
      { id: 0, start: 1.0, end: 3.5, text: " We should launch next week.", speaker: "SPEAKER_00" },
      { id: 1, start: 4.0, end: 6.2, text: "I think QA needs two more days.", speaker: "SPEAKER_01" },
    ],
  });
  const r = parseVerboseJson(raw);
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].speaker, "SPEAKER_00");
  assert.equal(r.segments[0].text, "We should launch next week."); // trimmed
  assert.match(r.text, /launch next week/);
});

test("parseVerboseJson tolerates missing speakers and empty segments", () => {
  const r = parseVerboseJson(JSON.stringify({ text: "hi", segments: [{ text: "hi" }, { text: "  " }] }));
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].speaker, "");
});

test("parseVerboseJson falls back to plain text on non-JSON", () => {
  const r = parseVerboseJson("just plain text");
  assert.equal(r.text, "just plain text");
  assert.deepEqual(r.segments, []);
});

test("uploadName keeps a known extension and falls back through the mime type", () => {
  assert.equal(uploadName("item-3.webm", "audio/webm"), "audio.webm");
  assert.equal(uploadName("board meeting.M4A", "audio/x-m4a"), "audio.m4a");
  assert.equal(uploadName("recording", "audio/x-m4a"), "audio.m4a");
  assert.equal(uploadName("recording", "audio/mpeg"), "audio.mp3");
  assert.equal(uploadName("notes.txt", "application/octet-stream"), "audio.webm");
  // A hostile filename never reaches the multipart headers.
  assert.equal(uploadName('a"\r\nX-Evil: 1.webm', "audio/webm"), "audio.webm");
});

test("transcribeAudio posts a well-formed multipart body and parses the result", async () => {
  let seen: Buffer = Buffer.alloc(0);
  let contentType = "";
  const w = await withWhisper((body, req, res) => {
    seen = body;
    contentType = String(req.headers["content-type"] ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      text: "Hello there.",
      segments: [{ start: 0, end: 1.5, text: " Hello there.", speaker: "SPEAKER_00" }],
    }));
  });
  try {
    const r = await transcribeAudio(CLIP);
    assert.equal(r.segments.length, 1);
    assert.equal(r.segments[0].speaker, "SPEAKER_00");
    assert.equal(r.segments[0].text, "Hello there.");
  } finally { await w.stop(); }

  const boundary = /boundary=(\S+)/.exec(contentType)?.[1] ?? "";
  assert.ok(boundary, "a boundary is declared");
  const text = seen.toString("latin1");
  assert.ok(text.startsWith(`--${boundary}\r\n`), "body opens with the boundary");
  assert.ok(text.endsWith(`--${boundary}--\r\n`), "body closes with the terminator");
  assert.match(text, /name="response_format"\r\n\r\nverbose_json\r\n/);
  assert.match(text, /name="language"\r\n\r\nen\r\n/);
  assert.match(text, /name="file"; filename="audio\.webm"/);
  assert.ok(seen.includes(CLIP.buffer), "the audio bytes survive intact");
  assert.ok(!text.includes(`--${boundary}--\r\n--`), "no trailing parts after the terminator");
});

// The bug this guards: global fetch (undici) abandons a request after 300s of
// waiting for response headers, and whisper sends none until the whole job is
// done. That capped transcription at roughly 100 seconds of audio. The
// transport must therefore not be fetch at all.
test("transcribeAudio does not go through global fetch", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("fetch must not be used — it caps requests at 300s"); }) as typeof fetch;
  const w = await withWhisper((_b, _req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "ok", segments: [] }));
  });
  try {
    assert.equal((await transcribeAudio(CLIP)).text, "ok");
  } finally {
    await w.stop();
    globalThis.fetch = realFetch;
  }
});

test("transcribeAudio waits for a slow response instead of giving up", async () => {
  const w = await withWhisper((_b, _req, res) => {
    // Headers withheld, as whisper does while it works.
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "slow but finished", segments: [] }));
    }, 400);
  });
  try {
    assert.equal((await transcribeAudio(CLIP)).text, "slow but finished");
  } finally { await w.stop(); }
});

test("a transcription that overruns its deadline says so", async () => {
  const previous = config.whisperTimeoutMs;
  config.whisperTimeoutMs = 150;
  const w = await withWhisper(() => { /* never respond */ });
  try {
    await assert.rejects(transcribeAudio(CLIP), /did not finish within/);
  } finally {
    config.whisperTimeoutMs = previous;
    await w.stop();
  }
});

test("a whisper error response surfaces the server's message", async () => {
  const w = await withWhisper((_b, _req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "unsupported audio format" } }));
  });
  try {
    await assert.rejects(transcribeAudio(CLIP), /unsupported audio format/);
  } finally { await w.stop(); }
});

test("an unreachable whisper still reports an unreachable container", async () => {
  const previous = config.whisperRestUrl;
  // Port 1 on loopback refuses connections.
  config.whisperRestUrl = "http://127.0.0.1:1";
  try {
    await assert.rejects(transcribeAudio(CLIP), /unreachable/);
  } finally { config.whisperRestUrl = previous; }
});

// The multipart body is built by hand, so prove a real parser accepts it
// rather than trusting the byte-level assertions above.
test("the hand-built multipart body round-trips through a real parser", async () => {
  const Fastify = require("fastify");
  const multipart = require("@fastify/multipart");
  const app = Fastify();
  const fields: Record<string, string> = {};
  let fileName = "", fileBytes: Buffer = Buffer.alloc(0);
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  app.post("/v1/audio/transcriptions", async (req: any) => {
    for await (const part of req.parts()) {
      if (part.type === "file") { fileName = part.filename; fileBytes = await part.toBuffer(); }
      else fields[part.fieldname] = String(part.value ?? "");
    }
    return { text: "parsed", segments: [] };
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const previous = config.whisperRestUrl;
  config.whisperRestUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    assert.equal((await transcribeAudio(CLIP)).text, "parsed");
    assert.deepEqual(fields, { model: "whisper-1", language: "en", response_format: "verbose_json" });
    assert.equal(fileName, "audio.webm");
    assert.deepEqual(fileBytes, CLIP.buffer);
  } finally {
    config.whisperRestUrl = previous;
    await app.close();
  }
});
