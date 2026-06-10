import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { setSetting, getSetting, getSettingsView } from "./settings";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

test("settings round-trip and view never leaks raw key", async () => {
  await setSetting(pool, "anthropic_api_key", "sk-ant-SECRETVALUE-123");
  await setSetting(pool, "mailchimp_api_key", "abc-us21");
  await setSetting(pool, "mailchimp_server", "us21");

  assert.equal(await getSetting(pool, "anthropic_api_key"), "sk-ant-SECRETVALUE-123");

  const view = await getSettingsView(pool);
  assert.equal(view.hasAnthropicKey, true);
  assert.equal(view.hasMailchimp, true);
  assert.equal(view.mailchimpServer, "us21");
  // Hint is a truncated prefix, NOT the full key.
  assert.equal(view.anthropicKeyHint, "sk-ant-SEC...");
  assert.ok(!JSON.stringify(view).includes("SECRETVALUE"), "view must not contain the full key");

  await pool.query("DELETE FROM settings");
  await pool.end();
});
