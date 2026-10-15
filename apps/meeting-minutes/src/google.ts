import { randomBytes } from "node:crypto";
import { Pool } from "pg";

// Google Drive export for "Open in Google Docs". Each user grants the
// drive.file scope once — it reaches only files this app creates — and the
// refresh token is kept so later exports go straight to the new Doc.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_TIMEOUT_MS = 30 * 1000;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// Raised when the stored grant is gone or revoked: the caller sends the user
// back through consent rather than showing an error.
export class NeedsConsentError extends Error {}

// ── Consent state ───────────────────────────────────────────────────────────
// The OAuth `state` ties a callback to the user and meeting that started it.
// Kept in memory: a restart mid-consent only means clicking the button again.

interface PendingConsent { email: string; meetingId: number; expires: number }
const pending = new Map<string, PendingConsent>();
const CONSENT_TTL_MS = 10 * 60 * 1000;

export function startConsent(email: string, meetingId: number, now = Date.now()): string {
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  const state = randomBytes(24).toString("base64url");
  pending.set(state, { email, meetingId, expires: now + CONSENT_TTL_MS });
  return state;
}

// One use only. Null when unknown, expired, or started by someone else.
export function finishConsent(state: string, email: string, now = Date.now()): number | null {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.expires < now || p.email !== email) return null;
  return p.meetingId;
}

export function consentUrl(client: GoogleClient, state: string, email: string): string {
  const q = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    // Without "consent" Google omits the refresh token on a repeat grant.
    prompt: "consent",
    include_granted_scopes: "true",
    login_hint: email,
    state,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

// ── Tokens ──────────────────────────────────────────────────────────────────

async function tokenRequest(params: Record<string, string>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Could not reach Google: ${(e as Error).message}`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === "invalid_grant") throw new NeedsConsentError("Google access was revoked.");
    throw new Error(`Google sign-in failed: ${data.error_description || data.error || res.status}`);
  }
  return data;
}

export async function exchangeCode(dbPool: Pool, client: GoogleClient, email: string, code: string): Promise<void> {
  const data = await tokenRequest({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: client.redirectUri,
    grant_type: "authorization_code",
  });
  if (!String(data.scope ?? "").split(" ").includes(DRIVE_SCOPE)) {
    throw new Error("Google Drive access was not granted. Tick the Drive box on Google's consent screen.");
  }
  if (!data.refresh_token) throw new Error("Google did not return a refresh token. Try again.");
  await dbPool.query(
    `INSERT INTO google_tokens (email, refresh_token, access_token, expires_at, updated_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4), now())
     ON CONFLICT (email) DO UPDATE
       SET refresh_token = $2, access_token = $3, expires_at = now() + make_interval(secs => $4), updated_at = now()`,
    [email, data.refresh_token, data.access_token ?? "", Number(data.expires_in ?? 0)]
  );
}

// A usable access token for this user, refreshed when within a minute of
// expiry. NeedsConsentError when the user has never granted access.
export async function accessToken(dbPool: Pool, client: GoogleClient, email: string): Promise<string> {
  const r = await dbPool.query(
    "SELECT refresh_token, access_token, (expires_at > now() + interval '60 seconds') AS fresh FROM google_tokens WHERE email = $1",
    [email]
  );
  const row = r.rows[0];
  if (!row) throw new NeedsConsentError("Google Drive is not connected yet.");
  if (row.fresh && row.access_token) return row.access_token;
  let data: any;
  try {
    data = await tokenRequest({
      refresh_token: row.refresh_token,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
    });
  } catch (e) {
    if (e instanceof NeedsConsentError) await forgetToken(dbPool, email);
    throw e;
  }
  await dbPool.query(
    "UPDATE google_tokens SET access_token = $2, expires_at = now() + make_interval(secs => $3), updated_at = now() WHERE email = $1",
    [email, data.access_token, Number(data.expires_in ?? 0)]
  );
  return data.access_token;
}

export async function forgetToken(dbPool: Pool, email: string): Promise<void> {
  await dbPool.query("DELETE FROM google_tokens WHERE email = $1", [email]);
}

// ── Upload ──────────────────────────────────────────────────────────────────

// A multipart/related body: Drive metadata, then the HTML that Drive converts
// into a native Google Doc.
export function multipartBody(name: string, html: string, boundary: string): string {
  const meta = JSON.stringify({ name, mimeType: "application/vnd.google-apps.document" });
  return [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    meta,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

// Create a Google Doc in the user's Drive from report HTML. Returns its link.
export async function createDoc(token: string, name: string, html: string): Promise<string> {
  const boundary = `minutes-${randomBytes(12).toString("hex")}`;
  let res: Response;
  try {
    res = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody(name, html, boundary),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Could not reach Google Drive: ${(e as Error).message}`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401) throw new NeedsConsentError("Google Drive access expired.");
  if (!res.ok) {
    const message = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Google Drive refused the upload: ${message}`);
  }
  return data.webViewLink || `https://docs.google.com/document/d/${data.id}/edit`;
}
