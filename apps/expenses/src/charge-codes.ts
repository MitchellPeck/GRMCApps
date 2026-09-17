import { Pool } from "pg";

export interface ChargeCodeRow {
  id: number;
  code: string;
  label: string;
  parent_id: number | null;
  sort: number;
  active: boolean;
}

export interface ChargeCodeNode {
  id: number;
  code: string;
  label: string;
  subs: ChargeCodeNode[];
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
    subs: active
      .filter((r) => r.parent_id === p.id)
      .sort(bySort)
      .map((s) => ({ id: s.id, code: s.code, label: s.label, subs: [] })),
  }));
}

export async function listChargeCodes(pool: Pool): Promise<ChargeCodeRow[]> {
  const r = await pool.query<ChargeCodeRow>(
    // ::int on both ids — node-pg returns bigserial as a string, which would
    // make the parent/child comparison in chargeCodeTree depend on both sides
    // happening to be strings.
    `SELECT id::int AS id, code, label, parent_id::int AS parent_id, sort, active
       FROM charge_codes ORDER BY sort, code`
  );
  return r.rows;
}

export async function createChargeCode(
  pool: Pool,
  code: string,
  label: string,
  parentId: number | null
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO charge_codes (code, label, parent_id, sort)
     VALUES ($1, $2, $3, COALESCE((SELECT max(sort) + 1 FROM charge_codes WHERE parent_id IS NOT DISTINCT FROM $3), 0))
     RETURNING id::int AS id`,
    [code.trim(), label.trim(), parentId]
  );
  return r.rows[0].id;
}

export async function updateChargeCode(
  pool: Pool,
  id: number,
  fields: { code?: string; label?: string; active?: boolean }
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE charge_codes
        SET code   = COALESCE($2, code),
            label  = COALESCE($3, label),
            active = COALESCE($4, active)
      WHERE id = $1 RETURNING id`,
    [id, fields.code?.trim() ?? null, fields.label?.trim() ?? null, fields.active ?? null]
  );
  return r.rowCount !== null && r.rowCount > 0;
}

// Sub-codes cascade via the foreign key.
export async function deleteChargeCode(pool: Pool, id: number): Promise<boolean> {
  const r = await pool.query("DELETE FROM charge_codes WHERE id = $1 RETURNING id", [id]);
  return r.rowCount !== null && r.rowCount > 0;
}
