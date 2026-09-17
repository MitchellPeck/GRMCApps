import { Pool } from "pg";
import { config } from "./config";
import { SCHEMA_SQL } from "./schema";
import { seedDefaults } from "./seed";
import { ensureExpensesAdmin } from "./app-users";
import { backfillPaperEra, paperEraBackfillNeeded } from "./migrate";

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function ensureSchema(): Promise<void> {
  const log = { info: (m: string) => console.log(m) };

  // Probe FIRST: SCHEMA_SQL creates request_events, so asking afterwards would
  // always say "already there" and the one-time backfill would never run.
  const needsBackfill = await paperEraBackfillNeeded(pool);

  await pool.query(SCHEMA_SQL);
  if (needsBackfill) await backfillPaperEra(pool, log);

  await seedDefaults(pool);
  await ensureExpensesAdmin(pool, log);
}
