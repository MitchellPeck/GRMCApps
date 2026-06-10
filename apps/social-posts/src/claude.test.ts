import { strict as assert } from "node:assert";
import { test } from "node:test";
import { stripJsonFences } from "./claude";

test("stripJsonFences removes markdown code fences", () => {
  assert.equal(stripJsonFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFences('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFences('  {"a":1}  '), '{"a":1}');
});
