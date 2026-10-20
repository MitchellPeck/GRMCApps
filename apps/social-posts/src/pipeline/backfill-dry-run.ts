// Preview the content-pipeline backfill without keeping anything.
//
// Creates the pipeline tables and runs the backfill inside one transaction,
// prints what it would produce, then rolls the whole thing back — Postgres DDL
// is transactional, so the database is left exactly as it was. Safe against a
// copy or the live database:
//
//   docker compose run --rm --no-deps social-posts node dist/pipeline/backfill-dry-run.js
//
// DATABASE_URL overrides the app's usual SOCIALPOSTS_DB_* settings.
import { Pool } from "pg";
import { SCHEMA_SQL } from "../schema";
import { DEFAULT_TZ, todayInTimezone } from "../dates";
import { backfill } from "./sync";

async function main() {
  const url = process.env.DATABASE_URL || (await import("../config")).config.databaseUrl;
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(SCHEMA_SQL);
    const tz = (await client.query("SELECT value FROM settings WHERE key = 'default_timezone'")).rows[0]?.value || DEFAULT_TZ;
    const report = await backfill(client, todayInTimezone(tz));
    console.log("Would create:", report);

    const events = await client.query("SELECT id, name, kind, series_id, archived FROM events ORDER BY kind, name");
    console.log(`\nEvents (${events.rowCount}):`);
    console.table(events.rows);

    const byStatus = await client.query("SELECT status, count(*)::int AS n FROM content_items GROUP BY status ORDER BY status");
    console.log("\nContent items by status:");
    console.table(byStatus.rows);

    const sample = await client.query(
      `SELECT sp.series_id, sp.post_idx, sp.date AS label, sp.status AS old_status,
              ci.publish_date::text AS publish_date, ci.status AS new_status, ci.title
         FROM content_items ci JOIN series_posts sp USING (series_id, post_idx)
        ORDER BY sp.series_id, sp.post_idx LIMIT 25`,
    );
    console.log("\nSample (first 25):");
    console.table(sample.rows);

    const undated = await client.query("SELECT count(*)::int AS n FROM content_items WHERE publish_date IS NULL");
    if (undated.rows[0].n) console.log(`\n${undated.rows[0].n} item(s) have no publish date (unparseable label) and will only show on the board.`);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
  console.log("\nRolled back — nothing was written.");
}

main().catch((e) => { console.error(e); process.exit(1); });
