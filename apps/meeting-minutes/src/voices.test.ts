import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  applyVoiceNames, candidatesFor, evaluateMatching, learnMeetingVoices, learnedVoiceCounts, matchVoices,
  meetingVoiceMatches, personScore, recognizeMeetingVoices, recommendThreshold, runVoiceCheck, saveMeetingVoices,
  setLearnVoice, setVoiceSettings, speechRanges, voicesFromRecording, getVoiceCheck, getVoiceSettings,
  DEFAULT_THRESHOLD, LearnedVoice, Voice,
} from "./voices";
import { addPerson } from "./people";
import { addAgendaItem, createMeeting, saveReport, setAttendees, updateAgendaItem, setMeetingSpeakerMap } from "./meetings";
import { saveMeetingSpeakers } from "./actions";
import { DiarizedSegment } from "./whisper";

// A voice: one of a few fixed directions plus a little noise, so prints of
// one person are near each other and prints of different people are not.
function rng(seed: number) {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 - 0.5; };
}
const DIM = 24;
function base(person: number): Float32Array {
  const r = rng(person * 7919 + 1);
  return Float32Array.from({ length: DIM }, () => r());
}
function voiceOf(person: number, seed: number, noise = 0.15): Float32Array {
  const b = base(person);
  const r = rng(seed * 104729 + person);
  return Float32Array.from(b, (v) => v + noise * r());
}

const seg = (speaker: string, start: number, end: number): DiarizedSegment => ({ speaker, start, end, text: "x" });

// ── Pure ────────────────────────────────────────────────────────────────────

test("personScore averages a voice's best few matches with someone's prints", () => {
  const v = voiceOf(1, 1);
  const same = [voiceOf(1, 2), voiceOf(1, 3), voiceOf(1, 4)];
  const other = [voiceOf(2, 2), voiceOf(2, 3)];
  assert.ok(personScore(v, same) > 0.8);
  assert.ok(personScore(v, other) < personScore(v, same) - 0.3);
  assert.equal(personScore(v, []), -1);
});

test("matchVoices names a voice only when it is strong and clearly ahead", () => {
  const cands = [
    { personId: 1, name: "Alice", prints: [voiceOf(1, 10), voiceOf(1, 11)] },
    { personId: 2, name: "Bob", prints: [voiceOf(2, 10)] },
    { personId: 3, name: "Carol", prints: [] }, // nothing learned: never matched
  ];
  const voices = [
    { speaker: "SPEAKER_00", embedding: voiceOf(2, 20) },
    { speaker: "SPEAKER_01", embedding: voiceOf(1, 20) },
    { speaker: "SPEAKER_02", embedding: voiceOf(3, 20) }, // Carol, or a guest
  ];
  const got = matchVoices(voices, cands, 0.6);
  assert.deepEqual(got.map((m) => [m.speaker, m.name]).sort(), [["SPEAKER_00", "Bob"], ["SPEAKER_01", "Alice"]]);
  // Too high a level names no one.
  assert.deepEqual(matchVoices(voices, cands, 0.999), []);
  // Two people who sound alike to it: neither is clearly ahead, so no name.
  const twins = [
    { personId: 1, name: "Alice", prints: [voiceOf(1, 10)] },
    { personId: 9, name: "Alice's twin", prints: [voiceOf(1, 30)] },
  ];
  assert.deepEqual(matchVoices([{ speaker: "S", embedding: voiceOf(1, 31) }], twins, 0.5), []);
});

test("matchVoices gives each person to one voice, the strongest", () => {
  const cands = [{ personId: 1, name: "Alice", prints: [voiceOf(1, 1)] }];
  const got = matchVoices([
    { speaker: "A", embedding: voiceOf(1, 2, 0.4) },
    { speaker: "B", embedding: voiceOf(1, 3, 0.05) },
  ], cands, 0.3);
  assert.deepEqual(got.map((m) => m.speaker), ["B"]);
});

test("applyVoiceNames wins over the guess and takes the name off the voice it was guessed for", () => {
  assert.deepEqual(
    applyVoiceNames({ SPEAKER_00: "Alice", SPEAKER_01: "Bob" }, { SPEAKER_01: "Alice" }),
    { SPEAKER_01: "Alice" }
  );
  assert.deepEqual(applyVoiceNames({ SPEAKER_00: "Alice" }, {}), { SPEAKER_00: "Alice" });
  assert.deepEqual(applyVoiceNames({}, { SPEAKER_02: "Carol" }), { SPEAKER_02: "Carol" });
});

test("speechRanges takes a speaker's longest turns up to the cap", () => {
  const segs = [seg("A", 0, 10), seg("B", 10, 12), seg("A", 12, 52), seg("A", 60, 90)];
  assert.deepEqual(speechRanges(segs, "A", 60), [[12, 52], [60, 80]]);
  assert.deepEqual(speechRanges(segs, "C", 60), []);
});

test("evaluateMatching checks each meeting against the others, and recommends a safe level", () => {
  const learned: LearnedVoice[] = [];
  for (let m = 1; m <= 4; m++) {
    for (const p of [1, 2, 3]) learned.push({ meetingId: m, speaker: `S${p}`, personId: p, embedding: voiceOf(p, m * 10) });
  }
  // A visitor named once: no prints elsewhere, so it can only be missed or wrong.
  learned.push({ meetingId: 4, speaker: "S9", personId: 9, embedding: voiceOf(9, 99) });
  const rows = evaluateMatching(learned, new Map(), [0.5, 0.99]);
  const [low, high] = rows;
  assert.equal(low.correct, 12);
  assert.equal(low.wrong, 0);
  assert.equal(high.correct, 0);
  assert.equal(high.missed, 12); // the visitor isn't counted as missed
  // Every voice is also tried as a newcomer; these people sound nothing alike.
  assert.equal(low.newcomers, 13);
  assert.equal(low.newcomerWrong, 0);
  assert.equal(recommendThreshold(rows), 0.5);
  const row = (threshold: number, correct: number, wrong: number, newcomerWrong = 0) =>
    ({ threshold, correct, wrong, missed: 0, newcomers: 20, newcomerWrong });
  assert.equal(recommendThreshold([row(0.5, 10, 5)]), null);
  assert.equal(recommendThreshold([row(0.5, 0, 0)]), null);
  // Naming newcomers as someone else rules a level out...
  assert.equal(recommendThreshold([row(0.5, 12, 0, 6), row(0.7, 10, 0, 0)]), 0.7);
  // ...and on a tie the stricter level is recommended.
  assert.equal(recommendThreshold([row(0.5, 10, 0), row(0.6, 10, 0)]), 0.6);
});

test("evaluateMatching catches a newcomer who sounds like someone known", () => {
  const learned: LearnedVoice[] = [];
  for (let m = 1; m <= 3; m++) learned.push({ meetingId: m, speaker: "A", personId: 1, embedding: voiceOf(1, m) });
  // Person 2 sounds just like person 1 (same base, more noise).
  learned.push({ meetingId: 3, speaker: "B", personId: 2, embedding: voiceOf(1, 50, 0.3) });
  const [row] = evaluateMatching(learned, new Map(), [0.5]);
  assert.ok(row.newcomerWrong >= 1);
  assert.equal(recommendThreshold([row]), null);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("voicesFromRecording prints each voice from its own stretch of the recording", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "voices-test-"));
  try {
    // 0-10 s at 300 Hz, 10-20 s at 1200 Hz: each "voice" is one tone.
    const path = join(dir, "m.webm");
    const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=10",
      "-f", "lavfi", "-i", "sine=frequency=1200:duration=10",
      "-filter_complex", "[0][1]concat=n=2:v=0:a=1", "-c:a", "libopus", path]);
    assert.equal(r.status, 0, String(r.stderr));
    const seen: Array<{ n: number; crossings: number }> = [];
    const embed = (samples: Float32Array) => {
      let crossings = 0;
      for (let i = 1; i < samples.length; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
      seen.push({ n: samples.length, crossings });
      return Float32Array.from([samples.length]);
    };
    const voices = await voicesFromRecording(path, [seg("LOW", 1, 9), seg("HIGH", 11, 19), seg("TINY", 9.2, 9.6)], embed);
    assert.deepEqual(voices.map((v) => v.speaker), ["LOW", "HIGH"]); // TINY is too short to print
    assert.deepEqual(voices.map((v) => v.seconds), [8, 8]);
    // 8 s each, read from the right place: 300 Hz crosses zero ~600 times a
    // second, 1200 Hz ~2400.
    assert.ok(Math.abs(seen[0].n - 8 * 16000) < 50);
    assert.ok(Math.abs(seen[0].crossings / 8 - 600) < 30, String(seen[0].crossings));
    assert.ok(Math.abs(seen[1].crossings / 8 - 2400) < 60, String(seen[1].crossings));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Database ────────────────────────────────────────────────────────────────

const url = process.env.TEST_DATABASE_URL;

async function reset(pool: Pool) {
  await pool.query("DELETE FROM meetings");
  await pool.query("DELETE FROM people");
  await pool.query("DELETE FROM settings WHERE key LIKE 'voice_%'");
}

async function meeting(pool: Pool, title: string, attendees: number[]): Promise<number> {
  const m = await createMeeting(pool, { title, meetingDate: "", location: "", description: "", email: "", name: "" });
  assert.ok(m.ok);
  const id = (m as { id: number }).id;
  await setAttendees(pool, id, attendees);
  return id;
}

const V = (speaker: string, person: number, seed: number, seconds = 60): Voice => ({ speaker, embedding: voiceOf(person, seed), seconds });

test("voices are learned from names, moved on a rename, and never from guests or short voices", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    await reset(pool);
    const alice = (await addPerson(pool, "Alice", "", "Chair")) as { id: number };
    const bob = (await addPerson(pool, "Bob", "", "")) as { id: number };
    const m1 = await meeting(pool, "One", [alice.id, bob.id]);
    await saveMeetingVoices(pool, m1, [V("SPEAKER_00", 1, 1), V("SPEAKER_01", 2, 1), V("SPEAKER_02", 3, 1, 3), V("SPEAKER_03", 4, 1)], []);

    const n = await learnMeetingVoices(pool, m1, {
      SPEAKER_00: "Alice (Chair)", SPEAKER_01: "Bob", SPEAKER_02: "Alice", SPEAKER_03: "Visiting Speaker",
    });
    assert.equal(n, 2);
    const owners = async () => Object.fromEntries((await pool.query(
      "SELECT speaker, person_id FROM meeting_voices WHERE meeting_id = $1 ORDER BY speaker", [m1])).rows
      .map((r) => [r.speaker, r.person_id === null ? null : Number(r.person_id)]));
    assert.deepEqual(await owners(), { SPEAKER_00: alice.id, SPEAKER_01: bob.id, SPEAKER_02: null, SPEAKER_03: null });

    // Only the voices named are touched; a rename moves the print.
    await learnMeetingVoices(pool, m1, { SPEAKER_00: "Bob", SPEAKER_01: "" }, ["SPEAKER_00"]);
    assert.deepEqual(await owners(), { SPEAKER_00: bob.id, SPEAKER_01: bob.id, SPEAKER_02: null, SPEAKER_03: null });
    assert.deepEqual([...(await learnedVoiceCounts(pool))], [[bob.id, 1]]);

    // Forgetting someone clears their prints, and they are not learned again.
    await setLearnVoice(pool, bob.id, false);
    await learnMeetingVoices(pool, m1, { SPEAKER_00: "Bob", SPEAKER_01: "Bob" });
    assert.deepEqual(await owners(), { SPEAKER_00: null, SPEAKER_01: null, SPEAKER_02: null, SPEAKER_03: null });
  } finally {
    await reset(pool);
    await pool.end();
  }
});

test("a new meeting's voices are matched to those present, suggested or named by mode", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    await reset(pool);
    const alice = (await addPerson(pool, "Alice", "", "")) as { id: number };
    const bob = (await addPerson(pool, "Bob", "", "")) as { id: number };
    const carol = (await addPerson(pool, "Carol", "", "")) as { id: number };
    // Two earlier meetings teach all three voices.
    for (const seedM of [1, 2]) {
      const m = await meeting(pool, `Earlier ${seedM}`, [alice.id, bob.id, carol.id]);
      await saveMeetingVoices(pool, m, [V("A", 1, seedM), V("B", 2, seedM), V("C", 3, seedM)], []);
      await learnMeetingVoices(pool, m, { A: "Alice", B: "Bob", C: "Carol" });
    }
    // Carol isn't at this one, so she is not a candidate even though she spoke.
    const now = await meeting(pool, "Now", [alice.id, bob.id]);
    const cands = await candidatesFor(pool, now);
    assert.deepEqual(cands.map((c) => c.name).sort(), ["Alice", "Bob"]);
    assert.equal(cands[0].prints.length, 2);

    const voices = [V("SPEAKER_00", 2, 9), V("SPEAKER_01", 1, 9)];
    assert.equal((await getVoiceSettings(pool)).mode, "suggest");
    const suggested = await recognizeMeetingVoices(pool, now, voices);
    assert.deepEqual(suggested.apply, {});
    assert.deepEqual((await meetingVoiceMatches(pool, now)).map((m) => [m.speaker, m.name]), [["SPEAKER_00", "Bob"], ["SPEAKER_01", "Alice"]]);

    assert.equal(await setVoiceSettings(pool, { mode: "auto" }), null);
    const auto = await recognizeMeetingVoices(pool, now, voices);
    assert.deepEqual(auto.apply, { SPEAKER_00: "Bob", SPEAKER_01: "Alice" });

    // A meeting's own prints never count as "learned elsewhere".
    await learnMeetingVoices(pool, now, auto.apply);
    assert.equal((await candidatesFor(pool, now)).find((c) => c.name === "Alice")!.prints.length, 2);

    assert.match(String(await setVoiceSettings(pool, { mode: "always" })), /Unknown/);
    assert.match(String(await setVoiceSettings(pool, { threshold: 2 })), /between/);
    assert.equal((await getVoiceSettings(pool)).threshold, DEFAULT_THRESHOLD);
  } finally {
    await reset(pool);
    await pool.end();
  }
});

test("naming a speaker on the page teaches only that voice", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    await reset(pool);
    const alice = (await addPerson(pool, "Alice", "", "")) as { id: number };
    const bob = (await addPerson(pool, "Bob", "", "")) as { id: number };
    const m = await meeting(pool, "Board", [alice.id, bob.id]);
    const item = await addAgendaItem(pool, m, "Opening", "");
    assert.ok(item.ok);
    await updateAgendaItem(pool, (item as { id: number }).id, {
      transcriptSegments: [seg("SPEAKER_00", 0, 30), seg("SPEAKER_01", 30, 60)], transcriptSource: "meeting",
    });
    await saveMeetingVoices(pool, m, [V("SPEAKER_00", 1, 1), V("SPEAKER_01", 2, 1)], []);
    // The automatic guess is on the map but nobody chose it: not learned.
    await setMeetingSpeakerMap(pool, m, { SPEAKER_00: "Alice" });
    // With minutes, a rename corrects them in place (no summaries to queue,
    // which would reach for the production database).
    await saveReport(pool, m, "# Minutes");
    await saveMeetingSpeakers(pool, m, { SPEAKER_00: "Alice", SPEAKER_01: "Bob" });
    const rows = (await pool.query("SELECT speaker, person_id FROM meeting_voices WHERE meeting_id = $1 ORDER BY speaker", [m])).rows;
    assert.deepEqual(rows.map((r) => r.person_id === null ? null : Number(r.person_id)), [null, bob.id]);
    // Off means off: nothing is learned.
    await setVoiceSettings(pool, { mode: "off" });
    await saveMeetingSpeakers(pool, m, { SPEAKER_00: "Bob", SPEAKER_01: "Bob" });
    const after = (await pool.query("SELECT person_id FROM meeting_voices WHERE meeting_id = $1 AND speaker = 'SPEAKER_00'", [m])).rows[0];
    assert.equal(after.person_id, null);
  } finally {
    await reset(pool);
    await pool.end();
  }
});

test("the check against past meetings learns from minuted meetings and scores matching", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    await reset(pool);
    const alice = (await addPerson(pool, "Alice", "", "")) as { id: number };
    const bob = (await addPerson(pool, "Bob", "", "")) as { id: number };
    const decoded: string[] = [];
    const ids: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const m = await meeting(pool, `M${i}`, [alice.id, bob.id]);
      ids.push(m);
      const rec = await pool.query(
        "INSERT INTO meeting_recordings (meeting_id, mime_type, storage_path) VALUES ($1, 'audio/webm', $2) RETURNING id",
        [m, `/data/m${i}.webm`]
      );
      const item = (await addAgendaItem(pool, m, "Talk", "")) as { id: number };
      await updateAgendaItem(pool, item.id, {
        transcriptSegments: [seg("SPEAKER_00", 0, 30), seg("SPEAKER_01", 30, 60)],
        transcriptRecordingId: Number(rec.rows[0].id), transcriptSource: "meeting",
      });
      await setMeetingSpeakerMap(pool, m, { SPEAKER_00: "Alice", SPEAKER_01: "Bob" });
      if (i < 3) await saveReport(pool, m, "# Minutes"); // the third has no minutes yet
    }
    const result = await runVoiceCheck(pool, {
      voicesFor: async (path, segments) => {
        decoded.push(path);
        const n = Number(path.match(/m(\d)/)![1]);
        assert.equal(segments.length, 2);
        return [V("SPEAKER_00", 1, n), V("SPEAKER_01", 2, n)];
      },
      log: () => {},
    });
    assert.deepEqual(decoded, ["/data/m1.webm", "/data/m2.webm"]);
    assert.equal(result.status, "done");
    assert.equal(result.meetings, 2);
    assert.equal(result.voices, 4);
    assert.equal(result.people, 2);
    const at = result.rows!.find((r) => r.threshold === 0.5)!;
    assert.deepEqual([at.correct, at.wrong], [4, 0]);
    assert.ok(result.recommended !== null);
    assert.equal((await getVoiceCheck(pool)).status, "done");

    // Run again: meetings already printed aren't decoded again.
    decoded.length = 0;
    await runVoiceCheck(pool, { voicesFor: async () => { decoded.push("x"); return []; }, log: () => {} });
    assert.deepEqual(decoded, []);
  } finally {
    await reset(pool);
    await pool.end();
  }
});
