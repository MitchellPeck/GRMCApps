import { strict as assert } from "node:assert";
import { test, before, after, beforeEach } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { setSetting } from "./settings";
import { captionsToText, getCaptions, pickTrack, videoOf } from "./youtube";
import { parseSource, parseSourceRef } from "./pipeline/drafting";
import { buildDraftPrompt } from "./pipeline/prompt";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const KEYS = ["youtube_client_id", "youtube_client_secret", "youtube_refresh_token"];
const realFetch = globalThis.fetch;

before(async () => { await pool.query(SCHEMA_SQL); });
beforeEach(async () => {
  await pool.query("TRUNCATE youtube_captions");
  for (const k of KEYS) await setSetting(pool, k, "x");
});
after(async () => {
  globalThis.fetch = realFetch;
  await pool.query("TRUNCATE youtube_captions");
  await pool.query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
  await pool.end();
});

test("captionsToText drops timings and tags and rolling repeats", () => {
  const vtt = "WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.000 --> 00:00:02.000 align:start position:0%\n"
    + "good<00:00:00.500><c> morning</c> church\n\n00:00:02.000 --> 00:00:04.000\ngood morning church\n\n"
    + "00:00:04.000 --> 00:00:06.000\n>> [Music]\n\n3\n00:00:06.000 --> 00:00:08.000\nGod&#39;s grace &amp; peace\n";
  assert.equal(captionsToText(vtt), "good morning church God's grace & peace");
});

test("pickTrack prefers human English captions, then automatic English", () => {
  const t = (id: string, trackKind: string, language: string) => ({ id, snippet: { trackKind, language } });
  assert.equal(pickTrack([t("a", "asr", "en"), t("b", "standard", "en-US"), t("c", "standard", "es")])!.id, "b");
  assert.equal(pickTrack([t("c", "standard", "es"), t("a", "asr", "en")])!.id, "a");
  assert.equal(pickTrack([]), null);
});

test("videoOf labels streams and uploads", () => {
  const v = videoOf({ id: "abc123XYZ", snippet: { title: "Sunday Worship", liveBroadcastContent: "none" },
    liveStreamingDetails: { actualStartTime: "2026-11-22T15:00:00Z" } }, "America/New_York");
  assert.equal(v.url, "https://www.youtube.com/watch?v=abc123XYZ");
  assert.equal(v.wasLive, true);
  assert.match(v.dateLine, /^streamed /);
  assert.equal(videoOf({ id: "x", snippet: { title: "t", liveBroadcastContent: "upcoming" } }, "UTC").live, "upcoming");
});

test("youtube is a source kind and a source ref", () => {
  assert.deepEqual((parseSource({ kind: "youtube" }) as any).value, { kind: "youtube" });
  assert.equal((parseSourceRef({ kind: "youtube", id: "abc123XYZ" }) as any).value.id, "abc123XYZ");
});

test("prompt carries the captions and flags automatic ones", () => {
  const { user } = buildDraftPrompt({
    voice: "", context: "", instructions: "", eventName: "", eventKind: "", eventDates: "", title: "t", brief: "", phase: "",
    publishDate: null, seriesPosition: null, platforms: ["facebook"], captionMode: "same", caption: "", captions: {},
    source: { kind: "youtube", id: "v", title: "Sunday Worship", url: "https://youtu.be/v", date: "", dateLine: "streamed Nov 22", content: "Grace upon grace", trackKind: "asr" },
  });
  assert.match(user, /VIDEO CAPTIONS:\nGrace upon grace/);
  assert.match(user, /automatic captions/);
});

test("getCaptions downloads once, then serves from the database", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (String(url).startsWith("https://oauth2")) return json({ access_token: "tok", expires_in: 3600 });
    if (String(url).includes("/captions?")) return json({ items: [{ id: "trk", snippet: { trackKind: "asr", language: "en" } }] });
    if (String(url).includes("/captions/trk")) return new Response("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello church\n", { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const a = await getCaptions(pool, "vid1");
  assert.equal(a.text, "Hello church");
  assert.equal(a.trackKind, "asr");
  const n = calls.length;
  assert.equal((await getCaptions(pool, "vid1")).text, "Hello church");
  assert.equal(calls.length, n); // no second download
  await getCaptions(pool, "vid1", true);
  assert.ok(calls.length > n);
});

test("getCaptions says when YouTube has none yet", async () => {
  globalThis.fetch = (async (url: string) => new Response(JSON.stringify(
    String(url).startsWith("https://oauth2") ? { access_token: "tok", expires_in: 3600 } : { items: [] }), { status: 200 })) as typeof fetch;
  await assert.rejects(getCaptions(pool, "vid2"), /no captions for this video yet/);
});
