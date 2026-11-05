# Expenses Phase 1 — roles, visibility, email, chart of accounts

**Goal:** Give each of the four users (submitter, approver, office assistant, CPA) the right rights and the right view, tell people by email when something needs them, and map charge codes to GL accounts.

**Architecture:** Two new permission flags (`can_pay`, `can_audit`). `manage` stops implying approve, so the assistant can prepare and pay without approving. Row visibility is enforced in SQL and in one `canSee` rule. Notifications go into a `notifications` outbox inside the same transaction as the audit event. An in-process sender delivers them through the Resend HTTP API with retries. Charge codes gain a `gl_account`.

**Tech stack:** Fastify 5, pg, TypeScript, node:test + `fastify.inject` against local Postgres. The Resend REST API is called with `fetch`, so no SDK is needed.

**Spec:** `docs/expenses-board-review.md` (role model, approver/assistant/CPA highlights, foundation item 5). User decisions: Resend, simple COA mapping.

## Global constraints
- The new permissions migration must keep every existing user able to do what they could do before:
  - `can_pay := can_manage`
  - `can_approve := can_approve OR can_manage`
  - It runs once only, inside a `DO` block guarded by the absence of `can_pay`.
- When mail is not configured (no key or no from address), nothing is queued, so turning mail on later never floods anyone.
- No email goes to the person who caused the event.
- Plain-English copy throughout. Users are non-technical.
- Never run anything against the production database from the build Mac.

## Roles (presets on the admin matrix; the flags stay editable)

| Preset | submit | for others | approve | office (manage) | pay | read all (audit) |
|---|---|---|---|---|---|---|
| Submitter | ✓ | | | | | |
| Approver | ✓ | | ✓ | | | |
| Office assistant | ✓ | ✓ | | ✓ | ✓ | |
| Accountant (CPA) | | | | | | ✓ |

Derived values:
- `approveAny = approve && manage`
- `viewAll = manage || pay || audit`
- `reports = manage || pay || audit`

## Tasks

### Task 1: Permissions, migration and visibility
- `schema.ts`: a `DO` block that adds `can_pay` and `can_audit` and runs the backfill once.
- `permissions.ts`:
  - `PermissionRow` gains `can_pay` and `can_audit`.
  - `Permissions` gains `pay`, `audit`, `approveAny`, `viewAll` and `reports`.
  - `manage` no longer implies `approve`.
  - `ROLE_PRESETS` is exported.
- `app-users.ts`: columns and upsert updated. `listApprovers` returns `can_approve` users only.
- `routes/permissions.ts`: accepts `can_pay`, `can_audit` and `role`. A role preset sets all six flags in one call.
- `lifecycle.ts`:
  - New `canSee(req, email, perms)`: `viewAll`, an owner, the creator, or the assigned approver.
  - `checkDecision` lets an approver act on any request only with `approveAny`.
  - `checkReimburse` requires `pay`.
  - New `checkPaperApproval`: the approver, or the office recording a signed paper form for the assigned approver.
- `requests.ts`: `listRequests(pool, scope?: {email, all})` filters in SQL.
- Routes:
  - GET list, GET by id, receipts, receipt file and comments: a request the user can't see returns 404.
  - Queue: `approveAny`, else assigned to me.
  - Reports require `reports`.
  - `requireMember` also admits `pay` and `audit` users.
- Tests:
  - `permissions.test.ts`: presets, and that manage no longer implies approve.
  - `lifecycle.test.ts`: `canSee`; an assistant can't approve but can pay; paper approval by the office.
  - Route test: a submitter can't list or open someone else's request (404); the CPA sees everything but changes nothing (403).

### Task 2: Notification outbox and Resend sender
- `schema.ts`: `notifications(id, request_id, to_email, kind, subject, body, status pending|sent|failed, attempts, last_error, next_attempt_at, created_at, sent_at)`.
- `notify.ts` (pure):
  - `notificationsFor(type, req, ctx: {actorEmail, comment, meta, payers, appUrl, orgName}) → Draft[]`.
  - Rules: `submitted`/`resubmitted`/`reapproval_required` → the approver.
  - `approved`/`approved_on_paper`/`rejected`/`changes_requested`/`voided` → the owners.
  - An approved reimbursement that is ready to pay → the payers.
  - `actuals_completed` on a reimbursement, still approved → the payers.
  - `reimbursed` → the payee.
  - `comment` → the owners and the approver.
  - Remove the actor, dedupe, drop blanks.
- `events.ts`: `addEvent` calls `queueNotifications(db, …)` for notifiable types, in the same transaction.
- `mailer.ts`:
  - `sendViaResend(fetchFn, key, from, n)`: POST `https://api.resend.com/emails` with the `Idempotency-Key: expenses-<id>` header and a 10 s timeout.
  - `deliverPending(pool, fetchFn)`: up to 10 due rows, `FOR UPDATE SKIP LOCKED`.
  - Backoff `attempts² minutes`; marked `failed` after 5 tries.
  - `startMailer(pool, log)` runs every 20 s.
- Settings: `resend_api_key` (secret, hint only) and `mail_from`.
- `POST /api/settings/test-email` (admin) sends to the caller immediately.
- `config.appUrl`: from `APP_URL`, else `https://expenses.${BASE_DOMAIN}`.
- Tests:
  - `notify.test.ts`: recipients per event, no self-mail, a deep link in the body.
  - `mailer.test.ts`: success marks the row sent; a 500 schedules a retry; the 5th failure marks it failed; no key means nothing is sent.
  - Route test: a submission queues a row for the approver when mail is configured, and nothing when it isn't.

### Task 3: Chart-of-accounts mapping
- `charge_codes.gl_account text NOT NULL DEFAULT ''`. Create and PATCH accept `glAccount`. The tree carries `gl_account`.
- `glAccountFor(chargeCode, subCode, rows)`: the sub-code's GL, else the parent's GL, else the parent code itself (blank means "same as the code").
- Reports:
  - The ledger CSV gains a `gl_account` column.
  - New `GET /api/export-gl.csv`: spend per GL account for the period (`gl_account, count, total`).
- Tests: `charge-codes.test.ts` covers the fallback order; `reports.test.ts` covers the GL totals.

### Task 4: Screens
- Admin matrix:
  - A Role dropdown (presets, plus "Custom" when the flags match no preset).
  - Columns renamed: Submit, For others, Approve, Office, Pay, Read all, Admin.
  - The hint text is updated.
- Tabs:
  - "New request" is hidden without `submit`; Reports uses `data-needs="reports"`.
  - Landing tab: Reports for audit-only users; "Awaiting you" when the queue has items.
- Deep links: `#/r/<id>` opens a request. `openDetail` sets the hash, and a hash on load opens it.
- Charge codes: a GL account input on add, and an inline GL edit on each line.
- Reports: a "Download GL summary" button.
- Settings: an "Email notifications" card with the from address, the Resend key (with hint) and "Send me a test email".

### Task 5: Leftovers from Phase 0
- The Anthropic client gets a 60 s timeout and 1 retry.
- The image types accepted for upload and for extraction are made to agree.
- Dockerfile: `COPY package-lock.json` and use `npm ci`.

## Review focus
1. A user with only `audit` presses an action button through the API: every mutation is refused with 403.
2. An office assistant who is also the purchaser records paying themselves: refused.
3. Mail key set but Resend down: a submission still succeeds, and the row retries later.
4. A deep link to a request the user can't see: they get a "not found" message, not a blank page.
5. Turning off approve for the office after migration: a reboot does not turn it back on (the one-shot guard).
