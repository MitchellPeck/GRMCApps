import { strict as assert } from "node:assert";
import { test } from "node:test";
import { planProvisioning } from "./provision";
import { BASE_DDL, BOOTSTRAP_ADMIN_EMAIL } from "./schema";

test("a database meeting the hub for the first time gets the grandfather backfill", () => {
  assert.deepEqual(planProvisioning(false), ["base-ddl", "grandfather", "bootstrap-repair"]);
});

test("a database that already has the grants table never re-runs the backfill", () => {
  // This is the whole point: re-running it would silently restore an app that
  // an administrator had deliberately revoked.
  assert.deepEqual(planProvisioning(true), ["base-ddl", "bootstrap-repair"]);
  assert.equal(planProvisioning(true).includes("grandfather"), false);
});

test("the bootstrap address is the hardcoded church address", () => {
  assert.equal(BOOTSTRAP_ADMIN_EMAIL, "mitchell.peck@graceresurrection.org");
  assert.equal(BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_EMAIL.toLowerCase());
});

test("base DDL is idempotent in shape, so every boot can run it", () => {
  assert.match(BASE_DDL, /ADD COLUMN IF NOT EXISTS is_admin/);
  assert.match(BASE_DDL, /ADD COLUMN IF NOT EXISTS active/);
  assert.match(BASE_DDL, /ALTER COLUMN google_sub DROP NOT NULL/);
  assert.match(BASE_DDL, /CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx/);
  assert.match(BASE_DDL, /CREATE TABLE IF NOT EXISTS user_app_access/);
});
