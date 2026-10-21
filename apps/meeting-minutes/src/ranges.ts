import { DiarizedSegment } from "./whisper";

// Where a line of the report came from in the recording. The report stays
// Markdown; a range rides along as an HTML comment at the end of a heading or
// action-item line, invisible in any Markdown viewer and stripped for export.

export interface AudioRange {
  source: "m" | "i"; // "m": meeting_recordings.id, "i": item_recordings.id
  recordingId: number;
  start: number; // seconds on that recording's timeline
  end: number;
}

const MARKER = /\s*<!--t:([mi])(\d+):(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)-->/;
const TRAILING = new RegExp(MARKER.source + "\\s*$");
const ANY = new RegExp(MARKER.source, "g");

export function formatRangeMarker(r: AudioRange): string {
  return `<!--t:${r.source}${r.recordingId}:${r.start.toFixed(1)}-${r.end.toFixed(1)}-->`;
}

// A marker at the end of the line, removed from the text. Anywhere else it is
// left alone.
export function splitRangeMarker(line: string): { text: string; range: AudioRange | null } {
  const m = TRAILING.exec(line);
  if (!m) return { text: line, range: null };
  return {
    text: line.slice(0, m.index),
    range: { source: m[1] as "m" | "i", recordingId: Number(m[2]), start: Number(m[3]), end: Number(m[4]) },
  };
}

export function stripRangeMarkers(markdown: string): string {
  return markdown.replace(ANY, "");
}

// "12:40" or "1:02:05" to seconds; anything else is null.
export function parseClock(s: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/.exec(s);
  if (!m) return null;
  const [h, min, sec] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  if (sec > 59 || (m[1] !== undefined && min > 59)) return null;
  return h * 3600 + min * 60 + sec;
}

export function formatClock(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// The stretch of the recording a topic's segments cover.
export function segmentsRange(segments: DiarizedSegment[], source: "m" | "i", recordingId: number): AudioRange | null {
  if (!segments.length) return null;
  let start = Infinity, end = -Infinity;
  for (const s of segments) { start = Math.min(start, s.start); end = Math.max(end, s.end); }
  return { source, recordingId, start, end };
}

// "12:40-13:05" (hyphen, en or em dash; h:mm:ss past the hour) to seconds.
// Null when either end is unreadable or the range runs backwards.
export function parseClockRange(s: string): { start: number; end: number } | null {
  const parts = String(s ?? "").split(/\s*[-–—]\s*/);
  if (parts.length !== 2) return null;
  const start = parseClock(parts[0]), end = parseClock(parts[1]);
  return start !== null && end !== null && end > start ? { start, end } : null;
}

// Seconds of slack allowed around a topic's range for a time cited inside it.
export const RANGE_SLACK_SECONDS = 5;

// Whether a cited stretch lies inside a topic's range. A citation that falls
// outside would play some other part of the meeting.
export function withinRange(r: AudioRange | null, start: number, end: number): boolean {
  return !!r && start >= r.start - RANGE_SLACK_SECONDS && end <= r.end + RANGE_SLACK_SECONDS;
}
