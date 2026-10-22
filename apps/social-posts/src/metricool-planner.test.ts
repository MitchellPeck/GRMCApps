import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapState, parsePlanner, textHash } from "./metricool-planner";

// tsc doesn't copy JSON, so tests read the fixtures from src/.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, "..", "src", "fixtures", name), "utf8"));
}
const TZ = "America/New_York";

test("parsePlanner reads the before payload", () => {
  const posts = parsePlanner(fixture("metricool-planner-before.provisional.json"), TZ);
  assert.equal(posts.length, 1);
  const p = posts[0];
  assert.deepEqual(p.networks.map((n) => n.network), ["facebook", "instagram"]);
  assert.ok(p.networks.every((n) => n.state === "scheduled"));
  assert.equal(p.networks[0].scheduledFor, p.networks[1].scheduledFor);
  assert.equal(p.networks[0].scheduledFor, "2026-11-03T09:00");
  assert.ok(p.networks.every((n) => n.text.length > 0));
});

test("parsePlanner reads the after-move payload", () => {
  const posts = parsePlanner(fixture("metricool-planner-after-move.provisional.json"), TZ);
  const all = posts.flatMap((p) => p.networks);
  const fb = all.find((n) => n.network === "facebook")!;
  const ig = all.find((n) => n.network === "instagram")!;
  assert.notEqual(fb.scheduledFor, ig.scheduledFor);
});

test("parsePlanner accepts a bare array and rejects other shapes", () => {
  assert.deepEqual(parsePlanner([], TZ), []);
  assert.throws(() => parsePlanner({ nope: 1 }, TZ), /wasn't readable/);
  assert.throws(() => parsePlanner("text", TZ), /wasn't readable/);
});

test("mapState covers every status", () => {
  assert.equal(mapState("PUBLISHED", "", true), "published");
  assert.equal(mapState("PENDING", "https://x", true), "published");
  assert.equal(mapState("ERROR", "", true), "failed");
  assert.equal(mapState("PENDING", "", false), "draft");
  assert.equal(mapState("SCHEDULED", "", true), "scheduled");
  assert.equal(mapState("WHO KNOWS", "", true), "unknown");
});

test("planner times are normalised to the church's zone across DST", () => {
  const row = (dateTime: string) => ({ id: 1, publicationDate: { dateTime }, text: "t", autoPublish: true, providers: [{ network: "facebook", status: "PENDING" }] });
  const after = parsePlanner({ data: [row("2026-11-01T13:00:00Z")] }, TZ);
  assert.equal(after[0].networks[0].scheduledFor, "2026-11-01T08:00");
  const before = parsePlanner({ data: [row("2026-10-31T13:00:00Z")] }, TZ);
  assert.equal(before[0].networks[0].scheduledFor, "2026-10-31T09:00");
});

test("a wall time in another zone converts to the church's zone", () => {
  const body = { data: [{ id: 1, publicationDate: { dateTime: "2026-11-03T06:00:00", timezone: "America/Los_Angeles" }, text: "t", autoPublish: true, providers: [{ network: "facebook", status: "PENDING" }] }] };
  assert.equal(parsePlanner(body, TZ)[0].networks[0].scheduledFor, "2026-11-03T09:00");
});

test("twitter becomes x, other networks are dropped, provider text wins", () => {
  const body = { data: [{ id: "7", publicationDate: { dateTime: "2026-11-03T09:00:00", timezone: TZ }, text: "post", autoPublish: true, media: ["https://m/1.jpg"],
    providers: [{ network: "twitter", status: "PENDING", text: "short" }, { network: "google", status: "PENDING" }] }] };
  const [p] = parsePlanner(body, TZ);
  assert.deepEqual(p.networks.map((n) => [n.network, n.text]), [["x", "short"]]);
  assert.deepEqual(p.media, ["https://m/1.jpg"]);
  assert.equal(p.id, "7");
});

test("textHash ignores line-ending and edge whitespace differences", () => {
  assert.equal(textHash("a\r\nb "), textHash("a\nb"));
  assert.match(textHash("a"), /^[0-9a-f]{40}$/);
});
