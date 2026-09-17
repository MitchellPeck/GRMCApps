import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decideAdminRequest } from "./guard";

const HUB = "https://hub.grmc.app";
const admin = { id: "a1", email: "a@g.org", name: null, is_admin: true, active: true };

test("an admin reading the screen is allowed", () => {
  assert.deepEqual(decideAdminRequest(admin, "GET", "", HUB), { ok: true });
});

test("a signed-out visitor is refused", () => {
  assert.deepEqual(decideAdminRequest(null, "GET", "", HUB), {
    ok: false,
    status: 403,
    error: "Sign in first.",
  });
});

test("a non-admin is refused, even though they are a real signed-in user", () => {
  const plain = { ...admin, is_admin: false };
  assert.deepEqual(decideAdminRequest(plain, "GET", "", HUB), {
    ok: false,
    status: 403,
    error: "You do not have access to user management.",
  });
});

test("a disabled admin is refused", () => {
  const disabled = { ...admin, active: false };
  assert.deepEqual(decideAdminRequest(disabled, "GET", "", HUB), {
    ok: false,
    status: 403,
    error: "You do not have access to user management.",
  });
});

test("a mutation from a foreign origin is refused", () => {
  assert.deepEqual(decideAdminRequest(admin, "POST", "https://evil.example", HUB), {
    ok: false,
    status: 403,
    error: "Bad origin.",
  });
});

test("a mutation from the hub's own origin is allowed", () => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    assert.deepEqual(decideAdminRequest(admin, method, HUB, HUB), { ok: true });
  }
});

test("a mutation with no Origin header at all is allowed", () => {
  // Non-browser callers (curl, a future script) send none, and the SameSite=Lax
  // session cookie is what actually stops a cross-site browser POST.
  assert.deepEqual(decideAdminRequest(admin, "DELETE", "", HUB), { ok: true });
});

test("origin is never consulted for reads", () => {
  assert.deepEqual(decideAdminRequest(admin, "GET", "https://evil.example", HUB), { ok: true });
  assert.deepEqual(decideAdminRequest(admin, "HEAD", "https://evil.example", HUB), { ok: true });
});
