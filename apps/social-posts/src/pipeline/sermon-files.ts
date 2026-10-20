// Where a sermon recording's bytes live while they arrive in pieces, and
// after. Pieces are appended in order (Cloudflare caps a request at 100 MB, so
// a sermon video comes in 8 MB pieces); a piece that breaks off halfway is cut
// back out so it can be sent again.
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const CHUNK_BYTES = 8 * 1024 * 1024;

export class UploadError extends Error {
  constructor(public status: number, message: string, public received?: number) { super(message); }
}

export const sermonDir = (dataDir: string, id: string) => join(dataDir, "sermons", id);
export const recordingPart = (dir: string) => join(dir, "recording.part");

export async function receivedBytes(dir: string): Promise<number> {
  try { return (await stat(recordingPart(dir))).size; } catch { return 0; }
}

/** Append one piece at `offset`; returns how many bytes have arrived in all. */
export async function appendChunk(dir: string, size: number, offset: number, body: Readable, maxChunk = CHUNK_BYTES): Promise<number> {
  await mkdir(dir, { recursive: true });
  const have = await receivedBytes(dir);
  if (offset !== have) {
    body.resume();
    throw new UploadError(409, "That piece is out of order.", have);
  }
  let count = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      count += chunk.length;
      if (count > maxChunk) return done(new UploadError(413, "That piece is too large."));
      if (have + count > size) return done(new UploadError(400, "That's more than the file's size."));
      done(null, chunk);
    },
  });
  try {
    await pipeline(body, counter, createWriteStream(recordingPart(dir), { flags: "a" }));
  } catch (e) {
    await truncate(recordingPart(dir), have).catch(() => {});
    if (e instanceof UploadError) throw e;
    throw new UploadError(400, "That piece didn't arrive in full.", have);
  }
  return have + count;
}

/** The finished recording, named with its type's extension so ffmpeg reads it right. */
export async function finishRecording(dir: string, ext: string): Promise<string> {
  const target = join(dir, "recording." + ext);
  await rename(recordingPart(dir), target);
  return target;
}

export async function removeSermonFiles(dataDir: string, id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return;
  await rm(sermonDir(dataDir, id), { recursive: true, force: true });
}
