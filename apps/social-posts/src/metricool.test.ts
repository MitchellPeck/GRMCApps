import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSchedulerPayload, suggestDateTime, charWarnings } from "./metricool";

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

test("suggestDateTime maps a weekday key to the next such day at the default time", () => {
  const iso = suggestDateTime({ kind: "weekday", weekday: "monday" }, { refDate: "2026-06-10", time: "09:00" });
  assert.equal(iso, "2026-06-15T09:00:00");
  const iso2 = suggestDateTime({ kind: "seriesDate", label: "Jun 16" }, { refDate: "2026-06-10", time: "09:00" });
  assert.equal(iso2, "2026-06-16T09:00:00");
});

test("charWarnings flags Instagram over 2200", () => {
  const w = charWarnings("a".repeat(2300), ["instagram"]);
  assert.ok(w.some((m) => m.toLowerCase().includes("instagram")));
  assert.equal(charWarnings("short", ["instagram", "facebook"]).length, 0);
});
