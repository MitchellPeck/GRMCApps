import { test } from "node:test";
import assert from "node:assert/strict";
import { desiredPower } from "./power";

test("the TV is on exactly when something is set to play", () => {
  assert.equal(desiredPower(false, false, false), "off");
  assert.equal(desiredPower(true, false, false), "on");
  assert.equal(desiredPower(false, true, false), "on");   // Play now with nothing scheduled
  assert.equal(desiredPower(false, false, true), "on");   // takeover
  assert.equal(desiredPower(false, true, true), "on");    // takeover cleared later -> still Play now
});
