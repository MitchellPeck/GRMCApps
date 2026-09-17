import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { requirePermission } from "../guard";
import { listRequests } from "../requests";
import { ReportRow, spendByCode, toCsv } from "../reports";
import { stageOf } from "../lifecycle";

interface Filters {
  from?: string;
  to?: string;
  status?: string;
  chargeCode?: string;
}

async function filteredRows(f: Filters): Promise<ReportRow[]> {
  const rows = await listRequests(pool);
  return rows
    .filter((r) => {
      const d = r.request_date ?? "";
      if (f.from && d && d < f.from) return false;
      if (f.to && d && d > f.to) return false;
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
    }));
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/reports/by-code", { preHandler: requirePermission("manage") }, async (req) => {
    const rows = await filteredRows(req.query as Filters);
    const totals = spendByCode(rows);
    return {
      ok: true,
      totals,
      grandTotal: Math.round(totals.reduce((s, t) => s + t.total, 0) * 100) / 100,
    };
  });

  app.get("/api/export.csv", { preHandler: requirePermission("manage") }, async (req, reply) => {
    const rows = await filteredRows(req.query as Filters);
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="grmc-expenses-${stamp}.csv"`)
      .send(toCsv(rows));
  });
}
