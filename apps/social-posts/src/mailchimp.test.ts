import { strict as assert } from "node:assert";
import { test } from "node:test";
import { campaignDateLine, cleanCampaignText, isDraftStatus, parseIssueDate } from "./mailchimp";

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

test("parseIssueDate reads the issue's own date out of the subject line", () => {
  assert.equal(parseIssueDate("Grace Notes - August 5, 2026 - Weekly Update"), "2026-08-05");
  assert.equal(parseIssueDate("Grace Notes - Aug 5, 2026"), "2026-08-05");
  assert.equal(parseIssueDate("Rev. Williams' Weekly Blog - June 5, 2026"), "2026-06-05");
  assert.equal(parseIssueDate("Grace Notes 8/5/2026"), "2026-08-05");
  assert.equal(parseIssueDate("Grace Notes - Weekly Update"), "");
  assert.equal(parseIssueDate(""), "");
});

test("isDraftStatus treats Mailchimp's 'save' as a draft", () => {
  assert.equal(isDraftStatus("save"), true);
  assert.equal(isDraftStatus("paused"), true);
  assert.equal(isDraftStatus("sent"), false);
  assert.equal(isDraftStatus("schedule"), false);
});

test("campaignDateLine never calls an unsent issue 'sent'", () => {
  // The reported bug: an Aug 5 issue still in draft, created Jul 31, was
  // captioned "sent Jul 31".
  const draft = campaignDateLine(
    { status: "save", sentAt: "", createdAt: "2026-07-31T14:02:00+00:00", issueDate: "2026-08-05" },
    "America/New_York"
  );
  assert.equal(draft, "Issue Aug 5, 2026 · draft, created Jul 31, 2026");

  const sent = campaignDateLine(
    { status: "sent", sentAt: "2026-08-05T13:00:00+00:00", createdAt: "2026-07-31T14:02:00+00:00", issueDate: "2026-08-05" },
    "America/New_York"
  );
  assert.equal(sent, "Issue Aug 5, 2026 · sent Aug 5, 2026");

  const scheduled = campaignDateLine(
    { status: "schedule", sentAt: "2026-08-05T13:00:00+00:00", createdAt: "2026-07-31T14:02:00+00:00", issueDate: "" },
    "America/New_York"
  );
  assert.equal(scheduled, "scheduled to send Aug 5, 2026");
});
