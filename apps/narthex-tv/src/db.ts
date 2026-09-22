import { Pool } from "pg";
import { config } from "./config";
import { SCHEMA_SQL } from "./schema";
import { ensureNarthexAdmin } from "./app-users";

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function ensureSchema(): Promise<void> {
  const log = { info: (m: string) => console.log(m) };
  await pool.query(SCHEMA_SQL);
  await ensureNarthexAdmin(pool, log);
}
