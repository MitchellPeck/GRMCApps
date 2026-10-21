# Minutes Edit Lock Implementation Plan (plan 3 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One signed-in person edits a meeting at a time; everyone else sees it read-only with "Being edited by <name>", and can take over once the lock lapses.

**Architecture:** A `meeting_locks` row per meeting (holder, heartbeat, last edit). Pure `lockState(lock, now, recording)` decides live vs lapsed; `acquireLock` takes a free/lapsed lock or refreshes the holder's. A Fastify `preHandler` on every meeting-scoped write route resolves the meeting id and refuses other people's writes with 423. The page heartbeats while open and switches to read-only on 423 or when someone else holds the lock.

**Tech Stack:** TypeScript, Fastify 5, pg, node:test, vanilla JS.

**Spec:** `docs/superpowers/specs/2026-10-21-meeting-minutes-live-edit-design.md` — Goal 6.

## Global Constraints

- Holder identity is `getIdentity(req)` (`x-auth-email`, `x-auth-name`). An empty email (local dev) is a holder like any other.
- Lapse: **2 minutes** without a heartbeat, or **15 minutes** without an edit. While the meeting's `recording_status` is `recording`, the idle rule does not apply (heartbeat still does).
- Lock covers every write on a meeting: details, attendees, guests, speakers, agenda/items, transcripts, notes, summaries, report generate/edit/cancel, fixes/undo, delete meeting, recording start/reprocess. **Exempt:** the recording routes `chunk`, `marker`, `finish` (a two-hour recording must never lose an upload), all GETs, creating a meeting, people, settings.
- Background work (queues) never checks the lock.
- A refused write is HTTP **423** `{ ok:false, locked:true, holder: "<name or email>", error: "<name> is editing this meeting." }`.
- The chat (plan 5) acts as the person using it, so it goes through the same guard.

## Review Focus

1. **Holder's tab closed without releasing** → lock lapses after 2 min and the next person who opens it gets it. *Test in Task 1.*
2. **Two people open the meeting at the same moment** → exactly one gets the lock (row-level atomic upsert). *Test in Task 1.*
3. **Long recording with no other edits** → lock never lapses for idleness while recording; chunk uploads are never refused. *Test in Task 1 and Task 2.*
4. **Write to an item/guest/recording id (not a meeting id)** → guard resolves the right meeting. *Test in Task 2.*
5. **Read-only viewer clicks something that writes** → nothing is sent, or a 423 puts the page back in read-only with the holder's name, never a silent failure. *Test in Task 3.*

---

### Task 1: Locks (`locks.ts`)

**Files:** Modify `src/schema.ts`; Create `src/locks.ts`, `src/locks.test.ts`

**Interfaces — Produces:**
```sql
CREATE TABLE IF NOT EXISTS meeting_locks (
  meeting_id   bigint PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  email        text NOT NULL,
  name         text NOT NULL DEFAULT '',
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  edited_at    timestamptz NOT NULL DEFAULT now()
);
```
- `export const HEARTBEAT_LAPSE_MS = 120_000; export const IDLE_LAPSE_MS = 900_000;`
- `export interface Lock { meetingId: number; email: string; name: string; acquiredAt: Date; heartbeatAt: Date; editedAt: Date }`
- `export function lockLive(lock: Lock | null, now: Date, recording: boolean): boolean`
- `export type LockResult = { held: true; lock: Lock } | { held: false; lock: Lock }` — `held:false` means someone else holds a live lock.
- `export async function acquireLock(pool: Pool, meetingId: number, who: { email: string; name: string }, opts?: { edit?: boolean; now?: Date }): Promise<LockResult>` — in one transaction (`SELECT … FOR UPDATE` after `INSERT … ON CONFLICT DO NOTHING`): no row, a lapsed row, or the caller's own row → caller holds it (heartbeat = now; `edited_at` = now when `edit` or when newly taken). Recording = meeting `recording_status === 'recording'`.
- `export async function releaseLock(pool: Pool, meetingId: number, email: string): Promise<void>` — deletes only the caller's row.
- `export async function getLock(pool: Pool, meetingId: number, now?: Date): Promise<{ lock: Lock; live: boolean } | null>`

- [ ] **Step 1: Failing tests:** pure `lockLive` (fresh → true; heartbeat 3 min old → false; edit 20 min old → false; edit 20 min old while recording → true); DB: A acquires; B is refused (`held:false`, lock.email A); A's heartbeat 3 minutes stale (pass `now`) → B takes it; A releases only A's lock; two concurrent `acquireLock` calls for A and B on a free meeting → exactly one `held:true`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `feat(meeting-minutes): meeting edit locks`.

---

### Task 2: Enforce the lock on writes

**Files:** Create `src/lockGuard.ts`; Modify `src/routes/meetings.ts`; Create `src/lockRoutes.test.ts` (route tests with `fastify.inject`, DB-backed)

Route tests set `config.databaseUrl = process.env.TEST_DATABASE_URL` **before** dynamically importing `./db` and `./routes/meetings` (the `config` object is shared by reference; `db.ts` builds its pool on first import). Skip without `TEST_DATABASE_URL`.

**Interfaces — Produces:**
- `export async function meetingIdForRequest(pool: Pool, url: string, params: Record<string, string>): Promise<number | null>` — `:id` on `/api/meetings/:id…`; `:itemId` → `agenda_items.meeting_id`; `:gid` → `meeting_guests.meeting_id`; `:rid` → `meeting_recordings.meeting_id`; else null.
- `export function lockGuard(pool: Pool): preHandlerHookHandler` — for POST/PUT/PATCH/DELETE whose route is not exempt (`/api/meeting-recordings/:rid/chunk|marker|finish`, `POST /api/meetings`): resolve the meeting; if found, `acquireLock(…, { edit: true })`; on `held:false` reply 423 as in Global Constraints.
- Routes (registered in `meetingsRoutes`): `POST /api/meetings/:id/lock` (acquire/heartbeat; not an edit) → `{ ok:true, held, holder: { email, name } }`; `DELETE /api/meetings/:id/lock` → `{ ok:true }`. `GET /api/meetings/:id` adds `lock: { held: boolean, holder: { email, name } } | null` for the caller.

- [ ] **Step 1: Failing route tests:** A (`x-auth-email: a@x`) PATCHes a meeting → 200 and holds the lock; B PATCHes → 423 with `holder`; B PATCHes an item of that meeting → 423; B posts a recording chunk for A's recording → not 423; B `POST …/lock` → `held:false`; A `DELETE …/lock` then B `POST …/lock` → `held:true`; `GET /api/meetings/:id` as B shows `lock.held` true.
- [ ] **Step 2:** FAIL. **Step 3:** implement and register `app.addHook("preHandler", lockGuard(pool))` inside `meetingsRoutes`. **Step 4:** PASS. **Step 5:** commit `feat(meeting-minutes): one editor per meeting`.

---

### Task 3: Read-only page for everyone else

**Files:** Modify `src/public/app.js`, `src/public/app.css`; Test `src/modal.test.ts`

**Interfaces — Consumes:** Task 2 routes and the `lock` field.
**Produces in app.js:**
- `state.lock` from the meeting payload. `openMeeting` calls `POST …/lock`; while the detail view is open a 30 s timer heartbeats it. `showList` and `pagehide` release it (`fetch(…, { method:'DELETE', keepalive:true })`).
- When `state.lock && !state.lock.held`: `#detail-body` gets class `readonly`; a banner `#lock-banner` "Being edited by <holder>. You can look, listen and export, but not change anything." The viewer's own 30 s heartbeat is also its take-over: once the holder's lock lapses, that POST returns `held:true`, the banner becomes "You can edit now." and the page re-renders editable. *(No separate Take over button: acquiring a lapsed lock already takes it.)*
- In read-only mode every `input, textarea, select, button` inside `#detail-body` is disabled except `.sec-play`, `.spk-play`, `#btn-report-print` and links (Google Docs, downloads).
- `api()` callers: any response with `locked:true` sets `state.lock = { held:false, holder }` and re-renders read-only, and shows the banner.

- [ ] **Step 1: Failing browser tests:** meeting payload with `lock:{held:false, holder:{name:'Ann'}}` renders the banner naming Ann and disables `#fix-from` and `#btn-report` but not `.sec-play`; a 423 `locked:true` reply to a PATCH flips an editable page to read-only; `showList()` sends `DELETE /api/meetings/42/lock`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `feat(meeting-minutes): read-only meeting page while someone else edits`.
