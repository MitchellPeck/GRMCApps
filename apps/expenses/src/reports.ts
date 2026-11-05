export interface ReportRow {
  id: number;
  request_date: string | null;
  amount: number;
  charge_code: string;
  sub_charge_code: string;
  vendor: string;
  reason: string;
  status: string;
  stage: string;
  kind: string;
  payment_method: string;
  submitted_by_email: string;
  // Optional so a minimal row still reports; the export fills them all in.
  actuals_completed?: boolean;
  purchased_by?: string;
  card?: string;
  approver?: string;
  approval_method?: string;
  approved_at?: string;
  paid_on?: string;
  paid_reference?: string;
  voided_reason?: string;
}

// With a range set, an undated request belongs to no period rather than all.
export function inPeriod(date: string | null, f: { from?: string; to?: string }): boolean {
  if (!f.from && !f.to) return true;
  if (!date) return false;
  if (f.from && date < f.from) return false;
  if (f.to && date > f.to) return false;
  return true;
}

export interface CodeTotal {
  chargeCode: string;
  total: number;
  count: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Approved money is spend. So is money already spent on a pre-purchase that
// went back for re-approval — the card was charged whatever the approver now
// says. A rejected request with nothing bought, a pending one, and anything
// withdrawn or voided is not.
export function isSpend(r: ReportRow): boolean {
  if (r.status === "voided" || r.status === "withdrawn") return false;
  return r.status === "approved" || !!r.actuals_completed;
}

export function spendByCode(rows: ReportRow[]): CodeTotal[] {
  const totals = new Map<string, { total: number; count: number }>();
  for (const r of rows) {
    if (!isSpend(r)) continue;
    const code = r.charge_code || "(none)";
    const entry = totals.get(code) ?? { total: 0, count: 0 };
    entry.total += Number(r.amount) || 0;
    entry.count += 1;
    totals.set(code, entry);
  }
  return [...totals.entries()]
    .map(([chargeCode, v]) => ({ chargeCode, total: round2(v.total), count: v.count }))
    .sort((a, b) => a.chargeCode.localeCompare(b.chargeCode));
}

const HEADERS = [
  "id", "date", "amount", "kind", "payment", "status", "stage",
  "charge_code", "sub_charge_code", "vendor", "reason", "submitted_by",
  "purchased_by", "card", "approver", "approval_method", "approved_at",
  "paid_on", "paid_reference", "voided_reason",
];

// A leading =, +, - or @ makes a spreadsheet treat the cell as a formula, so a
// vendor named "=cmd|..." would execute on open. Prefixing an apostrophe is the
// standard neutralisation and is invisible once imported.
function neutralise(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

// Numbers go out as numbers: an apostrophe in front of a refund's minus sign
// would make the spreadsheet read it as text and drop it from every sum.
function escapeCell(value: unknown): string {
  const raw = typeof value === "number" ? String(value) : neutralise(String(value ?? ""));
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

export function toCsv(rows: ReportRow[]): string {
  const lines = [HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id, r.request_date ?? "", r.amount, r.kind, r.payment_method,
        r.status, r.stage, r.charge_code, r.sub_charge_code,
        r.vendor, r.reason, r.submitted_by_email,
        r.purchased_by ?? "", r.card ?? "", r.approver ?? "", r.approval_method ?? "",
        r.approved_at ?? "", r.paid_on ?? "", r.paid_reference ?? "", r.voided_reason ?? "",
      ]
        .map(escapeCell)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}
