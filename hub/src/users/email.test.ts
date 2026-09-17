import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isValidEmail, normalizeEmail, sameEmail } from "./email";

test("normalizeEmail trims and lowercases, so email is a stable invite key", () => {
  assert.equal(normalizeEmail("  Mitchell.Peck@GraceResurrection.org "), "mitchell.peck@graceresurrection.org");
  assert.equal(normalizeEmail("a@b.co"), "a@b.co");
});

test("sameEmail compares case-insensitively", () => {
  assert.equal(sameEmail("A@B.CO", "a@b.co"), true);
  assert.equal(sameEmail("a@b.co", "a@c.co"), false);
});

test("isValidEmail accepts ordinary addresses", () => {
  assert.equal(isValidEmail("mitchell.peck@graceresurrection.org"), true);
  assert.equal(isValidEmail("  taylor@grmc.app  "), true);
  assert.equal(isValidEmail("a+tag@b.co.uk"), true);
});

test("isValidEmail rejects malformed addresses", () => {
  assert.equal(isValidEmail(""), false);
  assert.equal(isValidEmail("   "), false);
  assert.equal(isValidEmail("no-at-sign.org"), false);
  assert.equal(isValidEmail("two@at@signs.org"), false);
  assert.equal(isValidEmail("@nolocal.org"), false);
  assert.equal(isValidEmail("nodomain@"), false);
  assert.equal(isValidEmail("no@tld"), false);
  assert.equal(isValidEmail("spaces in@email.org"), false);
  assert.equal(isValidEmail("dot@.leading.org"), false);
  assert.equal(isValidEmail("dot@trailing.org."), false);
  assert.equal(isValidEmail("double@dots..org"), false);
  assert.equal(isValidEmail("a".repeat(250) + "@b.co"), false);
});
