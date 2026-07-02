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

// Render diarized segments into a readable, speaker-attributed transcript.
// Consecutive segments from the same speaker are merged into one line. When no
// segment carries a speaker label, falls back to plain joined text.
export function renderTranscript(segments: DiarizedSegment[], map: SpeakerMap): string {
  if (!segments.length) return "";
  const order = distinctSpeakers(segments);
  if (!order.length) {
    // No diarization labels — just the text.
    return segments.map((s) => s.text).join(" ").trim();
  }
  const lines: string[] = [];
  let curSpeaker: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (curSpeaker === null || !buf.length) return;
    const name = (map[curSpeaker] && map[curSpeaker].trim()) || friendlyLabel(curSpeaker, order);
    lines.push(`${name}: ${buf.join(" ").trim()}`);
    buf = [];
  };
  for (const s of segments) {
    const spk = s.speaker || (order[0] ?? "SPEAKER_00");
    if (spk !== curSpeaker) { flush(); curSpeaker = spk; }
    buf.push(s.text);
  }
  flush();
  return lines.join("\n");
}
