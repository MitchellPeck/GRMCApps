import { Pool } from "pg";
import { ActionItem } from "./claude";
import { ItemFields, Snapshot, recordChange, writeFields } from "./changes";
import { renamedVoices, replaceInActionItems, replaceInSegments, replaceMany, replaceWords } from "./corrections";
import { listPeople } from "./people";
import { reportBodyStart, topicSectionLines } from "./report";
import { chronologicalSpeakerOrder } from "./segmentation";
import { SpeakerMap, distinctSpeakers, renderTranscript } from "./transcript";
import { DiarizedSegment } from "./whisper";

export { listChanges, undoChange } from "./changes";

// The fixes still in force (not undone) for a topic, applied to freshly
// transcribed segments, so transcribing again doesn't bring a misheard name
// back. Whole-meeting fixes and the topic's own, in the order they were made.
export async function applyActiveFixes(
  pool: Pool, meetingId: number, itemId: number, segments: DiarizedSegment[]
): Promise<DiarizedSegment[]> {
  const r = await pool.query(
    `SELECT params FROM meeting_changes
      WHERE meeting_id = $1 AND kind = 'fix' AND undone_at IS NULL ORDER BY id`,
    [meetingId]
  );
  let segs = segments;
  for (const { params } of r.rows) {
    if (!params?.from || !params?.to) continue;
    if (params.itemId !== null && params.itemId !== undefined && Number(params.itemId) !== itemId) continue;
    segs = replaceInSegments(segs, params.from, params.to).segments;
  }
  return segs;
}

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

// Apply `edit` to the part of the report about items[index]: its section, and
// its lines in the action item list (tagged "(<title>)").
function editTopicInReport<T extends { title: string }>(
  report: string,
  items: T[],
  index: number,
  edit: (text: string) => { text: string; count: number }
): { text: string; count: number } {
  const eol = report.includes("\r\n") ? "\r\n" : "\n";
  const lines = report.split(/\r?\n/);
  let count = 0;
  const bounds = index >= 0 ? topicSectionLines(report, items, index) : null;
  const title = items[index]?.title;
  const tag = title ? new RegExp(`^\\s*- \\[ \\] .*\\(${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)(\\s*<!--t:[^>]*-->)?\\s*$`) : null;
  const out = lines.map((line, i) => {
    const inSection = bounds && i >= bounds.start && i < bounds.end;
    if (!inSection && !(tag && tag.test(line))) return line;
    const r = edit(line);
    count += r.count;
    return r.text;
  });
  return { text: out.join(eol), count };
}

// The report with `edit` applied to the minutes proper, leaving the header,
// attendance and guest lines (laid out from the meeting's records) alone.
function editReportBody(report: string, edit: (text: string) => { text: string; count: number }): string {
  const lines = report.split(/\r?\n/);
  const start = reportBodyStart(lines);
  const body = edit(lines.slice(start).join("\n")).text;
  return [...lines.slice(0, start), ...(start < lines.length ? [body] : [])].join("\n");
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
      // A whole-meeting topic shares the meeting's speaker names; changing them
      // for one topic alone would be undone by the next meeting-wide save.
      const sharedNames = opts.itemId !== undefined && it.transcript_source === "meeting";
      const map = sharedNames ? { map: it.speaker_map ?? {}, count: 0 } : replaceInMap(it.speaker_map ?? {}, from, to);
      if (map.count) { b.speaker_map = it.speaker_map; a.speaker_map = map.map; itemSpeakerNames += map.count; }
      if (segs.length) {
        const ord = it.transcript_source === "meeting" ? order : undefined;
        const s = replaceInSegments(segs, from, to);
        if (s.count) { b.transcript_segments = segs; a.transcript_segments = s.segments; counts.transcripts += s.count; }
        // A transcript corrected by hand no longer matches its segments; fix its
        // own text rather than re-rendering over those corrections.
        const handEdited = renderTranscript(segs, it.speaker_map ?? {}, ord) !== it.transcript;
        if (handEdited) {
          const t = replaceWords(it.transcript, from, to);
          if (t.count) { b.transcript = it.transcript; a.transcript = t.text; }
        } else if (s.count || map.count) {
          const rendered = renderTranscript(s.segments, map.map, ord);
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
        const r = editTopicInReport(report, items, items.findIndex((it) => it.id === opts.itemId),
          (t) => replaceWords(t, from, to));
        counts.report += r.count;
        if (r.count) next = r.text;
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
      `“${from}” → “${to}”: ${total} place${total === 1 ? "" : "s"}`, before, after, opts.by ?? "",
      { from, to, itemId: opts.itemId ?? null });
    await c.query("COMMIT");
    return { counts, total, changeId, libraryMatches };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

function sortedMap(m: SpeakerMap): SpeakerMap {
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
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
export async function renameMeetingSpeakers(pool: Pool, meetingId: number, map: SpeakerMap, by = ""): Promise<number | null> {
  const before: Snapshot = { meeting: {}, items: {} }, after: Snapshot = { meeting: {}, items: {} };
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const meeting = (await c.query("SELECT report, speaker_map FROM meetings WHERE id = $1 FOR UPDATE", [meetingId])).rows[0];
    if (!meeting) throw new Error("Meeting not found.");
    if (JSON.stringify(sortedMap(meeting.speaker_map ?? {})) === JSON.stringify(sortedMap(map))) {
      await c.query("ROLLBACK");
      return null;
    }
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
    const report = editReportBody(meeting.report ?? "", (t) => replaceMany(t, pairs));
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
    if (meeting.report) {
      const r = editTopicInReport(meeting.report, all, all.findIndex((x) => x.id === itemId), (t) => replaceMany(t, pairs));
      if (r.count) { before.meeting = { report: meeting.report }; after.meeting = { report: r.text }; }
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
