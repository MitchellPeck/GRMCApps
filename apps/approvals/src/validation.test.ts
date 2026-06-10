import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateUpload, MAX_BYTES } from "./validation";

test("accepts allowed image types within size", () => {
  assert.deepEqual(validateUpload("image/png", 1024), { ok: true });
  assert.deepEqual(validateUpload("image/jpeg", 1024), { ok: true });
  assert.deepEqual(validateUpload("application/pdf", 1024), { ok: true });
});

test("rejects disallowed types", () => {
  const r = validateUpload("text/html", 10);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /type/i);
});

test("rejects oversize files", () => {
  const r = validateUpload("image/png", MAX_BYTES + 1);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /large|size|10/i);
});

test("rejects empty files", () => {
  const r = validateUpload("image/png", 0);
  assert.equal(r.ok, false);
});
