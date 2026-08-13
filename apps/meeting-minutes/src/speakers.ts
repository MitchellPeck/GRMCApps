import { DiarizedSegment } from "./whisper";

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
