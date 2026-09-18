import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import pdf2md from "@opendocsg/pdf2md";
import type { Pool } from "pg";
import { getSetting } from "./settings";
import { chargeCodeTree, listChargeCodes, ChargeCodeNode } from "./charge-codes";
import {
  Classification,
  Combined,
  DocResult,
  combineDocs,
  looksExtractable,
  validateClassification,
} from "./extract-logic";
import { heuristicSummary } from "./format";
import { withTimeout } from "./with-timeout";

const MODEL = "claude-opus-5";

// PDF-to-markdown conversion is local and fast — about a second for a typical
// receipt. Anything beyond this is a hang, not slow work, and the document
// takes the raw-PDF route instead, which is the more capable path anyway.
const MARKDOWN_TIMEOUT_MS = 20_000;

export const MISSING_KEY_ERROR = "No Anthropic API key. Go to Settings to add it.";

const DocSchema = z.object({
  items: z.array(z.object({ title: z.string(), price: z.number() })),
  vendor: z.string(),
  shipping: z.number(),
  tax: z.number(),
  discount: z.number(),
});

const ClassifySchema = z.object({
  reason: z.string(),
  chargeCode: z.string(),
  subChargeCode: z.string(),
});

// Carried over from the Artifact's perDocPrompt essentially verbatim. Every
// rule here was earned against real receipts: product line items only, fees
// reported separately, a "Free Shipping Promo: -$8.87" line is a discount
// rather than shipping, and the reminder that at least one item exists even
// when a description wraps across lines or a table column.
function docPrompt(name: string): string {
  return `You are extracting purchase details from ONE receipt/invoice document. Focus only on this document.

Tasks:
1. Extract every purchased product line item (title + price). Do NOT include shipping, handling, tax, discounts, or promos as items — report those separately below.
2. Identify the vendor/store this document is from as a whole (the company shown at the top of the receipt/invoice, e.g. "Amazon.com", "Sweetwater") as a short string.
3. Report the shipping/handling amount shown on this document as "shipping" (0 if none appears).
4. Report the tax amount shown on this document as "tax" (0 if none appears).
5. Report any discount, promo, or credit shown on this document as a NEGATIVE "discount" number (0 if none). Example: a line like "Free Shipping Promo: -$8.87" is a discount, not an item and not shipping.

This document has at least one purchased product line item somewhere in it — find it even if the description wraps across multiple lines or a table column.

Document: ${name}`;
}

export interface UploadedDoc {
  name: string;
  buffer: Buffer;
}

// Minimal logger surface so the Fastify request logger can be threaded in
// without this module importing Fastify.
export interface ExtractLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

const NO_LOG: ExtractLog = { info: () => undefined, warn: () => undefined };

const since = (t: number) => Math.round(Date.now() - t);

export interface ExtractionResult extends Combined, Classification {}

async function toMarkdown(buffer: Buffer, name: string, log: ExtractLog): Promise<string> {
  const started = Date.now();
  try {
    const md = await withTimeout(pdf2md(new Uint8Array(buffer)), MARKDOWN_TIMEOUT_MS, "");
    if (!md) {
      log.warn({ doc: name, ms: since(started) }, "pdf2md timed out — using the PDF route");
      return "";
    }
    log.info({ doc: name, ms: since(started), chars: md.length }, "pdf2md converted");
    return md;
  } catch (err) {
    // A conversion failure is not fatal — it just means this document takes
    // the PDF route, which is the more capable path anyway. It IS logged,
    // because a silent conversion failure looks identical to an image-only
    // receipt and we would never know which we were looking at.
    log.warn({ doc: name, ms: since(started), err: String(err) }, "pdf2md failed");
    return "";
  }
}

async function extractOne(
  client: Anthropic,
  doc: UploadedDoc,
  log: ExtractLog
): Promise<DocResult> {
  const started = Date.now();
  try {
    const markdown = await toMarkdown(doc.buffer, doc.name, log);

    // Markdown when the page actually carries text; the original PDF when it
    // does not, which is what makes image-only invoices work at all.
    const content: Anthropic.ContentBlockParam[] = looksExtractable(markdown)
      ? [{ type: "text", text: `${docPrompt(doc.name)}\n\n${markdown}` }]
      : [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: doc.buffer.toString("base64"),
            },
          },
          { type: "text", text: docPrompt(doc.name) },
        ];

    const route = content.some((c) => c.type === "document") ? "pdf-fallback" : "markdown";
    log.info({ doc: doc.name, route, bytes: doc.buffer.length }, "extraction call starting");

    const callStarted = Date.now();
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      messages: [{ role: "user", content }],
      output_config: { format: zodOutputFormat(DocSchema) },
    });
    log.info(
      { doc: doc.name, route, ms: since(callStarted), usage: res.usage },
      "extraction call returned"
    );

    if (!res.parsed_output) {
      log.warn({ doc: doc.name, stopReason: res.stop_reason }, "extraction returned unparsable output");
      return { doc: doc.name, ok: false };
    }
    return { doc: doc.name, ok: true, result: res.parsed_output };
  } catch (err) {
    // Logged, not swallowed. A bare `catch {}` here made every failure —
    // timeout, auth, rate limit, oversized document — indistinguishable from
    // "this receipt had no items on it".
    log.warn(
      { doc: doc.name, ms: since(started), err: err instanceof Error ? err.message : String(err) },
      "extraction failed"
    );
    return { doc: doc.name, ok: false };
  }
}

function codeListText(tree: ChargeCodeNode[]): string {
  return tree
    .map((c) => {
      const subs = c.subs.length
        ? ` (sub-codes: ${c.subs.map((s) => `${s.code} ${s.label}`).join(", ")})`
        : "";
      return `${c.code} ${c.label}${subs}`;
    })
    .join("\n");
}

async function classify(
  client: Anthropic,
  titles: string[],
  tree: ChargeCodeNode[],
  log: ExtractLog
): Promise<Classification> {
  const started = Date.now();
  const fallback: Classification = {
    reason: heuristicSummary(titles),
    chargeCode: "",
    subChargeCode: "",
  };
  if (!titles.length) return fallback;

  try {
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Given these purchased item titles from a church expense request:
${titles.map((t) => "- " + t).join("\n")}

Available charge codes:
${codeListText(tree)}

Write a very short expense reason (under 8 words, no trailing period) and pick the single best-fit charge code from the list, plus its sub-code if one applies. Use an empty string if none fit.`,
        },
      ],
      output_config: { format: zodOutputFormat(ClassifySchema) },
    });

    log.info({ ms: since(started), usage: res.usage }, "classification returned");
    if (!res.parsed_output) return fallback;
    const validated = validateClassification(res.parsed_output, tree);
    return { ...validated, reason: validated.reason || fallback.reason };
  } catch (err) {
    // Keep the heuristic reason and leave the codes blank rather than failing
    // the whole extraction over the cosmetic half of it — but say so.
    log.warn(
      { ms: since(started), err: err instanceof Error ? err.message : String(err) },
      "classification failed, using heuristic reason"
    );
    return fallback;
  }
}

export async function extractDocuments(
  pool: Pool,
  docs: UploadedDoc[],
  log: ExtractLog = NO_LOG
): Promise<ExtractionResult> {
  const started = Date.now();
  const key = await getSetting(pool, "anthropic_api_key");
  if (!key) throw new Error(MISSING_KEY_ERROR);
  const client = new Anthropic({ apiKey: key });
  log.info(
    { docs: docs.length, totalBytes: docs.reduce((n, d) => n + d.buffer.length, 0) },
    "extraction starting"
  );

  // Parallel, unlike the Artifact's sequential loop. Per-document isolation is
  // what made extraction reliable — running them one at a time was never part
  // of that, only slower.
  const results = await Promise.all(docs.map((d) => extractOne(client, d, log)));
  const combined = combineDocs(results);
  log.info(
    { ms: since(started), failed: combined.failed, items: combined.items.length },
    "all documents processed"
  );

  const tree = chargeCodeTree(await listChargeCodes(pool));
  const titles = combined.items.filter((i) => !i.autoType).map((i) => i.title);

  const classified = await classify(client, titles, tree, log);
  log.info({ ms: since(started) }, "extraction complete");
  return { ...combined, ...classified };
}
