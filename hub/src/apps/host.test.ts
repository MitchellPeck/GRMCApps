import { strict as assert } from "node:assert";
import { test } from "node:test";
import { subdomainFromHost } from "./host";

test("subdomainFromHost extracts the app subdomain under the base domain", () => {
  assert.equal(subdomainFromHost("social.grmc.app", "grmc.app"), "social");
  assert.equal(subdomainFromHost("whoami.lvh.me", "lvh.me"), "whoami");
  assert.equal(subdomainFromHost("social.evil.com", "grmc.app"), null);
  assert.equal(subdomainFromHost("grmc.app", "grmc.app"), null);
});
