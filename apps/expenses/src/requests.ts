import { Pool, PoolClient } from "pg";
import type { Identity } from "./identity";
import type { AutoType } from "./extract-logic";
import type { ExpenseRequest, PaymentMethod, RequestKind, RequestStatus } from "./lifecycle";

// A pool or a client inside a transaction — the queries do not care which.
export type Db = Pick<Pool, "query">;

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
  voided_by_email: string | null;
  void_reason: string | null;
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
  r.approved_amount::float8 AS approved_amount, r.version,
  r.voided_at, r.voided_by_email, r.void_reason,
  r.created_by_email, r.created_by_name, r.created_at,
  CASE WHEN c.id IS NULL THEN NULL ELSE c.nickname || ' ••' || c.last4 END AS card_label`;

// Without a scope, every request (reports, the office). With one, only what
// that person may see — the same rule as lifecycle.canSee, in SQL.
export async function listRequests(
  pool: Pool,
  scope?: { email: string; all: boolean },
  status?: string
): Promise<ExpenseRequestRow[]> {
  const limited = scope && !scope.all;
  const where: string[] = [];
  const params: unknown[] = [];
  if (limited) {
    params.push(scope.email.trim().toLowerCase());
    where.push(`$1 <> '' AND $1 IN (lower(r.submitted_by_email), lower(r.purchased_by_email),
                                    lower(r.created_by_email), lower(r.approver_email))`);
  }
  if (status) {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  const r = await pool.query<ExpenseRequestRow>(
    `SELECT ${SELECT_COLUMNS},
            (SELECT count(*)::int FROM request_items i WHERE i.request_id = r.id) AS item_count
       FROM requests r
       LEFT JOIN cards c ON c.id = r.card_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY r.created_at DESC, r.id DESC`,
    params
  );
  return r.rows;
}

export interface FoundRequest {
  request: ExpenseRequestRow;
  items: RequestItem[];
}

export async function getRequest(
  db: Db,
  id: number,
  opts: { forUpdate?: boolean } = {}
): Promise<FoundRequest | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const r = await db.query<ExpenseRequestRow>(
    `SELECT ${SELECT_COLUMNS} FROM requests r
       LEFT JOIN cards c ON c.id = r.card_id
      WHERE r.id = $1${opts.forUpdate ? " FOR UPDATE OF r" : ""}`,
    [id]
  );
  if (!r.rows[0]) return null;

  const items = await db.query(
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
  client: Db,
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

// Every state change runs here: one transaction, the row locked against a
// concurrent decision or edit, the change and its audit event committed
// together or not at all. null when the request does not exist.
export async function withRequest<T>(
  pool: Pool,
  id: number,
  fn: (db: PoolClient, found: FoundRequest) => Promise<T>
): Promise<T | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await getRequest(client, id, { forUpdate: true });
    if (!found) {
      await client.query("ROLLBACK");
      return null;
    }
    const out = await fn(client, found);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function updateRequest(
  db: Db,
  id: number,
  input: Partial<ExpenseRequestInput>
): Promise<number> {
  const r = await db.query(
    `UPDATE requests SET
       request_date     = COALESCE($2, request_date),
       amount           = COALESCE($3, amount),
       reason           = COALESCE($4, reason),
       vendor           = COALESCE($5, vendor),
       charge_code      = COALESCE($6, charge_code),
       sub_charge_code  = COALESCE($7, sub_charge_code),
       card_id          = COALESCE($8, card_id),
       approver_email   = COALESCE($9, approver_email),
       approved_by      = COALESCE($10, approved_by),
       estimated_amount = COALESCE($11, estimated_amount),
       version          = version + 1,
       updated_at       = now()
     WHERE id = $1 RETURNING version`,
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
      input.estimatedAmount ?? null,
    ]
  );
  if (input.items) await replaceItems(db, id, input.items);
  return r.rows[0].version;
}

export async function setStatus(db: Db, id: number, status: RequestStatus): Promise<void> {
  await db.query(
    "UPDATE requests SET status = $2, version = version + 1, updated_at = now() WHERE id = $1",
    [id, status]
  );
}

// What is being approved is the estimate while nothing has been bought yet,
// and the real amount after.
export async function approveRequest(
  db: Db,
  id: number,
  f: { method: "digital" | "paper"; byEmail: string; at: string }
): Promise<void> {
  await db.query(
    `UPDATE requests SET status = 'approved',
       approval_method   = $2,
       approved_by_email = $3,
       approved_at       = $4::timestamptz,
       approved_amount   = CASE WHEN kind = 'pre_purchase' AND actuals_completed_at IS NULL
                                THEN estimated_amount ELSE amount END,
       version = version + 1, updated_at = now()
     WHERE id = $1`,
    [id, f.method, f.byEmail.toLowerCase(), f.at]
  );
}

// Back to the approver. The old approval no longer stands, so its method, date
// and approver are cleared — a pending request showing "Approved digitally"
// contradicts itself. approved_amount stays: it is what the new figure is
// measured against, and the events keep the full history.
export async function returnForReapproval(db: Db, id: number): Promise<void> {
  await db.query(
    `UPDATE requests SET status = 'pending',
       approval_method = NULL, approved_by_email = NULL, approved_at = NULL,
       version = version + 1, updated_at = now()
     WHERE id = $1`,
    [id]
  );
}

export async function completeActuals(
  db: Db,
  id: number,
  amount: number,
  items: RequestItem[]
): Promise<void> {
  await db.query(
    `UPDATE requests SET amount = $2, actuals_completed_at = now(),
       version = version + 1, updated_at = now() WHERE id = $1`,
    [id, amount]
  );
  await replaceItems(db, id, items);
}

export async function markReimbursed(
  db: Db,
  id: number,
  byEmail: string,
  paidOn: string,
  reference: string
): Promise<void> {
  await db.query(
    `UPDATE requests SET reimbursed_at = $3::date,
                         reimbursed_by_email = $2,
                         reimbursement_reference = $4,
                         version = version + 1,
                         updated_at = now()
      WHERE id = $1`,
    [id, byEmail.toLowerCase(), paidOn, reference ?? ""]
  );
}

export async function voidRequest(db: Db, id: number, byEmail: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE requests SET status = 'voided', voided_at = now(), voided_by_email = $2, void_reason = $3,
       version = version + 1, updated_at = now()
     WHERE id = $1`,
    [id, byEmail.toLowerCase(), reason]
  );
}

export async function deleteRequest(db: Db, id: number): Promise<boolean> {
  const r = await db.query("DELETE FROM requests WHERE id = $1 RETURNING id", [id]);
  return r.rowCount !== null && r.rowCount > 0;
}
