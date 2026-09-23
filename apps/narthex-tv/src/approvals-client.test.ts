import { test } from "node:test";
import assert from "node:assert/strict";
import { fileNameForApproval } from "./approvals-client";

test("the extension follows what Approvals actually sent, not the title", () => {
  assert.equal(fileNameForApproval("Advent series", "image/png"), "Advent-series.png");
  assert.equal(fileNameForApproval("Advent series", "image/jpeg"), "Advent-series.jpg");
  assert.equal(fileNameForApproval("Advent series", "image/webp"), "Advent-series.webp");
  // Anything unrecognised is treated as a JPEG, which the converter will
  // normalise anyway if it turns out not to be one.
  assert.equal(fileNameForApproval("Advent series", "application/octet-stream"), "Advent-series.jpg");
});

test("a title cannot escape its directory or surprise a shell", () => {
  assert.equal(fileNameForApproval("../../etc/passwd", "image/png"), "etc-passwd.png");
  assert.ok(!fileNameForApproval("a/b`c$(d)", "image/png").includes("/"));
  assert.equal(fileNameForApproval("", "image/png"), "approved.png");
  assert.equal(fileNameForApproval("...", "image/png"), "approved.png");
});

test("a very long title is trimmed rather than making an unusable filename", () => {
  const name = fileNameForApproval("A".repeat(300), "image/png");
  assert.ok(name.length <= 64, name.length + " chars");
  assert.ok(name.endsWith(".png"));
});
