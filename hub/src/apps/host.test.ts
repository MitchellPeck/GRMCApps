import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isSiblingOrigin, subdomainFromHost } from "./host";

test("subdomainFromHost extracts the app subdomain under the base domain", () => {
  assert.equal(subdomainFromHost("social.grmc.app", "grmc.app"), "social");
  assert.equal(subdomainFromHost("whoami.lvh.me", "lvh.me"), "whoami");
  assert.equal(subdomainFromHost("social.evil.com", "grmc.app"), null);
  assert.equal(subdomainFromHost("grmc.app", "grmc.app"), null);
});

test("isSiblingOrigin only accepts https origins under the base domain", () => {
  assert.equal(isSiblingOrigin("https://social.grmc.app", "grmc.app"), true);
  assert.equal(isSiblingOrigin("https://minutes.grmc.app", "grmc.app"), true);
  assert.equal(isSiblingOrigin("https://grmc.app", "grmc.app"), false);
  assert.equal(isSiblingOrigin("https://social.evil.com", "grmc.app"), false);
  assert.equal(isSiblingOrigin("http://social.grmc.app", "grmc.app"), false);
  assert.equal(isSiblingOrigin("https://social.grmc.app.evil.com", "grmc.app"), false);
  assert.equal(isSiblingOrigin("", "grmc.app"), false);
});
