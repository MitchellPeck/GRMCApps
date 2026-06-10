# Approvals App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new hub app (`apps/approvals`) for requesting and granting sign-off on uploaded graphics, with a roster-chosen approver, change-request revisions, version history, and a decision log.

**Architecture:** A drop-in clone of the `social-posts` app pattern — TypeScript + Fastify + `pg`, gated by the hub's Traefik forwardAuth (identity via `x-auth-*` headers), idempotent schema on boot, and a fetch-based static frontend. Image bytes live in Postgres `bytea`. Pure modules (`approval.ts`, `validation.ts`) hold the state-machine and upload rules and are unit-tested with no database; DB modules (`roster.ts`, `requests.ts`) follow the existing `TEST_DATABASE_URL` test pattern.

**Tech Stack:** Node 20, TypeScript, Fastify 5, `@fastify/static`, `@fastify/multipart`, `pg`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-06-10-approvals-design.md`

---

## Conventions (read before starting)

- Reference app to mirror: `apps/social-posts/`. Match its file layout, `config.ts` shape, `db.ts`/`schema.ts` boot pattern, route style (`{ ok:true, ... }` / `{ ok:false, error }`), and `identity.ts`.
- All commands run from the repo root `/Users/mitchellpeck/WebstormProjects/GRMCApps` unless noted.
- **Running tests:** the app is built with `npm run build` then tested with `npm test` (`node --test` over `dist`). Pure-logic tests need no database. DB-backed tests read `TEST_DATABASE_URL`. To run DB tests locally, point it at a throwaway Postgres database that has the app schema applied (see Task 11 "Running DB tests" note). Pure tests always run.
- Commit after every task with the messages shown. End every commit message with the `Co-Authored-By` trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

---

## File structure

```
apps/approvals/
├── Dockerfile
├── package.json
├── tsconfig.json
└── src/
    ├── config.ts          # databaseUrl from APPROVALS_DB_* env
    ├── db.ts              # pg Pool + ensureSchema()
    ├── schema.ts          # idempotent DDL (roster, requests, request_versions, request_events)
    ├── identity.ts        # x-auth-* header reader (copied from social-posts)
    ├── validation.ts      # PURE: ALLOWED_MIME, MAX_BYTES, validateUpload()
    ├── validation.test.ts # PURE tests
    ├── approval.ts        # PURE: status machine + permission checks
    ├── approval.test.ts   # PURE tests
    ├── roster.ts          # DB: roster CRUD
    ├── roster.test.ts     # DB tests
    ├── requests.ts        # DB: create/list/detail/decision/version/image
    ├── requests.test.ts   # DB tests
    ├── index.ts           # Fastify bootstrap + plugin/route registration
    ├── routes/
    │   ├── me.ts          # GET /api/me
    │   ├── roster.ts      # GET/POST /api/roster, POST /api/roster/:id
    │   └── requests.ts    # request endpoints incl. multipart + image serving
    └── public/
        ├── index.html     # tabbed UI (Inbox, My Requests, New Request, Settings)
        └── app.js         # fetch-based frontend logic
```

Hub wiring touches: `db/init/01-databases.sh`, `db/init/02-hub-schema.sql`, `docker-compose.yml`, `.env`, `.env.example`, `README.md`.

---

## Task 1: Scaffold the app skeleton (builds + healthz)

**Files:**
- Create: `apps/approvals/package.json`
- Create: `apps/approvals/tsconfig.json`
- Create: `apps/approvals/Dockerfile`
- Create: `apps/approvals/src/config.ts`
- Create: `apps/approvals/src/identity.ts`
- Create: `apps/approvals/src/schema.ts`
- Create: `apps/approvals/src/db.ts`
- Create: `apps/approvals/src/index.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "approvals",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": { "build": "tsc", "start": "node dist/index.js", "test": "node --test" },
  "dependencies": {
    "@fastify/multipart": "^9.0.1",
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

- [ ] **Step 2: Create `tsconfig.json`** (identical to social-posts)

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

- [ ] **Step 3: Create `Dockerfile`** (identical to social-posts)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && (cp -r src/public dist/public 2>/dev/null || true)
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 4: Create `src/config.ts`**

```ts
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: 3000,
  databaseUrl: `postgres://${required("APPROVALS_DB_USER")}:${required("APPROVALS_DB_PASSWORD")}@postgres:5432/${required("APPROVALS_DB_NAME")}`,
};
```

- [ ] **Step 5: Create `src/identity.ts`** (copied from social-posts)

```ts
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

- [ ] **Step 6: Create `src/schema.ts`**

```ts
// DDL run on boot (idempotent). Mirrors the design spec data model.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS roster (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  email       text UNIQUE NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
  id               bigserial PRIMARY KEY,
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  submitter_email  text NOT NULL,
  submitter_name   text NOT NULL DEFAULT '',
  approver_email   text NOT NULL,
  approver_name    text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'pending',
  current_version  integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz
);

CREATE TABLE IF NOT EXISTS request_versions (
  request_id        bigint NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  version_no        integer NOT NULL,
  file_name         text NOT NULL,
  mime_type         text NOT NULL,
  byte_size         integer NOT NULL,
  image             bytea NOT NULL,
  note              text NOT NULL DEFAULT '',
  uploaded_by_email text NOT NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, version_no)
);

CREATE TABLE IF NOT EXISTS request_events (
  id           bigserial PRIMARY KEY,
  request_id   bigint NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  version_no   integer NOT NULL,
  type         text NOT NULL,
  actor_email  text NOT NULL,
  actor_name   text NOT NULL DEFAULT '',
  comment      text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
`;
```

- [ ] **Step 7: Create `src/db.ts`** (copied from social-posts)

```ts
import { Pool } from "pg";
import { config } from "./config";
import { SCHEMA_SQL } from "./schema";

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function ensureSchema(): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
```

- [ ] **Step 8: Create `src/index.ts`** (minimal — routes added in later tasks)

```ts
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { join } from "node:path";
import { config } from "./config";
import { ensureSchema } from "./db";

const app = Fastify({ logger: true, trustProxy: true });

app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
app.register(fastifyStatic, { root: join(__dirname, "public"), prefix: "/" });

app.get("/healthz", async () => ({ ok: true }));

async function start() {
  await ensureSchema();
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`approvals listening on ${config.port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
```

- [ ] **Step 9: Install deps and verify it builds**

Run: `cd apps/approvals && npm install && npm run build`
Expected: `npm install` succeeds; `tsc` exits 0 with no errors and produces `dist/`.

- [ ] **Step 10: Commit**

```bash
git add apps/approvals/package.json apps/approvals/tsconfig.json apps/approvals/Dockerfile apps/approvals/src
git commit -m "feat: scaffold approvals app skeleton (config, schema, db, bootstrap)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Upload validation (pure, TDD)

**Files:**
- Create: `apps/approvals/src/validation.ts`
- Test: `apps/approvals/src/validation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/approvals/src/validation.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateUpload, MAX_BYTES } from "./validation";

test("accepts allowed image types within size", () => {
  assert.deepEqual(validateUpload("image/png", 1024), { ok: true });
  assert.deepEqual(validateUpload("image/jpeg", 1024), { ok: true });
  assert.deepEqual(validateUpload("application/pdf", 1024), { ok: true });
});

test("rejects disallowed types", () => {
  const r = validateUpload("text/html", 10);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /type/i);
});

test("rejects oversize files", () => {
  const r = validateUpload("image/png", MAX_BYTES + 1);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /large|size|10/i);
});

test("rejects empty files", () => {
  const r = validateUpload("image/png", 0);
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/approvals && npm run build`
Expected: FAIL — `tsc` errors that `./validation` has no exported `validateUpload`/`MAX_BYTES`.

- [ ] **Step 3: Write the implementation**

Create `apps/approvals/src/validation.ts`:

```ts
export const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateUpload(mime: string, size: number): ValidationResult {
  if (!ALLOWED_MIME.has(mime)) {
    return { ok: false, error: `Unsupported file type "${mime}". Allowed: PNG, JPG, WebP, GIF, PDF.` };
  }
  if (size <= 0) {
    return { ok: false, error: "File is empty." };
  }
  if (size > MAX_BYTES) {
    return { ok: false, error: "File is too large (max 10 MB)." };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/approvals && npm run build && npm test`
Expected: PASS — validation tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/approvals/src/validation.ts apps/approvals/src/validation.test.ts
git commit -m "feat: upload validation rules for approvals (type + size)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Approval state machine + permissions (pure, TDD)

**Files:**
- Create: `apps/approvals/src/approval.ts`
- Test: `apps/approvals/src/approval.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/approvals/src/approval.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isApprover, isSubmitter, statusAfterDecision, eventTypeForDecision,
  checkDecision, checkVersionUpload, RequestParties,
} from "./approval";

const base: RequestParties = {
  submitter_email: "sub@x.com",
  approver_email: "appr@x.com",
  status: "pending",
};

test("party checks are case-insensitive on email", () => {
  assert.equal(isApprover(base, "APPR@x.com"), true);
  assert.equal(isApprover(base, "sub@x.com"), false);
  assert.equal(isSubmitter(base, "Sub@X.com"), true);
});

test("statusAfterDecision / eventTypeForDecision map each action", () => {
  assert.equal(statusAfterDecision("approve"), "approved");
  assert.equal(statusAfterDecision("reject"), "rejected");
  assert.equal(statusAfterDecision("request_changes"), "changes_requested");
  assert.equal(eventTypeForDecision("approve"), "approved");
  assert.equal(eventTypeForDecision("request_changes"), "changes_requested");
});

test("checkDecision allows the approver on a pending request", () => {
  assert.deepEqual(checkDecision(base, "appr@x.com", "approve", ""), { ok: true });
});

test("checkDecision rejects a non-approver with 403", () => {
  const r = checkDecision(base, "sub@x.com", "approve", "");
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 403);
});

test("checkDecision rejects when not pending with 409", () => {
  const r = checkDecision({ ...base, status: "approved" }, "appr@x.com", "approve", "");
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 409);
});

test("checkDecision requires a comment for request_changes (400)", () => {
  const r = checkDecision(base, "appr@x.com", "request_changes", "   ");
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 400);
});

test("checkVersionUpload allows submitter only when changes_requested", () => {
  const cr: RequestParties = { ...base, status: "changes_requested" };
  assert.deepEqual(checkVersionUpload(cr, "sub@x.com"), { ok: true });
  assert.equal(checkVersionUpload(cr, "appr@x.com").ok, false); // not submitter -> 403
  assert.equal((checkVersionUpload(cr, "appr@x.com") as { status: number }).status, 403);
  assert.equal(checkVersionUpload(base, "sub@x.com").ok, false); // pending, not changes_requested -> 409
  assert.equal((checkVersionUpload(base, "sub@x.com") as { status: number }).status, 409);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/approvals && npm run build`
Expected: FAIL — `./approval` exports are missing.

- [ ] **Step 3: Write the implementation**

Create `apps/approvals/src/approval.ts`:

```ts
export type Status = "pending" | "approved" | "rejected" | "changes_requested";
export type DecisionAction = "approve" | "reject" | "request_changes";

export interface RequestParties {
  submitter_email: string;
  approver_email: string;
  status: Status;
}

export type CheckResult = { ok: true } | { ok: false; status: number; error: string };

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function isApprover(req: RequestParties, email: string): boolean {
  return sameEmail(req.approver_email, email);
}

export function isSubmitter(req: RequestParties, email: string): boolean {
  return sameEmail(req.submitter_email, email);
}

export function statusAfterDecision(action: DecisionAction): Status {
  if (action === "approve") return "approved";
  if (action === "reject") return "rejected";
  return "changes_requested";
}

export function eventTypeForDecision(action: DecisionAction): string {
  return statusAfterDecision(action);
}

export function checkDecision(
  req: RequestParties, email: string, action: DecisionAction, comment: string
): CheckResult {
  if (!isApprover(req, email)) {
    return { ok: false, status: 403, error: "Only the assigned approver can decide this request." };
  }
  if (req.status !== "pending") {
    return { ok: false, status: 409, error: `Request is ${req.status}; it is no longer pending.` };
  }
  if (action === "request_changes" && !comment.trim()) {
    return { ok: false, status: 400, error: "A comment is required when requesting changes." };
  }
  return { ok: true };
}

export function checkVersionUpload(req: RequestParties, email: string): CheckResult {
  if (!isSubmitter(req, email)) {
    return { ok: false, status: 403, error: "Only the submitter can upload a new version." };
  }
  if (req.status !== "changes_requested") {
    return { ok: false, status: 409, error: "New versions can only be uploaded after changes are requested." };
  }
  return { ok: true };
}

export function canView(req: RequestParties, email: string): boolean {
  return isApprover(req, email) || isSubmitter(req, email);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/approvals && npm run build && npm test`
Expected: PASS — approval + validation tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/approvals/src/approval.ts apps/approvals/src/approval.test.ts
git commit -m "feat: approval state machine and permission checks (pure)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Roster data module (DB, TDD)

**Files:**
- Create: `apps/approvals/src/roster.ts`
- Test: `apps/approvals/src/roster.test.ts`

> **DB test note:** these tests require `TEST_DATABASE_URL` pointing at a Postgres DB with the app schema applied. They are skipped automatically when it is unset, so pure tests still run. See Task 11's "Running DB tests" note for setup. When `TEST_DATABASE_URL` is set, run the full suite to confirm.

- [ ] **Step 1: Write the failing test**

Create `apps/approvals/src/roster.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { addRosterEntry, listRoster, setRosterActive } from "./roster";

const url = process.env.TEST_DATABASE_URL;

test("roster add (unique + reactivate), list, toggle", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await pool.query("DELETE FROM roster");

  const a = await addRosterEntry(pool, "Pastor Dale", "dale@x.com");
  assert.ok(a.ok);

  // duplicate email updates name + reactivates rather than erroring
  const dup = await addRosterEntry(pool, "Dale R", "dale@x.com");
  assert.ok(dup.ok);

  const all = await listRoster(pool, true);
  assert.equal(all.length, 1);
  assert.equal(all[0].name, "Dale R");
  assert.equal(all[0].active, true);

  await setRosterActive(pool, all[0].id, false);
  const activeOnly = await listRoster(pool, false);
  assert.equal(activeOnly.length, 0);
  const withInactive = await listRoster(pool, true);
  assert.equal(withInactive.length, 1);
  assert.equal(withInactive[0].active, false);

  await pool.query("DELETE FROM roster");
  await pool.end();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/approvals && npm run build`
Expected: FAIL — `./roster` exports are missing.

- [ ] **Step 3: Write the implementation**

Create `apps/approvals/src/roster.ts`:

```ts
import { Pool } from "pg";

export interface RosterEntry {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export type AddResult = { ok: true; id: number } | { ok: false; error: string };

// Insert a roster member; on duplicate email, update the name and reactivate.
export async function addRosterEntry(pool: Pool, name: string, email: string): Promise<AddResult> {
  const n = name.trim();
  const e = email.trim().toLowerCase();
  if (!n) return { ok: false, error: "Name is required." };
  if (!e || !e.includes("@")) return { ok: false, error: "A valid email is required." };
  try {
    const r = await pool.query(
      `INSERT INTO roster (name, email, active) VALUES ($1, $2, true)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, active = true
       RETURNING id`,
      [n, e]
    );
    return { ok: true, id: Number(r.rows[0].id) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function listRoster(pool: Pool, includeInactive: boolean): Promise<RosterEntry[]> {
  const where = includeInactive ? "" : "WHERE active = true";
  const r = await pool.query(
    `SELECT id, name, email, active FROM roster ${where} ORDER BY name`
  );
  return r.rows.map((row) => ({
    id: Number(row.id), name: row.name, email: row.email, active: row.active,
  }));
}

export async function getRosterEntry(pool: Pool, id: number): Promise<RosterEntry | null> {
  const r = await pool.query(
    "SELECT id, name, email, active FROM roster WHERE id = $1", [id]
  );
  const row = r.rows[0];
  return row ? { id: Number(row.id), name: row.name, email: row.email, active: row.active } : null;
}

export async function setRosterActive(pool: Pool, id: number, active: boolean): Promise<void> {
  await pool.query("UPDATE roster SET active = $2 WHERE id = $1", [id, active]);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/approvals && npm run build && npm test`
Expected: PASS. (Roster DB test runs if `TEST_DATABASE_URL` is set; otherwise it is skipped and the pure tests still pass.)

- [ ] **Step 5: Commit**

```bash
git add apps/approvals/src/roster.ts apps/approvals/src/roster.test.ts
git commit -m "feat: roster data module for approvals (add/list/toggle)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Requests data module (DB, TDD)

**Files:**
- Create: `apps/approvals/src/requests.ts`
- Test: `apps/approvals/src/requests.test.ts`

This module ties together the roster, the state machine, and the version/event tables. It is the core of the app.

- [ ] **Step 1: Write the failing test**

Create `apps/approvals/src/requests.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { addRosterEntry } from "./roster";
import {
  createRequest, listRequests, getRequestDetail,
  recordDecision, addVersion, getVersionImage,
} from "./requests";

const url = process.env.TEST_DATABASE_URL;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // not a real PNG, just bytes

test("full request lifecycle: submit -> changes -> new version -> approve", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  await pool.query("DELETE FROM request_events");
  await pool.query("DELETE FROM request_versions");
  await pool.query("DELETE FROM requests");
  await pool.query("DELETE FROM roster");

  const appr = await addRosterEntry(pool, "Approver", "appr@x.com");
  assert.ok(appr.ok);

  // submit
  const created = await createRequest(pool, {
    title: "Easter banner", description: "for the lawn sign", approverId: appr.id,
    submitter: { email: "sub@x.com", name: "Submitter" },
    file: { fileName: "banner.png", mimeType: "image/png", buffer: png },
  });
  assert.ok(created.ok);
  const id = created.id;

  // appears in approver inbox and submitter sent box
  const inbox = await listRequests(pool, "inbox", "appr@x.com");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].id, id);
  const sent = await listRequests(pool, "sent", "sub@x.com");
  assert.equal(sent.length, 1);

  // non-approver cannot decide
  const bad = await recordDecision(pool, id, "sub@x.com", "approve", "");
  assert.equal(bad.ok, false);
  assert.equal((bad as { status: number }).status, 403);

  // approver requests changes (comment required)
  const noComment = await recordDecision(pool, id, "appr@x.com", "request_changes", "");
  assert.equal(noComment.ok, false);
  const changed = await recordDecision(pool, id, "appr@x.com", "request_changes", "Make the cross bigger");
  assert.ok(changed.ok);

  // now it leaves the approver inbox (status changes_requested)
  assert.equal((await listRequests(pool, "inbox", "appr@x.com")).length, 0);

  // submitter uploads a new version -> back to pending, current_version 2
  const v2 = await addVersion(pool, id, "sub@x.com",
    { fileName: "banner2.png", mimeType: "image/png", buffer: png }, "bigger cross");
  assert.ok(v2.ok);
  const detail = await getRequestDetail(pool, id, "sub@x.com");
  assert.ok(detail.ok);
  assert.equal(detail.request.status, "pending");
  assert.equal(detail.request.current_version, 2);
  assert.equal(detail.versions.length, 2);
  // events: submitted, changes_requested, resubmitted
  assert.ok(detail.events.length >= 3);

  // image fetch returns bytes for a party, 403 for an outsider
  const img = await getVersionImage(pool, id, 2, "appr@x.com");
  assert.ok(img.ok);
  assert.equal(img.mimeType, "image/png");
  const denied = await getVersionImage(pool, id, 2, "stranger@x.com");
  assert.equal(denied.ok, false);
  assert.equal((denied as { status: number }).status, 403);

  // approve -> terminal
  const approved = await recordDecision(pool, id, "appr@x.com", "approve", "looks great");
  assert.ok(approved.ok);
  const after = await getRequestDetail(pool, id, "appr@x.com");
  assert.ok(after.ok);
  assert.equal(after.request.status, "approved");
  // cannot approve again
  assert.equal((await recordDecision(pool, id, "appr@x.com", "approve", "")).ok, false);

  await pool.query("DELETE FROM request_events");
  await pool.query("DELETE FROM request_versions");
  await pool.query("DELETE FROM requests");
  await pool.query("DELETE FROM roster");
  await pool.end();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/approvals && npm run build`
Expected: FAIL — `./requests` exports are missing.

- [ ] **Step 3: Write the implementation**

Create `apps/approvals/src/requests.ts`:

```ts
import { Pool } from "pg";
import { getRosterEntry } from "./roster";
import {
  Status, DecisionAction, RequestParties, CheckResult,
  checkDecision, checkVersionUpload, canView,
  statusAfterDecision, eventTypeForDecision,
} from "./approval";

export interface UploadFile {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

export interface RequestRow {
  id: number;
  title: string;
  description: string;
  submitter_email: string;
  submitter_name: string;
  approver_email: string;
  approver_name: string;
  status: Status;
  current_version: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

export interface VersionMeta {
  version_no: number;
  file_name: string;
  mime_type: string;
  byte_size: number;
  note: string;
  uploaded_by_email: string;
  uploaded_at: string;
}

export interface EventRow {
  type: string;
  version_no: number;
  actor_email: string;
  actor_name: string;
  comment: string;
  created_at: string;
}

export interface ListItem extends RequestRow {
  latest_file_name: string;
  latest_mime_type: string;
}

export type CreateInput = {
  title: string;
  description: string;
  approverId: number;
  submitter: { email: string; name: string };
  file: UploadFile;
};

export type CreateResult = { ok: true; id: number } | { ok: false; status: number; error: string };
export type MutateResult = { ok: true } | { ok: false; status: number; error: string };

function rowToRequest(row: any): RequestRow {
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description,
    submitter_email: row.submitter_email,
    submitter_name: row.submitter_name,
    approver_email: row.approver_email,
    approver_name: row.approver_name,
    status: row.status,
    current_version: Number(row.current_version),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    decided_at: row.decided_at ? String(row.decided_at) : null,
  };
}

async function loadParties(pool: Pool, id: number): Promise<RequestParties & { found: boolean }> {
  const r = await pool.query(
    "SELECT submitter_email, approver_email, status FROM requests WHERE id = $1", [id]
  );
  const row = r.rows[0];
  if (!row) return { found: false, submitter_email: "", approver_email: "", status: "pending" };
  return { found: true, submitter_email: row.submitter_email, approver_email: row.approver_email, status: row.status };
}

export async function createRequest(pool: Pool, input: CreateInput): Promise<CreateResult> {
  const title = input.title.trim();
  if (!title) return { ok: false, status: 400, error: "Title is required." };

  const approver = await getRosterEntry(pool, input.approverId);
  if (!approver || !approver.active) {
    return { ok: false, status: 400, error: "Selected approver is not on the active roster." };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO requests (title, description, submitter_email, submitter_name, approver_email, approver_name, status, current_version)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',1) RETURNING id`,
      [title, input.description.trim(), input.submitter.email, input.submitter.name, approver.email, approver.name]
    );
    const id = Number(ins.rows[0].id);
    await client.query(
      `INSERT INTO request_versions (request_id, version_no, file_name, mime_type, byte_size, image, note, uploaded_by_email)
       VALUES ($1,1,$2,$3,$4,$5,'',$6)`,
      [id, input.file.fileName, input.file.mimeType, input.file.buffer.length, input.file.buffer, input.submitter.email]
    );
    await client.query(
      `INSERT INTO request_events (request_id, version_no, type, actor_email, actor_name, comment)
       VALUES ($1,1,'submitted',$2,$3,'')`,
      [id, input.submitter.email, input.submitter.name]
    );
    await client.query("COMMIT");
    return { ok: true, id };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, status: 500, error: (err as Error).message };
  } finally {
    client.release();
  }
}

export async function listRequests(pool: Pool, box: "inbox" | "sent", email: string): Promise<ListItem[]> {
  const e = email.trim().toLowerCase();
  const cond = box === "inbox"
    ? "lower(approver_email) = $1 AND status = 'pending'"
    : "lower(submitter_email) = $1";
  const r = await pool.query(
    `SELECT r.*, v.file_name AS latest_file_name, v.mime_type AS latest_mime_type
       FROM requests r
       JOIN request_versions v ON v.request_id = r.id AND v.version_no = r.current_version
      WHERE ${cond}
      ORDER BY r.updated_at DESC`,
    [e]
  );
  return r.rows.map((row) => ({
    ...rowToRequest(row),
    latest_file_name: row.latest_file_name,
    latest_mime_type: row.latest_mime_type,
  }));
}

export type DetailResult =
  | { ok: true; request: RequestRow; versions: VersionMeta[]; events: EventRow[] }
  | { ok: false; status: number; error: string };

export async function getRequestDetail(pool: Pool, id: number, email: string): Promise<DetailResult> {
  const rq = await pool.query("SELECT * FROM requests WHERE id = $1", [id]);
  const row = rq.rows[0];
  if (!row) return { ok: false, status: 404, error: "Request not found." };
  const request = rowToRequest(row);
  if (!canView(request, email)) return { ok: false, status: 403, error: "You do not have access to this request." };

  const vs = await pool.query(
    `SELECT version_no, file_name, mime_type, byte_size, note, uploaded_by_email, uploaded_at
       FROM request_versions WHERE request_id = $1 ORDER BY version_no`, [id]
  );
  const ev = await pool.query(
    `SELECT type, version_no, actor_email, actor_name, comment, created_at
       FROM request_events WHERE request_id = $1 ORDER BY created_at, id`, [id]
  );
  return {
    ok: true,
    request,
    versions: vs.rows.map((v) => ({
      version_no: Number(v.version_no), file_name: v.file_name, mime_type: v.mime_type,
      byte_size: Number(v.byte_size), note: v.note, uploaded_by_email: v.uploaded_by_email,
      uploaded_at: String(v.uploaded_at),
    })),
    events: ev.rows.map((e) => ({
      type: e.type, version_no: Number(e.version_no), actor_email: e.actor_email,
      actor_name: e.actor_name, comment: e.comment, created_at: String(e.created_at),
    })),
  };
}

export async function recordDecision(
  pool: Pool, id: number, actorEmail: string, action: DecisionAction, comment: string,
  actorName = ""
): Promise<MutateResult> {
  const parties = await loadParties(pool, id);
  if (!parties.found) return { ok: false, status: 404, error: "Request not found." };
  const check: CheckResult = checkDecision(parties, actorEmail, action, comment);
  if (!check.ok) return check;

  const newStatus = statusAfterDecision(action);
  const eventType = eventTypeForDecision(action);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query("SELECT current_version FROM requests WHERE id = $1", [id]);
    const versionNo = Number(cur.rows[0].current_version);
    const decidedAt = action === "request_changes" ? null : "now()";
    if (decidedAt) {
      await client.query(
        "UPDATE requests SET status = $2, updated_at = now(), decided_at = now() WHERE id = $1",
        [id, newStatus]
      );
    } else {
      await client.query(
        "UPDATE requests SET status = $2, updated_at = now() WHERE id = $1",
        [id, newStatus]
      );
    }
    await client.query(
      `INSERT INTO request_events (request_id, version_no, type, actor_email, actor_name, comment)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, versionNo, eventType, actorEmail, actorName, comment.trim()]
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, status: 500, error: (err as Error).message };
  } finally {
    client.release();
  }
}

export async function addVersion(
  pool: Pool, id: number, actorEmail: string, file: UploadFile, note: string, actorName = ""
): Promise<MutateResult> {
  const parties = await loadParties(pool, id);
  if (!parties.found) return { ok: false, status: 404, error: "Request not found." };
  const check = checkVersionUpload(parties, actorEmail);
  if (!check.ok) return check;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query("SELECT current_version FROM requests WHERE id = $1 FOR UPDATE", [id]);
    const next = Number(cur.rows[0].current_version) + 1;
    await client.query(
      `INSERT INTO request_versions (request_id, version_no, file_name, mime_type, byte_size, image, note, uploaded_by_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, next, file.fileName, file.mimeType, file.buffer.length, file.buffer, note.trim(), actorEmail]
    );
    await client.query(
      "UPDATE requests SET status = 'pending', current_version = $2, updated_at = now() WHERE id = $1",
      [id, next]
    );
    await client.query(
      `INSERT INTO request_events (request_id, version_no, type, actor_email, actor_name, comment)
       VALUES ($1,$2,'resubmitted',$3,$4,$5)`,
      [id, next, actorEmail, actorName, note.trim()]
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, status: 500, error: (err as Error).message };
  } finally {
    client.release();
  }
}

export type ImageResult =
  | { ok: true; mimeType: string; fileName: string; image: Buffer }
  | { ok: false; status: number; error: string };

export async function getVersionImage(pool: Pool, id: number, versionNo: number, email: string): Promise<ImageResult> {
  const parties = await loadParties(pool, id);
  if (!parties.found) return { ok: false, status: 404, error: "Request not found." };
  if (!canView(parties, email)) return { ok: false, status: 403, error: "You do not have access to this image." };
  const r = await pool.query(
    "SELECT mime_type, file_name, image FROM request_versions WHERE request_id = $1 AND version_no = $2",
    [id, versionNo]
  );
  const row = r.rows[0];
  if (!row) return { ok: false, status: 404, error: "Version not found." };
  return { ok: true, mimeType: row.mime_type, fileName: row.file_name, image: row.image as Buffer };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/approvals && npm run build && npm test`
Expected: PASS. (Requests lifecycle DB test runs when `TEST_DATABASE_URL` is set; otherwise skipped. Pure tests pass regardless.)

- [ ] **Step 5: Commit**

```bash
git add apps/approvals/src/requests.ts apps/approvals/src/requests.test.ts
git commit -m "feat: requests data module (create/list/detail/decision/version/image)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: API routes — me + roster

**Files:**
- Create: `apps/approvals/src/routes/me.ts`
- Create: `apps/approvals/src/routes/roster.ts`
- Modify: `apps/approvals/src/index.ts`

- [ ] **Step 1: Create `src/routes/me.ts`**

```ts
import { FastifyInstance } from "fastify";
import { getIdentity } from "../identity";

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/me", async (req) => {
    const id = getIdentity(req);
    return { ok: true, email: id.email, name: id.name };
  });
}
```

- [ ] **Step 2: Create `src/routes/roster.ts`**

```ts
import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { addRosterEntry, listRoster, setRosterActive } from "../roster";

interface AddBody { name?: string; email?: string }
interface ToggleBody { active?: boolean }

export async function rosterRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/roster", async (req) => {
    try {
      const includeInactive = (req.query as { all?: string })?.all === "1";
      return { ok: true, roster: await listRoster(pool, includeInactive) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.post("/api/roster", async (req, reply) => {
    const b = (req.body ?? {}) as AddBody;
    const r = await addRosterEntry(pool, b.name ?? "", b.email ?? "");
    if (!r.ok) reply.code(400);
    return r;
  });

  app.post("/api/roster/:id", async (req, reply) => {
    try {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isFinite(id)) { reply.code(400); return { ok: false, error: "Bad id." }; }
      const b = (req.body ?? {}) as ToggleBody;
      await setRosterActive(pool, id, b.active !== false);
      return { ok: true };
    } catch (e) {
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });
}
```

- [ ] **Step 3: Wire them into `src/index.ts`**

Add imports below the existing imports:

```ts
import { meRoutes } from "./routes/me";
import { rosterRoutes } from "./routes/roster";
```

Add registrations after the `fastifyStatic` registration line:

```ts
app.register(meRoutes);
app.register(rosterRoutes);
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd apps/approvals && npm run build`
Expected: PASS — `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/approvals/src/routes/me.ts apps/approvals/src/routes/roster.ts apps/approvals/src/index.ts
git commit -m "feat: me + roster API routes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: API routes — requests (multipart, decisions, versions, image)

**Files:**
- Create: `apps/approvals/src/routes/requests.ts`
- Modify: `apps/approvals/src/index.ts`

- [ ] **Step 1: Create `src/routes/requests.ts`**

```ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { validateUpload } from "../validation";
import { DecisionAction } from "../approval";
import {
  createRequest, listRequests, getRequestDetail,
  recordDecision, addVersion, getVersionImage, UploadFile,
} from "../requests";

// Pull a single file part + text fields out of a multipart request.
async function readMultipart(req: FastifyRequest): Promise<{
  fields: Record<string, string>;
  file: UploadFile | null;
}> {
  const fields: Record<string, string> = {};
  let file: UploadFile | null = null;
  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      const buffer = await part.toBuffer();
      file = { fileName: part.filename, mimeType: part.mimetype, buffer };
    } else {
      fields[part.fieldname] = String(part.value ?? "");
    }
  }
  return { fields, file };
}

export async function requestsRoutes(app: FastifyInstance): Promise<void> {
  // List inbox or sent.
  app.get("/api/requests", async (req) => {
    try {
      const id = getIdentity(req);
      const box = (req.query as { box?: string })?.box === "sent" ? "sent" : "inbox";
      return { ok: true, requests: await listRequests(pool, box, id.email) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // Detail.
  app.get("/api/requests/:id", async (req, reply) => {
    const id = getIdentity(req);
    const reqId = Number((req.params as { id: string }).id);
    const r = await getRequestDetail(pool, reqId, id.email);
    if (!r.ok) reply.code(r.status);
    return r;
  });

  // Serve version image bytes.
  app.get("/api/requests/:id/versions/:n/image", async (req: FastifyRequest, reply: FastifyReply) => {
    const id = getIdentity(req);
    const p = req.params as { id: string; n: string };
    const r = await getVersionImage(pool, Number(p.id), Number(p.n), id.email);
    if (!r.ok) { reply.code(r.status); return { ok: false, error: r.error }; }
    reply
      .header("Content-Type", r.mimeType)
      .header("Content-Disposition", `inline; filename="${r.fileName.replace(/"/g, "")}"`)
      .header("Cache-Control", "private, max-age=300");
    return reply.send(r.image);
  });

  // Create (multipart).
  app.post("/api/requests", async (req, reply) => {
    try {
      const id = getIdentity(req);
      const { fields, file } = await readMultipart(req);
      if (!file) { reply.code(400); return { ok: false, error: "A file is required." }; }
      const v = validateUpload(file.mimeType, file.buffer.length);
      if (!v.ok) { reply.code(400); return { ok: false, error: v.error }; }
      const approverId = Number(fields.approverId);
      if (!Number.isFinite(approverId)) { reply.code(400); return { ok: false, error: "An approver is required." }; }
      const r = await createRequest(pool, {
        title: fields.title ?? "",
        description: fields.description ?? "",
        approverId,
        submitter: { email: id.email, name: id.name },
        file,
      });
      if (!r.ok) reply.code(r.status);
      return r;
    } catch (e) {
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });

  // Decision (JSON).
  app.post("/api/requests/:id/decision", async (req, reply) => {
    const id = getIdentity(req);
    const reqId = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { action?: string; comment?: string };
    const action = b.action as DecisionAction;
    if (!["approve", "reject", "request_changes"].includes(action)) {
      reply.code(400);
      return { ok: false, error: "Invalid action." };
    }
    const r = await recordDecision(pool, reqId, id.email, action, b.comment ?? "", id.name);
    if (!r.ok) reply.code(r.status);
    return r;
  });

  // New version (multipart).
  app.post("/api/requests/:id/versions", async (req, reply) => {
    try {
      const id = getIdentity(req);
      const reqId = Number((req.params as { id: string }).id);
      const { fields, file } = await readMultipart(req);
      if (!file) { reply.code(400); return { ok: false, error: "A file is required." }; }
      const v = validateUpload(file.mimeType, file.buffer.length);
      if (!v.ok) { reply.code(400); return { ok: false, error: v.error }; }
      const r = await addVersion(pool, reqId, id.email, file, fields.note ?? "", id.name);
      if (!r.ok) reply.code(r.status);
      return r;
    } catch (e) {
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });
}
```

- [ ] **Step 2: Wire into `src/index.ts`**

Add import:

```ts
import { requestsRoutes } from "./routes/requests";
```

Add registration after `rosterRoutes`:

```ts
app.register(requestsRoutes);
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cd apps/approvals && npm run build`
Expected: PASS — `tsc` exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/approvals/src/routes/requests.ts apps/approvals/src/index.ts
git commit -m "feat: request API routes (multipart upload, decision, version, image)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Frontend — HTML shell

**Files:**
- Create: `apps/approvals/src/public/index.html`

Reuses the navy/gold design system from social-posts. Tabs: Inbox, My Requests, New Request, Settings.

- [ ] **Step 1: Create `src/public/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GRMC Approvals</title>
<style>
:root{--navy:#1a2744;--navy-light:#243058;--gold:#c9a84c;--gold-light:#e8c97a;--gold-muted:#f5ead4;--white:#fff;--off:#f8f6f1;--text:#1a2744;--muted:#5a6480;--hint:#9aa0b4;--border:#dde0ea;--r:8px;--rlg:12px}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--off);color:var(--text);min-height:100vh}
header{background:var(--navy);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid var(--gold)}
.logo{display:flex;align-items:center;gap:12px}
.mark{width:32px;height:32px;border-radius:50%;background:var(--gold);display:flex;align-items:center;justify-content:center;font-size:15px;color:var(--navy);flex-shrink:0}
header h1{font-size:14px;font-weight:600;color:var(--white)}
header p{font-size:11px;color:var(--gold-light);margin-top:1px}
.hright{display:flex;align-items:center;gap:8px}
.hlabel{font-size:12px;color:rgba(255,255,255,.7)}
.layout{max-width:760px;margin:0 auto;padding:24px 20px 80px}
.tabs{display:flex;gap:2px;background:var(--white);border:1px solid var(--border);border-radius:var(--rlg);padding:4px;margin-bottom:20px;flex-wrap:wrap}
.tab{flex:1;min-width:90px;padding:8px 10px;font-size:13px;font-weight:500;text-align:center;cursor:pointer;border:none;background:none;color:var(--muted);border-radius:var(--r);transition:background .15s,color .15s}
.tab.active{background:var(--navy);color:var(--white)}
.tab:hover:not(.active){background:var(--off);color:var(--text)}
.panel{display:none}.panel.active{display:block}
.card{background:var(--white);border:1px solid var(--border);border-radius:var(--rlg);padding:20px;margin-bottom:14px}
.ct{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--gold);margin-bottom:14px;display:flex;align-items:center;gap:6px}
.ct::after{content:"";flex:1;height:1px;background:var(--gold-muted)}
.field{margin-bottom:14px}.field:last-child{margin-bottom:0}
label{display:block;font-size:11px;font-weight:600;color:var(--muted);margin-bottom:4px;letter-spacing:.02em}
.hint{font-size:11px;color:var(--hint);margin-top:3px;line-height:1.5}
input[type=text],input[type=file],textarea,select{width:100%;border:1px solid var(--border);border-radius:var(--r);padding:8px 11px;font-size:13px;font-family:inherit;color:var(--text);background:var(--white)}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,168,76,.12)}
textarea{resize:vertical;min-height:70px;line-height:1.55}
.btn-row{display:flex;gap:8px;align-items:center;margin-top:16px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;font-size:13px;font-weight:600;cursor:pointer;border-radius:var(--r);border:none}
.btn-primary{background:var(--navy);color:var(--white)}.btn-primary:hover{background:var(--navy-light)}.btn-primary:disabled{opacity:.5;cursor:not-allowed}
.btn-secondary{background:var(--white);color:var(--text);border:1px solid var(--border)}.btn-secondary:hover{background:var(--off)}
.btn-gold{background:var(--gold);color:var(--navy)}.btn-gold:hover{background:var(--gold-light)}
.btn-danger{background:#fff;color:#791F1F;border:1px solid #e6b8b8}.btn-danger:hover{background:#FCEBEB}
.btn-sm{padding:5px 11px;font-size:12px;font-weight:600;cursor:pointer;border-radius:var(--r);border:1px solid var(--border);background:var(--white);color:var(--text)}
.btn-sm:hover{background:var(--off)}
.spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.alert{padding:10px 14px;border-radius:var(--r);font-size:12.5px;line-height:1.6;margin-bottom:12px}
.alert-err{background:#FCEBEB;color:#791F1F}
.alert-ok{background:#EAF3DE;color:#27500A}
.alert-info{background:#E6F1FB;color:#0C447C}
.empty{text-align:center;color:var(--muted);font-size:13px;padding:30px 10px}
.rcard{background:var(--white);border:1px solid var(--border);border-radius:var(--rlg);padding:16px;margin-bottom:12px}
.rhead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.rtitle{font-size:14px;font-weight:600;color:var(--text)}
.rmeta{font-size:11px;color:var(--muted);margin-top:3px}
.rdesc{font-size:12.5px;color:var(--text);margin-top:8px;white-space:pre-wrap;line-height:1.6}
.badge{font-size:10px;font-weight:700;padding:2px 9px;border-radius:20px;white-space:nowrap}
.b-pending{background:#FAEEDA;color:#633806}
.b-approved{background:#EAF3DE;color:#27500A}
.b-rejected{background:#FCEBEB;color:#791F1F}
.b-changes_requested{background:#E6F1FB;color:#0C447C}
.preview{margin-top:12px;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:var(--off)}
.preview img{display:block;max-width:100%;max-height:340px;margin:0 auto}
.preview .pdf{padding:18px;text-align:center;font-size:12.5px}
.ver{font-size:11px;color:var(--muted);margin-top:8px}
.log{margin-top:10px;border-top:1px solid var(--border);padding-top:10px}
.logitem{font-size:11.5px;color:var(--muted);padding:3px 0;line-height:1.5}
.logitem b{color:var(--text)}
.logitem .cmt{color:var(--text);display:block;background:var(--off);border-radius:6px;padding:6px 9px;margin-top:3px}
.roster-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)}
.roster-row:last-child{border-bottom:none}
.roster-name{font-size:13px;font-weight:600}
.roster-email{font-size:11px;color:var(--muted)}
.roster-row.off{opacity:.5}
</style>
</head>
<body>
<header>
  <div class="logo">
    <div class="mark">&#10003;</div>
    <div><h1>GRMC Approvals</h1><p>Graphics sign-off</p></div>
  </div>
  <div class="hright"><span class="hlabel" id="me-label">&hellip;</span></div>
</header>

<div class="layout">
  <div class="tabs">
    <button class="tab active" data-tab="inbox">Inbox</button>
    <button class="tab" data-tab="sent">My Requests</button>
    <button class="tab" data-tab="new">New Request</button>
    <button class="tab" data-tab="settings">Settings</button>
  </div>

  <div class="panel active" id="p-inbox">
    <div id="inbox-list"><div class="empty">Loading&hellip;</div></div>
  </div>

  <div class="panel" id="p-sent">
    <div id="sent-list"><div class="empty">Loading&hellip;</div></div>
  </div>

  <div class="panel" id="p-new">
    <div class="card">
      <div class="ct">New approval request</div>
      <div id="new-msg"></div>
      <div class="field"><label>Title</label><input type="text" id="n-title" placeholder="e.g. Easter lawn-sign banner"></div>
      <div class="field"><label>Description / notes</label><textarea id="n-desc" placeholder="Anything the approver should know"></textarea></div>
      <div class="field"><label>Approver</label><select id="n-approver"></select><div class="hint">Manage the roster in Settings.</div></div>
      <div class="field"><label>Graphic file</label><input type="file" id="n-file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"><div class="hint">PNG, JPG, WebP, GIF, or PDF &middot; up to 10 MB.</div></div>
      <div class="btn-row"><button class="btn btn-primary" id="btn-new" data-default="Submit for approval">Submit for approval</button></div>
    </div>
  </div>

  <div class="panel" id="p-settings">
    <div class="card">
      <div class="ct">Approver roster</div>
      <div id="roster-msg"></div>
      <div id="roster-list"><div class="empty">Loading&hellip;</div></div>
      <div class="field" style="margin-top:14px"><label>Add approver</label>
        <input type="text" id="r-name" placeholder="Name" style="margin-bottom:8px">
        <input type="text" id="r-email" placeholder="email@grmc.org">
      </div>
      <div class="btn-row"><button class="btn btn-gold" id="btn-roster" data-default="Add to roster">Add to roster</button></div>
    </div>
  </div>
</div>

<script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Verify it serves (after the app is running in Task 11), or just confirm the file exists for now**

Run: `test -f apps/approvals/src/public/index.html && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add apps/approvals/src/public/index.html
git commit -m "feat: approvals frontend HTML shell (tabs + design system)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Frontend — app.js logic

**Files:**
- Create: `apps/approvals/src/public/app.js`

- [ ] **Step 1: Create `src/public/app.js`**

```js
// ── HTTP helpers ────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
async function apiForm(path, formData) {
  const res = await fetch(path, { method: 'POST', body: formData });
  return res.json();
}

function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function v(id){ return document.getElementById(id).value.trim(); }
function setBtn(id, loading, label){
  var b = document.getElementById(id); if(!b) return;
  if(loading){ b.disabled=true; b.innerHTML='<span class="spin"></span> '+(label||'Working...'); }
  else { b.disabled=false; b.textContent=b.getAttribute('data-default')||label||'Submit'; }
}
function msg(id, kind, text){
  var el=document.getElementById(id);
  el.innerHTML = text ? '<div class="alert alert-'+kind+'">'+esc(text)+'</div>' : '';
}
function fmtDate(s){ try { return new Date(s).toLocaleString(); } catch(e){ return s; } }
function statusLabel(s){ return s.replace('_',' '); }

// ── Tabs ────────────────────────────────────────────────────────────────────
function switchTab(id){
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('.panel').forEach(function(p){ p.classList.remove('active'); });
  var t=document.querySelector('[data-tab="'+id+'"]'); if(t) t.classList.add('active');
  var p=document.getElementById('p-'+id); if(p) p.classList.add('active');
  if(id==='inbox') loadList('inbox');
  if(id==='sent') loadList('sent');
  if(id==='new') loadApproverOptions();
  if(id==='settings') loadRoster();
}
document.querySelectorAll('.tab').forEach(function(t){
  t.addEventListener('click', function(){ switchTab(t.getAttribute('data-tab')); });
});

// ── Identity ────────────────────────────────────────────────────────────────
function loadMe(){
  api('/api/me').then(function(m){
    document.getElementById('me-label').textContent = m.name || m.email || '';
  }).catch(function(){});
}

// ── Request rendering ───────────────────────────────────────────────────────
function badge(status){ return '<span class="badge b-'+status+'">'+esc(statusLabel(status))+'</span>'; }

function previewHtml(reqId, versionNo, mime){
  var src='/api/requests/'+reqId+'/versions/'+versionNo+'/image';
  if(mime==='application/pdf'){
    return '<div class="preview"><div class="pdf">PDF &middot; <a href="'+src+'" target="_blank">open in new tab</a></div></div>';
  }
  return '<div class="preview"><a href="'+src+'" target="_blank"><img src="'+src+'" alt="graphic"></a></div>';
}

function logHtml(events){
  if(!events || !events.length) return '';
  var rows = events.map(function(e){
    var who = esc(e.actor_name || e.actor_email);
    var line = '<div class="logitem"><b>'+who+'</b> '+esc(statusLabel(e.type))+' &middot; v'+e.version_no+' &middot; '+esc(fmtDate(e.created_at));
    if(e.comment) line += '<span class="cmt">'+esc(e.comment)+'</span>';
    return line+'</div>';
  }).join('');
  return '<div class="log">'+rows+'</div>';
}

// Render one detailed request card with optional action controls.
function renderDetail(d, mode){
  var r=d.request;
  var latest=d.versions[d.versions.length-1];
  var h='<div class="rcard" id="rc-'+r.id+'">';
  h+='<div class="rhead"><div><div class="rtitle">'+esc(r.title)+'</div>'
    +'<div class="rmeta">from '+esc(r.submitter_name||r.submitter_email)+' &middot; to '+esc(r.approver_name||r.approver_email)
    +' &middot; v'+r.current_version+'</div></div>'+badge(r.status)+'</div>';
  if(r.description) h+='<div class="rdesc">'+esc(r.description)+'</div>';
  h+=previewHtml(r.id, latest.version_no, latest.mime_type);
  if(latest.note) h+='<div class="ver">Latest note: '+esc(latest.note)+'</div>';
  h+=logHtml(d.events);

  if(mode==='inbox' && r.status==='pending'){
    h+='<div class="field" style="margin-top:12px"><label>Comment (required to request changes)</label>'
      +'<textarea id="cmt-'+r.id+'" placeholder="Optional for approve/reject"></textarea></div>'
      +'<div class="btn-row">'
      +'<button class="btn btn-gold btn-sm" onclick="decide('+r.id+',\'approve\')">Approve</button>'
      +'<button class="btn btn-secondary btn-sm" onclick="decide('+r.id+',\'request_changes\')">Request changes</button>'
      +'<button class="btn btn-danger btn-sm" onclick="decide('+r.id+',\'reject\')">Reject</button>'
      +'<span id="amsg-'+r.id+'"></span></div>';
  }
  if(mode==='sent' && r.status==='changes_requested'){
    h+='<div class="field" style="margin-top:12px"><label>Upload new version</label>'
      +'<input type="file" id="nv-file-'+r.id+'" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" style="margin-bottom:8px">'
      +'<input type="text" id="nv-note-'+r.id+'" placeholder="What changed (optional)"></div>'
      +'<div class="btn-row"><button class="btn btn-primary btn-sm" onclick="uploadVersion('+r.id+')">Submit new version</button>'
      +'<span id="amsg-'+r.id+'"></span></div>';
  }
  h+='</div>';
  return h;
}

// ── Lists ───────────────────────────────────────────────────────────────────
function loadList(box){
  var listId = box==='inbox' ? 'inbox-list' : 'sent-list';
  var el=document.getElementById(listId);
  el.innerHTML='<div class="empty">Loading&hellip;</div>';
  api('/api/requests?box='+box).then(function(res){
    if(!res.ok){ el.innerHTML='<div class="alert alert-err">'+esc(res.error)+'</div>'; return; }
    if(!res.requests.length){
      el.innerHTML='<div class="empty">'+(box==='inbox'?'Nothing awaiting your approval.':'You have not submitted any requests yet.')+'</div>';
      return;
    }
    // Fetch full detail per request so previews + logs render.
    Promise.all(res.requests.map(function(r){ return api('/api/requests/'+r.id); }))
      .then(function(details){
        el.innerHTML = details.filter(function(d){ return d.ok; })
          .map(function(d){ return renderDetail(d, box); }).join('');
      });
  }).catch(function(e){ el.innerHTML='<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

// ── Actions ─────────────────────────────────────────────────────────────────
function decide(id, action){
  var comment = (document.getElementById('cmt-'+id)||{}).value || '';
  var amsg=document.getElementById('amsg-'+id);
  amsg.innerHTML='<span class="spin" style="border-top-color:var(--navy)"></span>';
  api('/api/requests/'+id+'/decision', { method:'POST', body:{ action:action, comment:comment } })
    .then(function(res){
      if(!res.ok){ amsg.innerHTML='<span style="color:#791F1F;font-size:12px">'+esc(res.error)+'</span>'; return; }
      loadList('inbox');
    });
}

function uploadVersion(id){
  var fileEl=document.getElementById('nv-file-'+id);
  var amsg=document.getElementById('amsg-'+id);
  if(!fileEl.files.length){ amsg.innerHTML='<span style="color:#791F1F;font-size:12px">Pick a file first.</span>'; return; }
  var fd=new FormData();
  fd.append('file', fileEl.files[0]);
  fd.append('note', (document.getElementById('nv-note-'+id)||{}).value || '');
  amsg.innerHTML='<span class="spin" style="border-top-color:var(--navy)"></span>';
  apiForm('/api/requests/'+id+'/versions', fd).then(function(res){
    if(!res.ok){ amsg.innerHTML='<span style="color:#791F1F;font-size:12px">'+esc(res.error)+'</span>'; return; }
    loadList('sent');
  });
}

// ── New request ─────────────────────────────────────────────────────────────
function loadApproverOptions(){
  api('/api/roster').then(function(res){
    var sel=document.getElementById('n-approver');
    if(!res.ok || !res.roster.length){
      sel.innerHTML='<option value="">No approvers — add one in Settings</option>';
      return;
    }
    sel.innerHTML = res.roster.map(function(p){
      return '<option value="'+p.id+'">'+esc(p.name)+' ('+esc(p.email)+')</option>';
    }).join('');
  });
}

document.getElementById('btn-new').addEventListener('click', function(){
  var fileEl=document.getElementById('n-file');
  if(!v('n-title')){ msg('new-msg','err','Title is required.'); return; }
  if(!fileEl.files.length){ msg('new-msg','err','Pick a graphic file.'); return; }
  var approverId=document.getElementById('n-approver').value;
  if(!approverId){ msg('new-msg','err','Choose an approver (add one in Settings).'); return; }
  var fd=new FormData();
  fd.append('title', v('n-title'));
  fd.append('description', v('n-desc'));
  fd.append('approverId', approverId);
  fd.append('file', fileEl.files[0]);
  setBtn('btn-new', true, 'Submitting...');
  apiForm('/api/requests', fd).then(function(res){
    setBtn('btn-new', false);
    if(!res.ok){ msg('new-msg','err',res.error); return; }
    msg('new-msg','ok','Submitted for approval.');
    document.getElementById('n-title').value='';
    document.getElementById('n-desc').value='';
    fileEl.value='';
  }).catch(function(e){ setBtn('btn-new', false); msg('new-msg','err',e.message); });
});

// ── Roster ──────────────────────────────────────────────────────────────────
function loadRoster(){
  var el=document.getElementById('roster-list');
  api('/api/roster?all=1').then(function(res){
    if(!res.ok){ el.innerHTML='<div class="alert alert-err">'+esc(res.error)+'</div>'; return; }
    if(!res.roster.length){ el.innerHTML='<div class="empty">No approvers yet.</div>'; return; }
    el.innerHTML = res.roster.map(function(p){
      return '<div class="roster-row'+(p.active?'':' off')+'">'
        +'<div><div class="roster-name">'+esc(p.name)+'</div><div class="roster-email">'+esc(p.email)+'</div></div>'
        +'<button class="btn-sm" onclick="toggleRoster('+p.id+','+(!p.active)+')">'+(p.active?'Deactivate':'Reactivate')+'</button>'
        +'</div>';
    }).join('');
  });
}

function toggleRoster(id, active){
  api('/api/roster/'+id, { method:'POST', body:{ active:active } }).then(function(){ loadRoster(); });
}

document.getElementById('btn-roster').addEventListener('click', function(){
  if(!v('r-name') || !v('r-email')){ msg('roster-msg','err','Name and email are required.'); return; }
  setBtn('btn-roster', true, 'Adding...');
  api('/api/roster', { method:'POST', body:{ name:v('r-name'), email:v('r-email') } }).then(function(res){
    setBtn('btn-roster', false);
    if(!res.ok){ msg('roster-msg','err',res.error); return; }
    msg('roster-msg','ok','Added.');
    document.getElementById('r-name').value='';
    document.getElementById('r-email').value='';
    loadRoster();
  }).catch(function(e){ setBtn('btn-roster', false); msg('roster-msg','err',e.message); });
});

// ── Boot ────────────────────────────────────────────────────────────────────
loadMe();
loadList('inbox');
```

- [ ] **Step 2: Confirm the file exists**

Run: `test -f apps/approvals/src/public/app.js && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add apps/approvals/src/public/app.js
git commit -m "feat: approvals frontend logic (lists, decisions, versions, roster)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Hub wiring (database, registry, compose, env, README)

**Files:**
- Modify: `db/init/01-databases.sh`
- Modify: `db/init/02-hub-schema.sql`
- Modify: `docker-compose.yml`
- Modify: `.env`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add the database to `db/init/01-databases.sh`**

After the `create_app_db "$SOCIALPOSTS_DB_NAME" ...` line, add:

```bash
create_app_db "$APPROVALS_DB_NAME"   "$APPROVALS_DB_USER"   "$APPROVALS_DB_PASSWORD"
```

- [ ] **Step 2: Seed the registry row in `db/init/02-hub-schema.sql`**

After the social-posts `INSERT INTO apps ...` block (before `RESET ROLE;`), add:

```sql
INSERT INTO apps (slug, name, host, icon)
VALUES ('approvals', 'Approvals', 'app-approvals.lvh.me', '✅');
```

- [ ] **Step 3: Add env vars to `.env.example`**

After the `SOCIALPOSTS_DB_*` block, add:

```bash
APPROVALS_DB_NAME=approvals
APPROVALS_DB_USER=approvals_user
APPROVALS_DB_PASSWORD=replace-approvals-db-password
```

- [ ] **Step 4: Add matching vars to `.env`**

Add the same three keys to `.env`, with a real generated password:

```bash
APPROVALS_DB_NAME=approvals
APPROVALS_DB_USER=approvals_user
APPROVALS_DB_PASSWORD=<run: openssl rand -hex 24>
```

Run to generate the value: `openssl rand -hex 24`

- [ ] **Step 5: Add the compose service to `docker-compose.yml`**

After the `social-posts:` service block (before the `networks:` top-level key), add:

```yaml
  approvals:
    build: ./apps/approvals
    environment:
      APPROVALS_DB_USER: "${APPROVALS_DB_USER}"
      APPROVALS_DB_PASSWORD: "${APPROVALS_DB_PASSWORD}"
      APPROVALS_DB_NAME: "${APPROVALS_DB_NAME}"
    depends_on:
      postgres:
        condition: service_healthy
    networks: [hubnet]
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.approvals.rule=Host(`app-approvals.lvh.me`)"
      - "traefik.http.routers.approvals.entrypoints=websecure"
      - "traefik.http.routers.approvals.tls=true"
      - "traefik.http.routers.approvals.middlewares=hub-forward-auth@file"
      - "traefik.http.services.approvals.loadbalancer.server.port=3000"
```

- [ ] **Step 6: Document the app in `README.md`**

Under the "## Apps" list, after the Social Posts bullet, add:

```markdown
- **Approvals** (`app-approvals.lvh.me`) — request and grant sign-off on
  graphics. Submitters upload an image and pick an approver from a roster
  (managed in Settings); the approver approves, rejects, or requests changes.
  Change requests bounce back to the submitter, who uploads a new version.
  Data and image bytes live in the `approvals` database.
```

- [ ] **Step 7: Commit**

```bash
git add db/init/01-databases.sh db/init/02-hub-schema.sql docker-compose.yml .env.example README.md
git commit -m "feat: wire approvals app into the hub (db, registry, compose, docs)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> `.env` is gitignored (it holds secrets) — do not add it to the commit; Step 4 only edits your local file.

---

## Task 11: Provision the database on the existing volume + end-to-end smoke test

`02-hub-schema.sql` and `01-databases.sh` only run on a **fresh** Postgres volume. Since the dev volume already exists, the `approvals` DB/role and the registry row must be created with one-off statements (the same approach used for social-posts).

> **Running DB tests (optional, for Tasks 4–5):** after the role/DB exist (Steps 1–2 below), the app's tables are created either by booting the container (`ensureSchema()` on start, Step 5) or by running the `SCHEMA_SQL` against the DB once. To run the DB-backed unit tests locally, set `TEST_DATABASE_URL` to that database, e.g.:
> `TEST_DATABASE_URL="postgres://approvals_user:<pw>@localhost:5432/approvals" npm test`
> (requires the Postgres port published to localhost; otherwise rely on the container boot + the smoke test below).

- [ ] **Step 1: Create the role + database in the running Postgres**

Run (uses the password you put in `.env`):

```bash
APPROVALS_PW=$(grep '^APPROVALS_DB_PASSWORD=' .env | cut -d= -f2-)
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='approvals_user') THEN
    CREATE ROLE approvals_user WITH LOGIN PASSWORD '${APPROVALS_PW}';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE approvals OWNER approvals_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='approvals')\gexec
SQL
```

Expected: completes without error (creates role + database if missing).

- [ ] **Step 2: Seed the registry row in the hub database**

```bash
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d hub <<SQL
SET ROLE hub_user;
INSERT INTO apps (slug, name, host, icon)
VALUES ('approvals', 'Approvals', 'app-approvals.lvh.me', '✅')
ON CONFLICT (slug) DO NOTHING;
RESET ROLE;
SQL
```

Expected: inserts one row (or no-ops if already present).

> If the `apps` table has no unique constraint on `slug` that `ON CONFLICT` can use, the schema in `02-hub-schema.sql` declares `slug text UNIQUE NOT NULL`, so `ON CONFLICT (slug)` is valid.

- [ ] **Step 3: Build and start the container**

Run: `docker compose up -d --build approvals`
Expected: image builds; `approvals` container starts. `ensureSchema()` creates the four tables on boot.

- [ ] **Step 4: Verify health and schema**

Run: `docker compose logs --tail=20 approvals`
Expected: log line `approvals listening on 3000`, no errors.

Run: `docker compose exec -T postgres psql -U approvals_user -d approvals -c "\dt"`
Expected: lists `roster`, `requests`, `request_versions`, `request_events`.

- [ ] **Step 5: End-to-end smoke test through the browser**

Manual checks at `https://app-approvals.lvh.me` (logged in via the hub):
1. **Settings** → add an approver (your own name + email so you can both submit and approve). Confirm it appears.
2. **New Request** → title + a small PNG + the approver → Submit. Confirm "Submitted for approval".
3. **Inbox** → the request appears with an image preview. Add a comment → **Request changes**. It disappears from Inbox.
4. **My Requests** → the request shows `changes requested` with an "upload new version" control. Upload a second image → it returns to pending.
5. **Inbox** → it reappears at v2. **Approve**. Confirm it leaves the Inbox and **My Requests** shows `approved` with the full decision log.
6. Confirm the hub dashboard at `https://hub.lvh.me` shows the **Approvals** tile (✅) and it links to the app.

- [ ] **Step 6: Final commit (if any tracked files changed during smoke testing)**

If nothing tracked changed, skip. Otherwise:

```bash
git add -A
git commit -m "chore: approvals app verified end-to-end

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done

The approvals app is built, wired into the hub, unit-tested (pure logic always; DB modules when `TEST_DATABASE_URL` is set), and verified end-to-end through the browser.
