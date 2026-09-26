import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiarizedSegment, TranscriptionResult } from "./whisper";
import {
  Fingerprint, MIN_EMBED_SECONDS, applySpeakerClusters, clusterFingerprints, labelAudio, wavSamples,
} from "./speakerLinking";

// ── Long-recording transcription in parts ───────────────────────────────────
// A whole-meeting recording sent to whisper in one request crashed the whisper
// container outright (70 minutes, three tries, three container restarts, and
// "socket hang up" each time). So a long recording is decoded once to 16 kHz
// mono WAV — exactly what whisper resamples to anyway — cut into ~10-minute
// parts at pauses in speech, and transcribed one part at a time.
//
// The stored recording is only ever READ: every intermediate file lives in a
// throwaway temp directory that is removed when the job ends, pass or fail, so
// a failed run can always be retried against the untouched original.
//
// Each part's timestamps are shifted by where that part starts, so the merged
// transcript is on the original recording's timeline and the topic markers
// (seconds from the start of the recording) apply unchanged.

// Snap each cut to the middle of a pause within this many seconds of the
// target, so a cut does not split a word.
const SNAP_WINDOW_SECONDS = 30;
// Never leave a final part shorter than this; fold it into the previous one.
const MIN_TAIL_SECONDS = 60;

export interface Silence { start: number; end: number }

// Pull `silence_start` / `silence_end` pairs out of ffmpeg's silencedetect log.
export function parseSilences(log: string): Silence[] {
  const out: Silence[] = [];
  let open: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) { open = Math.max(0, Number(s[1])); continue; }
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && open !== null) { out.push({ start: open, end: Number(e[1]) }); open = null; }
  }
  return out;
}

// Where to cut a recording of `duration` seconds into ~`chunkSeconds` parts:
// each target is snapped to the midpoint of the nearest pause within
// SNAP_WINDOW_SECONDS, or used as-is when there is none.
export function chooseCutPoints(duration: number, silences: Silence[], chunkSeconds: number): number[] {
  const cuts: number[] = [];
  let prev = 0;
  for (let target = chunkSeconds; target < duration - MIN_TAIL_SECONDS; target += chunkSeconds) {
    let best = target, bestDist = Infinity;
    for (const s of silences) {
      const mid = (s.start + s.end) / 2;
      const dist = Math.abs(mid - target);
      if (dist <= SNAP_WINDOW_SECONDS && dist < bestDist) { best = mid; bestDist = dist; }
    }
    if (best - prev >= MIN_TAIL_SECONDS && duration - best >= MIN_TAIL_SECONDS) {
      cuts.push(best);
      prev = best;
    }
  }
  return cuts;
}

// Exact duration of a PCM WAV from its header: data bytes ÷ byte rate.
export function wavDurationSeconds(buf: Buffer): number {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }
  let byteRate = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(pos + 16);
    if (id === "data") {
      if (!byteRate) throw new Error("WAV has no fmt chunk before its data.");
      // A streamed header can carry a placeholder size; trust the bytes present.
      const available = buf.length - (pos + 8);
      return Math.min(size, available) / byteRate;
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk.");
}

export interface PartResult { offset: number; result: TranscriptionResult }

// Stitch per-part results onto one timeline. Whisper's speaker labels are only
// meaningful within the request that produced them — "SPEAKER_00" in part 2 is
// not necessarily "SPEAKER_00" in part 3 — so each part's labels get their own
// namespace ("P2_SPEAKER_00"). transcribeLongAudio then matches those labels
// to meeting-wide voices by fingerprint (speakerLinking.ts) — never ship the
// namespaced labels themselves: that produced 200+ "speakers" for eight
// people. A single part is returned untouched, so short recordings keep their
// plain labels.
export function mergePartResults(parts: PartResult[]): TranscriptionResult {
  if (parts.length === 1 && parts[0].offset === 0) return parts[0].result;
  const segments: DiarizedSegment[] = [];
  parts.forEach(({ offset, result }, i) => {
    for (const s of result.segments) {
      segments.push({
        text: s.text,
        speaker: s.speaker ? `P${i + 1}_${s.speaker}` : "",
        start: s.start + offset,
        end: s.end + offset,
      });
    }
  });
  const text = parts.map((p) => p.result.text).filter(Boolean).join(" ").trim();
  return { text, segments };
}

// ── ffmpeg ──────────────────────────────────────────────────────────────────

function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("ffmpeg", ["-hide_banner", "-nostats", "-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      reject(e);
      return;
    }
    const chunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (e: NodeJS.ErrnoException) => {
      reject(e.code === "ENOENT"
        ? new Error("ffmpeg is not installed in the meeting-minutes container; long recordings cannot be split.")
        : e);
    });
    child.on("close", (code) => {
      const log = Buffer.concat(chunks).toString("utf8");
      if (code === 0) resolve(log);
      else reject(new Error(`Could not read the recording audio (ffmpeg exit ${code}): ${log.trim().split("\n").slice(-3).join(" ")}`));
    });
  });
}

export interface AudioPart { path: string; offset: number }

// Decode `inputPath` to WAV and cut it into parts in `workDir`. Returns the
// parts in order with their start offset (seconds) in the original recording.
export async function splitAudio(inputPath: string, workDir: string, chunkSeconds: number): Promise<AudioPart[]> {
  const full = join(workDir, "full.wav");
  // One decode pass produces the WAV and, via the pass-through silencedetect
  // filter, the pauses to cut at.
  const log = await runFfmpeg([
    "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    "-af", "silencedetect=noise=-35dB:d=0.4", full,
  ]);
  const duration = wavDurationSeconds(await readFile(full));
  const cuts = chooseCutPoints(duration, parseSilences(log), chunkSeconds);
  if (!cuts.length) return [{ path: full, offset: 0 }];

  await runFfmpeg([
    "-i", full, "-c", "copy", "-f", "segment",
    "-segment_times", cuts.map((c) => c.toFixed(3)).join(","),
    "-reset_timestamps", "1", join(workDir, "part%03d.wav"),
  ]);
  await rm(full, { force: true });
  const names = (await readdir(workDir)).filter((n) => /^part\d+\.wav$/.test(n)).sort();
  // Offsets come from the parts' own lengths rather than the requested cut
  // times, so they are exact to the sample however ffmpeg rounded the cuts.
  const parts: AudioPart[] = [];
  let offset = 0;
  for (const n of names) {
    const path = join(workDir, n);
    parts.push({ path, offset });
    offset += wavDurationSeconds(await readFile(path));
  }
  return parts;
}

export interface LongAudioDeps {
  transcribe(file: { fileName: string; mimeType: string; buffer: Buffer }): Promise<TranscriptionResult>;
  // Voice fingerprint of 16 kHz mono samples. Required whenever a recording
  // is long enough to be split: without it speakers cannot be matched across
  // parts, and the job fails rather than save hundreds of phantom speakers.
  embed?(samples: Float32Array, sampleRate: number): Float32Array;
  log(message: string): void;
}

export interface LongAudioOptions {
  // People present at the meeting: the most distinct voices to report.
  maxSpeakers?: number;
}

// Fingerprint every label whisper used in one part, from that part's audio.
function fingerprintPart(
  wav: Buffer,
  partIndex: number,
  result: TranscriptionResult,
  embed: NonNullable<LongAudioDeps["embed"]>
): Fingerprint[] {
  const { sampleRate, samples } = wavSamples(wav);
  const labels = [...new Set(result.segments.map((s) => s.speaker).filter(Boolean))];
  const prints: Fingerprint[] = [];
  for (const label of labels) {
    const audio = labelAudio(samples, sampleRate, result.segments, label);
    if (audio.length < MIN_EMBED_SECONDS * sampleRate) continue;
    // Same key mergePartResults gives this label.
    prints.push({ key: `P${partIndex + 1}_${label}`, embedding: embed(audio, sampleRate) });
  }
  return prints;
}

// Transcribe a stored recording of any length, part by part. `inputPath` is
// read, never written; the temp directory is always removed.
export async function transcribeLongAudio(
  inputPath: string,
  chunkSeconds: number,
  deps: LongAudioDeps,
  opts: LongAudioOptions = {}
): Promise<TranscriptionResult> {
  const workDir = await mkdtemp(join(tmpdir(), "minutes-split-"));
  try {
    const parts = await splitAudio(inputPath, workDir, chunkSeconds);
    if (parts.length > 1 && !deps.embed) {
      throw new Error("Speaker matching is unavailable, so a recording this long cannot be split.");
    }
    const results: PartResult[] = [];
    const prints: Fingerprint[] = [];
    for (let i = 0; i < parts.length; i++) {
      const started = Date.now();
      let result: TranscriptionResult;
      try {
        result = await deps.transcribe({ fileName: `part-${i + 1}.wav`, mimeType: "audio/wav", buffer: await readFile(parts[i].path) });
      } catch (e) {
        throw new Error(parts.length > 1 ? `Part ${i + 1} of ${parts.length}: ${(e as Error).message}` : (e as Error).message);
      }
      try {
        deps.log(`transcribed part ${i + 1}/${parts.length} (from ${Math.round(parts[i].offset)}s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } catch { /* logging must never fail a job */ }
      results.push({ offset: parts[i].offset, result });
      if (parts.length > 1) {
        try {
          prints.push(...fingerprintPart(await readFile(parts[i].path), i, result, deps.embed!));
        } catch (e) {
          throw new Error(`Part ${i + 1} of ${parts.length}: could not fingerprint speakers: ${(e as Error).message}`);
        }
      }
    }
    const merged = mergePartResults(results);
    if (parts.length === 1) return merged;
    if (!prints.length && merged.segments.some((s) => s.speaker)) {
      throw new Error("No speaker had enough audio to be matched across parts.");
    }
    const clusterOf = clusterFingerprints(prints, opts.maxSpeakers);
    const segments = applySpeakerClusters(merged.segments, clusterOf);
    try {
      deps.log(`matched ${prints.length} per-part speaker label(s) to ${new Set(clusterOf.values()).size} voice(s)`
        + (opts.maxSpeakers ? ` (at most ${opts.maxSpeakers} present)` : ""));
    } catch { /* logging must never fail a job */ }
    return { text: merged.text, segments };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
