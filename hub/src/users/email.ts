// Email is the invite key: an administrator creates an account by address, and
// Google's identity is bound to it on first sign-in. Every comparison is
// case-insensitive, matching the `users_email_lower_idx` unique index.
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function sameEmail(a: string, b: string): boolean {
  return normalizeEmail(a) === normalizeEmail(b);
}

// Deliberately structural rather than RFC-exhaustive: this guards an admin
// typing an address into a form, and Google is the real authority on whether
// an address exists.
export function isValidEmail(raw: string): boolean {
  const email = raw.trim();
  if (email.length === 0 || email.length > 254) return false;
  if (/\s/.test(email)) return false;

  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;

  const domain = email.slice(at + 1);
  if (!domain.includes(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  if (domain.includes("..")) return false;

  return true;
}
