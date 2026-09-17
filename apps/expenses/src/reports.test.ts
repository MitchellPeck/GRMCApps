import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ReportRow, spendByCode, toCsv } from "./reports";

const rows: ReportRow[] = [
  { id: 1, request_date: "2026-09-01", amount: 100, charge_code: "5540", sub_charge_code: "5404", vendor: "Sweetwater", reason: "Converter", status: "approved", stage: "Complete", kind: "post_purchase", payment_method: "church_card", submitted_by_email: "a@grmc.app" },
  { id: 2, request_date: "2026-09-02", amount: 50.5, charge_code: "5540", sub_charge_code: "", vendor: "Amazon", reason: "Cable", status: "approved", stage: "Complete", kind: "post_purchase", payment_method: "church_card", submitted_by_email: "b@grmc.app" },
  { id: 3, request_date: "2026-09-03", amount: 999, charge_code: "7000", sub_charge_code: "", vendor: "Adobe", reason: "Software", status: "rejected", stage: "Rejected", kind: "post_purchase", payment_method: "church_card", submitted_by_email: "a@grmc.app" },
];

test("spendByCode totals only money that was actually approved", () => {
  // The rejected 7000 request is not spend, so that code does not appear.
  assert.deepEqual(spendByCode(rows), [{ chargeCode: "5540", total: 150.5, count: 2 }]);
});

test("spendByCode rounds to cents", () => {
  const out = spendByCode([{ ...rows[0], amount: 0.1 }, { ...rows[1], amount: 0.2 }]);
  assert.equal(out[0].total, 0.3);
});

test("toCsv writes a header and one row per request", () => {
  const csv = toCsv(rows.slice(0, 1));
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^id,date,amount,/);
  assert.match(lines[1], /^1,2026-09-01,100/);
});

test("toCsv quotes and escapes fields containing commas and quotes", () => {
  const csv = toCsv([{ ...rows[0], vendor: 'Smith, "Bob" & Co' }]);
  assert.match(csv, /"Smith, ""Bob"" & Co"/);
});

test("toCsv never lets a field start a spreadsheet formula", () => {
  // A vendor named "=1+1" must not evaluate when the file is opened in Excel.
  const csv = toCsv([{ ...rows[0], vendor: "=1+1" }]);
  assert.equal(csv.includes("\n=1+1") || csv.includes(",=1+1"), false);
  assert.match(csv, /'=1\+1/);
});

test("toCsv neutralises every dangerous lead character", () => {
  for (const lead of ["=", "+", "-", "@"]) {
    const csv = toCsv([{ ...rows[0], vendor: `${lead}danger` }]);
    assert.match(csv, new RegExp(`'\\${lead}danger`));
  }
});

test("an empty set still produces a header", () => {
  assert.match(toCsv([]).trim(), /^id,date,amount,/);
});
