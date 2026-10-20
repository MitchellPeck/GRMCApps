import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_UPLOAD_BYTES, uploadProblem } from "./pipeline/uploads";
import { objectKey } from "./r2";

test("uploads take photos and videos up to the size limit", () => {
  assert.equal(uploadProblem("image/jpeg", 2_000_000), "");
  assert.equal(uploadProblem("video/mp4", 80_000_000), "");
  assert.equal(uploadProblem("video/quicktime", 1), "");
  assert.match(uploadProblem("application/pdf", 1000), /photo \(JPG, PNG, GIF or WebP\) or a video \(MP4 or MOV\)/);
  assert.match(uploadProblem("image/jpeg", MAX_UPLOAD_BYTES + 1), /larger than 100 MB/);
  assert.match(uploadProblem("image/png", 0), /empty/);
});

test("uploaded media is stored under media/ with the right extension", () => {
  assert.match(objectKey("video/mp4", "abc", "media"), /^media\/abc-\d+\.mp4$/);
  assert.match(objectKey("video/quicktime", "abc", "media"), /^media\/abc-\d+\.mov$/);
  assert.match(objectKey("image/png", "abc"), /^metricool\/abc-\d+\.png$/, "Metricool images keep their old place");
});
