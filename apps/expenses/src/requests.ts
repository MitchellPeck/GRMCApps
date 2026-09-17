import { Pool } from "pg";
import type { Identity } from "./identity";
import type { AutoType } from "./extract-logic";
import type { ExpenseRequest, PaymentMethod, RequestKind, RequestStatus } from "./lifecycle";

export interface RequestItem {
  title: string;
  price: number;
  autoType?: AutoType | null;
}

export interface ExpenseRequestInput {
  kind: RequestKind;
  paymentMethod: PaymentMethod;
  requestDate: string;
  amount: number;
  estimatedAmount: number | null;
  reason: string;
  vendor: string;
  chargeCode: string;
  subChargeCode: string;
  cardId: number | null;
  card: string;
  purchasedBy: string;
  purchasedByEmail: string;
  submittedBy: string;
  approvedBy: string;
  approverEmail: string;
  items: RequestItem[];
}

export interface ExpenseRequestRow extends ExpenseRequest {
  request_date: string | null;
  reason: string;
  vendor: string;
  charge_code: string;
  sub_charge_code: string;
  purchased_by: string;
  purchased_by_email: string;
  card: string;
  card_id: number | null;
  submitted_by: string;
  approved_by: string;
  approval_method: string | null;
  approved_by_email: string | null;
  reimbursed_by_email: string | null;
  reimbursement_reference: string | null;
  created_by_email: string;
  created_by_name: string;
  created_at: string;
  item_count?: number;
  card_label?: string | null;
}

// id::int and to_char on purpose: node-pg returns bigserial as a string and a
// `date` as a JS Date that serializes to a UTC timestamp — which reads as the
// previous day east of Greenwich and does not match the yyyy-mm-dd the form
// works in. Numeric columns are cast to float so arithmetic works client-side.
const SELECT_COLUMNS = `
  r.id::int AS id,
  to_char(r.request_date, 'YYYY-MM-DD') AS request_date,
  r.amount::float8 AS amount,
  r.estimated_amount::float8 AS estimated_amount,
  r.reason, r.vendor, r.charge_code, r.sub_charge_code,
  r.purchased_by, r.purchased_by_email, r.card, r.card_id::int AS card_id,
  r.submitted_by, r.submitted_by_email, r.approved_by, r.approver_email,
  r.kind, r.payment_method, r.status,
  r.approval_method, r.approved_at, r.approved_by_email,
  r.actuals_completed_at, r.reimbursed_at, r.reimbursed_by_email, r.reimbursement_reference,
  r.created_by_email, r.created_by_name, r.created_at,
  CASE WHEN c.id IS NULL THEN NULL ELSE c.nickname || ' ••' || c.last4 END AS card_label`;

export async function listRequests(pool: Pool): Promise<ExpenseRequestRow[]> {
  // Unfiltered by design: everyone with app access sees every request.
  // Permissions govern what can be done, not what can be seen.
  const r = await pool.query<ExpenseRequestRow>(
    `SELECT ${SELECT_COLUMNS},
            (SELECT count(*)::int FROM request_items i WHERE i.request_id = r.id) AS item_count
       FROM requests r
       LEFT JOIN cards c ON c.id = r.card_id
      ORDER BY r.created_at DESC, r.id DESC`
  );
  return r.rows;
}

export async function getRequest(
  pool: Pool,
  id: number
): Promise<{ request: ExpenseRequestRow; items: RequestItem[] } | null> {
  const r = await pool.query<ExpenseRequestRow>(
    `SELECT ${SELECT_COLUMNS} FROM requests r
       LEFT JOIN cards c ON c.id = r.card_id
      WHERE r.id = $1`,
    [id]
  );
  if (!r.rows[0]) return null;

  const items = await pool.query(
    "SELECT title, price::float8 AS price, auto_type FROM request_items WHERE request_id = $1 ORDER BY idx",
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

async function replaceItems(
  client: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  id: number,
  items: RequestItem[]
): Promise<void> {
  await client.query("DELETE FROM request_items WHERE request_id = $1", [id]);
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    await client.query(
      "INSERT INTO request_items (request_id, idx, title, price, auto_type) VALUES ($1,$2,$3,$4,$5)",
      [id, idx, it.title, it.price || 0, it.autoType ?? null]
    );
  }
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
      `INSERT INTO requests (
         request_date, amount, estimated_amount, reason, vendor, charge_code, sub_charge_code,
         card_id, card, purchased_by, purchased_by_email, submitted_by, submitted_by_email,
         approved_by, approver_email, kind, payment_method, status,
         created_by_email, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending',$18,$19)
       RETURNING id::int AS id`,
      [
        input.requestDate || null,
        input.amount || 0,
        input.estimatedAmount,
        input.reason ?? "",
        input.vendor ?? "",
        input.chargeCode ?? "",
        input.subChargeCode ?? "",
        input.cardId,
        input.card ?? "",
        input.purchasedBy ?? "",
        (input.purchasedByEmail ?? "").toLowerCase(),
        input.submittedBy ?? "",
        identity.email,
        input.approvedBy ?? "",
        (input.approverEmail ?? "").toLowerCase(),
        input.kind,
        input.paymentMethod,
        identity.email,
        identity.name,
      ]
    );
    const id: number = r.rows[0].id;
    await replaceItems(client, id, input.items);
    await client.query("COMMIT");
    return id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function updateRequest(
  pool: Pool,
  id: number,
  input: Partial<ExpenseRequestInput>
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `UPDATE requests SET
         request_date    = COALESCE($2, request_date),
         amount          = COALESCE($3, amount),
         reason          = COALESCE($4, reason),
         vendor          = COALESCE($5, vendor),
         charge_code     = COALESCE($6, charge_code),
         sub_charge_code = COALESCE($7, sub_charge_code),
         card_id         = COALESCE($8, card_id),
         approver_email  = COALESCE($9, approver_email),
         approved_by     = COALESCE($10, approved_by),
         updated_at      = now()
       WHERE id = $1 RETURNING id`,
      [
        id,
        input.requestDate ?? null,
        input.amount ?? null,
        input.reason ?? null,
        input.vendor ?? null,
        input.chargeCode ?? null,
        input.subChargeCode ?? null,
        input.cardId ?? null,
        input.approverEmail ? input.approverEmail.toLowerCase() : null,
        input.approvedBy ?? null,
      ]
    );
    if (!r.rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }
    if (input.items) await replaceItems(client, id, input.items);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function setStatus(
  pool: Pool,
  id: number,
  status: RequestStatus,
  fields: {
    approvalMethod?: string | null;
    approvedByEmail?: string | null;
    approvedAt?: string | null;
  } = {}
): Promise<void> {
  await pool.query(
    `UPDATE requests SET status = $2,
       approval_method   = COALESCE($3, approval_method),
       approved_by_email = COALESCE($4, approved_by_email),
       approved_at       = COALESCE($5::timestamptz, approved_at),
       updated_at        = now()
     WHERE id = $1`,
    [id, status, fields.approvalMethod ?? null, fields.approvedByEmail ?? null, fields.approvedAt ?? null]
  );
}

export async function completeActuals(
  pool: Pool,
  id: number,
  amount: number,
  items: RequestItem[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE requests SET amount = $2, actuals_completed_at = now(), updated_at = now() WHERE id = $1",
      [id, amount]
    );
    await replaceItems(client, id, items);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function markReimbursed(
  pool: Pool,
  id: number,
  byEmail: string,
  paidOn: string | null,
  reference: string
): Promise<void> {
  await pool.query(
    `UPDATE requests SET reimbursed_at = COALESCE($3::date, now()),
                         reimbursed_by_email = $2,
                         reimbursement_reference = $4,
                         updated_at = now()
      WHERE id = $1`,
    [id, byEmail.toLowerCase(), paidOn || null, reference ?? ""]
  );
}

export async function deleteRequest(pool: Pool, id: number): Promise<boolean> {
  const r = await pool.query("DELETE FROM requests WHERE id = $1 RETURNING id", [id]);
  return r.rowCount !== null && r.rowCount > 0;
}
