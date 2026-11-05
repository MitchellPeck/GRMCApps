import { Pool } from "pg";

export interface ChargeCodeRow {
  id: number;
  code: string;
  label: string;
  parent_id: number | null;
  sort: number;
  active: boolean;
  // The chart-of-accounts number this code books to. Blank: the code itself.
  gl_account?: string;
}

export interface ChargeCodeNode {
  id: number;
  code: string;
  label: string;
  gl_account?: string;
  subs: ChargeCodeNode[];
}

// The GL account a request books to: its sub-code's mapping, else its
// code's, else the code number itself — the church's codes are already GL
// numbers, so mapping is only needed where they differ. Inactive codes still
// count: old spend must still land somewhere.
export function glAccountFor(rows: ChargeCodeRow[], chargeCode: string, subCode: string): string {
  const parent = rows.find((r) => r.parent_id === null && r.code === chargeCode);
  const sub = parent && subCode
    ? rows.find((r) => r.parent_id === parent.id && r.code === subCode)
    : undefined;
  return (sub?.gl_account || parent?.gl_account || chargeCode || "").trim();
}

// Flat rows -> parents with children. A child whose parent is inactive is
// dropped with it: a sub-code is meaningless without its parent.
export function chargeCodeTree(rows: ChargeCodeRow[]): ChargeCodeNode[] {
  const bySort = (a: ChargeCodeRow, b: ChargeCodeRow) =>
    a.sort - b.sort || a.code.localeCompare(b.code);
  const active = rows.filter((r) => r.active);
  const parents = active.filter((r) => r.parent_id === null).sort(bySort);
  return parents.map((p) => ({
    id: p.id,
    code: p.code,
    label: p.label,
    gl_account: p.gl_account ?? "",
    subs: active
      .filter((r) => r.parent_id === p.id)
      .sort(bySort)
      .map((s) => ({ id: s.id, code: s.code, label: s.label, gl_account: s.gl_account ?? "", subs: [] })),
  }));
}

export async function listChargeCodes(pool: Pool): Promise<ChargeCodeRow[]> {
  const r = await pool.query<ChargeCodeRow>(
    // ::int on both ids — node-pg returns bigserial as a string, which would
    // make the parent/child comparison in chargeCodeTree depend on both sides
    // happening to be strings.
    `SELECT id::int AS id, code, label, parent_id::int AS parent_id, sort, active, gl_account
       FROM charge_codes ORDER BY sort, code`
  );
  return r.rows;
}

export async function createChargeCode(
  pool: Pool,
  code: string,
  label: string,
  parentId: number | null,
  glAccount = ""
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO charge_codes (code, label, parent_id, gl_account, sort)
     VALUES ($1, $2, $3, $4, COALESCE((SELECT max(sort) + 1 FROM charge_codes WHERE parent_id IS NOT DISTINCT FROM $3), 0))
     RETURNING id::int AS id`,
    [code.trim(), label.trim(), parentId, glAccount.trim()]
  );
  return r.rows[0].id;
}

export async function updateChargeCode(
  pool: Pool,
  id: number,
  fields: { code?: string; label?: string; active?: boolean; glAccount?: string }
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE charge_codes
        SET code       = COALESCE($2, code),
            label      = COALESCE($3, label),
            active     = COALESCE($4, active),
            gl_account = COALESCE($5, gl_account)
      WHERE id = $1 RETURNING id`,
    [id, fields.code?.trim() ?? null, fields.label?.trim() ?? null, fields.active ?? null,
     typeof fields.glAccount === "string" ? fields.glAccount.trim() : null]
  );
  return r.rowCount !== null && r.rowCount > 0;
}

// Requests store the code as text, so deleting one that is in use would leave
// history pointing at nothing. Returns how many requests use it or a sub-code.
export async function chargeCodeUsage(pool: Pool, id: number): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM requests q
      WHERE EXISTS (SELECT 1 FROM charge_codes c
                     WHERE (c.id = $1 OR c.parent_id = $1)
                       AND ((c.parent_id IS NULL AND q.charge_code = c.code)
                         OR (c.parent_id IS NOT NULL AND q.sub_charge_code = c.code)))`,
    [id]
  );
  return r.rows[0]?.n ?? 0;
}

// Sub-codes cascade via the foreign key.
export async function deleteChargeCode(pool: Pool, id: number): Promise<boolean> {
  const r = await pool.query("DELETE FROM charge_codes WHERE id = $1 RETURNING id", [id]);
  return r.rowCount !== null && r.rowCount > 0;
}
