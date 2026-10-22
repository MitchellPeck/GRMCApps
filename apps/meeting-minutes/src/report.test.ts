import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  attachRanges, buildReport, joinReportLines, replaceLine, reportLines, consolidateActionItems, estimatePages, presentedBy, reportBodyInput, reportChanges,
  reportHtml, ReportInput, ReportItemInput, reportSources, keepReportEdits,
} from "./report";

function item(over: Partial<ReportItemInput> & Pick<ReportItemInput, "id" | "title">): ReportItemInput {
  return {
    description: "", presenters: [], guestPresenters: [], summary: "", notes: "", transcript: "",
    actionItems: [], hasContent: false, range: null, timedTranscript: "", ...over,
  };
}

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    title: "Board",
    meetingDate: "2026-04-01",
    location: "Hall",
    present: ["Alice", "Bob"],
    guests: [{ name: "Gina", title: "Architect" }],
    absent: ["Carl"],
    items: [
      item({ id: 1, title: "Budget", presenters: ["Bob"], summary: "Reviewed Q2.\n- Shortfall of $2k", hasContent: true,
        transcript: "Bob: we are $2k short",
        actionItems: [{ task: "Send figures", owner: "Bob" }, { task: "send figures", owner: "bob" }] }),
      item({ id: 2, title: "Building", guestPresenters: ["Gina"], hasContent: true, notes: "Roof plans" }),
      item({ id: 3, title: "Missions" }),
    ],
    ...over,
  };
}

const BODY = "## Summary\nThe board met.\n\n## Agenda\n### 1. Budget";

test("buildReport lists guests under attendance, then the body and action items", () => {
  const { markdown } = buildReport(input(), BODY);
  assert.match(markdown, /^# Board\n\*\*Date:\*\* 2026-04-01 · \*\*Location:\*\* Hall\n\n## Attendance\n\*\*Present:\*\* Alice, Bob\n\*\*Absent:\*\* Carl\n\n### Guests\n- \*\*Gina\*\* — Architect · Presented: Building\n\n## Summary/);
  assert.ok(markdown.indexOf("## Summary") < markdown.indexOf("## Action Items"));
  // The case-insensitive duplicate is merged.
  assert.equal(markdown.match(/Send figures/gi)?.length, 1);
  assert.match(markdown, /- \[ \] Send figures — \*\*Bob\*\* \(Budget\)/);
});

test("buildReport leaves out the guest section without guests and says when there are no action items", () => {
  const { markdown } = buildReport(input({ absent: [], guests: [], items: [] }), BODY);
  assert.match(markdown, /\*\*Absent:\*\* None/);
  assert.doesNotMatch(markdown, /Guests/);
  assert.match(markdown, /## Action Items\nNone recorded\./);
});

test("presentedBy lists library presenters, then guests marked as guests", () => {
  assert.equal(presentedBy({ presenters: ["Bob"], guestPresenters: ["Gina"] }), "Bob, Gina (Guest)");
  assert.equal(presentedBy({ presenters: [], guestPresenters: [] }), "");
});

test("reportBodyInput hands Claude every item's full record", () => {
  const body = reportBodyInput(input());
  assert.deepEqual(body.guests, ["Gina (Architect)"]);
  assert.equal(body.items[0].transcript, "Bob: we are $2k short");
  assert.equal(body.items[0].actionItems.length, 2);
  assert.equal(body.items[1].presentedBy, "Gina (Guest)");
  assert.equal(body.items[1].notes, "Roof plans");
});

test("consolidateActionItems defaults a blank owner to Unassigned", () => {
  const lines = consolidateActionItems([
    item({ id: 1, title: "X", hasContent: true, actionItems: [{ task: "Do it", owner: "" }] }),
  ]);
  assert.deepEqual(lines, ["- [ ] Do it — **Unassigned** (X)"]);
});

test("reportChanges is empty for an unchanged meeting and names what changed", () => {
  const saved = reportSources(input());
  const titles = new Map([[1, "Budget"], [2, "Building"], [3, "Missions"], [4, "New"]]);
  assert.deepEqual(reportChanges(saved, reportSources(input()), titles), []);

  const edited = input();
  edited.items[2] = { ...edited.items[2], summary: "Now discussed.", hasContent: true };
  edited.items.push(item({ id: 4, title: "New" }));
  edited.absent = [];
  assert.deepEqual(reportChanges(saved, reportSources(edited), titles), [
    "Attendance or guests changed",
    "Summary changed: Missions",
    "Added: New",
  ]);
});

test("reportChanges notices a guest presenter being added", () => {
  const saved = reportSources(input());
  const edited = input();
  edited.items[0] = { ...edited.items[0], guestPresenters: ["Gina"] };
  assert.deepEqual(reportChanges(saved, reportSources(edited), new Map([[1, "Budget"]])), ["Summary changed: Budget"]);
});

test("reportChanges reports removals and a pure reorder", () => {
  const saved = reportSources(input());
  const titles = new Map([[1, "Budget"], [2, "Building"], [3, "Missions"]]);
  const removed = input(); removed.items = [removed.items[0], removed.items[1]];
  assert.deepEqual(reportChanges(saved, reportSources(removed), titles), ["1 item removed"]);
  const reordered = input(); reordered.items = [reordered.items[1], reordered.items[0], reordered.items[2]];
  assert.deepEqual(reportChanges(saved, reportSources(reordered), titles), ["Agenda order changed"]);
});

test("reportChanges treats a report with no saved fingerprint as current", () => {
  assert.deepEqual(reportChanges({}, reportSources(input()), new Map()), []);
});

test("reportHtml renders headings, bold, checkboxes and escapes HTML", () => {
  const html = reportHtml("# A <b>\n**Present:** X\n- [ ] Task — **Bob**\n- plain", "A <b>");
  assert.match(html, /<title>A &lt;b&gt;<\/title>/);
  assert.match(html, /<h1>A &lt;b&gt;<\/h1>/);
  assert.match(html, /<p><strong>Present:<\/strong> X<\/p>/);
  assert.match(html, /<ul><li>☐ Task — <strong>Bob<\/strong><\/li><li>plain<\/li><\/ul>/);
});

test("reportHtml renders the per-schedule sub-headings", () => {
  assert.match(reportHtml("### 1. Treasurer\n#### Schedule A\n- **Balance:** $100", "T"), /<h3>1\. Treasurer<\/h3><h4>Schedule A<\/h4>/);
});

const R = { source: "m" as const, recordingId: 12, start: 600, end: 1200 };

test("attachRanges marks topic headings by number and converts in-range sub-section cites", () => {
  const items = [item({ id: 1, title: "Budget", range: R }), item({ id: 2, title: "Roof", range: null })];
  const body = [
    "### 1. Budget",
    "#### Schedule A — Operating [10:30-12:00]",
    "#### Schedule B [99:00-99:30]",
    "#### Schedule C [soon]",
    "- **Income:** $5 [10:31-10:40]",
    "### 2. Roof",
    "#### Gutters [10:30-12:00]",
  ].join("\n");
  assert.equal(attachRanges(body, items), [
    "### 1. Budget <!--t:m12:600.0-1200.0-->",
    "#### Schedule A — Operating <!--t:m12:630.0-720.0-->",
    "#### Schedule B",
    "#### Schedule C [soon]",
    "- **Income:** $5 [10:31-10:40]",
    "### 2. Roof",
    "#### Gutters",
  ].join("\n"));
});

test("buildReport attaches ranges to the body", () => {
  const { markdown } = buildReport(input({ items: [item({ id: 1, title: "Budget", range: R })] }), "### 1. Budget");
  assert.match(markdown, /### 1\. Budget <!--t:m12:600\.0-1200\.0-->/);
});

test("action items merge across topics and carry their time", () => {
  const items = [
    item({ id: 1, title: "Budget", range: R, actionItems: [{ task: "Send figures", owner: "Bob", start: 700, end: 720 }] }),
    item({ id: 2, title: "Roof", range: null, actionItems: [{ task: "send figures", owner: "bob" }, { task: "Call roofer", owner: "Tom", start: 1, end: 2 }] }),
  ];
  assert.deepEqual(consolidateActionItems(items), [
    "- [ ] Send figures — **Bob** (Budget) <!--t:m12:700.0-720.0-->",
    "- [ ] Call roofer — **Tom** (Roof)",
  ]);
});

test("estimatePages ignores markers", () => {
  assert.equal(estimatePages("word ".repeat(800) + "<!--t:m1:0.0-1.0-->"), 2);
  assert.equal(estimatePages("one two"), 0.5);
  assert.equal(estimatePages(""), 0);
});

test("reportSources ignores range and timedTranscript", () => {
  const a = reportSources(input());
  const b = reportSources(input({ items: input().items.map((it) => ({ ...it, range: R, timedTranscript: "[0:01] x" })) }));
  assert.deepEqual(a, b);
});

test("the report is written from the timed transcript when there is one", () => {
  const body = reportBodyInput(input({ items: [item({ id: 1, title: "A", transcript: "Bob: hi", timedTranscript: "[0:01] Bob: hi" }),
    item({ id: 2, title: "B", transcript: "Ann: edited" })] }));
  assert.equal(body.items[0].transcript, "[0:01] Bob: hi");
  assert.equal(body.items[1].transcript, "Ann: edited");
});

test("reportHtml never shows range markers", () => {
  const html = reportHtml("### 1. Budget <!--t:m12:600.0-1200.0-->\n- [ ] Send — **Bob** <!--t:m12:700.0-720.0-->", "x");
  assert.doesNotMatch(html, /<!--t:|t:m12/);
  assert.match(html, /<h3>1\. Budget<\/h3>/);
});

test("reportHtml is unchanged for a report without markers", () => {
  const md = "# Board\n\n## Summary\nMet.\n- [ ] Send — **Bob**";
  assert.match(reportHtml(md, "x"), /<li>☐ Send — <strong>Bob<\/strong><\/li>/);
});

test("action-item times outside their topic get no play button", () => {
  const late = { source: "m" as const, recordingId: 12, start: 4200, end: 5100 }; // 1:10:00–1:25:00
  const items = [item({ id: 5, title: "Finance", range: late, actionItems: [
    { task: "Hour-less stamp", owner: "Bob", start: 603, end: 640 }, // "10:03-10:40" — topic 1's audio
    { task: "Right stamp", owner: "Ann", start: 4203, end: 4240 },
  ] })];
  assert.deepEqual(consolidateActionItems(items), [
    "- [ ] Hour-less stamp — **Bob** (Finance)",
    "- [ ] Right stamp — **Ann** (Finance) <!--t:m12:4203.0-4240.0-->",
  ]);
});

test("section cites accept en and em dashes, and keep brackets that aren't times", () => {
  const items = [item({ id: 1, title: "Budget", range: R })];
  const body = [
    "### 1. Budget",
    "#### Schedule A [10:30–12:00]",
    "#### Schedule B [10:30 — 12:00]",
    "#### Schedule C [Restricted Funds]",
    "#### Motion [carried]",
  ].join("\n");
  assert.equal(attachRanges(body, items), [
    "### 1. Budget <!--t:m12:600.0-1200.0-->",
    "#### Schedule A <!--t:m12:630.0-720.0-->",
    "#### Schedule B <!--t:m12:630.0-720.0-->",
    "#### Schedule C [Restricted Funds]",
    "#### Motion [carried]",
  ].join("\n"));
});

test("a meeting past the hour cites h:mm:ss", () => {
  const late = { source: "m" as const, recordingId: 12, start: 4200, end: 5100 };
  const out = attachRanges("### 1. Finance\n#### Schedule A [1:10:30-1:12:00]", [item({ id: 1, title: "Finance", range: late })]);
  assert.match(out, /#### Schedule A <!--t:m12:4230\.0-4320\.0-->/);
});

test("topic headings numbered another way still find their topic, by title", () => {
  const items = [item({ id: 1, title: "Treasurer's Report", range: R }),
    item({ id: 2, title: "Building & Grounds", range: { ...R, start: 1300, end: 1500 } })];
  const body = [
    "### I. Treasurer's Report",
    "#### Schedule A [10:30-12:00]",
    "### 1.2 Building & Grounds",
    "### Something the agenda never had",
    "#### Stray [10:30-12:00]",
  ].join("\n");
  assert.equal(attachRanges(body, items), [
    "### I. Treasurer's Report <!--t:m12:600.0-1200.0-->",
    "#### Schedule A <!--t:m12:630.0-720.0-->",
    "### 1.2 Building & Grounds <!--t:m12:1300.0-1500.0-->",
    "### Something the agenda never had",
    "#### Stray",
  ].join("\n"));
});

test("a time the AI puts on a topic heading is removed", () => {
  const out = attachRanges("### 1. Budget [10:00-20:00]", [item({ id: 1, title: "Budget", range: R })]);
  assert.equal(out, "### 1. Budget <!--t:m12:600.0-1200.0-->");
  assert.equal(attachRanges("### 1. Budget [10:00-20:00]", [item({ id: 1, title: "Budget", range: null })]), "### 1. Budget");
});

const EDIT_REPORT = "# Board\n\n## Summary\nThe board met.\n\n### 1. Budget <!--t:m12:600.0-1200.0-->\n- **Income:** $5";

test("report lines on the server work like the page editor's", () => {
  const lines = reportLines(EDIT_REPORT);
  assert.equal(lines.length, 5);
  assert.deepEqual(lines[3], { text: "### 1. Budget", marker: "<!--t:m12:600.0-1200.0-->" });
  assert.equal(joinReportLines(lines), EDIT_REPORT);
  assert.match(joinReportLines(replaceLine(lines, 3, "### 1. Budget and Finance")), /### 1\. Budget and Finance <!--t:m12:600\.0-1200\.0-->/);
  assert.doesNotMatch(joinReportLines(replaceLine(lines, 2, " ")), /The board met/);
  assert.match(joinReportLines(replaceLine(lines, 2, "One.\n\nTwo.")), /## Summary\nOne\.\nTwo\./);
});

// ── Regenerating keeps edits ────────────────────────────────────────────────
const KITEMS = [{ id: 1, title: "Budget" }, { id: 2, title: "Roof" }];
const doc = (budget: string, roof: string, summary = "Old summary.") =>
  `# Board\n\n**Present:** Alice\n\n## Summary\n${summary}\n\n## Agenda\n### 1. Budget <!--t:m1:0.0-60.0-->\n${budget}\n\n### 2. Roof\n${roof}\n\n## Action Items\n- [ ] Call — **Bob** (Roof)\n`;
const SRC = { header: "h", attendance: "a", "item:1": "b1", "item:2": "r1", order: "o" };

test("regenerating takes the new text for every section nobody edited", async () => {
  const out = await keepReportEdits({
    baseline: doc("Old budget.", "Old roof."), edited: doc("Old budget.", "Old roof."),
    fresh: doc("New budget.", "New roof.", "New summary."), items: KITEMS,
    savedSources: SRC, currentSources: { ...SRC, "item:1": "b2" },
  }, async () => { throw new Error("no merge needed"); });
  const lines = (t: string) => t.split("\n").filter((l) => l.trim());
  assert.deepEqual(lines(out), lines(doc("New budget.", "New roof.", "New summary.")));
});

test("an edited section whose topic hasn't changed is kept as edited", async () => {
  const out = await keepReportEdits({
    baseline: doc("Old budget.", "Old roof."), edited: doc("Old budget.", "Roof by Jon."),
    fresh: doc("New budget.", "New roof."), items: KITEMS,
    savedSources: SRC, currentSources: { ...SRC, "item:1": "b2" },
  }, async () => { throw new Error("no merge needed"); });
  assert.match(out, /Roof by Jon\./);
  assert.match(out, /New budget\./);
});

test("an edited section whose topic changed is merged from the original, the edit and the new text", async () => {
  const seen: any[] = [];
  const out = await keepReportEdits({
    baseline: doc("Old budget.", "Old roof."), edited: doc("Budget, Jon's version.", "Old roof."),
    fresh: doc("New budget.", "Old roof."), items: KITEMS,
    savedSources: SRC, currentSources: { ...SRC, "item:1": "b2" },
  }, async (s) => { seen.push(s); return "### 1. Budget [merged heading dropped]\nMerged budget."; });
  assert.equal(seen.length, 1);
  assert.match(seen[0].original, /Old budget\./);
  assert.match(seen[0].edited, /Jon's version/);
  assert.match(seen[0].fresh, /New budget\./);
  assert.match(out, /### 1\. Budget <!--t:m1:0\.0-60\.0-->\nMerged budget\./, "the new heading, with its time, stays");
});

test("a merge that fails keeps the person's edit", async () => {
  const out = await keepReportEdits({
    baseline: doc("Old budget.", "Old roof."), edited: doc("Budget, Jon's version.", "Old roof."),
    fresh: doc("New budget.", "Old roof."), items: KITEMS,
    savedSources: SRC, currentSources: { ...SRC, "item:1": "b2" },
  }, async () => { throw new Error("down"); });
  assert.match(out, /Budget, Jon's version\./);
});

test("the summary is merged when any topic changed, and a section the person added stays where they put it", async () => {
  const edited = doc("Old budget.", "Old roof.", "Summary, edited.").replace("## Agenda", "## Notes\nBring coffee.\n\n## Agenda");
  let merged = 0;
  const out = await keepReportEdits({
    baseline: doc("Old budget.", "Old roof."), edited,
    fresh: doc("New budget.", "Old roof.", "New summary."), items: KITEMS,
    savedSources: SRC, currentSources: { ...SRC, "item:1": "b2" },
  }, async (s) => { merged++; return "## Summary\nMerged summary."; });
  assert.equal(merged, 1);
  assert.match(out, /## Summary\nMerged summary\.\n\n## Notes\nBring coffee\.\n\n## Agenda/);
});

test("without a record of the first version, edited sections are merged where they changed and kept where they didn't", async () => {
  const seen: any[] = [];
  const out = await keepReportEdits({
    baseline: null, edited: doc("Budget, Jon's version.", "Roof by Jon."),
    fresh: doc("New budget.", "New roof."), items: KITEMS,
    savedSources: SRC, currentSources: { ...SRC, "item:1": "b2" },
  }, async (s) => { seen.push(s); return s.fresh; });
  assert.equal(seen.filter((x) => /Budget/.test(x.fresh)).length, 1);
  assert.equal(seen[0].original, null);
  assert.match(out, /Roof by Jon\./);
});
