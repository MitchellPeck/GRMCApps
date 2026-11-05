# Expenses — board review (2026-11-05)

Six read-only reviewers: simple submitter, approver, administrative assistant,
CPA, visual/accessibility designer, and a correctness/security engineer. Paths
are relative to `apps/expenses/src/`. Findings marked ✔ were re-verified by hand.

## Phase 0 — Bugs and controls to fix first

| # | Finding | Evidence | Fix |
|---|---|---|---|
| 1 ✔ | **"Changes requested" is a dead end** (found by 5 of 6 reviewers). Nothing moves `changes_requested` back to `pending`; the submitter edits, it stays stuck, no queue shows it, nobody can decide it. | `routes/requests.ts:116-177`, `lifecycle.ts:110,208`, queue filter `routes/requests.ts:223` | Resubmit transition → `pending` + `resubmitted` event; button "Send back to {approver}" |
| 2 ✔ | **Self-approval bypass via submit-on-behalf.** Guard checks only `submitted_by_email` (the typist). The assistant keys the pastor's purchase, the pastor approves it. `purchased_by_email` is unvalidated free text. | `lifecycle.ts:107`, `requests.ts:156`, `routes/requests.ts:87` | Purchaser is the owner; `created_by` = "keyed by"; guard against submitter AND purchaser; validate purchaser |
| 3 | **Approve without a version check** — the submitter edits $50→$5,000 while the approver has the page open; Approve approves $5,000. Concurrent decisions race. | `routes/decisions.ts:35-52`, `requests.ts:226-245` | `UPDATE … WHERE status='pending' AND version=$seen`, in one transaction with the event; 409 on mismatch |
| 4 | **Overage creep** — tolerance compared against the current amount, not the approved amount, so a manager can step their own approved request up in sub-tolerance increments. `/actuals` can be re-posted after completion or payment. | `routes/requests.ts:165-168`, `routes/decisions.ts:86-116` | Snapshot `approved_amount`; compare against it; refuse a second `/actuals` |
| 5 | **Paid money can vanish.** A submitter can withdraw an already-reimbursed request (drops out of reports); a manager hard delete cascades away events and receipts. | `lifecycle.ts:170-180`, `reports.ts:29`, `schema.ts:41,97,108` | No withdraw after payment/completion; `voided` status instead of hard delete; RESTRICT foreign keys; append-only events |
| 6 | **Receipt upload after submit fails silently** — "Submitted" shows and queued files are discarded. | `public/app.js:432-439` | Check `res.ok` and `rejected`; keep files; retry |
| 7 | **No way to add receipts after submit** (route exists, no UI); pre-purchases get closed with no receipt. | `app.js:953-1012`, `routes/receipts.ts:55` | Drop zone + re-extract on the detail page; actuals completion uses the extract flow |
| 8 | Rejecting an overage erases spent money from reports. | `lifecycle.ts:132-136`, `reports.ts:26-29` | "Accept overage / Flag" decision; count pending re-approvals as committed spend |
| 9 | Paper-approval date via `prompt()` → a typo causes a 500. | `app.js:1115`, `decisions.ts:77` | Date input + note, validated |
| 10 | Unicode receipt filenames (macOS screenshots) → 500 on view. | `routes/receipts.ts:51` | RFC 5987 `filename*` |
| 11 | Stored XSS through datalist/select `innerHTML` (charge-code labels, card nicknames, user names). | `app.js:334,346,362,380,395,752,771,1232,1265,1318` | `new Option(text, value)` |
| 12 | No read permission: any hub user can list every request and call `/api/extract` (Anthropic spend). | `requests.ts:73-84`, `routes/extract.ts` | Row-level visibility by role; gate extract on submit |
| 13 | Approver/card not validated server-side (yourself or a non-approver → silently stuck); `cardId:null` → 500. | `routes/requests.ts:78,99,134` | Validate; exclude self from the approver list |
| 14 | Mark-paid repeatable and overwrites; paid date always today in the UI. | `decisions.ts:150-164`, `app.js:1137` | Idempotent; paid date, amount, method, payee |
| 15 | CSV: undated rows appear in every period; negative amounts become text. | `routes/reports.ts:20-21`, `reports.ts:50` | Require date; neutralise text columns only |

Smaller items: the receipt partial-upload loses events (`routes/receipts.ts:72-104`); no indexes on receipts.request_id / requests status, approver, date; migrations unversioned; the Dockerfile ignores the lockfile; a tolerance of 0 can't be configured (`|| 0.1`); HEIC/GIF mismatch between upload and extraction.

## Role model — the 4 users vs. today's permissions

Today: submit · submit-for-others · edit-own · approve · manage (= approve + edit any + delete + pay + reports) · admin (settings only). Everyone sees every request.

| User | Proposed rights | Lands on |
|---|---|---|
| Simple submitter | submit; sees own requests only | **My requests** — "Snap a receipt" + next step per request |
| Approver | submit + approve (assigned / delegated) | **To approve** (oldest first, age, overage delta) · My requests |
| Admin assistant | prepare (submit for others, edit, receipts, recode), pay — **not** approve their own or the payee's | **Workbench** — missing receipts, changes requested, awaiting actuals, awaiting payment, pay run |
| CPA | new read-only **auditor**: sees everything, changes nothing | **Reports / Close** — period package, exceptions |

`manage` is split into prepare, pay and approve-any, so that segregation of duties holds.

## Per-role highlights

**Submitter** — receipt-photo-first flow with extraction running on file choice; plain wording ("Have you bought it yet?", "How did you pay?", "What budget is this for?"); default to "My own money" when the user holds no card; amount locked to the line-item total; a confirmation screen ("Sent to Pastor X. Next: …"); draft autosave; "Copy into a new request"; no charge codes shown to simple users.

**Approver** — notifications (none exist today); deep links; queue split into assigned and others, sorted oldest first with age; re-approval banner "approved $X → now $Y"; stale approval badges cleared on re-approval; reassign + delegation/out-of-office; require a reason to reject; go to the next item after a decision; budgets per charge code with a burn bar and impact shown on the decision screen; amount-threshold routing.

**Admin assistant** — workbench queues; strict person picker (the card list doesn't reload when the purchaser changes, `app.js:355`); manage can edit kind, payment method, estimate and purchaser; server-side search and filters, a sortable table, URL routing and keyboard triage; batch pay run; card reconciliation (import statement CSV/OFX, auto-match, list unmatched charges → nudge the cardholder); missing-receipt nudges sent to the purchaser; manage can administer cards.

**CPA** — period close (`closed_through`) with adjusting entries; separate incurred / submitted / approved / paid dates; GL account + fund on charge codes, with line-level splits; journal-entry CSV / QuickBooks export; full-column ledger CSV; period zip of receipts + index + audit log; accountable-plan flags (60-day, business purpose, receipts required server-side, tax paid by an exempt org, duplicates); vendor master with a 1099 flag; charge codes and cards deactivated rather than deleted (`charge-codes.ts:80`, `schema.ts:82`).

**UI/accessibility** — unstyled grey `.btn` default (Reject looks like Back), `.btn-danger` never used; number/date inputs unstyled, 13px fields zoom on iOS, no `inputmode=decimal`; three different states share one gold badge; the receipt-upload button can't be reached by keyboard (`index.html:68-70`); contrast failures (`--hint` 3.16:1, `--pending-fg` 3.88:1, input borders 1.41:1, invisible focus); no landmarks, headings, `aria-live`, or tab roles; unlabeled filter and comment inputs; 9px "×" targets; 780px cap; native `prompt`/`confirm`; the PDF has no request number or approval record. Most are copy-across from meeting-minutes' readability overrides (lift them into `grmc.css`).

## Foundation work before the redesign

1. One transactional state-machine service (submit/resubmit/decide/actuals/pay/withdraw/void) with a version guard, `approved_amount`, and the event in the same commit.
2. Distinct validated identities: keyed-by, purchaser/payee, approver, payer.
3. Row-level visibility + indexes; pagination.
4. Route/DB integration tests (`fastify.inject` + throwaway Postgres) — the 96 existing tests cover only pure functions.
5. Notification outbox + mailer.
6. Split `app.js` (1,436 lines) into modules with one safe render helper; hash routing.
7. Versioned migrations.
