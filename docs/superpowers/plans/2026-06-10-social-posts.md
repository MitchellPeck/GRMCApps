# Social Posts App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Google Apps Script "GRMC Social Posts" tool into a hub-native Fastify + Postgres app (`apps/social-posts/`), gated by Traefik forwardAuth, reproducing all features and the UI 1:1.

**Architecture:** A new app container behind the hub's forwardAuth gateway, with its own `socialposts` Postgres database. The Fastify backend serves the ported HTML/JS UI and exposes `/api/*` REST endpoints that replace each Apps Script server function. Postgres tables replace the Google Sheets; a `settings` table replaces Script Properties; server-side `fetch` replaces `UrlFetchApp` for Claude and Mailchimp.

**Tech Stack:** Node 20 + TypeScript + Fastify 5, `pg`, `@fastify/static`, Postgres 16, Traefik forwardAuth, Claude Messages API (`claude-sonnet-4-6`), Mailchimp Marketing API.

---

## Reference source (port FROM these)

The original Apps Script and HTML are saved in the repo:
- `docs/reference/social-posts/Code.gs` — all server functions
- `docs/reference/social-posts/index.html` — the full UI (HTML + CSS + inline JS)

**Translation rules** (apply consistently when porting any function):
- `PropertiesService` get/set → `settings` table via `getSetting`/`setSetting` (Task 4).
- `SpreadsheetApp` sheets → Postgres tables via `pg` (Tasks 7, 9).
- `UrlFetchApp.fetch(url, opts)` → `fetch(url, opts)` (Node 20 global fetch), `await res.text()/res.json()`.
- `Utilities.base64Encode(s)` → `Buffer.from(s).toString('base64')`.
- `Logger.log` → `app.log` / `req.log`.
- Each server fn returned `{ok:true,...}` / `{ok:false,error}` — keep these shapes; HTTP handlers send them as JSON.
- `Date.now()`-based ids (`'series-' + Date.now()`) → keep (`series-${Date.now()}`).

## File structure

```
apps/social-posts/
  Dockerfile           package.json        tsconfig.json
  src/
    index.ts           # Fastify bootstrap, static serving, ensureSchema(), route registration
    config.ts          # env (port, SOCIALPOSTS_DATABASE_URL)
    db.ts              # pg Pool + ensureSchema() (runs schema DDL)
    schema.ts          # the CREATE TABLE IF NOT EXISTS DDL string
    identity.ts        # read X-Auth-* headers
    settings.ts        # getSetting/setSetting/getSettingsView
    voice.ts           # VOICE + HISTORY_SERIES_POSTS
    claude.ts          # callClaude(), stripJsonFences()
    mailchimp.ts       # auth + getLatestGraceNotes/getLatestBlog + cleanCampaignText()
    series.ts          # series + series_posts data access, seed, thursday matcher, claude drafting
    drafts.ts          # savePostDrafts, getRecentDrafts
    runs.ts            # draftMondayPosts, draftWedPosts, draftFridayPost
    routes/
      me.ts  settings.ts  mailchimp.ts  series.ts  drafts.ts
    public/
      index.html       # ported UI
      app.js           # ported frontend JS (fetch-based)
  src/*.test.ts        # node --test unit tests
```

## Notes for the implementer

- Tests use Node's built-in test runner (`node --test`), no extra deps. Pure-logic tests run locally; DB tests run inside a throwaway container on the `grmcapps_hubnet` network (pattern shown in Task 4).
- The app listens on **port 3000**; the host is `app-social.lvh.me`; the compose project network is `grmcapps_hubnet`.
- Run all commands from repo root `/Users/mitchellpeck/WebstormProjects/GRMCApps` unless noted.
- Delete any stray `apps/social-posts/package-lock.json` before committing (the Dockerfile uses `npm install`).
- Use `docker compose exec -T` for psql checks; never publish Postgres's port.

---

### Task 1: Provision the `socialposts` database and register the app

**Files:**
- Modify: `db/init/01-databases.sh`, `db/init/02-hub-schema.sql`, `.env`, `.env.example`

- [ ] **Step 1: Add per-app DB creation to `db/init/01-databases.sh`**

In `db/init/01-databases.sh`, add a third provisioning call after the `whoami` line:
```bash
create_app_db "$SOCIALPOSTS_DB_NAME" "$SOCIALPOSTS_DB_USER" "$SOCIALPOSTS_DB_PASSWORD"
```

- [ ] **Step 2: Seed the app into the hub registry for fresh setups**

In `db/init/02-hub-schema.sql`, after the existing `INSERT INTO apps ... 'whoami' ...` statement (and before `RESET ROLE;`), add:
```sql
INSERT INTO apps (slug, name, host, icon)
VALUES ('social-posts', 'Social Posts', 'app-social.lvh.me', '📣');
```

- [ ] **Step 3: Add env vars to `.env.example`**

Append to `.env.example`:
```dotenv

SOCIALPOSTS_DB_NAME=socialposts
SOCIALPOSTS_DB_USER=socialposts_user
SOCIALPOSTS_DB_PASSWORD=replace-socialposts-db-password
```

- [ ] **Step 4: Add the same vars to the live `.env` with a real password**

Run:
```bash
{
  echo "";
  echo "SOCIALPOSTS_DB_NAME=socialposts";
  echo "SOCIALPOSTS_DB_USER=socialposts_user";
  echo "SOCIALPOSTS_DB_PASSWORD=$(openssl rand -hex 16)";
} >> .env
```

- [ ] **Step 5: Create the DB + role against the ALREADY-RUNNING Postgres (init scripts won't re-run on the existing volume)**

Run:
```bash
SP_USER=$(grep '^SOCIALPOSTS_DB_USER=' .env | cut -d= -f2)
SP_PASS=$(grep '^SOCIALPOSTS_DB_PASSWORD=' .env | cut -d= -f2)
SP_DB=$(grep '^SOCIALPOSTS_DB_NAME=' .env | cut -d= -f2)
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "CREATE ROLE \"$SP_USER\" WITH LOGIN PASSWORD '$SP_PASS';" \
  -c "CREATE DATABASE \"$SP_DB\" OWNER \"$SP_USER\";"
```
Expected: `CREATE ROLE` then `CREATE DATABASE`. (If they already exist from a prior run, that's fine — note it and continue.)

- [ ] **Step 6: Register the app in the running hub registry**

Run:
```bash
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d hub \
  -c "INSERT INTO apps (slug, name, host, icon) VALUES ('social-posts','Social Posts','app-social.lvh.me','📣') ON CONFLICT (slug) DO NOTHING;"
```
Expected: `INSERT 0 1` (or `INSERT 0 0` if already present).

- [ ] **Step 7: Verify**

Run:
```bash
docker compose exec -T postgres psql -U postgres -c "SELECT datname, pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname='socialposts';"
docker compose exec -T postgres psql -U postgres -d hub -c "SELECT slug, host FROM apps ORDER BY name;"
```
Expected: `socialposts` owned by `socialposts_user`; the apps list includes `social-posts | app-social.lvh.me`.

- [ ] **Step 8: Commit**

```bash
git add db/init/01-databases.sh db/init/02-hub-schema.sql .env.example
git commit -m "feat: provision socialposts database and register app in hub"
```

---

### Task 2: App scaffold, schema-on-boot, and forwardAuth wiring

**Files:**
- Create: `apps/social-posts/package.json`, `tsconfig.json`, `Dockerfile`, `src/config.ts`, `src/schema.ts`, `src/db.ts`, `src/index.ts`
- Modify: `docker-compose.yml`

- [ ] **Step 1: `apps/social-posts/package.json`**

```json
{
  "name": "social-posts",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": { "build": "tsc", "start": "node dist/index.js", "test": "node --test" },
  "dependencies": {
    "@fastify/static": "^8.0.3",
    "fastify": "^5.1.0",
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "@types/pg": "^8.11.10",
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 2: `apps/social-posts/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: `apps/social-posts/src/config.ts`**

```typescript
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: 3000,
  databaseUrl: `postgres://${required("SOCIALPOSTS_DB_USER")}:${required("SOCIALPOSTS_DB_PASSWORD")}@postgres:5432/${required("SOCIALPOSTS_DB_NAME")}`,
};
```

- [ ] **Step 4: `apps/social-posts/src/schema.ts`**

```typescript
// DDL run on boot (idempotent). Mirrors the spec data model.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS series (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  context     text NOT NULL DEFAULT '',
  cadence     text NOT NULL DEFAULT 'weekly',
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS series_posts (
  series_id  text NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  post_idx   integer NOT NULL,
  date       text NOT NULL DEFAULT '',
  phase      text NOT NULL DEFAULT '',
  title      text NOT NULL,
  sub        text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'pending',
  draft      text NOT NULL DEFAULT '',
  notes      text NOT NULL DEFAULT '',
  PRIMARY KEY (series_id, post_idx)
);

CREATE TABLE IF NOT EXISTS post_drafts (
  id          bigserial PRIMARY KEY,
  run         text NOT NULL,
  post_date   text NOT NULL DEFAULT '',
  key         text NOT NULL,
  text        text NOT NULL,
  status      text NOT NULL DEFAULT 'draft',
  created_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
`;
```

- [ ] **Step 5: `apps/social-posts/src/db.ts`**

```typescript
import { Pool } from "pg";
import { config } from "./config";
import { SCHEMA_SQL } from "./schema";

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function ensureSchema(): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
```

- [ ] **Step 6: `apps/social-posts/src/index.ts` (health only for now)**

```typescript
import Fastify from "fastify";
import { config } from "./config";
import { ensureSchema } from "./db";

const app = Fastify({ logger: true, trustProxy: true });

app.get("/healthz", async () => ({ ok: true }));

async function start() {
  await ensureSchema();
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`social-posts listening on ${config.port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
```

- [ ] **Step 7: `apps/social-posts/Dockerfile`**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && cp -r src/public dist/public 2>/dev/null || true
EXPOSE 3000
CMD ["node", "dist/index.js"]
```
(The `public/` copy is a no-op now and starts working once Task 10 adds `src/public`.)

- [ ] **Step 8: Add the service to `docker-compose.yml`**

Insert under `services:` (keep others intact):
```yaml
  social-posts:
    build: ./apps/social-posts
    environment:
      SOCIALPOSTS_DB_USER: "${SOCIALPOSTS_DB_USER}"
      SOCIALPOSTS_DB_PASSWORD: "${SOCIALPOSTS_DB_PASSWORD}"
      SOCIALPOSTS_DB_NAME: "${SOCIALPOSTS_DB_NAME}"
    depends_on:
      postgres:
        condition: service_healthy
    networks: [hubnet]
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.social.rule=Host(`app-social.lvh.me`)"
      - "traefik.http.routers.social.entrypoints=websecure"
      - "traefik.http.routers.social.tls=true"
      - "traefik.http.routers.social.middlewares=hub-forward-auth@file"
      - "traefik.http.services.social.loadbalancer.server.port=3000"
```

- [ ] **Step 9: Build, start, verify schema + gating**

Run:
```bash
docker compose up -d --build social-posts
for i in $(seq 1 15); do [ "$(docker compose ps social-posts --format '{{.State}}')" = "running" ] && break; sleep 1; done
sleep 3
docker compose exec -T social-posts wget -qO- http://localhost:3000/healthz; echo
docker compose exec -T postgres psql -U postgres -d socialposts -c "\dt"
curl -sS -D - -o /dev/null https://app-social.lvh.me/ 2>/dev/null | grep -iE "^(HTTP|location:)"
```
Expected: `{"ok":true}`; the `socialposts` DB lists tables `settings`, `series`, `series_posts`, `post_drafts`; and the gated curl returns `302` → `location: https://hub.lvh.me/auth/login?redirect=https%3A%2F%2Fapp-social.lvh.me%2F`.

- [ ] **Step 10: Commit**

```bash
git add apps/social-posts/package.json apps/social-posts/tsconfig.json apps/social-posts/Dockerfile apps/social-posts/src/config.ts apps/social-posts/src/schema.ts apps/social-posts/src/db.ts apps/social-posts/src/index.ts docker-compose.yml
git commit -m "feat: social-posts app scaffold with schema-on-boot behind forwardAuth"
```

---

### Task 3: Identity, static UI serving, and `/api/me`

**Files:**
- Create: `apps/social-posts/src/identity.ts`, `apps/social-posts/src/routes/me.ts`, `apps/social-posts/src/public/index.html` (placeholder)
- Modify: `apps/social-posts/src/index.ts`

- [ ] **Step 1: `apps/social-posts/src/identity.ts`**

```typescript
import { FastifyRequest } from "fastify";

export interface Identity {
  email: string;
  name: string;
}

// Identity headers are injected by Traefik forwardAuth (from the hub). The
// host is fully gated, so these are present on every real request.
export function getIdentity(req: FastifyRequest): Identity {
  return {
    email: (req.headers["x-auth-email"] as string) ?? "",
    name: (req.headers["x-auth-name"] as string) ?? "",
  };
}
```

- [ ] **Step 2: `apps/social-posts/src/routes/me.ts`**

```typescript
import { FastifyInstance } from "fastify";
import { getIdentity } from "../identity";

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/me", async (req) => {
    const id = getIdentity(req);
    return { ok: true, email: id.email, name: id.name };
  });
}
```

- [ ] **Step 3: Placeholder `apps/social-posts/src/public/index.html`** (replaced fully in Task 10)

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>GRMC Social Posts</title></head>
<body><p>Social Posts — UI loads in Task 10.</p></body></html>
```

- [ ] **Step 4: Wire static serving + routes in `apps/social-posts/src/index.ts`**

Replace the file with:
```typescript
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { config } from "./config";
import { ensureSchema } from "./db";
import { meRoutes } from "./routes/me";

const app = Fastify({ logger: true, trustProxy: true });

app.register(fastifyStatic, { root: join(__dirname, "public"), prefix: "/" });
app.register(meRoutes);

app.get("/healthz", async () => ({ ok: true }));

async function start() {
  await ensureSchema();
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`social-posts listening on ${config.port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
```
(`@fastify/static` serves `public/index.html` at `/` automatically.)

- [ ] **Step 5: Rebuild and verify static + /api/me**

Run:
```bash
docker compose up -d --build social-posts
sleep 4
docker compose exec -T social-posts wget -qO- http://localhost:3000/ | grep -i "Social Posts"
docker compose exec -T social-posts wget -qO- --header="X-Auth-Email: a@b.com" --header="X-Auth-Name: Tester" http://localhost:3000/api/me; echo
```
Expected: the placeholder HTML contains "Social Posts"; `/api/me` returns `{"ok":true,"email":"a@b.com","name":"Tester"}`.

- [ ] **Step 6: Commit**

```bash
git add apps/social-posts/src/identity.ts apps/social-posts/src/routes/me.ts apps/social-posts/src/public/index.html apps/social-posts/src/index.ts
git commit -m "feat: identity headers, static UI serving, and /api/me"
```

---

### Task 4: Settings module + endpoints (DB-backed, with tests)

**Files:**
- Create: `apps/social-posts/src/settings.ts`, `apps/social-posts/src/settings.test.ts`, `apps/social-posts/src/routes/settings.ts`
- Modify: `apps/social-posts/src/index.ts`

Ports `getSettings`/`saveSettings` from `Code.gs`, but storing into the `settings` table instead of Script Properties.

- [ ] **Step 1: Write the failing test `apps/social-posts/src/settings.test.ts`**

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { setSetting, getSetting, getSettingsView } from "./settings";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

test("settings round-trip and view never leaks raw key", async () => {
  await setSetting(pool, "anthropic_api_key", "sk-ant-SECRETVALUE-123");
  await setSetting(pool, "mailchimp_api_key", "abc-us21");
  await setSetting(pool, "mailchimp_server", "us21");

  assert.equal(await getSetting(pool, "anthropic_api_key"), "sk-ant-SECRETVALUE-123");

  const view = await getSettingsView(pool);
  assert.equal(view.hasAnthropicKey, true);
  assert.equal(view.hasMailchimp, true);
  assert.equal(view.mailchimpServer, "us21");
  // Hint is a truncated prefix, NOT the full key.
  assert.equal(view.anthropicKeyHint, "sk-ant-SEC...");
  assert.ok(!JSON.stringify(view).includes("SECRETVALUE"), "view must not contain the full key");

  await pool.query("DELETE FROM settings");
  await pool.end();
});
```

- [ ] **Step 2: Run it to verify it fails**

(See Task 4 Step 5 for the exact docker test command.) Expected: FAIL — `Cannot find module './settings'`.

- [ ] **Step 3: Implement `apps/social-posts/src/settings.ts`**

```typescript
import { Pool } from "pg";

export async function getSetting(pool: Pool, key: string): Promise<string> {
  const r = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
  return r.rows[0] ? r.rows[0].value : "";
}

export async function setSetting(pool: Pool, key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

export interface SettingsView {
  anthropicKeyHint: string;
  hasAnthropicKey: boolean;
  mailchimpServer: string;
  hasMailchimp: boolean;
}

// Mirrors Code.gs getSettings(): never returns full keys, only a hint + flags.
export async function getSettingsView(pool: Pool): Promise<SettingsView> {
  const ak = await getSetting(pool, "anthropic_api_key");
  const mk = await getSetting(pool, "mailchimp_api_key");
  const server = await getSetting(pool, "mailchimp_server");
  return {
    anthropicKeyHint: ak ? ak.substring(0, 10) + "..." : "",
    hasAnthropicKey: ak.length > 0,
    mailchimpServer: server,
    hasMailchimp: !!(mk && server),
  };
}
```

- [ ] **Step 4: Implement `apps/social-posts/src/routes/settings.ts`**

Ports `saveSettings(s)` — only persists non-empty trimmed values (same as `Code.gs`).
```typescript
import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getSettingsView, setSetting } from "../settings";

interface SaveBody {
  anthropicKey?: string;
  mailchimpKey?: string;
  mailchimpServer?: string;
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async () => {
    try {
      return { ok: true, ...(await getSettingsView(pool)) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.post("/api/settings", async (req) => {
    try {
      const s = (req.body ?? {}) as SaveBody;
      if (s.anthropicKey && s.anthropicKey.trim())
        await setSetting(pool, "anthropic_api_key", s.anthropicKey.trim());
      if (s.mailchimpKey && s.mailchimpKey.trim())
        await setSetting(pool, "mailchimp_api_key", s.mailchimpKey.trim());
      if (s.mailchimpServer && s.mailchimpServer.trim())
        await setSetting(pool, "mailchimp_server", s.mailchimpServer.trim());
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}
```

- [ ] **Step 5: Register routes in `index.ts` and run the test (now passing)**

Add `import { settingsRoutes } from "./routes/settings";` and `app.register(settingsRoutes);` (after `meRoutes`).

Then build the image once and run the test in a throwaway container on the network:
```bash
SP_PASS=$(grep '^SOCIALPOSTS_DB_PASSWORD=' .env | cut -d= -f2)
docker run --rm --network grmcapps_hubnet -v "$PWD/apps/social-posts":/work -w /work \
  -e TEST_DATABASE_URL="postgres://socialposts_user:${SP_PASS}@postgres:5432/socialposts" \
  node:20-alpine sh -c "npm install --silent && npm run build && node --test dist/settings.test.js"
rm -f apps/social-posts/package-lock.json
```
Expected: the test passes (`tests 1 ... pass 1`).

- [ ] **Step 6: Rebuild the container and verify the live endpoints**

```bash
docker compose up -d --build social-posts; sleep 4
docker compose exec -T social-posts wget -qO- --post-data='{"anthropicKey":"sk-ant-LIVE-xyz","mailchimpServer":"us21"}' --header="Content-Type: application/json" http://localhost:3000/api/settings; echo
docker compose exec -T social-posts wget -qO- http://localhost:3000/api/settings; echo
```
Expected: first returns `{"ok":true}`; second returns a view with `"hasAnthropicKey":true`, `"anthropicKeyHint":"sk-ant-LI..."`, `"mailchimpServer":"us21"`, and NO full key.

- [ ] **Step 7: Commit**

```bash
git add apps/social-posts/src/settings.ts apps/social-posts/src/settings.test.ts apps/social-posts/src/routes/settings.ts apps/social-posts/src/index.ts
git commit -m "feat: DB-backed settings module and endpoints"
```

---

### Task 5: Voice constants + Claude module (with fence-stripper test)

**Files:**
- Create: `apps/social-posts/src/voice.ts`, `apps/social-posts/src/claude.ts`, `apps/social-posts/src/claude.test.ts`

- [ ] **Step 1: `apps/social-posts/src/voice.ts`**

Port the `VOICE` string and the `HISTORY_SERIES_POSTS` array **verbatim** from `docs/reference/social-posts/Code.gs` (the `var VOICE = ...` and `var HISTORY_SERIES_POSTS = [...]` blocks), as TypeScript exports:
```typescript
export const VOICE = "GRMC voice rules: short, punchy, warm but not stiff. Salutations ('Family of Grace', 'Hey everyone') should be used sparingly, and rarely on content for both members and guests. Salutations are acceptible on posts that are more towards members. Open as an invitation, not insider communication. 2-4 sentences, line breaks between thoughts. No hashtags unless natural. Sentence case. No em-dashes as decoration.";

export interface HistoryPost { date: string; phase: string; title: string; sub: string; }

export const HISTORY_SERIES_POSTS: HistoryPost[] = [
  // ... copy all 13 entries verbatim from Code.gs HISTORY_SERIES_POSTS ...
];
```
(Copy all 13 objects exactly — date/phase/title/sub — from the reference file.)

- [ ] **Step 2: Write the failing test `apps/social-posts/src/claude.test.ts`** (pure logic, no network)

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { stripJsonFences } from "./claude";

test("stripJsonFences removes markdown code fences", () => {
  assert.equal(stripJsonFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFences('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFences('  {"a":1}  '), '{"a":1}');
});
```

- [ ] **Step 3: Run it — expect FAIL** (`Cannot find module './claude'`). Command pattern as in Task 5 Step 5.

- [ ] **Step 4: Implement `apps/social-posts/src/claude.ts`**

Ports `callClaude` from `Code.gs` (UrlFetchApp → fetch, key from settings table). The fence-stripping (`.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim()`) becomes a named, tested helper.
```typescript
import { Pool } from "pg";
import { getSetting } from "./settings";

export function stripJsonFences(raw: string): string {
  return raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
}

export async function callClaude(
  pool: Pool,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const key = await getSetting(pool, "anthropic_api_key");
  if (!key) throw new Error("No Anthropic API key. Go to Settings to add it.");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  const data: any = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.content[0].text as string;
}
```

- [ ] **Step 5: Run the test — expect PASS**

```bash
docker run --rm -v "$PWD/apps/social-posts":/work -w /work \
  node:20-alpine sh -c "npm install --silent && npm run build && node --test dist/claude.test.js"
rm -f apps/social-posts/package-lock.json
```
Expected: `pass 1`.

- [ ] **Step 6: Commit**

```bash
git add apps/social-posts/src/voice.ts apps/social-posts/src/claude.ts apps/social-posts/src/claude.test.ts
git commit -m "feat: voice constants and Claude API module with tested fence stripper"
```

---

### Task 6: Mailchimp module (with content-cleaning test) + endpoints

**Files:**
- Create: `apps/social-posts/src/mailchimp.ts`, `apps/social-posts/src/mailchimp.test.ts`, `apps/social-posts/src/routes/mailchimp.ts`
- Modify: `apps/social-posts/src/index.ts`

Ports `getMailchimpAuth`, `getLatestGraceNotes`, `getLatestBlog`, `fetchGraceNotes`, `fetchBlog` from `Code.gs`. The boilerplate/footer stripping (identical in both campaign fetchers) is extracted into one tested `cleanCampaignText`.

- [ ] **Step 1: Write the failing test `apps/social-posts/src/mailchimp.test.ts`** (pure logic)

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cleanCampaignText } from "./mailchimp";

test("cleanCampaignText strips header rule and footer", () => {
  const raw = [
    "View this email in your browser",
    "GRMC logo",
    "--------------------------------",
    "Real paragraph one.",
    "Real paragraph two.",
    "",
    "Unsubscribe from this list",
    "Copyright © 2026 GRMC",
  ].join("\n");
  const out = cleanCampaignText(raw);
  assert.ok(out.startsWith("Real paragraph one."), "header before ---- removed");
  assert.ok(!out.includes("Unsubscribe"), "footer removed");
  assert.ok(!out.includes("logo"), "pre-rule header removed");
});

test("cleanCampaignText leaves clean text untouched", () => {
  assert.equal(cleanCampaignText("Just a sentence."), "Just a sentence.");
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing).

- [ ] **Step 3: Implement `apps/social-posts/src/mailchimp.ts`**

Port `getMailchimpAuth`/`getLatestGraceNotes`/`getLatestBlog` from `Code.gs` using `fetch`, with the cleaning logic factored out. Keep behavior identical (subject filters `grace notes`/`weekly blog`, skip `resend`, the `before`-date selection, `preview` = first 4000 chars).

```typescript
import { Pool } from "pg";
import { getSetting } from "./settings";

// Identical to the Code.gs header/footer stripping, factored into one function.
export function cleanCampaignText(plainText: string): string {
  let cleaned = plainText || "";
  const hrIdx = cleaned.indexOf("----");
  if (hrIdx !== -1) {
    const afterHr = cleaned.indexOf("\n", hrIdx);
    if (afterHr !== -1) cleaned = cleaned.substring(afterHr + 1).trim();
  }
  const footerMarkers = ["*|IF:REWARDS|*", "Unsubscribe", "unsubscribe", "*|UNSUB|*", "Copyright ©"];
  for (const marker of footerMarkers) {
    const fIdx = cleaned.indexOf(marker);
    if (fIdx !== -1 && fIdx > cleaned.length * 0.5) {
      cleaned = cleaned.substring(0, fIdx).trim();
      break;
    }
  }
  return cleaned;
}

interface MailchimpAuth { base: string; headers: Record<string, string>; }

async function getMailchimpAuth(pool: Pool): Promise<MailchimpAuth> {
  const key = await getSetting(pool, "mailchimp_api_key");
  const server = await getSetting(pool, "mailchimp_server");
  if (!key || !server) throw new Error("Mailchimp credentials not configured. Go to Settings.");
  return {
    base: `https://${server}.api.mailchimp.com/3.0`,
    headers: { Authorization: "Basic " + Buffer.from("anystring:" + key).toString("base64") },
  };
}

export interface CampaignContent {
  subject: string;
  archiveUrl: string;
  status: string;
  sentAt: string;
  preview: string;
}

async function getLatestCampaign(
  pool: Pool,
  subjectMatch: string,
  beforeDate: string | null
): Promise<CampaignContent> {
  const mc = await getMailchimpAuth(pool);
  const listUrl =
    mc.base +
    "/campaigns?count=30&sort_field=create_time&sort_dir=DESC" +
    "&fields=campaigns.id,campaigns.status,campaigns.settings.subject_line,campaigns.archive_url,campaigns.send_time,campaigns.create_time";
  const listRes: any = await (await fetch(listUrl, { headers: mc.headers })).json();
  const campaigns: any[] = listRes.campaigns || [];
  const matches = campaigns.filter((c) => {
    const subj = (c.settings?.subject_line || "").toLowerCase();
    return subj.indexOf(subjectMatch) !== -1 && subj.indexOf("resend") === -1;
  });
  if (!matches.length) throw new Error(`No ${subjectMatch} campaigns found in Mailchimp.`);

  let target = matches[0];
  if (beforeDate) {
    const cutoff = new Date(beforeDate + "T23:59:59");
    for (const c of matches) {
      if (new Date(c.create_time) <= cutoff) { target = c; break; }
    }
  }

  const contentRes: any = await (
    await fetch(mc.base + "/campaigns/" + target.id + "/content?fields=plain_text", { headers: mc.headers })
  ).json();
  const cleaned = cleanCampaignText(contentRes.plain_text || "");

  return {
    subject: target.settings.subject_line,
    archiveUrl: target.archive_url || "",
    status: target.status,
    sentAt: target.send_time || target.create_time,
    preview: cleaned.substring(0, 4000),
  };
}

export function getLatestGraceNotes(pool: Pool, beforeDate: string | null): Promise<CampaignContent> {
  return getLatestCampaign(pool, "grace notes", beforeDate);
}

export function getLatestBlog(pool: Pool): Promise<CampaignContent> {
  return getLatestCampaign(pool, "weekly blog", null);
}
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
docker run --rm -v "$PWD/apps/social-posts":/work -w /work \
  node:20-alpine sh -c "npm install --silent && npm run build && node --test dist/mailchimp.test.js"
rm -f apps/social-posts/package-lock.json
```
Expected: `pass 2`.

- [ ] **Step 5: Implement `apps/social-posts/src/routes/mailchimp.ts`**

Ports `fetchGraceNotes`/`fetchBlog` (preview endpoints).
```typescript
import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getLatestGraceNotes, getLatestBlog } from "../mailchimp";

export async function mailchimpRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/grace-notes", async (req) => {
    try {
      const sundayDate = (req.query as { sundayDate?: string }).sundayDate || null;
      const gn = await getLatestGraceNotes(pool, sundayDate);
      return { ok: true, subject: gn.subject, archiveUrl: gn.archiveUrl, status: gn.status, sentAt: gn.sentAt, preview: gn.preview };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.get("/api/blog", async () => {
    try {
      const blog = await getLatestBlog(pool);
      return { ok: true, subject: blog.subject, archiveUrl: blog.archiveUrl, status: blog.status, sentAt: blog.sentAt, preview: blog.preview };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}
```
Register in `index.ts`: `import { mailchimpRoutes } from "./routes/mailchimp";` + `app.register(mailchimpRoutes);`.

- [ ] **Step 6: Rebuild and verify the endpoint returns a clean `{ok:false}` when Mailchimp isn't configured**

```bash
docker compose up -d --build social-posts; sleep 4
docker compose exec -T social-posts wget -qO- http://localhost:3000/api/grace-notes; echo
```
Expected: `{"ok":false,"error":"Mailchimp credentials not configured. Go to Settings."}` (graceful — no crash). (Real fetching is verified manually once Mailchimp creds are entered.)

- [ ] **Step 7: Commit**

```bash
git add apps/social-posts/src/mailchimp.ts apps/social-posts/src/mailchimp.test.ts apps/social-posts/src/routes/mailchimp.ts apps/social-posts/src/index.ts
git commit -m "feat: mailchimp module with tested content cleaning and preview endpoints"
```

---

### Task 7: Series data access, seed, Thursday matcher (with tests) + read endpoints

**Files:**
- Create: `apps/social-posts/src/series.ts`, `apps/social-posts/src/series.test.ts`, `apps/social-posts/src/routes/series.ts`
- Modify: `apps/social-posts/src/index.ts`

Ports the Series data layer from `Code.gs`: `getAllSeries` (seed history if empty), `getSeriesPosts`, `createSeries`, `updateSeriesPostField`, `updateSeriesMeta`, `seedHistorySeries`, `getActiveSeriesThursdayItem`. (The two Claude-calling series fns come in Task 8.)

- [ ] **Step 1: Write the failing test `apps/social-posts/src/series.test.ts`**

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import {
  getAllSeries, getSeriesPosts, createSeries,
  updateSeriesPostField, updateSeriesMeta, getActiveSeriesThursdayItem,
} from "./series";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

test("series CRUD, history seed, and thursday matcher", async () => {
  await pool.query("DELETE FROM series_posts");
  await pool.query("DELETE FROM series");

  // getAllSeries seeds the History series when empty
  const seeded = await getAllSeries(pool);
  assert.equal(seeded.ok, true);
  assert.ok(seeded.series.some((s) => s.id === "series-history"), "history seeded");
  const histPosts = await getSeriesPosts(pool, "series-history");
  assert.equal(histPosts.posts.length, 13, "history has 13 posts");
  assert.equal(histPosts.posts[0].postIdx, 0);

  // createSeries with posts
  const created = await createSeries(pool, {
    name: "Test Series", description: "d", context: "c", cadence: "weekly",
    posts: [{ date: "Jun 9", phase: "P1", title: "T0", sub: "s0" }, { date: "Jun 16", phase: "", title: "T1", sub: "s1" }],
  });
  assert.equal(created.ok, true);
  const posts = await getSeriesPosts(pool, created.id);
  assert.equal(posts.posts.length, 2);
  assert.equal(posts.posts[1].title, "T1");

  // update a post field and series meta
  await updateSeriesPostField(pool, created.id, 0, "status", "drafted");
  await updateSeriesMeta(pool, created.id, { status: "paused" });
  const after = await getSeriesPosts(pool, created.id);
  assert.equal(after.posts[0].status, "drafted");
  const all = await getAllSeries(pool);
  assert.equal(all.series.find((s) => s.id === created.id)!.status, "paused");

  // thursday matcher: nearest non-posted dated post in an ACTIVE series to a ref date
  const thu = getActiveSeriesThursdayItem
    ? await getActiveSeriesThursdayItem(pool, "2026-06-10")
    : null;
  assert.ok(thu && thu.title.length > 0, "matcher returns a candidate from an active series");

  await pool.query("DELETE FROM series_posts");
  await pool.query("DELETE FROM series");
  await pool.end();
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing).

- [ ] **Step 3: Implement `apps/social-posts/src/series.ts`**

Port faithfully from `Code.gs` (sheet ops → SQL). Signatures (all take `pool` first):
```typescript
import { Pool } from "pg";
import { HISTORY_SERIES_POSTS } from "./voice";

export interface SeriesRow {
  id: string; name: string; description: string; context: string;
  cadence: string; status: string; createdAt: string;
}
export interface SeriesPost {
  seriesId: string; postIdx: number; date: string; phase: string;
  title: string; sub: string; status: string; draft: string; notes: string;
}
export interface ThursdayItem {
  seriesId: string; seriesName: string; context: string; postIdx: number;
  total: number; date: string; title: string; sub: string; phase: string;
}

const FIELD_COLUMNS: Record<string, string> = {
  date: "date", phase: "phase", title: "title", sub: "sub",
  status: "status", draft: "draft", notes: "notes",
};
const META_COLUMNS: Record<string, string> = {
  name: "name", description: "description", context: "context",
  cadence: "cadence", status: "status",
};

export async function seedHistorySeries(pool: Pool): Promise<void> {
  const id = "series-history";
  await pool.query(
    `INSERT INTO series (id, name, description, context, cadence, status)
     VALUES ($1,$2,$3,$4,'weekly','active') ON CONFLICT (id) DO NOTHING`,
    [
      id, "History of GRMC",
      "13-week series on the founding, present, and future of Grace Resurrection",
      "Founded in 2022 in East Cobb/Marietta by Rev. Dr. Randy Mickler, Rev. Charlie Marus, Rev. Dr. Ted Sauter - experienced ministers who came out of retirement. 1200 Indian Hills Pkwy, Marietta GA. Senior Pastor Rev. James Williams joined Oct 2024; Associate Pastor Rev. Taylor Bacon joined Nov 2025.",
    ]
  );
  for (let i = 0; i < HISTORY_SERIES_POSTS.length; i++) {
    const p = HISTORY_SERIES_POSTS[i];
    await pool.query(
      `INSERT INTO series_posts (series_id, post_idx, date, phase, title, sub, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT (series_id, post_idx) DO NOTHING`,
      [id, i, p.date, p.phase, p.title, p.sub]
    );
  }
}

export async function getAllSeries(pool: Pool): Promise<{ ok: true; series: SeriesRow[] } | { ok: false; error: string }> {
  try {
    let r = await pool.query("SELECT * FROM series");
    if (r.rows.length === 0) { await seedHistorySeries(pool); r = await pool.query("SELECT * FROM series"); }
    const series = r.rows.map((row) => ({
      id: row.id, name: row.name, description: row.description, context: row.context,
      cadence: row.cadence, status: row.status, createdAt: String(row.created_at),
    }));
    return { ok: true, series };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function getSeriesPosts(pool: Pool, seriesId: string): Promise<{ ok: true; posts: SeriesPost[] } | { ok: false; error: string }> {
  try {
    const r = await pool.query("SELECT * FROM series_posts WHERE series_id = $1 ORDER BY post_idx", [seriesId]);
    const posts = r.rows.map((row) => ({
      seriesId: row.series_id, postIdx: Number(row.post_idx), date: row.date, phase: row.phase,
      title: row.title, sub: row.sub, status: row.status, draft: row.draft, notes: row.notes,
    }));
    return { ok: true, posts };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export interface CreateSeriesParams {
  name: string; description?: string; context?: string; cadence?: string;
  posts?: Array<{ date?: string; phase?: string; title: string; sub?: string }>;
}
export async function createSeries(pool: Pool, params: CreateSeriesParams): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const id = "series-" + Date.now();
    await pool.query(
      `INSERT INTO series (id, name, description, context, cadence, status)
       VALUES ($1,$2,$3,$4,$5,'active')`,
      [id, params.name, params.description || "", params.context || "", params.cadence || "weekly"]
    );
    const posts = params.posts || [];
    for (let i = 0; i < posts.length; i++) {
      const p = posts[i];
      await pool.query(
        `INSERT INTO series_posts (series_id, post_idx, date, phase, title, sub, status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
        [id, i, p.date || "", p.phase || "", p.title, p.sub || ""]
      );
    }
    return { ok: true, id };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function updateSeriesPostField(pool: Pool, seriesId: string, postIdx: number, field: string, value: string): Promise<{ ok: boolean; error?: string }> {
  const col = FIELD_COLUMNS[field];
  if (!col) return { ok: false, error: "Unknown field: " + field };
  try {
    const r = await pool.query(
      `UPDATE series_posts SET ${col} = $1 WHERE series_id = $2 AND post_idx = $3`,
      [value, seriesId, postIdx]
    );
    if (r.rowCount === 0) return { ok: false, error: "Post not found" };
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function updateSeriesMeta(pool: Pool, seriesId: string, fields: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  try {
    const sets: string[] = [];
    const vals: string[] = [];
    Object.keys(fields).forEach((f) => {
      const col = META_COLUMNS[f];
      if (col) { vals.push(fields[f]); sets.push(`${col} = $${vals.length}`); }
    });
    if (!sets.length) return { ok: true };
    vals.push(seriesId);
    const r = await pool.query(`UPDATE series SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    if (r.rowCount === 0) return { ok: false, error: "Series not found" };
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// Port of getActiveSeriesThursdayItem: nearest non-posted dated post (by 'Mon DD')
// across ACTIVE series to a reference date.
export async function getActiveSeriesThursdayItem(pool: Pool, dateStr?: string): Promise<ThursdayItem | null> {
  try {
    const ref = dateStr ? new Date(dateStr + "T12:00:00") : new Date();
    const year = ref.getFullYear();
    const months: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const all = await getAllSeries(pool);
    if (!all.ok) return null;
    const active = all.series.filter((s) => s.status === "active");
    let best: ThursdayItem | null = null;
    let minDiff = Infinity;
    for (const s of active) {
      const pr = await getSeriesPosts(pool, s.id);
      if (!pr.ok) continue;
      for (const p of pr.posts) {
        if (p.status === "posted") continue;
        const parts = p.date.split(" ");
        if (parts.length < 2 || !(parts[0] in months)) continue;
        const d = new Date(year, months[parts[0]], parseInt(parts[1], 10), 12);
        const diff = Math.abs(ref.getTime() - d.getTime());
        if (diff < minDiff) {
          minDiff = diff;
          best = {
            seriesId: s.id, seriesName: s.name, context: s.context, postIdx: p.postIdx,
            total: pr.posts.length, date: p.date, title: p.title, sub: p.sub, phase: p.phase,
          };
        }
      }
    }
    return best;
  } catch { return null; }
}
```

- [ ] **Step 4: Run the test — expect PASS** (DB test on the network)

```bash
SP_PASS=$(grep '^SOCIALPOSTS_DB_PASSWORD=' .env | cut -d= -f2)
docker run --rm --network grmcapps_hubnet -v "$PWD/apps/social-posts":/work -w /work \
  -e TEST_DATABASE_URL="postgres://socialposts_user:${SP_PASS}@postgres:5432/socialposts" \
  node:20-alpine sh -c "npm install --silent && npm run build && node --test dist/series.test.js"
rm -f apps/social-posts/package-lock.json
```
Expected: `pass 1`.

- [ ] **Step 5: Implement read/update routes `apps/social-posts/src/routes/series.ts`**

(The draft/plan POST routes are added in Task 8 — this step adds GET list/posts, POST create, PATCH post field, PATCH series meta.)
```typescript
import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getAllSeries, getSeriesPosts, createSeries, updateSeriesPostField, updateSeriesMeta } from "../series";

export async function seriesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/series", async () => getAllSeries(pool));

  app.get("/api/series/:id/posts", async (req) => {
    const { id } = req.params as { id: string };
    return getSeriesPosts(pool, id);
  });

  app.post("/api/series", async (req) => {
    return createSeries(pool, (req.body ?? {}) as any);
  });

  app.patch("/api/series/:id/posts/:idx", async (req) => {
    const { id, idx } = req.params as { id: string; idx: string };
    const { field, value } = (req.body ?? {}) as { field: string; value: string };
    return updateSeriesPostField(pool, id, Number(idx), field, value);
  });

  app.patch("/api/series/:id", async (req) => {
    const { id } = req.params as { id: string };
    return updateSeriesMeta(pool, id, (req.body ?? {}) as Record<string, string>);
  });
}
```
Register in `index.ts`: `import { seriesRoutes } from "./routes/series";` + `app.register(seriesRoutes);`.

- [ ] **Step 6: Rebuild and verify live**

```bash
docker compose up -d --build social-posts; sleep 4
docker compose exec -T social-posts wget -qO- http://localhost:3000/api/series | head -c 300; echo
```
Expected: `{"ok":true,"series":[...]}` including the seeded `series-history`.

- [ ] **Step 7: Commit**

```bash
git add apps/social-posts/src/series.ts apps/social-posts/src/series.test.ts apps/social-posts/src/routes/series.ts apps/social-posts/src/index.ts
git commit -m "feat: series data layer, history seed, thursday matcher, and series endpoints"
```

---

### Task 8: Claude-powered series drafting (draft post + generate plan)

**Files:**
- Modify: `apps/social-posts/src/series.ts` (add `draftSeriesPost`, `generateSeriesPostsWithClaude`), `apps/social-posts/src/routes/series.ts`

Ports `draftSeriesPost` and `generateSeriesPostsWithClaude` from `Code.gs`. Port the prompt-building (`lines`) **verbatim** from the reference, swapping `callClaude(sys, ...)` for `await callClaude(pool, sys, ...)` and `JSON.parse(stripJsonFences(raw))`.

- [ ] **Step 1: Add `draftSeriesPost` to `series.ts`**

```typescript
import { callClaude, stripJsonFences } from "./claude";
import { VOICE } from "./voice";

export async function draftSeriesPost(pool: Pool, seriesId: string, postIdx: number): Promise<{ ok: true; post: string; seriesName: string } | { ok: false; error: string }> {
  try {
    const all = await getAllSeries(pool);
    if (!all.ok) throw new Error(all.error);
    const series = all.series.find((s) => s.id === seriesId);
    if (!series) throw new Error("Series not found: " + seriesId);

    const pr = await getSeriesPosts(pool, seriesId);
    if (!pr.ok) throw new Error(pr.error);
    const post = pr.posts.find((p) => p.postIdx === postIdx);
    if (!post) throw new Error("Post not found");

    const lines = [
      `Draft a GRMC social media post for the "${series.name}" series.`, "", VOICE, "",
      "SERIES NAME: " + series.name,
      "SERIES DESCRIPTION: " + series.description,
      "SERIES CONTEXT: " + series.context,
      "", "THIS POST: " + (postIdx + 1) + " of " + pr.posts.length,
      "SCHEDULED DATE: " + (post.date || "TBD"),
      "TITLE: " + post.title,
      "ANGLE: " + (post.sub || ""),
    ];
    if (post.phase) lines.push("PHASE: " + post.phase);
    lines.push("", "Write it as the next chapter in an unfolding story, not a standalone fact post.");
    lines.push("Tone: educational but not lecture-y, warm, inviting, makes people want to follow along.");

    const sys = 'You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. Return ONLY a JSON object with key "post" containing the post text string. No markdown fences, just valid JSON.';
    const raw = stripJsonFences(await callClaude(pool, sys, lines.join("\n")));
    const result = JSON.parse(raw);
    await updateSeriesPostField(pool, seriesId, postIdx, "status", "drafted");
    await updateSeriesPostField(pool, seriesId, postIdx, "draft", result.post);
    return { ok: true, post: result.post, seriesName: series.name };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
```

- [ ] **Step 2: Add `generateSeriesPostsWithClaude` to `series.ts`**

```typescript
export interface GeneratePlanParams {
  name: string; description?: string; context?: string;
  count: number; cadence?: string; startDate?: string;
}
export async function generateSeriesPostsWithClaude(pool: Pool, params: GeneratePlanParams): Promise<{ ok: true; posts: any[] } | { ok: false; error: string }> {
  try {
    const lines = [
      `Generate a post schedule for a social media series called "${params.name}".`,
      "Description: " + params.description,
      "Context: " + params.context,
      "Number of posts: " + params.count,
      "Cadence: " + (params.cadence || "weekly"),
      "Start date: " + (params.startDate || "TBD"),
      "",
      "Return ONLY a JSON array of objects, each with: date (string), phase (string, group label or empty), title (short post title), sub (angle/description for this post, 1-2 sentences).",
      "Plan the arc: build toward a conclusion, group into 2-3 phases if it makes sense.",
      "No markdown fences, just valid JSON array.",
    ];
    const sys = "You are a social media content strategist for Grace Resurrection Methodist Church (GRMC) in Marietta, GA.";
    const raw = stripJsonFences(await callClaude(pool, sys, lines.join("\n")));
    return { ok: true, posts: JSON.parse(raw) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
```

- [ ] **Step 3: Add the two POST routes to `routes/series.ts`**

Add inside `seriesRoutes`:
```typescript
  app.post("/api/series/plan", async (req) => {
    return generateSeriesPostsWithClaude(pool, (req.body ?? {}) as any);
  });

  app.post("/api/series/:id/posts/:idx/draft", async (req) => {
    const { id, idx } = req.params as { id: string; idx: string };
    return draftSeriesPost(pool, id, Number(idx));
  });
```
Add the imports: `import { ..., draftSeriesPost, generateSeriesPostsWithClaude } from "../series";`.

- [ ] **Step 4: Rebuild and verify the routes exist and fail gracefully without a Claude key**

```bash
docker compose up -d --build social-posts; sleep 4
docker compose exec -T social-posts wget -qO- --post-data='{"name":"X","count":3}' --header="Content-Type: application/json" http://localhost:3000/api/series/plan; echo
```
Expected: `{"ok":false,"error":"No Anthropic API key. Go to Settings to add it."}` (proves wiring; real generation verified manually with a key).

- [ ] **Step 5: Commit**

```bash
git add apps/social-posts/src/series.ts apps/social-posts/src/routes/series.ts
git commit -m "feat: claude-powered series post drafting and plan generation"
```

---

### Task 9: Drafts store + Monday/Wednesday/Friday runs

**Files:**
- Create: `apps/social-posts/src/drafts.ts`, `apps/social-posts/src/runs.ts`, `apps/social-posts/src/routes/drafts.ts`
- Modify: `apps/social-posts/src/index.ts`

Ports `savePostDrafts`/`getRecentDrafts` and `draftMondayPosts`/`draftWedPosts`/`draftFridayPost`. The prompt-building `lines` arrays are ported **verbatim** from `docs/reference/social-posts/Code.gs`.

- [ ] **Step 1: `apps/social-posts/src/drafts.ts`**

`savePostDrafts` now also records `created_by`.
```typescript
import { Pool } from "pg";

export async function savePostDrafts(
  pool: Pool, run: string, postDate: string, posts: Record<string, string>, createdBy: string
): Promise<void> {
  for (const key of Object.keys(posts)) {
    await pool.query(
      `INSERT INTO post_drafts (run, post_date, key, text, status, created_by)
       VALUES ($1,$2,$3,$4,'draft',$5)`,
      [run, postDate, key, posts[key], createdBy]
    );
  }
}

export interface DraftRow {
  dateDrafted: string; run: string; postDate: string; key: string; text: string; status: string; createdBy: string;
}
export async function getRecentDrafts(pool: Pool): Promise<{ ok: true; rows: DraftRow[] } | { ok: false; error: string }> {
  try {
    const r = await pool.query("SELECT * FROM post_drafts ORDER BY id DESC LIMIT 20");
    const rows = r.rows.map((row) => ({
      dateDrafted: String(row.created_at), run: row.run, postDate: row.post_date,
      key: row.key, text: row.text, status: row.status, createdBy: row.created_by,
    }));
    return { ok: true, rows };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
```

- [ ] **Step 2: `apps/social-posts/src/runs.ts`**

Port `draftMondayPosts`, `draftWedPosts`, `draftFridayPost` verbatim from `Code.gs`. Each takes `(pool, params, createdBy)`. Use `await getActiveSeriesThursdayItem(pool, params.date)`, `await getLatestGraceNotes(pool, ...)`, `await getLatestBlog(pool)`, `stripJsonFences(await callClaude(pool, sys, lines.join("\n")))`, `await savePostDrafts(pool, run, date, posts, createdBy)`, and `await updateSeriesPostField(...)`. Keep the exact `lines`/`sys` strings and the exact returned fields (`mailchimpFetched`, `mailchimpError`, `archiveUrl`, `subject`, `sentAt`, `seriesLabel`). Skeleton:

```typescript
import { Pool } from "pg";
import { VOICE } from "./voice";
import { callClaude, stripJsonFences } from "./claude";
import { getActiveSeriesThursdayItem, updateSeriesPostField } from "./series";
import { getLatestGraceNotes, getLatestBlog } from "./mailchimp";
import { savePostDrafts } from "./drafts";

export async function draftMondayPosts(pool: Pool, params: any, createdBy: string) {
  try {
    const thu = await getActiveSeriesThursdayItem(pool, params.date);
    const lines: string[] = ["Draft three GRMC social posts.", "", VOICE, "", "--- CONTEXT ---",
      "SUNDAY DATE: " + (params.date || "this past Sunday"), "SERMON TITLE: " + params.sermon];
    if (params.pulpit)     { lines.push("", "PULPIT AI SUMMARY:", params.pulpit); }
    if (params.events)     { lines.push("", "UPCOMING EVENTS:", params.events); }
    if (params.highlights) { lines.push("", "PEOPLE / HIGHLIGHTS:", params.highlights); }
    if (thu) {
      lines.push("", "THURSDAY SERIES - post " + (thu.postIdx + 1) + " of " + thu.total + " (" + thu.date + ') from series "' + thu.seriesName + '":');
      lines.push(thu.title + " - " + thu.sub);
    }
    lines.push("", "--- POSTS TO DRAFT ---", "",
      "1. MONDAY - Service recap", "Celebratory, invites people who missed to feel the energy. Reference sermon theme meaningfully.",
      "", "2. TUESDAY - Upcoming events", "Highlight 1-2 events max. Clear CTA with date/time/location.");
    if (thu) {
      lines.push("", "3. THURSDAY - " + thu.seriesName + " series post (" + thu.date + ")",
        "Topic: " + thu.title + ". Angle: " + thu.sub,
        "Educational but not lecture-y. Next chapter in an unfolding story. Series context: " + thu.context);
    } else {
      lines.push("", "3. THURSDAY - no active series post scheduled for this week. Write a general GRMC community post.");
    }
    const sys = 'You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. Return ONLY a JSON object with keys "monday", "tuesday", "thursday" each a string. No markdown fences, just valid JSON.';
    const posts = JSON.parse(stripJsonFences(await callClaude(pool, sys, lines.join("\n"))));
    await savePostDrafts(pool, "monday", params.date || "", posts, createdBy);
    if (thu) await updateSeriesPostField(pool, thu.seriesId, thu.postIdx, "status", "drafted");
    return { ok: true, posts, seriesLabel: thu ? "Post " + (thu.postIdx + 1) + " of " + thu.total + ": " + thu.title : "" };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// draftWedPosts and draftFridayPost: port the bodies verbatim from Code.gs the
// same way (mailchimp fetch in try/catch → mailchimpError, fallback to manual
// params.manualUrl/params.content, save drafts, return the same fields).
```
Port `draftWedPosts` and `draftFridayPost` completing the file, matching `Code.gs` exactly (including the `mailchimpFetched`/`mailchimpError`/`archiveUrl`/`subject`/`sentAt` return fields and the manual-input fallbacks).

- [ ] **Step 3: `apps/social-posts/src/routes/drafts.ts`**

```typescript
import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { getRecentDrafts } from "../drafts";
import { draftMondayPosts, draftWedPosts, draftFridayPost } from "../runs";

export async function draftsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/drafts", async () => getRecentDrafts(pool));

  app.post("/api/draft/monday", async (req) =>
    draftMondayPosts(pool, (req.body ?? {}) as any, getIdentity(req).email));

  app.post("/api/draft/wednesday", async (req) =>
    draftWedPosts(pool, (req.body ?? {}) as any, getIdentity(req).email));

  app.post("/api/draft/friday", async (req) =>
    draftFridayPost(pool, (req.body ?? {}) as any, getIdentity(req).email));
}
```
Register in `index.ts`: `import { draftsRoutes } from "./routes/drafts";` + `app.register(draftsRoutes);`.

- [ ] **Step 4: Rebuild and verify wiring (graceful no-key error + empty drafts list)**

```bash
docker compose up -d --build social-posts; sleep 4
docker compose exec -T social-posts wget -qO- http://localhost:3000/api/drafts; echo
docker compose exec -T social-posts wget -qO- --post-data='{"sermon":"Test"}' --header="Content-Type: application/json" http://localhost:3000/api/draft/monday; echo
```
Expected: `/api/drafts` → `{"ok":true,"rows":[]}`; monday draft → `{"ok":false,"error":"No Anthropic API key. Go to Settings to add it."}`.

- [ ] **Step 5: Commit**

```bash
git add apps/social-posts/src/drafts.ts apps/social-posts/src/runs.ts apps/social-posts/src/routes/drafts.ts apps/social-posts/src/index.ts
git commit -m "feat: drafts store and Monday/Wednesday/Friday draft runs"
```

---

### Task 10: Frontend (ported UI + fetch-based JS)

**Files:**
- Replace: `apps/social-posts/src/public/index.html`
- Create: `apps/social-posts/src/public/app.js`

- [ ] **Step 1: Port `index.html`**

Copy `docs/reference/social-posts/index.html` to `apps/social-posts/src/public/index.html` with these edits:
1. Remove the entire inline `<script>...</script>` block (its logic moves to `app.js`).
2. Before `</body>`, add: `<script src="/app.js"></script>`.
3. Keep ALL the HTML structure, CSS, and element ids/onclick attributes exactly as-is (the onclick handlers are defined in `app.js`).

- [ ] **Step 2: Create `apps/social-posts/src/public/app.js` from the reference inline script**

Start from the inline `<script>` in `docs/reference/social-posts/index.html` and apply exactly these transformations:

(a) Add the API helper at the top:
```javascript
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error('Request failed: ' + res.status);
  return res.json();
}
```

(b) Replace every `google.script.run.withSuccessHandler(cb).withFailureHandler(fb).FN(args)` call with the matching `api(...)` call, mapping per this table (all responses already have `{ok,...}`):

| Reference call | Replace with |
|---|---|
| `.getSettings()` | `api('/api/settings')` |
| `.saveSettings(obj)` | `api('/api/settings', {method:'POST', body:obj})` |
| `.draftMondayPosts(obj)` | `api('/api/draft/monday', {method:'POST', body:obj})` |
| `.draftWedPosts(obj)` | `api('/api/draft/wednesday', {method:'POST', body:obj})` |
| `.draftFridayPost(obj)` | `api('/api/draft/friday', {method:'POST', body:obj})` |
| `.fetchGraceNotes(sunday)` | `api('/api/grace-notes' + (sunday ? '?sundayDate=' + encodeURIComponent(sunday) : ''))` |
| `.fetchBlog()` | `api('/api/blog')` |
| `.getAllSeries()` | `api('/api/series')` |
| `.getSeriesPosts(id)` | `api('/api/series/' + id + '/posts')` |
| `.createSeries(obj)` | `api('/api/series', {method:'POST', body:obj})` |
| `.generateSeriesPostsWithClaude(obj)` | `api('/api/series/plan', {method:'POST', body:obj})` |
| `.draftSeriesPost(id, idx)` | `api('/api/series/' + id + '/posts/' + idx + '/draft', {method:'POST'})` |
| `.updateSeriesPostField(id, idx, field, value)` | `api('/api/series/' + id + '/posts/' + idx, {method:'PATCH', body:{field, value}})` |
| `.updateSeriesMeta(id, fields)` | `api('/api/series/' + id, {method:'PATCH', body:fields})` |
| `.getRecentDrafts()` | `api('/api/drafts')` |

Conversion rule for each call site: `google.script.run.withSuccessHandler(SUCCESS).withFailureHandler(FAILURE).FN(ARGS)` becomes:
```javascript
api(...).then(SUCCESS).catch(FAILURE);
```
where `SUCCESS`/`FAILURE` are the same callback bodies as in the reference (the success handler receives the parsed `{ok,...}` object exactly as before; the failure handler receives an `Error`). Keep every other line (DOM updates, `setBtn`, `esc`, rendering, the init block at the bottom) unchanged.

(c) Add identity display to `checkAuthStatus` (optional nicety): after it runs, also call `api('/api/me').then(function(me){ /* could show me.email */ });` — or leave the header label as-is. Keep it minimal; do not change unrelated behavior.

- [ ] **Step 3: Rebuild and verify the UI is served with real markup + app.js**

```bash
docker compose up -d --build social-posts; sleep 4
docker compose exec -T social-posts sh -c "ls dist/public"
docker compose exec -T social-posts wget -qO- http://localhost:3000/ | grep -c "Monday run"
docker compose exec -T social-posts wget -qO- http://localhost:3000/app.js | grep -c "function api"
```
Expected: `dist/public` lists `index.html` and `app.js`; the page contains "Monday run"; `app.js` contains the `api` helper.

- [ ] **Step 4: Commit**

```bash
git add apps/social-posts/src/public/index.html apps/social-posts/src/public/app.js
git commit -m "feat: port social posts UI to fetch-based frontend"
```

---

### Task 11: End-to-end verification + docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Bring the full stack up and confirm all services**

```bash
docker compose up -d --build
docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
```
Expected: `traefik`, `postgres` (healthy), `hub`, `whoami`, `social-posts` all running.

- [ ] **Step 2: Confirm the app is gated and registered**

```bash
curl -sS -D - -o /dev/null https://app-social.lvh.me/ 2>/dev/null | grep -iE "^(HTTP|location:)"
docker compose exec -T postgres psql -U postgres -d hub -c "SELECT slug, host FROM apps ORDER BY name;"
```
Expected: gated 302 → hub login; the apps table lists `social-posts | app-social.lvh.me`.

- [ ] **Step 3: Manual browser verification (requires a real Anthropic key; Mailchimp optional)**

In the browser (after hub login):
1. Open `https://hub.lvh.me/` → the dashboard shows the **Social Posts** (📣) card → click it → the ported UI loads, authenticated.
2. **Settings tab** → paste a real Anthropic key (and Mailchimp key + server if testing fetch) → Save → header shows "API key set".
3. **Monday run** → enter a sermon title → Draft posts → three posts render and appear in the **Drafts** tab.
4. **Series tab** → the "History of GRMC" series shows 13 posts → expand → Draft one → it gets a draft + "drafted" badge → mark Posted → Notes prompt works → Pause/Resume toggles.
5. **New series** → enter name + count → Generate post plan (Claude) → edit rows → Save → it appears in the list.
6. **Wednesday/Friday** → if Mailchimp configured, Preview Grace Notes / Fetch blog pull and clean content; otherwise paste manually → drafts generate.

Record the outcome of each check. (Drafting requires the real key, so these steps are manual.)

- [ ] **Step 4: Verify drafts are stamped with the logged-in user**

```bash
docker compose exec -T postgres psql -U postgres -d socialposts -c "SELECT run, key, created_by FROM post_drafts ORDER BY id DESC LIMIT 5;"
```
Expected: rows whose `created_by` is your logged-in email.

- [ ] **Step 5: Update `README.md`** — add a "Social Posts app" subsection under the apps the hub serves:

```markdown
## Apps

- **whoami** (`app-whoami.lvh.me`) — validation app echoing identity headers.
- **Social Posts** (`app-social.lvh.me`) — drafts GRMC social posts with Claude,
  pulls Grace Notes / blog from Mailchimp, manages multi-week post series.
  Configure the Anthropic + Mailchimp keys in its Settings tab (stored in the
  `socialposts` database). Source ported from the Apps Script tool in
  `docs/reference/social-posts/`.
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document the social-posts app in the README"
```

---

## Self-review notes

- **Spec coverage:** §1 (provision DB+register: Task 1), §2/§3 (scaffold+forwardAuth: Task 2), §4 (identity+/api/me: Task 3), settings (Task 4), claude+voice (Task 5), mailchimp (Task 6), series data+seed+thursday (Task 7), series Claude fns (Task 8), drafts+runs (Task 9), frontend (Task 10), end-to-end+docs (Task 11). All spec sections map to tasks.
- **`{ok,...}` contract** preserved end to end so the ported frontend logic is a 1:1 swap of the transport layer.
- **Type/name consistency:** `pool` is the first arg to every data/claude/mailchimp fn; `getActiveSeriesThursdayItem`, `updateSeriesPostField`, `getLatestGraceNotes`, `stripJsonFences`, `cleanCampaignText`, `savePostDrafts(... createdBy)` names match across the tasks that define and call them.
- **Tests:** pure-logic (fence strip, campaign cleaning) run locally; DB-backed (settings, series) run in a throwaway container on `grmcapps_hubnet`. External Claude/Mailchimp drafting is manual (needs real keys), with every wiring path proving a graceful `{ok:false}` first.
- **No silent caps:** drafts list is capped at 20 (matches the reference's last-20 behavior) — documented in `getRecentDrafts`.
```
