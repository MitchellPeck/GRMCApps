// The weekly Grace Notes clock: create the issue, then remind contributors, on a schedule from settings.
import { Pool } from "pg";
import { DEFAULT_TZ, localDateIn, localTimeIn, weekdayOf } from "../dates";
import { getSetting } from "../settings";
import { contributorStatus, createIssue, fillOpenIssues, listIssues, liveIssue, nextIssueDate } from "./issues";
import { FetchFn, remind } from "./mail";

export interface Schedule {
  sendDow: number; createDow: number; createAt: string; remindDow: number; remindAt: string; deadlineDow: number; deadlineAt: string;
}
export type Action = { kind: "create" | "monday" | "deadline"; issueDate: string };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const scheduleFrom = (sendDow: number, createAt: string, remindAt: string, deadlineAt: string): Schedule => ({
  sendDow, createDow: (sendDow + 4) % 7, createAt, remindDow: (sendDow + 5) % 7, remindAt, deadlineDow: (sendDow + 6) % 7, deadlineAt,
});

export async function loadSchedule(db: Pool): Promise<Schedule> {
  const raw = (await getSetting(db, "gn_send_dow")).trim();
  const dow = raw === "" ? 3 : Number(raw);
  const t = async (k: string, d: string) => { const v = (await getSetting(db, k)).trim(); return TIME.test(v) ? v : d; };
  return scheduleFrom(Number.isInteger(dow) && dow >= 0 && dow <= 6 ? dow : 3,
    await t("gn_create_at", "18:00"), await t("gn_remind_at", "08:00"), await t("gn_deadline_at", "12:00"));
}

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** The contributor page's "please check by …" words, e.g. "Tue noon" or "Tue 3pm". */
export function deadlineLabel(s: Schedule): string {
  const [h, m] = s.deadlineAt.split(":").map(Number);
  const time = s.deadlineAt === "12:00" ? "noon" : `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
  return `${SHORT_DAYS[s.deadlineDow]} ${time}`;
}

/** What is due at this local date/time. Later days in the window also return earlier steps, so missed ticks catch up. */
export function dueActions(now: { date: string; time: string }, s: Schedule, hasEarlierIssue: boolean): Action[] {
  const pos = (dow: number) => (dow - s.createDow + 7) % 7;
  const p = pos(weekdayOf(now.date));
  const last = pos(s.deadlineDow);
  if (p > last) return [];
  const reached = (dow: number, at: string) => p > pos(dow) || (p === pos(dow) && now.time >= at);
  const issueDate = nextIssueDate(now.date, s.sendDow);
  const out: Action[] = [];
  if (hasEarlierIssue && reached(s.createDow, s.createAt)) out.push({ kind: "create", issueDate });
  // Once the deadline has passed, "check by the deadline" would be stale: only the deadline nudge goes.
  if (reached(s.remindDow, s.remindAt) && !reached(s.deadlineDow, s.deadlineAt)) out.push({ kind: "monday", issueDate });
  if (reached(s.deadlineDow, s.deadlineAt)) out.push({ kind: "deadline", issueDate });
  return out;
}

export async function tick(db: Pool, now: Date = new Date(), fetchFn: FetchFn = fetch): Promise<{ created?: string; reminded: number }> {
  const tz = (await getSetting(db, "default_timezone")) || DEFAULT_TZ;
  const schedule = await loadSchedule(db);
  const issues = await listIssues(db);
  const today = localDateIn(tz, now);
  const actions = dueActions({ date: today, time: localTimeIn(tz, now) }, schedule, issues.length > 0);
  const result: { created?: string; reminded: number } = { reminded: 0 };
  for (const a of actions) {
    if (a.kind === "create") {
      // An issue on or after this date (e.g. a first issue started for a later week) means nothing to create.
      if (!issues.some((i) => i.issueDate >= a.issueDate)) {
        const r = await createIssue(db, a.issueDate);
        if (r.ok) { result.created = a.issueDate; issues.push(r.value); }
      }
      continue;
    }
    // Remind about the issue actually being collected, which may be later than this week's date; never a sent one.
    const issue = await liveIssue(db, today);
    if (!issue) continue;
    await fillOpenIssues(db);
    // The deadline nudge belongs to that issue's own deadline: sent a week early it would say "by Tuesday"
    // about the wrong Tuesday and use up the one real nudge.
    if (a.kind === "deadline" && issue.issueDate !== a.issueDate) continue;
    const auto = a.kind === "monday" ? ["outstanding", "confirmed", "changed", "new"] : ["outstanding"];
    for (const c of await contributorStatus(db, issue.id)) {
      // R21: Monday also asks events-section owners with nothing in yet whether there's anything new.
      if (!auto.includes(c.state) && !(a.kind === "monday" && c.state === "none" && c.ownsEvents)) continue;
      const r = await remind(db, issue.id, c.contributorId, a.kind, fetchFn);
      if (r.status === "sent") result.reminded += 1;
    }
  }
  return result;
}
