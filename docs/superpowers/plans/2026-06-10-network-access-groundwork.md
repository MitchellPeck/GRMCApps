# Network Access Groundwork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-machine `lvh.me`/mkcert access model with a real domain (`grmc.app`) + Let's Encrypt wildcard TLS via Cloudflare DNS-01, driven by one `BASE_DOMAIN` env var, with a domain-agnostic app registry — so every LAN/VPN device reaches the hub with trusted HTTPS.

**Architecture:** `BASE_DOMAIN` drives all Traefik `Host(...)` rules and the hub's URLs/cookie domain. The `apps` registry stores a per-app `subdomain`; the hub computes `host = <subdomain>.${BASE_DOMAIN}`. Traefik obtains a real `*.${BASE_DOMAIN}` cert via Let's Encrypt DNS-01 through Cloudflare. DNS (`*.grmc.app` → host LAN IP, DNS-only) and the Cloudflare token are deploy-time prerequisites.

**Tech Stack:** Docker Compose, Traefik v3.6 (ACME dnsChallenge/cloudflare), Postgres 16, Node/TS hub, Cloudflare DNS, Let's Encrypt.

---

## Sequencing rationale (read first)

The change is sequenced so the stack stays testable at each step:
- **Tasks 1–2** refactor the code/registry while **`BASE_DOMAIN` stays `lvh.me`** — `*.lvh.me` resolves to `127.0.0.1` natively and the existing mkcert `*.lvh.me` cert still covers the new short subdomains (`hub.lvh.me`, `whoami.lvh.me`, `social.lvh.me`), so everything keeps working locally with trusted TLS.
- **Task 3** is the **cutover** to `grmc.app` + Let's Encrypt. After it, local verification uses `curl -k --resolve <host>:443:127.0.0.1` (Traefik serves its default self-signed cert until your real Cloudflare token + domain are in place — that's the only `-k`). The **real trusted cert + cross-device test is gated on your Cloudflare setup** (spec §5/§7).
- **Task 4** updates docs.

## File map

| File | Change |
|---|---|
| `hub/src/hub-urls.ts` | NEW — pure `deriveHubUrls(baseDomain)` helper |
| `hub/src/hub-urls.test.ts` | NEW — unit test |
| `hub/src/config.ts` | derive publicUrl/cookieDomain/redirectUri from `BASE_DOMAIN`; add `baseDomain` |
| `hub/src/apps/host.ts` | NEW — pure `subdomainFromHost(host, baseDomain)` helper |
| `hub/src/apps/host.test.ts` | NEW — unit test |
| `hub/src/apps/registry.ts` | `host` → `subdomain`; `getAppByHost` → `getAppBySubdomain` |
| `hub/src/apps/routes.ts` | dashboard computes `host = <subdomain>.${baseDomain}` |
| `hub/src/auth/routes.ts` | `/auth/verify` derives subdomain via `subdomainFromHost` + `getAppBySubdomain` |
| `db/init/02-hub-schema.sql` | apps table `subdomain` instead of `host`; seeds `whoami`/`social` |
| `.env.example`, `.env` | remove `HUB_PUBLIC_URL`/`COOKIE_DOMAIN`; later `BASE_DOMAIN=grmc.app` + `ACME_EMAIL` + `CF_DNS_API_TOKEN` |
| `docker-compose.yml` | env-interpolated `Host(...)`; Traefik ACME args/env/volume; hub router wildcard; remove certs mount |
| `traefik/dynamic/tls.yml` | DELETE (mkcert) |
| `README.md` | new URLs + Cloudflare/LE prerequisites |

## Notes for the implementer
- Pure-logic tests run locally in a throwaway container: `docker run --rm -v "$PWD/hub":/work -w /work node:20-alpine sh -c "npm install --silent && npm run build && node --test dist/<file>.test.js"`. Delete any stray `hub/package-lock.json` afterward.
- Run all commands from repo root `/Users/mitchellpeck/WebstormProjects/GRMCApps`.
- `docker compose exec -T` for psql; never publish Postgres's port.

---

### Task 1: Hub derives its URLs from `BASE_DOMAIN`

**Files:** Create `hub/src/hub-urls.ts`, `hub/src/hub-urls.test.ts`; Modify `hub/src/config.ts`, `.env.example`, `.env`

Keeps `BASE_DOMAIN=lvh.me`, so the running stack is unchanged — this only removes the now-redundant `HUB_PUBLIC_URL`/`COOKIE_DOMAIN` envs by deriving them.

- [ ] **Step 1: Write the failing test `hub/src/hub-urls.test.ts`**

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deriveHubUrls } from "./hub-urls";

test("deriveHubUrls builds hub URLs from the base domain", () => {
  const u = deriveHubUrls("grmc.app");
  assert.equal(u.publicUrl, "https://hub.grmc.app");
  assert.equal(u.cookieDomain, ".grmc.app");
  assert.equal(u.redirectUri, "https://hub.grmc.app/auth/callback");

  const dev = deriveHubUrls("lvh.me");
  assert.equal(dev.publicUrl, "https://hub.lvh.me");
  assert.equal(dev.cookieDomain, ".lvh.me");
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module './hub-urls'`). Command:
```bash
docker run --rm -v "$PWD/hub":/work -w /work node:20-alpine sh -c "npm install --silent && npm run build && node --test dist/hub-urls.test.js"
rm -f hub/package-lock.json
```

- [ ] **Step 3: Create `hub/src/hub-urls.ts`**

```typescript
export interface HubUrls {
  publicUrl: string;
  cookieDomain: string;
  redirectUri: string;
}

// All hub-facing URLs derive from the single BASE_DOMAIN. The hub always lives
// at hub.<baseDomain>; the session cookie is shared across .<baseDomain>.
export function deriveHubUrls(baseDomain: string): HubUrls {
  const publicUrl = `https://hub.${baseDomain}`;
  return {
    publicUrl,
    cookieDomain: `.${baseDomain}`,
    redirectUri: `${publicUrl}/auth/callback`,
  };
}
```

- [ ] **Step 4: Run the test — expect PASS** (same command as Step 2). Expected: `pass 2`.

- [ ] **Step 5: Update `hub/src/config.ts` to use it**

Replace the entire file with:
```typescript
import { deriveHubUrls } from "./hub-urls";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const baseDomain = required("BASE_DOMAIN");
const urls = deriveHubUrls(baseDomain);

export const config = {
  port: 3000,
  baseDomain,
  publicUrl: urls.publicUrl,
  cookieDomain: urls.cookieDomain,
  sessionSecret: required("SESSION_SECRET"),
  databaseUrl: `postgres://${required("HUB_DB_USER")}:${required("HUB_DB_PASSWORD")}@postgres:5432/${required("HUB_DB_NAME")}`,
  google: {
    clientId: required("GOOGLE_CLIENT_ID"),
    clientSecret: required("GOOGLE_CLIENT_SECRET"),
    redirectUri: urls.redirectUri,
  },
};
```

- [ ] **Step 6: Remove the redundant envs from `.env.example`**

In `.env.example`, replace the top `# ---- Domain / URLs ----` block (the `BASE_DOMAIN`, `HUB_PUBLIC_URL`, `COOKIE_DOMAIN` lines) with just:
```dotenv
# ---- Domain ----
# Every host + URL derives from this. hub.<BASE_DOMAIN>, <app>.<BASE_DOMAIN>.
BASE_DOMAIN=grmc.app
```
(`.env.example` documents the target value `grmc.app`; the live `.env` stays `lvh.me` until Task 3.)

- [ ] **Step 7: Remove the redundant envs from the live `.env`**

Run:
```bash
sed -i '' '/^HUB_PUBLIC_URL=/d; /^COOKIE_DOMAIN=/d' .env
grep -E '^BASE_DOMAIN=' .env || echo "BASE_DOMAIN=lvh.me" >> .env
grep -E '^(BASE_DOMAIN|HUB_PUBLIC_URL|COOKIE_DOMAIN)=' .env
```
Expected: only `BASE_DOMAIN=lvh.me` remains (the other two are gone).

- [ ] **Step 8: Rebuild the hub and verify it still works at lvh.me**

```bash
docker compose up -d --build hub; sleep 4
curl -sS https://hub.lvh.me/healthz; echo
curl -sS -o /dev/null -D - https://hub.lvh.me/auth/login 2>/dev/null | grep -io "redirect_uri=[^&]*"
```
Expected: `{"ok":true}`; and `redirect_uri=https%3A%2F%2Fhub.lvh.me%2Fauth%2Fcallback` (derived from BASE_DOMAIN=lvh.me).

- [ ] **Step 9: Commit**

```bash
git add hub/src/hub-urls.ts hub/src/hub-urls.test.ts hub/src/config.ts .env.example
git commit -m "refactor: derive hub URLs from BASE_DOMAIN, drop HUB_PUBLIC_URL/COOKIE_DOMAIN"
```
(`.env` is gitignored — not committed.)

---

### Task 2: Domain-agnostic app registry (subdomain) + short subdomains

**Files:** Create `hub/src/apps/host.ts`, `hub/src/apps/host.test.ts`; Modify `hub/src/apps/registry.ts`, `hub/src/apps/routes.ts`, `hub/src/auth/routes.ts`, `db/init/02-hub-schema.sql`, `docker-compose.yml`

Still `BASE_DOMAIN=lvh.me`. Renames app hosts to short subdomains (`whoami.lvh.me`, `social.lvh.me`) and stores the registry by subdomain. `*.lvh.me` resolves natively and mkcert `*.lvh.me` covers the new names, so it stays verifiable locally.

- [ ] **Step 1: Write the failing test `hub/src/apps/host.test.ts`**

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { subdomainFromHost } from "./host";

test("subdomainFromHost extracts the app subdomain under the base domain", () => {
  assert.equal(subdomainFromHost("social.grmc.app", "grmc.app"), "social");
  assert.equal(subdomainFromHost("whoami.lvh.me", "lvh.me"), "whoami");
  // Wrong base domain → null (reject)
  assert.equal(subdomainFromHost("social.evil.com", "grmc.app"), null);
  // Exactly the base domain (no subdomain) → null
  assert.equal(subdomainFromHost("grmc.app", "grmc.app"), null);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module './host'`). Command:
```bash
docker run --rm -v "$PWD/hub":/work -w /work node:20-alpine sh -c "npm install --silent && npm run build && node --test dist/apps/host.test.js"
rm -f hub/package-lock.json
```

- [ ] **Step 3: Create `hub/src/apps/host.ts`**

```typescript
// Extract the app subdomain from a forwarded host, requiring it to sit directly
// under the configured base domain. Returns null if it doesn't match (reject).
export function subdomainFromHost(host: string, baseDomain: string): string | null {
  const suffix = "." + baseDomain;
  if (!host.endsWith(suffix)) return null;
  const subdomain = host.slice(0, -suffix.length);
  return subdomain.length > 0 ? subdomain : null;
}
```

- [ ] **Step 4: Run the test — expect PASS** (same command as Step 2). Expected: `pass 1`.

- [ ] **Step 5: Update `hub/src/apps/registry.ts`** — replace the entire file with:

```typescript
import { pool } from "../db";

export interface AppRow {
  id: string;
  slug: string;
  name: string;
  subdomain: string;
  icon: string | null;
  enabled: boolean;
}

export async function listEnabledApps(): Promise<AppRow[]> {
  const r = await pool.query<AppRow>(
    "SELECT id, slug, name, subdomain, icon, enabled FROM apps WHERE enabled = true ORDER BY name"
  );
  return r.rows;
}

export async function getAppBySubdomain(subdomain: string): Promise<AppRow | null> {
  const r = await pool.query<AppRow>(
    "SELECT id, slug, name, subdomain, icon, enabled FROM apps WHERE subdomain = $1",
    [subdomain]
  );
  return r.rows[0] ?? null;
}

export async function getUser(userId: string): Promise<{ id: string; email: string; name: string | null } | null> {
  const r = await pool.query("SELECT id, email, name FROM users WHERE id = $1", [userId]);
  return r.rows[0] ?? null;
}
```

- [ ] **Step 6: Update `hub/src/apps/routes.ts`** — replace the entire file with:

```typescript
import { FastifyInstance } from "fastify";
import { config } from "../config";
import { listEnabledApps, getUser } from "./registry";

export async function appRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (req, reply) => {
    if (!req.session.userId) {
      return reply.view("login.ejs", {});
    }
    const user = await getUser(req.session.userId);
    if (!user) {
      await req.session.destroy();
      return reply.view("login.ejs", {});
    }
    // Compute each app's full host from its subdomain + the base domain.
    const apps = (await listEnabledApps()).map((a) => ({
      ...a,
      host: `${a.subdomain}.${config.baseDomain}`,
    }));
    return reply.view("dashboard.ejs", { user, apps });
  });
}
```
(`dashboard.ejs` already links `https://<%= a.host %>/` — no view change needed.)

- [ ] **Step 7: Update `/auth/verify` in `hub/src/auth/routes.ts`**

Change the import line that pulls from `../apps/registry`:
```typescript
import { getAppBySubdomain, getUser } from "../apps/registry";
import { subdomainFromHost } from "../apps/host";
```
Then in the `/auth/verify` handler, replace the app-lookup block (the `const appRow = await getAppByHost(forwardedHost);` and its `if`) with:
```typescript
    const subdomain = subdomainFromHost(forwardedHost, config.baseDomain);
    const appRow = subdomain ? await getAppBySubdomain(subdomain) : null;
    if (!appRow || !appRow.enabled) {
      return reply.code(403).send("Forbidden: unknown or disabled app");
    }
```
Leave the session check, the `getUser` call, and the `X-Auth-*` header response exactly as they are.

- [ ] **Step 8: Update the schema seed `db/init/02-hub-schema.sql`**

Change the `apps` table definition: replace the `host  text UNIQUE NOT NULL` column line with:
```sql
  subdomain   text UNIQUE NOT NULL,
```
And replace the two seed INSERTs (whoami + social-posts) with:
```sql
INSERT INTO apps (slug, name, subdomain, icon)
VALUES ('whoami', 'Who Am I', 'whoami', '👤');

INSERT INTO apps (slug, name, subdomain, icon)
VALUES ('social-posts', 'Social Posts', 'social', '📣');
```

- [ ] **Step 9: Migrate the live `hub` database (init scripts don't re-run on an existing volume)**

```bash
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d hub <<'SQL'
ALTER TABLE apps ADD COLUMN subdomain text;
UPDATE apps SET subdomain = 'whoami' WHERE slug = 'whoami';
UPDATE apps SET subdomain = 'social' WHERE slug = 'social-posts';
ALTER TABLE apps ALTER COLUMN subdomain SET NOT NULL;
ALTER TABLE apps ADD CONSTRAINT apps_subdomain_key UNIQUE (subdomain);
ALTER TABLE apps DROP COLUMN host;
SQL
docker compose exec -T postgres psql -U postgres -d hub -c "SELECT slug, subdomain FROM apps ORDER BY slug;"
```
Expected: `social-posts | social` and `whoami | whoami`, with no `host` column.

- [ ] **Step 10: Update the `Host(...)` labels in `docker-compose.yml` to env-interpolated short subdomains**

Change the three router rule labels:
- hub: `- "traefik.http.routers.hub.rule=Host(\`hub.${BASE_DOMAIN}\`)"`
- whoami: `- "traefik.http.routers.whoami.rule=Host(\`whoami.${BASE_DOMAIN}\`)"`
- social: `- "traefik.http.routers.social.rule=Host(\`social.${BASE_DOMAIN}\`)"`

(Leave entrypoints/tls/middlewares/service labels unchanged.)

- [ ] **Step 11: Rebuild and verify at lvh.me (native DNS + mkcert wildcard cover the new short hosts)**

```bash
docker compose up -d --build hub whoami social-posts; sleep 5
docker compose config | grep -oE "Host\(\`[^)]*\`\)"
curl -sS https://hub.lvh.me/healthz; echo
curl -sS -o /dev/null -D - https://social.lvh.me/ 2>/dev/null | grep -iE "^(HTTP|location:)"
curl -sS -o /dev/null -D - https://whoami.lvh.me/ 2>/dev/null | grep -iE "^(HTTP|location:)"
```
Expected: `docker compose config` shows `Host(\`hub.lvh.me\`)`, `Host(\`whoami.lvh.me\`)`, `Host(\`social.lvh.me\`)`; `/healthz` → `{"ok":true}`; `social.lvh.me` and `whoami.lvh.me` each → `302` → `location: https://hub.lvh.me/auth/login?redirect=https%3A%2F%2Fsocial.lvh.me%2F` (and `…whoami.lvh.me…`), proving forwardAuth resolves the app by its new subdomain.

- [ ] **Step 12: Run the hub unit tests (regression) and commit**

```bash
docker run --rm -v "$PWD/hub":/work -w /work node:20-alpine sh -c "npm install --silent && npm run build && node --test dist/apps/host.test.js dist/hub-urls.test.js" 2>&1 | grep -E "# (tests|pass|fail)"
rm -f hub/package-lock.json
git add hub/src/apps/host.ts hub/src/apps/host.test.ts hub/src/apps/registry.ts hub/src/apps/routes.ts hub/src/auth/routes.ts db/init/02-hub-schema.sql docker-compose.yml
git commit -m "refactor: domain-agnostic app registry by subdomain; short per-app subdomains"
```
Expected: `pass 3` across the two test files.

---

### Task 3: Cutover to `grmc.app` + Let's Encrypt DNS-01 (Cloudflare)

**Files:** Modify `.env.example`, `.env`, `docker-compose.yml`; Delete `traefik/dynamic/tls.yml`

After this, plain `lvh.me` access stops (replaced by `grmc.app`). Local verification uses `curl -k --resolve` (Traefik serves its default self-signed cert until your real Cloudflare token issues the LE cert). The real trusted cert + cross-device test happen once your Cloudflare/domain prerequisites are done.

- [ ] **Step 1: Add ACME settings to `.env.example`**

Under the `# ---- Domain ----` block in `.env.example`, append:
```dotenv

# ---- TLS (Let's Encrypt via Cloudflare DNS-01) ----
# Email for Let's Encrypt registration/expiry notices.
ACME_EMAIL=you@example.com
# Cloudflare API token scoped to Zone:DNS:Edit for the BASE_DOMAIN zone.
CF_DNS_API_TOKEN=replace-with-cloudflare-dns-edit-token
```

- [ ] **Step 2: Flip the live `.env` to the real domain + add ACME settings**

Run (replace the email with yours after, and paste the real Cloudflare token):
```bash
sed -i '' 's/^BASE_DOMAIN=.*/BASE_DOMAIN=grmc.app/' .env
grep -q '^ACME_EMAIL=' .env || echo "ACME_EMAIL=you@example.com" >> .env
grep -q '^CF_DNS_API_TOKEN=' .env || echo "CF_DNS_API_TOKEN=replace-with-cloudflare-dns-edit-token" >> .env
grep -E '^(BASE_DOMAIN|ACME_EMAIL|CF_DNS_API_TOKEN)=' .env
```
Expected: `BASE_DOMAIN=grmc.app` plus the two ACME lines. **Manual:** edit `.env` to set the real `ACME_EMAIL` and `CF_DNS_API_TOKEN` once you have them (the LE cert can't issue until the token is real — that's expected for the local-only verification below).

- [ ] **Step 3: Add the Let's Encrypt cert resolver + Cloudflare token to the Traefik service in `docker-compose.yml`**

Replace the entire `traefik:` service block with:
```yaml
  traefik:
    image: traefik:v3.6
    command:
      - "--configfile=/etc/traefik/traefik.yml"
      - "--certificatesresolvers.le.acme.email=${ACME_EMAIL}"
      - "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json"
      - "--certificatesresolvers.le.acme.dnschallenge=true"
      - "--certificatesresolvers.le.acme.dnschallenge.provider=cloudflare"
      - "--certificatesresolvers.le.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53"
    environment:
      CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}"
    ports:
      - "80:80"
      - "443:443"
      - "8080:8080"   # Traefik dashboard (local only)
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./traefik/traefik.yml:/etc/traefik/traefik.yml:ro
      - ./traefik/dynamic:/etc/traefik/dynamic:ro
      - letsencrypt:/letsencrypt
    networks: [hubnet]
```
(The ACME resolver is configured via CLI args so Compose interpolates `${ACME_EMAIL}`; the Cloudflare provider reads `CF_DNS_API_TOKEN` from the environment.)

- [ ] **Step 4: Make the hub router request the wildcard cert**

In `docker-compose.yml`, in the `hub` service `labels:`, replace the single `tls=true` line with these three:
```yaml
      - "traefik.http.routers.hub.tls.certresolver=le"
      - "traefik.http.routers.hub.tls.domains[0].main=${BASE_DOMAIN}"
      - "traefik.http.routers.hub.tls.domains[0].sans=*.${BASE_DOMAIN}"
```
Leave the `whoami` and `social` routers with their existing `tls=true` (Traefik serves them the wildcard cert by SNI once issued).

- [ ] **Step 5: Add the `letsencrypt` volume**

In `docker-compose.yml`, under the top-level `volumes:` (which has `pgdata:`), add:
```yaml
  letsencrypt:
```

- [ ] **Step 6: Remove the mkcert static cert config**

```bash
git rm traefik/dynamic/tls.yml
```
(The `certs/` mount was already removed from the traefik service in Step 3. `certs/` is gitignored and now unused.)

- [ ] **Step 7: Verify the cutover locally (routing/forwardAuth/oauth on grmc.app; cert is self-signed until your token is real → use -k)**

```bash
docker compose up -d
sleep 6
echo "=== interpolated hosts ==="; docker compose config | grep -oE "Host\(\`[^)]*\`\)"
echo "=== traefik loaded the resolver, no fatal config error ==="; docker compose logs traefik 2>&1 | grep -iE "error|acme|le" | tail -8
echo "=== hub healthz on grmc.app (-k: default cert until LE issues) ==="
curl -k -sS --resolve hub.grmc.app:443:127.0.0.1 https://hub.grmc.app/healthz; echo
echo "=== gated app on grmc.app ==="
curl -k -sS -o /dev/null -D - --resolve social.grmc.app:443:127.0.0.1 https://social.grmc.app/ 2>/dev/null | grep -iE "^(HTTP|location:)"
echo "=== oauth redirect now targets hub.grmc.app ==="
curl -k -sS -o /dev/null -D - --resolve hub.grmc.app:443:127.0.0.1 https://hub.grmc.app/auth/login 2>/dev/null | grep -io "redirect_uri=[^&]*"
```
Expected: hosts are `Host(\`hub.grmc.app\`)` / `whoami.grmc.app` / `social.grmc.app`; Traefik logs show it loading the `le` resolver and attempting DNS-01 (it will log an ACME/Cloudflare auth error while the token is a placeholder — that's expected and non-fatal); `/healthz` → `{"ok":true}`; `social.grmc.app` → `302` → `location: https://hub.grmc.app/auth/login?redirect=https%3A%2F%2Fsocial.grmc.app%2F`; and `redirect_uri=https%3A%2F%2Fhub.grmc.app%2Fauth%2Fcallback`.

> **Gated on your setup (not scriptable here):** once `grmc.app` is on Cloudflare with the real `CF_DNS_API_TOKEN` and an `A *.grmc.app → <host LAN IP>` (DNS-only) record, restart Traefik; it issues the real `*.grmc.app` cert (`docker compose logs traefik | grep -i certificate`). Then from a second LAN device (and over the VPN) open `https://hub.grmc.app` — trusted cert, Google login completes (after you add `https://hub.grmc.app/auth/callback` to the Google OAuth client).

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "feat: cutover to grmc.app with Let's Encrypt wildcard via Cloudflare DNS-01"
```

---

### Task 4: Update docs

**Files:** Modify `README.md`

- [ ] **Step 1: Read `README.md`** to find the "## Prerequisites", "## Setup", and "## URLs" sections (they reference mkcert and `*.lvh.me`).

- [ ] **Step 2: Replace the mkcert prerequisites/setup with the Cloudflare + Let's Encrypt flow.** Set the Prerequisites/Setup to:

```markdown
## Prerequisites

- Docker + Docker Compose
- A dedicated domain on **Cloudflare** (this project uses `grmc.app`)
- A Cloudflare API token scoped to **Zone → DNS → Edit** for that zone
- A Google OAuth 2.0 Web client with redirect URI `https://hub.grmc.app/auth/callback`
- The Docker host on a **static IP / DHCP reservation**

## Setup

1. **DNS (Cloudflare):** add `A  *.grmc.app → <Docker host LAN IP>`, **DNS-only** (grey cloud).
2. **Environment:** `cp .env.example .env`, then set `BASE_DOMAIN`, `ACME_EMAIL`,
   `CF_DNS_API_TOKEN`, the Google client id/secret, and the password/secret fields.
3. **Run:** `docker compose up -d --build` — Traefik obtains a trusted
   `*.grmc.app` certificate from Let's Encrypt via the Cloudflare DNS-01 challenge.

Every device on the LAN (or tunneling in via VPN) can then reach the hosts below
with trusted HTTPS and no per-device setup.
```

And set the "## URLs" section to:
```markdown
## URLs

- Hub dashboard: https://hub.grmc.app
- whoami app:    https://whoami.grmc.app
- Social Posts:  https://social.grmc.app
- Traefik dashboard (host-local only): http://localhost:8080
```

Also update the "## Adding an app" step that mentions `host = app-<name>.lvh.me` to: *"add a row to `apps` with the app's `subdomain` (e.g. `social`); its host is `<subdomain>.${BASE_DOMAIN}`"*, and the compose label note to `Host(\`<subdomain>.${BASE_DOMAIN}\`)`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README for grmc.app + Let's Encrypt access model"
```

---

## Self-review notes

- **Spec coverage:** Traefik LE DNS-01 + volume + mkcert removal (Task 3), BASE_DOMAIN-driven domain (Tasks 1–3), domain-agnostic registry + migration (Task 2), hub URL derivation incl. OAuth redirect (Task 1), docs/prereqs (Task 4). All spec §4 items map to tasks; §5 prerequisites are surfaced in Task 3 Step 7 note + Task 4 README.
- **Verifiability:** Tasks 1–2 verify natively at `lvh.me` (forwardAuth on the new short subdomains); Task 3 verifies routing/forwardAuth/oauth on `grmc.app` via `curl -k --resolve`; the trusted-cert + cross-device leg is explicitly gated on the user's Cloudflare setup (spec §7).
- **Type/name consistency:** `subdomainFromHost(host, baseDomain)`, `getAppBySubdomain(subdomain)`, `config.baseDomain`, `AppRow.subdomain`, and the computed `host = ${subdomain}.${baseDomain}` are used consistently across registry, routes, verify, dashboard, and the migration/seed.
- **No silent breakage:** the live DB migration (Task 2 Step 9) runs in lockstep with the code that reads `subdomain`, and the `host` column is dropped only after the new code is built — the hub never queries a column that doesn't exist.
