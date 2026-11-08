// The weekly Grace Notes clock: create the issue, then remind contributors, on a schedule from settings.
import { Pool } from "pg";
import { DEFAULT_TZ, localDateIn, localTimeIn, weekdayOf } from "../dates";
import { getSetting } from "../settings";
import { contributorStatus, createIssue, listIssues, nextIssueDate } from "./issues";
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
  if (reached(s.remindDow, s.remindAt)) out.push({ kind: "monday", issueDate });
  if (reached(s.deadlineDow, s.deadlineAt)) out.push({ kind: "deadline", issueDate });
  return out;
}

export async function tick(db: Pool, now: Date = new Date(), fetchFn: FetchFn = fetch): Promise<{ created?: string; reminded: number }> {
  const tz = (await getSetting(db, "default_timezone")) || DEFAULT_TZ;
  const schedule = await loadSchedule(db);
  const issues = await listIssues(db);
  const actions = dueActions({ date: localDateIn(tz, now), time: localTimeIn(tz, now) }, schedule, issues.length > 0);
  const result: { created?: string; reminded: number } = { reminded: 0 };
  for (const a of actions) {
    let issue = issues.find((i) => i.issueDate === a.issueDate);
    if (a.kind === "create") {
      if (!issue) {
        const r = await createIssue(db, a.issueDate);
        if (r.ok) { result.created = a.issueDate; issues.push(r.value); }
      }
      continue;
    }
    if (!issue || issue.status !== "collecting") continue;
    const states = a.kind === "monday" ? ["outstanding", "confirmed", "changed", "new"] : ["outstanding"];
    for (const c of await contributorStatus(db, issue.id)) {
      if (!states.includes(c.state)) continue;
      const r = await remind(db, issue.id, c.contributorId, a.kind, fetchFn);
      if (r.status === "sent") result.reminded += 1;
    }
  }
  return result;
}
