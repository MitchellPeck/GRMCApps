import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cutoffDate, pickCampaign } from "./pipeline/sources";
import { CampaignSummary } from "./mailchimp";

const c = (id: string, createdAt: string): CampaignSummary => ({
  id, subject: "Grace Notes " + id, status: "sent", archiveUrl: "https://x/" + id, sentAt: createdAt, createdAt,
  issueDate: "", isDraft: false, dateLine: "",
});
// Newest first, as listCampaigns returns them.
const list = [c("oct25", "2026-10-23T14:00:00Z"), c("oct18", "2026-10-16T14:00:00Z"), c("oct11", "2026-10-09T14:00:00Z")];

test("the Sunday on or after a post's date", () => {
  assert.equal(cutoffDate("followingSunday", "2026-10-21"), "2026-10-25", "Wednesday → that Sunday");
  assert.equal(cutoffDate("followingSunday", "2026-10-25"), "2026-10-25", "a Sunday is its own cutoff");
  assert.equal(cutoffDate("postDate", "2026-10-21"), "2026-10-21");
  assert.equal(cutoffDate("latest", "2026-10-21"), null);
  assert.equal(cutoffDate("followingSunday", null), null, "no date: no cutoff");
});

test("picking the issue, as the Wednesday and Friday runs did", () => {
  assert.equal(pickCampaign(list, "latest", "2026-10-14")?.id, "oct25");
  assert.equal(pickCampaign(list, "followingSunday", "2026-10-14")?.id, "oct18", "Wed Oct 14 gets the issue made by Sun Oct 18");
  assert.equal(pickCampaign(list, "followingSunday", "2026-10-07")?.id, "oct11", "Wed Oct 7 gets the issue made by Sun Oct 11");
  assert.equal(pickCampaign(list, "postDate", "2026-10-20")?.id, "oct18");
  assert.equal(pickCampaign(list, "followingSunday", null)?.id, "oct25", "no publish date: newest");
  assert.equal(pickCampaign(list, "postDate", "2026-01-01")?.id, "oct25", "nothing old enough: newest, as the run did");
  assert.equal(pickCampaign([], "latest", null), null);
});
