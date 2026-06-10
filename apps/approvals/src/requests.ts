import { Pool } from "pg";
import { getRosterEntry } from "./roster";
import {
  Status, DecisionAction, RequestParties, CheckResult,
  checkDecision, checkVersionUpload, canView,
  statusAfterDecision, eventTypeForDecision,
} from "./approval";

export interface UploadFile {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

export interface RequestRow {
  id: number;
  title: string;
  description: string;
  submitter_email: string;
  submitter_name: string;
  approver_email: string;
  approver_name: string;
  status: Status;
  current_version: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

export interface VersionMeta {
  version_no: number;
  file_name: string;
  mime_type: string;
  byte_size: number;
  note: string;
  uploaded_by_email: string;
  uploaded_at: string;
}

export interface EventRow {
  type: string;
  version_no: number;
  actor_email: string;
  actor_name: string;
  comment: string;
  created_at: string;
}

export interface ListItem extends RequestRow {
  latest_file_name: string;
  latest_mime_type: string;
}

export type CreateInput = {
  title: string;
  description: string;
  approverId: number;
  submitter: { email: string; name: string };
  file: UploadFile;
};

export type CreateResult = { ok: true; id: number } | { ok: false; status: number; error: string };
export type MutateResult = { ok: true } | { ok: false; status: number; error: string };

function rowToRequest(row: any): RequestRow {
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description,
    submitter_email: row.submitter_email,
    submitter_name: row.submitter_name,
    approver_email: row.approver_email,
    approver_name: row.approver_name,
    status: row.status,
    current_version: Number(row.current_version),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    decided_at: row.decided_at ? String(row.decided_at) : null,
  };
}

async function loadParties(pool: Pool, id: number): Promise<RequestParties & { found: boolean }> {
  const r = await pool.query(
    "SELECT submitter_email, approver_email, status FROM requests WHERE id = $1", [id]
  );
  const row = r.rows[0];
  if (!row) return { found: false, submitter_email: "", approver_email: "", status: "pending" };
  return { found: true, submitter_email: row.submitter_email, approver_email: row.approver_email, status: row.status };
}

export async function createRequest(pool: Pool, input: CreateInput): Promise<CreateResult> {
  const title = input.title.trim();
  if (!title) return { ok: false, status: 400, error: "Title is required." };

  const approver = await getRosterEntry(pool, input.approverId);
  if (!approver || !approver.active) {
    return { ok: false, status: 400, error: "Selected approver is not on the active roster." };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO requests (title, description, submitter_email, submitter_name, approver_email, approver_name, status, current_version)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',1) RETURNING id`,
      [title, input.description.trim(), input.submitter.email, input.submitter.name, approver.email, approver.name]
    );
    const id = Number(ins.rows[0].id);
    await client.query(
      `INSERT INTO request_versions (request_id, version_no, file_name, mime_type, byte_size, image, note, uploaded_by_email)
       VALUES ($1,1,$2,$3,$4,$5,'',$6)`,
      [id, input.file.fileName, input.file.mimeType, input.file.buffer.length, input.file.buffer, input.submitter.email]
    );
    await client.query(
      `INSERT INTO request_events (request_id, version_no, type, actor_email, actor_name, comment)
       VALUES ($1,1,'submitted',$2,$3,'')`,
      [id, input.submitter.email, input.submitter.name]
    );
    await client.query("COMMIT");
    return { ok: true, id };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, status: 500, error: (err as Error).message };
  } finally {
    client.release();
  }
}

export async function listRequests(pool: Pool, box: "inbox" | "sent", email: string): Promise<ListItem[]> {
  const e = email.trim().toLowerCase();
  const cond = box === "inbox"
    ? "lower(approver_email) = $1 AND status = 'pending'"
    : "lower(submitter_email) = $1";
  const r = await pool.query(
    `SELECT r.*, v.file_name AS latest_file_name, v.mime_type AS latest_mime_type
       FROM requests r
       JOIN request_versions v ON v.request_id = r.id AND v.version_no = r.current_version
      WHERE ${cond}
      ORDER BY r.updated_at DESC`,
    [e]
  );
  return r.rows.map((row) => ({
    ...rowToRequest(row),
    latest_file_name: row.latest_file_name,
    latest_mime_type: row.latest_mime_type,
  }));
}

export type DetailResult =
  | { ok: true; request: RequestRow; versions: VersionMeta[]; events: EventRow[] }
  | { ok: false; status: number; error: string };

export async function getRequestDetail(pool: Pool, id: number, email: string): Promise<DetailResult> {
  const rq = await pool.query("SELECT * FROM requests WHERE id = $1", [id]);
  const row = rq.rows[0];
  if (!row) return { ok: false, status: 404, error: "Request not found." };
  const request = rowToRequest(row);
  if (!canView(request, email)) return { ok: false, status: 403, error: "You do not have access to this request." };

  const vs = await pool.query(
    `SELECT version_no, file_name, mime_type, byte_size, note, uploaded_by_email, uploaded_at
       FROM request_versions WHERE request_id = $1 ORDER BY version_no`, [id]
  );
  const ev = await pool.query(
    `SELECT type, version_no, actor_email, actor_name, comment, created_at
       FROM request_events WHERE request_id = $1 ORDER BY created_at, id`, [id]
  );
  return {
    ok: true,
    request,
    versions: vs.rows.map((v) => ({
      version_no: Number(v.version_no), file_name: v.file_name, mime_type: v.mime_type,
      byte_size: Number(v.byte_size), note: v.note, uploaded_by_email: v.uploaded_by_email,
      uploaded_at: String(v.uploaded_at),
    })),
    events: ev.rows.map((e) => ({
      type: e.type, version_no: Number(e.version_no), actor_email: e.actor_email,
      actor_name: e.actor_name, comment: e.comment, created_at: String(e.created_at),
    })),
  };
}

export async function recordDecision(
  pool: Pool, id: number, actorEmail: string, action: DecisionAction, comment: string,
  actorName = ""
): Promise<MutateResult> {
  const parties = await loadParties(pool, id);
  if (!parties.found) return { ok: false, status: 404, error: "Request not found." };
  const check: CheckResult = checkDecision(parties, actorEmail, action, comment);
  if (!check.ok) return check;

  const newStatus = statusAfterDecision(action);
  const eventType = eventTypeForDecision(action);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query("SELECT current_version FROM requests WHERE id = $1", [id]);
    const versionNo = Number(cur.rows[0].current_version);
    const decidedAt = action === "request_changes" ? null : "now()";
    if (decidedAt) {
      await client.query(
        "UPDATE requests SET status = $2, updated_at = now(), decided_at = now() WHERE id = $1",
        [id, newStatus]
      );
    } else {
      await client.query(
        "UPDATE requests SET status = $2, updated_at = now() WHERE id = $1",
        [id, newStatus]
      );
    }
    await client.query(
      `INSERT INTO request_events (request_id, version_no, type, actor_email, actor_name, comment)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, versionNo, eventType, actorEmail, actorName, comment.trim()]
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, status: 500, error: (err as Error).message };
  } finally {
    client.release();
  }
}

export async function addVersion(
  pool: Pool, id: number, actorEmail: string, file: UploadFile, note: string, actorName = ""
): Promise<MutateResult> {
  const parties = await loadParties(pool, id);
  if (!parties.found) return { ok: false, status: 404, error: "Request not found." };
  const check = checkVersionUpload(parties, actorEmail);
  if (!check.ok) return check;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query("SELECT current_version FROM requests WHERE id = $1 FOR UPDATE", [id]);
    const next = Number(cur.rows[0].current_version) + 1;
    await client.query(
      `INSERT INTO request_versions (request_id, version_no, file_name, mime_type, byte_size, image, note, uploaded_by_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, next, file.fileName, file.mimeType, file.buffer.length, file.buffer, note.trim(), actorEmail]
    );
    await client.query(
      "UPDATE requests SET status = 'pending', current_version = $2, updated_at = now(), decided_at = NULL WHERE id = $1",
      [id, next]
    );
    await client.query(
      `INSERT INTO request_events (request_id, version_no, type, actor_email, actor_name, comment)
       VALUES ($1,$2,'resubmitted',$3,$4,$5)`,
      [id, next, actorEmail, actorName, note.trim()]
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, status: 500, error: (err as Error).message };
  } finally {
    client.release();
  }
}

export type ImageResult =
  | { ok: true; mimeType: string; fileName: string; image: Buffer }
  | { ok: false; status: number; error: string };

export async function getVersionImage(pool: Pool, id: number, versionNo: number, email: string): Promise<ImageResult> {
  const parties = await loadParties(pool, id);
  if (!parties.found) return { ok: false, status: 404, error: "Request not found." };
  if (!canView(parties, email)) return { ok: false, status: 403, error: "You do not have access to this image." };
  const r = await pool.query(
    "SELECT mime_type, file_name, image FROM request_versions WHERE request_id = $1 AND version_no = $2",
    [id, versionNo]
  );
  const row = r.rows[0];
  if (!row) return { ok: false, status: 404, error: "Version not found." };
  return { ok: true, mimeType: row.mime_type, fileName: row.file_name, image: row.image as Buffer };
}
