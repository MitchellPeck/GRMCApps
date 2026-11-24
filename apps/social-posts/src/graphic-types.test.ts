import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GRAPHIC_TYPES, graphicType } from "./pipeline/graphic-types";

const size = (key: string) => { const g = graphicType(key); return g && [g.width, g.height]; };

test("registry keys are unique kebab-case", () => {
  const keys = GRAPHIC_TYPES.map((g) => g.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) assert.match(k, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test("lower-third is 1920x280", () => assert.deepEqual(size("lower-third"), [1920, 280]));
test("ig-feed is 1080x1350", () => assert.deepEqual(size("ig-feed"), [1080, 1350]));
test("ig-story is 1080x1920", () => assert.deepEqual(size("ig-story"), [1080, 1920]));
test("announcement-slide is 1920x1080", () => assert.deepEqual(size("announcement-slide"), [1920, 1080]));
test("graphicType(\"nope\") is undefined", () => assert.equal(graphicType("nope"), undefined));
