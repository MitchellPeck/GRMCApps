# GRMCApps UI Overhaul + Approval Engine + Hub Inbox — Design

**Date:** 2026-06-18
**Status:** Approved for planning
**Author:** Mitchell Peck (with Claude)

## Summary

A comprehensive overhaul of the GRMCApps suite, delivered in three sequential,
independently-shippable phases:

1. **Visual system** — one shared `grmc.css` design system (Editorial Refined
   style) replacing every app's duplicated inline CSS, applied to all apps and
   the hub.
2. **Approval engine** — generalize the Approvals app from images-only to any
   content type (image, file, text, link), and let other apps submit approval
   requests programmatically with decisions flowing back via callback.
3. **Hub pending inbox** — the hub dashboard becomes a live cross-app inbox,
   showing what's awaiting the signed-in user across every app.

Build order is **1 → 2 → 3**. Phase 1 is independent and de-risks the look.
Phase 2 establishes the trusted cross-app HTTP contract that Phase 3 consumes.

## Locked decisions

- **Audience:** internal tools, but must look sharp and intentional.
- **Brand:** GRMC stays. Palette is deep teal-navy `#092D3E` + gold `#D3B02B`.
- **Aesthetic direction:** "Editorial Refined" — warm paper canvas, serif
  display headings, hairline gold rules, generous whitespace.
- **Typography:** Playfair Display (display/headings) + Inter (UI: labels,
  inputs, buttons, body). Self-hosted woff2 — no external CDN dependency.
- **Delivery:** vanilla shared CSS. No framework, no new build pipeline.
- **Pending scope:** show both — "awaiting you" emphasized, "N open total"
  secondary.
- **Pending fetch:** live on page load, parallel, short timeout, dash on failure.
- **Approval content types (priority):** image, file, text, link — all four.
- **Cross-app:** other apps can submit approvals AND the hub can read pending
  counts, both over a shared trusted internal HTTP contract.

## Current state (baseline)

- Apps (`approvals`, `social-posts`, `whoami`) are vanilla HTML/CSS/JS served by
  Fastify + `@fastify/static` from each app's `src/public/`. The hub renders EJS
  (`hub/src/views/login.ejs`, `dashboard.ejs`).
- `approvals` and `social-posts` each **re-declare the entire stylesheet inline**
  (navy/gold theme). Copy-pasted, not shared.
- The hub uses a **different** slate/blue theme — visually disconnected from the
  apps.
- Each app listens on port `3000` and is reachable on the internal Docker
  network by its service name (which equals its subdomain: `approvals`,
  `social-posts`, `whoami`, `hub`).
- Identity is injected by Traefik forwardAuth as `x-auth-email` / `x-auth-name`
  headers (see `apps/approvals/src/identity.ts`). The hub knows the user from its
  own session (`hub/src/apps/registry.ts#getUser`).

---

## Phase 1 — Visual system (`grmc.css`)

### Goal

One shared stylesheet that every surface inherits, replacing all duplicated
inline CSS, establishing the Editorial Refined look.

### Design tokens (CSS custom properties)

```
--navy:        #092D3E   /* primary brand, topbar, primary buttons, headings */
--navy-2:      #0e3c52   /* hover/elevated navy */
--gold:        #D3B02B   /* accent, primary-secondary action, active state */
--gold-d:      #9a7d20   /* gold text on light bg (contrast-safe) */
--paper:       #f7f3e9   /* app canvas */
--card:        #fffdf8   /* card surface */
--rule:        #e3d9bf   /* hairline borders / dividers */
--ink:         #23303a   /* body text */
--muted:       #7a6f54   /* labels */
--hint:        #9a8f72   /* secondary/hint text */
/* status */
--ok-bg/-fg, --pending-bg/-fg, --rej-bg/-fg, --info-bg/-fg
/* scale */ radii, spacing steps, shadow tokens, type sizes
```

Status colors (light-bg tints): pending `#fef6dc`/`#9a7d20`, approved
`#e6efe1`/`#3f6b2e`, rejected `#f6e6e3`/`#9a4b3a`, info blue tint.

### Typography

- **Display/headings:** Playfair Display (500/600/700).
- **UI/body:** Inter (400/500/600/700).
- Self-hosted woff2 with `@font-face` in `grmc.css`; fonts shipped alongside it.
- Type scale defined as tokens (e.g. `--t-h1 … --t-small`).

### Component inventory (classes in `grmc.css`)

- **App shell:** `.grmc-topbar` (navy bar, seal/brand left, identity right),
  `.grmc-canvas`, `.grmc-hero` (kicker + Playfair `h1` + subtitle).
- **Tabs:** `.grmc-tabs` / `.tab` / `.tab.active` (gold underline).
- **Cards:** `.card`, `.appcard`.
- **Buttons:** `.btn` + `.btn-primary` (navy), `.btn-gold`, `.btn-ghost`,
  `.btn-danger`, `.btn-sm`.
- **Status pills:** `.pill` + `.pill-pending|-ok|-rejected|-info`.
- **Forms:** `.field`, `.lbl`, inputs/textarea/select, `.hint`, focus ring in
  gold.
- **Feedback:** `.alert-*`, toast, `.spin` loader, `.empty` state.
- **Badges:** `.badge` (gold count), `.badge.zero`.

Components mirror the markup the apps already use, so reskinning is mostly a
class swap, not a rewrite.

### Delivery mechanism

- Source of truth: new `shared/ui/` at repo root containing `grmc.css` and the
  font files.
- Each app's Docker build **copies** `shared/ui/` into its served `public/`
  (e.g. `public/assets/grmc.css`). No runtime coupling between containers; each
  image is self-contained.
- The hub copies the same assets and serves them statically; EJS templates link
  the same `grmc.css`.
- Build wiring: a `COPY shared/ui` step in each Dockerfile (build context already
  the repo root) or a small prebuild copy script. Concrete mechanism decided in
  the plan; requirement is **single source, copied in at build**.

### Per-surface work

- **approvals:** replace inline `<style>` in `src/public/index.html` with a link
  to `grmc.css`; map existing markup to system classes.
- **social-posts:** same. This app is form-dense (Settings, series, drafts) —
  verify the editorial style holds at density (it should: serif is display-only,
  Inter carries dense UI).
- **hub:** rebuild `login.ejs` and `dashboard.ejs` to the system (replaces the
  slate/blue theme). Dashboard rebuild continues into Phase 3.

### Testing

No automated visual tests. Manual check of each surface against the approved
mockups. Existing unit tests must still pass (presentation-only change).

---

## Phase 2 — Approvals as an approval engine

### Goal

Generalize Approvals from images-only to any content type, and expose a trusted
API so other apps can submit approval requests and receive the decision back.

### Data model changes (`apps/approvals/src/schema.ts`)

Additive, backward-compatible migrations (DDL is idempotent on boot):

- `requests` gains:
  - `kind text NOT NULL DEFAULT 'image'` — one of `image | file | text | link`.
  - `source_app text` — null for manual submissions, else originating app slug.
  - `source_ref text` — originating app's own id for the item.
  - `callback_url text` — where to POST the decision (internal URL).
- `request_versions`: make the file columns
  (`file_name/mime_type/byte_size/image`) nullable so a version can be
  attachment-less, and add `content text NOT NULL DEFAULT ''` to hold the
  per-version text body (kind=text) or URL (kind=link). Content lives **per
  version** so resubmissions keep full history for every kind — image/file
  versions store bytes as today; text/link versions store `content`.

Existing rows default to `kind='image'` with empty `content` — no data
migration needed.

### Content-type behavior

All kinds share the same lifecycle (pending → approved / rejected /
changes-requested → resubmit new version), roster-based approver, full version
and event history. Differences are only in submission + rendering:

- **image** — upload image bytes (current behavior). Rendered as preview.
- **file** — upload any file (PDF/doc/etc.). Rendered as filename + download +
  type icon; inline preview for PDFs/images where feasible.
- **text** — a copy block, no attachment. Rendered as formatted text.
- **link** — a URL. Rendered as a clickable link with the URL shown.

Submitter picks the kind in the UI; the form adapts (file picker vs. textarea
vs. URL field). "Request changes" + resubmission works for every kind (new
version = new text/file/link).

### Cross-app submission API

- `POST /api/requests` (trusted internal; see Cross-cutting contract):
  body `{ kind, title, description, content?, approver_email, file?,
  source_app, source_ref, callback_url }` → `{ id, status }`. `content` carries
  the text/URL for text/link kinds and becomes version 1's `content`; `file`
  carries bytes for image/file kinds.
- `GET /api/requests/:id` (trusted internal) — originating app can poll status.
- On every decision, Approvals POSTs to `callback_url`:
  `{ request_id, source_app, source_ref, decision, version_no, note,
  decided_by, decided_at }`. Delivery is best-effort with a couple of retries;
  failures are logged and visible, not fatal (originating app can also poll).

### UI changes (`apps/approvals/src/public`)

- New-request form gains a **kind selector**; fields swap per kind.
- Request cards/detail render per kind (preview / file / text / link).
- Externally-sourced requests show a small "from Social Posts" provenance chip
  and link back where possible.

### Trust model

`/api/*` endpoints are reachable on the internal Docker network without Traefik
auth, so they require the shared internal secret (Cross-cutting contract). The
forwarded `x-auth-email` identifies the acting/submitting user when relevant.

### Testing

Unit tests (existing `node --test` setup): schema defaults, each kind's
submission/validation, version/resubmit per kind, decision → callback payload
(with a fake callback sink), secret enforcement on `/api/*`.

---

## Phase 3 — Hub cross-app pending inbox

### Goal

Turn the hub dashboard from a static launcher into a live inbox aggregating
pending work across all apps for the signed-in user.

### Per-app contract: `GET /pending`

Each app exposes a trusted internal endpoint returning, for the user identified
by forwarded headers:

```json
{
  "app": "approvals",
  "mine":  3,           // awaiting *this user* — emphasized
  "total": 7,           // open in the system — secondary
  "items": [            // up to ~3 previews of the user's pending items
    { "title": "Spring Campaign — Hero", "meta": "Anna · 2h ago", "href": "/..." }
  ]
}
```

Per-app semantics:

- **approvals** — `mine` = requests where the user is the approver and status is
  pending, plus requests bounced back to the user as submitter
  (changes-requested). `total` = all open requests. `items` = the user's queue.
- **social-posts** — `mine` = drafts the user owns that are unsent/ready to send
  (and any items awaiting an approval callback). `total` = all unsent drafts.
- **whoami** — no actionable work: returns `{ mine: 0, total: 0, items: [] }`
  (or omits the endpoint; hub treats missing as zero).

### Hub fan-out (`hub/src/apps/routes.ts` + new aggregator)

- On dashboard load, for each enabled app, call
  `http://<subdomain>:3000/pending` in **parallel** with a short timeout
  (~1.5s), forwarding `x-auth-email`/`x-auth-name` (from hub session) + the
  internal secret.
- Aggregate results. An app that errors/times out/lacks the endpoint renders a
  **dash** (—) instead of a count; it never blocks the page.
- Sum `mine` across apps for the hero line ("You have N things waiting").

### Hub UI (`dashboard.ejs`)

Rebuild as the approved mockup: hero greeting with total `mine`, app cards each
showing icon, name, a `mine` badge (gold) with "awaiting you", a smaller
"N open total", and up to 3 preview lines. Zero-state cards read "all clear".
Cards link into the app.

### Testing

Hub aggregator unit-tested with a stubbed fetch (counts, timeout→dash,
missing-endpoint→zero, parallel behavior). App `/pending` handlers unit-tested
per the apps' existing test setup.

---

## Cross-cutting — trusted internal HTTP contract

Phases 2 and 3 share one mechanism for container-to-container calls that bypass
Traefik's forwardAuth:

- A shared secret env var (e.g. `INTERNAL_API_SECRET`) provided to the hub and
  every app via compose/`.env`.
- Internal endpoints (`/pending`, `/api/*`) require header
  `x-internal-secret: <secret>`; requests without it are rejected `401`.
- The acting user is conveyed with the existing `x-auth-email` / `x-auth-name`
  headers, forwarded by the trusted caller (the hub, or a submitting app).
- These endpoints are only reachable on the internal Docker network (apps are
  `exposedbydefault=false`; only Traefik-labelled routes are public). The secret
  guards against any internal-network caller that isn't ours.

A tiny shared helper (per app, ~10 lines) validates the secret and reads
identity — kept simple, not a new framework.

## Out of scope (YAGNI)

- No frontend framework / build-tool migration; stays vanilla.
- No dark mode / theme switching.
- No multi-approver / approval-chains / parallel sign-off (single approver as
  today).
- No real-time push to the hub (live-on-load only; no websockets/polling daemon).
- No caching layer for pending counts (revisit only if load proves it needed).
- No generic plugin SDK for apps; the internal contract is a documented
  convention, not a published package.

## Risks & mitigations

- **Editorial style at form density (social-posts):** mitigated by serif being
  display-only; Inter carries dense UI. Validate during Phase 1.
- **Callback reliability (Phase 2):** best-effort POST + retries, plus pollable
  `GET /api/requests/:id`, so a missed callback is recoverable.
- **Slow/down app blocking the hub (Phase 3):** strict per-call timeout +
  graceful dash; aggregation never fails the page.
- **Nullable version columns (Phase 2):** additive migration with safe defaults;
  existing image rows untouched.

## Build order & shippability

- **Phase 1** ships the new look with zero behavior change.
- **Phase 2** ships generalized approvals + the internal contract.
- **Phase 3** ships the hub inbox, consuming the contract.

Each phase gets its own implementation plan.
