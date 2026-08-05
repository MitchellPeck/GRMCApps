import { Pool } from "pg";
import { VOICE } from "./voice";
import { callClaude, stripJsonFences } from "./claude";
import { getLatestGraceNotes, getLatestBlog, CampaignContent } from "./mailchimp";
import { savePostDrafts } from "./drafts";
import { scheduleDatesFor } from "./schedule";

// What the UI needs to caption a fetched campaign without re-deriving it.
function campaignSummary(c: CampaignContent | null) {
  if (!c) return null;
  return {
    status: c.status, isDraft: c.isDraft, dateLine: c.dateLine,
    issueDate: c.issueDate, sentAt: c.sentAt, createdAt: c.createdAt,
  };
}

export async function draftWedPosts(pool: Pool, params: any, createdBy: string): Promise<any> {
  try {
    let graceNotes: CampaignContent | null = null; let mailchimpError: string | null = null;
    if (!params.manualUrl) {
      try { graceNotes = await getLatestGraceNotes(pool, params.sundayDate || null); }
      catch (e) { mailchimpError = (e as Error).message; }
    }
    const archiveUrl  = params.manualUrl || (graceNotes ? graceNotes.archiveUrl : "(not provided)");
    const contentText = params.content   || (graceNotes ? graceNotes.preview    : "");
    const subject     = graceNotes ? graceNotes.subject : "";
    const sundayLabel = params.sundayDate ? "Sunday " + params.sundayDate : "this Sunday";
    const lines = ["Draft two GRMC social posts.", "", VOICE, "", "--- CONTEXT ---",
      "UPCOMING SUNDAY DATE: " + sundayLabel,
      "GRACE NOTES SUBJECT: " + (subject || "(not available)"),
      "GRACE NOTES ARCHIVE URL: " + archiveUrl, "", "GRACE NOTES CONTENT:", contentText || "(not provided)", "",
      "THIS SUNDAY SERVICE PREVIEW:", params.service || "(not provided - write a warm general invite to Sunday 11am worship)",
      "", "--- POSTS TO DRAFT ---", "",
      "1. WEDNESDAY - Grace Notes post",
      "Warm summary of what is inside this week Grace Notes. End with the archive link. Make people feel there is something worth reading, not just a notification.",
      "", "2. SATURDAY - Invite and preview",
      "Anticipatory invite for " + sundayLabel + " service. Warm, specific to what is happening. Should make someone who has not been in a while feel welcomed back."];
    const sys = 'You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. Return ONLY a JSON object with keys "wednesday" and "saturday" each a string. No markdown fences, just valid JSON.';
    const posts = JSON.parse(stripJsonFences(await callClaude(pool, sys, lines.join("\n"))));
    await savePostDrafts(pool, "wednesday", params.sundayDate || "", posts, createdBy);
    return {
      ok: true, posts, mailchimpFetched: !!graceNotes, mailchimpError, archiveUrl, subject,
      campaign: campaignSummary(graceNotes),
      dates: await scheduleDatesFor(pool, Object.keys(posts)),
    };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function draftFridayPost(pool: Pool, params: any, createdBy: string): Promise<any> {
  try {
    let blog: CampaignContent | null = null; let mailchimpError: string | null = null;
    if (!params.manualUrl) {
      try { blog = await getLatestBlog(pool); }
      catch (e) { mailchimpError = (e as Error).message; }
    }
    const archiveUrl  = params.manualUrl || (blog ? blog.archiveUrl : "(not provided)");
    const contentText = params.content   || (blog ? blog.preview    : "");
    const subject     = blog ? blog.subject : "";
    const lines = [
      "Draft one GRMC social media post promoting this week's blog post.", "", VOICE, "",
      "--- CONTEXT ---",
      "BLOG POST SUBJECT: " + (subject || params.subject || "(not available)"),
      "BLOG ARCHIVE URL: " + archiveUrl,
      "", "BLOG CONTENT:", contentText || "(not provided)",
      "", "--- POST TO DRAFT ---", "",
      "FRIDAY - Weekly blog post",
      "Tease the most compelling idea or question from the blog. Make someone want to read it.",
      "End with the archive URL on its own line.",
      "Do not summarize everything — hook with one strong thread.",
    ];
    const sys = 'You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. Return ONLY a JSON object with key "friday" containing the post text string. No markdown fences, just valid JSON.';
    const posts = JSON.parse(stripJsonFences(await callClaude(pool, sys, lines.join("\n"))));
    await savePostDrafts(pool, "friday", params.date || "", posts, createdBy);
    return {
      ok: true, posts, mailchimpFetched: !!blog, mailchimpError, archiveUrl, subject,
      campaign: campaignSummary(blog),
      dates: await scheduleDatesFor(pool, Object.keys(posts)),
    };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
