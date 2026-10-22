// The capture calendar and the posts calendar as iCalendar feeds, so the team
// sees capture days and publish dates in their phone's calendar. Pure: rows in, text out.
import { addDays } from "../dates";
import { PLATFORMS } from "./config";
import { ContentRow, MediaRow } from "./repo";

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

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
const header = (name: string) => [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//GRMC//Content Pipeline//EN", "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH", `X-WR-CALNAME:${text(name)}`, "X-PUBLISHED-TTL:PT1H",
];
const finish = (lines: string[]) => [...lines, "END:VCALENDAR"].map(fold).join("\r\n") + "\r\n";

export function buildCaptureIcs(media: MediaRow[], opts: { name: string; pageUrl: string; stamp: Date }): string {
  const stamp = utcStamp(opts.stamp);
  const lines = header(opts.name);
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
  return finish(lines);
}

const STATUS_LABEL: Record<string, string> = {
  idea: "Idea", planned: "Planned", drafted: "Drafted", ready: "Ready",
  scheduled: "Scheduled", published: "Published", cancelled: "Cancelled",
};
const platformLabel = (key: string) => PLATFORMS.find((p) => p.key === key)?.label || key;

/**
 * Every dated post on its publish date: at its time (in the church's time
 * zone) when it has one, otherwise all day. Published posts get a tick; posts
 * not yet scheduled say where they are, so a glance shows what's still open.
 */
export function buildPostsIcs(items: ContentRow[], opts: { name: string; pageUrl: string; stamp: Date; timezone: string }): string {
  const stamp = utcStamp(opts.stamp);
  const lines = header(opts.name);
  lines.push(`X-WR-TIMEZONE:${opts.timezone}`);
  for (const i of items) {
    if (!i.publishDate) continue;
    const summary = i.status === "published" ? "✓ " + i.title
      : i.status === "scheduled" ? i.title
      : `${i.title} (${STATUS_LABEL[i.status] || i.status})`;
    const captions = i.captionMode === "separate"
      ? i.platforms.map((p) => i.captions[p] ? `${platformLabel(p)}:\n${i.captions[p]}` : "").filter(Boolean).join("\n\n")
      : i.caption;
    const details = [
      i.platforms.map(platformLabel).join(", "),
      i.eventName ? `Event: ${i.eventName}` : "",
      `Status: ${STATUS_LABEL[i.status] || i.status}`,
      i.ownerEmail ? `Owner: ${i.ownerEmail}` : "Nobody owns this yet",
      i.mediaTotal ? `Media: ${i.mediaDone} of ${i.mediaTotal} ready` : "",
      i.brief ? `Brief: ${i.brief}` : "",
      captions ? `Caption:\n${captions}` : "",
      opts.pageUrl,
    ].filter(Boolean).join("\n");
    const when = i.publishTime
      ? [`DTSTART;TZID=${opts.timezone}:${compact(i.publishDate)}T${i.publishTime.replace(":", "")}00`, "DURATION:PT30M"]
      : [`DTSTART;VALUE=DATE:${compact(i.publishDate)}`, `DTEND;VALUE=DATE:${compact(addDays(i.publishDate, 1))}`];
    lines.push(
      "BEGIN:VEVENT",
      `UID:post-${i.id}@grmc-pipeline`,
      `DTSTAMP:${stamp}`,
      ...when,
      `SUMMARY:${text(summary)}`,
      `DESCRIPTION:${text(details)}`,
      ...(i.eventName ? [`CATEGORIES:${text(i.eventName)}`] : []),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  return finish(lines);
}
