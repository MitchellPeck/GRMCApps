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
}

export interface CodeTotal {
  chargeCode: string;
  total: number;
  count: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Only approved money counts as spend — a rejected request is not an expense,
// and a pending one has not been agreed to yet.
export function spendByCode(rows: ReportRow[]): CodeTotal[] {
  const totals = new Map<string, { total: number; count: number }>();
  for (const r of rows) {
    if (r.status !== "approved") continue;
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
];

// A leading =, +, - or @ makes a spreadsheet treat the cell as a formula, so a
// vendor named "=cmd|..." would execute on open. Prefixing an apostrophe is the
// standard neutralisation and is invisible once imported.
function neutralise(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function escapeCell(value: unknown): string {
  const raw = neutralise(String(value ?? ""));
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
      ]
        .map(escapeCell)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}
