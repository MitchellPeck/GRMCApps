import { strict as assert } from "node:assert";
import { test } from "node:test";
import { objectKey, publicUrlFor } from "./r2";

test("objectKey keeps the extension and varies by seed", () => {
  const k = objectKey("image/jpeg", "seed-1");
  assert.ok(k.endsWith(".jpg"));
  assert.notEqual(k, objectKey("image/png", "seed-2"));
});
test("publicUrlFor joins base + key without double slashes", () => {
  assert.equal(publicUrlFor("https://media.grmc.app/", "metricool/x.jpg"), "https://media.grmc.app/metricool/x.jpg");
  assert.equal(publicUrlFor("https://media.grmc.app", "metricool/x.jpg"), "https://media.grmc.app/metricool/x.jpg");
});
