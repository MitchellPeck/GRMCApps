import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHtml, htmlToText } from "./gracenotes/html";

test("sanitize keeps allowed markup", () => {
  const html = '<p>Hi <strong>all</strong> <a href="https://x.org">here</a></p>';
  assert.equal(sanitizeHtml(html), html);
});

test("sanitize strips word junk", () => {
  assert.equal(
    sanitizeHtml('<p class="MsoNormal" style="x"><span style="font:1">Hi</span><o:p></o:p></p>'),
    "<p>Hi</p>",
  );
});

test("sanitize kills scripts and js links", () => {
  assert.equal(
    sanitizeHtml('<p onclick="x">a<script>alert(1)</script><a href="javascript:alert(1)">b</a></p>'),
    "<p>ab</p>",
  );
});

test("sanitize maps b/i/div", () => {
  assert.equal(sanitizeHtml("<div><b>x</b><i>y</i></div>"), "<p><strong>x</strong><em>y</em></p>");
});

test("sanitize escapes stray brackets", () => {
  assert.equal(sanitizeHtml("a < b & c"), "a &lt; b &amp; c");
  assert.equal(sanitizeHtml("a > b &amp; c"), "a &gt; b &amp; c");
});

test("sanitize drops comments, styles and unmatched closers, closes open tags", () => {
  assert.equal(sanitizeHtml("<!-- hi --><style>p{x:y}</style><p>a</em></p><ul><li>b"), "<p>a</p><ul><li>b</li></ul>");
});

test("sanitize keeps mailto and drops other attributes on links", () => {
  assert.equal(
    sanitizeHtml('<a target="_blank" href="mailto:a@b.org" onclick="x">mail</a>'),
    '<a href="mailto:a@b.org">mail</a>',
  );
  assert.equal(sanitizeHtml('<a href=" JaVa\nscript:alert(1)">x</a>'), "x");
});

test("htmlToText", () => {
  assert.equal(htmlToText("<p>One</p><p>Two<br>Three</p><ul><li>A</li></ul>"), "One\n\nTwo\nThree\n\n• A");
});

test("htmlToText links and entities", () => {
  assert.equal(htmlToText('<p><a href="https://x.org">here</a> &amp; <a href="https://y.org">https://y.org</a></p>'), "here (https://x.org) & https://y.org");
  assert.equal(htmlToText("<ul><li>A</li><li>B&nbsp;&lt;3</li></ul>"), "• A\n• B <3");
});
