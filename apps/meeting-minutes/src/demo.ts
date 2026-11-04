// The walkthrough's practice meeting: a real meeting row, seen only by the
// person it was made for, with four practice people who never join the shared
// People list. Two topics come already recorded, named and summarized, so the
// tour works with no microphone and no API key; the third is empty, for the
// user to record into if they want to.
// Spec: docs/superpowers/specs/2026-09-17-meeting-minutes-walkthrough-design.md
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { deleteMeeting } from "./meetings";
import { chronologicalSpeakerOrder } from "./segmentation";
import { renderTranscript } from "./transcript";
import { DiarizedSegment } from "./whisper";

export const PRACTICE_TITLE = "PRACTICE — April Board Meeting";

const PEOPLE = [
  { key: "dale", name: "Dale Whitcomb", title: "Pastor" },
  { key: "marian", name: "Marian Webb", title: "Treasurer" },
  { key: "tom", name: "Tom Ross", title: "Trustees Chair" },
  { key: "joyce", name: "Joyce Alden", title: "Secretary" },
];

// Seeded voices use SPEAKER_10 and up. A real recording's voices are numbered
// from SPEAKER_00, so the user's own practice take never merges into one.
const VOICES: Record<string, string> = { SPEAKER_10: "Dale Whitcomb", SPEAKER_11: "Marian Webb", SPEAKER_12: "Tom Ross" };

const seg = (speaker: string, start: number, end: number, text: string): DiarizedSegment => ({ speaker, start, end, text });

const TOPICS = [
  {
    title: "Welcome & devotion",
    presenter: "dale",
    segments: [
      seg("SPEAKER_10", 0, 9, "Good evening, everyone, and thank you for coming out on a rainy Monday."),
      seg("SPEAKER_10", 9, 24, "Let's open with a short reading from Psalm 133: how good and pleasant it is when God's people live together in unity."),
      seg("SPEAKER_10", 24, 36, "Let's pray. Lord, guide our conversation tonight and help us serve this congregation well. Amen."),
    ],
    summary: "Pastor Dale welcomed the board, read from Psalm 133 on unity, and opened the meeting in prayer.",
    actions: [] as Array<{ task: string; owner: string }>,
  },
  {
    title: "Budget review",
    presenter: "marian",
    segments: [
      seg("SPEAKER_11", 40, 55, "Giving for the first quarter came in at forty-two thousand, which is about four percent ahead of budget."),
      seg("SPEAKER_11", 55, 70, "Utilities ran over by about nine hundred dollars because of the cold February, but everything else is on track."),
      seg("SPEAKER_12", 70, 82, "Does that leave room for the roof repair if the quote comes in where we expect?"),
      seg("SPEAKER_11", 82, 98, "It should, if it's under twelve thousand. I'll send everyone the full April report before the next meeting."),
      seg("SPEAKER_12", 98, 108, "Good. I'll get two more quotes so we have something to compare."),
    ],
    summary: "Marian reported first-quarter giving of $42,000, about 4% ahead of budget; utilities were $900 over because of a cold February. "
      + "The budget can cover the roof repair if the quote is under $12,000.",
    actions: [
      { task: "Send the full April financial report to the board", owner: "Marian Webb" },
      { task: "Get two more quotes for the roof repair", owner: "Tom Ross" },
    ],
  },
  { title: "Building repairs — roof quote", presenter: "tom", segments: [] as DiarizedSegment[], summary: "", actions: [] as Array<{ task: string; owner: string }> },
];

// Practice people carry reserved addresses, unique to their owner, so one
// person's reset never touches another's practice meeting and a real person
// can never be merged into a practice one.
function demoEmail(key: string, ownerEmail: string): string {
  const tag = createHash("sha1").update(ownerEmail.toLowerCase()).digest("hex").slice(0, 10);
  return `${key}.${tag}@practice.invalid`;
}

export async function practiceMeetingId(pool: Pool, ownerEmail: string): Promise<number | null> {
  const r = await pool.query(
    "SELECT id FROM meetings WHERE is_demo AND created_by_email = $1 ORDER BY id DESC LIMIT 1", [ownerEmail]
  );
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

// The practice meeting and its people, gone.
export async function deletePractice(pool: Pool, ownerEmail: string): Promise<void> {
  const r = await pool.query("SELECT id FROM meetings WHERE is_demo AND created_by_email = $1", [ownerEmail]);
  for (const row of r.rows) await deleteMeeting(pool, Number(row.id));
  await pool.query("DELETE FROM people WHERE is_demo AND email = ANY($1)", [PEOPLE.map((p) => demoEmail(p.key, ownerEmail))]);
}

// A fresh practice meeting for this person, replacing any they had.
export async function seedPractice(pool: Pool, owner: { email: string; name: string }): Promise<number> {
  await deletePractice(pool, owner.email);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids: Record<string, number> = {};
    for (const p of PEOPLE) {
      const r = await client.query(
        "INSERT INTO people (name, email, title, active, is_demo, learn_voice) VALUES ($1, $2, $3, true, true, false) RETURNING id",
        [p.name, demoEmail(p.key, owner.email), p.title]
      );
      ids[p.key] = Number(r.rows[0].id);
    }
    const m = await client.query(
      `INSERT INTO meetings (title, meeting_date, location, description, created_by_email, created_by_name, speaker_map, is_demo)
       VALUES ($1, 'Apr 14, 7:00pm', 'Fellowship Hall', 'A practice meeting for the walkthrough. Change anything; delete it when you’re done.', $2, $3, $4, true)
       RETURNING id`,
      [PRACTICE_TITLE, owner.email, owner.name, JSON.stringify(VOICES)]
    );
    const meetingId = Number(m.rows[0].id);
    for (const p of PEOPLE) {
      await client.query("INSERT INTO meeting_attendees (meeting_id, person_id) VALUES ($1, $2)", [meetingId, ids[p.key]]);
    }
    const order = chronologicalSpeakerOrder(TOPICS.map((t) => t.segments));
    for (let i = 0; i < TOPICS.length; i++) {
      const t = TOPICS[i];
      const recorded = t.segments.length > 0;
      const it = await client.query(
        `INSERT INTO agenda_items (meeting_id, position, title, transcript, transcript_segments, speaker_map, summary,
                                   action_items, status, transcribe_status, transcript_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [meetingId, i, t.title,
         recorded ? renderTranscript(t.segments, VOICES, order) : "",
         JSON.stringify(t.segments), JSON.stringify(recorded ? VOICES : {}), t.summary, JSON.stringify(t.actions),
         t.summary ? "done" : "pending", recorded ? "done" : "idle", recorded ? "meeting" : ""]
      );
      await client.query("INSERT INTO agenda_item_presenters (item_id, person_id) VALUES ($1, $2)",
        [Number(it.rows[0].id), ids[t.presenter]]);
    }
    await client.query("COMMIT");
    return meetingId;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
