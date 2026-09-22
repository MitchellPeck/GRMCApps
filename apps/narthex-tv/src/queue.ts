import { Pool } from "pg";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  MediaRow, mediaDir, replacePages, setMediaPaths, setMediaStatus, listUnfinished,
} from "./media";
import { isBrowserImage, needsTranscode } from "./ingest";
import * as convert from "./convert";

export interface QueueTask {
  label: string;
  run(): Promise<void>;
  fail(message: string): Promise<void>;
}

export interface Queue {
  enqueue(task: QueueTask): void;
  size(): number;
  idle(): Promise<void>;
}

/**
 * A single-consumer FIFO. One conversion at a time on purpose: LibreOffice and
 * ffmpeg will each happily eat every core on the host, and this box is also
 * running the rest of the stack — including the TV the whole thing exists for.
 */
export function createQueue(log: (message: string) => void): Queue {
  const pending: QueueTask[] = [];
  const idleWaiters: Array<() => void> = [];
  let running = false;

  function safeLog(message: string): void {
    try { log(message); } catch { /* logging must never break the queue */ }
  }

  function releaseIdle(): void {
    while (idleWaiters.length) idleWaiters.shift()!();
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const task = pending.shift()!;
        try {
          await task.run();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          safeLog(`narthex-tv: ${task.label} failed — ${message}`);
          try { await task.fail(message); } catch { /* already failing */ }
        }
      }
    } finally {
      running = false;
      releaseIdle();
    }
  }

  return {
    enqueue(task) {
      pending.push(task);
      void drain();
    },
    size: () => pending.length + (running ? 1 : 0),
    idle() {
      if (!running && !pending.length) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}

export interface ProcessDeps {
  probe(path: string): Promise<convert.Probe>;
  transcodeVideo(src: string, dst: string): Promise<void>;
  extractPoster(src: string, dst: string): Promise<void>;
  normalizeImage(src: string, dst: string): Promise<void>;
  makeThumbnail(src: string, dst: string): Promise<void>;
  convertToPdf(src: string, outDir: string): Promise<string>;
  pdfToImages(pdf: string, outDir: string): Promise<string[]>;
}

export const realDeps: ProcessDeps = {
  probe: convert.probe,
  transcodeVideo: convert.transcodeVideo,
  extractPoster: convert.extractPoster,
  normalizeImage: convert.normalizeImage,
  makeThumbnail: convert.makeThumbnail,
  convertToPdf: convert.convertToPdf,
  pdfToImages: convert.pdfToImages,
};

export interface ProcessStore {
  setStatus(id: number, status: MediaRow["status"], error?: string): Promise<void>;
  setPaths(id: number, fields: Parameters<typeof setMediaPaths>[2]): Promise<void>;
  setPages(id: number, paths: string[]): Promise<void>;
}

/**
 * Turn one upload into something the player can show without thinking:
 *   image -> a browser-safe still (+ a thumbnail for the admin grid)
 *   video -> H.264/MP4 with the audio stripped (+ a poster frame)
 *   deck  -> a PDF, then one JPEG per slide
 *
 * Every side effect is injected so the state machine is testable with no
 * filesystem, no database and no LibreOffice.
 */
export async function processMedia(
  media: MediaRow,
  dir: string,
  store: ProcessStore,
  deps: ProcessDeps
): Promise<void> {
  await store.setStatus(media.id, "processing");
  const original = media.original_path;
  if (!original) throw new Error("The uploaded file is missing.");

  if (media.kind === "image") {
    let play = original;
    if (!isBrowserImage(media.file_name)) {
      play = join(dir, "play.jpg");
      await deps.normalizeImage(original, play);
    }
    const info = await deps.probe(play).catch(() => null);
    const poster = join(dir, "poster.jpg");
    await deps.makeThumbnail(play, poster).catch(() => {});
    await store.setPaths(media.id, {
      playPath: play,
      posterPath: poster,
      width: info?.width ?? null,
      height: info?.height ?? null,
    });
    await store.setStatus(media.id, "ready");
    return;
  }

  if (media.kind === "video") {
    const info = await deps.probe(original);
    if (!info.hasVideo) throw new Error("That file has no video track.");
    let play = original;
    if (needsTranscode(media.file_name, info.codec)) {
      play = join(dir, "play.mp4");
      await deps.transcodeVideo(original, play);
    }
    const poster = join(dir, "poster.jpg");
    await deps.extractPoster(play, poster).catch(() => {});
    // Re-probe only when we re-encoded: the scale filter changes the dimensions
    // and trimming can nudge the duration.
    const final = play === original ? info : await deps.probe(play).catch(() => info);
    await store.setPaths(media.id, {
      playPath: play,
      posterPath: poster,
      width: final.width ?? null,
      height: final.height ?? null,
      durationMs: final.durationMs ?? info.durationMs ?? null,
    });
    await store.setStatus(media.id, "ready");
    return;
  }

  // deck: PowerPoint, Keynote-exported, ODP or a PDF someone already made.
  const workDir = join(dir, "work");
  const pdf = /\.pdf$/i.test(media.file_name)
    ? original
    : await deps.convertToPdf(original, workDir);
  const slides = await deps.pdfToImages(pdf, join(dir, "slides"));
  await store.setPages(media.id, slides);
  const poster = join(dir, "poster.jpg");
  await deps.makeThumbnail(slides[0], poster).catch(() => {});
  await store.setPaths(media.id, { posterPath: poster, pageCount: slides.length });
  await store.setStatus(media.id, "ready");
  // The intermediate PDF and LibreOffice profile are pure scratch; the slides
  // are what the player reads.
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}

export function storeFor(pool: Pool): ProcessStore {
  return {
    setStatus: (id, status, error) => setMediaStatus(pool, id, status, error),
    setPaths: (id, fields) => setMediaPaths(pool, id, fields),
    setPages: (id, paths) => replacePages(pool, id, paths),
  };
}

export function enqueueMedia(
  queue: Queue,
  pool: Pool,
  media: MediaRow,
  deps: ProcessDeps = realDeps
): void {
  const store = storeFor(pool);
  queue.enqueue({
    label: `convert media ${media.id} (${media.file_name})`,
    run: () => processMedia(media, mediaDir(media.id), store, deps),
    fail: (message) => setMediaStatus(pool, media.id, "failed", message),
  });
}

/** A restart must not strand an upload half-converted. */
export async function resumePending(
  queue: Queue,
  pool: Pool,
  log: (m: string) => void,
  deps: ProcessDeps = realDeps
): Promise<void> {
  const rows = await listUnfinished(pool);
  if (!rows.length) return;
  log(`narthex-tv: resuming ${rows.length} unfinished upload(s)`);
  for (const row of rows) enqueueMedia(queue, pool, row, deps);
}
