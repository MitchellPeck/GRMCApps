import { Pool } from "pg";
import { createHash } from "node:crypto";

type Db = Pick<Pool, "query">;

export interface ReceiptMeta {
  id: number;
  file_name: string;
  mime_type: string;
  byte_size: number;
  uploaded_by_email: string;
  uploaded_at: string;
}

export async function addReceipt(
  pool: Db,
  requestId: number,
  file: { name: string; mimeType: string; buffer: Buffer },
  uploaderEmail: string
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO receipts (request_id, file_name, mime_type, byte_size, content, uploaded_by_email)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::int AS id`,
    [requestId, file.name, file.mimeType, file.buffer.length, file.buffer, uploaderEmail]
  );
  return r.rows[0].id;
}

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// Metadata only — the bytes are deliberately not selected here, so listing a
// request never pulls megabytes out of the database.
export async function listReceipts(pool: Pool, requestId: number): Promise<ReceiptMeta[]> {
  const r = await pool.query<ReceiptMeta>(
    `SELECT id::int AS id, file_name, mime_type, byte_size, uploaded_by_email, uploaded_at
       FROM receipts WHERE request_id = $1 ORDER BY uploaded_at, id`,
    [requestId]
  );
  return r.rows;
}

export async function getReceipt(
  pool: Pool,
  requestId: number,
  receiptId: number
): Promise<{ file_name: string; mime_type: string; content: Buffer } | null> {
  const r = await pool.query(
    `SELECT file_name, mime_type, content FROM receipts WHERE id = $1 AND request_id = $2`,
    [receiptId, requestId]
  );
  return r.rows[0] ?? null;
}

// Returns the removed file's name so the audit event can say which one it was.
export async function deleteReceipt(
  pool: Db,
  requestId: number,
  receiptId: number
): Promise<string | null> {
  const r = await pool.query(
    "DELETE FROM receipts WHERE id = $1 AND request_id = $2 RETURNING file_name",
    [receiptId, requestId]
  );
  return r.rows[0]?.file_name ?? null;
}
