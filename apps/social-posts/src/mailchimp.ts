import { Pool } from "pg";
import { getSetting } from "./settings";

// Identical to the Code.gs header/footer stripping, factored into one function.
export function cleanCampaignText(plainText: string): string {
  let cleaned = plainText || "";
  const hrIdx = cleaned.indexOf("----");
  if (hrIdx !== -1) {
    const afterHr = cleaned.indexOf("\n", hrIdx);
    if (afterHr !== -1) cleaned = cleaned.substring(afterHr + 1).trim();
  }
  const footerMarkers = ["*|IF:REWARDS|*", "Unsubscribe", "unsubscribe", "*|UNSUB|*", "Copyright ©"];
  for (const marker of footerMarkers) {
    const fIdx = cleaned.indexOf(marker);
    if (fIdx !== -1 && fIdx > cleaned.length * 0.5) {
      cleaned = cleaned.substring(0, fIdx).trim();
      break;
    }
  }
  return cleaned;
}

interface MailchimpAuth { base: string; headers: Record<string, string>; }

async function getMailchimpAuth(pool: Pool): Promise<MailchimpAuth> {
  const key = await getSetting(pool, "mailchimp_api_key");
  const server = await getSetting(pool, "mailchimp_server");
  if (!key || !server) throw new Error("Mailchimp credentials not configured. Go to Settings.");
  return {
    base: `https://${server}.api.mailchimp.com/3.0`,
    headers: { Authorization: "Basic " + Buffer.from("anystring:" + key).toString("base64") },
  };
}

export interface CampaignContent {
  subject: string;
  archiveUrl: string;
  status: string;
  sentAt: string;
  preview: string;
}

async function getLatestCampaign(
  pool: Pool,
  subjectMatch: string,
  beforeDate: string | null
): Promise<CampaignContent> {
  const mc = await getMailchimpAuth(pool);
  const listUrl =
    mc.base +
    "/campaigns?count=30&sort_field=create_time&sort_dir=DESC" +
    "&fields=campaigns.id,campaigns.status,campaigns.settings.subject_line,campaigns.archive_url,campaigns.send_time,campaigns.create_time";
  const listRes: any = await (await fetch(listUrl, { headers: mc.headers })).json();
  const campaigns: any[] = listRes.campaigns || [];
  const matches = campaigns.filter((c) => {
    const subj = (c.settings?.subject_line || "").toLowerCase();
    return subj.indexOf(subjectMatch) !== -1 && subj.indexOf("resend") === -1;
  });
  if (!matches.length) throw new Error(`No ${subjectMatch} campaigns found in Mailchimp.`);

  let target = matches[0];
  if (beforeDate) {
    const cutoff = new Date(beforeDate + "T23:59:59");
    for (const c of matches) {
      if (new Date(c.create_time) <= cutoff) { target = c; break; }
    }
  }

  const contentRes: any = await (
    await fetch(mc.base + "/campaigns/" + target.id + "/content?fields=plain_text", { headers: mc.headers })
  ).json();
  const cleaned = cleanCampaignText(contentRes.plain_text || "");

  return {
    subject: target.settings.subject_line,
    archiveUrl: target.archive_url || "",
    status: target.status,
    sentAt: target.send_time || target.create_time,
    preview: cleaned.substring(0, 4000),
  };
}

export function getLatestGraceNotes(pool: Pool, beforeDate: string | null): Promise<CampaignContent> {
  return getLatestCampaign(pool, "grace notes", beforeDate);
}

export function getLatestBlog(pool: Pool): Promise<CampaignContent> {
  return getLatestCampaign(pool, "weekly blog", null);
}
