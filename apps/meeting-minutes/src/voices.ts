import { Pool } from "pg";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiarizedSegment } from "./whisper";
import { SpeakerMap } from "./transcript";
import { cosine, MAX_EMBED_SECONDS, MIN_EMBED_SECONDS } from "./speakerLinking";
import { runFfmpeg } from "./chunking";
import { getSetting, setSetting } from "./settings";

// ── Recognising voices across meetings ──────────────────────────────────────
// Every voice in a processed whole-meeting recording gets a voice print (a
// speaker embedding of up to a minute of its audio), kept in meeting_voices.
// A print becomes a person's once a person names that voice, or once minutes
// are generated with it named (someone had the chance to correct it). Never
// from an automatic guess alone, so a wrong guess is not learned and repeated.
// Later meetings compare each voice with the learned prints of the people
// present: a strong, unambiguous match is offered as a suggestion, or applied
// outright in "auto" mode.

export type VoiceMode = "off" | "suggest" | "auto";
export const VOICE_MODES: VoiceMode[] = ["off", "suggest", "auto"];
export const DEFAULT_VOICE_MODE: VoiceMode = "suggest";
// Similarity a voice must reach with a person's prints to be called theirs.
// Kept high by default: a voice that has never been learned (a guest, someone
// new) still lands nearest to *somebody*, and in testing it scored up to ~0.67
// against people it wasn't. The "check against past meetings" run measures
// both kinds of mistake on this church's own recordings and recommends a level.
export const DEFAULT_THRESHOLD = 0.7;
// And how far clear of the next-best person it must be.
export const MATCH_MARGIN = 0.08;
// Voices with less talk than this are not learned from: too little audio for
// a print that will hold up in another meeting.
export const MIN_LEARN_SECONDS = 8;
// The most recent prints per person compared against. Older ones age out, so
// a voice that changes (a new microphone, a new room) is followed.
export const PRINTS_PER_PERSON = 10;
// A voice's score against a person is the mean of its best matches with
// that person's prints: one fluke print neither makes nor breaks it.
const TOP_PRINTS = 3;

export interface Voice { speaker: string; embedding: Float32Array; seconds: number }
export interface Candidate { personId: number; name: string; prints: ArrayLike<number>[] }
export interface VoiceMatch { speaker: string; personId: number; name: string; score: number }

export function personScore(embedding: ArrayLike<number>, prints: ArrayLike<number>[]): number {
  if (!prints.length) return -1;
  const sims = prints.map((p) => cosine(embedding, p)).sort((a, b) => b - a).slice(0, TOP_PRINTS);
  return sims.reduce((s, x) => s + x, 0) / sims.length;
}

// Each voice to at most one person and each person to at most one voice,
// strongest pairs first. A voice is matched only when its best person reaches
// the threshold and is clearly ahead of its second-best.
export function matchVoices(
  voices: Array<{ speaker: string; embedding: ArrayLike<number> }>,
  candidates: Candidate[],
  threshold: number,
  margin: number = MATCH_MARGIN
): VoiceMatch[] {
  const people = candidates.filter((c) => c.prints.length);
  const eligible: VoiceMatch[] = [];
  for (const v of voices) {
    const scored = people
      .map((c) => ({ c, score: personScore(v.embedding, c.prints) }))
      .sort((a, b) => b.score - a.score);
    if (!scored.length) continue;
    const [best, second] = scored;
    if (best.score < threshold) continue;
    if (second && best.score - second.score < margin) continue;
    eligible.push({ speaker: v.speaker, personId: best.c.personId, name: best.c.name, score: best.score });
  }
  eligible.sort((a, b) => b.score - a.score);
  const usedPeople = new Set<number>();
  const out: VoiceMatch[] = [];
  for (const m of eligible) {
    if (usedPeople.has(m.personId)) continue;
    usedPeople.add(m.personId);
    out.push(m);
  }
  return out;
}

// Names recognised by voice win over names guessed from the words. A name the
// voice match gives one speaker is taken off any other speaker it was guessed for.
export function applyVoiceNames(map: SpeakerMap, byVoice: SpeakerMap): SpeakerMap {
  const out: SpeakerMap = { ...map };
  for (const [speaker, name] of Object.entries(byVoice)) {
    const key = name.trim().toLowerCase();
    for (const other of Object.keys(out)) {
      if (other !== speaker && out[other].trim().toLowerCase() === key) delete out[other];
    }
    out[speaker] = name;
  }
  return out;
}

// The longest turns of one speaker, up to MAX_EMBED_SECONDS in all, as
// [start, end] seconds on the recording's timeline.
export function speechRanges(segments: DiarizedSegment[], speaker: string, maxSeconds = MAX_EMBED_SECONDS): Array<[number, number]> {
  const turns = segments
    .filter((s) => s.speaker === speaker && s.end > s.start)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const out: Array<[number, number]> = [];
  let total = 0;
  for (const t of turns) {
    if (total >= maxSeconds) break;
    const len = Math.min(t.end - t.start, maxSeconds - total);
    out.push([t.start, t.start + len]);
    total += len;
  }
  return out;
}

export function talkSeconds(segments: DiarizedSegment[], speaker: string): number {
  return segments.reduce((s, x) => s + (x.speaker === speaker ? Math.max(0, x.end - x.start) : 0), 0);
}

const RATE = 16000;

// A print of every voice in a recording. The audio is decoded once to raw
// 16 kHz PCM in a temp directory, and only each voice's chosen turns are read
// back, so a long meeting never sits in memory. `path` is read, never written.
export async function voicesFromRecording(
  path: string,
  segments: DiarizedSegment[],
  embed: (samples: Float32Array, sampleRate: number) => Float32Array
): Promise<Voice[]> {
  const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
  if (!speakers.length) return [];
  const dir = await mkdtemp(join(tmpdir(), "minutes-voices-"));
  try {
    const raw = join(dir, "audio.raw");
    await runFfmpeg(["-i", path, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-c:a", "pcm_s16le", raw]);
    const fh = await open(raw, "r");
    try {
      const size = (await fh.stat()).size;
      const out: Voice[] = [];
      for (const speaker of speakers) {
        const pieces: Float32Array[] = [];
        let total = 0;
        for (const [start, end] of speechRanges(segments, speaker)) {
          const from = Math.max(0, Math.floor(start * RATE)) * 2;
          const to = Math.min(size, Math.ceil(end * RATE) * 2);
          if (to <= from) continue;
          const buf = Buffer.alloc(to - from);
          const { bytesRead } = await fh.read(buf, 0, buf.length, from);
          const n = Math.floor(bytesRead / 2);
          const piece = new Float32Array(n);
          for (let i = 0; i < n; i++) piece[i] = buf.readInt16LE(i * 2) / 32768;
          pieces.push(piece);
          total += n;
        }
        if (total < MIN_EMBED_SECONDS * RATE) continue;
        const samples = new Float32Array(total);
        let at = 0;
        for (const p of pieces) { samples.set(p, at); at += p.length; }
        out.push({ speaker, embedding: embed(samples, RATE), seconds: talkSeconds(segments, speaker) });
      }
      return out;
    } finally {
      await fh.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

export interface VoiceSettings { mode: VoiceMode; threshold: number }

export async function getVoiceSettings(pool: Pool): Promise<VoiceSettings> {
  const mode = (await getSetting(pool, "voice_mode")) as VoiceMode;
  const threshold = Number(await getSetting(pool, "voice_threshold"));
  return {
    mode: VOICE_MODES.includes(mode) ? mode : DEFAULT_VOICE_MODE,
    threshold: Number.isFinite(threshold) && threshold > 0 && threshold < 1 ? threshold : DEFAULT_THRESHOLD,
  };
}

export async function setVoiceSettings(pool: Pool, s: { mode?: unknown; threshold?: unknown }): Promise<string | null> {
  if (s.mode !== undefined) {
    if (!VOICE_MODES.includes(s.mode as VoiceMode)) return "Unknown voice recognition mode.";
    await setSetting(pool, "voice_mode", String(s.mode));
  }
  if (s.threshold !== undefined) {
    const t = Number(s.threshold);
    if (!Number.isFinite(t) || t <= 0 || t >= 1) return "The match level must be between 0 and 1.";
    await setSetting(pool, "voice_threshold", String(t));
  }
  return null;
}

// ── Storage ─────────────────────────────────────────────────────────────────

const toArray = (e: ArrayLike<number>) => Array.from(e);

// Replace a meeting's voices after it is processed (again). Labels from an
// earlier run mean nothing now, so what was learned from them goes too; it is
// learned again as the new voices are named.
export async function saveMeetingVoices(pool: Pool, meetingId: number, voices: Voice[], matches: VoiceMatch[]): Promise<void> {
  const bySpeaker = new Map(matches.map((m) => [m.speaker, m]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM meeting_voices WHERE meeting_id = $1", [meetingId]);
    for (const v of voices) {
      const m = bySpeaker.get(v.speaker);
      await client.query(
        `INSERT INTO meeting_voices (meeting_id, speaker, embedding, seconds, match_person_id, match_score)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [meetingId, v.speaker, toArray(v.embedding), v.seconds, m ? m.personId : null, m ? m.score : null]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

interface PersonRow { id: number; name: string; learn_voice: boolean }

// The person a speaker-map name means: someone present at the meeting first,
// otherwise the only library person with that name. Guests, and names two
// library people share, are no one, so nothing is learned from them.
function resolvePerson(name: string, present: PersonRow[], everyone: PersonRow[]): PersonRow | null {
  const key = name.replace(/\s*\([^()]*\)\s*$/, "").trim().toLowerCase();
  if (!key) return null;
  const here = present.filter((p) => p.name.trim().toLowerCase() === key);
  if (here.length === 1) return here[0];
  const all = everyone.filter((p) => p.name.trim().toLowerCase() === key);
  return all.length === 1 ? all[0] : null;
}

// Record whose voice each of a meeting's voices is, from its speaker map.
// `speakers` limits it to the voices just named; omitted, every voice is
// brought in line with the map (when minutes are generated). A voice named no
// one, a guest, or someone not learning stops being anyone's print.
export async function learnMeetingVoices(pool: Pool, meetingId: number, map: SpeakerMap, speakers?: string[]): Promise<number> {
  // A practice meeting teaches nobody's voice: its names are made up.
  const demo = await pool.query("SELECT is_demo FROM meetings WHERE id = $1", [meetingId]);
  if (demo.rows[0]?.is_demo) return 0;
  const everyone: PersonRow[] = (await pool.query("SELECT id, name, learn_voice FROM people")).rows
    .map((r) => ({ id: Number(r.id), name: r.name, learn_voice: r.learn_voice }));
  const presentIds = new Set((await pool.query("SELECT person_id FROM meeting_attendees WHERE meeting_id = $1", [meetingId])).rows
    .map((r) => Number(r.person_id)));
  const present = everyone.filter((p) => presentIds.has(p.id));
  const rows = (await pool.query("SELECT speaker, seconds, person_id FROM meeting_voices WHERE meeting_id = $1", [meetingId])).rows;
  let learned = 0;
  for (const row of rows) {
    if (speakers && !speakers.includes(row.speaker)) continue;
    const p = resolvePerson(map[row.speaker] ?? "", present, everyone);
    const personId = p && p.learn_voice && Number(row.seconds) >= MIN_LEARN_SECONDS ? p.id : null;
    if (personId !== null) learned++;
    const current = row.person_id === null ? null : Number(row.person_id);
    if (current === personId) continue;
    await pool.query(
      "UPDATE meeting_voices SET person_id = $3, learned_at = CASE WHEN $3::bigint IS NULL THEN NULL ELSE now() END WHERE meeting_id = $1 AND speaker = $2",
      [meetingId, row.speaker, personId]
    );
  }
  return learned;
}

// The people a meeting's voices are compared with, each with their latest
// learned prints from other meetings: those marked present, or, when no one
// is marked present, everyone active.
export async function candidatesFor(pool: Pool, meetingId: number): Promise<Candidate[]> {
  const attendees = (await pool.query("SELECT person_id FROM meeting_attendees WHERE meeting_id = $1", [meetingId])).rows
    .map((r) => Number(r.person_id));
  const r = await pool.query(
    `SELECT p.id, p.name, v.embedding
       FROM people p
       JOIN LATERAL (
         SELECT embedding FROM meeting_voices
          WHERE person_id = p.id AND meeting_id <> $1
          ORDER BY learned_at DESC NULLS LAST LIMIT $2
       ) v ON true
      WHERE p.learn_voice AND (CASE WHEN cardinality($3::bigint[]) > 0 THEN p.id = ANY($3::bigint[]) ELSE p.active END)`,
    [meetingId, PRINTS_PER_PERSON, attendees]
  );
  const by = new Map<number, Candidate>();
  for (const row of r.rows) {
    const id = Number(row.id);
    if (!by.has(id)) by.set(id, { personId: id, name: row.name, prints: [] });
    by.get(id)!.prints.push(row.embedding as number[]);
  }
  return [...by.values()];
}

// Print, match and store a freshly processed meeting's voices. Returns the
// names to put on the transcript: the matches in "auto" mode, none otherwise
// (they are offered on the page instead).
export async function recognizeMeetingVoices(pool: Pool, meetingId: number, voices: Voice[]): Promise<{ matches: VoiceMatch[]; apply: SpeakerMap }> {
  const s = await getVoiceSettings(pool);
  const matches = matchVoices(voices, await candidatesFor(pool, meetingId), s.threshold);
  await saveMeetingVoices(pool, meetingId, voices, matches);
  const apply: SpeakerMap = {};
  if (s.mode === "auto") for (const m of matches) apply[m.speaker] = m.name;
  return { matches, apply };
}

export interface VoiceMatchView { speaker: string; personId: number; name: string; score: number }

// What each of a meeting's voices was recognised as, for its page.
export async function meetingVoiceMatches(pool: Pool, meetingId: number): Promise<VoiceMatchView[]> {
  const r = await pool.query(
    `SELECT v.speaker, v.match_score, p.id, p.name FROM meeting_voices v
       JOIN people p ON p.id = v.match_person_id
      WHERE v.meeting_id = $1 AND p.learn_voice ORDER BY v.speaker`,
    [meetingId]
  );
  return r.rows.map((row) => ({ speaker: row.speaker, personId: Number(row.id), name: row.name, score: Number(row.match_score) }));
}

// How many meetings each person's voice has been learned from.
export async function learnedVoiceCounts(pool: Pool): Promise<Map<number, number>> {
  const r = await pool.query(
    "SELECT person_id, count(DISTINCT meeting_id) AS n FROM meeting_voices WHERE person_id IS NOT NULL GROUP BY person_id"
  );
  return new Map(r.rows.map((row) => [Number(row.person_id), Number(row.n)]));
}

// Turning learning off for someone forgets their voice: their prints and any
// match to them go.
export async function setLearnVoice(pool: Pool, personId: number, on: boolean): Promise<void> {
  await pool.query("UPDATE people SET learn_voice = $2 WHERE id = $1", [personId, on]);
  if (!on) {
    await pool.query("UPDATE meeting_voices SET person_id = NULL, learned_at = NULL WHERE person_id = $1", [personId]);
    await pool.query("UPDATE meeting_voices SET match_person_id = NULL, match_score = NULL WHERE match_person_id = $1", [personId]);
  }
}

// ── Checking against past meetings ──────────────────────────────────────────

export interface LearnedVoice { meetingId: number; speaker: string; personId: number; embedding: ArrayLike<number> }
// Per level: voices named rightly, named wrongly, and left unnamed; and, of
// `newcomers` voices tried as if their person had never been learned, how
// many were wrongly given someone else's name.
export interface CheckRow { threshold: number; correct: number; wrong: number; missed: number; newcomers: number; newcomerWrong: number }

export const CHECK_THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85];
// The most wrong names, as a share of names given, a recommended level allows.
export const MAX_WRONG_SHARE = 0.03;
// And the most newcomers it may name as someone else.
export const MAX_NEWCOMER_SHARE = 0.05;

// Leave-one-meeting-out: each meeting's named voices are matched against the
// prints learned from every other meeting, as if it were the newest, and the
// result is compared with the names people gave. A voice whose person has no
// prints elsewhere can only be left unnamed or named wrongly. Each voice is
// also tried as a newcomer, with its own person's prints taken away: any name
// it gets then is wrong. Without that, the check would only ever see people it
// already knows and would recommend levels that misname every guest.
export function evaluateMatching(
  learned: LearnedVoice[],
  attendeesByMeeting: Map<number, number[]>,
  thresholds: number[] = CHECK_THRESHOLDS
): CheckRow[] {
  const meetings = [...new Set(learned.map((l) => l.meetingId))];
  const rows: CheckRow[] = thresholds.map((threshold) => ({ threshold, correct: 0, wrong: 0, missed: 0, newcomers: 0, newcomerWrong: 0 }));
  for (const meetingId of meetings) {
    const here = learned.filter((l) => l.meetingId === meetingId);
    const present = attendeesByMeeting.get(meetingId) ?? [];
    const prints = new Map<number, ArrayLike<number>[]>();
    for (const l of learned) {
      if (l.meetingId === meetingId) continue;
      if (present.length && !present.includes(l.personId)) continue;
      if (!prints.has(l.personId)) prints.set(l.personId, []);
      const list = prints.get(l.personId)!;
      if (list.length < PRINTS_PER_PERSON) list.push(l.embedding);
    }
    const candidates: Candidate[] = [...prints].map(([personId, p]) => ({ personId, name: String(personId), prints: p }));
    thresholds.forEach((threshold, i) => {
      const got = new Map(matchVoices(here, candidates, threshold).map((m) => [m.speaker, m.personId]));
      for (const v of here) {
        const m = got.get(v.speaker);
        if (m === undefined) { if (prints.has(v.personId)) rows[i].missed++; }
        else if (m === v.personId) rows[i].correct++;
        else rows[i].wrong++;
        const others = candidates.filter((c) => c.personId !== v.personId);
        if (!others.length) continue;
        rows[i].newcomers++;
        if (matchVoices([v], others, threshold).length) rows[i].newcomerWrong++;
      }
    });
  }
  return rows;
}

// The level that names the most voices while keeping wrong names rare, for
// known voices and newcomers alike, or null when no level does (then names
// should stay suggestions). On a tie the stricter level wins.
export function recommendThreshold(rows: CheckRow[]): number | null {
  let best: CheckRow | null = null;
  for (const r of rows) {
    const named = r.correct + r.wrong;
    if (!named || r.wrong / named > MAX_WRONG_SHARE) continue;
    if (r.newcomers && r.newcomerWrong / r.newcomers > MAX_NEWCOMER_SHARE) continue;
    if (!best || r.correct > best.correct || (r.correct === best.correct && r.threshold > best.threshold)) best = r;
  }
  return best ? best.threshold : null;
}

export interface VoiceCheck {
  status: "idle" | "running" | "done" | "error";
  startedAt?: string;
  finishedAt?: string;
  progress?: { done: number; total: number };
  meetings?: number;
  voices?: number;
  people?: number;
  rows?: CheckRow[];
  recommended?: number | null;
  skipped?: string[];
  error?: string;
}

export async function getVoiceCheck(pool: Pool): Promise<VoiceCheck> {
  try {
    const v = JSON.parse((await getSetting(pool, "voice_check")) || "{}");
    return v && v.status ? v : { status: "idle" };
  } catch { return { status: "idle" }; }
}

export async function setVoiceCheck(pool: Pool, v: VoiceCheck): Promise<void> {
  await setSetting(pool, "voice_check", JSON.stringify(v));
}

export interface CheckDeps {
  // Prints for one recording's voices; the real one decodes and embeds.
  voicesFor(path: string, segments: DiarizedSegment[]): Promise<Voice[]>;
  log(message: string): void;
}

// Learn voices from every meeting whose minutes have been generated, then
// measure how well matching would have named them. Meetings already printed
// when processed are not decoded again.
export async function runVoiceCheck(pool: Pool, deps: CheckDeps): Promise<VoiceCheck> {
  const startedAt = new Date().toISOString();
  const meetings = (await pool.query(
    `SELECT m.id, m.title, m.speaker_map FROM meetings m
      WHERE m.report_generated_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM agenda_items i WHERE i.meeting_id = m.id AND i.transcript_source = 'meeting')
      ORDER BY m.id`
  )).rows;
  const skipped: string[] = [];
  let done = 0;
  await setVoiceCheck(pool, { status: "running", startedAt, progress: { done, total: meetings.length } });
  for (const m of meetings) {
    const meetingId = Number(m.id);
    try {
      const have = Number((await pool.query("SELECT count(*) AS n FROM meeting_voices WHERE meeting_id = $1", [meetingId])).rows[0].n);
      if (!have) {
        const items = (await pool.query(
          `SELECT transcript_segments, transcript_recording_id FROM agenda_items
            WHERE meeting_id = $1 AND transcript_source = 'meeting'`, [meetingId]
        )).rows;
        const recIds = [...new Set(items.map((i) => i.transcript_recording_id).filter((x) => x !== null).map(Number))];
        const rec = recIds.length === 1
          ? (await pool.query("SELECT storage_path FROM meeting_recordings WHERE id = $1 AND meeting_id = $2", [recIds[0], meetingId])).rows[0]
          : undefined;
        if (!rec || !rec.storage_path) {
          skipped.push(`${m.title}: its recording can't be matched to the transcript.`);
        } else {
          const segments = items.flatMap((i) => (Array.isArray(i.transcript_segments) ? i.transcript_segments : []) as DiarizedSegment[])
            .sort((a, b) => a.start - b.start);
          await saveMeetingVoices(pool, meetingId, await deps.voicesFor(rec.storage_path, segments), []);
        }
      }
      await learnMeetingVoices(pool, meetingId, (m.speaker_map ?? {}) as SpeakerMap);
    } catch (e) {
      skipped.push(`${m.title}: ${(e as Error).message}`);
      try { deps.log(`voice check: meeting ${meetingId}: ${(e as Error).message}`); } catch { /* never fails the run */ }
    }
    done++;
    await setVoiceCheck(pool, { status: "running", startedAt, progress: { done, total: meetings.length } });
  }

  const learned: LearnedVoice[] = (await pool.query(
    `SELECT v.meeting_id, v.speaker, v.person_id, v.embedding FROM meeting_voices v
       JOIN people p ON p.id = v.person_id AND p.learn_voice
      ORDER BY v.learned_at DESC`
  )).rows.map((r) => ({ meetingId: Number(r.meeting_id), speaker: r.speaker, personId: Number(r.person_id), embedding: r.embedding as number[] }));
  const attendees = new Map<number, number[]>();
  for (const r of (await pool.query("SELECT meeting_id, person_id FROM meeting_attendees")).rows) {
    const id = Number(r.meeting_id);
    if (!attendees.has(id)) attendees.set(id, []);
    attendees.get(id)!.push(Number(r.person_id));
  }
  const rows = evaluateMatching(learned, attendees);
  const result: VoiceCheck = {
    status: "done", startedAt, finishedAt: new Date().toISOString(),
    meetings: new Set(learned.map((l) => l.meetingId)).size,
    voices: learned.length,
    people: new Set(learned.map((l) => l.personId)).size,
    rows, recommended: recommendThreshold(rows), skipped,
  };
  await setVoiceCheck(pool, result);
  return result;
}
