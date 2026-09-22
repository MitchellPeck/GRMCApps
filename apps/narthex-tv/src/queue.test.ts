import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueue, processMedia, ProcessDeps, ProcessStore } from "./queue";
import { MediaRow } from "./media";

function media(over: Partial<MediaRow>): MediaRow {
  return {
    id: 1, kind: "image", title: "x", file_name: "x.jpg", mime_type: "image/jpeg",
    byte_size: 10, status: "pending", error: "", width: null, height: null,
    duration_ms: null, page_count: 0, original_path: "/data/media/1/original-x.jpg",
    play_path: "", poster_path: "", uploaded_by_email: "", uploaded_by_name: "",
    created_at: "", updated_at: "", ...over,
  } as MediaRow;
}

interface Recorder {
  store: ProcessStore;
  statuses: Array<{ status: string; error?: string }>;
  paths: Array<Record<string, unknown>>;
  pages: string[][];
}

function recorder(): Recorder {
  const statuses: Recorder["statuses"] = [];
  const paths: Recorder["paths"] = [];
  const pages: string[][] = [];
  return {
    statuses, paths, pages,
    store: {
      async setStatus(_id, status, error) { statuses.push({ status, error }); },
      async setPaths(_id, fields) { paths.push(fields as Record<string, unknown>); },
      async setPages(_id, list) { pages.push(list); },
    },
  };
}

function deps(over: Partial<ProcessDeps> = {}): ProcessDeps {
  const calls: string[] = [];
  const base: ProcessDeps = {
    async probe() { return { durationMs: 45_000, width: 1920, height: 1080, codec: "h264", hasVideo: true }; },
    async transcodeVideo() { calls.push("transcode"); },
    async extractPoster() { calls.push("poster"); },
    async normalizeImage() { calls.push("normalize"); },
    async makeThumbnail() { calls.push("thumb"); },
    async convertToPdf() { calls.push("pdf"); return "/tmp/out.pdf"; },
    async pdfToImages() { calls.push("slides"); return ["/s/slide-1.jpg", "/s/slide-2.jpg"]; },
  };
  return Object.assign(base, over, { calls } as unknown as ProcessDeps);
}

test("a JPEG is kept as it is and marked ready", async () => {
  const r = recorder();
  const d = deps();
  let normalized = false;
  d.normalizeImage = async () => { normalized = true; };
  await processMedia(media({ kind: "image", file_name: "x.jpg" }), "/data/media/1", r.store, d);

  assert.equal(normalized, false, "a browser-safe image needs no re-encode");
  assert.deepEqual(r.statuses.map((s) => s.status), ["processing", "ready"]);
  assert.equal(r.paths[0].playPath, "/data/media/1/original-x.jpg");
});

test("a HEIC is re-encoded to something a browser can show", async () => {
  const r = recorder();
  const d = deps();
  let normalizedTo = "";
  d.normalizeImage = async (_src, dst) => { normalizedTo = dst; };
  await processMedia(media({ kind: "image", file_name: "x.heic" }), "/data/media/1", r.store, d);

  assert.equal(normalizedTo, "/data/media/1/play.jpg");
  assert.equal(r.paths[0].playPath, "/data/media/1/play.jpg");
});

test("an H.264 MP4 is left alone but still gets a poster and a duration", async () => {
  const r = recorder();
  const d = deps();
  let transcoded = false;
  d.transcodeVideo = async () => { transcoded = true; };
  await processMedia(
    media({ kind: "video", file_name: "clip.mp4", original_path: "/data/media/2/original-clip.mp4" }),
    "/data/media/2", r.store, d
  );

  assert.equal(transcoded, false);
  assert.equal(r.paths[0].playPath, "/data/media/2/original-clip.mp4");
  assert.equal(r.paths[0].durationMs, 45_000);
  assert.equal(r.statuses.at(-1)?.status, "ready");
});

test("a ProRes .mov is transcoded to play.mp4", async () => {
  const r = recorder();
  const d = deps({
    async probe() { return { durationMs: 12_000, width: 1920, height: 1080, codec: "prores", hasVideo: true }; },
  });
  await processMedia(
    media({ kind: "video", file_name: "clip.mov", original_path: "/data/media/3/original-clip.mov" }),
    "/data/media/3", r.store, d
  );
  assert.equal(r.paths[0].playPath, "/data/media/3/play.mp4");
});

test("a file with no video track fails with a reason rather than a blank screen", async () => {
  const r = recorder();
  const d = deps({
    async probe() { return { durationMs: 1000, width: null, height: null, codec: "", hasVideo: false }; },
  });
  await assert.rejects(
    () => processMedia(media({ kind: "video", file_name: "x.mp4" }), "/d", r.store, d),
    /no video track/i
  );
});

test("a PowerPoint becomes a PDF and then one image per slide", async () => {
  const r = recorder();
  const d = deps();
  let pdfCalled = false;
  d.convertToPdf = async () => { pdfCalled = true; return "/tmp/out.pdf"; };
  await processMedia(
    media({ kind: "deck", file_name: "deck.pptx", original_path: "/data/media/4/original-deck.pptx" }),
    "/data/media/4", r.store, d
  );

  assert.equal(pdfCalled, true);
  assert.deepEqual(r.pages[0], ["/s/slide-1.jpg", "/s/slide-2.jpg"]);
  assert.equal(r.paths[0].pageCount, 2);
  assert.equal(r.statuses.at(-1)?.status, "ready");
});

test("a PDF skips LibreOffice and goes straight to slides", async () => {
  const r = recorder();
  const d = deps();
  let pdfCalled = false;
  d.convertToPdf = async () => { pdfCalled = true; return "/tmp/out.pdf"; };
  await processMedia(
    media({ kind: "deck", file_name: "bulletin.pdf", original_path: "/data/media/5/original-bulletin.pdf" }),
    "/data/media/5", r.store, d
  );
  assert.equal(pdfCalled, false);
  assert.equal(r.pages[0].length, 2);
});

test("an upload whose bytes never arrived fails cleanly", async () => {
  const r = recorder();
  await assert.rejects(
    () => processMedia(media({ original_path: "" }), "/d", r.store, deps()),
    /missing/i
  );
});

test("the queue runs one job at a time, in order", async () => {
  const log: string[] = [];
  const queue = createQueue(() => {});
  let running = 0;
  let maxConcurrent = 0;

  for (const label of ["a", "b", "c"]) {
    queue.enqueue({
      label,
      async run() {
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((r) => setTimeout(r, 5));
        log.push(label);
        running--;
      },
      async fail() {},
    });
  }
  await queue.idle();
  assert.deepEqual(log, ["a", "b", "c"]);
  assert.equal(maxConcurrent, 1);
});

test("a failing job is recorded and the queue carries on", async () => {
  const done: string[] = [];
  const failed: string[] = [];
  const queue = createQueue(() => {});

  queue.enqueue({
    label: "bad",
    async run() { throw new Error("soffice exploded"); },
    async fail(message) { failed.push(message); },
  });
  queue.enqueue({ label: "good", async run() { done.push("good"); }, async fail() {} });

  await queue.idle();
  assert.deepEqual(failed, ["soffice exploded"]);
  assert.deepEqual(done, ["good"]);
});
