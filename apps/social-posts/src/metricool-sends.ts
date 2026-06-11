import { Pool } from "pg";

export interface SendLog {
  sourceType: string; sourceRef: string; text: string; networks: string;
  imageRef: string; r2Url: string; scheduledFor: string; timezone: string;
  metricoolPostId: string; status: "sent" | "error"; error: string; createdBy: string;
}

export async function logSend(pool: Pool, s: SendLog): Promise<void> {
  await pool.query(
    `INSERT INTO metricool_sends
       (source_type, source_ref, text, networks, image_ref, r2_url, scheduled_for, timezone, metricool_post_id, status, error, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [s.sourceType, s.sourceRef, s.text, s.networks, s.imageRef, s.r2Url, s.scheduledFor, s.timezone, s.metricoolPostId, s.status, s.error, s.createdBy]
  );
}
