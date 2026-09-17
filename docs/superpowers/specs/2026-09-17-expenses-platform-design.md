# Expenses Platform — Design

**Date:** 2026-09-17
**Status:** Approved for implementation
**Scope:** The `expenses` app, plus one new endpoint on the hub.
**Builds on:** `2026-09-17-expenses-app-design.md` (the receipt-extraction app this expands)

## Problem

The expenses app produces a PDF with wet-signature lines. Approval happens on
paper, nothing tracks whether a request was approved, anyone with app access can
do anything, the card is free text, and receipts are discarded after extraction.

The goal is a digital approval workflow that covers pre-purchase authorization
and post-purchase submission, for both church-card spending and personal
reimbursements — without losing the paper path while the office transitions, and
without losing anything the app does today.

## The core model: two independent dimensions

Every request carries a **kind** and a **payment method**. They are orthogonal,
and together they decide which fields apply:

| | `church_card` | `reimbursement` |
|---|---|---|
| **`pre_purchase`** | Estimate, card, no receipts yet | Estimate, no card, no receipts yet |
| **`post_purchase`** | Actual, card, receipts required | Actual, no card, receipts required, **money owed** |

This is deliberately not a four-value type enum. The card field exists only for
church-card requests; the reimbursement-payment step exists only for
reimbursements. Each field answers to exactly one dimension.

## Status vs. milestones

`status` keeps the Approvals app's vocabulary — `pending`,
`changes_requested`, `rejected`, `approved` — and covers **only the approval
decision**. Everything after approval is a timestamped milestone:
`approved_at`/`approval_method`, `actuals_completed_at`,
`reimbursed_at`/`reimbursed_by_email`/`reimbursement_reference`.

The stage shown on screen is a **pure function** of those fields:

| Condition | Stage |
|---|---|
| `status = pending` | Awaiting approval |
| `status = changes_requested` | Changes requested |
| `status = rejected` | Rejected |
| `approved`, `pre_purchase`, no `actuals_completed_at` | Approved — awaiting receipts |
| `approved`, `reimbursement`, no `reimbursed_at` | Approved — awaiting reimbursement |
| otherwise | Complete |

Deriving the stage rather than storing it means the two can never disagree, and
one tested function defines the whole lifecycle.

## Permissions

A per-app permission table in the expenses database, keyed by lower-cased email.
The hub decides **who can open the app**; this decides **what they can do in it**.

| Permission | Grants |
|---|---|
| `submit` | Create requests for yourself |
| `submit_for_others` | *Purchased by* and *Submitted by* become pickers over GRMCApps users, plus free text for someone not on GRMCApps. Without it, both are locked to your own name |
| `edit_own` | Edit your own requests, only while `pending` or `changes_requested` |
| `approve` | Decide requests **assigned to you** |
| `manage` | Implies `approve`. Decide, edit and act on **anyone's** requests; mark reimbursed; edit charge codes |
| `admin` | Manage permissions, cards and settings. Implies nothing else |

`admin` implying nothing mirrors the hub's admin flag, so appointing someone to
maintain the card list does not hand them sight of every expense.

Guard rails, reusing the hub's tested rule rather than writing a second one:
**the last active admin cannot be demoted or removed**, and if no admin exists,
`mitchell.peck@graceresurrection.org` is restored on boot.

Each user may also have a **default approver**, pre-filled on their new requests.

### Self-approval

A user cannot approve their own request, `manage` included. This is the control
that makes the workflow worth having. Because a very small staff could deadlock
(one submitter who is also the only approver), Settings carries
`allow_self_approval`, **off** by default. Turning it on is a deliberate,
recorded choice rather than an accident of who happens to hold permissions.

### Users with app access but no permissions

No row is auto-created. The admin screen lists **everyone the hub has granted
the app**, whether or not they have a permission row, so a new person appears
ready to be ticked rather than having to be hunted for. A row is written the
first time a permission is set. A user with no permissions sees an explanatory
empty state, not an error.

## The hub change

The expenses app has its own database and role and cannot read the hub's users,
but every picker in this design needs them. The hub gains:

```
GET /api/users            → active users: { id, email, name }
GET /api/users?app=<slug> → only those granted that app
```

Session-authenticated with the same sibling-origin CORS as the existing
`/api/apps`, and called **from the browser**, not server-to-server — so no
service-to-service credential is introduced. The expenses server validates
against its own permission table, which is the authority for what anyone may do.

**Accepted trade-off:** any signed-in user can enumerate names and emails. This
matches what `/api/apps` already allows, and the hub is invite-only, so the
audience is staff who appear in a shared directory anyway.

## Cards

```sql
CREATE TABLE cards (
  id            bigserial PRIMARY KEY,
  last4         text NOT NULL,
  nickname      text NOT NULL,
  primary_email text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE card_users (           -- additional authorized users
  card_id bigint NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  email   text NOT NULL,
  PRIMARY KEY (card_id, email)
);
```

Only `last4` is stored — never a full number. The *Charged to which card* free
text becomes a dropdown of cards where the signed-in user is the primary holder
or an additional user, labelled `<nickname> ••<last4>`. Someone submitting on
another's behalf sees the cards available to the **person who made the
purchase**, not their own.

## Receipts

```sql
CREATE TABLE receipts (
  id                bigserial PRIMARY KEY,
  request_id        bigint NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  file_name         text NOT NULL,
  mime_type         text NOT NULL,
  byte_size         integer NOT NULL,
  content           bytea NOT NULL,
  uploaded_by_email text NOT NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now()
);
```

Bytes live in the database, exactly as the Approvals app stores image bytes.
This makes `expenses` the largest database in the stack; it is also what makes
digital approval mean anything, since otherwise an approver is confirming a
typed-in number with no way to check it.

**The generated PDF does not change.** It keeps the itemized line-item pages,
which print and file better in black and white than receipt scans. Receipts are
viewed in the app beside the line items, with a separate *Download receipts*
action for anyone who needs the full packet.

Receipts attach through `POST /api/requests/:id/receipts` **after** the request
exists, rather than being carried through the extraction call. The same endpoint
serves the pre-purchase completion flow, where receipts necessarily arrive days
after the request was created.

## Overage on completion

An approved pre-purchase request is completed by adding actual amounts and
receipts. Settings hold a tolerance — default **10% or $25, whichever is
greater**:

```
threshold = max(estimate × tolerance_pct, tolerance_abs)
reapprove = (actual − estimate) > threshold
```

Within tolerance the request closes out. Beyond it, status returns to `pending`
and the approver sees estimate and actual side by side. Taking the greater of
the two bounds avoids re-approving a $2 sales-tax difference on a small
purchase while still catching a real overrun on a large one.

## Audit trail

```sql
CREATE TABLE request_events (
  id          bigserial PRIMARY KEY,
  request_id  bigint NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  type        text NOT NULL,
  actor_email text NOT NULL,
  actor_name  text NOT NULL DEFAULT '',
  comment     text NOT NULL DEFAULT '',
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

Event types: `submitted`, `approved`, `rejected`, `changes_requested`,
`approved_on_paper`, `comment`, `receipt_added`, `receipt_removed`,
`actuals_completed`, `reapproval_required`, `reimbursed`, `edited`.

Rendered as a timeline on each request. Comments use the same table, so the
comment thread is the audit trail rather than a parallel structure.

## Requests table migration

Existing columns are kept. `purchased_by`, `submitted_by`, `approved_by` and
`card` remain text, because they are what the PDF prints and because a request
may name someone who is not a GRMCApps user at all. Identity columns are added
beside them.

```sql
ALTER TABLE requests ADD COLUMN IF NOT EXISTS kind                text NOT NULL DEFAULT 'post_purchase';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS payment_method      text NOT NULL DEFAULT 'church_card';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS status              text NOT NULL DEFAULT 'approved';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS card_id             bigint REFERENCES cards(id) ON DELETE SET NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS submitted_by_email  text NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS purchased_by_email  text NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS approver_email      text NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS approval_method     text;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS approved_at         timestamptz;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS approved_by_email   text;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS estimated_amount    numeric(12,2);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS actuals_completed_at timestamptz;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS reimbursed_at       timestamptz;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS reimbursed_by_email text;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS reimbursement_reference text;
```

The column defaults describe exactly what every existing row already is: a
post-purchase church-card expense that was approved on paper. A **once-only
backfill**, guarded on `to_regclass('request_events') IS NULL` evaluated
*before* the DDL runs — the same structurally-once pattern as the hub's
grandfather migration — additionally sets `approval_method = 'paper'` and
`approved_at = created_at` on those rows, and writes an `approved_on_paper`
event for each.

This is the transition log the physical-to-digital move needs: paper-era
requests sit in the same history as digital ones, correctly labelled, rather
than in a separate world.

## API

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/me` | any — returns identity **and effective permissions** |
| `POST` | `/api/extract` | `submit` |
| `GET` | `/api/requests` | any — all requests, see *History scope* |
| `GET` | `/api/requests/:id` | any — all requests, see *History scope* |
| `POST` | `/api/requests` | `submit` |
| `PATCH` | `/api/requests/:id` | `edit_own` (own, pending/changes_requested) or `manage` |
| `DELETE` | `/api/requests/:id` | `manage` |
| `POST` | `/api/requests/:id/decision` | `approve` (assigned) or `manage` |
| `POST` | `/api/requests/:id/paper-approval` | `approve` or `manage` |
| `POST` | `/api/requests/:id/actuals` | submitter or `manage` |
| `POST` | `/api/requests/:id/reimburse` | `manage` |
| `POST` | `/api/requests/:id/comments` | anyone who can view it |
| `GET`/`POST`/`DELETE` | `/api/requests/:id/receipts[/:rid]` | submitter or `manage`; **GET** also the approver |
| `GET` | `/api/queue` | any — requests awaiting this user, with a count |
| `GET` | `/api/export.csv` | `manage` |
| `GET` | `/api/reports/by-code` | `manage` |
| `GET`/`PUT`/`DELETE` | `/api/permissions[/:email]` | `admin` |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/cards[/:id]` | `admin` |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/charge-codes[/:id]` | `manage` |
| `GET`/`PUT` | `/api/settings` | `admin` |

`GET /api/me` returning effective permissions is what lets the UI hide what the
user cannot do; the server re-checks every one of them regardless.

### History scope

Everyone with app access sees every request and its detail, as decided for the
original app. Permissions govern what can be **done**, not what can be seen — a
church office where approvals are a shared responsibility.

**Receipt bytes are the one exception**, requiring submitter, approver or
`manage`. This is not squeamishness about spending: a receipt is a scan of an
original document and routinely carries a home address, a partial card number
and a signature — the Amazon order documents used to build this app each print
the buyer's home address in full. The metadata of a purchase is shared; the
image of the receipt is not.

## UI

Tabs: **New request**, **Awaiting you** (count badge), **History**,
**Reports**, **Settings**. Tabs and controls the user's permissions do not allow
are hidden.

- **New request** — kind and payment method chosen first, which drives the rest
  of the form. The card dropdown appears only for church-card; the approver
  dropdown lists users with `approve`, defaulted to the submitter's default
  approver. *Purchased by* / *Submitted by* are locked to the signed-in user
  unless `submit_for_others`, where each becomes a picker with free-text entry.
  Receipt import and the item table are unchanged.
- **Awaiting you** — pending requests assigned to this user, and for `manage`
  all pending requests. The badge count also appears on the header.
- **History** — every request with stage, kind, payment method, amount and
  submitter; filters by stage, person, charge code and date.
- **Request detail** — line items, receipts, the event timeline, a comment box,
  and whichever actions the viewer's permissions allow.
- **Reports** — spend by charge code over a date range, plus the CSV export.
- **Settings** — Permissions and Cards (`admin`), Charge codes (`manage`),
  defaults, tolerance, self-approval toggle and the Anthropic key (`admin`).

## Testing

Pure functions carry the logic, per the repo's pattern:

- `effectivePermissions` — `manage` implies `approve`; `admin` implies nothing.
- `stageOf` — all six stages, including the two that depend on payment method.
- `checkDecision` — assigned approver may; a stranger may not; `manage` may;
  self-approval refused; permitted when `allow_self_approval` is on; a decided
  request cannot be decided twice; `request_changes` requires a comment.
- `checkEdit` — own while pending; own after approval refused; another's refused
  without `manage`; permitted with it.
- `needsReapproval` — within percentage; within absolute; beyond both; the
  greater-of rule at small and large estimates; under-spend never re-approves.
- `visibleCardsFor` — primary holder, additional user, neither, inactive cards.
- `checkAdminChange` — last active admin refused across demote and delete.
- `requiredFields` — card required only for church card; receipts required only
  post-purchase; estimate required only pre-purchase.
- `csvRows` / `spendByCode` — grouping, totals, date filtering, escaping.

## Phasing

Each phase leaves working software:

1. **Permissions** — hub `/api/users`, permission table, `/api/me`, admin screen, guards.
2. **Cards** — card CRUD, card dropdown, approver dropdown, default approver.
3. **Workflow** — kind/payment, status machine, decisions, paper approval, receipt storage, audit timeline.
4. **Completion** — pre-purchase actuals, overage re-approval, reimbursement tracking.
5. **Extras** — awaiting-you queue and badge, comments, CSV export, spend summary.

## Out of scope

- Email notification. Nothing in the stack sends transactional mail; the event
  table is shaped so a sender can be added later without rework.
- Multi-step or threshold-based approval chains (a second approver above an
  amount). Plausible later; no demand now.
- Budgets and encumbrance against charge codes.
- Editing an approved request. It is re-submitted or superseded, never silently
  altered after the decision.
