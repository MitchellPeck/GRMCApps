import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DRIVE_SCOPE, consentUrl, finishConsent, multipartBody, startConsent } from "./google";

test("consent state is single-use, per user, and expires", () => {
  const s = startConsent("a@x.org", 5, 1000);
  assert.equal(finishConsent(s, "b@x.org", 1000), null, "someone else's state is refused");
  const s2 = startConsent("a@x.org", 5, 1000);
  assert.equal(finishConsent(s2, "a@x.org", 2000), 5);
  assert.equal(finishConsent(s2, "a@x.org", 2000), null, "a state works once");
  const s3 = startConsent("a@x.org", 6, 1000);
  assert.equal(finishConsent(s3, "a@x.org", 1000 + 11 * 60 * 1000), null, "expired");
});

test("consentUrl asks offline for drive.file only", () => {
  const u = new URL(consentUrl({ clientId: "cid", clientSecret: "x", redirectUri: "https://m/cb" }, "st", "a@x.org"));
  assert.equal(u.searchParams.get("scope"), DRIVE_SCOPE);
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("redirect_uri"), "https://m/cb");
  assert.equal(u.searchParams.get("login_hint"), "a@x.org");
  assert.equal(u.searchParams.get("state"), "st");
});

test("multipartBody asks Drive to convert the HTML into a Doc", () => {
  const body = multipartBody("Board — Minutes", "<p>hi</p>", "B");
  const parts = body.split("\r\n");
  assert.equal(parts[0], "--B");
  assert.deepEqual(JSON.parse(parts[3]), { name: "Board — Minutes", mimeType: "application/vnd.google-apps.document" });
  assert.equal(parts[5], "Content-Type: text/html; charset=UTF-8");
  assert.equal(parts[7], "<p>hi</p>");
  assert.equal(parts[8], "--B--");
});
