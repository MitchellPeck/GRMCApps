// The walkthrough's practice meeting: made per person, seen only by them, its
// practice people kept out of the shared list. Route-level, against the test
// database, like lockRoutes.test.ts.
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { config } from "./config";

const url = process.env.TEST_DATABASE_URL;
if (url) config.databaseUrl = url;

let app: any = null, pool: any = null;
async function setup() {
  if (app) return;
  ({ pool } = await import("./db"));
  const Fastify = (await import("fastify")).default;
  app = Fastify();
  await app.register((await import("@fastify/multipart")).default);
  await app.register((await import("./routes/meetings")).meetingsRoutes);
  await app.register((await import("./routes/people")).peopleRoutes);
  await app.register((await import("./routes/practice")).practiceRoutes);
}
after(async () => { if (app) await app.close(); if (pool) await pool.end(); });

const as = (email: string, name: string) => ({ "x-auth-email": email, "x-auth-name": name });
const A = as("ann@x", "Ann"), B = as("bob@x", "Bob");
const json = (r: any) => JSON.parse(r.body);
async function reset() {
  await pool.query("DELETE FROM meetings");
  await pool.query("DELETE FROM people");
}

test("making the practice meeting twice leaves exactly one, fully seeded", { skip: !url }, async () => {
  await setup(); await reset();
  const first = json(await app.inject({ method: "POST", url: "/api/practice", headers: A }));
  const second = json(await app.inject({ method: "POST", url: "/api/practice", headers: A }));
  assert.ok(first.ok && second.ok);
  assert.notEqual(first.meetingId, second.meetingId, "a reset is a fresh meeting");
  const n = await pool.query("SELECT count(*)::int AS n FROM meetings WHERE is_demo AND created_by_email = 'ann@x'");
  assert.equal(n.rows[0].n, 1);
  const people = await pool.query("SELECT count(*)::int AS n FROM people WHERE is_demo");
  assert.equal(people.rows[0].n, 4, "the first set of practice people went with the reset");
  const det = json(await app.inject({ method: "GET", url: `/api/meetings/${second.meetingId}`, headers: A }));
  assert.equal(det.items.length, 3);
  assert.equal(det.attendeeIds.length, 4);
  assert.match(det.items[1].summary, /ahead of budget/);
  assert.equal(det.items[1].action_items.length, 2);
  assert.equal(det.items[2].transcript, "", "the third topic is left for the user to record");
  assert.equal(det.meetingSpeakerStats.length, 3, "the seeded voices show in Voices");
  assert.equal(det.meeting.speaker_map.SPEAKER_11, "Marian Webb");
  const resumed = json(await app.inject({ method: "GET", url: "/api/practice", headers: A }));
  assert.equal(resumed.meetingId, second.meetingId);
});

test("someone else's practice meeting is invisible", { skip: !url }, async () => {
  await setup(); await reset();
  const { meetingId } = json(await app.inject({ method: "POST", url: "/api/practice", headers: A }));
  await pool.query("INSERT INTO meetings (title) VALUES ('Real meeting')");
  const mine = json(await app.inject({ method: "GET", url: "/api/meetings", headers: A }));
  const theirs = json(await app.inject({ method: "GET", url: "/api/meetings", headers: B }));
  assert.equal(mine.meetings.length, 2);
  assert.deepEqual(theirs.meetings.map((m: any) => m.title), ["Real meeting"]);
  const peek = await app.inject({ method: "GET", url: `/api/meetings/${meetingId}`, headers: B });
  assert.equal(peek.statusCode, 404);
  assert.equal(json(await app.inject({ method: "GET", url: "/api/practice", headers: B })).meetingId, null);
});

test("practice people appear only inside their own practice meeting", { skip: !url }, async () => {
  await setup(); await reset();
  await pool.query("INSERT INTO people (name) VALUES ('Real Person')");
  const { meetingId } = json(await app.inject({ method: "POST", url: "/api/practice", headers: A }));
  const names = async (u: string, h: any) => json(await app.inject({ method: "GET", url: u, headers: h })).people.map((p: any) => p.name);
  assert.deepEqual(await names("/api/people?all=1", A), ["Real Person"]);
  const inside = await names(`/api/people?all=1&meetingId=${meetingId}`, A);
  assert.equal(inside.length, 5);
  assert.ok(inside.includes("Marian Webb"));
  assert.deepEqual(await names(`/api/people?all=1&meetingId=${meetingId}`, B), ["Real Person"], "not to anyone else");
});

test("deleting the practice meeting takes its practice people too, and only the owner's", { skip: !url }, async () => {
  await setup(); await reset();
  await app.inject({ method: "POST", url: "/api/practice", headers: A });
  await app.inject({ method: "POST", url: "/api/practice", headers: B });
  const del = json(await app.inject({ method: "DELETE", url: "/api/practice", headers: A }));
  assert.ok(del.ok);
  const left = await pool.query("SELECT created_by_email FROM meetings WHERE is_demo");
  assert.deepEqual(left.rows.map((r: any) => r.created_by_email), ["bob@x"]);
  const people = await pool.query("SELECT count(*)::int AS n FROM people WHERE is_demo");
  assert.equal(people.rows[0].n, 4, "Bob's practice people are untouched");
});

test("saving a processed recording's names keeps names for voices it didn't hear", { skip: !url }, async () => {
  await setup(); await reset();
  const { setMeetingSpeakerMap } = await import("./meetings");
  const id = Number((await pool.query(
    `INSERT INTO meetings (title, speaker_map) VALUES ('M', '{"SPEAKER_10":"Dale","SPEAKER_00":"Old"}') RETURNING id`)).rows[0].id);
  await setMeetingSpeakerMap(pool, id, { SPEAKER_00: "New", SPEAKER_01: "Ann" });
  const m = (await pool.query("SELECT speaker_map FROM meetings WHERE id = $1", [id])).rows[0].speaker_map;
  assert.deepEqual(m, { SPEAKER_10: "Dale", SPEAKER_00: "New", SPEAKER_01: "Ann" });
});

test("a practice meeting never teaches anyone's voice", { skip: !url }, async () => {
  await setup(); await reset();
  const { learnMeetingVoices } = await import("./voices");
  const { meetingId } = json(await app.inject({ method: "POST", url: "/api/practice", headers: A }));
  await pool.query("INSERT INTO meeting_voices (meeting_id, speaker, embedding, seconds) VALUES ($1, 'SPEAKER_00', '{0.1,0.2}', 60)", [meetingId]);
  assert.equal(await learnMeetingVoices(pool, meetingId, { SPEAKER_00: "Marian Webb" }), 0);
  const v = await pool.query("SELECT person_id FROM meeting_voices WHERE meeting_id = $1", [meetingId]);
  assert.equal(v.rows[0].person_id, null);
});
