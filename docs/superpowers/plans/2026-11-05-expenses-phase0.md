# Expenses Phase 0 — Correctness & Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the workflow, control and data-integrity bugs from the board review before the role-based redesign.

**Architecture:** Every rule about who may do what to a request moves into pure, unit-tested checks in `lifecycle.ts`, plus a pure `allowedActions()` the API returns so the UI stops mirroring rules. Every state change runs inside one transaction that locks the row (`SELECT … FOR UPDATE`), checks an optimistic `version`, writes the change and its audit event, then commits. Input validation lives in a new pure `validate.ts`.

**Tech Stack:** Fastify 5, Postgres (`pg`), TypeScript, `node:test`; vanilla JS frontend.

**Spec:** `docs/expenses-board-review.md` (Phase 0 table + foundation items 1, 2, 4)

## Global Constraints

- Paths relative to `apps/expenses/src/`. Amounts stay `numeric(12,2)`; money comparisons use a ±0.005 epsilon.
- Schema stays idempotent DDL in `schema.ts` (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`); backfills are idempotent `UPDATE … WHERE x IS NULL`.
- Owner of a request = submitter **or** purchaser (`purchased_by_email`, when set). Self-approval is blocked against both.
- Copy is plain English and tells the user what to do next.
- Route tests run against `TEST_DATABASE_URL` (local Postgres `expenses_test`) and skip when it is unset.

## Review Focus

1. A request in `changes_requested`, edited by its owner, must be resubmittable and reach the approver's queue — route test.
2. An approver acting on a stale page (version mismatch) gets 409 `stale`, never approves numbers they did not see — route test.
3. The assistant keys the pastor's purchase naming the pastor as approver — 400 on create, 403 on decision — unit + route test.
4. Receipt upload that fails part-way stores nothing — route test (11 files / unsupported mix).
5. A paid reimbursement cannot be withdrawn, voided, re-paid or edited — unit tests on checks.

---

### Task 1: Schema, version and transactional helpers

**Files:** Modify `schema.ts`, `requests.ts`, `events.ts`, `db.ts`, `package.json`; Create `requests.route.test.ts` (harness only)

**Produces:**
- Columns: `requests.version int NOT NULL DEFAULT 0`, `approved_amount numeric(12,2)`, `voided_at timestamptz`, `voided_by_email text`, `void_reason text`. Indexes: `receipts(request_id)`, `requests(status)`, `requests(approver_email)`. Trigger `request_events_no_update` raising on UPDATE. Backfill `approved_amount` for `status='approved'` rows.
- `type Db = { query: Pool["query"] }`; `addEvent(db: Db, …)`.
- `withRequest<T>(pool, id, fn: (db: PoolClient, found) => Promise<T>): Promise<T | null>` — BEGIN, `getRequest(client, id, { forUpdate: true })`, fn, COMMIT; ROLLBACK on throw; `null` when not found.
- `updateRequest(db, id, patch)`, `approveRequest(db, id, {method, byEmail, at})` (sets `approved_amount` = estimate when pre-purchase without actuals, else amount), `returnForReapproval(db, id)` (status pending, clears approval_method/at/by), `setStatus(db, id, status)`, `completeActuals(db, …)`, `markReimbursed(db, …)`, `voidRequest(db, id, byEmail, reason)`; every UPDATE bumps `version`.
- `ExpenseRequest` gains `purchased_by_email`, `version`, `approved_amount`, `voided_at`; status gains `"voided"`, stage gains `"Voided"`.
- `npm test` script passes dummy `EXPENSES_DB_*` env like meeting-minutes.

### Task 2: Pure rules in lifecycle.ts

**Produces** (all `(req, actorEmail, perms, …) => CheckResult`):
- `isOwner(req, email)`.
- `checkDecision(..., action, comment, allowSelf)`: self check vs owner; comment required for `reject` and `request_changes`.
- `checkEdit`: owner while pending/changes_requested; manage also approved; nobody once `reimbursed_at`.
- `checkResubmit`: status `changes_requested`; owner or manage.
- `checkDelete` → `{mode:"hard"}` only when undecided and `approved_amount === null`; `{mode:"withdraw"}` for owner/manage on approved pre-purchase without actuals; otherwise 409 ("This money has already been spent, so the request stays on the record. Ask the office if something is wrong." / manage: "Use Void to take this off the books with a reason.").
- `checkVoid(req, perms, reason)`: manage; not voided/withdrawn; not reimbursed; reason required.
- `checkActuals`: owner or manage; approved pre-purchase; not already completed.
- `checkReimburse`: manage; reimbursement; approved; actuals done for pre-purchase; not already paid; actor is not owner ("Someone else must record paying you.").
- `checkAddReceipts`: owner or manage; not rejected/withdrawn/voided.
- `reapprovalAfterEdit(prevStatus, approvedAmount, newAmount, pct, abs)` compares against `approved_amount ?? amount`.
- `allowedActions(req, email, perms, allowSelf) → { edit, resubmit, decide, paperApprove, completeActuals, reimburse, withdraw, delete, void, addReceipts, comment }`.
- Tests: each rule's allow/deny incl. assistant-keyed self-approval, paid-cannot-withdraw, double actuals, double pay, self pay.

### Task 3: validate.ts

**Produces:** `isIsoDate(s)`, `notFuture(s, today)`, `parseMoney(v): number | null` (finite, ≥0, rounded to cents), `itemsMatch(items, amount)`, `validateSubmission(input, ctx) → string | null` with ctx `{ actorEmail, approverEmails, allowSelf, cardIdsForPurchaser }`. Rules: valid date not in future; reason required ("Say what this was for."); post-purchase amount > 0; pre-purchase estimate > 0; approver in list and not submitter/purchaser unless allowSelf; card required & in list for church_card; items sum = amount when items present (pre-purchase: skip); purchaser email, if given, looks like an email. Tests per rule.

### Task 4: Routes on the new rules

**Files:** `routes/requests.ts`, `routes/decisions.ts`, `routes/receipts.ts`, `guard.ts`, `routes/extract.ts`, `routes/charge-codes.ts`, `routes/cards.ts`, `routes/permissions.ts`, `app-users.ts`, `settings.ts`
- `requireMember` preHandler (any permission) on reads, comments, queue, extract. Numeric-id guard → 400.
- GET `/api/requests/:id` adds `allowed`. New `POST /:id/resubmit {comment?, version?}` → event `resubmitted`. New `POST /:id/void {reason, version?}` → event `voided`.
- All mutations through `withRequest`; `version` mismatch → 409 `{stale:true, error:"This request changed since you opened it. Reload to see the latest."}`; `version` required on decision and paper approval.
- Paper approval: `approvedOn` required ISO date, not future; `note` stored.
- Reimburse: `paidOn` required ISO date, not future.
- Receipts: all-or-nothing in one transaction with per-file `receipt_added` events (meta: size, sha256); RFC 5987 `content-disposition`; delete event names the file.
- Charge code / card delete refuse (409) when referenced; tolerance settings accept 0; `is_admin` strict boolean; default approver clearable.
- Route tests for Review Focus 1–4.

### Task 5: Reports

`reports.ts`: spend = approved, or actuals completed and not withdrawn/voided; CSV text-only neutralisation; columns add purchaser, card, approver, approval method/date, paid date/reference, voided; date filter excludes undated rows when a range is set.

### Task 6: Frontend (app.js)

Safe option building (no data in innerHTML); receipt-upload result checked with retry; approver list excludes self/purchaser; amount locked to item total; detail driven by `allowed`; `version` on every mutation with stale handling; resubmit banner + "Save and send back"; reject needs comment; inline paper-approval date + note; paid-date input; add receipts on detail; void with reason; estimate editable; new timeline labels; re-approval banner.

### Task 7: Data recheck script

`scripts/expenses-recheck.sh` — read-only SQL on the host via `docker compose exec postgres psql`: stuck `changes_requested`; approvals where approver = purchaser or submitter; withdrawn after payment; pending rows carrying approval fields; undated requests; amount ≠ item total.
