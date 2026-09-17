import type { Pool } from "pg";

// Probed BEFORE SCHEMA_SQL runs. SCHEMA_SQL creates request_events, so probing
// afterwards would always report "already present" and the backfill would never
// run. Same structurally-once pattern as the hub's grandfather migration.
export async function paperEraBackfillNeeded(pool: Pool): Promise<boolean> {
  const r = await pool.query("SELECT to_regclass('public.request_events') AS reg");
  const reg = r.rows[0]?.reg;
  return reg === null || reg === undefined;
}

// Every row that existed before the digital workflow is exactly one thing: a
// post-purchase church-card expense that was approved on paper. The column
// defaults already assert the first three; this adds the approval method and
// date and writes a matching event, so the paper era sits in the same log as
// the digital one rather than looking like a pile of unapproved requests.
export async function backfillPaperEra(
  pool: Pool,
  log: { info(msg: string): void }
): Promise<void> {
  const updated = await pool.query(
    `UPDATE requests
        SET approval_method = 'paper',
            approved_at = COALESCE(approved_at, created_at),
            submitted_by_email = COALESCE(NULLIF(submitted_by_email, ''), created_by_email)
      WHERE approval_method IS NULL
      RETURNING id, created_by_email, created_by_name, created_at`
  );

  for (const row of updated.rows) {
    await pool.query(
      `INSERT INTO request_events (request_id, type, actor_email, actor_name, comment, created_at)
       VALUES ($1, 'approved_on_paper', $2, $3, $4, $5)`,
      [
        row.id,
        row.created_by_email,
        row.created_by_name,
        "Recorded from the paper workflow during migration.",
        row.created_at,
      ]
    );
  }
  log.info(`expenses: backfilled ${updated.rowCount ?? 0} paper-era requests`);
}
