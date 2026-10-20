// The capture calendar as an iCalendar feed, so whoever is gathering media
// sees their days in their phone's calendar. Pure: rows in, text out.
import { addDays } from "../dates";
import { MediaRow } from "./repo";

// RFC 5545 text escaping, then folding at 75 octets.
function text(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0, first = true;
  while (start < bytes.length) {
    let end = Math.min(start + (first ? 75 : 74), bytes.length);
    // Never split a UTF-8 character.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push((first ? "" : " ") + bytes.subarray(start, end).toString("utf8"));
    start = end; first = false;
  }
  return parts.join("\r\n");
}
const compact = (iso: string) => iso.replace(/-/g, "");

export function buildCaptureIcs(media: MediaRow[], opts: { name: string; pageUrl: string; stamp: Date }): string {
  const stamp = opts.stamp.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//GRMC//Content Pipeline//EN", "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH", `X-WR-CALNAME:${text(opts.name)}`, "X-PUBLISHED-TTL:PT1H",
  ];
  for (const m of media) {
    if (!m.gatherDate) continue;
    const done = m.status === "captured" || m.status === "edited";
    const details = [
      `${m.type} for "${m.itemTitle}"` + (m.itemPublishDate ? ` (publishes ${m.itemPublishDate})` : ""),
      m.assigneeEmail ? `Capturing: ${m.assigneeEmail}` : "Nobody assigned yet",
      m.notes, `Status: ${m.status}`, opts.pageUrl,
    ].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:media-${m.id}@grmc-pipeline`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(m.gatherDate)}`,
      `DTEND;VALUE=DATE:${compact(addDays(m.gatherDate, 1))}`,
      `SUMMARY:${text((done ? "✓ " : "Capture: ") + m.description)}`,
      `DESCRIPTION:${text(details)}`,
      ...(m.gatherLocation ? [`LOCATION:${text(m.gatherLocation)}`] : []),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
