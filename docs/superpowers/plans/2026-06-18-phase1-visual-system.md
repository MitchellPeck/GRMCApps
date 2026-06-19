# Phase 1 — Visual System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one shared `grmc.css` design system (Editorial Refined style) plus self-hosted fonts, wire it into every app + the hub at build time, and reskin all surfaces — replacing every app's duplicated inline CSS, with zero behavior change.

**Architecture:** A single source-of-truth `shared/ui/` (stylesheet + fonts) is copied into each container's served static dir at Docker build, and into each app's local `src/public/assets/` by a dev sync script. `grmc.css` provides design tokens + base + the component vocabulary both apps already use (`.card`, `.tab`, `.btn`, `.field`, `.badge`, `.alert`, etc.). Each app keeps a small `app.css` for its bespoke components (request cards; series/post planner) that consumes the shared CSS variables. The hub (EJS) gains a static handler to serve `/assets/*` and its templates are rebuilt to the system.

**Tech Stack:** Vanilla HTML/CSS, Fastify + `@fastify/static`, EJS (hub), Docker. No frontend framework, no bundler.

## Global Constraints

- Palette is exactly: navy `#092D3E`, gold `#D3B02B`. Paper `#f7f3e9`, card `#fffdf8`, rule `#e3d9bf`, ink `#23303a`. (Copy verbatim — do not approximate.)
- Display/heading font: **Playfair Display**. UI/body font: **Inter**. Both self-hosted woff2 — **no external CDN / Google Fonts `<link>`** in shipped HTML.
- No new frontend framework or build tool. Stays vanilla.
- Presentation-only: no change to any app's behavior, routes, or data. All existing tests must still pass.
- Org name is "Grace Resurrection Methodist Church" (GRMC). App subdomains/service names: `hub`, `approvals`, `social-posts`, `whoami`.
- Apps listen on port 3000 and serve static files from `dist/public` (copied from `src/public` at build).

---

## File Structure

**Created:**
- `shared/ui/grmc.css` — the design system: tokens, `@font-face`, base/reset, shared components.
- `shared/ui/fonts/` — self-hosted woff2 files (Playfair Display 500/600/700; Inter 400/500/600/700).
- `scripts/fetch-fonts.sh` — one-time reproducible font download into `shared/ui/fonts/`.
- `scripts/sync-ui.sh` — copies `shared/ui/` into each surface's served dir for local (non-Docker) dev.
- `apps/approvals/src/public/app.css` — bespoke approvals component styles (token-driven).
- `apps/social-posts/src/public/app.css` — bespoke social-posts component styles (token-driven).
- `hub/src/public/.gitkeep` — hub static dir (assets land here at build/sync).

**Modified:**
- `apps/approvals/src/public/index.html` — drop inline `<style>`; link `grmc.css` + `app.css`; refresh header markup.
- `apps/social-posts/src/public/index.html` — same.
- `hub/src/views/login.ejs`, `hub/src/views/dashboard.ejs` — rebuilt to the system (dashboard stays a launcher here; live counts come in Phase 3).
- `hub/src/index.ts` — register `@fastify/static` for `/assets`.
- `hub/package.json` — add `@fastify/static` dependency.
- `apps/approvals/Dockerfile`, `apps/social-posts/Dockerfile`, `hub/Dockerfile` — root build context; `COPY shared/ui` into served dir.
- `docker-compose.yml` — set `build.context: .` + `dockerfile:` for `hub`, `approvals`, `social-posts`.
- `.gitignore` — ignore generated `**/src/public/assets/` and `hub/src/public/assets/`.

---

## Task 1: Self-hosted fonts

**Files:**
- Create: `scripts/fetch-fonts.sh`
- Create: `shared/ui/fonts/` (populated by the script)

**Interfaces:**
- Produces: woff2 files at `shared/ui/fonts/{playfair-600.woff2, playfair-500.woff2, playfair-700.woff2, inter-400.woff2, inter-500.woff2, inter-600.woff2, inter-700.woff2}` — referenced by `@font-face` in Task 2.

- [ ] **Step 1: Write the fetch script**

Create `scripts/fetch-fonts.sh`:

```bash
#!/usr/bin/env bash
# Reproducibly download self-hosted woff2 (latin subset) for Playfair Display
# + Inter. The Google CSS2 endpoint returns several subset blocks per weight
# (latin, latin-ext, cyrillic, ...), each preceded by a /* <subset> */ comment.
# We request ONE weight at a time and extract the woff2 URL from the block
# labelled /* latin */ — robust against block ordering and extra subsets.
set -euo pipefail
DEST="$(cd "$(dirname "$0")/.." && pwd)/shared/ui/fonts"
mkdir -p "$DEST"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

fetch_one() { # <family-query> <weight> <out-basename>
  local css url
  css=$(curl -sf -H "User-Agent: $UA" "https://fonts.googleapis.com/css2?family=${1}:wght@${2}&display=swap")
  # From the /* latin */ marker, take the first woff2 URL that follows.
  url=$(printf '%s\n' "$css" | awk '/\/\* latin \*\//{f=1} f && /url\(/{match($0,/https:[^)]+woff2/); print substr($0,RSTART,RLENGTH); exit}')
  if [ -z "$url" ]; then echo "ERROR: no latin woff2 for ${1} ${2}" >&2; exit 1; fi
  curl -sf -o "$DEST/${3}.woff2" "$url"
  echo "  -> ${3}.woff2"
}

echo "Playfair Display..."
for w in 500 600 700; do fetch_one "Playfair+Display" "$w" "playfair-$w"; done
echo "Inter..."
for w in 400 500 600 700; do fetch_one "Inter" "$w" "inter-$w"; done

echo "Done. Files in $DEST"
ls -1 "$DEST"
```

- [ ] **Step 2: Make executable and run it**

Run:
```bash
chmod +x scripts/fetch-fonts.sh && ./scripts/fetch-fonts.sh
```
Expected output ends with a listing of 7 files:
```
inter-400.woff2
inter-500.woff2
inter-600.woff2
inter-700.woff2
playfair-500.woff2
playfair-600.woff2
playfair-700.woff2
```

- [ ] **Step 3: Verify the files are real woff2**

Run:
```bash
file shared/ui/fonts/inter-400.woff2 shared/ui/fonts/playfair-600.woff2
```
Expected: each line reports `Web Open Font Format (Version 2)` (or `woff2`). If any file is HTML/empty, the download failed — re-run; if Google blocks, fall back to `npx google-webfonts-helper` or copy from `@fontsource/inter` + `@fontsource/playfair-display` woff2 files into the same names.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-fonts.sh shared/ui/fonts
git commit -m "feat(ui): self-host Playfair Display + Inter woff2"
```

---

## Task 2: Design tokens, base, and `@font-face` (`grmc.css` part 1)

**Files:**
- Create: `shared/ui/grmc.css`

**Interfaces:**
- Produces: CSS custom properties on `:root` consumed by every app + `app.css`: `--navy --navy-2 --gold --gold-d --paper --card --rule --ink --muted --hint --ok-bg --ok-fg --pending-bg --pending-fg --rej-bg --rej-fg --info-bg --info-fg --r --r-lg --shadow --shadow-lg --t-h1 --t-h2 --t-body --t-small --font-display --font-ui`.

- [ ] **Step 1: Write `shared/ui/grmc.css` with fonts, tokens, and base**

Create `shared/ui/grmc.css`:

```css
/* GRMC design system — Editorial Refined. Single source of truth. */

/* ---- Fonts (self-hosted) ---- */
@font-face{font-family:"Playfair Display";font-weight:500;font-display:swap;src:url("/assets/fonts/playfair-500.woff2") format("woff2")}
@font-face{font-family:"Playfair Display";font-weight:600;font-display:swap;src:url("/assets/fonts/playfair-600.woff2") format("woff2")}
@font-face{font-family:"Playfair Display";font-weight:700;font-display:swap;src:url("/assets/fonts/playfair-700.woff2") format("woff2")}
@font-face{font-family:"Inter";font-weight:400;font-display:swap;src:url("/assets/fonts/inter-400.woff2") format("woff2")}
@font-face{font-family:"Inter";font-weight:500;font-display:swap;src:url("/assets/fonts/inter-500.woff2") format("woff2")}
@font-face{font-family:"Inter";font-weight:600;font-display:swap;src:url("/assets/fonts/inter-600.woff2") format("woff2")}
@font-face{font-family:"Inter";font-weight:700;font-display:swap;src:url("/assets/fonts/inter-700.woff2") format("woff2")}

/* ---- Tokens ---- */
:root{
  --navy:#092D3E; --navy-2:#0e3c52;
  --gold:#D3B02B; --gold-d:#9a7d20;
  --paper:#f7f3e9; --card:#fffdf8; --rule:#e3d9bf;
  --ink:#23303a; --muted:#7a6f54; --hint:#9a8f72;
  --ok-bg:#e6efe1; --ok-fg:#3f6b2e;
  --pending-bg:#fef6dc; --pending-fg:#9a7d20;
  --rej-bg:#f6e6e3; --rej-fg:#9a4b3a;
  --info-bg:#e6eff3; --info-fg:#0c447c;
  --r:7px; --r-lg:13px;
  --shadow:0 1px 2px rgba(9,45,62,.05); --shadow-lg:0 10px 30px rgba(9,45,62,.14);
  --t-h1:30px; --t-h2:22px; --t-body:13.5px; --t-small:11.5px;
  --font-display:"Playfair Display",Georgia,serif;
  --font-ui:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}

/* ---- Base / reset ---- */
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--font-ui);background:var(--paper);color:var(--ink);min-height:100vh;line-height:1.5;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:var(--font-display);font-weight:600;color:var(--navy);line-height:1.15}
a{color:var(--navy);text-underline-offset:2px}
.kicker{font-family:var(--font-ui);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold-d);font-weight:700}
.muted{color:var(--muted)} .hint{font-size:var(--t-small);color:var(--hint);margin-top:3px;line-height:1.5}
.empty{text-align:center;color:var(--muted);font-size:13px;padding:30px 10px}
```

- [ ] **Step 2: Verify required tokens are present**

Run:
```bash
for t in --navy --gold --paper --card --rule --ink --font-display --font-ui --pending-bg; do grep -q "$t:" shared/ui/grmc.css && echo "ok $t" || echo "MISSING $t"; done
```
Expected: every line starts with `ok`.

- [ ] **Step 3: Verify exact brand hex values**

Run:
```bash
grep -E "#092D3E|#D3B02B|#f7f3e9" shared/ui/grmc.css
```
Expected: matches found (navy, gold, paper all present).

- [ ] **Step 4: Commit**

```bash
git add shared/ui/grmc.css
git commit -m "feat(ui): grmc.css tokens, base, and self-hosted @font-face"
```

---

## Task 3: Shared components (`grmc.css` part 2)

**Files:**
- Modify: `shared/ui/grmc.css` (append the component layer)

**Interfaces:**
- Consumes: tokens from Task 2.
- Produces: the shared class vocabulary used by both apps + hub: `header .logo .mark .hright .hlabel .btn-hdr .layout .tabs .tab .panel .card .ct .field label inputs .btn .btn-row .btn-primary .btn-secondary .btn-gold .btn-sm .btn-danger .spin .alert(.-err/-ok/-info/-warn) .badge(.b-*) .pill(.pill-*) .appcard .seal .hero .badge-count`.

- [ ] **Step 1: Append the component layer to `shared/ui/grmc.css`**

Append to `shared/ui/grmc.css`:

```css
/* ---- App shell ---- */
header{background:var(--navy);padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
header h1{font-size:15px;font-weight:600;color:#fff;font-family:var(--font-display);letter-spacing:.01em}
header p{font-size:11px;color:var(--gold);margin-top:1px;font-family:var(--font-ui)}
.logo{display:flex;align-items:center;gap:12px}
.mark,.seal{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:var(--font-display);font-weight:700}
.mark{background:var(--gold);color:var(--navy);font-size:15px}
.seal{background:transparent;border:1.5px solid var(--gold);color:var(--gold)}
.hright{display:flex;align-items:center;gap:10px}
.hlabel{font-size:12px;color:rgba(255,255,255,.72)}
.btn-hdr{background:transparent;border:1px solid rgba(255,255,255,.25);color:#fff;font-size:12px;font-weight:600;padding:6px 13px;border-radius:var(--r);cursor:pointer;font-family:var(--font-ui)}
.btn-hdr:hover{background:rgba(255,255,255,.08)}
.layout{max-width:780px;margin:0 auto;padding:26px 20px 80px}

/* ---- Hero ---- */
.hero{padding:6px 0 18px}
.hero h1{font-size:var(--t-h1);font-weight:600;margin:8px 0 4px}
.hero p{color:#5d6b61;font-size:var(--t-body)}

/* ---- Tabs ---- */
.tabs{display:flex;gap:2px;background:var(--card);border:1px solid var(--rule);border-radius:var(--r-lg);padding:4px;margin-bottom:20px;flex-wrap:wrap}
.tab{flex:1;min-width:90px;padding:8px 10px;font-size:13px;font-weight:500;text-align:center;cursor:pointer;border:none;background:none;color:var(--muted);border-radius:var(--r);font-family:var(--font-ui);transition:background .15s,color .15s}
.tab.active{background:var(--navy);color:#fff}
.tab:hover:not(.active){background:var(--paper);color:var(--ink)}
.panel{display:none}.panel.active{display:block}

/* ---- Cards ---- */
.card{background:var(--card);border:1px solid var(--rule);border-radius:var(--r-lg);padding:20px;margin-bottom:14px;box-shadow:var(--shadow)}
.ct{font-family:var(--font-display);font-size:18px;font-weight:600;color:var(--navy);margin-bottom:14px}
.appcard{background:var(--card);border:1px solid var(--rule);border-radius:var(--r-lg);padding:17px;box-shadow:var(--shadow);transition:transform .15s,box-shadow .15s}
.appcard:hover{transform:translateY(-3px);box-shadow:var(--shadow-lg)}

/* ---- Forms ---- */
.field{margin-bottom:14px}.field:last-child{margin-bottom:0}
label,.lbl{display:block;font-size:10px;font-weight:600;color:var(--muted);margin-bottom:5px;letter-spacing:.04em;text-transform:uppercase}
input[type=text],input[type=email],input[type=url],input[type=file],input[type=password],textarea,select{width:100%;border:1px solid var(--rule);border-radius:var(--r);padding:9px 11px;font-size:13px;font-family:var(--font-ui);color:var(--ink);background:#fff}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--gold);box-shadow:0 0 0 3px rgba(211,176,43,.16)}
textarea{resize:vertical;min-height:72px;line-height:1.55}

/* ---- Buttons ---- */
.btn-row{display:flex;gap:8px;align-items:center;margin-top:16px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;font-size:13px;font-weight:600;cursor:pointer;border-radius:var(--r);border:none;font-family:var(--font-ui)}
.btn-primary{background:var(--navy);color:var(--paper)}.btn-primary:hover{background:var(--navy-2)}.btn-primary:disabled{opacity:.5;cursor:not-allowed}
.btn-secondary{background:#fff;color:var(--ink);border:1px solid var(--rule)}.btn-secondary:hover{background:var(--paper)}
.btn-gold{background:var(--gold);color:var(--navy)}.btn-gold:hover{filter:brightness(1.05)}
.btn-danger{background:#fff;color:#9a4b3a;border:1px solid #e0c3bc}.btn-danger:hover{background:var(--rej-bg)}
.btn-sm{padding:5px 11px;font-size:12px;font-weight:600;cursor:pointer;border-radius:var(--r);border:1px solid var(--rule);background:#fff;color:var(--ink);font-family:var(--font-ui)}
.btn-sm:hover{background:var(--paper)}
.spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* ---- Alerts ---- */
.alert{padding:10px 14px;border-radius:var(--r);font-size:12.5px;line-height:1.6;margin-bottom:12px}
.alert-err{background:var(--rej-bg);color:var(--rej-fg)}
.alert-ok{background:var(--ok-bg);color:var(--ok-fg)}
.alert-info{background:var(--info-bg);color:var(--info-fg)}
.alert-warn{background:var(--pending-bg);color:var(--pending-fg)}

/* ---- Status pills / badges ---- */
.badge{font-size:10px;font-weight:700;padding:2px 9px;border-radius:20px;white-space:nowrap}
.b-pending{background:var(--pending-bg);color:var(--pending-fg)}
.b-approved{background:var(--ok-bg);color:var(--ok-fg)}
.b-rejected{background:var(--rej-bg);color:var(--rej-fg)}
.b-changes_requested{background:var(--info-bg);color:var(--info-fg)}
.pill{display:inline-block;font-size:10.5px;font-weight:600;padding:3px 10px;border-radius:20px;letter-spacing:.02em}
.pill-pending{background:var(--pending-bg);color:var(--pending-fg)}
.pill-ok{background:var(--ok-bg);color:var(--ok-fg)}
.pill-rejected{background:var(--rej-bg);color:var(--rej-fg)}
.pill-info{background:var(--info-bg);color:var(--info-fg)}
.badge-count{background:var(--gold);color:var(--navy);font-size:12px;font-weight:700;min-width:22px;height:22px;border-radius:11px;padding:0 7px;display:inline-flex;align-items:center;justify-content:center}
.badge-count.zero{background:transparent;color:#b3ac98;border:1px solid var(--rule)}
```

- [ ] **Step 2: Verify the shared vocabulary both apps need is defined**

Run:
```bash
for c in card tab btn-primary btn-gold btn-secondary btn-hdr field alert-ok badge b-pending logo mark hlabel layout tabs panel ct hint spin; do
  if grep -qE "\.$c[ ,{:]" shared/ui/grmc.css; then echo "ok .$c"; else echo "MISSING .$c"; fi
done
```
Expected: every line starts with `ok`.

- [ ] **Step 3: Verify no raw legacy hex leaked into components**

Run:
```bash
grep -nE "#1a2744|#c9a84c|#0f172a|#2563eb" shared/ui/grmc.css && echo "LEAK" || echo "clean"
```
Expected: `clean` (old navy/gold/slate must not appear).

- [ ] **Step 4: Commit**

```bash
git add shared/ui/grmc.css
git commit -m "feat(ui): grmc.css shared component layer"
```

---

## Task 4: Delivery wiring (sync script, gitignore, Docker, hub static)

**Files:**
- Create: `scripts/sync-ui.sh`
- Create: `hub/src/public/.gitkeep`
- Modify: `.gitignore`
- Modify: `apps/approvals/Dockerfile`, `apps/social-posts/Dockerfile`, `hub/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `hub/package.json`, `hub/src/index.ts`

**Interfaces:**
- Consumes: `shared/ui/grmc.css` + `shared/ui/fonts/` (Tasks 1–3).
- Produces: `/assets/grmc.css` and `/assets/fonts/*.woff2` served by each surface (apps + hub). Local dev populates `*/src/public/assets/` via `scripts/sync-ui.sh`.

- [ ] **Step 1: Write the dev sync script**

Create `scripts/sync-ui.sh`:

```bash
#!/usr/bin/env bash
# Copy the shared UI into each surface's served dir for local (non-Docker) dev.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/shared/ui"
for d in apps/approvals apps/social-posts hub; do
  DEST="$ROOT/$d/src/public/assets"
  mkdir -p "$DEST/fonts"
  cp "$SRC/grmc.css" "$DEST/grmc.css"
  cp "$SRC/fonts/"*.woff2 "$DEST/fonts/"
  echo "synced -> $d/src/public/assets"
done
```

Run:
```bash
chmod +x scripts/sync-ui.sh && ./scripts/sync-ui.sh
```
Expected: three `synced -> …` lines.

- [ ] **Step 2: Ignore the generated assets and keep the hub public dir**

Append to `.gitignore`:
```
# Generated: shared UI synced into served dirs (source of truth is shared/ui/)
**/src/public/assets/
```

Create `hub/src/public/.gitkeep` (empty file) so the hub has a `public/` dir to serve:
```bash
mkdir -p hub/src/public && touch hub/src/public/.gitkeep
```

- [ ] **Step 3: Verify gitignore excludes the synced assets**

Run:
```bash
git status --porcelain | grep -E "src/public/assets" && echo "TRACKED-BAD" || echo "ignored-ok"
```
Expected: `ignored-ok`.

- [ ] **Step 4: Add `@fastify/static` to the hub and serve `/assets`**

In `hub/package.json`, add to `dependencies` (alphabetical near the other `@fastify/*`):
```json
"@fastify/static": "^8.0.3",
```
Run:
```bash
cd hub && npm install && cd ..
```
Expected: installs without error.

In `hub/src/index.ts`, add the import near the other plugin imports:
```ts
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
```
(If `join` is already imported, don't duplicate it.) Then register the static plugin **before** `app.register(appRoutes)`:
```ts
app.register(fastifyStatic, { root: join(__dirname, "public"), prefix: "/assets/" , decorateReply: false});
```
Note: files live in `dist/public/assets/...` and are served at `/assets/...`. Because the static `root` is `dist/public` and prefix is `/assets/`, place synced files under `public/assets/` (the sync script and Dockerfile already do).

Correction for path mapping: set `root` to `join(__dirname, "public", "assets")` so `public/assets/grmc.css` serves at `/assets/grmc.css`:
```ts
app.register(fastifyStatic, { root: join(__dirname, "public", "assets"), prefix: "/assets/", decorateReply: false });
```

- [ ] **Step 5: Update the three Dockerfiles to root build context + copy shared UI**

Replace `apps/approvals/Dockerfile` with:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY apps/approvals/package.json ./
RUN npm install
COPY apps/approvals/tsconfig.json ./
COPY apps/approvals/src ./src
COPY shared/ui/grmc.css ./src/public/assets/grmc.css
COPY shared/ui/fonts ./src/public/assets/fonts
RUN npm run build && (cp -r src/public dist/public 2>/dev/null || true)
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

Replace `apps/social-posts/Dockerfile` with the same content but `apps/social-posts` in the three COPY paths.

Replace `hub/Dockerfile` with:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY hub/package.json ./
RUN npm install
COPY hub/tsconfig.json ./
COPY hub/src ./src
COPY shared/ui/grmc.css ./src/public/assets/grmc.css
COPY shared/ui/fonts ./src/public/assets/fonts
RUN npm run build && cp -r src/views dist/views && cp -r src/public dist/public
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 6: Point compose at the root build context**

In `docker-compose.yml`, for each of `hub`, `social-posts`, `approvals`, replace the single-line `build:` with a context block. Example for `approvals` (line ~108):
```yaml
    build:
      context: .
      dockerfile: apps/approvals/Dockerfile
```
For `hub`:
```yaml
    build:
      context: .
      dockerfile: hub/Dockerfile
```
For `social-posts`:
```yaml
    build:
      context: .
      dockerfile: apps/social-posts/Dockerfile
```
Leave `whoami` unchanged (it has no UI).

- [ ] **Step 7: Build and verify assets are served**

Run:
```bash
docker compose build approvals hub social-posts
```
Expected: all three build successfully.

Then bring up and curl (through Traefik or directly). Direct container check:
```bash
docker compose up -d approvals
docker compose exec approvals wget -qO- http://localhost:3000/assets/grmc.css | head -1
```
Expected: first line is the CSS comment `/* GRMC design system — Editorial Refined. Single source of truth. */`.
```bash
docker compose exec approvals sh -c 'ls dist/public/assets/fonts | wc -l'
```
Expected: `7`.

- [ ] **Step 8: Commit**

```bash
git add scripts/sync-ui.sh .gitignore hub/src/public/.gitkeep hub/package.json hub/package-lock.json hub/src/index.ts apps/approvals/Dockerfile apps/social-posts/Dockerfile hub/Dockerfile docker-compose.yml
git commit -m "feat(ui): deliver shared grmc.css + fonts to all surfaces at build"
```

---

## Task 5: Reskin the Approvals app

**Files:**
- Modify: `apps/approvals/src/public/index.html`
- Create: `apps/approvals/src/public/app.css`

**Interfaces:**
- Consumes: `grmc.css` shared vocabulary + tokens.
- Produces: an approvals UI with no inline `<style>`; bespoke request-card/roster styles in `app.css`.

- [ ] **Step 1: Create `apps/approvals/src/public/app.css` (bespoke pieces, token-driven)**

Create `apps/approvals/src/public/app.css`:
```css
/* Approvals — bespoke components (inherits grmc.css tokens). */
.rcard{background:var(--card);border:1px solid var(--rule);border-radius:var(--r-lg);padding:16px;margin-bottom:12px;box-shadow:var(--shadow)}
.rhead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.rtitle{font-family:var(--font-display);font-size:16px;font-weight:600;color:var(--navy)}
.rmeta{font-size:11px;color:var(--muted);margin-top:3px}
.rdesc{font-size:12.5px;color:var(--ink);margin-top:8px;white-space:pre-wrap;line-height:1.6}
.preview{margin-top:12px;border:1px solid var(--rule);border-radius:var(--r);overflow:hidden;background:var(--paper)}
.preview img{display:block;max-width:100%;max-height:340px;margin:0 auto}
.preview .pdf{padding:18px;text-align:center;font-size:12.5px}
.ver{font-size:11px;color:var(--muted);margin-top:8px}
.log{margin-top:10px;border-top:1px solid var(--rule);padding-top:10px}
.logitem{font-size:11.5px;color:var(--muted);padding:3px 0;line-height:1.5}
.logitem b{color:var(--ink)}
.logitem .cmt{color:var(--ink);display:block;background:var(--paper);border-radius:6px;padding:6px 9px;margin-top:3px}
.roster-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--rule)}
.roster-row:last-child{border-bottom:none}
.roster-name{font-size:13px;font-weight:600}
.roster-email{font-size:11px;color:var(--muted)}
.roster-row.off{opacity:.5}
```

- [ ] **Step 2: Replace the `<head>` style block and refresh the header in `index.html`**

In `apps/approvals/src/public/index.html`, delete the entire `<style>…</style>` block and replace it with:
```html
<link rel="stylesheet" href="/assets/grmc.css">
<link rel="stylesheet" href="/app.css">
```
Replace the existing `<header>…</header>` with (uses the `.seal` mark + Playfair):
```html
<header>
  <div class="logo">
    <div class="seal">G</div>
    <div><h1>GRMC Approvals</h1><p>Graphics &amp; content sign-off</p></div>
  </div>
  <div class="hright"><span class="hlabel" id="me-label">&hellip;</span></div>
</header>
```
Leave the rest of the body markup unchanged — its classes (`.tabs .tab .panel .card .ct .field .btn .btn-primary .btn-gold`) are provided by `grmc.css`.

- [ ] **Step 3: Verify no inline style remains and links are present**

Run:
```bash
grep -c "<style" apps/approvals/src/public/index.html; grep -c "/assets/grmc.css" apps/approvals/src/public/index.html; grep -c "/app.css" apps/approvals/src/public/index.html
```
Expected: `0`, then `1`, then `1`.

- [ ] **Step 4: Build, run existing tests, and visually verify**

Run:
```bash
cd apps/approvals && npm run build && npm test && cd ../..
```
Expected: build succeeds; existing tests PASS (presentation-only change).

Then sync + serve locally and eyeball it:
```bash
./scripts/sync-ui.sh
cd apps/approvals && node dist/index.js &  # or `docker compose up approvals`
```
Open the app; confirm: paper background, navy header with gold seal, Playfair `GRMC Approvals` title, gold-accented active tab, cards on `#fffdf8`. Compare against the approved mockup (paper canvas + Playfair headings). Stop the process when done.

- [ ] **Step 5: Commit**

```bash
git add apps/approvals/src/public/index.html apps/approvals/src/public/app.css
git commit -m "feat(ui): reskin Approvals to grmc.css design system"
```

---

## Task 6: Reskin the Social Posts app

**Files:**
- Modify: `apps/social-posts/src/public/index.html`
- Create: `apps/social-posts/src/public/app.css`

**Interfaces:**
- Consumes: `grmc.css` shared vocabulary + tokens.
- Produces: a social-posts UI with no inline `<style>`; bespoke series/post-planner styles in `app.css`.

- [ ] **Step 1: Extract bespoke selectors into `app.css` mapped to tokens**

The shared selectors (`.card .tab .tabs .panel .btn .btn-primary .btn-secondary .btn-gold .btn-hdr .btn-row .btn-sm .field .ct .hint .alert .alert-ok .alert-err .alert-info .alert-warn .spin .logo .mark .hright .hlabel .layout .lbl`) are now provided by `grmc.css` — do NOT redefine them.

Create `apps/social-posts/src/public/app.css` containing ONLY the bespoke selectors from the current inline `<style>`, with every hardcoded color swapped to a token using this mapping:

| Old hex | Token |
|---|---|
| `#1a2744` (navy) | `var(--navy)` |
| `#243058` | `var(--navy-2)` |
| `#c9a84c` (gold) | `var(--gold)` |
| `#e8c97a` | `var(--gold)` |
| `#f8f6f1` / off-white bg | `var(--paper)` |
| `#fff` card | `var(--card)` |
| `#dde0ea` border | `var(--rule)` |
| `#5a6480` muted | `var(--muted)` |
| `#9aa0b4` hint | `var(--hint)` |
| body text `#1a2744` | `var(--ink)` |

Bespoke selectors to move (from the current file): `.dot .dot-ok .dot-err .results .row2 .row3 .new-series-form .pcard .pbadge .pb-drafted .pb-pending .pb-posted .plabel .ptext .post-btns .post-date .post-draft-preview .post-phase .post-plan-row .post-row .post-sub .post-title .lbl-mon .lbl-tue .lbl-wed .lbl-thu .lbl-sat .sbadge .sb-active .sb-complete .sb-paused .series-actions .series-badges .series-body .series-card .series-chevron .series-header .series-meta .series-name .has-draft .open .copied`. For each, keep its existing rule body but apply the color mapping above. Add `font-family:var(--font-display)` to `.series-name` and `.post-title` so headings use Playfair.

- [ ] **Step 2: Replace the head style block and header in `index.html`**

Delete the entire `<style>…</style>` block in `apps/social-posts/src/public/index.html` and replace with:
```html
<link rel="stylesheet" href="/assets/grmc.css">
<link rel="stylesheet" href="/app.css">
```
Replace the `<header>` with:
```html
<header>
  <div class="logo">
    <div class="seal">GR</div>
    <div><h1>Social Posts</h1><p>Grace Resurrection Methodist Church</p></div>
  </div>
  <div class="hright">
    <div class="dot dot-err" id="auth-dot"></div>
    <span class="hlabel" id="auth-label">No API key</span>
    <button class="btn-hdr" onclick="switchTab('settings')">Settings</button>
  </div>
</header>
```

- [ ] **Step 3: Verify no inline style remains and links are present**

Run:
```bash
grep -c "<style" apps/social-posts/src/public/index.html; grep -c "/assets/grmc.css" apps/social-posts/src/public/index.html
```
Expected: `0`, then `1`.

Run (no legacy hex left in the app.css bespoke file):
```bash
grep -nE "#1a2744|#c9a84c|#f8f6f1|#dde0ea" apps/social-posts/src/public/app.css && echo "LEAK" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 4: Build, run existing tests, visually verify**

Run:
```bash
cd apps/social-posts && npm run build && npm test && cd ../..
```
Expected: build succeeds; tests PASS.

Sync + serve, then verify the dense screens (Settings, a series with posts) hold up: paper bg, Playfair on series/post titles, Inter everywhere else, gold accents, no broken/unstyled bespoke components. Compare to the approved direction.

- [ ] **Step 5: Commit**

```bash
git add apps/social-posts/src/public/index.html apps/social-posts/src/public/app.css
git commit -m "feat(ui): reskin Social Posts to grmc.css design system"
```

---

## Task 7: Reskin the hub (login + dashboard launcher)

**Files:**
- Modify: `hub/src/views/login.ejs`
- Modify: `hub/src/views/dashboard.ejs`

**Interfaces:**
- Consumes: `grmc.css` served by the hub at `/assets/grmc.css` (Task 4).
- Produces: hub login + dashboard in the Editorial Refined style. Dashboard is a launcher here (cards link to apps); live pending counts arrive in Phase 3.

- [ ] **Step 1: Rebuild `hub/src/views/login.ejs`**

Replace `hub/src/views/login.ejs` with:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GRMC Apps — Sign in</title>
    <link rel="stylesheet" href="/assets/grmc.css" />
    <style>body{display:grid;place-items:center;height:100vh}</style>
  </head>
  <body>
    <div class="card" style="text-align:center;max-width:360px;padding:34px 38px">
      <div class="seal" style="margin:0 auto 14px">G</div>
      <div class="kicker">Grace Resurrection Methodist Church</div>
      <h1 style="font-size:26px;margin:6px 0 4px">GRMC Apps</h1>
      <p class="muted" style="font-size:13px;margin-bottom:18px">Sign in to continue.</p>
      <a class="btn btn-primary" href="/auth/login" style="text-decoration:none">Sign in with Google</a>
    </div>
  </body>
</html>
```
(The small inline `<style>` is layout-only centering — allowed; no colors/fonts duplicated.)

- [ ] **Step 2: Rebuild `hub/src/views/dashboard.ejs` as a styled launcher**

Replace `hub/src/views/dashboard.ejs` with:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GRMC Apps</title>
    <link rel="stylesheet" href="/assets/grmc.css" />
  </head>
  <body>
    <header>
      <div class="logo">
        <div class="seal">G</div>
        <div><h1>GRMC Apps</h1><p>Workspace</p></div>
      </div>
      <div class="hright">
        <span class="hlabel"><%= user.email %></span>
        <a class="btn-hdr" href="/auth/logout" style="text-decoration:none">Sign out</a>
      </div>
    </header>
    <div class="layout" style="max-width:1000px">
      <div class="hero">
        <div class="kicker">Good day</div>
        <h1>Your apps</h1>
        <p>Open any GRMC tool below.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px">
        <% apps.forEach(function (a) { %>
          <a class="appcard" href="https://<%= a.host %>/" style="text-decoration:none;display:flex;flex-direction:column;min-height:120px">
            <div style="font-size:22px;margin-bottom:10px"><%= a.icon || "📦" %></div>
            <h3 style="font-size:18px"><%= a.name %></h3>
          </a>
        <% }); %>
      </div>
    </div>
  </body>
</html>
```

- [ ] **Step 3: Build the hub and verify it serves the new templates + CSS**

Run:
```bash
cd hub && npm run build && cd ..
./scripts/sync-ui.sh
docker compose up -d --build hub
```
Then verify the stylesheet is reachable and the dashboard references it:
```bash
docker compose exec hub wget -qO- http://localhost:3000/assets/grmc.css | head -1
grep -c "/assets/grmc.css" hub/src/views/dashboard.ejs hub/src/views/login.ejs
```
Expected: CSS comment first line; then `1` for each template.

- [ ] **Step 4: Visually verify login + dashboard**

Open `https://hub.grmc.app` (signed out → login card on paper with gold seal; signed in → dashboard with Playfair "Your apps" hero and app cards). Confirm it now matches the apps (no more slate/blue theme).

- [ ] **Step 5: Commit**

```bash
git add hub/src/views/login.ejs hub/src/views/dashboard.ejs
git commit -m "feat(ui): reskin hub login + dashboard to grmc.css"
```

---

## Done criteria

- `shared/ui/grmc.css` + `shared/ui/fonts/` exist; no surface has duplicated inline component CSS.
- Every surface (approvals, social-posts, hub login + dashboard) serves and links `/assets/grmc.css` and renders the Editorial Refined look (paper canvas, Playfair headings, Inter UI, navy/gold).
- `grep -rnE "#1a2744|#c9a84c|#0f172a|#2563eb" apps/*/src/public/*.html apps/*/src/public/app.css hub/src/views` returns nothing (legacy themes gone from markup/CSS). Note `shared/ui/` and generated `assets/` are the only homes for shared color.
- All existing app tests pass; no behavior changed.
- Fonts are self-hosted; no `fonts.googleapis.com` `<link>` in any shipped HTML.
