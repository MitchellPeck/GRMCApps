import { Pool } from "pg";
import { config } from "./config";
import { SCHEMA_SQL } from "./schema";
import { seedDefaults } from "./seed";
import { ensureExpensesAdmin } from "./app-users";

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function ensureSchema(): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await seedDefaults(pool);
  await ensureExpensesAdmin(pool, { info: (m) => console.log(m) });
}
