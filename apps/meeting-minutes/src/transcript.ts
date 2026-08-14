import { DiarizedSegment } from "./whisper";

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
export function renderTranscript(segments: DiarizedSegment[], map: SpeakerMap): string {
  if (!segments.length) return "";
  const order = distinctSpeakers(segments);
  if (!order.length) {
    // No diarization labels — just the text.
    return segments.map((s) => s.text).join(" ").trim();
  }
  const lines: string[] = [];
  let curName: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (curName === null || !buf.length) return;
    lines.push(`${curName}: ${buf.join(" ").trim()}`);
    buf = [];
  };
  for (const s of segments) {
    const spk = s.speaker || (order[0] ?? "SPEAKER_00");
    const name = resolveSpeakerName(spk, map, order);
    if (name !== curName) { flush(); curName = name; }
    buf.push(s.text);
  }
  flush();
  return lines.join("\n");
}
