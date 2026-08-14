import { DiarizedSegment } from "./whisper";
import { distinctSpeakers } from "./transcript";

export interface TopicMarker {
  itemId: number;
  atSeconds: number;
}

// Assign whole-meeting segments to agenda items using the topic markers laid
// down while recording. Sorted markers define windows [at_i, at_{i+1}); a
// segment belongs to the window holding its midpoint. Audio before the first
// marker belongs to the first marker's item; with no markers at all everything
// belongs to fallbackItemId. Revisited topics concatenate in time order.
export function segmentByMarkers(
  segments: DiarizedSegment[],
  markers: TopicMarker[],
  fallbackItemId: number
): Map<number, DiarizedSegment[]> {
  const out = new Map<number, DiarizedSegment[]>();
  const sorted = [...markers].sort((a, b) => a.atSeconds - b.atSeconds);
  if (!sorted.length) {
    if (segments.length) out.set(fallbackItemId, [...segments]);
    return out;
  }
  for (const s of segments) {
    const mid = (s.start + s.end) / 2;
    let owner = sorted[0].itemId;
    for (const m of sorted) {
      if (m.atSeconds <= mid) owner = m.itemId;
      else break;
    }
    if (!out.has(owner)) out.set(owner, []);
    out.get(owner)!.push(s);
  }
  return out;
}

// First-appearance speaker order across the chronological concatenation of
// every item's segments — the meeting-wide "Speaker N" numbering.
export function chronologicalSpeakerOrder(itemSegments: DiarizedSegment[][]): string[] {
  const all = itemSegments.flat().slice().sort((a, b) => a.start - b.start);
  return distinctSpeakers(all);
}
