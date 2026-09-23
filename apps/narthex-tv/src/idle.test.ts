import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_IDLE, idleIsBlank, idleSlideName, IdleSettings } from "./idle";

const idle = (over: Partial<IdleSettings> = {}): IdleSettings => ({ ...DEFAULT_IDLE, ...over });

test("the slide name changes when anything that changes the picture changes", () => {
  const base = idle({ headline: "Grace Resurrection", message: "Welcome", theme: "navy" });
  const name = idleSlideName(base, "");
  assert.notEqual(idleSlideName(idle({ ...base, headline: "Grace" }), ""), name);
  assert.notEqual(idleSlideName(idle({ ...base, message: "Hello" }), ""), name);
  assert.notEqual(idleSlideName(idle({ ...base, theme: "paper" }), ""), name);
  assert.notEqual(idleSlideName(idle({ ...base, logoMediaId: 4 }), ""), name);
  // ...but the seal does NOT: it is the player's offline fallback, not part
  // of the rendered picture, so it must not invalidate a cached slide.
  assert.equal(idleSlideName(idle({ ...base, showMark: false }), ""), name);
  // Replacing the logo image itself must also produce a new name, or screens
  // would keep serving the old one out of cache.
  assert.notEqual(idleSlideName(base, "2026-09-23T10:00:00Z"), name);
});

test("the same configuration always gives the same name", () => {
  const a = idle({ headline: "Grace", message: "Welcome", logoMediaId: 2 });
  assert.equal(idleSlideName(a, "s"), idleSlideName(idle({ ...a }), "s"));
});

test("the name is a plain filename that cannot point elsewhere", () => {
  const name = idleSlideName(idle({ headline: "../../etc/passwd" }), "");
  assert.ok(/^[0-9a-f]{16}\.jpg$/.test(name), name);
});

test("nothing configured is blank, and is not rendered at all", () => {
  assert.equal(idleIsBlank(idle()), true);
  // The seal alone is not content: rendering it would put a lone serif letter
  // on the wall instead of the gold mark the player draws.
  assert.equal(idleIsBlank(idle({ showMark: true })), true);
  assert.equal(idleIsBlank(idle({ headline: "Grace" })), false);
  assert.equal(idleIsBlank(idle({ message: "Welcome" })), false);
  assert.equal(idleIsBlank(idle({ logoMediaId: 3 })), false);
  // Whitespace is not content.
  assert.equal(idleIsBlank(idle({ headline: "   " })), true);
});
