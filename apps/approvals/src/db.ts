import { Pool } from "pg";
import { config } from "./config";
import { SCHEMA_SQL } from "./schema";

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function ensureSchema(): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
