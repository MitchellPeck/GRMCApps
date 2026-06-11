import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { addRosterEntry } from "./roster";
import {
  createRequest, listRequests, getRequestDetail,
  recordDecision, addVersion, getVersionImage,
  listApproved, getApprovedImage,
} from "./requests";

const url = process.env.TEST_DATABASE_URL;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // not a real PNG, just bytes

test("full request lifecycle: submit -> changes -> new version -> approve", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await pool.query("DELETE FROM request_events");
  await pool.query("DELETE FROM request_versions");
  await pool.query("DELETE FROM requests");
  await pool.query("DELETE FROM roster");

  const appr = await addRosterEntry(pool, "Approver", "appr@x.com");
  assert.ok(appr.ok);

  // submit
  const created = await createRequest(pool, {
    title: "Easter banner", description: "for the lawn sign", approverId: appr.id,
    submitter: { email: "sub@x.com", name: "Submitter" },
    file: { fileName: "banner.png", mimeType: "image/png", buffer: png },
  });
  assert.ok(created.ok);
  const id = created.id;

  // appears in approver inbox and submitter sent box
  const inbox = await listRequests(pool, "inbox", "appr@x.com");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].id, id);
  const sent = await listRequests(pool, "sent", "sub@x.com");
  assert.equal(sent.length, 1);

  // non-approver cannot decide
  const bad = await recordDecision(pool, id, "sub@x.com", "approve", "");
  assert.equal(bad.ok, false);
  assert.equal((bad as { status: number }).status, 403);

  // approver requests changes (comment required)
  const noComment = await recordDecision(pool, id, "appr@x.com", "request_changes", "");
  assert.equal(noComment.ok, false);
  const changed = await recordDecision(pool, id, "appr@x.com", "request_changes", "Make the cross bigger");
  assert.ok(changed.ok);

  // now it leaves the approver inbox (status changes_requested)
  assert.equal((await listRequests(pool, "inbox", "appr@x.com")).length, 0);

  // submitter uploads a new version -> back to pending, current_version 2
  const v2 = await addVersion(pool, id, "sub@x.com",
    { fileName: "banner2.png", mimeType: "image/png", buffer: png }, "bigger cross");
  assert.ok(v2.ok);
  const detail = await getRequestDetail(pool, id, "sub@x.com");
  assert.ok(detail.ok);
  assert.equal(detail.request.status, "pending");
  assert.equal(detail.request.current_version, 2);
  assert.equal(detail.versions.length, 2);
  // events: submitted, changes_requested, resubmitted
  assert.ok(detail.events.length >= 3);

  // image fetch returns bytes for a party, 403 for an outsider
  const img = await getVersionImage(pool, id, 2, "appr@x.com");
  assert.ok(img.ok);
  assert.equal(img.mimeType, "image/png");
  const denied = await getVersionImage(pool, id, 2, "stranger@x.com");
  assert.equal(denied.ok, false);
  assert.equal((denied as { status: number }).status, 403);

  // approve -> terminal
  const approved = await recordDecision(pool, id, "appr@x.com", "approve", "looks great");
  assert.ok(approved.ok);
  const after = await getRequestDetail(pool, id, "appr@x.com");
  assert.ok(after.ok);
  assert.equal(after.request.status, "approved");
  // cannot approve again
  assert.equal((await recordDecision(pool, id, "appr@x.com", "approve", "")).ok, false);

  await pool.query("DELETE FROM request_events");
  await pool.query("DELETE FROM request_versions");
  await pool.query("DELETE FROM requests");
  await pool.query("DELETE FROM roster");
  await pool.end();
});

test("listApproved returns approved requests and getApprovedImage returns current-version bytes", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await pool.query("DELETE FROM request_events");
  await pool.query("DELETE FROM request_versions");
  await pool.query("DELETE FROM requests");
  await pool.query("DELETE FROM roster");

  const appr = await addRosterEntry(pool, "Approver2", "appr2@x.com");
  assert.ok(appr.ok);

  const created = await createRequest(pool, {
    title: "Approved Banner", description: "approved graphic", approverId: appr.id,
    submitter: { email: "sub2@x.com", name: "Submitter2" },
    file: { fileName: "approved.png", mimeType: "image/png", buffer: png },
  });
  assert.ok(created.ok);
  const id = created.id;

  // Directly set status to approved (bypassing business logic, matching test style)
  await pool.query("UPDATE requests SET status='approved', decided_at=now() WHERE id=$1", [id]);

  const list = await listApproved(pool);
  assert.ok(Array.isArray(list));
  assert.ok(list.every((r) => typeof r.id === "number" && typeof r.title === "string" && typeof r.currentVersion === "number"));
  assert.ok(list.length >= 1, "an approved request should be listed");

  const img = await getApprovedImage(pool, list[0].id);
  assert.ok(img.ok && Buffer.isBuffer(img.image) && img.mimeType.length > 0);

  await pool.query("DELETE FROM request_events");
  await pool.query("DELETE FROM request_versions");
  await pool.query("DELETE FROM requests");
  await pool.query("DELETE FROM roster");
  await pool.end();
});
