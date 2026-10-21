import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseItems, stripJsonFences, isSupportedAgendaType, parseSummary, parseSpeakerMap, reportSystemPrompt, SUMMARIZE_SYSTEM } from "./claude";

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

// The real failure: a long topic's reply was cut off mid-array, the JSON did
// not parse, and the raw half-object was saved as the summary.
test("parseSummary salvages a cut-off reply instead of saving raw JSON", () => {
  const raw = '```json\n{\n  "summary": "The board discussed \\"three\\" topics.",\n  "actionItems": [\n'
    + '    { "task": "Finance committee to report back", "owner": "Unassigned" },\n'
    + '    { "task": "Look into shed storage", "owner": "Eddie Huffaker" },\n'
    + '    { "task": "Return financial documents to David",\n      "owner": "Unass';
  const r = parseSummary(raw);
  assert.equal(r.summary, 'The board discussed "three" topics.');
  assert.deepEqual(r.actionItems, [
    { task: "Finance committee to report back", owner: "Unassigned" },
    { task: "Look into shed storage", owner: "Eddie Huffaker" },
  ]);
});

test("parseSummary refuses unreadable JSON rather than storing it as the summary", () => {
  assert.throws(() => parseSummary('{ "summ'), /could not be read/);
});

test("reportSystemPrompt gives each presented schedule its own sub-heading", () => {
  const base = reportSystemPrompt("", "");
  assert.match(base, /its own\s+"#### <name>" sub-heading/);
  assert.doesNotMatch(base, /<instructions>|<example_report>/);
});

test("reportSystemPrompt adds standing instructions and the example only when set", () => {
  const withBoth = reportSystemPrompt("  One section per schedule.  ", "## Agenda\n### 1. Treasurer");
  assert.match(withBoth, /<instructions>\nOne section per schedule\.\n<\/instructions>/);
  assert.match(withBoth, /<example_report>\n## Agenda\n### 1\. Treasurer\n<\/example_report>/);
  assert.match(withBoth, /never copy its names, figures or facts/);
  const onlyExample = reportSystemPrompt(" ", "x");
  assert.doesNotMatch(onlyExample, /<instructions>/);
  assert.match(onlyExample, /<example_report>/);
});

test("parseSummary reads an action item's time range", () => {
  const r = parseSummary(JSON.stringify({ summary: "s", actionItems: [
    { task: "Send figures", owner: "Bob", at: "12:40-13:05" },
    { task: "Book hall", owner: "Ann", at: "soon" },
    { task: "Call roofer", owner: "Tom", at: "13:05-12:40" },
  ] }));
  assert.deepEqual(r.actionItems, [
    { task: "Send figures", owner: "Bob", start: 760, end: 785 },
    { task: "Book hall", owner: "Ann" },
    { task: "Call roofer", owner: "Tom" },
  ]);
});

test("a salvaged summary keeps action item times", () => {
  const raw = '{"summary": "s", "actionItems": [{"task": "Send figures", "owner": "Bob", "at": "0:10-0:20"}, {"task": "cut';
  assert.deepEqual(parseSummary(raw).actionItems, [{ task: "Send figures", owner: "Bob", start: 10, end: 20 }]);
});

test("the summary prompt asks only for real commitments", () => {
  assert.match(SUMMARIZE_SYSTEM, /agreed to do|was asked to/);
  assert.doesNotMatch(SUMMARIZE_SYSTEM, /extract every action item/i);
});

test("the report prompt sets a length budget and asks for cited times", () => {
  const p = reportSystemPrompt("", "");
  assert.match(p, /5[–-]7 pages/);
  assert.match(p, /\[start-end\]/);
  assert.doesNotMatch(p, /comprehensive/i);
  assert.doesNotMatch(p, /Keep every concrete/);
});

test("the prompts keep real clock times and copy stamps exactly, past the hour too", () => {
  const p = reportSystemPrompt("", "");
  assert.doesNotMatch(p, /Never write a time anywhere/);
  assert.match(p, /recording timestamp/);
  assert.match(p, /h:mm:ss/);
  assert.match(SUMMARIZE_SYSTEM, /h:mm:ss/);
  assert.doesNotMatch(p, /\(Nothing else on the heading line/);
});

test("parseSummary reads an en-dash action-item time", () => {
  const r = parseSummary(JSON.stringify({ summary: "s", actionItems: [{ task: "T", owner: "O", at: "1:10:03–1:10:40" }] }));
  assert.deepEqual(r.actionItems, [{ task: "T", owner: "O", start: 4203, end: 4240 }]);
});
