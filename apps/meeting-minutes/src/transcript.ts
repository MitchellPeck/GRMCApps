import { DiarizedSegment } from "./whisper";
import { formatClock } from "./ranges";

export type SpeakerMap = Record<string, string>; // "SPEAKER_00" -> person name

// Distinct speaker labels in order of first appearance.
export function distinctSpeakers(segments: DiarizedSegment[]): string[] {
  const seen: string[] = [];
  for (const s of segments) {
    if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker);
  }
  return seen;
}

// A friendly fallback name for an unmapped speaker ("Speaker 1", "Speaker 2"…),
// numbered by first-appearance order.
export function friendlyLabel(speaker: string, order: string[]): string {
  const idx = order.indexOf(speaker);
  return idx >= 0 ? `Speaker ${idx + 1}` : "Speaker";
}

// The display name for a raw diarization label: the mapped person's name when
// one is set, otherwise the positional "Speaker N" fallback.
export function resolveSpeakerName(speaker: string, map: SpeakerMap, order: string[]): string {
  const mapped = map[speaker];
  if (mapped && mapped.trim()) return mapped.trim();
  return friendlyLabel(speaker, order);
}

// Render diarized segments into a readable, speaker-attributed transcript.
// Consecutive segments that resolve to the SAME DISPLAY NAME are merged into
// one line — several raw labels can map to one person after reconciliation.
// When no segment carries a speaker label, falls back to plain joined text.
export function renderTranscript(
  segments: DiarizedSegment[],
  map: SpeakerMap,
  order?: string[]
): string {
  if (!segments.length) return "";
  const t = turns(segments, map, order);
  if (!t) return segments.map((s) => s.text).join(" ").trim();
  return t.map((x) => `${x.name}: ${x.text}`).join("\n");
}

// The same transcript with each turn stamped "[mm:ss]" at its start, so the
// AI can say where in the recording something was said.
export function renderTimedTranscript(
  segments: DiarizedSegment[],
  map: SpeakerMap,
  order?: string[]
): string {
  if (!segments.length) return "";
  const t = turns(segments, map, order);
  if (!t) return segments.map((s) => `[${formatClock(s.start)}] ${s.text.trim()}`).join("\n");
  return t.map((x) => `[${formatClock(x.start)}] ${x.name}: ${x.text}`).join("\n");
}

// Consecutive segments under one display name, merged. Null when no segment
// carries a speaker label.
function turns(
  segments: DiarizedSegment[],
  map: SpeakerMap,
  order?: string[]
): Array<{ name: string; start: number; text: string }> | null {
  const ord = order && order.length ? order : distinctSpeakers(segments);
  if (!ord.length) return null;
  const out: Array<{ name: string; start: number; text: string }> = [];
  let cur: { name: string; start: number; parts: string[] } | null = null;
  const flush = () => {
    if (cur && cur.parts.length) out.push({ name: cur.name, start: cur.start, text: cur.parts.join(" ").trim() });
  };
  for (const s of segments) {
    const spk = s.speaker || (ord[0] ?? "SPEAKER_00");
    const name = resolveSpeakerName(spk, map, ord);
    if (!cur || name !== cur.name) { flush(); cur = { name, start: s.start, parts: [] }; }
    cur.parts.push(s.text);
  }
  flush();
  return out;
}

// What the AI is given for a topic's transcript: the timed rendering while the
// stored text still matches the segments, otherwise the stored text as is. A
// hand-edited transcript no longer lines up with the segment times.
export function transcriptForAi(
  item: { transcript: string; transcript_segments: DiarizedSegment[]; speaker_map: SpeakerMap },
  order?: string[]
): string {
  const segs = item.transcript_segments ?? [];
  if (segs.length && renderTranscript(segs, item.speaker_map, order) === item.transcript.trim()) {
    return renderTimedTranscript(segs, item.speaker_map, order);
  }
  return item.transcript;
}
