import type { ChargeCodeNode } from "./charge-codes";

export interface DocItem {
  title: string;
  price: number;
}

export interface DocExtraction {
  items: DocItem[];
  vendor: string;
  shipping: number;
  tax: number;
  discount: number;
}

export type DocResult =
  | { doc: string; ok: true; result: DocExtraction }
  | { doc: string; ok: false };

export type AutoType = "shipping" | "tax" | "discount";

export interface CombinedItem {
  title: string;
  price: number;
  autoType?: AutoType;
}

export interface Combined {
  items: CombinedItem[];
  vendor: string;
  failed: string[];
}

// A currency amount anywhere is the signal that a page actually carries a
// receipt. Length alone is not: pdf2md returns ~98 characters of browser print
// header for an image-only invoice, and a long prose page with no amount on it
// still yields no line items. When this returns false the caller re-sends the
// original PDF, which the model reads natively.
const CURRENCY = /\$\s?\d|(?:^|\s)\d+\.\d{2}(?:\s|$)/;

export function looksExtractable(markdown: string): boolean {
  const text = (markdown ?? "").trim();
  if (text.length < 120) return false;
  return CURRENCY.test(text);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function combineDocs(results: DocResult[]): Combined {
  const items: CombinedItem[] = [];
  const vendors: string[] = [];
  const failed: string[] = [];
  let shipping = 0;
  let tax = 0;
  let discount = 0;

  for (const r of results) {
    if (!r.ok) {
      failed.push(r.doc);
      continue;
    }
    for (const it of r.result.items ?? []) {
      const title = String(it?.title ?? "").trim();
      const price = Number(it?.price) || 0;
      // Both are required, as in the original: a titleless row or a zero price
      // is noise from a mis-read table.
      if (title && price) items.push({ title, price });
    }
    shipping += Number(r.result.shipping) || 0;
    tax += Number(r.result.tax) || 0;
    discount += Number(r.result.discount) || 0;
    const v = String(r.result.vendor ?? "").trim();
    if (v && !vendors.some((x) => x.toLowerCase() === v.toLowerCase())) vendors.push(v);
  }

  // Fees are summed here rather than by the model: arithmetic over already
  // extracted numbers should be reproducible.
  if (Math.abs(shipping) >= 0.005) {
    items.push({ title: "Shipping & Handling", price: round2(shipping), autoType: "shipping" });
  }
  if (Math.abs(tax) >= 0.005) {
    items.push({ title: "Tax", price: round2(tax), autoType: "tax" });
  }
  if (Math.abs(discount) >= 0.005) {
    items.push({ title: "Discount / Promo", price: -Math.abs(round2(discount)), autoType: "discount" });
  }

  return { items, vendor: vendors.join(", "), failed };
}

export interface Classification {
  reason: string;
  chargeCode: string;
  subChargeCode: string;
}

// Validated against the LIVE taxonomy, so a code the model invented never
// reaches the form. A sub-code is only kept if it belongs to the chosen parent.
export function validateClassification(
  raw: { reason?: string; chargeCode?: string; subChargeCode?: string },
  tree: ChargeCodeNode[]
): Classification {
  const reason = String(raw?.reason ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\.$/, "")
    .trim();
  const codeRaw = String(raw?.chargeCode ?? "").trim();
  const subRaw = String(raw?.subChargeCode ?? "").trim();

  const parent = tree.find((c) => c.code === codeRaw) ?? null;
  const sub = parent ? parent.subs.find((s) => s.code === subRaw) ?? null : null;

  return {
    reason,
    chargeCode: parent ? parent.code : "",
    subChargeCode: sub ? sub.code : "",
  };
}
