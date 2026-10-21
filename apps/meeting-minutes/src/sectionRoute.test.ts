import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { sendSection } from "./routes/meetings";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

// Just enough of a Fastify reply to see what sendSection answers.
function fakeReply() {
  const r = { status: 200, headers: {} as Record<string, string>, body: undefined as unknown, raw: new EventEmitter(),
    code(n: number) { r.status = n; return r; },
    header(k: string, v: string) { r.headers[k] = v; return r; },
    send(b: unknown) { r.body = b; return r; } };
  return r;
}

test("sendSection refuses bad times and missing recordings without running ffmpeg", async () => {
  for (const q of [{}, { start: "5", end: "5" }, { start: "-1", end: "3" }, { start: "x", end: "3" }]) {
    const r = fakeReply();
    assert.deepEqual(await sendSection(r as any, "/nope", q), { ok: false, error: "Give a start and end time." });
    assert.equal(r.status, 400);
  }
  const none = fakeReply();
  await sendSection(none as any, undefined, { start: "0", end: "3" });
  assert.equal(none.status, 404);
  const gone = fakeReply();
  assert.deepEqual(await sendSection(gone as any, "/definitely/missing.webm", { start: "0", end: "3" }),
    { ok: false, error: "Recording file is missing." });
  assert.equal(gone.status, 404);
});

test("sendSection answers 416 past the end of the audio", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "section-test-"));
  try {
    const wav = join(dir, "a.wav");
    spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", wav]);
    const r = fakeReply();
    await sendSection(r as any, wav, { start: "100", end: "110" });
    assert.equal(r.status, 416);
    const ok = fakeReply();
    await sendSection(ok as any, wav, { start: "0", end: "2" });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["content-type"], "audio/mpeg");
    // Streamed, not buffered: playback can start while ffmpeg is still cutting.
    assert.ok(ok.body instanceof Readable);
    const closed = new Promise<void>((res) => (ok.body as Readable).on("close", () => res()));
    (ok.body as Readable).resume();
    ok.raw.emit("close"); // the listener went away
    await closed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
