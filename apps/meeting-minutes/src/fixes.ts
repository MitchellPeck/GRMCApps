import { Pool } from "pg";
import { ActionItem } from "./claude";
import { ItemFields, Snapshot, recordChange, writeFields } from "./changes";
import { replaceInActionItems, replaceInSegments, replaceWords } from "./corrections";
import { listPeople } from "./people";
import { topicSectionLines } from "./report";
import { chronologicalSpeakerOrder } from "./segmentation";
import { SpeakerMap, renderTranscript } from "./transcript";
import { DiarizedSegment } from "./whisper";

export { listChanges, undoChange } from "./changes";

// "Fix a name or word": a misheard name corrected in one step across the
// meeting — transcripts (at the segment level, so a re-render keeps it),
// summaries, action items, the report, speaker names and guests. It never
// rewrites a summary from scratch, and never touches the shared people list.

export interface FixCounts {
  transcripts: number;
  summaries: number;
  actionItems: number;
  report: number;
  speakers: number;
  guests: number;
}

export interface FixResult {
  counts: FixCounts;
  total: number;
  changeId: number | null;
  libraryMatches: Array<{ id: number; name: string }>;
}

function replaceInMap(map: SpeakerMap, from: string, to: string): { map: SpeakerMap; count: number } {
  let count = 0;
  const out: SpeakerMap = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    const r = replaceWords(v, from, to);
    count += r.count;
    out[k] = r.text;
  }
  return { map: out, count };
}

export async function fixWords(
  pool: Pool,
  meetingId: number,
  fromRaw: string,
  toRaw: string,
  opts: { itemId?: number; dryRun?: boolean; by?: string } = {}
): Promise<FixResult> {
  const from = fromRaw.trim(), to = toRaw.trim();
  const counts: FixCounts = { transcripts: 0, summaries: 0, actionItems: 0, report: 0, speakers: 0, guests: 0 };
  const before: Snapshot = {}, after: Snapshot = {};
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const meeting = (await c.query("SELECT report, speaker_map FROM meetings WHERE id = $1 FOR UPDATE", [meetingId])).rows[0];
    if (!meeting) throw new Error("Meeting not found.");
    const items = (await c.query(
      `SELECT id, title, transcript, transcript_segments, summary, action_items, speaker_map, transcript_source
         FROM agenda_items WHERE meeting_id = $1 ORDER BY position, id FOR UPDATE`,
      [meetingId]
    )).rows.map((r) => ({ ...r, id: Number(r.id) }));
    const order = chronologicalSpeakerOrder(
      items.filter((it) => it.transcript_source === "meeting").map((it) => it.transcript_segments as DiarizedSegment[])
    );

    // Whole-meeting topics each carry a copy of the meeting's speaker names, so
    // a speaker counts once, from the meeting's own map when it has the name.
    let itemSpeakerNames = 0;
    const targets = opts.itemId === undefined ? items : items.filter((it) => it.id === opts.itemId);
    for (const it of targets) {
      const b: ItemFields = {}, a: ItemFields = {};
      const segs = (it.transcript_segments ?? []) as DiarizedSegment[];
      const map = replaceInMap(it.speaker_map ?? {}, from, to);
      if (map.count) { b.speaker_map = it.speaker_map; a.speaker_map = map.map; itemSpeakerNames += map.count; }
      if (segs.length) {
        const s = replaceInSegments(segs, from, to);
        if (s.count) { b.transcript_segments = segs; a.transcript_segments = s.segments; counts.transcripts += s.count; }
        if (s.count || map.count) {
          const rendered = renderTranscript(s.segments, map.map, it.transcript_source === "meeting" ? order : undefined);
          if (rendered !== it.transcript) { b.transcript = it.transcript; a.transcript = rendered; }
        }
      } else {
        const t = replaceWords(it.transcript, from, to);
        if (t.count) { b.transcript = it.transcript; a.transcript = t.text; counts.transcripts += t.count; }
      }
      const sum = replaceWords(it.summary, from, to);
      if (sum.count) { b.summary = it.summary; a.summary = sum.text; counts.summaries += sum.count; }
      const acts = replaceInActionItems((it.action_items ?? []) as ActionItem[], from, to);
      if (acts.count) { b.action_items = it.action_items; a.action_items = acts.items; counts.actionItems += acts.count; }
      if (Object.keys(a).length) {
        (before.items ??= {})[it.id] = b;
        (after.items ??= {})[it.id] = a;
      }
    }

    // The report: all of it, or just the topic's section.
    let report = meeting.report as string;
    if (report) {
      let next = report;
      if (opts.itemId === undefined) {
        const r = replaceWords(report, from, to);
        next = r.text; counts.report += r.count;
      } else {
        const idx = items.findIndex((it) => it.id === opts.itemId);
        const bounds = idx >= 0 ? topicSectionLines(report, items, idx) : null;
        if (bounds) {
          const lines = report.split(/\r?\n/);
          const r = replaceWords(lines.slice(bounds.start, bounds.end).join("\n"), from, to);
          counts.report += r.count;
          next = [...lines.slice(0, bounds.start), r.text, ...lines.slice(bounds.end)].join("\n");
        }
      }
      if (next !== report) { (before.meeting ??= {}).report = report; (after.meeting ??= {}).report = next; }
    }

    if (opts.itemId === undefined) {
      const mmap = replaceInMap(meeting.speaker_map ?? {}, from, to);
      if (mmap.count) {
        (before.meeting ??= {}).speaker_map = meeting.speaker_map;
        (after.meeting ??= {}).speaker_map = mmap.map;
      }
      counts.speakers = mmap.count || itemSpeakerNames;
      const guests = (await c.query("SELECT id, name FROM meeting_guests WHERE meeting_id = $1 ORDER BY id FOR UPDATE", [meetingId])).rows;
      for (const g of guests) {
        const r = replaceWords(g.name, from, to);
        if (!r.count) continue;
        (before.guests ??= {})[g.id] = { name: g.name };
        (after.guests ??= {})[g.id] = { name: r.text };
        counts.guests += r.count;
      }
    }

    if (opts.itemId !== undefined) counts.speakers = itemSpeakerNames;
    const total = Object.values(counts).reduce((n, v) => n + v, 0);
    const libraryMatches = (await listPeople(pool, true))
      .filter((p) => replaceWords(p.name, from, to).count > 0)
      .map((p) => ({ id: p.id, name: p.name }));
    if (opts.dryRun || !total || !from || from === to) {
      await c.query("ROLLBACK");
      return { counts, total, changeId: null, libraryMatches };
    }
    await writeFields(c, meetingId, after);
    const changeId = await recordChange(c, meetingId, "fix",
      `“${from}” → “${to}”: ${total} place${total === 1 ? "" : "s"}`, before, after, opts.by ?? "");
    await c.query("COMMIT");
    return { counts, total, changeId, libraryMatches };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
