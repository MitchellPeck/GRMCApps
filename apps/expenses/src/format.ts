import type { ChargeCodeNode } from "./charge-codes";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function fmtAmount(value: number): string {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  const body = Math.abs(safe).toFixed(2);
  return (safe < 0 ? "-$" : "$") + body;
}

// Formats an ISO yyyy-mm-dd by splitting the string rather than going through
// Date parsing: `new Date("2026-09-17")` is parsed as UTC midnight and renders
// as the 16th anywhere west of Greenwich.
export function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? "").trim());
  if (!m) return "—";
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return "—";
  return `${month} ${Number(m[3])}, ${Number(m[1])}`;
}

export function displayCode(code: string, tree: ChargeCodeNode[]): string {
  const value = (code ?? "").trim();
  if (!value) return "—";
  for (const parent of tree) {
    if (parent.code === value) return `${parent.code} — ${parent.label}`;
    for (const sub of parent.subs) {
      if (sub.code === value) return `${sub.code} — ${sub.label}`;
    }
  }
  return value;
}

// Ported from the Artifact: up to three titles, each elided at 40 characters,
// then a count of the remainder. Used as the reason when classification fails.
export function heuristicSummary(titles: string[]): string {
  if (!titles.length) return "";
  const maxShow = 3;
  const shown = titles
    .slice(0, maxShow)
    .map((t) => (t.length > 40 ? t.slice(0, 37).trim() + "…" : t));
  let summary = shown.join(", ");
  if (titles.length > maxShow) summary += ` +${titles.length - maxShow} more`;
  return summary;
}
