import { Pool } from "pg";
import { VOICE } from "./voice";
import { callClaude, stripJsonFences } from "./claude";
import { getActiveSeriesThursdayItem, updateSeriesPostField } from "./series";
import { getLatestGraceNotes, getLatestBlog, CampaignContent } from "./mailchimp";
import { savePostDrafts } from "./drafts";

export async function draftMondayPosts(pool: Pool, params: any, createdBy: string): Promise<any> {
  try {
    const thu = await getActiveSeriesThursdayItem(pool, params.date);
    const lines: string[] = ["Draft three GRMC social posts.", "", VOICE, "", "--- CONTEXT ---",
      "SUNDAY DATE: " + (params.date || "this past Sunday"), "SERMON TITLE: " + params.sermon];
    if (params.pulpit)     { lines.push("", "PULPIT AI SUMMARY:", params.pulpit); }
    if (params.events)     { lines.push("", "UPCOMING EVENTS:", params.events); }
    if (params.highlights) { lines.push("", "PEOPLE / HIGHLIGHTS:", params.highlights); }
    if (thu) {
      lines.push("", "THURSDAY SERIES - post " + (thu.postIdx + 1) + " of " + thu.total + " (" + thu.date + ') from series "' + thu.seriesName + '":');
      lines.push(thu.title + " - " + thu.sub);
    }
    lines.push("", "--- POSTS TO DRAFT ---", "",
      "1. MONDAY - Service recap", "Celebratory, invites people who missed to feel the energy. Reference sermon theme meaningfully.",
      "", "2. TUESDAY - Upcoming events", "Highlight 1-2 events max. Clear CTA with date/time/location.");
    if (thu) {
      lines.push("", "3. THURSDAY - " + thu.seriesName + " series post (" + thu.date + ")",
        "Topic: " + thu.title + ". Angle: " + thu.sub,
        "Educational but not lecture-y. Next chapter in an unfolding story. Series context: " + thu.context);
    } else {
      lines.push("", "3. THURSDAY - no active series post scheduled for this week. Write a general GRMC community post.");
    }
    const sys = 'You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. Return ONLY a JSON object with keys "monday", "tuesday", "thursday" each a string. No markdown fences, just valid JSON.';
    const posts = JSON.parse(stripJsonFences(await callClaude(pool, sys, lines.join("\n"))));
    await savePostDrafts(pool, "monday", params.date || "", posts, createdBy);
    if (thu) await updateSeriesPostField(pool, thu.seriesId, thu.postIdx, "status", "drafted");
    return { ok: true, posts, seriesLabel: thu ? "Post " + (thu.postIdx + 1) + " of " + thu.total + ": " + thu.title : "" };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
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
    return { ok: true, posts, mailchimpFetched: !!graceNotes, mailchimpError, archiveUrl, subject, sentAt: graceNotes ? graceNotes.sentAt : "" };
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
    return { ok: true, posts, mailchimpFetched: !!blog, mailchimpError, archiveUrl, subject, sentAt: blog ? blog.sentAt : "" };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
