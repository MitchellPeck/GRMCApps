# Metricool "Send to Metricool" — Design Spec

**Date:** 2026-06-11
**Status:** Approved (pending final spec review)
**Part of:** the `social-posts` app (`docs/superpowers/specs/2026-06-10-social-posts-design.md`), with a cross-app read from the `approvals` app. Adds an outbound integration; does not change existing drafting/series features.

## 1. Purpose

The social-posts app drafts posts with Claude; Metricool is where GRMC schedules and manages posts; the Approvals app holds the **approved graphics**. This feature adds a one-click **"Send to Metricool"** on any drafted post that:
- pushes the post into Metricool's planner as a **scheduled draft a human publishes**, and
- can attach an **approved image from the Approvals app** — published to a public Cloudflare R2 URL so Metricool can fetch it (the hub itself stays private).

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Core workflow | "Send to Metricool" button on drafted posts (run results, Drafts, series) |
| Lands in Metricool as | **Scheduled draft, human publishes** (`autoPublish:false` + publication date/time) |
| Networks | **Facebook + Instagram** default (toggleable) |
| Date/time | Auto-suggested from day-label / series date + a default posting time (Settings), editable |
| Image source | **Approved image picked from Approvals** (primary), or an optional public image URL |
| Image hosting | Approved image bytes are uploaded to a **public Cloudflare R2 bucket** at send time; Metricool fetches that public URL (its API only accepts public URLs — "private/temporary URLs are skipped") |
| Cross-app access | social-posts calls the Approvals app's API container-to-container, **forwarding the logged-in user's `X-Auth-*` identity** (same trust model as forwardAuth) |
| Credentials | Metricool + R2 creds in the app's `settings` table, set via the Settings tab |
| Metricool plan | Advanced (confirmed — required for API access) |

## 3. External interfaces

### 3.1 Metricool API
- **Schedule:** `POST https://app.metricool.com/api/v2/scheduler/posts?userId={userId}&blogId={blogId}`, header `X-Mc-Auth: {token}`.
- **Body:** `{ publicationDate:{dateTime:"<ISO>",timezone:"America/New_York"}, text, providers:[{network:"facebook"},{network:"instagram"}], autoPublish:false, ...media }`. Providers are objects; Facebook needs `facebookData.type="POST"`.
- **Media:** normalize a **public** image URL via Metricool's media endpoint → `mediaId`, include it in the post. Exact normalize path + per-network media fields pinned during implementation against Metricool's live API/CLI.
- **Brands:** one token covers all brands; a brands-list endpoint lets the user pick `blogId`.

### 3.2 Cloudflare R2 (public image host)
- R2 is S3-compatible. social-posts uploads the approved image bytes to a **public-read** bucket (R2 `r2.dev` URL or a custom domain like `media.grmc.app`), producing a stable public URL.
- The object only needs to survive until Metricool normalizes it (Metricool copies the file to its own storage). A bucket lifecycle rule can expire objects after a few days.
- Settings: `r2_account_id`, `r2_access_key_id`, `r2_secret_access_key`, `r2_bucket`, `r2_public_base_url`.

### 3.3 Approvals app (approved-image source)
- social-posts reads approved graphics from the Approvals app over the internal Docker network (`http://approvals:3000`), forwarding the requesting user's `X-Auth-Email`/`X-Auth-Name` headers so Approvals applies its normal access rules.
- It needs two reads: **list approved images** (id, label/thumbnail) and **fetch one image's bytes**. The Approvals app already serves version images; if a suitable "list approved" + "image bytes" pair isn't exposed in the form needed, a thin addition to the Approvals API is in scope (pinned during implementation by inspecting `apps/approvals`).

## 4. Components

### Settings (new fields in `socialposts.settings`)
Metricool: `metricool_token`, `metricool_user_id`, `metricool_blog_id`, `default_post_time` (`09:00`), `default_timezone` (`America/New_York`). R2: the five `r2_*` fields above. The Settings tab gets a **Metricool** section (+ "Test connection / load brands" button to pick `blogId`) and an **Image hosting (R2)** section. `GET /api/settings` returns only flags/hints, never raw tokens/secrets.

### Backend (`apps/social-posts/src/`)
- `metricool.ts` — `getMetricoolCreds(pool)`, `listBrands(creds)`, `normalizeMedia(creds, publicUrl)`, `schedulePost(creds, payload)`; pure `buildSchedulerPayload(input)` and `suggestDateTime(source, defaults)`.
- `r2.ts` — `uploadPublic(creds, bytes, contentType) → publicUrl` (S3-compatible PUT to R2).
- `approvals-client.ts` — `listApprovedImages(identity)`, `getApprovedImageBytes(identity, imageId)` (calls `http://approvals:3000`, forwarding identity headers).
- `routes/metricool.ts` —
  - `GET /api/metricool/status` → `{ ok, hasMetricool, hasR2 }`.
  - `GET /api/metricool/brands` → `{ ok, brands:[{id,label}] }`.
  - `GET /api/metricool/approved-images` → `{ ok, images:[{id,label,thumbUrl?}] }` (proxies Approvals, forwarding identity).
  - `POST /api/metricool/send` → body `{ text, networks[], dateTime, timezone, approvedImageId?, imageUrl?, sourceType?, sourceRef? }` → if `approvedImageId`: fetch bytes from Approvals → upload to R2 → public URL; else use `imageUrl` → `normalizeMedia` → `schedulePost(autoPublish:false)` → log → `{ ok, metricoolPostId, scheduledFor }`.

### Data (`socialposts` DB)
`metricool_sends` log table: `id`, `source_type`, `source_ref`, `text`, `networks`, `image_ref` (approvedImageId or url), `r2_url`, `scheduled_for`, `timezone`, `metricool_post_id`, `status` (`sent`|`error`), `error`, `created_by`, `created_at`. Created on boot via `ensureSchema()`.

### Frontend (`apps/social-posts/src/public/`)
- A shared **"Send to Metricool" modal**: editable text (prefilled), **Facebook / Instagram** checkboxes, auto-suggested **date/time** picker, and an **image picker** showing approved graphics from Approvals (thumbnails) + an "optional public image URL" fallback.
- A **"Send to Metricool"** button on each post card (run results, Drafts, series). On success → "Sent to Metricool ✓ (scheduled Mon Jun 15, 9:00 AM)".
- If `/api/metricool/status` reports missing creds, the button points to Settings.

## 5. Data flow (send with an approved image)

Click **Send** → modal (prefilled text + suggested time) → user picks an approved image + networks/time → `POST /api/metricool/send` → backend: fetch image bytes from **Approvals** (identity forwarded) → upload to **R2** → public URL → Metricool **normalize** → **schedule** (`autoPublish:false`) → insert `metricool_sends` row → card shows "Sent ✓". Text-only / Instagram-without-image still creates the draft, with a note to add the image in Metricool. Failures return `{ok:false, error}` to the existing alert UI.

## 6. Error handling

- Missing Metricool/R2 creds → `{ok:false, error}`; Send button gated via `/api/metricool/status`.
- Approvals unreachable / image not found → `{ok:false, error}`, no partial send.
- R2 upload failure → `{ok:false, error}`; nothing scheduled.
- Metricool API error → surface Metricool's message; log a `status:'error'` row.
- Instagram without an image → send as draft; response `note` shown in the UI.

## 7. Testing

- **Pure-logic unit tests:** `buildSchedulerPayload` (provider objects, `facebookData.type`, ISO/timezone, autoPublish:false, media field), `suggestDateTime` (Monday→next Monday at default time; series "Jun 9"→that date), char-limit warnings.
- **R2:** unit-test the object-key/public-URL construction; the actual PUT verified manually with real R2 creds (or a MinIO/S3 stand-in if available).
- **Approvals client:** unit-test request shaping (identity headers, paths); integration verified against the running approvals container.
- **DB round-trip:** `metricool_sends` insert/read.
- **Manual (real creds):** configure Metricool + R2 in Settings, load brands, pick an approved image, send → confirm it lands in Metricool's planner as a scheduled draft with the image.

## 8. Out of scope

- Pulling Metricool's calendar/analytics back (push-only v1).
- Auto-publishing (always `autoPublish:false`).
- Editing a Metricool post after sending (do it in Metricool).
- Exposing the hub itself to the internet (only R2 objects are public).
- Video/multi-image (single approved image in v1).

## 9. Success criteria

1. Settings saves Metricool + R2 creds; "load brands" lists brands to pick `blogId`.
2. Every drafted post shows a "Send to Metricool" button; the modal lists **approved images from Approvals**.
3. Sending with an approved image uploads it to R2, attaches it via Metricool, and creates a **scheduled draft** (`autoPublish:false`) for the chosen networks/time.
4. The send is recorded in `metricool_sends` (with `created_by` + the R2 URL); the card shows "Sent ✓ (scheduled …)".
5. Text-only / Instagram-without-image still creates the draft with the "add an image in Metricool" note.
6. Errors (bad token, wrong blogId, R2 failure, Approvals unreachable, rejected post) surface clearly.
