import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GENERIC_INSTRUCTIONS, effectiveProfile, parseOverride, parseProfile, parseSourceRef } from "./pipeline/drafting";

test("profiles validate their source, instructions and angles", () => {
  assert.ok(parseProfile({}).ok, "an empty profile is fine");
  const gn = parseProfile({ source: { kind: "mailchimp", subjectContains: "Grace Notes", cutoff: "followingSunday" }, instructions: "Warm summary." });
  assert.ok(gn.ok);
  assert.deepEqual(gn.value.source, { kind: "mailchimp", subjectContains: "grace notes", cutoff: "followingSunday" }, "subject match is stored lower-case");
  assert.ok(!parseProfile({ source: { kind: "mailchimp" } }).ok, "Mailchimp needs a subject to match");
  assert.ok(!parseProfile({ source: { kind: "rss" } }).ok);
  assert.ok(!parseProfile({ source: { kind: "mailchimp", subjectContains: "x", cutoff: "yesterday" } }).ok);
  assert.deepEqual(parseProfile({ source: { kind: "mailchimp", subjectContains: "blog" } }).ok && (parseProfile({ source: { kind: "mailchimp", subjectContains: "blog" } }) as any).value.source.cutoff, "latest", "cutoff defaults to latest");
  assert.ok(!parseProfile({ angles: [{ key: "a", label: "A", instructions: "x", offsetDays: 0 }, { key: "a", label: "B", instructions: "y", offsetDays: 1 }] }).ok, "angle keys are unique");
  assert.ok(!parseProfile({ angles: [{ key: "Bad Key", label: "A", instructions: "x", offsetDays: 0 }] }).ok);
  assert.ok(!parseProfile({ angles: [{ key: "a", label: "A", instructions: "", offsetDays: 0 }] }).ok, "an angle needs instructions");
});

test("overrides carry instructions and source but never angles", () => {
  const o = parseOverride({ instructions: "  Invite them.  ", angles: [] });
  assert.ok(o.ok);
  assert.deepEqual(o.value, { instructions: "Invite them." });
  assert.deepEqual((parseOverride({ instructions: "" }) as any).value, {}, "blank instructions mean inherit");
});

test("source refs", () => {
  assert.deepEqual(parseSourceRef(null), { ok: true, value: null });
  assert.ok(parseSourceRef({ kind: "manual", content: "Pasted text", url: "https://x.org" }).ok);
  assert.ok(!parseSourceRef({ kind: "manual" }).ok, "pasted content can't be empty");
  assert.ok(parseSourceRef({ kind: "mailchimp", id: "abc123", title: "Grace Notes" }).ok);
  assert.ok(!parseSourceRef({ kind: "mailchimp" }).ok, "a picked campaign needs its id");
});

test("the post's override wins, then the recurrence's, then the event's", () => {
  const event = { notes: "Founded 2022.", drafting: { source: { kind: "mailchimp" as const, subjectContains: "grace notes", cutoff: "followingSunday" as const }, instructions: "Event says.", angles: [] } };
  const rec = { drafting: { instructions: "Recurrence says." } };
  assert.equal(effectiveProfile(event, rec, { drafting: { instructions: "Post says." } }).instructions, "Post says.");
  const viaRec = effectiveProfile(event, rec, { drafting: {} });
  assert.equal(viaRec.instructions, "Recurrence says.");
  assert.equal(viaRec.from, "recurrence");
  assert.equal(viaRec.source.kind, "mailchimp", "source still inherited from the event");
  assert.equal(viaRec.context, "Founded 2022.");
  const own = effectiveProfile(event, null, { drafting: { source: { kind: "none" } } });
  assert.equal(own.source.kind, "none", "a post can switch its source off");
  const bare = effectiveProfile(null, null, { drafting: {} });
  assert.equal(bare.instructions, GENERIC_INSTRUCTIONS);
  assert.equal(bare.source.kind, "none");
  assert.equal(bare.from, "default");
});
