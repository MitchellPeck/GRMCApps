import type { Pool } from "pg";
import { normalizeEmail } from "./email";
import {
  BASE_DDL,
  BOOTSTRAP_ADMIN_EMAIL,
  COUNT_ACTIVE_ADMINS_SQL,
  FIND_BY_LOWER_EMAIL_SQL,
  GRANDFATHER_SQL,
  GRANT_ALL_ENABLED_SQL,
  INSERT_BOOTSTRAP_SQL,
  PROBE_ACCESS_TABLE_SQL,
  PROMOTE_BOOTSTRAP_SQL,
  REPROMOTE_SQL,
} from "./schema";

export interface ProvisionLog {
  info(msg: string): void;
  warn(obj: unknown, msg: string): void;
}

// Pure: which steps run, given whether user_app_access existed BEFORE this
// boot. Extracted so the once-only rule is testable without a database.
export function planProvisioning(accessTableExisted: boolean): string[] {
  return accessTableExisted
    ? ["base-ddl", "bootstrap-repair"]
    : ["base-ddl", "grandfather", "bootstrap-repair"];
}

export async function ensureUserSchema(pool: Pool, log: ProvisionLog): Promise<void> {
  // 1. Probe BEFORE any DDL. BASE_DDL creates the table, so probing afterwards
  //    would always report "already present" and the backfill would never run.
  const probe = await pool.query(PROBE_ACCESS_TABLE_SQL);
  const existed = probe.rows[0]?.reg !== null && probe.rows[0]?.reg !== undefined;
  const steps = planProvisioning(existed);

  // 2. Base DDL.
  await pool.query(BASE_DDL);

  // 3. Grandfather, only on the hub's first meeting with this database.
  if (steps.includes("grandfather")) {
    const granted = await pool.query(GRANDFATHER_SQL);
    await pool.query(PROMOTE_BOOTSTRAP_SQL, [normalizeEmail(BOOTSTRAP_ADMIN_EMAIL)]);
    log.info(`user management: grandfathered ${granted.rowCount ?? 0} existing app grants`);
  }

  // 4. Bootstrap repair, every boot but only when nobody can administer.
  await ensureBootstrapAdmin(pool, log);
}

// Fires on a fresh database (creates the account) and after a disaster (the
// last admin was removed outside the guard rails). A no-op whenever any active
// administrator exists, so a deliberate demotion stays demoted.
async function ensureBootstrapAdmin(pool: Pool, log: ProvisionLog): Promise<void> {
  const count = await pool.query(COUNT_ACTIVE_ADMINS_SQL);
  if ((count.rows[0]?.n ?? 0) > 0) return;

  const email = normalizeEmail(BOOTSTRAP_ADMIN_EMAIL);
  const found = await pool.query(FIND_BY_LOWER_EMAIL_SQL, [email]);

  let userId: string;
  if (found.rows[0]) {
    userId = found.rows[0].id;
    await pool.query(REPROMOTE_SQL, [userId]);
    log.info(`user management: restored admin on ${BOOTSTRAP_ADMIN_EMAIL}`);
  } else {
    const created = await pool.query(INSERT_BOOTSTRAP_SQL, [BOOTSTRAP_ADMIN_EMAIL, null]);
    userId = created.rows[0].id;
    log.info(`user management: seeded bootstrap admin ${BOOTSTRAP_ADMIN_EMAIL}`);
  }

  await pool.query(GRANT_ALL_ENABLED_SQL, [userId]);
}
