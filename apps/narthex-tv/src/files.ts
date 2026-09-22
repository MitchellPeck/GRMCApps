import { FastifyReply, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export interface RangeSpec {
  start: number;
  end: number;
}

/**
 * Parses a single-range `Range: bytes=…` header. Multi-range is not supported —
 * no browser asks for one on media — and anything unparseable returns null so
 * the caller falls back to sending the whole file.
 */
export function parseRange(header: string | undefined, size: number): RangeSpec | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
  if (!m || size <= 0) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    // A suffix range: the last N bytes.
    const length = Number(rawEnd);
    if (!isFinite(length) || length <= 0) return null;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!isFinite(start) || !isFinite(end) || start < 0 || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Serves a file off the media volume with byte-range support. Chrome will not
 * seek — or reliably loop — an MP4 served without it, so this matters for the
 * video half of the TV.
 */
export async function sendFile(
  req: FastifyRequest,
  reply: FastifyReply,
  path: string,
  contentType: string,
  cacheSeconds = 3600
): Promise<FastifyReply> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return reply.code(404).send({ ok: false, error: "That file is no longer on disk." });
  }
  if (!info.isFile()) {
    return reply.code(404).send({ ok: false, error: "That file is no longer on disk." });
  }

  reply.header("content-type", contentType);
  reply.header("accept-ranges", "bytes");
  // The bytes at a given URL never change — a new upload gets a new id — so the
  // TV can hold them for as long as it likes.
  reply.header("cache-control", `private, max-age=${cacheSeconds}`);

  const range = parseRange(req.headers.range as string | undefined, info.size);
  if (!range) {
    reply.header("content-length", String(info.size));
    return reply.send(createReadStream(path));
  }
  reply.code(206);
  reply.header("content-range", `bytes ${range.start}-${range.end}/${info.size}`);
  reply.header("content-length", String(range.end - range.start + 1));
  return reply.send(createReadStream(path, { start: range.start, end: range.end }));
}
