import { strict as assert } from "node:assert";
import { test } from "node:test";
import { draftPodcastPosts } from "./runs";

test("the podcast run refuses to draft before any angle is picked", async () => {
  // No angles means no posts to ask Claude for — better to say so than to
  // spend a call and parse back an empty object. Returns before touching the
  // pool, which is why passing none here is safe.
  const res = await draftPodcastPosts(null as any, { angles: [] }, "me@test");
  assert.equal(res.ok, false);
  assert.match(res.error, /angle/i, "the message names the thing to fix");
});
