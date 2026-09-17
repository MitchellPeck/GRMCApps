import { strict as assert } from "node:assert";
import { test } from "node:test";
import { combineDocs, looksExtractable, validateClassification } from "./extract-logic";
import type { ChargeCodeNode } from "./charge-codes";

// Measured: @opendocsg/pdf2md on ~/Downloads/Sweetwater Invoice.pdf -> 98 chars,
// the browser print header only. The invoice body is a rasterized image.
const SWEETWATER_MD =
  "9/17/26, 11:27 AM Sweetwater Invoice https://www.sweetwater.com/myaccount/invoice/51940786 1/1";

// Measured: the same converter on ~/Downloads/order-document (2).pdf.
const AMAZON_MD = `Final Details for Order #111-2448202-9267416
**Order Placed:** September 16, 2026 **Order Total: USD 58.26**
Items Ordered Price 1 of: Amazon Basics Extension Cord, 10 Ft
## $6.98`;

test("an image-only receipt routes to the PDF fallback", () => {
  assert.equal(looksExtractable(SWEETWATER_MD), false);
});

test("a text-based receipt takes the cheap markdown path", () => {
  assert.equal(looksExtractable(AMAZON_MD), true);
});

test("a long page with no price is still not extractable", () => {
  // Length alone is the wrong signal: a receipt with no amount on it cannot
  // yield line items, however many words it has.
  assert.equal(looksExtractable("lorem ipsum ".repeat(80)), false);
});

test("a bare decimal counts as currency, not just a dollar sign", () => {
  assert.equal(looksExtractable("Total 16.41 for the order of parts " + "x".repeat(200)), true);
});

test("empty or whitespace markdown routes to fallback", () => {
  assert.equal(looksExtractable(""), false);
  assert.equal(looksExtractable("   \n  "), false);
});

test("combineDocs concatenates items and sums fees into three tagged rows", () => {
  const out = combineDocs([
    { doc: "a.pdf", ok: true, result: { items: [{ title: "Cable", price: 6.98 }], vendor: "Amazon.com", shipping: 6.99, tax: 0.93, discount: 0 } },
    { doc: "b.pdf", ok: true, result: { items: [{ title: "Converter", price: 85 }], vendor: "Sweetwater", shipping: 8.87, tax: 5.1, discount: -8.87 } },
  ]);
  assert.deepEqual(out.items.filter((i) => !i.autoType).map((i) => i.title), ["Cable", "Converter"]);
  const auto = Object.fromEntries(out.items.filter((i) => i.autoType).map((i) => [i.autoType, i.price]));
  assert.equal(auto.shipping, 15.86);
  assert.equal(auto.tax, 6.03);
  assert.equal(auto.discount, -8.87);      // stays negative
  assert.equal(out.vendor, "Amazon.com, Sweetwater");
  assert.deepEqual(out.failed, []);
});

test("a zero fee produces no row at all", () => {
  const out = combineDocs([
    { doc: "a.pdf", ok: true, result: { items: [{ title: "X", price: 5 }], vendor: "V", shipping: 0, tax: 0, discount: 0 } },
  ]);
  assert.equal(out.items.length, 1);
});

test("vendors are deduplicated case-insensitively", () => {
  const out = combineDocs([
    { doc: "a", ok: true, result: { items: [], vendor: "Amazon.com", shipping: 0, tax: 0, discount: 0 } },
    { doc: "b", ok: true, result: { items: [], vendor: "amazon.com", shipping: 0, tax: 0, discount: 0 } },
  ]);
  assert.equal(out.vendor, "Amazon.com");
});

test("a failed document is reported without losing the others", () => {
  const out = combineDocs([
    { doc: "good.pdf", ok: true, result: { items: [{ title: "X", price: 1 }], vendor: "V", shipping: 0, tax: 0, discount: 0 } },
    { doc: "bad.pdf", ok: false },
  ]);
  assert.equal(out.items.length, 1);
  assert.deepEqual(out.failed, ["bad.pdf"]);
});

test("items with no title or no price are dropped, as in the original", () => {
  const out = combineDocs([
    { doc: "a", ok: true, result: { items: [{ title: "", price: 5 }, { title: "Real", price: 0 }, { title: "Keep", price: 2 }], vendor: "V", shipping: 0, tax: 0, discount: 0 } },
  ]);
  assert.deepEqual(out.items.map((i) => i.title), ["Keep"]);
});

test("floating point fee sums are rounded to cents", () => {
  // 0.1 + 0.2 must not surface as 0.30000000000000004 on the form.
  const out = combineDocs([
    { doc: "a", ok: true, result: { items: [{ title: "X", price: 1 }], vendor: "V", shipping: 0.1, tax: 0, discount: 0 } },
    { doc: "b", ok: true, result: { items: [], vendor: "", shipping: 0.2, tax: 0, discount: 0 } },
  ]);
  assert.equal(out.items.find((i) => i.autoType === "shipping")!.price, 0.3);
});

const TREE: ChargeCodeNode[] = [
  { id: 1, code: "5540", label: "AV Streaming", subs: [{ id: 2, code: "5404", label: "AV Equipment", subs: [] }] },
  { id: 3, code: "9300", label: "Security System", subs: [] },
];

test("a valid code and sub-code pass through", () => {
  assert.deepEqual(
    validateClassification({ reason: "AV gear", chargeCode: "5540", subChargeCode: "5404" }, TREE),
    { reason: "AV gear", chargeCode: "5540", subChargeCode: "5404" }
  );
});

test("a hallucinated charge code is dropped rather than shown", () => {
  const out = validateClassification({ reason: "r", chargeCode: "9999", subChargeCode: "" }, TREE);
  assert.equal(out.chargeCode, "");
});

test("a sub-code belonging to a different parent is dropped", () => {
  const out = validateClassification({ reason: "r", chargeCode: "9300", subChargeCode: "5404" }, TREE);
  assert.equal(out.chargeCode, "9300");
  assert.equal(out.subChargeCode, "");
});

test("surrounding quotes and a trailing period are stripped from the reason", () => {
  assert.equal(validateClassification({ reason: '"AV gear"', chargeCode: "", subChargeCode: "" }, TREE).reason, "AV gear");
  assert.equal(validateClassification({ reason: "AV gear.", chargeCode: "", subChargeCode: "" }, TREE).reason, "AV gear");
});

test("missing fields are tolerated rather than throwing", () => {
  assert.deepEqual(validateClassification({}, TREE), { reason: "", chargeCode: "", subChargeCode: "" });
});
