import { Pool } from "pg";

export interface ReceiptMeta {
  id: number;
  file_name: string;
  mime_type: string;
  byte_size: number;
  uploaded_by_email: string;
  uploaded_at: string;
}

export async function addReceipt(
  pool: Pool,
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

export async function deleteReceipt(
  pool: Pool,
  requestId: number,
  receiptId: number
): Promise<boolean> {
  const r = await pool.query(
    "DELETE FROM receipts WHERE id = $1 AND request_id = $2 RETURNING id",
    [receiptId, requestId]
  );
  return r.rowCount !== null && r.rowCount > 0;
}
