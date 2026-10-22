// Where a post's source material comes from: the Mailchimp issue the profile
// points at for this post's date, the Buzzsprout episode it's pinned to, or
// text someone pasted. Fetched only when asked (opening the editor's source
// panel, or drafting), never on a schedule.
import { Pool } from "pg";
import { addDays } from "../dates";
import { CampaignSummary, getCampaignText, listCampaigns } from "../mailchimp";
import { getEpisode } from "../buzzsprout";
import { Cutoff, SourceConfig, SourceRef } from "./drafting";
import { SourceContent } from "./prompt";
import { SermonOpts, durationLabel, getSermon, notReadyMessage, sermonOpts } from "./sermons";
import { startEpisodeTranscript } from "./episode-audio";

/** The last day an issue may have been created on, or null for "newest". */
export function cutoffDate(cutoff: Cutoff, postDate: string | null): string | null {
  if (!postDate || cutoff === "latest") return null;
  if (cutoff === "postDate") return postDate;
  const dow = new Date(postDate + "T12:00:00Z").getUTCDay();
  return addDays(postDate, (7 - dow) % 7);
}

/**
 * The issue a post should draft from: the newest created on or before the
 * cutoff, else the newest overall (what the runs did when nothing was old
 * enough). `campaigns` is newest first.
 */
export function pickCampaign(campaigns: CampaignSummary[], cutoff: Cutoff, postDate: string | null): CampaignSummary | null {
  if (!campaigns.length) return null;
  const day = cutoffDate(cutoff, postDate);
  if (!day) return campaigns[0];
  const limit = new Date(day + "T23:59:59");
  return campaigns.find((c) => new Date(c.createdAt) <= limit) || campaigns[0];
}

/**
 * The content Draft with Claude should use for a post. A stored ref (a picked
 * campaign or episode, or pasted text) wins over the profile; otherwise a
 * Mailchimp profile picks by date. A Buzzsprout profile with no pinned episode
 * returns null: the editor asks which episode.
 */
export async function resolveSource(
  pool: Pool, source: SourceConfig, ref: SourceRef | null, postDate: string | null, opts: SermonOpts = sermonOpts(),
): Promise<SourceContent | null> {
  if (ref?.kind === "manual") {
    return { kind: "manual", id: "", title: ref.title || "Pasted content", url: ref.url || "", date: "", dateLine: "", content: ref.content || "" };
  }
  // A video post drafts from the recording uploaded to it (kind "sermon" is
  // the stored name: it began as sermons only). An upload is this post's own
  // choice, like pasted text, so it counts whatever the event's source is.
  // Until there is one there's nothing to draft from; until it's transcribed, say so.
  if (ref?.kind === "sermon" || (!ref && source.kind === "sermon")) {
    if (!ref?.id) return null;
    const s = await getSermon(pool, ref.id);
    if (!s) throw new Error("That video is gone. Upload it again.");
    if (s.status !== "ready") throw new Error(notReadyMessage(s));
    return { kind: "sermon", id: s.id, title: s.title, url: "", date: "", dateLine: durationLabel(s.durationSeconds) + " recording",
             content: s.transcript.slice(0, 60000) };
  }
  // "Don't use the event's source for this post" outranks an issue or episode stored earlier.
  if (source.kind === "none") return null;
  if (ref?.kind === "buzzsprout" || (!ref && source.kind === "buzzsprout")) {
    if (!ref?.id) return null;
    const ep = await getEpisode(pool, ref.id);
    const out: SourceContent = {
      kind: "buzzsprout", id: String(ep.id), title: ep.title, url: ep.listenUrl, date: ep.publishDate, dateLine: ep.dateLine,
      content: ep.description, notYetPublic: !ep.isPublished, durationLabel: ep.durationLabel,
    };
    // The audio is transcribed once per episode, starting the first time anyone looks.
    if (ep.audioUrl) {
      const rec = await startEpisodeTranscript(pool, ep, opts);
      out.audio = { id: rec.id, status: rec.status, progress: rec.progress, error: rec.error };
      if (rec.status === "ready") out.transcript = rec.transcript.slice(0, 60000);
    }
    return out;
  }
  if (ref?.kind === "mailchimp" || source.kind === "mailchimp") {
    let summary: CampaignSummary | null = null;
    if (ref?.kind === "mailchimp" && ref.id) {
      const recent = source.kind === "mailchimp" ? await listCampaigns(pool, source.subjectContains || "") : [];
      summary = recent.find((c) => c.id === ref.id) || {
        id: ref.id, subject: ref.title || "Mailchimp campaign", status: "sent", archiveUrl: ref.url || "",
        sentAt: "", createdAt: "", issueDate: ref.date || "", isDraft: false, dateLine: "",
      };
    } else {
      const matches = await listCampaigns(pool, source.subjectContains || "");
      if (!matches.length) throw new Error(`No Mailchimp campaigns with "${source.subjectContains}" in the subject.`);
      summary = pickCampaign(matches, source.cutoff || "latest", postDate);
    }
    if (!summary) return null;
    return {
      kind: "mailchimp", id: summary.id, title: summary.subject, url: summary.archiveUrl, date: summary.issueDate,
      dateLine: summary.dateLine, content: await getCampaignText(pool, summary.id), isDraft: summary.isDraft,
    };
  }
  return null;
}
