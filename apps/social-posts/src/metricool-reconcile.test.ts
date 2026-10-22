import test from "node:test";
import assert from "node:assert/strict";
import { reconcileItem, overallStatus } from "./pipeline/metricool-reconcile";
import { textHash, type PlannerPost, type PlannerNetwork } from "./metricool-planner";
import type { Link } from "./pipeline/metricool-links";

const covered = { from: "2026-10-01", to: "2026-10-31" };
const link = (o: Partial<Link>): Link => ({
  contentItemId: "i1", metricoolPostId: "p1", network: "instagram", scheduledFor: "2026-10-25T09:00",
  state: "scheduled", detail: "", publicUrl: "", textHash: "", goneAt: null, metricoolUuid: "", metricoolCreated: "", ...o });
const net = (network: PlannerNetwork["network"], o: Partial<PlannerNetwork> = {}): PlannerNetwork => ({
  network, scheduledFor: "2026-10-25T09:00", state: "scheduled", detail: "", publicUrl: "", text: "hi", ...o });
const planner = (...posts: PlannerPost[]) => new Map(posts.map((p) => [p.id, p]));
const post = (id: string, networks: PlannerNetwork[]): PlannerPost => ({ id, uuid: "", createdAt: "", creatorId: "", networks, media: [] });

test("a move of every network is one group at the new time", () => {
  const links = [link({ network: "instagram" }), link({ network: "facebook" })];
  const r = reconcileItem(links, planner(post("p1", [
    net("instagram", { scheduledFor: "2026-10-26T10:00" }), net("facebook", { scheduledFor: "2026-10-26T10:00" })])), covered);
  assert.equal(r.changes.length, 2);
  assert.ok(r.changes.every((c) => c.scheduledFor === "2026-10-26T10:00"));
  assert.deepEqual(r.groups, [{ scheduledFor: "2026-10-26T10:00", networks: ["instagram", "facebook"] }]);
});

test("moving only Instagram makes two groups, earliest first", () => {
  const links = [link({ network: "instagram" }), link({ network: "facebook" })];
  const r = reconcileItem(links, planner(post("p1", [
    net("instagram", { scheduledFor: "2026-10-24T08:00" }), net("facebook")])), covered);
  assert.deepEqual(r.groups, [
    { scheduledFor: "2026-10-24T08:00", networks: ["instagram"] },
    { scheduledFor: "2026-10-25T09:00", networks: ["facebook"] }]);
});

test("reconcile marks gone only inside the covered range", () => {
  const inside = link({ metricoolPostId: "a", scheduledFor: "2026-10-31T23:00" });
  const outside = link({ metricoolPostId: "b", scheduledFor: "2026-11-01T09:00" });
  const r = reconcileItem([inside, outside], planner(), covered);
  assert.deepEqual(r.changes.map((c) => [c.link.metricoolPostId, c.state]), [["a", "gone"]]);
  assert.deepEqual(r.groups, [{ scheduledFor: "2026-11-01T09:00", networks: ["instagram"] }]);
});

test("a published link never goes", () => {
  const r = reconcileItem([link({ state: "published" })], planner(), covered);
  assert.deepEqual(r.changes, []);
  assert.equal(r.groups.length, 1);
});

test("a gone link whose post reappears comes back with the planner's state", () => {
  const r = reconcileItem([link({ state: "gone", goneAt: "2026-10-20T00:00:00.000Z" })],
    planner(post("p1", [net("instagram", { state: "draft" })])), covered);
  assert.equal(r.changes[0].state, "draft");
  assert.equal(r.groups.length, 1);
});

test("an edited text is reported once and the baseline is set first", () => {
  const p = planner(post("p1", [net("instagram", { text: "first" })]));
  const a = reconcileItem([link({})], p, covered);
  assert.equal(a.changes[0].newHash, textHash("first"));
  assert.equal(a.changes[0].text, undefined);
  const p2 = planner(post("p1", [net("instagram", { text: "second" })]));
  const b = reconcileItem([link({ textHash: textHash("first") })], p2, covered);
  assert.equal(b.changes[0].text, "second");
  assert.equal(b.changes[0].newHash, textHash("second"));
  const c = reconcileItem([link({ textHash: textHash("second") })], p2, covered);
  assert.deepEqual(c.changes, []);
});

test("unknown status changes nothing", () => {
  const r = reconcileItem([link({})], planner(post("p1", [net("instagram", { state: "unknown", scheduledFor: "2026-10-30T09:00", text: "x" })])), covered);
  assert.deepEqual(r.changes, []);
  assert.equal(r.unknown.length, 1);
  assert.deepEqual(r.groups, [{ scheduledFor: "2026-10-25T09:00", networks: ["instagram"] }]);
});

test("an unreadable time is treated like unknown", () => {
  const r = reconcileItem([link({ textHash: "old" })], planner(post("p1", [net("instagram", { scheduledFor: "", text: "x" })])), covered);
  assert.deepEqual(r.changes, []);
  assert.equal(r.unknown.length, 1);
});

test("overallStatus follows the table", () => {
  assert.deepEqual(overallStatus(["published", "published"], "d"), { status: "published", note: "" });
  assert.deepEqual(overallStatus(["published", "gone"], "d"), { status: "published", note: "" });
  assert.equal(overallStatus(["published", "scheduled"], "d").status, "scheduled");
  assert.equal(overallStatus(["published", "draft"], "d").status, "scheduled");
  assert.equal(overallStatus(["published", "failed"], "d").status, "scheduled");
  assert.equal(overallStatus(["scheduled", "draft"], "d").status, "scheduled");
  assert.deepEqual(overallStatus([
    { state: "failed", network: "instagram", detail: "bad image" }, { state: "failed", network: "x", detail: "too long" }], "d"),
    { status: "scheduled", note: "Metricool couldn't publish it: Instagram: bad image; X: too long" });
  assert.deepEqual(overallStatus(["gone", "gone"], "2026-10-22"), { status: "ready", note: "Removed from Metricool on 2026-10-22." });
  assert.deepEqual(overallStatus([], "d"), { status: "scheduled", note: "" });
});

test("a published link stays published whatever the planner says later", () => {
  const l = link({ state: "published", publicUrl: "https://facebook.com/1", textHash: textHash("hi") });
  const r = reconcileItem([l], planner(post("p1", [net("instagram", { state: "failed", detail: "Token expired", publicUrl: "https://instagram.com/2" })])), covered);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].state, undefined);
  assert.equal(r.changes[0].detail, "Token expired");
  assert.equal(r.changes[0].publicUrl, "https://instagram.com/2");
  const s = reconcileItem([l], planner(post("p1", [net("instagram", { state: "scheduled", publicUrl: "https://facebook.com/1" })])), covered);
  assert.deepEqual(s.changes, []);
});
