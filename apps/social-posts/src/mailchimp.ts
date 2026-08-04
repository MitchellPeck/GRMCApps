import { Pool } from "pg";
import { getSetting } from "./settings";
import { DEFAULT_TZ, formatMonthDayYear } from "./dates";

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

const MONTH_WORDS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

// Grace Notes and blog subjects carry the issue's own date ("Grace Notes -
// August 5, 2026 - Weekly Update"). That date is the one worth showing: an
// unsent issue's create_time is just when someone started the draft, and
// labelling it "sent" was where the wrong dates came from.
export function parseIssueDate(subject: string): string {
  const s = subject || "";
  const words = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (words) {
    const idx = MONTH_WORDS.findIndex((m) => m.startsWith(words[1].toLowerCase()) && words[1].length >= 3);
    if (idx !== -1) return `${words[3]}-${String(idx + 1).padStart(2, "0")}-${String(Number(words[2])).padStart(2, "0")}`;
  }
  const numeric = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (numeric) return `${numeric[3]}-${numeric[1].padStart(2, "0")}-${numeric[2].padStart(2, "0")}`;
  return "";
}

// Mailchimp's draft status is "save" (there is no "draft"), and only sent or
// scheduled campaigns carry a send_time.
export function isDraftStatus(status: string): boolean {
  return ["sent", "sending", "schedule"].indexOf(status) === -1;
}

export interface CampaignDates {
  status: string;
  sentAt: string;
  createdAt: string;
  issueDate: string;
}

// One honest line about when this issue is dated and where it stands, e.g.
// "Issue Aug 5, 2026 · draft, created Jul 31, 2026".
export function campaignDateLine(c: CampaignDates, tz: string = DEFAULT_TZ): string {
  const parts: string[] = [];
  if (c.issueDate) parts.push("Issue " + formatMonthDayYear(c.issueDate, tz));
  if (c.status === "sent" || c.status === "sending") {
    const when = formatMonthDayYear(c.sentAt || c.createdAt, tz);
    parts.push(when ? "sent " + when : "sent");
  } else if (c.status === "schedule") {
    const when = formatMonthDayYear(c.sentAt || "", tz);
    parts.push(when ? "scheduled to send " + when : "scheduled");
  } else {
    const when = formatMonthDayYear(c.createdAt, tz);
    parts.push(when ? "draft, created " + when : "draft");
  }
  return parts.join(" · ");
}

export interface CampaignContent {
  subject: string;
  archiveUrl: string;
  status: string;
  /** Empty unless Mailchimp actually sent or scheduled the campaign. */
  sentAt: string;
  createdAt: string;
  /** Parsed out of the subject line; empty when the subject carries no date. */
  issueDate: string;
  isDraft: boolean;
  dateLine: string;
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

  const subject = target.settings.subject_line || "";
  const dates: CampaignDates = {
    status: target.status || "",
    sentAt: target.send_time || "",
    createdAt: target.create_time || "",
    issueDate: parseIssueDate(subject),
  };
  const tz = (await getSetting(pool, "default_timezone")) || DEFAULT_TZ;

  return {
    subject,
    archiveUrl: target.archive_url || "",
    ...dates,
    isDraft: isDraftStatus(dates.status),
    dateLine: campaignDateLine(dates, tz),
    preview: cleaned.substring(0, 4000),
  };
}

export function getLatestGraceNotes(pool: Pool, beforeDate: string | null): Promise<CampaignContent> {
  return getLatestCampaign(pool, "grace notes", beforeDate);
}

export function getLatestBlog(pool: Pool): Promise<CampaignContent> {
  return getLatestCampaign(pool, "weekly blog", null);
}
