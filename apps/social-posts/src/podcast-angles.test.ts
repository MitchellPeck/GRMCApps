import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ANGLES, anglesBlock, jsonKeysHint, selectAngles } from "./podcast-angles";

test("selectAngles keeps the canonical order and ignores keys that aren't angles", () => {
  const picked = selectAngles(["quote", "announcement", "nonsense"]);
  assert.deepEqual(picked.map((a) => a.key), ["announcement", "quote"]);
});

test("selectAngles returns nothing when nothing was picked", () => {
  assert.deepEqual(selectAngles([]), []);
});

test("anglesBlock numbers each picked angle and carries its instruction", () => {
  const block = anglesBlock(selectAngles(["announcement", "quote"]));
  assert.ok(block.includes("1. ANNOUNCEMENT"), "first pick is numbered 1");
  assert.ok(block.includes("2. QUOTE"), "second pick is numbered 2");
  assert.ok(block.indexOf("1. ANNOUNCEMENT") < block.indexOf("2. QUOTE"), "numbered in canonical order");
  const quote = ANGLES.find((a) => a.key === "quote");
  assert.ok(quote && block.includes(quote.instruction), "the angle's instruction reaches the prompt");
});

test("jsonKeysHint names exactly the keys Claude must return", () => {
  assert.equal(jsonKeysHint(selectAngles(["announcement", "quote"])), '"announcement", "quote"');
  assert.equal(jsonKeysHint(selectAngles(["invite"])), '"invite"');
});

test("every angle is usable as a post key and carries a real instruction", () => {
  assert.ok(ANGLES.length >= 4, "the menu is worth having");
  for (const a of ANGLES) {
    assert.ok(/^[a-z]+$/.test(a.key), a.key + " must be a plain key — it becomes a draft key and a JSON field");
    assert.ok(a.label.length > 0, a.key + " needs a label for the checkbox");
    assert.ok(a.instruction.length > 40, a.key + " needs an instruction with actual direction in it");
  }
  assert.equal(new Set(ANGLES.map((a) => a.key)).size, ANGLES.length, "keys are unique");
});
