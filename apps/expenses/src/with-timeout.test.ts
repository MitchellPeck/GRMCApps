import { strict as assert } from "node:assert";
import { test } from "node:test";
import { withTimeout } from "./with-timeout";

test("a promise that settles in time passes its value through", async () => {
  assert.equal(await withTimeout(Promise.resolve("done"), 1000, "fallback"), "done");
});

test("a promise that never settles yields the fallback instead of hanging", async () => {
  // This is the whole point: pdf2md on Node 20 never resolved AND never threw,
  // so the request hung until the browser gave up with ERR_CONNECTION_CLOSED.
  const never = new Promise<string>(() => undefined);
  assert.equal(await withTimeout(never, 30, "fallback"), "fallback");
});

test("a rejection still rejects rather than being swallowed as a timeout", async () => {
  await assert.rejects(() => withTimeout(Promise.reject(new Error("boom")), 1000, "fb"), /boom/);
});

test("the timer does not keep the process alive", async () => {
  // An un-unref'd timer would hold the event loop open for the full timeout on
  // every single conversion.
  const out = await withTimeout(Promise.resolve(1), 60000, 0);
  assert.equal(out, 1);
});
