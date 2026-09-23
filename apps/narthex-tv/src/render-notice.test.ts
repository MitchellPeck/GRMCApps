import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFilter } from "./render-notice";
import { layoutNotice } from "./notices";

const FONTS = { serif: "/f/serif.ttf", sans: "/f/sans.ttf" };

function filterFor(text: { headline: string; body: string; footnote: string }) {
  const layout = layoutNotice(text);
  const paths = layout.lines.map((_, i) => `/tmp/lines/${i}.txt`);
  return { layout, filter: buildFilter(layout, paths, FONTS) };
}

test("text is never interpolated into the filtergraph", () => {
  // The whole point of textfile=: a colon, apostrophe, percent, comma or
  // backslash in somebody's announcement must not be able to change the graph.
  const nasty = "Tea & coffee: 10:30, Pastor's study — 100% welcome \\ bring a friend";
  const { filter } = filterFor({ headline: nasty, body: nasty, footnote: nasty });
  assert.ok(!filter.includes("Pastor"), "the text leaked into the filter");
  assert.ok(!filter.includes("100%"), "the text leaked into the filter");
  assert.ok(filter.includes("textfile=/tmp/lines/0.txt"));
  assert.ok(!filter.includes("text="+"'"), "should never use the quoting form");
});

test("each laid-out line gets exactly one drawtext", () => {
  const { layout, filter } = filterFor({
    headline: "Trunk or Treat", body: "Sunday the 26th, 5pm.", footnote: "All welcome",
  });
  const drawtexts = filter.split("drawtext=").length - 1;
  assert.equal(drawtexts, layout.lines.length);
});

test("the headline uses the serif font and the body the sans", () => {
  const { filter } = filterFor({ headline: "Advent", body: "Starts soon.", footnote: "" });
  assert.ok(filter.includes(`fontfile=${FONTS.serif}`));
  assert.ok(filter.includes(`fontfile=${FONTS.sans}`));
});

test("the rule is drawn only when the layout asks for one", () => {
  assert.ok(filterFor({ headline: "A", body: "B", footnote: "" }).filter.includes("drawbox="));
  assert.ok(!filterFor({ headline: "A", body: "", footnote: "" }).filter.includes("drawbox="));
});

test("an empty layout still yields a filter ffmpeg will accept", () => {
  const layout = layoutNotice({ headline: "", body: "", footnote: "" });
  assert.equal(buildFilter(layout, [], FONTS), "null");
});

test("every drawtext carries a colour, a size and a position", () => {
  const { filter } = filterFor({ headline: "Advent", body: "Starts soon.", footnote: "Welcome" });
  for (const piece of filter.split(",").filter((p) => p.startsWith("drawtext="))) {
    assert.ok(/fontcolor=0x[0-9A-Fa-f]{6}/.test(piece), piece);
    assert.ok(/fontsize=\d+/.test(piece), piece);
    assert.ok(piece.includes("x=(w-text_w)/2"), piece);
    assert.ok(/[:]y=\d+/.test(piece), piece);
  }
});
