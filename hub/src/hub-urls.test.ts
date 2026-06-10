import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deriveHubUrls } from "./hub-urls";

test("deriveHubUrls builds hub URLs from the base domain", () => {
  const u = deriveHubUrls("grmc.app");
  assert.equal(u.publicUrl, "https://hub.grmc.app");
  assert.equal(u.cookieDomain, ".grmc.app");
  assert.equal(u.redirectUri, "https://hub.grmc.app/auth/callback");

  const dev = deriveHubUrls("lvh.me");
  assert.equal(dev.publicUrl, "https://hub.lvh.me");
  assert.equal(dev.cookieDomain, ".lvh.me");
});
