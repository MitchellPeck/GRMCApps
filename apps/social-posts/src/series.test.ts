import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import {
  getAllSeries, getSeriesPosts, createSeries,
  updateSeriesPostField, updateSeriesMeta, getActiveSeriesThursdayItem,
} from "./series";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

test("series CRUD, history seed, and thursday matcher", async () => {
  await pool.query("DELETE FROM series_posts");
  await pool.query("DELETE FROM series");

  // assert.ok(x.ok) narrows the discriminated union to the success variant.
  const seeded = await getAllSeries(pool);
  assert.ok(seeded.ok);
  assert.ok(seeded.series.some((s) => s.id === "series-history"), "history seeded");
  const histPosts = await getSeriesPosts(pool, "series-history");
  assert.ok(histPosts.ok);
  assert.equal(histPosts.posts.length, 13, "history has 13 posts");
  assert.equal(histPosts.posts[0].postIdx, 0);

  const created = await createSeries(pool, {
    name: "Test Series", description: "d", context: "c", cadence: "weekly",
    posts: [{ date: "Jun 9", phase: "P1", title: "T0", sub: "s0" }, { date: "Jun 16", phase: "", title: "T1", sub: "s1" }],
  });
  assert.ok(created.ok);
  const posts = await getSeriesPosts(pool, created.id);
  assert.ok(posts.ok);
  assert.equal(posts.posts.length, 2);
  assert.equal(posts.posts[1].title, "T1");

  await updateSeriesPostField(pool, created.id, 0, "status", "drafted");
  await updateSeriesMeta(pool, created.id, { status: "paused" });
  const after = await getSeriesPosts(pool, created.id);
  assert.ok(after.ok);
  assert.equal(after.posts[0].status, "drafted");
  const all = await getAllSeries(pool);
  assert.ok(all.ok);
  const foundSeries = all.series.find((s) => s.id === created.id);
  assert.ok(foundSeries, "created series present");
  assert.equal(foundSeries.status, "paused");

  const thu = await getActiveSeriesThursdayItem(pool, "2026-06-10");
  assert.ok(thu && thu.title.length > 0, "matcher returns a candidate from an active series");

  await pool.query("DELETE FROM series_posts");
  await pool.query("DELETE FROM series");
  await pool.end();
});
