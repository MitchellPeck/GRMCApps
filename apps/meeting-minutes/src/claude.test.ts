import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseItems, stripJsonFences, isSupportedAgendaType, parseSummary, parseSpeakerMap } from "./claude";

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

test("parseSummary reads summary + action items and defaults owner", () => {
  const raw = JSON.stringify({
    summary: "Discussed the Q2 budget shortfall.",
    actionItems: [
      { task: "Pull the Q2 numbers", owner: "Bob" },
      { task: "Follow up with the printer", owner: "" },
      { task: "  ", owner: "X" },
    ],
  });
  const r = parseSummary(raw);
  assert.equal(r.summary, "Discussed the Q2 budget shortfall.");
  assert.equal(r.actionItems.length, 2); // blank task dropped
  assert.equal(r.actionItems[0].owner, "Bob");
  assert.equal(r.actionItems[1].owner, "Unassigned"); // blank owner defaulted
});

test("parseSummary tolerates fenced JSON and missing actionItems", () => {
  const r = parseSummary('```json\n{"summary":"ok"}\n```');
  assert.equal(r.summary, "ok");
  assert.deepEqual(r.actionItems, []);
});

test("parseSummary falls back to raw text when not JSON", () => {
  const r = parseSummary("plain summary text");
  assert.equal(r.summary, "plain summary text");
  assert.deepEqual(r.actionItems, []);
});

test("parseItems reads the presenter field", () => {
  const raw = '[{"title":"Budget","description":"Q2 numbers","presenter":"Jane Doe"}]';
  assert.deepEqual(parseItems(raw), [{ title: "Budget", description: "Q2 numbers", presenter: "Jane Doe" }]);
});

test("parseItems defaults a missing or blank presenter to an empty string", () => {
  const raw = '[{"title":"Budget","description":""},{"title":"Missions","description":"","presenter":"   "}]';
  assert.deepEqual(parseItems(raw), [
    { title: "Budget", description: "", presenter: "" },
    { title: "Missions", description: "", presenter: "" },
  ]);
});

test("parseItems trims a padded presenter name", () => {
  assert.equal(parseItems('[{"title":"T","description":"","presenter":"  Jane Doe  "}]')[0].presenter, "Jane Doe");
});

const ORDER = ["SPEAKER_00", "SPEAKER_01", "SPEAKER_02"];
const NAMES = ["Alice Smith", "Bob Jones"];

test("parseSpeakerMap translates positional labels back to raw labels", () => {
  const raw = '{"Speaker 1":"Alice Smith","Speaker 2":"Bob Jones","Speaker 3":""}';
  assert.deepEqual(parseSpeakerMap(raw, ORDER, NAMES), {
    SPEAKER_00: "Alice Smith",
    SPEAKER_01: "Bob Jones",
  });
});

test("parseSpeakerMap merges several labels onto one person", () => {
  const raw = '{"Speaker 1":"Alice Smith","Speaker 3":"Alice Smith"}';
  assert.deepEqual(parseSpeakerMap(raw, ORDER, NAMES), {
    SPEAKER_00: "Alice Smith",
    SPEAKER_02: "Alice Smith",
  });
});

test("parseSpeakerMap normalizes casing to the canonical attendee name", () => {
  assert.deepEqual(parseSpeakerMap('{"Speaker 1":"alice smith"}', ORDER, NAMES), { SPEAKER_00: "Alice Smith" });
});

test("parseSpeakerMap drops invented names and out-of-range labels", () => {
  const raw = '{"Speaker 1":"Carlos Vega","Speaker 9":"Alice Smith","nonsense":"Bob Jones"}';
  assert.deepEqual(parseSpeakerMap(raw, ORDER, NAMES), {});
});

test("parseSpeakerMap tolerates fenced JSON and malformed output", () => {
  const fenced = '```json\n{"Speaker 2":"Bob Jones"}\n```';
  assert.deepEqual(parseSpeakerMap(fenced, ORDER, NAMES), { SPEAKER_01: "Bob Jones" });
  assert.deepEqual(parseSpeakerMap("I could not tell.", ORDER, NAMES), {});
  assert.deepEqual(parseSpeakerMap('["Speaker 1"]', ORDER, NAMES), {});
  assert.deepEqual(parseSpeakerMap("", ORDER, NAMES), {});
});

test("parseSpeakerMap tolerates a name echoed with its title", () => {
  assert.deepEqual(parseSpeakerMap('{"Speaker 1":"Alice Smith (Chair)"}', ORDER, NAMES), { SPEAKER_00: "Alice Smith" });
});
