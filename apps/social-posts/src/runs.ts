import { Pool } from "pg";
import { VOICE } from "./voice";
import { callClaude, stripJsonFences } from "./claude";
import { getLatestGraceNotes, getLatestBlog, CampaignContent } from "./mailchimp";
import { savePostDrafts } from "./drafts";
import { podcastScheduleDates, scheduleDatesFor } from "./schedule";
import { Episode, getEpisode } from "./buzzsprout";
import { anglesBlock, jsonKeysHint, selectAngles } from "./podcast-angles";

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

// What the UI needs to caption the chosen episode without re-deriving it.
function episodeSummary(e: Episode | null) {
  if (!e) return null;
  return {
    title: e.title, label: e.label, dateLine: e.dateLine, isPublished: e.isPublished,
    isPrivate: e.isPrivate, publishDate: e.publishDate, listenUrl: e.listenUrl,
    durationLabel: e.durationLabel,
  };
}

export async function draftPodcastPosts(pool: Pool, params: any, createdBy: string): Promise<any> {
  const angles = selectAngles(params.angles || []);
  if (!angles.length) return { ok: false, error: "Pick at least one angle to draft." };
  try {
    let episode: Episode | null = null; let buzzsproutError: string | null = null;
    if (params.episodeId) {
      try { episode = await getEpisode(pool, params.episodeId); }
      catch (e) { buzzsproutError = (e as Error).message; }
    }
    const title       = params.title       || (episode ? episode.title       : "");
    const listenUrl   = params.listenUrl   || (episode ? episode.listenUrl   : "(not provided)");
    const contentText = params.content     || (episode ? episode.description : "");
    const publishDate = params.publishDate || (episode ? episode.publishDate : "");

    const lines: string[] = [
      `Draft ${angles.length} GRMC social media ${angles.length === 1 ? "post" : "posts"} promoting one podcast episode.`,
      "", VOICE, "",
      "--- CONTEXT ---",
      "EPISODE TITLE: " + (title || "(not available)"),
      "LISTEN URL: " + listenUrl,
    ];
    if (episode && episode.durationLabel) lines.push("EPISODE LENGTH: " + episode.durationLabel);
    // An episode drafted ahead of its drop must not be announced as already out.
    if (episode && !episode.isPublished) {
      lines.push("NOT YET PUBLIC: this episode is " + episode.dateLine + ". Write as though it is landing, not as though it is already out.");
    }
    lines.push("", "EPISODE DESCRIPTION:", contentText || "(not provided)");
    lines.push("", "--- POSTS TO DRAFT ---", "", anglesBlock(angles));
    lines.push("", "Each post stands alone. Do not number them or refer to the others.");

    const sys = "You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. "
      + `Return ONLY a JSON object with keys ${jsonKeysHint(angles)}, each a string holding that post's text. `
      + "No markdown fences, just valid JSON.";
    const posts = JSON.parse(stripJsonFences(await callClaude(pool, sys, lines.join("\n"))));
    await savePostDrafts(pool, "podcast", publishDate, posts, createdBy);
    return {
      ok: true, posts, buzzsproutFetched: !!episode, buzzsproutError, listenUrl, title,
      episode: episodeSummary(episode),
      dates: podcastScheduleDates(angles, publishDate),
    };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
