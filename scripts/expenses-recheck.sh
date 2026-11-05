#!/usr/bin/env bash
# Look through the live expenses data for records hit by the bugs fixed in
# Phase 0 (docs/expenses-board-review.md). Read-only: every query is a SELECT.
# Run on the Docker host, from the repo root, BEFORE deploying the fix:
#
#   ./scripts/expenses-recheck.sh            # the report
#   ./scripts/expenses-recheck.sh backup     # pg_dump the expenses DB first
#
# Works against the old schema and the new one alike.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; . ./.env; set +a
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.remote.yml)
PSQL=("${COMPOSE[@]}" exec -T postgres psql -U "$EXPENSES_DB_USER" -d "$EXPENSES_DB_NAME" -v ON_ERROR_STOP=1 -P pager=off)

if [ "${1:-}" = "backup" ]; then
  out="$HOME/expenses-backup-$(date +%Y%m%d-%H%M%S).sql"
  "${COMPOSE[@]}" exec -T postgres pg_dump -U "$EXPENSES_DB_USER" "$EXPENSES_DB_NAME" > "$out"
  echo "Backup written: $out ($(wc -c < "$out") bytes)"
  exit 0
fi

section() { printf '\n=== %s ===\n' "$1"; }
q() { "${PSQL[@]}" -c "$1"; }

section "Stuck in 'changes requested' (could never be sent back — owners can resend after the deploy)"
q "SELECT r.id, r.request_date, r.amount, r.vendor, r.submitted_by_email, r.approver_email,
          (SELECT max(created_at) FROM request_events e WHERE e.request_id = r.id AND e.type = 'changes_requested') AS asked_on
     FROM requests r WHERE r.status = 'changes_requested' ORDER BY r.id;"

section "Approved by the person who bought it (submit-on-behalf loophole)"
q "SELECT id, request_date, amount, vendor, submitted_by_email, purchased_by_email, approved_by_email, approval_method
     FROM requests
    WHERE approved_by_email IS NOT NULL AND purchased_by_email <> ''
      AND lower(approved_by_email) = lower(purchased_by_email)
      AND lower(approved_by_email) <> lower(submitted_by_email)
    ORDER BY id;"

section "Approved by the submitter (only legitimate if self-approval was switched on)"
q "SELECT id, request_date, amount, vendor, submitted_by_email, approval_method, approved_at
     FROM requests
    WHERE approved_by_email IS NOT NULL AND lower(approved_by_email) = lower(submitted_by_email)
      AND approval_method = 'digital'
    ORDER BY id;"

section "Withdrawn after money was spent or paid (drops real spend out of reports)"
q "SELECT id, request_date, amount, kind, payment_method, actuals_completed_at, reimbursed_at
     FROM requests
    WHERE status = 'withdrawn'
      AND (reimbursed_at IS NOT NULL OR actuals_completed_at IS NOT NULL OR kind = 'post_purchase')
    ORDER BY id;"

section "Pending but still showing an old approval (re-approval left stale fields)"
q "SELECT id, amount, estimated_amount, approval_method, approved_by_email, approved_at, reimbursed_at
     FROM requests WHERE status = 'pending' AND approval_method IS NOT NULL ORDER BY id;"

section "Actuals recorded more than once, or paid more than once"
q "SELECT request_id, type, count(*) AS times
     FROM request_events WHERE type IN ('actuals_completed', 'reimbursed')
    GROUP BY request_id, type HAVING count(*) > 1 ORDER BY request_id;"

section "Reapproval rejected after the money was spent (spend that vanished from reports)"
q "SELECT id, amount, estimated_amount, actuals_completed_at FROM requests
    WHERE status = 'rejected' AND actuals_completed_at IS NOT NULL ORDER BY id;"

section "Undated requests (they appeared in every report period)"
q "SELECT id, amount, vendor, status, created_at FROM requests WHERE request_date IS NULL ORDER BY id;"

section "Amount does not match its line items (post-purchase or completed)"
q "SELECT r.id, r.amount, sum(i.price) AS items_total, r.status
     FROM requests r JOIN request_items i ON i.request_id = r.id
    WHERE r.kind = 'post_purchase' OR r.actuals_completed_at IS NOT NULL
    GROUP BY r.id HAVING abs(r.amount - sum(i.price)) >= 0.01 ORDER BY r.id;"

section "Zero or missing amounts on spent money"
q "SELECT id, kind, status, amount, vendor FROM requests
    WHERE status = 'approved' AND amount <= 0
      AND (kind = 'post_purchase' OR actuals_completed_at IS NOT NULL) ORDER BY id;"

section "Spent money with no receipt"
q "SELECT r.id, r.request_date, r.amount, r.vendor, r.submitted_by_email, r.approval_method
     FROM requests r
    WHERE r.status = 'approved' AND (r.kind = 'post_purchase' OR r.actuals_completed_at IS NOT NULL)
      AND COALESCE(r.approval_method, '') <> 'paper'
      AND NOT EXISTS (SELECT 1 FROM receipts x WHERE x.request_id = r.id)
    ORDER BY r.id;"
