import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSchedulerPayload, charWarnings } from "./metricool";
import { decodeImageDataUrl } from "./r2";

test("buildSchedulerPayload shapes the Metricool body", () => {
  const p = buildSchedulerPayload({
    text: "Hello", networks: ["facebook", "instagram"],
    dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrl: "",
  });
  assert.equal(p.autoPublish, false);
  assert.deepEqual(p.publicationDate, { dateTime: "2026-06-15T09:00:00", timezone: "America/New_York" });
  assert.deepEqual(p.providers, [{ network: "facebook" }, { network: "instagram" }]);
  assert.equal(p.text, "Hello");
  assert.equal(p.facebookData?.type, "POST");
  assert.equal("media" in p, false);
});

test("buildSchedulerPayload includes media when given a url", () => {
  const p = buildSchedulerPayload({ text: "x", networks: ["instagram"], dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrl: "https://pub/x.jpg" });
  assert.deepEqual(p.media, ["https://pub/x.jpg"]);
});

test("buildSchedulerPayload carries X through as Metricool's twitter provider", () => {
  const p = buildSchedulerPayload({ text: "x", networks: ["facebook", "instagram", "twitter"], dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrl: "" });
  assert.deepEqual(p.providers, [{ network: "facebook" }, { network: "instagram" }, { network: "twitter" }]);
});

test("charWarnings flags Instagram over 2200 and labels X by its real name", () => {
  const w = charWarnings("a".repeat(2300), ["instagram"]);
  assert.ok(w.some((m) => m.toLowerCase().includes("instagram")));
  assert.equal(charWarnings("short", ["instagram", "facebook"]).length, 0);
  const x = charWarnings("a".repeat(300), ["twitter"]);
  assert.equal(x.length, 1);
  assert.ok(x[0].startsWith("X limit is 280"), x[0]);
});

test("decodeImageDataUrl accepts image data urls and rejects anything else", () => {
  const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  const out = decodeImageDataUrl(gif);
  assert.equal(out.contentType, "image/gif");
  assert.ok(out.bytes.length > 0);
  assert.throws(() => decodeImageDataUrl("data:application/pdf;base64,AAAA"), /must be an image/);
  assert.throws(() => decodeImageDataUrl("https://example.com/x.jpg"), /must be an image/);
  assert.throws(() => decodeImageDataUrl(""), /must be an image/);
});
