import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_TAKEOVER, parseTakeover, takeoverImageName, Takeover } from "./takeover";

const stored = (t: Partial<Takeover>) => JSON.stringify({ active: true, ...t });

test("an empty setting is no takeover", () => {
  assert.deepEqual(parseTakeover(""), NO_TAKEOVER);
});

test("a stored takeover round-trips", () => {
  const t = parseTakeover(stored({
    headline: "Service moved", body: "We are meeting in the chapel today.",
    urgent: false, startedAt: "2026-09-23T14:00:00.000Z", startedBy: "Mitchell",
  }));
  assert.equal(t.active, true);
  assert.equal(t.headline, "Service moved");
  assert.equal(t.urgent, false);
  assert.equal(t.startedBy, "Mitchell");
});

test("urgent defaults on — an emergency message is red unless said otherwise", () => {
  assert.equal(parseTakeover(stored({ headline: "Evacuate" })).urgent, true);
  assert.equal(parseTakeover(stored({ headline: "Evacuate", urgent: false })).urgent, false);
});

test("active:false is not a takeover however much else is filled in", () => {
  const raw = JSON.stringify({ active: false, headline: "Old news", body: "x" });
  assert.deepEqual(parseTakeover(raw), NO_TAKEOVER);
});

test("a takeover with nothing to say is not a takeover", () => {
  assert.deepEqual(parseTakeover(stored({ headline: "", body: "   " })), NO_TAKEOVER);
});

test("a malformed row cannot pin a message on the screen, and does not throw", () => {
  assert.deepEqual(parseTakeover("{not json"), NO_TAKEOVER);
  assert.deepEqual(parseTakeover("null"), NO_TAKEOVER);
  assert.deepEqual(parseTakeover("[]"), NO_TAKEOVER);
});

test("text is capped so nothing can be made unreadable from across a narthex", () => {
  const t = parseTakeover(stored({ headline: "H".repeat(500), body: "B".repeat(2000) }));
  assert.equal(t.headline.length, 120);
  assert.equal(t.body.length, 400);
});

test("the image name is versioned by when the message went up", () => {
  // Otherwise a second emergency would be served from a client's cache of the
  // first one — on a screen nobody is standing at to notice.
  const a = takeoverImageName("2026-09-23T14:00:00.000Z");
  const b = takeoverImageName("2026-09-23T14:05:00.000Z");
  assert.notEqual(a, b);
  assert.ok(a.endsWith(".jpg"));
  assert.ok(!a.includes("/"), "must not be able to point outside its directory");
});

test("a takeover stored without a rendered image is still a takeover", () => {
  // The render can fail — no fonts, a full disk — and the message must still
  // go up: the browser player draws the text itself.
  const t = parseTakeover(stored({ headline: "Evacuate" }));
  assert.equal(t.active, true);
  assert.equal(t.imagePath, "");
});
