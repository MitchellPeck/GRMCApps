import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSchedulerPayload, charWarnings, parseNormalizedUrl } from "./metricool";
import { decodeImageDataUrl } from "./r2";

test("buildSchedulerPayload shapes the Metricool body", () => {
  const p = buildSchedulerPayload({
    text: "Hello", networks: ["facebook", "instagram"],
    dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrl: "",
  });
  assert.deepEqual(p.publicationDate, { dateTime: "2026-06-15T09:00:00", timezone: "America/New_York" });
  assert.deepEqual(p.providers, [{ network: "facebook" }, { network: "instagram" }]);
  assert.equal(p.text, "Hello");
  assert.equal(p.facebookData?.type, "POST");
  assert.equal("media" in p, false);
});

// Metricool only publishes a post when autoPublish is true; autoPublish:false is
// its "draft awaiting approval" state, and the two flags have to agree or the
// post lands in the planner and never goes anywhere. Instagram has to publish
// itself, so selecting it turns publishing on for the whole post.
test("buildSchedulerPayload auto-publishes when Instagram is selected", () => {
  const ig = buildSchedulerPayload({ text: "x", networks: ["facebook", "instagram"], dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrl: "" });
  assert.equal(ig.autoPublish, true);
  assert.equal(ig.draft, false);
});

test("buildSchedulerPayload leaves non-Instagram sends as approvable drafts", () => {
  const fb = buildSchedulerPayload({ text: "x", networks: ["facebook", "twitter"], dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrl: "" });
  assert.equal(fb.autoPublish, false);
  assert.equal(fb.draft, true);
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

// The normalize endpoint hands back the Metricool-hosted URL in a few shapes.
// Falling back to the URL we sent in is worse than failing: Metricool silently
// skips media it doesn't host, so the post would go out with no image at all.
test("parseNormalizedUrl reads every shape the normalize endpoint returns", () => {
  const u = "https://cdn.metricool.com/x.jpg";
  assert.equal(parseNormalizedUrl(`"${u}"`), u);
  assert.equal(parseNormalizedUrl(u), u);
  assert.equal(parseNormalizedUrl(`  ${u}\n`), u);
  assert.equal(parseNormalizedUrl(JSON.stringify({ url: u })), u);
  assert.equal(parseNormalizedUrl(JSON.stringify({ data: u })), u);
  assert.equal(parseNormalizedUrl(JSON.stringify({ media: u })), u);
  assert.equal(parseNormalizedUrl(JSON.stringify([u])), u);
});

test("parseNormalizedUrl refuses anything that isn't a url", () => {
  assert.throws(() => parseNormalizedUrl(""), /did not return a media url/);
  assert.throws(() => parseNormalizedUrl("null"), /did not return a media url/);
  assert.throws(() => parseNormalizedUrl(JSON.stringify({ error: "nope" })), /did not return a media url/);
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
