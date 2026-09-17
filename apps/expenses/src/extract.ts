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

const MODEL = "claude-opus-5";

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

export interface ExtractionResult extends Combined, Classification {}

async function toMarkdown(buffer: Buffer): Promise<string> {
  try {
    return await pdf2md(new Uint8Array(buffer));
  } catch {
    // A conversion failure is not fatal — it just means this document takes
    // the PDF route, which is the more capable path anyway.
    return "";
  }
}

async function extractOne(client: Anthropic, doc: UploadedDoc): Promise<DocResult> {
  try {
    const markdown = await toMarkdown(doc.buffer);

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

    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      messages: [{ role: "user", content }],
      output_config: { format: zodOutputFormat(DocSchema) },
    });

    if (!res.parsed_output) return { doc: doc.name, ok: false };
    return { doc: doc.name, ok: true, result: res.parsed_output };
  } catch {
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
  tree: ChargeCodeNode[]
): Promise<Classification> {
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

    if (!res.parsed_output) return fallback;
    const validated = validateClassification(res.parsed_output, tree);
    return { ...validated, reason: validated.reason || fallback.reason };
  } catch {
    // Keep the heuristic reason and leave the codes blank rather than failing
    // the whole extraction over the cosmetic half of it.
    return fallback;
  }
}

export async function extractDocuments(
  pool: Pool,
  docs: UploadedDoc[]
): Promise<ExtractionResult> {
  const key = await getSetting(pool, "anthropic_api_key");
  if (!key) throw new Error(MISSING_KEY_ERROR);
  const client = new Anthropic({ apiKey: key });

  // Parallel, unlike the Artifact's sequential loop. Per-document isolation is
  // what made extraction reliable — running them one at a time was never part
  // of that, only slower.
  const results = await Promise.all(docs.map((d) => extractOne(client, d)));
  const combined = combineDocs(results);

  const tree = chargeCodeTree(await listChargeCodes(pool));
  const titles = combined.items.filter((i) => !i.autoType).map((i) => i.title);

  return { ...combined, ...(await classify(client, titles, tree)) };
}
