# Metricool Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Send to Metricool" to the social-posts app that schedules a drafted post into Metricool's planner as a draft (`autoPublish:false`), optionally attaching an approved graphic from the Approvals app (published to a public Cloudflare R2 URL so Metricool can fetch it).

**Architecture:** Two phases. **Phase 1** (Tasks 1–5) ships a working text-only "Send to Metricool" using the existing social-posts patterns (DB-backed settings, `{ok,...}` routes, fetch frontend). **Phase 2** (Tasks 6–9) adds the image path: an approved-gallery API on the Approvals app, a cross-app client, Cloudflare R2 upload, and an image picker in the send modal.

**Tech Stack:** Node 20 + TypeScript + Fastify 5, `pg`, `@aws-sdk/client-s3` (R2, S3-compatible), Metricool scheduler API, Cloudflare R2, the existing Approvals + social-posts apps.

---

## Context the implementer needs

- All work is in the **`social-posts`** app (`apps/social-posts/`), except Task 6 which adds endpoints to the **`approvals`** app (`apps/approvals/`). Both are Fastify+TS apps behind the hub's forwardAuth, each with its own Postgres DB. Strict TypeScript (do not disable strict flags).
- Established patterns to follow (read them): `apps/social-posts/src/settings.ts` (generic `getSetting`/`setSetting`/`getSettingsView`), `claude.ts`/`mailchimp.ts` (module + `{ok,...}`), `routes/*.ts`, `db.ts` (`ensureSchema()` runs DDL on boot), `identity.ts` (`getIdentity(req)` reads `X-Auth-*`), `public/app.js` (the `api()` fetch helper + modal/card patterns).
- The Approvals app exposes (confirmed): `GET /api/requests?box=inbox|sent`, `GET /api/requests/:id`, `GET /api/requests/:id/versions/:n/image`. Status values include `'approved'`. `request_versions` holds `image bytea`, `mime_type`, `file_name`. There is **no** "list approved" endpoint and image access is restricted to submitter/approver — Task 6 adds a team-visible approved gallery.
- **Pin-against-live-API items** (the dev runs these with real creds during implementation): Metricool's exact `brands` and `media-normalize` paths and the per-network media fields. The scheduler endpoint + core payload are confirmed: `POST https://app.metricool.com/api/v2/scheduler/posts?userId=&blogId=`, header `X-Mc-Auth`, body `{publicationDate:{dateTime,timezone}, text, providers:[{network}], autoPublish:false}`.
- Tests: Node's built-in runner. Pure-logic + DB tests run in a throwaway container (pattern below). Real Metricool/R2 calls are manual (need live creds).

Throwaway test runner (from repo root):
```bash
SP_PASS=$(grep '^SOCIALPOSTS_DB_PASSWORD=' .env | cut -d= -f2)
docker run --rm --network grmcapps_hubnet -v "$PWD/apps/social-posts":/work -w /work \
  -e TEST_DATABASE_URL="postgres://socialposts_user:${SP_PASS}@postgres:5432/socialposts" \
  node:20-alpine sh -c "npm install --silent && npm run build && node --test dist/<FILE>.test.js"
rm -f apps/social-posts/package-lock.json
```

## File structure

```
apps/social-posts/src/
  schema.ts            # + metricool_sends table
  settings.ts          # + Metricool/R2 flags & non-secret fields in getSettingsView
  metricool.ts         # creds, buildSchedulerPayload(pure), suggestDateTime(pure), listBrands, normalizeMedia, schedulePost
  metricool.test.ts    # pure-logic tests
  metricool-sends.ts   # logSend(), listRecentSends()
  r2.ts                # uploadPublic() (S3->R2), objectKey/publicUrl (pure)
  r2.test.ts
  approvals-client.ts  # listApprovedImages(identity), getApprovedImageBytes(identity,id)
  routes/metricool.ts  # /api/metricool/{status,brands,approved-images,send}
  public/index.html    # + Metricool & R2 settings sections + send-modal markup
  public/app.js        # + send modal, send buttons, image picker
apps/approvals/src/
  requests.ts          # + listApproved(), getApprovedImage()
  routes/requests.ts   # + GET /api/approved, GET /api/approved/:id/image
  requests.test.ts     # + approved-gallery test
```

---

# Phase 1 — Core "Send to Metricool" (text)

### Task 1: `metricool_sends` table, sends log module, settings flags

**Files:** Modify `apps/social-posts/src/schema.ts`, `apps/social-posts/src/settings.ts`; Create `apps/social-posts/src/metricool-sends.ts`

- [ ] **Step 1: Add the table to `apps/social-posts/src/schema.ts`** — append inside the `SCHEMA_SQL` template literal (before the closing backtick):
```sql

CREATE TABLE IF NOT EXISTS metricool_sends (
  id                bigserial PRIMARY KEY,
  source_type       text NOT NULL DEFAULT '',
  source_ref        text NOT NULL DEFAULT '',
  text              text NOT NULL,
  networks          text NOT NULL,
  image_ref         text NOT NULL DEFAULT '',
  r2_url            text NOT NULL DEFAULT '',
  scheduled_for     text NOT NULL,
  timezone          text NOT NULL,
  metricool_post_id text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'sent',
  error             text NOT NULL DEFAULT '',
  created_by        text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Create `apps/social-posts/src/metricool-sends.ts`**
```typescript
import { Pool } from "pg";

export interface SendLog {
  sourceType: string; sourceRef: string; text: string; networks: string;
  imageRef: string; r2Url: string; scheduledFor: string; timezone: string;
  metricoolPostId: string; status: "sent" | "error"; error: string; createdBy: string;
}

export async function logSend(pool: Pool, s: SendLog): Promise<void> {
  await pool.query(
    `INSERT INTO metricool_sends
       (source_type, source_ref, text, networks, image_ref, r2_url, scheduled_for, timezone, metricool_post_id, status, error, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [s.sourceType, s.sourceRef, s.text, s.networks, s.imageRef, s.r2Url, s.scheduledFor, s.timezone, s.metricoolPostId, s.status, s.error, s.createdBy]
  );
}
```

- [ ] **Step 3: Extend `getSettingsView` in `apps/social-posts/src/settings.ts`** — add Metricool/R2 flags + non-secret values. Add to the `SettingsView` interface:
```typescript
  hasMetricool: boolean;
  metricoolUserId: string;
  metricoolBlogId: string;
  defaultPostTime: string;
  defaultTimezone: string;
  hasR2: boolean;
```
And in `getSettingsView`, after the existing reads, add:
```typescript
  const mcToken = await getSetting(pool, "metricool_token");
  const mcUser = await getSetting(pool, "metricool_user_id");
  const r2Key = await getSetting(pool, "r2_access_key_id");
  const r2Bucket = await getSetting(pool, "r2_bucket");
```
and include in the returned object:
```typescript
    hasMetricool: !!(mcToken && mcUser),
    metricoolUserId: mcUser,
    metricoolBlogId: await getSetting(pool, "metricool_blog_id"),
    defaultPostTime: (await getSetting(pool, "default_post_time")) || "09:00",
    defaultTimezone: (await getSetting(pool, "default_timezone")) || "America/New_York",
    hasR2: !!(r2Key && r2Bucket),
```

- [ ] **Step 4: Accept the new keys in `POST /api/settings`** — in `apps/social-posts/src/routes/settings.ts`, extend `SaveBody` and the save block to persist (only when non-empty, like the existing keys): `metricoolToken`→`metricool_token`, `metricoolUserId`→`metricool_user_id`, `metricoolBlogId`→`metricool_blog_id`, `defaultPostTime`→`default_post_time`, `defaultTimezone`→`default_timezone`, `r2AccountId`→`r2_account_id`, `r2AccessKeyId`→`r2_access_key_id`, `r2SecretAccessKey`→`r2_secret_access_key`, `r2Bucket`→`r2_bucket`, `r2PublicBaseUrl`→`r2_public_base_url`. (Same `if (s.x && s.x.trim()) await setSetting(...)` shape as the Anthropic key.)

- [ ] **Step 5: Rebuild + verify the table and settings view**
```bash
docker compose up -d --build social-posts; sleep 4
docker compose exec -T postgres psql -U postgres -d socialposts -c "\dt" | grep metricool_sends
docker compose exec -T social-posts wget -qO- --post-data='{"metricoolToken":"tok","metricoolUserId":"123","defaultPostTime":"08:30"}' --header="Content-Type: application/json" http://0.0.0.0:3000/api/settings; echo
docker compose exec -T social-posts wget -qO- http://0.0.0.0:3000/api/settings; echo
```
Expected: `metricool_sends` table exists; first call `{"ok":true}`; second shows `"hasMetricool":true`, `"metricoolUserId":"123"`, `"defaultPostTime":"08:30"`, and NO raw token.

- [ ] **Step 6: Commit**
```bash
rm -f apps/social-posts/package-lock.json
git add apps/social-posts/src/schema.ts apps/social-posts/src/metricool-sends.ts apps/social-posts/src/settings.ts apps/social-posts/src/routes/settings.ts
git commit -m "feat: metricool_sends table, send log, and Metricool/R2 settings fields"
```

---

### Task 2: Pure helpers — payload builder + date suggester (TDD)

**Files:** Create `apps/social-posts/src/metricool.ts` (partial), `apps/social-posts/src/metricool.test.ts`

- [ ] **Step 1: Write the failing test `apps/social-posts/src/metricool.test.ts`**
```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSchedulerPayload, suggestDateTime, charWarnings } from "./metricool";

test("buildSchedulerPayload shapes the Metricool body", () => {
  const p = buildSchedulerPayload({
    text: "Hello", networks: ["facebook", "instagram"],
    dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrl: "",
  });
  assert.equal(p.autoPublish, false);
  assert.deepEqual(p.publicationDate, { dateTime: "2026-06-15T09:00:00", timezone: "America/New_York" });
  assert.deepEqual(p.providers, [{ network: "facebook" }, { network: "instagram" }]);
  assert.equal(p.text, "Hello");
  // Facebook requires a post type
  assert.equal(p.facebookData?.type, "POST");
  // No media field when no url
  assert.equal("media" in p, false);
});

test("buildSchedulerPayload includes media when given a url", () => {
  const p = buildSchedulerPayload({ text: "x", networks: ["instagram"], dateTime: "2026-06-15T09:00:00", timezone: "America/New_York", mediaUrl: "https://pub/x.jpg" });
  assert.deepEqual(p.media, ["https://pub/x.jpg"]);
});

test("suggestDateTime maps a weekday key to the next such day at the default time", () => {
  // 2026-06-10 is a Wednesday; 'monday' -> next Monday 2026-06-15
  const iso = suggestDateTime({ kind: "weekday", weekday: "monday" }, { refDate: "2026-06-10", time: "09:00" });
  assert.equal(iso, "2026-06-15T09:00:00");
  // a series 'Mon DD' date -> that date in the ref year at the default time
  const iso2 = suggestDateTime({ kind: "seriesDate", label: "Jun 16" }, { refDate: "2026-06-10", time: "09:00" });
  assert.equal(iso2, "2026-06-16T09:00:00");
});

test("charWarnings flags Instagram over 2200", () => {
  const w = charWarnings("a".repeat(2300), ["instagram"]);
  assert.ok(w.some((m) => m.toLowerCase().includes("instagram")));
  assert.equal(charWarnings("short", ["instagram", "facebook"]).length, 0);
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing). Use the throwaway runner with `<FILE>=metricool`.

- [ ] **Step 3: Implement the pure helpers in `apps/social-posts/src/metricool.ts`**
```typescript
export interface PayloadInput {
  text: string;
  networks: string[];            // e.g. ["facebook","instagram"]
  dateTime: string;              // local ISO, no offset: 2026-06-15T09:00:00
  timezone: string;              // e.g. America/New_York
  mediaUrl: string;              // "" when none
}
export interface SchedulerPayload {
  publicationDate: { dateTime: string; timezone: string };
  text: string;
  providers: Array<{ network: string }>;
  autoPublish: boolean;
  facebookData?: { type: string };
  media?: string[];
}

export function buildSchedulerPayload(i: PayloadInput): SchedulerPayload {
  const payload: SchedulerPayload = {
    publicationDate: { dateTime: i.dateTime, timezone: i.timezone },
    text: i.text,
    providers: i.networks.map((n) => ({ network: n })),
    autoPublish: false,
  };
  if (i.networks.includes("facebook")) payload.facebookData = { type: "POST" };
  if (i.mediaUrl) payload.media = [i.mediaUrl];
  return payload;
}

const WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
const MONTHS: Record<string, number> = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };

export type DateSource =
  | { kind: "weekday"; weekday: string }     // 'monday'...
  | { kind: "seriesDate"; label: string };   // 'Jun 16'

// Produce a local ISO (no timezone offset) at the default time. The timezone is
// carried separately in the Metricool publicationDate.
export function suggestDateTime(src: DateSource, def: { refDate: string; time: string }): string {
  const [y, m, d] = def.refDate.split("-").map(Number);
  const ref = new Date(Date.UTC(y, m - 1, d, 12));
  let target: Date;
  if (src.kind === "weekday") {
    const want = WEEKDAYS.indexOf(src.weekday.toLowerCase());
    const cur = ref.getUTCDay();
    let delta = (want - cur + 7) % 7;
    if (delta === 0) delta = 7; // "next" such weekday
    target = new Date(ref.getTime() + delta * 86400000);
  } else {
    const [mon, day] = src.label.split(" ");
    target = new Date(Date.UTC(ref.getUTCFullYear(), MONTHS[mon] ?? 0, parseInt(day, 10), 12));
  }
  const yyyy = target.getUTCFullYear();
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(target.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${def.time}:00`;
}

const LIMITS: Record<string, number> = { instagram: 2200, facebook: 16192, twitter: 280, google: 1500 };
export function charWarnings(text: string, networks: string[]): string[] {
  const out: string[] = [];
  for (const n of networks) {
    const lim = LIMITS[n];
    if (lim && text.length > lim) out.push(`${n} limit is ${lim} chars; this post is ${text.length}.`);
  }
  return out;
}
```

- [ ] **Step 4: Run the test — expect PASS** (`pass 4`).

- [ ] **Step 5: Commit**
```bash
rm -f apps/social-posts/package-lock.json
git add apps/social-posts/src/metricool.ts apps/social-posts/src/metricool.test.ts
git commit -m "feat: tested Metricool payload builder + date suggester + char warnings"
```

---

### Task 3: Metricool API client (creds, brands, normalize, schedule)

**Files:** Modify `apps/social-posts/src/metricool.ts`

- [ ] **Step 1: Append the credentials + HTTP client to `apps/social-posts/src/metricool.ts`**
```typescript
import { Pool } from "pg";
import { getSetting } from "./settings";

export interface MetricoolCreds { token: string; userId: string; blogId: string; }

export async function getMetricoolCreds(pool: Pool): Promise<MetricoolCreds> {
  const token = await getSetting(pool, "metricool_token");
  const userId = await getSetting(pool, "metricool_user_id");
  const blogId = await getSetting(pool, "metricool_blog_id");
  if (!token || !userId) throw new Error("Metricool not configured — add your token in Settings.");
  return { token, userId, blogId };
}

const BASE = "https://app.metricool.com/api";

function mcHeaders(c: MetricoolCreds): Record<string, string> {
  return { "X-Mc-Auth": c.token, "content-type": "application/json" };
}

// List the brands the token can access so the user can pick a blogId.
// NOTE: confirm the exact brands path against the live API/CLI during build;
// adjust the path/field mapping here if it differs.
export async function listBrands(c: MetricoolCreds): Promise<Array<{ id: string; label: string }>> {
  const res = await fetch(`${BASE}/admin/simpleProfiles?userId=${encodeURIComponent(c.userId)}`, { headers: mcHeaders(c) });
  const data: any = await res.json();
  const arr: any[] = Array.isArray(data) ? data : data.profiles || data.brands || [];
  return arr.map((b) => ({ id: String(b.blogId ?? b.id), label: String(b.label ?? b.title ?? b.brand ?? b.blogId ?? b.id) }));
}

// Normalize a PUBLIC media url so Metricool hosts it; returns the usable url.
// NOTE: confirm the exact normalize path against the live API during build.
export async function normalizeMedia(c: MetricoolCreds, publicUrl: string): Promise<string> {
  const url = `${BASE}/v2/scheduler/medias?userId=${encodeURIComponent(c.userId)}&blogId=${encodeURIComponent(c.blogId)}&url=${encodeURIComponent(publicUrl)}`;
  const res = await fetch(url, { headers: mcHeaders(c) });
  if (!res.ok) throw new Error(`Metricool media normalize failed (${res.status})`);
  const data: any = await res.json();
  return String(data.url ?? data.media ?? publicUrl);
}

export async function schedulePost(c: MetricoolCreds, payload: SchedulerPayload): Promise<string> {
  const url = `${BASE}/v2/scheduler/posts?userId=${encodeURIComponent(c.userId)}&blogId=${encodeURIComponent(c.blogId)}`;
  const res = await fetch(url, { method: "POST", headers: mcHeaders(c), body: JSON.stringify(payload) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `Metricool scheduler failed (${res.status})`);
  return String(data.id ?? data.postId ?? "");
}
```
(The `import { Pool }` / pure-helper interfaces from Task 2 stay at the top; merge imports so there's a single import block.)

- [ ] **Step 2: Build to confirm it compiles** (no new unit test — these are network calls, verified manually). Run the throwaway runner with `<FILE>=metricool` again — the existing `pass 4` must still pass and the file must compile.

- [ ] **Step 3: Commit**
```bash
rm -f apps/social-posts/package-lock.json
git add apps/social-posts/src/metricool.ts
git commit -m "feat: Metricool API client (creds, brands, media normalize, schedule)"
```

---

### Task 4: `/api/metricool/*` routes (status, brands, send) — text path

**Files:** Create `apps/social-posts/src/routes/metricool.ts`; Modify `apps/social-posts/src/index.ts`

- [ ] **Step 1: Create `apps/social-posts/src/routes/metricool.ts`**
```typescript
import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { getSettingsView } from "../settings";
import { getMetricoolCreds, listBrands, normalizeMedia, schedulePost, buildSchedulerPayload, charWarnings } from "../metricool";
import { logSend } from "../metricool-sends";

interface SendBody {
  text: string; networks: string[]; dateTime: string; timezone: string;
  imageUrl?: string; approvedImageId?: string; sourceType?: string; sourceRef?: string;
}

export async function metricoolRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/metricool/status", async () => {
    try {
      const v = await getSettingsView(pool);
      return { ok: true, hasMetricool: v.hasMetricool, hasR2: v.hasR2 };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  app.get("/api/metricool/brands", async () => {
    try { return { ok: true, brands: await listBrands(await getMetricoolCreds(pool)) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  app.post("/api/metricool/send", async (req) => {
    const b = (req.body ?? {}) as SendBody;
    const email = getIdentity(req).email;
    try {
      const creds = await getMetricoolCreds(pool);
      const networks = Array.isArray(b.networks) ? b.networks : [];
      const warnings = charWarnings(b.text || "", networks);

      // Phase 1: text + optional already-public imageUrl. (approvedImageId handled in Phase 2.)
      let mediaUrl = "";
      if (b.imageUrl && b.imageUrl.trim()) mediaUrl = await normalizeMedia(creds, b.imageUrl.trim());

      const note = networks.includes("instagram") && !mediaUrl
        ? "Instagram needs an image — add it in Metricool before publishing." : "";

      const payload = buildSchedulerPayload({ text: b.text || "", networks, dateTime: b.dateTime, timezone: b.timezone, mediaUrl });
      const postId = await schedulePost(creds, payload);

      await logSend(pool, {
        sourceType: b.sourceType || "", sourceRef: b.sourceRef || "", text: b.text || "",
        networks: networks.join(","), imageRef: b.approvedImageId || b.imageUrl || "", r2Url: mediaUrl,
        scheduledFor: b.dateTime, timezone: b.timezone, metricoolPostId: postId, status: "sent", error: "", createdBy: email,
      });
      return { ok: true, metricoolPostId: postId, scheduledFor: b.dateTime, warnings, note };
    } catch (e) {
      await logSend(pool, {
        sourceType: b.sourceType || "", sourceRef: b.sourceRef || "", text: b.text || "",
        networks: (b.networks || []).join(","), imageRef: b.approvedImageId || b.imageUrl || "", r2Url: "",
        scheduledFor: b.dateTime || "", timezone: b.timezone || "", metricoolPostId: "", status: "error",
        error: (e as Error).message, createdBy: email,
      }).catch(() => {});
      return { ok: false, error: (e as Error).message };
    }
  });
}
```
Register in `apps/social-posts/src/index.ts`: `import { metricoolRoutes } from "./routes/metricool";` + `app.register(metricoolRoutes);` after the existing route registrations.

- [ ] **Step 2: Rebuild + verify graceful no-creds behavior**
```bash
docker compose exec -T postgres psql -U postgres -d socialposts -c "DELETE FROM settings WHERE key IN ('metricool_token','metricool_user_id');"
docker compose up -d --build social-posts; sleep 4
docker compose exec -T social-posts wget -qO- http://0.0.0.0:3000/api/metricool/status; echo
docker compose exec -T social-posts wget -qO- --post-data='{"text":"hi","networks":["facebook"],"dateTime":"2026-06-15T09:00:00","timezone":"America/New_York"}' --header="Content-Type: application/json" http://0.0.0.0:3000/api/metricool/send; echo
```
Expected: status → `{"ok":true,"hasMetricool":false,"hasR2":false}`; send → `{"ok":false,"error":"Metricool not configured — add your token in Settings."}` (graceful — proves wiring; real send is manual with a token).

- [ ] **Step 3: Commit**
```bash
rm -f apps/social-posts/package-lock.json
git add apps/social-posts/src/routes/metricool.ts apps/social-posts/src/index.ts
git commit -m "feat: /api/metricool status/brands/send routes (text path)"
```

---

### Task 5: Frontend — Settings (Metricool) + Send modal + buttons (text path)

**Files:** Modify `apps/social-posts/src/public/index.html`, `apps/social-posts/src/public/app.js`

- [ ] **Step 1: Add a Metricool section to the Settings tab in `index.html`** (after the existing Mailchimp card, same card/markup style): fields `s-mc-token` (Metricool API token), `s-mc-user` (User ID), `s-mc-blog` (Blog ID) with a `btn-load-brands` button + a `mc-brands` select, `s-mc-time` (default post time, `type=time`), `s-mc-tz` (timezone text). Mirror the existing settings inputs' classes.

- [ ] **Step 2: Add the shared send-modal markup to `index.html`** (a hidden overlay at the end of `<body>`):
```html
<div id="mc-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:50;align-items:center;justify-content:center">
  <div class="card" style="max-width:520px;width:92%;max-height:90vh;overflow:auto">
    <div class="ct">Send to Metricool</div>
    <div class="field"><label>Post text</label><textarea id="mc-text" style="min-height:120px"></textarea></div>
    <div class="field"><label>Networks</label>
      <label style="font-weight:400"><input type="checkbox" id="mc-fb" checked> Facebook</label>
      <label style="font-weight:400;margin-left:12px"><input type="checkbox" id="mc-ig" checked> Instagram</label>
    </div>
    <div class="row2">
      <div class="field"><label>Date</label><input type="date" id="mc-date"></div>
      <div class="field"><label>Time</label><input type="time" id="mc-time"></div>
    </div>
    <div id="mc-image-area"><div class="field"><label>Image URL (optional, must be public)</label><input type="text" id="mc-imgurl" placeholder="https://..."></div></div>
    <div id="mc-msg"></div>
    <div class="btn-row">
      <button class="btn btn-primary" id="mc-send-btn" data-default="Send to Metricool" onclick="submitMetricool()">Send to Metricool</button>
      <button class="btn btn-secondary" onclick="closeMetricool()">Cancel</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add the JS to `app.js`** — the modal open/close, the date/time prefill, the network read, and the send call. Add:
```javascript
var _mcCtx = { sourceType:'', sourceRef:'' };
function openMetricool(text, opts){
  opts = opts || {};
  _mcCtx = { sourceType: opts.sourceType||'', sourceRef: opts.sourceRef||'' };
  document.getElementById('mc-text').value = text || '';
  // suggested date/time: opts.date (YYYY-MM-DD) else today; time from settings (loaded into _mcDefaults)
  var d = opts.date || new Date().toISOString().split('T')[0];
  document.getElementById('mc-date').value = d;
  document.getElementById('mc-time').value = (window._mcDefaults && _mcDefaults.time) || '09:00';
  document.getElementById('mc-imgurl').value = '';
  document.getElementById('mc-msg').innerHTML = '';
  document.getElementById('mc-modal').style.display = 'flex';
}
function closeMetricool(){ document.getElementById('mc-modal').style.display='none'; }
function submitMetricool(){
  var networks = [];
  if (document.getElementById('mc-fb').checked) networks.push('facebook');
  if (document.getElementById('mc-ig').checked) networks.push('instagram');
  var dateTime = document.getElementById('mc-date').value + 'T' + (document.getElementById('mc-time').value||'09:00') + ':00';
  var tz = (window._mcDefaults && _mcDefaults.tz) || 'America/New_York';
  setBtn('mc-send-btn', true, 'Sending...');
  api('/api/metricool/send', { method:'POST', body:{
    text: document.getElementById('mc-text').value, networks: networks, dateTime: dateTime, timezone: tz,
    imageUrl: document.getElementById('mc-imgurl').value, sourceType: _mcCtx.sourceType, sourceRef: _mcCtx.sourceRef
  }}).then(function(res){
    setBtn('mc-send-btn', false);
    var el = document.getElementById('mc-msg');
    if(!res.ok){ el.innerHTML = '<div class="alert alert-err">'+esc(res.error)+'</div>'; return; }
    var extra = (res.note? ' '+esc(res.note):'') + ((res.warnings&&res.warnings.length)? ' '+esc(res.warnings.join(' ')):'');
    el.innerHTML = '<div class="alert alert-ok">Sent to Metricool — scheduled '+esc(res.scheduledFor)+'.'+extra+'</div>';
  }).catch(function(e){ setBtn('mc-send-btn', false); document.getElementById('mc-msg').innerHTML = '<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}
```
Load the defaults in `checkAuthStatus()` (or wherever `/api/settings` is fetched) by stashing `window._mcDefaults = { time: s.defaultPostTime, tz: s.defaultTimezone }`. Add a "Load brands" handler that calls `api('/api/metricool/brands')` and fills the `mc-brands` select. Add `saveSettings` to include the new Metricool fields in its POST body.

- [ ] **Step 4: Add a "Send to Metricool" button to each post card.** In `postCard(...)` (run results) and the drafts list and the series draft preview, add a small button next to "Copy":
```javascript
'<button class="btn-sm" onclick="openMetricool(document.getElementById(\''+uid+'\').textContent)">→ Metricool</button>'
```
For series posts and drafts, pass `{sourceType, sourceRef, date}` where available (e.g. series: `{sourceType:'series', sourceRef:seriesId+':'+postIdx}`; drafts: `{sourceType:'draft', sourceRef:String(r.postDate)}`).

- [ ] **Step 5: Rebuild + verify served**
```bash
docker compose up -d --build social-posts; sleep 4
docker compose exec -T social-posts wget -qO- http://0.0.0.0:3000/app.js | grep -c "submitMetricool"
docker compose exec -T social-posts wget -qO- http://0.0.0.0:3000/ | grep -c "Send to Metricool"
```
Expected: both ≥ 1.

- [ ] **Step 6: Commit**
```bash
git add apps/social-posts/src/public/index.html apps/social-posts/src/public/app.js
git commit -m "feat: Send-to-Metricool modal, settings section, and post-card buttons (text path)"
```

> **Phase 1 manual check (real token):** in Settings enter the Metricool token + userId, Load brands, pick a blogId; from a draft click "→ Metricool", send → confirm a scheduled draft appears in Metricool's planner. If `brands`/scheduler paths differ from the placeholders, adjust `metricool.ts` (the pin-against-live items) and re-verify.

---

# Phase 2 — Approved-image attachment (Approvals → R2 → Metricool)

### Task 6: Approvals app — team-visible approved gallery

**Files:** Modify `apps/approvals/src/requests.ts`, `apps/approvals/src/routes/requests.ts`, `apps/approvals/src/requests.test.ts`

- [ ] **Step 1: Add a failing test to `apps/approvals/src/requests.test.ts`** for a new `listApproved` (returns approved requests team-wide) and `getApprovedImage` (current-version bytes, no submitter/approver restriction). Follow the existing test's setup (it already seeds requests); add:
```typescript
test("listApproved returns approved requests and getApprovedImage returns current-version bytes", async () => {
  // (reuse the suite's helper that creates a request + approves it; if none, create one,
  //  set status='approved'. Then:)
  const list = await listApproved(pool);
  assert.ok(Array.isArray(list));
  assert.ok(list.every((r) => typeof r.id === "number" && typeof r.title === "string" && typeof r.currentVersion === "number"));
  if (list.length) {
    const img = await getApprovedImage(pool, list[0].id);
    assert.ok(img.ok && Buffer.isBuffer(img.image) && img.mimeType.length > 0);
  }
});
```
(Import `listApproved, getApprovedImage` from `./requests`. Match the existing test file's pool/teardown pattern.)

- [ ] **Step 2: Implement in `apps/approvals/src/requests.ts`**
```typescript
export interface ApprovedItem { id: number; title: string; currentVersion: number; }
export async function listApproved(pool: Pool): Promise<ApprovedItem[]> {
  const r = await pool.query(
    "SELECT id, title, current_version FROM requests WHERE status = 'approved' ORDER BY updated_at DESC"
  );
  return r.rows.map((row) => ({ id: Number(row.id), title: row.title, currentVersion: Number(row.current_version) }));
}

export type ApprovedImageResult =
  | { ok: true; mimeType: string; fileName: string; image: Buffer }
  | { ok: false; status: number; error: string };
export async function getApprovedImage(pool: Pool, id: number): Promise<ApprovedImageResult> {
  const req = await pool.query("SELECT current_version, status FROM requests WHERE id = $1", [id]);
  if (!req.rows[0]) return { ok: false, status: 404, error: "Request not found." };
  if (req.rows[0].status !== "approved") return { ok: false, status: 403, error: "Request is not approved." };
  const v = await pool.query(
    "SELECT mime_type, file_name, image FROM request_versions WHERE request_id = $1 AND version_no = $2",
    [id, req.rows[0].current_version]
  );
  if (!v.rows[0]) return { ok: false, status: 404, error: "Image not found." };
  return { ok: true, mimeType: v.rows[0].mime_type, fileName: v.rows[0].file_name, image: v.rows[0].image };
}
```

- [ ] **Step 3: Add the routes in `apps/approvals/src/routes/requests.ts`** (inside `requestsRoutes`). Import `listApproved, getApprovedImage`. Add:
```typescript
  // Team-visible approved gallery (any authenticated hub user) — used by social-posts.
  app.get("/api/approved", async () => {
    try { return { ok: true, images: await listApproved(pool) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  app.get("/api/approved/:id/image", async (req, reply) => {
    const r = await getApprovedImage(pool, Number((req.params as { id: string }).id));
    if (!r.ok) { reply.code(r.status); return { ok: false, error: r.error }; }
    reply.header("Content-Type", r.mimeType).header("Cache-Control", "private, max-age=300");
    return reply.send(r.image);
  });
```
(These require an authenticated request — the host is behind forwardAuth — but intentionally do NOT restrict to submitter/approver, since approved graphics are team assets meant to be posted.)

- [ ] **Step 4: Run the approvals test (DB) + rebuild**
```bash
AP_PASS=$(grep '^APPROVALS_DB_PASSWORD=' .env | cut -d= -f2)
docker run --rm --network grmcapps_hubnet -v "$PWD/apps/approvals":/work -w /work \
  -e TEST_DATABASE_URL="postgres://approvals_user:${AP_PASS}@postgres:5432/approvals" \
  node:20-alpine sh -c "npm install --silent && npm run build && node --test dist/requests.test.js" 2>&1 | grep -E "# (tests|pass|fail)"
rm -f apps/approvals/package-lock.json
docker compose up -d --build approvals; sleep 4
docker compose exec -T approvals wget -qO- --header="X-Auth-Email: a@b.com" http://0.0.0.0:3000/api/approved; echo
```
Expected: tests pass; `/api/approved` → `{"ok":true,"images":[...]}` (array; may be empty if nothing approved yet).
(Note: the `APPROVALS_DB_*` env var names — confirm them in `.env`; adjust if the approvals app uses different names.)

- [ ] **Step 5: Commit**
```bash
rm -f apps/approvals/package-lock.json
git add apps/approvals/src/requests.ts apps/approvals/src/routes/requests.ts apps/approvals/src/requests.test.ts
git commit -m "feat(approvals): team-visible approved-image gallery API"
```

---

### Task 7: social-posts → Approvals client + approved-images route

**Files:** Create `apps/social-posts/src/approvals-client.ts`; Modify `apps/social-posts/src/routes/metricool.ts`

- [ ] **Step 1: Create `apps/social-posts/src/approvals-client.ts`**
```typescript
import { Identity } from "./identity";

const APPROVALS = "http://approvals:3000";

function authHeaders(id: Identity): Record<string, string> {
  // Forward the logged-in user's identity so Approvals applies its normal auth.
  return { "X-Auth-Email": id.email, "X-Auth-Name": id.name };
}

export async function listApprovedImages(id: Identity): Promise<Array<{ id: number; title: string; currentVersion: number }>> {
  const res = await fetch(`${APPROVALS}/api/approved`, { headers: authHeaders(id) });
  const data: any = await res.json();
  if (!data.ok) throw new Error(data.error || "Could not list approved images.");
  return data.images;
}

export async function getApprovedImageBytes(id: Identity, imageId: number): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await fetch(`${APPROVALS}/api/approved/${imageId}/image`, { headers: authHeaders(id) });
  if (!res.ok) throw new Error(`Could not fetch approved image (${res.status}).`);
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType };
}
```
(`Identity` is exported from `identity.ts` — confirm it exports the interface; if not, add `export` to it.)

- [ ] **Step 2: Add the proxy route to `apps/social-posts/src/routes/metricool.ts`** (inside `metricoolRoutes`). Import `listApprovedImages` and add:
```typescript
  app.get("/api/metricool/approved-images", async (req) => {
    try { return { ok: true, images: await listApprovedImages(getIdentity(req)) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });
```

- [ ] **Step 3: Rebuild + verify the cross-app call works**
```bash
docker compose up -d --build social-posts; sleep 4
docker compose exec -T social-posts wget -qO- --header="X-Auth-Email: a@b.com" --header="X-Auth-Name: Tester" http://0.0.0.0:3000/api/metricool/approved-images; echo
```
Expected: `{"ok":true,"images":[...]}` (array; empty if nothing approved). This proves social-posts reaches the Approvals container with forwarded identity.

- [ ] **Step 4: Commit**
```bash
rm -f apps/social-posts/package-lock.json
git add apps/social-posts/src/approvals-client.ts apps/social-posts/src/routes/metricool.ts
git commit -m "feat: social-posts cross-app client for Approvals approved images"
```

---

### Task 8: R2 upload + wire approved image into send + image picker UI

**Files:** Create `apps/social-posts/src/r2.ts`, `apps/social-posts/src/r2.test.ts`; Modify `apps/social-posts/package.json`, `apps/social-posts/src/routes/metricool.ts`, `apps/social-posts/src/public/{index.html,app.js}`

- [ ] **Step 1: Add the R2 client dep to `apps/social-posts/package.json`** dependencies: `"@aws-sdk/client-s3": "^3.700.0"`.

- [ ] **Step 2: Write the failing test `apps/social-posts/src/r2.test.ts`** (pure key/url logic only):
```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { objectKey, publicUrlFor } from "./r2";

test("objectKey is unique-ish and keeps the extension", () => {
  const k = objectKey("image/jpeg", "seed-1");
  assert.ok(k.endsWith(".jpg"));
  assert.notEqual(k, objectKey("image/png", "seed-2"));
});
test("publicUrlFor joins base + key without double slashes", () => {
  assert.equal(publicUrlFor("https://media.grmc.app/", "metricool/x.jpg"), "https://media.grmc.app/metricool/x.jpg");
  assert.equal(publicUrlFor("https://media.grmc.app", "metricool/x.jpg"), "https://media.grmc.app/metricool/x.jpg");
});
```

- [ ] **Step 3: Implement `apps/social-posts/src/r2.ts`**
```typescript
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { getSetting } from "./settings";

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

export function objectKey(contentType: string, seed: string): string {
  const ext = EXT[contentType] || "bin";
  return `metricool/${seed}-${Math.abs(hash(seed + contentType))}.${ext}`;
}
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

export function publicUrlFor(base: string, key: string): string {
  return `${base.replace(/\/+$/, "")}/${key}`;
}

export interface R2Creds { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; publicBaseUrl: string; }
export async function getR2Creds(pool: Pool): Promise<R2Creds> {
  const accountId = await getSetting(pool, "r2_account_id");
  const accessKeyId = await getSetting(pool, "r2_access_key_id");
  const secretAccessKey = await getSetting(pool, "r2_secret_access_key");
  const bucket = await getSetting(pool, "r2_bucket");
  const publicBaseUrl = await getSetting(pool, "r2_public_base_url");
  if (!accessKeyId || !secretAccessKey || !bucket || !publicBaseUrl) throw new Error("Image hosting (R2) not configured — add R2 settings.");
  return { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl };
}

export async function uploadPublic(c: R2Creds, bytes: Buffer, contentType: string, seed: string): Promise<string> {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${c.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
  const key = objectKey(contentType, seed);
  await client.send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: bytes, ContentType: contentType }));
  return publicUrlFor(c.publicBaseUrl, key);
}
```

- [ ] **Step 4: Run the r2 test — expect PASS** (throwaway runner, `<FILE>=r2`, `pass 2`).

- [ ] **Step 5: Wire the approved-image path into `POST /api/metricool/send`** (`routes/metricool.ts`). Add imports `import { getApprovedImageBytes } from "../approvals-client";` and `import { getR2Creds, uploadPublic } from "../r2";`. Replace the Phase-1 media block with:
```typescript
      let mediaUrl = "";
      if (b.approvedImageId) {
        const { bytes, contentType } = await getApprovedImageBytes(getIdentity(req), Number(b.approvedImageId));
        mediaUrl = await uploadPublic(await getR2Creds(pool), bytes, contentType, `${b.approvedImageId}-${Date.now()}`);
        mediaUrl = await normalizeMedia(creds, mediaUrl);
      } else if (b.imageUrl && b.imageUrl.trim()) {
        mediaUrl = await normalizeMedia(creds, b.imageUrl.trim());
      }
```
(`Date.now()` is fine in app runtime — only forbidden in workflow scripts. The rest of the handler is unchanged.)

- [ ] **Step 6: Add the R2 settings section + the image picker UI.** In `index.html` add an "Image hosting (R2)" settings card (`s-r2-account`, `s-r2-key`, `s-r2-secret`, `s-r2-bucket`, `s-r2-baseurl`) and, in the send modal's `mc-image-area`, add a `<select id="mc-approved">` above the URL field. In `app.js`: when `openMetricool` runs, populate `mc-approved` via `api('/api/metricool/approved-images')` (`<option value="">— none —</option>` + one per image, label = title); in `submitMetricool`, if `mc-approved` has a value, send `approvedImageId` instead of `imageUrl`. Extend `saveSettings` to POST the R2 fields.

- [ ] **Step 7: Rebuild + verify (graceful R2-not-configured + picker served)**
```bash
docker compose up -d --build social-posts; sleep 4
docker compose exec -T social-posts wget -qO- http://0.0.0.0:3000/app.js | grep -c "approved-images"
docker compose exec -T social-posts wget -qO- --post-data='{"text":"x","networks":["instagram"],"dateTime":"2026-06-15T09:00:00","timezone":"America/New_York","approvedImageId":"1"}' --header="Content-Type: application/json" http://0.0.0.0:3000/api/metricool/send; echo
```
Expected: app.js references `approved-images` (≥1); the send returns a graceful `{"ok":false,"error":"..."}` (Metricool-not-configured or R2-not-configured) — not a crash.

- [ ] **Step 8: Commit**
```bash
rm -f apps/social-posts/package-lock.json
git add apps/social-posts/src/r2.ts apps/social-posts/src/r2.test.ts apps/social-posts/package.json apps/social-posts/src/routes/metricool.ts apps/social-posts/src/public/index.html apps/social-posts/src/public/app.js
git commit -m "feat: R2 image upload + approved-image picker wired into Send to Metricool"
```

---

### Task 9: End-to-end verification + docs

**Files:** Modify `README.md`

- [ ] **Step 1: Full stack up + all unit tests green**
```bash
docker compose up -d --build
SP_PASS=$(grep '^SOCIALPOSTS_DB_PASSWORD=' .env | cut -d= -f2)
docker run --rm --network grmcapps_hubnet -v "$PWD/apps/social-posts":/work -w /work \
  -e TEST_DATABASE_URL="postgres://socialposts_user:${SP_PASS}@postgres:5432/socialposts" \
  node:20-alpine sh -c "npm install --silent && npm run build && node --test dist/metricool.test.js dist/r2.test.js" 2>&1 | grep -E "# (tests|pass|fail)"
rm -f apps/social-posts/package-lock.json
```
Expected: pass (metricool 4 + r2 2).

- [ ] **Step 2: Manual end-to-end (real creds — the human runs this).** In Social Posts → Settings: enter Metricool token + userId (Load brands → pick blogId), default time/timezone, and the R2 account id/keys/bucket/public base URL. Approve a graphic in the Approvals app. Then from a drafted post click **→ Metricool**, pick the approved image, choose networks/time, Send → confirm in Metricool's planner that a **scheduled draft** appears with the image attached. Verify a `metricool_sends` row:
```bash
docker compose exec -T postgres psql -U postgres -d socialposts -c "SELECT status, networks, created_by, scheduled_for FROM metricool_sends ORDER BY id DESC LIMIT 3;"
```

- [ ] **Step 3: Document in `README.md`** — under the Social Posts app bullet, add: "Send drafted posts straight to Metricool as scheduled drafts (Settings → Metricool: token + userId + blogId), optionally attaching an **approved graphic from the Approvals app** (published to a public Cloudflare R2 URL — Settings → Image hosting). Requires the Metricool Advanced plan."

- [ ] **Step 4: Commit**
```bash
git add README.md
git commit -m "docs: document Send to Metricool + approved-image attachment"
```

---

## Self-review notes

- **Spec coverage:** Settings + flags (Task 1), payload/date/char logic (Task 2), Metricool client (Task 3), routes incl. send (Task 4/7/8), text send modal+buttons (Task 5), Approvals approved-gallery (Task 6), cross-app client (Task 7), R2 + approved-image path + picker (Task 8), end-to-end+docs (Task 9). All spec §3–§9 items map to tasks.
- **Phasing:** Phase 1 (Tasks 1–5) is independently shippable (text send works; IG-without-image warns). Phase 2 (6–9) adds the approved-image pipeline.
- **`{ok,...}` contract** preserved; every external-call path proves a graceful `{ok:false}` before the manual real-creds run.
- **Type/name consistency:** `buildSchedulerPayload`/`suggestDateTime`/`charWarnings`, `getMetricoolCreds`/`listBrands`/`normalizeMedia`/`schedulePost`, `logSend`, `getR2Creds`/`uploadPublic`/`objectKey`/`publicUrlFor`, `listApprovedImages`/`getApprovedImageBytes`, `listApproved`/`getApprovedImage` are used consistently across the tasks that define and call them.
- **Pin-against-live-API (flagged, not silent):** Metricool `brands` + `media-normalize` paths and per-network media fields are confirmed during the Phase-1/Phase-2 manual runs; the scheduler endpoint + core payload are confirmed. The `APPROVALS_DB_*`/identity `Identity` export are verified in-task.
```
