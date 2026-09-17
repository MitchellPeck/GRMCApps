import { Pool } from "pg";
import type { Identity } from "./identity";
import type { AutoType } from "./extract-logic";

export interface RequestItem {
  title: string;
  price: number;
  autoType?: AutoType | null;
}

export interface ExpenseRequestInput {
  requestDate: string;
  amount: number;
  reason: string;
  vendor: string;
  chargeCode: string;
  subChargeCode: string;
  purchasedBy: string;
  card: string;
  submittedBy: string;
  approvedBy: string;
  items: RequestItem[];
}

export interface ExpenseRequestRow {
  id: number;
  request_date: string | null;
  amount: string;
  reason: string;
  vendor: string;
  charge_code: string;
  sub_charge_code: string;
  purchased_by: string;
  card: string;
  submitted_by: string;
  approved_by: string;
  created_by_email: string;
  created_by_name: string;
  created_at: string;
  item_count?: number;
}

export async function listRequests(pool: Pool): Promise<ExpenseRequestRow[]> {
  // Unfiltered by design: everyone with app access sees every request.
  // id is cast to int and the date to text on purpose: node-pg hands back
  // bigserial as a string, and a `date` as a JS Date that serializes to a UTC
  // timestamp — which reads as the previous day east of Greenwich and does not
  // match the yyyy-mm-dd the form works in.
  const r = await pool.query<ExpenseRequestRow>(
    `SELECT r.id::int AS id,
            to_char(r.request_date, 'YYYY-MM-DD') AS request_date,
            r.amount, r.reason, r.vendor, r.charge_code, r.sub_charge_code,
            r.purchased_by, r.card, r.submitted_by, r.approved_by,
            r.created_by_email, r.created_by_name, r.created_at,
            (SELECT count(*)::int FROM request_items i WHERE i.request_id = r.id) AS item_count
       FROM requests r
      ORDER BY r.created_at DESC, r.id DESC`
  );
  return r.rows;
}

export async function getRequest(
  pool: Pool,
  id: number
): Promise<{ request: ExpenseRequestRow; items: RequestItem[] } | null> {
  const r = await pool.query<ExpenseRequestRow>(
    `SELECT r.id::int AS id,
            to_char(r.request_date, 'YYYY-MM-DD') AS request_date,
            r.amount, r.reason, r.vendor, r.charge_code, r.sub_charge_code,
            r.purchased_by, r.card, r.submitted_by, r.approved_by,
            r.created_by_email, r.created_by_name, r.created_at
       FROM requests r WHERE r.id = $1`,
    [id]
  );
  if (!r.rows[0]) return null;
  const items = await pool.query(
    "SELECT title, price, auto_type FROM request_items WHERE request_id = $1 ORDER BY idx",
    [id]
  );
  return {
    request: r.rows[0],
    items: items.rows.map((i) => ({
      title: i.title,
      price: Number(i.price),
      autoType: i.auto_type,
    })),
  };
}

export async function saveRequest(
  pool: Pool,
  identity: Identity,
  input: ExpenseRequestInput
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `INSERT INTO requests (request_date, amount, reason, vendor, charge_code, sub_charge_code,
                             purchased_by, card, submitted_by, approved_by,
                             created_by_email, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id::int AS id`,
      [
        input.requestDate || null,
        input.amount || 0,
        input.reason ?? "",
        input.vendor ?? "",
        input.chargeCode ?? "",
        input.subChargeCode ?? "",
        input.purchasedBy ?? "",
        input.card ?? "",
        input.submittedBy ?? "",
        input.approvedBy ?? "",
        identity.email,
        identity.name,
      ]
    );
    const id: number = r.rows[0].id;
    for (let idx = 0; idx < input.items.length; idx++) {
      const it = input.items[idx];
      await client.query(
        "INSERT INTO request_items (request_id, idx, title, price, auto_type) VALUES ($1,$2,$3,$4,$5)",
        [id, idx, it.title, it.price || 0, it.autoType ?? null]
      );
    }
    await client.query("COMMIT");
    return id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteRequest(pool: Pool, id: number): Promise<boolean> {
  const r = await pool.query("DELETE FROM requests WHERE id = $1 RETURNING id", [id]);
  return r.rowCount !== null && r.rowCount > 0;
}
