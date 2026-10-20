// What the old Wednesday/Friday/Podcast runs and series drafting said to
// Claude, carried over word for word so drafts don't change when the runs
// become profiles. Seeded once by migrate-drafting.ts; editable afterwards.
import { Profile } from "./drafting";

export const DEFAULT_VOICE = "GRMC voice rules: short, punchy, warm but not stiff. Salutations ('Family of Grace', 'Hey everyone') should be used sparingly, and rarely on content for both members and guests. Salutations are acceptible on posts that are more towards members. Open as an invitation, not insider communication. 2-4 sentences, line breaks between thoughts. No hashtags unless natural. Sentence case. No em-dashes as decoration.";

export const GRACE_NOTES_PROFILE: Profile = {
  source: { kind: "mailchimp", subjectContains: "grace notes", cutoff: "followingSunday" },
  instructions: "Warm summary of what is inside this week Grace Notes. End with the archive link. Make people feel there is something worth reading, not just a notification.",
};

// The run's "service preview" box is now the post's brief.
export const SUNDAY_PROFILE: Profile = {
  source: { kind: "none" },
  instructions: "Anticipatory invite for this Sunday's service. Warm, specific to what is happening. Should make someone who has not been in a while feel welcomed back. The brief has this Sunday's service details; if it has none, write a warm general invite to Sunday 11am worship.",
};

export const BLOG_PROFILE: Profile = {
  source: { kind: "mailchimp", subjectContains: "weekly blog", cutoff: "latest" },
  instructions: "Tease the most compelling idea or question from the blog. Make someone want to read it. End with the archive URL on its own line. Do not summarize everything — hook with one strong thread.",
};

export const PODCAST_PROFILE: Profile = {
  source: { kind: "buzzsprout" },
  instructions: "Promote this podcast episode. Each post stands alone. Do not number them or refer to the others.",
  angles: [
    { key: "announcement", label: "Announcement", offsetDays: 0,
      instructions: "The episode is out. Open with the most compelling thread in it, name the guest if there is one, and end with the listen link on its own line. Make someone want to press play, not merely know it exists." },
    { key: "question", label: "The question it wrestles with", offsetDays: 2,
      instructions: "Lead with the real question this episode sits with. Ask it plainly and let it breathe, then point to the episode as where it gets worked through. Do not answer it in the post." },
    { key: "quote", label: "Pull quote", offsetDays: 4,
      instructions: "One striking line or idea from the episode, framed so it stands on its own. Keep it short. Attribute it when there is a clear speaker. Close with the listen link." },
    { key: "guest", label: "Guest or topic spotlight", offsetDays: 1,
      instructions: "Introduce who is on this episode, or what it digs into when there is no guest, and why this person or subject is worth an hour of someone's attention." },
    { key: "invite", label: "Invite to Sunday", offsetDays: 5,
      instructions: "Connect the episode's theme to gathering on Sunday at 11am. Warm, never a hard sell. It should read as an open door to someone who has never walked through it." },
  ],
};

export const SERIES_INSTRUCTIONS = "Write it as the next chapter in an unfolding story, not a standalone fact post. Tone: educational but not lecture-y, warm, inviting, makes people want to follow along.";

// From series.ts generateSeriesPostsWithClaude, with dates asked for as
// YYYY-MM-DD so they land straight on the calendar.
export function SERIES_PLAN_PROMPT(p: { name: string; description: string; context: string; count: number; cadence: string; startDate: string }): string[] {
  return [
    `Generate a post schedule for a social media series called "${p.name}".`,
    "Description: " + p.description,
    "Context: " + p.context,
    "Number of posts: " + p.count,
    "Cadence: " + (p.cadence || "weekly"),
    "Start date: " + (p.startDate || "TBD"),
    "",
    "Return ONLY a JSON array of objects, each with: date (YYYY-MM-DD), phase (string, group label or empty), title (short post title), sub (angle/description for this post, 1-2 sentences).",
    "Plan the arc: build toward a conclusion, group into 2-3 phases if it makes sense.",
    "No markdown fences, just valid JSON array.",
  ];
}
