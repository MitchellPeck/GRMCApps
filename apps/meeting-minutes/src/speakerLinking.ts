import { DiarizedSegment } from "./whisper";

// ── Matching speakers across parts ──────────────────────────────────────────
// Whisper diarizes each part of a long recording on its own, so its labels
// mean nothing across parts: "SPEAKER_00" in part 2 and "SPEAKER_00" in part 3
// can be different people, and one person gets a fresh label in every part.
// Left alone, a 70-minute meeting of eight people came back with 200+
// "speakers". So each part's labels get a voice fingerprint (a speaker
// embedding computed from that label's own audio), and the fingerprints are
// clustered across the whole meeting — never into more voices than there are
// people present.

// Cosine similarity at or above which two voices are treated as one person
// even when the attendee cap has not been reached. Same-speaker pairs score
// well above this with the ERes2Net model; different people score far below.
export const SAME_SPEAKER_SIMILARITY = 0.5;
// Up to this much of a label's audio is fingerprinted. More adds little.
export const MAX_EMBED_SECONDS = 60;
// Labels with less audio than this are too short to fingerprint reliably;
// they inherit the speaker of the nearest fingerprinted turn instead.
export const MIN_EMBED_SECONDS = 1.5;

// 16-bit PCM mono WAV → samples in [-1, 1].
export function wavSamples(buf: Buffer): { sampleRate: number; samples: Float32Array } {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }
  let sampleRate = 0, bits = 0, channels = 0, pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bits = buf.readUInt16LE(pos + 22);
    }
    if (id === "data") {
      if (bits !== 16 || channels !== 1) throw new Error("Expected 16-bit mono WAV.");
      const start = pos + 8;
      const n = Math.floor(Math.min(size, buf.length - start) / 2);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(start + i * 2) / 32768;
      return { sampleRate, samples };
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk.");
}

// The audio of every turn a label speaks in a part (part-local timestamps),
// longest turns first, capped at MAX_EMBED_SECONDS.
export function labelAudio(
  samples: Float32Array,
  sampleRate: number,
  segments: DiarizedSegment[],
  label: string
): Float32Array {
  const turns = segments
    .filter((s) => s.speaker === label && s.end > s.start)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const cap = MAX_EMBED_SECONDS * sampleRate;
  const pieces: Float32Array[] = [];
  let total = 0;
  for (const t of turns) {
    if (total >= cap) break;
    const from = Math.max(0, Math.floor(t.start * sampleRate));
    const to = Math.min(samples.length, Math.ceil(t.end * sampleRate), from + (cap - total));
    if (to > from) { pieces.push(samples.subarray(from, to)); total += to - from; }
  }
  const out = new Float32Array(total);
  let at = 0;
  for (const p of pieces) { out.set(p, at); at += p.length; }
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

export interface Fingerprint { key: string; embedding: Float32Array }

// Average-linkage agglomerative clustering on cosine similarity. Clusters
// merge while they are similar enough to be one voice, and keep merging past
// that while there are more clusters than `maxClusters` (the number of people
// present), so the result never names more voices than there were people.
export function clusterFingerprints(
  prints: Fingerprint[],
  maxClusters: number | undefined,
  threshold = SAME_SPEAKER_SIMILARITY
): Map<string, number> {
  const n = prints.length;
  const sim: number[][] = prints.map((a) => prints.map((b) => cosine(a.embedding, b.embedding)));
  let clusters: number[][] = prints.map((_, i) => [i]);
  const linkage = (x: number[], y: number[]) => {
    let s = 0;
    for (const i of x) for (const j of y) s += sim[i][j];
    return s / (x.length * y.length);
  };
  while (clusters.length > 1) {
    let best = -Infinity, bi = -1, bj = -1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const l = linkage(clusters[i], clusters[j]);
        if (l > best) { best = l; bi = i; bj = j; }
      }
    }
    const overCap = maxClusters !== undefined && maxClusters > 0 && clusters.length > maxClusters;
    if (best < threshold && !overCap) break;
    clusters[bi] = clusters[bi].concat(clusters[bj]);
    clusters = clusters.filter((_, k) => k !== bj);
  }
  const out = new Map<string, number>();
  clusters.forEach((members, c) => { for (const i of members) out.set(prints[i].key, c); });
  if (out.size !== n) throw new Error("clustering lost a fingerprint");
  return out;
}

// Rewrite merged segments' labels to meeting-wide "SPEAKER_NN" labels,
// numbered by first appearance. Labels with no fingerprint take the speaker of
// the nearest-in-time fingerprinted turn. Unlabelled segments stay unlabelled.
export function applySpeakerClusters(
  segments: DiarizedSegment[],
  clusterOf: Map<string, number>
): DiarizedSegment[] {
  const anchored = segments.filter((s) => s.speaker && clusterOf.has(s.speaker));
  const resolve = (s: DiarizedSegment): number | undefined => {
    if (!s.speaker) return undefined;
    const direct = clusterOf.get(s.speaker);
    if (direct !== undefined) return direct;
    let best: DiarizedSegment | undefined, bestDist = Infinity;
    const mid = (s.start + s.end) / 2;
    for (const a of anchored) {
      const d = Math.abs((a.start + a.end) / 2 - mid);
      if (d < bestDist) { best = a; bestDist = d; }
    }
    return best ? clusterOf.get(best.speaker) : undefined;
  };
  const names = new Map<number, string>();
  return segments.map((s) => {
    const c = resolve(s);
    if (c === undefined) return { ...s, speaker: "" };
    if (!names.has(c)) names.set(c, `SPEAKER_${String(names.size).padStart(2, "0")}`);
    return { ...s, speaker: names.get(c)! };
  });
}
