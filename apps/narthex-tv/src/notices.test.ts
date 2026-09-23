import { test } from "node:test";
import assert from "node:assert/strict";
import {
  columnsFor, layoutNotice, themeFor, THEMES, validateNotice, wrapText,
} from "./notices";

test("wrapText breaks on words, not mid-word", () => {
  assert.deepEqual(wrapText("the quick brown fox jumps", 10),
                   ["the quick", "brown fox", "jumps"]);
  assert.deepEqual(wrapText("short", 40), ["short"]);
  assert.deepEqual(wrapText("", 40), []);
  assert.deepEqual(wrapText("   ", 40), []);
});

test("a word longer than the column is broken rather than running off the slide", () => {
  // A pasted URL would otherwise vanish over the right-hand edge.
  const lines = wrapText("https://graceresurrection.org/give/christmas", 12);
  assert.ok(lines.every((l) => l.length <= 12), JSON.stringify(lines));
  assert.equal(lines.join(""), "https://graceresurrection.org/give/christmas");
});

test("deliberate line breaks are kept", () => {
  assert.deepEqual(wrapText("first\nsecond", 40), ["first", "second"]);
});

test("columnsFor never returns something unusable", () => {
  assert.ok(columnsFor(1570, 54, false) > 40);
  assert.ok(columnsFor(1570, 132, true) > 20);
  // Even an absurd font size leaves a usable column rather than zero.
  assert.equal(columnsFor(100, 900, false), 8);
});

test("the urgent theme matches what the browser player draws", () => {
  // The two clients showing the same emergency must not look like different
  // systems: #takeover in player.css is #7a1d1d on white.
  assert.equal(THEMES.urgent.background, "0x7A1D1D");
  assert.equal(THEMES.urgent.headline, "0xFFFFFF");
});

test("an unknown theme falls back instead of rendering an invisible slide", () => {
  assert.deepEqual(themeFor("chartreuse"), THEMES.navy);
  assert.deepEqual(themeFor(""), THEMES.navy);
  assert.deepEqual(themeFor("paper"), THEMES.paper);
});

test("every theme has a background distinct from its headline colour", () => {
  for (const [name, t] of Object.entries(THEMES)) {
    assert.notEqual(t.background, t.headline, `${name} would be unreadable`);
    assert.notEqual(t.background, t.body, `${name} body would be unreadable`);
  }
});

test("a notice lays out on the canvas and stays inside it", () => {
  const layout = layoutNotice(
    { headline: "Trunk or Treat", body: "Sunday 26th October, 5pm, in the back lot.", footnote: "All welcome" },
    { theme: "navy" }
  );
  assert.equal(layout.width, 1920);
  assert.ok(layout.lines.length >= 3);
  for (const line of layout.lines) {
    assert.ok(line.y >= 0, "line above the top edge");
    assert.ok(line.y + line.fontSize <= layout.height, `line at ${line.y} falls off the bottom`);
  }
});

test("the headline is serif and larger than the body", () => {
  const layout = layoutNotice({ headline: "Advent", body: "Begins November 30th.", footnote: "" });
  const head = layout.lines[0];
  const body = layout.lines[layout.lines.length - 1];
  assert.equal(head.serif, true);
  assert.equal(body.serif, false);
  assert.ok(head.fontSize > body.fontSize);
});

test("a long headline steps down in size rather than filling the slide", () => {
  const short = layoutNotice({ headline: "Advent", body: "", footnote: "" });
  const long = layoutNotice({
    headline: "Join us for the annual service of nine lessons and carols this December",
    body: "", footnote: "",
  });
  assert.ok(long.lines[0].fontSize < short.lines[0].fontSize);
  assert.ok(long.lines.length <= 4, "should not run to more than a few lines");
  for (const line of long.lines) {
    assert.ok(line.y + line.fontSize <= long.height, "long headline overruns the slide");
  }
});

test("the rule appears only when there is both a headline and a body", () => {
  assert.ok(layoutNotice({ headline: "A", body: "B", footnote: "" }).rule);
  assert.equal(layoutNotice({ headline: "A", body: "", footnote: "" }).rule, null);
  assert.equal(layoutNotice({ headline: "", body: "B", footnote: "" }).rule, null);
});

test("a wall of text is truncated rather than overrunning the slide", () => {
  const layout = layoutNotice({
    headline: "Notices",
    body: Array.from({ length: 40 }, (_, i) => `Line number ${i} of a very long notice`).join(" "),
    footnote: "",
  });
  for (const line of layout.lines) {
    assert.ok(line.y + line.fontSize <= layout.height, `overran at y=${line.y}`);
  }
});

test("validateNotice refuses what cannot be shown", () => {
  assert.equal(validateNotice({ headline: "", body: "" }).ok, false);
  assert.equal(validateNotice({ headline: "  ", body: "  " }).ok, false);
  assert.equal(validateNotice({ headline: "Hello", body: "" }).ok, true);
  assert.equal(validateNotice({ headline: "", body: "Just a body" }).ok, true);
  assert.equal(validateNotice({ headline: "H".repeat(300), body: "" }).ok, false);
  assert.equal(validateNotice({ headline: "H", body: "B".repeat(900) }).ok, false);
});
