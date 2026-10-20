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


// A refused or failed request (a revoked key, a missing campaign) is an error
// worth showing as itself, not an empty list.
async function mailchimpJson(res: Response): Promise<any> {
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Mailchimp answered ${res.status}: ${body.title || body.detail || "request failed"}.`);
  return body;
}

export interface CampaignSummary {
  id: string; subject: string; status: string; archiveUrl: string;
  sentAt: string; createdAt: string; issueDate: string; isDraft: boolean; dateLine: string;
}

/** The newest 30 campaigns whose subject contains `subjectMatch` (resends skipped), newest first. */
export async function listCampaigns(pool: Pool, subjectMatch: string): Promise<CampaignSummary[]> {
  const mc = await getMailchimpAuth(pool);
  const listUrl =
    mc.base +
    "/campaigns?count=30&sort_field=create_time&sort_dir=DESC" +
    "&fields=campaigns.id,campaigns.status,campaigns.settings.subject_line,campaigns.archive_url,campaigns.send_time,campaigns.create_time";
  const listRes: any = await mailchimpJson(await fetch(listUrl, { headers: mc.headers }));
  const match = subjectMatch.toLowerCase();
  const tz = (await getSetting(pool, "default_timezone")) || DEFAULT_TZ;
  return (listRes.campaigns || [])
    .filter((c: any) => {
      const subj = (c.settings?.subject_line || "").toLowerCase();
      return subj.indexOf(match) !== -1 && subj.indexOf("resend") === -1;
    })
    .map((c: any) => {
      const subject = c.settings?.subject_line || "";
      const dates: CampaignDates = { status: c.status || "", sentAt: c.send_time || "", createdAt: c.create_time || "", issueDate: parseIssueDate(subject) };
      return { id: c.id, subject, archiveUrl: c.archive_url || "", ...dates, isDraft: isDraftStatus(dates.status), dateLine: campaignDateLine(dates, tz) };
    });
}

/** A campaign's text, cleaned and trimmed the way the runs used it. */
export async function getCampaignText(pool: Pool, id: string): Promise<string> {
  const mc = await getMailchimpAuth(pool);
  const res: any = await mailchimpJson(await fetch(mc.base + "/campaigns/" + encodeURIComponent(id) + "/content?fields=plain_text", { headers: mc.headers }));
  return cleanCampaignText(res.plain_text || "").substring(0, 4000);
}
