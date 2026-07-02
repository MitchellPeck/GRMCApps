import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseItems, stripJsonFences, isSupportedAgendaType } from "./claude";

test("stripJsonFences removes code fences", () => {
  assert.equal(stripJsonFences('```json\n[]\n```'), "[]");
  assert.equal(stripJsonFences("```\n[1]\n```"), "[1]");
  assert.equal(stripJsonFences("[2]"), "[2]");
});

test("parseItems parses a well-formed array", () => {
  const items = parseItems('[{"title":"Budget","description":"Q2 review"},{"title":"Missions"}]');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Budget");
  assert.equal(items[0].description, "Q2 review");
  assert.equal(items[1].description, ""); // missing description → ""
});

test("parseItems tolerates fenced JSON and drops titleless entries", () => {
  const items = parseItems('```json\n[{"title":" Welcome "},{"description":"no title"}]\n```');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Welcome"); // trimmed
});

test("parseItems returns [] on garbage or non-array", () => {
  assert.deepEqual(parseItems("not json"), []);
  assert.deepEqual(parseItems('{"title":"x"}'), []);
});

test("isSupportedAgendaType covers pdf, text, images only", () => {
  assert.ok(isSupportedAgendaType("application/pdf"));
  assert.ok(isSupportedAgendaType("text/plain"));
  assert.ok(isSupportedAgendaType("image/png"));
  assert.ok(!isSupportedAgendaType("application/msword"));
  assert.ok(!isSupportedAgendaType("audio/webm"));
});
