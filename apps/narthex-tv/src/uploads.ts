import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// Uploads arrive in pieces, never as one request. Everything public reaches
// this app through the Cloudflare tunnel, which refuses a request body over
// 100 MB, and Traefik drops a request that takes longer than 60 seconds to
// arrive — so a few minutes of phone video can't make it in one go. 8 MB is
// small enough to finish well inside that minute on a slow church uplink.
export const CHUNK_BYTES = 8 * 1024 * 1024;

export interface Staged {
  id: string;
  fileName: string;
  originalName: string;
  mimeType: string;
  size: number;
  ownerEmail: string;
  ownerName: string;
}

export class UploadError extends Error {
  constructor(public status: number, message: string, public received?: number) {
    super(message);
  }
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function stagingRoot(dataDir: string): string {
  return join(dataDir, "uploads");
}

const dataPath = (root: string, id: string) => join(root, id, "data");
const metaPath = (root: string, id: string) => join(root, id, "meta.json");

export async function beginUpload(root: string, fields: Omit<Staged, "id">): Promise<Staged> {
  const staged: Staged = { id: randomUUID(), ...fields };
  await mkdir(join(root, staged.id), { recursive: true });
  await writeFile(dataPath(root, staged.id), "");
  await writeFile(metaPath(root, staged.id), JSON.stringify(staged));
  return staged;
}

/** Null for anything that isn't a live upload — including an id that would
 *  walk out of the staging directory. */
export async function readStaged(root: string, id: string): Promise<Staged | null> {
  if (!ID.test(id)) return null;
  try {
    return JSON.parse(await readFile(metaPath(root, id), "utf8")) as Staged;
  } catch {
    return null;
  }
}

export async function receivedBytes(root: string, id: string): Promise<number> {
  return (await stat(dataPath(root, id))).size;
}

/**
 * Append one piece at `offset`. The offset must be exactly what has arrived so
 * far: a retry of a piece that already landed is told where to carry on from,
 * and a piece that breaks off halfway is cut back out so it can be sent again.
 */
export async function appendChunk(
  root: string,
  staged: Staged,
  offset: number,
  body: Readable,
  maxChunk = CHUNK_BYTES
): Promise<number> {
  const have = await receivedBytes(root, staged.id);
  if (offset !== have) {
    body.resume();
    throw new UploadError(409, "That piece is out of order.", have);
  }

  let count = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      count += chunk.length;
      if (count > maxChunk) return done(new UploadError(413, "That piece is too large."));
      if (have + count > staged.size) return done(new UploadError(400, "That's more than the file's size."));
      done(null, chunk);
    },
  });

  try {
    await pipeline(body, counter, createWriteStream(dataPath(root, staged.id), { flags: "a" }));
  } catch (e) {
    await truncate(dataPath(root, staged.id), have).catch(() => {});
    if (e instanceof UploadError) throw e;
    throw new UploadError(400, "That piece didn't arrive in full.", have);
  }
  return have + count;
}

/** Move the finished bytes to where the media row expects them. */
export async function takeStaged(root: string, id: string, target: string): Promise<void> {
  await rename(dataPath(root, id), target);
  await discardStaged(root, id);
}

export async function discardStaged(root: string, id: string): Promise<void> {
  if (!ID.test(id)) return;
  await rm(join(root, id), { recursive: true, force: true });
}

/** Uploads someone walked away from. Their bytes would otherwise sit on the
 *  volume forever. */
export async function sweepStale(root: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!ID.test(name)) continue;
    // The data file, not the directory: appending doesn't touch the
    // directory's mtime, so an upload still in progress would look abandoned.
    const info = await stat(dataPath(root, name)).catch(() => stat(join(root, name)).catch(() => null));
    if (info && now - info.mtimeMs > maxAgeMs) {
      await discardStaged(root, name);
      removed++;
    }
  }
  return removed;
}
