import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cleanCampaignText } from "./mailchimp";

test("cleanCampaignText strips header rule and footer", () => {
  // Footer markers must fall in the back half of the post-header content, since
  // cleanCampaignText only strips a footer marker past the 50% mark (matching the
  // reference) so body-text mentions of "unsubscribe" aren't falsely cut. Real
  // Mailchimp emails are long, so the footer is always well past halfway.
  const raw = [
    "View this email in your browser",
    "GRMC logo",
    "--------------------------------",
    "Real paragraph one. With enough genuine content that the body dominates.",
    "Real paragraph two, also long enough to push the footer past the midpoint.",
    "A third sentence of real content so the footer sits in the back half.",
    "",
    "Unsubscribe from this list",
    "Copyright © 2026 GRMC",
  ].join("\n");
  const out = cleanCampaignText(raw);
  assert.ok(out.startsWith("Real paragraph one."), "header before ---- removed");
  assert.ok(!out.includes("Unsubscribe"), "footer removed");
  assert.ok(!out.includes("logo"), "pre-rule header removed");
});

test("cleanCampaignText leaves clean text untouched", () => {
  assert.equal(cleanCampaignText("Just a sentence."), "Just a sentence.");
});
