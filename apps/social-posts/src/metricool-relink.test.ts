import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePlanner, textHash, type PlannerPost } from "./metricool-planner";
import { relinkPlan } from "./pipeline/metricool-relink";
import { shouldImport } from "./pipeline/metricool-import";
import type { Link } from "./pipeline/metricool-links";

const TZ = "America/New_York";
const planner = (name: string) => parsePlanner(JSON.parse(readFileSync(join(__dirname, "..", "src", "fixtures", name), "utf8")), TZ);
const link = (o: Partial<Link>): Link => ({
  contentItemId: "i1", metricoolPostId: "403266041", network: "facebook", scheduledFor: "2026-10-23T17:19", state: "scheduled",
  detail: "", publicUrl: "", textHash: "", goneAt: null, metricoolUuid: "", metricoolCreated: "", ...o });
const probeText = () => planner("metricool-planner-before.json").find((p) => p.id === "403266041")!.networks[0].text;

test("a one-network move is followed to both new ids", () => {
  const h = textHash(probeText());
  const links = ["facebook", "instagram"].map((network) => link({ network, textHash: h, metricoolCreated: "2026-10-22T11:19", metricoolUuid: "3714024336334799271" }));
  // The old uuid is gone from the new posts, so this exercises the createdAt path only if uuid misses.
  const plan = relinkPlan(links, planner("metricool-planner-after-move.json"), []);
  assert.deepEqual(plan.map((e) => [e.network, e.toPostId]).sort(), [["facebook", "403266378"], ["instagram", "403266388"]]);
  assert.equal(plan.find((e) => e.network === "facebook")!.uuid, "6952897850155486888");
  assert.equal(plan.find((e) => e.network === "instagram")!.scheduledFor, "2026-10-24T17:19");
});

test("a move without a stored uuid is still followed", () => {
  const links = ["facebook", "instagram"].map((network) => link({ network, textHash: textHash(probeText()), metricoolCreated: "2026-10-22T11:19" }));
  assert.equal(relinkPlan(links, planner("metricool-planner-after-move.json"), []).length, 2);
  // A link with no text hash yet falls back on the creation time alone.
  const bare = links.map((l) => ({ ...l, textHash: "" }));
  assert.equal(relinkPlan(bare, planner("metricool-planner-after-move.json"), []).length, 2);
});

test("a one-network edit is followed by uuid", () => {
  const l = link({ metricoolPostId: "403266378", metricoolUuid: "6952897850155486888", textHash: textHash(probeText()) });
  const plan = relinkPlan([l], planner("metricool-planner-after-edit.json"), []);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].toPostId, "403266648");
  assert.equal(plan[0].link, l);
});

test("relinking is idempotent", () => {
  const l = link({ metricoolPostId: "403266378", metricoolUuid: "6952897850155486888" });
  const p = planner("metricool-planner-after-edit.json");
  const [e] = relinkPlan([l], p, []);
  const moved = { ...l, metricoolPostId: e.toPostId, metricoolUuid: e.uuid, metricoolCreated: e.created };
  assert.deepEqual(relinkPlan([moved], p, []), []);
});

const mk = (id: string, text: string, createdAt = "2026-10-22T11:19"): PlannerPost => ({
  id, uuid: "u" + id, createdAt, creatorId: "7",
  networks: [{ network: "facebook", scheduledFor: "2026-10-23T17:19", state: "scheduled", detail: "", publicUrl: "", text }], media: [] });

test("two candidates mean no relink", () => {
  const l = link({ metricoolCreated: "2026-10-22T11:19", textHash: textHash("same") });
  assert.deepEqual(relinkPlan([l], [mk("a", "same"), mk("b", "same")], []), []);
  assert.equal(relinkPlan([l], [mk("a", "same")], []).length, 1);
});

test("two links wanting one post leave it alone", () => {
  const a = link({ metricoolPostId: "x1", metricoolCreated: "2026-10-22T11:19", textHash: textHash("same") });
  const b = link({ metricoolPostId: "x2", contentItemId: "i2", metricoolCreated: "2026-10-22T11:19", textHash: textHash("same") });
  assert.deepEqual(relinkPlan([a, b], [mk("a", "same")], []), []);
});

test("an id-less send is matched to its Metricool post", () => {
  const send = { itemId: "i9", networks: ["facebook"], textHash: textHash(probeText()), sentAt: "2026-10-22T11:19" };
  const plan = relinkPlan([], planner("metricool-planner-after-move.json"), [send]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].link, null);
  assert.equal(plan[0].toPostId, "403266378");
  assert.equal(plan[0].itemId, "i9");
  // The app logs a moment after Metricool creates the post, possibly across a minute boundary.
  assert.equal(relinkPlan([], planner("metricool-planner-after-move.json"), [{ ...send, sentAt: "2026-10-22T11:20" }]).length, 1);
  assert.equal(relinkPlan([], planner("metricool-planner-after-move.json"), [{ ...send, sentAt: "2026-10-22T11:21" }]).length, 0);
  // A post a link already holds is not up for grabs.
  assert.equal(relinkPlan([link({ metricoolPostId: "403266378" })], planner("metricool-planner-after-move.json"), [send]).length, 0);
});

test("relinked posts are not imported", () => {
  const post = mk("c1", "t");
  assert.equal(shouldImport(post, new Set(), new Set(), "2026-01-01", [], new Set(["c1"])), false);
  assert.equal(shouldImport(post, new Set(), new Set(), "2026-01-01", [], new Set()), true);
});

