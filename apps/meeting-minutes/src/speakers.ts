import { DiarizedSegment } from "./whisper";
import { SpeakerMap, distinctSpeakers, friendlyLabel } from "./transcript";

// A turn shorter than this, sandwiched between two turns of the same other
// speaker, is treated as a diarization glitch rather than a real interjection.
export const MICRO_TURN_SECONDS = 1.2;

// A maximal run of consecutive segments sharing one speaker label.
export interface Turn {
  speaker: string;
  start: number;
  end: number;
  indexes: number[]; // positions in the source segment array
}

export function buildTurns(segments: DiarizedSegment[]): Turn[] {
  const turns: Turn[] = [];
  segments.forEach((s, i) => {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker) {
      last.end = s.end;
      last.indexes.push(i);
    } else {
      turns.push({ speaker: s.speaker, start: s.start, end: s.end, indexes: [i] });
    }
  });
  return turns;
}

// Repair mid-sentence speaker flips. When a short turn sits between two turns
// belonging to the SAME other speaker, it is almost always the diarizer
// wobbling rather than a real interjection, so reassign it to the surrounding
// speaker. Repeats until no more merges are possible: each pass strictly
// reduces the turn count, so this always terminates.
export function absorbMicroTurns(
  segments: DiarizedSegment[],
  maxSeconds: number = MICRO_TURN_SECONDS
): DiarizedSegment[] {
  const out = segments.map((s) => ({ ...s }));
  for (;;) {
    const turns = buildTurns(out);
    let merged = false;
    // Adjacent turns from buildTurns always differ in speaker. When two adjacent short
    // turns are both eligible for absorption, the leftmost wins (tie-break is deliberate;
    // later reconciliation passes clean up residual ambiguity).
    for (let i = 1; i < turns.length - 1; i++) {
      const prev = turns[i - 1];
      const cur = turns[i];
      const next = turns[i + 1];
      if (prev.speaker !== next.speaker) continue;
      if (cur.speaker === prev.speaker) continue;
      if (cur.end - cur.start > maxSeconds) continue;
      for (const idx of cur.indexes) out[idx].speaker = prev.speaker;
      merged = true;
      break; // turns are stale now — rebuild and rescan
    }
    if (!merged) return out;
  }
}

const SAMPLE_MAX_CHARS = 80;

// Per-voice talk time and a representative quote. Rendered in the "Who is
// speaking?" rows so several near-identical "Speaker N" entries can be told
// apart. `label` is positional (first-appearance order), matching
// friendlyLabel; the array itself is sorted by talk time descending.
export interface SpeakerStat {
  speaker: string;  // raw diarization label, e.g. "SPEAKER_00"
  label: string;    // "Speaker 1", "Speaker 2", …
  seconds: number;
  share: number;    // 0..1 of total labelled speaking time
  sample: string;
}

export function speakerStats(segments: DiarizedSegment[]): SpeakerStat[] {
  const order = distinctSpeakers(segments);
  if (!order.length) return [];
  const seconds = new Map<string, number>();
  const longest = new Map<string, string>();
  for (const s of segments) {
    if (!s.speaker) continue;
    seconds.set(s.speaker, (seconds.get(s.speaker) ?? 0) + Math.max(0, s.end - s.start));
    const best = longest.get(s.speaker) ?? "";
    if (s.text.length > best.length) longest.set(s.speaker, s.text);
  }
  const total = [...seconds.values()].reduce((a, b) => a + b, 0);
  return order
    .map((speaker) => {
      const raw = longest.get(speaker) ?? "";
      const sample = raw.length > SAMPLE_MAX_CHARS ? `${raw.slice(0, SAMPLE_MAX_CHARS)}…` : raw;
      const secs = seconds.get(speaker) ?? 0;
      return { speaker, label: friendlyLabel(speaker, order), seconds: secs, share: total > 0 ? secs / total : 0, sample };
    })
    .sort((a, b) => b.seconds - a.seconds);
}

// The label that spoke the most. Ties resolve to whichever appeared first.
export function dominantSpeaker(segments: DiarizedSegment[]): string {
  const stats = speakerStats(segments);
  return stats.length ? stats[0].speaker : "";
}

// Map the busiest voice to the agenda item's presenter. Callers must only pass
// a presenter who is a selected attendee of the meeting. Never overwrites an
// existing assignment, and does nothing if the presenter already owns a voice.
export function assignPresenterToDominant(
  segments: DiarizedSegment[],
  map: SpeakerMap,
  presenterName: string
): SpeakerMap {
  const name = presenterName.trim();
  if (!name) return map;
  const taken = Object.values(map).some((n) => n.trim().toLowerCase() === name.toLowerCase());
  if (taken) return map;
  const dom = dominantSpeaker(segments);
  if (!dom) return map;
  if (map[dom] && map[dom].trim()) return map;
  return { ...map, [dom]: name };
}
