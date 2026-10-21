import { Pool } from "pg";
import { ActionItem } from "./claude";
import { ItemFields, Snapshot, recordChange, writeFields } from "./changes";
import { renamedVoices, replaceInActionItems, replaceInSegments, replaceMany, replaceWords } from "./corrections";
import { listPeople } from "./people";
import { topicSectionLines } from "./report";
import { chronologicalSpeakerOrder } from "./segmentation";
import { SpeakerMap, distinctSpeakers, renderTranscript } from "./transcript";
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

function renameSummary(pairs: Array<{ from: string; to: string }>): string {
  return pairs.length ? pairs.map((p) => `“${p.from}” → “${p.to}”`).join(", ") : "Speaker names updated";
}

function renameActions(items: ActionItem[], pairs: Array<{ from: string; to: string }>): ActionItem[] {
  return items.map((a) => ({ ...a, owner: replaceMany(a.owner, pairs).text }));
}

// A meeting-wide speaker rename once the minutes exist: transcripts relabel,
// and the old names become the new ones where the minutes credit them —
// summaries, action-item owners, the report. Nothing is rewritten from
// scratch. Recorded so it can be undone.
export async function renameMeetingSpeakers(pool: Pool, meetingId: number, map: SpeakerMap, by = ""): Promise<number> {
  const before: Snapshot = { meeting: {}, items: {} }, after: Snapshot = { meeting: {}, items: {} };
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const meeting = (await c.query("SELECT report, speaker_map FROM meetings WHERE id = $1 FOR UPDATE", [meetingId])).rows[0];
    const items = (await c.query(
      `SELECT id, transcript, transcript_segments, summary, action_items, speaker_map FROM agenda_items
        WHERE meeting_id = $1 AND transcript_source = 'meeting' ORDER BY position, id FOR UPDATE`,
      [meetingId]
    )).rows;
    const order = chronologicalSpeakerOrder(items.map((it) => it.transcript_segments as DiarizedSegment[]));
    const pairs = renamedVoices(meeting.speaker_map ?? {}, map, order);
    before.meeting!.speaker_map = meeting.speaker_map; after.meeting!.speaker_map = map;
    for (const it of items) {
      const b: ItemFields = { speaker_map: it.speaker_map }, a: ItemFields = { speaker_map: map };
      const transcript = renderTranscript(it.transcript_segments, map, order);
      if (transcript !== it.transcript) { b.transcript = it.transcript; a.transcript = transcript; }
      const summary = replaceMany(it.summary, pairs).text;
      if (summary !== it.summary) { b.summary = it.summary; a.summary = summary; }
      const actions = renameActions(it.action_items ?? [], pairs);
      if (JSON.stringify(actions) !== JSON.stringify(it.action_items ?? [])) { b.action_items = it.action_items; a.action_items = actions; }
      before.items![it.id] = b; after.items![it.id] = a;
    }
    const report = replaceMany(meeting.report ?? "", pairs).text;
    if (report !== meeting.report) { before.meeting!.report = meeting.report; after.meeting!.report = report; }
    await writeFields(c, meetingId, after);
    const id = await recordChange(c, meetingId, "rename", renameSummary(pairs), before, after, by);
    await c.query("COMMIT");
    return id;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

// The same for one topic's own speaker names: that topic's transcript,
// summary, action items, and its section of the report.
export async function renameTopicSpeakers(pool: Pool, itemId: number, map: SpeakerMap, by = ""): Promise<{ changeId: number }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const it = (await c.query(
      "SELECT id, meeting_id, transcript, transcript_segments, summary, action_items, speaker_map FROM agenda_items WHERE id = $1 FOR UPDATE",
      [itemId]
    )).rows[0];
    if (!it) throw new Error("Agenda item not found.");
    const meetingId = Number(it.meeting_id);
    const meeting = (await c.query("SELECT report FROM meetings WHERE id = $1 FOR UPDATE", [meetingId])).rows[0];
    const all = (await c.query("SELECT id, title FROM agenda_items WHERE meeting_id = $1 ORDER BY position, id", [meetingId])).rows
      .map((r) => ({ id: Number(r.id), title: r.title as string }));
    const segs = (it.transcript_segments ?? []) as DiarizedSegment[];
    const order = distinctSpeakers(segs);
    const pairs = renamedVoices(it.speaker_map ?? {}, map, order);
    const b: ItemFields = { speaker_map: it.speaker_map }, a: ItemFields = { speaker_map: map };
    const transcript = renderTranscript(segs, map, order);
    if (transcript !== it.transcript) { b.transcript = it.transcript; a.transcript = transcript; }
    const summary = replaceMany(it.summary, pairs).text;
    if (summary !== it.summary) { b.summary = it.summary; a.summary = summary; }
    const actions = renameActions(it.action_items ?? [], pairs);
    if (JSON.stringify(actions) !== JSON.stringify(it.action_items ?? [])) { b.action_items = it.action_items; a.action_items = actions; }
    const before: Snapshot = { items: { [itemId]: b } }, after: Snapshot = { items: { [itemId]: a } };
    const bounds = meeting.report ? topicSectionLines(meeting.report, all, all.findIndex((x) => x.id === itemId)) : null;
    if (bounds) {
      const lines = (meeting.report as string).split(/\r?\n/);
      const section = replaceMany(lines.slice(bounds.start, bounds.end).join("\n"), pairs).text;
      const report = [...lines.slice(0, bounds.start), section, ...lines.slice(bounds.end)].join("\n");
      if (report !== meeting.report) { before.meeting = { report: meeting.report }; after.meeting = { report }; }
    }
    await writeFields(c, meetingId, after);
    const changeId = await recordChange(c, meetingId, "rename", renameSummary(pairs), before, after, by);
    await c.query("COMMIT");
    return { changeId };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
