import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { requirePermission } from "../guard";
import { seesReports } from "../permissions";
import { listRequests } from "../requests";
import { ReportRow, glCsv, inPeriod, spendByCode, spendByGl, toCsv } from "../reports";
import { glAccountFor, listChargeCodes } from "../charge-codes";
import { stageOf } from "../lifecycle";

interface Filters {
  from?: string;
  to?: string;
  status?: string;
  chargeCode?: string;
}

async function filteredRows(f: Filters): Promise<ReportRow[]> {
  const rows = await listRequests(pool);
  const codes = await listChargeCodes(pool);
  return rows
    .filter((r) => {
      if (!inPeriod(r.request_date, f)) return false;
      if (f.status && r.status !== f.status) return false;
      if (f.chargeCode && r.charge_code !== f.chargeCode) return false;
      return true;
    })
    .map((r) => ({
      id: r.id,
      request_date: r.request_date,
      amount: Number(r.amount) || 0,
      charge_code: r.charge_code,
      sub_charge_code: r.sub_charge_code,
      vendor: r.vendor,
      reason: r.reason,
      status: r.status,
      stage: stageOf(r),
      kind: r.kind,
      payment_method: r.payment_method,
      submitted_by_email: r.submitted_by_email,
      actuals_completed: !!r.actuals_completed_at,
      purchased_by: r.purchased_by_email || r.purchased_by,
      card: r.card_label ?? r.card,
      approver: r.approved_by_email ?? "",
      approval_method: r.approval_method ?? "",
      approved_at: r.approved_at ? new Date(r.approved_at).toISOString().slice(0, 10) : "",
      paid_on: r.reimbursed_at ? new Date(r.reimbursed_at).toISOString().slice(0, 10) : "",
      paid_reference: r.reimbursement_reference ?? "",
      voided_reason: r.void_reason ?? "",
      gl_account: glAccountFor(codes, r.charge_code, r.sub_charge_code),
    }));
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/reports/by-code", { preHandler: requirePermission(seesReports) }, async (req) => {
    const rows = await filteredRows(req.query as Filters);
    const codes = await listChargeCodes(pool);
    const totals = spendByCode(rows).map((t) => ({
      ...t,
      glAccount: t.chargeCode === "(none)" ? "" : glAccountFor(codes, t.chargeCode, ""),
    }));
    return {
      ok: true,
      totals,
      grandTotal: Math.round(totals.reduce((s, t) => s + t.total, 0) * 100) / 100,
    };
  });

  app.get("/api/export-gl.csv", { preHandler: requirePermission(seesReports) }, async (req, reply) => {
    const rows = await filteredRows(req.query as Filters);
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="grmc-expenses-gl-${stamp}.csv"`)
      .send(glCsv(spendByGl(rows)));
  });

  app.get("/api/export.csv", { preHandler: requirePermission(seesReports) }, async (req, reply) => {
    const rows = await filteredRows(req.query as Filters);
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="grmc-expenses-${stamp}.csv"`)
      .send(toCsv(rows));
  });
}
