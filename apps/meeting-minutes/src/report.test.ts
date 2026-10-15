import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildReport, consolidateActionItems, reportChanges, reportHtml, ReportInput } from "./report";

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    title: "Board",
    meetingDate: "2026-04-01",
    location: "Hall",
    present: ["Alice", "Bob"],
    guests: [{ name: "Gina", title: "Architect" }],
    absent: ["Carl"],
    items: [
      { id: 1, title: "Budget", presenters: ["Bob"], summary: "Reviewed Q2.\n- Shortfall of $2k", hasContent: true,
        actionItems: [{ task: "Send figures", owner: "Bob" }, { task: "send figures", owner: "bob" }] },
      { id: 2, title: "Missions", presenters: [], summary: "", hasContent: false, actionItems: [] },
    ],
    ...over,
  };
}

test("buildReport lays out attendance, agenda and consolidated action items", () => {
  const { markdown } = buildReport(input());
  assert.match(markdown, /^# Board\n\*\*Date:\*\* 2026-04-01 · \*\*Location:\*\* Hall\n/);
  assert.match(markdown, /\*\*Present:\*\* Alice, Bob/);
  assert.match(markdown, /\*\*Guests:\*\* Gina \(Architect\)/);
  assert.match(markdown, /\*\*Absent:\*\* Carl/);
  assert.match(markdown, /### 1\. Budget\n\*\*Presented by:\*\* Bob\nReviewed Q2\.\n- Shortfall of \$2k/);
  assert.match(markdown, /### 2\. Missions\nNo discussion recorded\./);
  // The case-insensitive duplicate is merged.
  assert.equal(markdown.match(/Send figures/gi)?.length, 1);
  assert.match(markdown, /- \[ \] Send figures — \*\*Bob\*\* \(Budget\)/);
});

test("buildReport says so when nobody is absent and there are no action items", () => {
  const { markdown } = buildReport(input({ absent: [], guests: [], items: [] }));
  assert.match(markdown, /\*\*Absent:\*\* None/);
  assert.doesNotMatch(markdown, /Guests/);
  assert.match(markdown, /## Action Items\nNone recorded\./);
});

test("consolidateActionItems defaults a blank owner to Unassigned", () => {
  const lines = consolidateActionItems([
    { id: 1, title: "X", presenters: [], summary: "", hasContent: true, actionItems: [{ task: "Do it", owner: "" }] },
  ]);
  assert.deepEqual(lines, ["- [ ] Do it — **Unassigned** (X)"]);
});

test("reportChanges is empty for an unchanged meeting and names what changed", () => {
  const saved = buildReport(input()).sources;
  const titles = new Map([[1, "Budget"], [2, "Missions"], [3, "New"]]);
  assert.deepEqual(reportChanges(saved, buildReport(input()).sources, titles), []);

  const edited = input();
  edited.items[1] = { ...edited.items[1], summary: "Now discussed.", hasContent: true };
  edited.items.push({ id: 3, title: "New", presenters: [], summary: "", hasContent: false, actionItems: [] });
  edited.absent = [];
  assert.deepEqual(reportChanges(saved, buildReport(edited).sources, titles), [
    "Attendance or guests changed",
    "Summary changed: Missions",
    "Added: New",
  ]);
});

test("reportChanges reports removals and a pure reorder", () => {
  const saved = buildReport(input()).sources;
  const titles = new Map([[1, "Budget"], [2, "Missions"]]);
  const removed = input(); removed.items = [removed.items[0]];
  assert.deepEqual(reportChanges(saved, buildReport(removed).sources, titles), ["1 item removed"]);
  const reordered = input(); reordered.items = [reordered.items[1], reordered.items[0]];
  assert.deepEqual(reportChanges(saved, buildReport(reordered).sources, titles), ["Agenda order changed"]);
});

test("reportChanges treats a report with no saved fingerprint as current", () => {
  assert.deepEqual(reportChanges({}, buildReport(input()).sources, new Map()), []);
});

test("reportHtml renders headings, bold, checkboxes and escapes HTML", () => {
  const html = reportHtml("# A <b>\n**Present:** X\n- [ ] Task — **Bob**\n- plain", "A <b>");
  assert.match(html, /<title>A &lt;b&gt;<\/title>/);
  assert.match(html, /<h1>A &lt;b&gt;<\/h1>/);
  assert.match(html, /<p><strong>Present:<\/strong> X<\/p>/);
  assert.match(html, /<ul><li>☐ Task — <strong>Bob<\/strong><\/li><li>plain<\/li><\/ul>/);
});
