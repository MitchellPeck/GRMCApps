import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSchedulerPayload, charWarnings, parseNormalizedUrl } from "./metricool";
import { decodeImageDataUrl } from "./r2";

test("buildSchedulerPayload shapes the Metricool body", () => {
  const p = buildSchedulerPayload({
    text: "Hello", networks: ["facebook", "instagram"],
    dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrls: [], publish: "scheduled",
  });
  assert.deepEqual(p.publicationDate, { dateTime: "2026-06-15T09:00:00", timezone: "America/New_York" });
  assert.deepEqual(p.providers, [{ network: "facebook" }, { network: "instagram" }]);
  assert.equal(p.text, "Hello");
  assert.equal(p.facebookData?.type, "POST");
  assert.equal("media" in p, false);
});

// Metricool only publishes a post when autoPublish is true; autoPublish:false is
// its draft state, and the two flags have to agree or the post lands in the
// planner and never goes anywhere. The sender picks which, for every network.
test("buildSchedulerPayload schedules a post to publish itself when asked", () => {
  const p = buildSchedulerPayload({ text: "x", networks: ["facebook", "twitter"], dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrls: [], publish: "scheduled" });
  assert.equal(p.autoPublish, true);
  assert.equal(p.draft, false);
});

test("buildSchedulerPayload makes a draft when asked, even with Instagram", () => {
  const p = buildSchedulerPayload({ text: "x", networks: ["facebook", "instagram"], dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrls: [], publish: "draft" });
  assert.equal(p.autoPublish, false);
  assert.equal(p.draft, true);
});

test("buildSchedulerPayload includes media when given a url", () => {
  const p = buildSchedulerPayload({ text: "x", networks: ["instagram"], dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrls: ["https://pub/x.jpg"], publish: "scheduled" });
  assert.deepEqual(p.media, ["https://pub/x.jpg"]);
});

test("buildSchedulerPayload carries X through as Metricool's twitter provider", () => {
  const p = buildSchedulerPayload({ text: "x", networks: ["facebook", "instagram", "twitter"], dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrls: [], publish: "scheduled" });
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

test("buildSchedulerPayload sends every image, in order, for a carousel", () => {
  const p = buildSchedulerPayload({ text: "x", networks: ["instagram"], dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrls: ["https://a/1.jpg", "https://a/2.jpg"], publish: "scheduled" });
  assert.deepEqual(p.media, ["https://a/1.jpg", "https://a/2.jpg"]);
});

test("a Metricool post is published only when every network says so", async () => {
  const { publicationState } = await import("./metricool");
  const prov = (status: string, extra: Record<string, string> = {}) => ({ network: "facebook", status, detailedStatus: "", ...extra });
  assert.deepEqual(publicationState({ providers: [prov("PUBLISHED"), prov("PUBLISHED")] }), { state: "published", detail: "" });
  assert.equal(publicationState({ providers: [prov("PUBLISHED"), prov("PENDING")] }).state, "pending");
  assert.equal(publicationState({ providers: [prov("SOMETHING_NEW", { publicUrl: "https://fb.com/p/1" })] }).state, "published", "a public link means it's out");
  const failed = publicationState({ providers: [prov("ERROR", { network: "instagram", detailedStatus: "Media missing" })] });
  assert.deepEqual(failed, { state: "failed", detail: "instagram: Media missing" });
  assert.equal(publicationState({ providers: [] }).state, "unknown", "nothing to go on, change nothing");
  assert.equal(publicationState({ providers: [prov("WEIRD")] }).state, "unknown");
});

test("schedulePost finds the new post's id in every reply shape we've seen or suspect", async () => {
  const { schedulePost } = await import("./metricool");
  const creds = { token: "t", userId: "u", blogId: "b" };
  const payload = buildSchedulerPayload({ text: "Hi", networks: ["facebook"], dateTime: "2026-11-01T09:00:00",
    timezone: "America/New_York", mediaUrls: [], publish: "scheduled" });
  const real = globalThis.fetch;
  const idFrom = async (reply: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(reply), { status: 200 })) as typeof fetch;
    try { return await schedulePost(creds, payload); } finally { globalThis.fetch = real; }
  };
  assert.equal(await idFrom({ id: 1 }), "1");
  assert.equal(await idFrom({ postId: 2 }), "2");
  assert.equal(await idFrom({ data: { id: 3 } }), "3");
  assert.equal(await idFrom({ data: { postId: 4 } }), "4");
  assert.equal(await idFrom({ data: [{ id: 5 }] }), "5");
  assert.equal(await idFrom({ data: [] }), "", "no id is an empty id, not a crash");
  assert.equal(await idFrom({}), "");
});
