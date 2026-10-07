import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  UploadError, appendChunk, beginUpload, readStaged, receivedBytes, sweepStale, takeStaged,
} from "./uploads";

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "narthex-uploads-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const fields = (size: number) => ({
  fileName: "clip.mov", originalName: "clip.mov", mimeType: "video/quicktime",
  size, ownerEmail: "a@example.org", ownerName: "A",
});

test("pieces sent in order reassemble into the file", async () => {
  await withRoot(async (root) => {
    const staged = await beginUpload(root, fields(10));
    assert.equal(await appendChunk(root, staged, 0, Readable.from([Buffer.from("hello")]), 5), 5);
    assert.equal(await appendChunk(root, staged, 5, Readable.from([Buffer.from("world")]), 5), 10);
    const target = join(root, "done");
    await takeStaged(root, staged.id, target);
    assert.equal(await readFile(target, "utf8"), "helloworld");
    assert.equal(await readStaged(root, staged.id), null);
  });
});

test("a repeated piece is told where to carry on from", async () => {
  await withRoot(async (root) => {
    const staged = await beginUpload(root, fields(10));
    await appendChunk(root, staged, 0, Readable.from([Buffer.from("hello")]));
    await assert.rejects(
      appendChunk(root, staged, 0, Readable.from([Buffer.from("hello")])),
      (e: unknown) => e instanceof UploadError && e.status === 409 && e.received === 5
    );
  });
});

test("an oversized piece is refused and cut back out", async () => {
  await withRoot(async (root) => {
    const staged = await beginUpload(root, fields(100));
    await assert.rejects(
      appendChunk(root, staged, 0, Readable.from([Buffer.alloc(4), Buffer.alloc(4)]), 6),
      (e: unknown) => e instanceof UploadError && e.status === 413
    );
    assert.equal(await receivedBytes(root, staged.id), 0);
  });
});

test("bytes past the declared size are refused", async () => {
  await withRoot(async (root) => {
    const staged = await beginUpload(root, fields(3));
    await assert.rejects(
      appendChunk(root, staged, 0, Readable.from([Buffer.from("toolong")])),
      (e: unknown) => e instanceof UploadError && e.status === 400
    );
    assert.equal(await receivedBytes(root, staged.id), 0);
  });
});

test("an id that isn't an upload id is never read", async () => {
  await withRoot(async (root) => {
    assert.equal(await readStaged(root, "../../etc"), null);
    assert.equal(await readStaged(root, "not-a-real-id"), null);
  });
});

test("only abandoned uploads are swept", async () => {
  await withRoot(async (root) => {
    const old = await beginUpload(root, fields(5));
    const fresh = await beginUpload(root, fields(5));
    const longAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(join(root, old.id, "data"), longAgo, longAgo);
    assert.equal(await sweepStale(root, 24 * 60 * 60 * 1000), 1);
    assert.equal(await readStaged(root, old.id), null);
    assert.ok(await readStaged(root, fresh.id));
  });
});
