import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decideLogin, UserRecord } from "./login-decision";

function user(over: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "u1",
    email: "taylor@grmc.app",
    name: "Taylor Bacon",
    google_sub: null,
    active: true,
    is_admin: false,
    ...over,
  };
}

const claims = { sub: "google-123", email: "taylor@grmc.app", name: "Taylor Bacon" };

test("a returning user matched by google_sub is allowed", () => {
  const found = user({ google_sub: "google-123" });
  assert.deepEqual(decideLogin(found, null, claims), { kind: "returning", userId: "u1" });
});

test("an invited account's first sign-in binds the Google identity", () => {
  assert.deepEqual(decideLogin(null, user(), claims), { kind: "bind", userId: "u1" });
});

test("an unprovisioned Google account is denied", () => {
  assert.deepEqual(decideLogin(null, null, claims), {
    kind: "deny",
    reason: "not_provisioned",
  });
});

test("a disabled account is denied whether matched by sub or by email", () => {
  const bySub = user({ google_sub: "google-123", active: false });
  assert.deepEqual(decideLogin(bySub, null, claims), { kind: "deny", reason: "disabled" });

  const byEmail = user({ active: false });
  assert.deepEqual(decideLogin(null, byEmail, claims), { kind: "deny", reason: "disabled" });
});

test("an email already bound to a different Google identity is denied", () => {
  const byEmail = user({ google_sub: "google-OTHER" });
  assert.deepEqual(decideLogin(null, byEmail, claims), {
    kind: "deny",
    reason: "email_bound_elsewhere",
  });
});

test("identity theft beats the disabled check, so the log names the real problem", () => {
  const byEmail = user({ google_sub: "google-OTHER", active: false });
  assert.deepEqual(decideLogin(null, byEmail, claims), {
    kind: "deny",
    reason: "email_bound_elsewhere",
  });
});
