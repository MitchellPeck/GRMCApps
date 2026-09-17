# Expenses App — Design

**Date:** 2026-09-17
**Status:** Approved for implementation
**Scope:** New app `expenses` at `expenses.${BASE_DOMAIN}`. Ports
`~/Downloads/expense-form-generator.html` (a claude.ai Artifact) into the stack.

## Problem

The expense request generator is a single-file Artifact. It has no server
persistence (form data and history are both `localStorage`), no multi-user
story, hardcoded charge codes and name defaults, and it reaches Claude through
`window.claude.use('sample')`, which only exists inside the Artifact runtime.

Porting it here fixes all four at once: the hub supplies identity and access
control, Postgres supplies persistence, and a server-side Anthropic key
replaces the Artifact capability.

Functionally the port must be **same or better, with no regressions**. Visually
it must match the GRMC design system, not the Artifact's own look.

## Decisions

| Question | Decision |
|---|---|
| Receipt → model | Convert each PDF to **markdown**, send markdown to the default model |
| Image-only receipts | **Automatic per-document fallback**: a document whose markdown holds no currency amount is re-sent as the raw PDF |
| Extraction granularity | One model call **per document** (unchanged), but run **in parallel** rather than sequentially |
| JSON reliability | `client.messages.parse()` with a Zod schema, replacing prompt-only JSON + fence stripping |
| Model | `claude-opus-5` for both the extraction and the classification call |
| History visibility | Shared — everyone with app access sees every request |
| Charge codes, org name, name defaults | Database-backed, edited in a Settings tab |
| Output PDF | jsPDF client-side, unchanged layout |

### Why the fallback is not optional

Measured against the real receipt corpus in `~/Downloads`:

| Document | Pages | Extracted text | Verdict |
|---|---|---|---|
| `order-document.pdf` | 1 | 1,018 chars | text-based |
| `order-document (1).pdf` | 1 | 1,061 chars | text-based |
| `order-document (2).pdf` | 2 | 1,855 chars | text-based |
| `Sweetwater Invoice.pdf` | 1 | **95 chars** | image-only |

The Sweetwater invoice carries two image XObjects and 95 characters of text —
the browser's print header and footer. Rendered to PNG it is entirely legible:
item `SDItoHDMI3G`, `$85.00`, `Shipping & Handling: $8.87`, `Free Shipping
Promo: -$8.87`, `Tax: $5.10`, `Total: $90.10`. Markdown conversion returns none
of it, and returns it **without erroring** — the user would get a blank form and
no explanation. Sweetwater appears in the original app's own extraction prompt
as an example vendor, so this is routine input.

### Rejected alternatives

- **Always send the raw PDF.** Most accurate, but spends 2–3× the input tokens
  on the Amazon-style receipts that markdown already handles cleanly.
- **Always markdown, no fallback.** What was asked for, but silently wrong on
  image-only receipts, which is the worst available failure mode.
- **Batched multi-document extraction.** The Artifact tried it; items were
  dropped and runs were inconsistent. Not revisited. Structured outputs would
  fix the *shape* of the response but not the attention problem that caused the
  drops.
- **Client-side pdf.js.** Keeps `groupTextIntoLines`' y-coordinate clustering,
  which is the weakest link in the original and produces worse input than
  `@opendocsg/pdf2md` on the same files.
- **Batch API (50% cost).** Asynchronous with polling; wrong for a flow where
  someone is waiting on screen.

## Architecture

A Fastify + TypeScript container on port 3000, laid out like `apps/social-posts`
(the closest analogue — it also holds an Anthropic key and a Settings tab).
Identity arrives in `X-Auth-*` headers from the hub's forwardAuth; the app never
authenticates anyone itself.

```
browser                        expenses container                  Anthropic
───────                        ──────────────────                  ─────────
upload N PDFs  ──POST────────▶ /api/extract
                               │
                               ├─ per doc, in parallel:
                               │    pdf2md(buf) ──▶ markdown
                               │    hasCurrency(markdown)?
                               │      yes → text prompt ─────────▶ messages.parse
                               │      no  → document block ──────▶ messages.parse
                               │                                   {items,vendor,
                               │                                    shipping,tax,
                               │                                    discount}
                               ├─ sum shipping/tax/discount in JS
                               └─ classify(titles, codes) ───────▶ messages.parse
                                                                   {reason,code,sub}
               ◀──items, vendor, reason, code──
build PDF (jsPDF, client-side) ──▶ blob download
save ──POST──▶ /api/requests ──▶ Postgres
```

### Why shipping/tax/discount are still summed in JavaScript

The original sums them in plain JS across documents rather than asking the model
to. That stays. Arithmetic over already-extracted numbers is not a task worth a
model's judgement, and doing it in code makes the total reproducible.

## Registration

Following the README's *Adding an app* steps: database and role in
`db/init/01-databases.sh`; registry row in `db/init/03-app-registry.sql` as
`('expenses', 'Expenses', 'expenses', '🧾')`; a `docker-compose.yml` service
copied from `whoami` carrying the `hub-forward-auth@file` middleware and
``Host(`expenses.${BASE_DOMAIN}`)``; the shared UI copied into the image by the
Dockerfile. Because user management now ships first, the app starts with **no**
grants — it is invisible until someone is ticked into it at
`hub.${BASE_DOMAIN}/admin/users`, including you.

## Data model

Database `expenses`, role `expenses_user`, created by `db/init/01-databases.sh`.
Schema is idempotent boot DDL in `src/schema.ts`, matching every other app.

```sql
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Self-referencing: a row with parent_id set is a sub-charge code.
CREATE TABLE IF NOT EXISTS charge_codes (
  id         bigserial PRIMARY KEY,
  code       text NOT NULL,
  label      text NOT NULL,
  parent_id  bigint REFERENCES charge_codes(id) ON DELETE CASCADE,
  sort       integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS charge_codes_code_parent_idx
  ON charge_codes (code, COALESCE(parent_id, 0));

CREATE TABLE IF NOT EXISTS requests (
  id               bigserial PRIMARY KEY,
  request_date     date,
  amount           numeric(12,2) NOT NULL DEFAULT 0,
  reason           text NOT NULL DEFAULT '',
  vendor           text NOT NULL DEFAULT '',
  charge_code      text NOT NULL DEFAULT '',
  sub_charge_code  text NOT NULL DEFAULT '',
  purchased_by     text NOT NULL DEFAULT '',
  card             text NOT NULL DEFAULT '',
  submitted_by     text NOT NULL DEFAULT '',
  approved_by      text NOT NULL DEFAULT '',
  created_by_email text NOT NULL DEFAULT '',
  created_by_name  text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS request_items (
  request_id bigint NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  idx        integer NOT NULL,
  title      text NOT NULL,
  price      numeric(12,2) NOT NULL DEFAULT 0,
  auto_type  text,                        -- 'shipping' | 'tax' | 'discount' | null
  PRIMARY KEY (request_id, idx)
);
```

`charge_codes` is seeded on first boot with the Artifact's taxonomy, and only
when the table is empty — so edits made in Settings are never overwritten:

| Code | Label | Sub-codes |
|---|---|---|
| 5540 | Audio/Video Streaming | 5404 Audio/Video Equipment |
| 7000 | Marketing | 7040 Photography, 7050 Video, 7060 Podcast Expense, 7070 Marketing Software |
| 9300 | Security System | — |
| 8700 | Software & Technology | — |

Settings keys and their seeded defaults: `anthropic_api_key` (empty),
`org_name` = `Grace Resurrection Methodist Church`, `default_purchased_by` =
`Mitchell Peck`, `default_card` = `Taylor Bacon`, `default_submitted_by` =
`Mitchell Peck`, `default_approved_by` = `Taylor Bacon`.

## Extraction pipeline

### Per document

1. `@opendocsg/pdf2md` converts the uploaded bytes to markdown.
2. `looksExtractable(markdown)` decides the route: it requires a currency
   amount (`$` followed by digits, or a bare decimal like `16.41`) **and** a
   minimum length. A receipt with no price on it cannot produce line items, so
   its absence is the signal — not a page count or a byte threshold alone.
3. Extractable → the markdown goes in a text prompt. Not extractable → the
   original PDF goes in as a `document` content block, base64, and the prompt
   text is otherwise identical.
4. Either way the call is `messages.parse()` with this schema:

```ts
const DocExtraction = z.object({
  items: z.array(z.object({ title: z.string(), price: z.number() })),
  vendor: z.string(),
  shipping: z.number(),
  tax: z.number(),
  discount: z.number(),
});
```

The prompt is carried over from `perDocPrompt` essentially verbatim — its rules
are hard-won and specific: product line items only; shipping, tax and discounts
reported separately, never as items; a promo such as `Free Shipping Promo:
-$8.87` is a discount, not shipping; and the reminder that at least one item
exists even when a description wraps across lines.

### Across documents

Documents are processed with `Promise.all`, not the original's sequential
`for` loop. Per-document isolation is what made extraction reliable, and that is
preserved exactly; the loop was never the reason it worked. A failed document is
collected by name and reported, and does not abort the others.

Shipping, tax and discount are summed in JS and appended as at most three
synthetic rows — `Shipping & Handling`, `Tax`, `Discount / Promo` — each tagged
with `auto_type` so the UI and the saved record can tell them from real items.
Vendors are deduplicated case-insensitively and joined.

### Classification

One further `messages.parse()` call takes the product titles plus the **live**
charge-code list from the database and returns `{reason, chargeCode,
subChargeCode}`. The returned codes are validated against that same list before
being applied, so a hallucinated code is dropped rather than shown — the
Artifact's behaviour, preserved. If the call fails, `reason` falls back to the
`heuristicSummary` of the first three titles.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/me` | Signed-in identity, for the header |
| `POST` | `/api/extract` | Multipart, up to 10 PDFs at 15 MB each → extraction result |
| `GET` | `/api/requests` | History, newest first, all users |
| `GET` | `/api/requests/:id` | One request with its items |
| `POST` | `/api/requests` | Save |
| `DELETE` | `/api/requests/:id` | Remove |
| `GET` | `/api/charge-codes` | Live taxonomy for the datalists |
| `POST`/`PATCH`/`DELETE` | `/api/charge-codes[/:id]` | Settings editing |
| `GET`/`PUT` | `/api/settings` | Org name, the four name defaults, API key |

The API key is write-only over the wire: `GET /api/settings` returns whether one
is set, never the value.

## UI

Three tabs in the shared design system (`/assets/grmc.css`, `grmc-nav.js`):

- **New request** — the import panel (add PDFs, extract, add item manually), the
  editable item table with a running total, and the request fields. Charge code
  and sub-charge code stay `<input list=datalist>` combos so a code can be typed
  freely; the sub-code datalist rebuilds when the parent changes and the field
  hides entirely when the parent has no sub-codes. **Download PDF**, **Save**,
  **Clear**.
- **History** — every saved request, newest first, showing who filed it. Open
  one back into the form, re-download its PDF, or delete it.
- **Settings** — Anthropic key, org name, the four name defaults, and the charge
  code editor.

The live preview pane is dropped. It duplicated the PDF at a second fidelity and
was the largest part of the original's CSS; the **Download PDF** button is the
preview, and nothing else depended on it.

## Output PDF

`buildPdfBlob` is ported as-is, including its page-one field rows, the wet
signature rules for *Submitted by* and *Approved by*, and the page-two itemized
list with pagination at `y > 730` and a total. jsPDF 2.5.1 stays client-side and
loads from cdnjs like the original. Delivery is a plain object-URL anchor
click — the Artifact's `downloads` capability has no analogue here and needs
none.

## Error handling

| Situation | Behaviour |
|---|---|
| No Anthropic key set | 400, message points at Settings (matches other apps) |
| Non-PDF upload | Rejected before conversion, named in the response |
| Markdown has no currency amount | Silent per-document fallback to the raw PDF |
| One document fails extraction | Named in the status line; other documents still fill the form |
| Model returns unparsable JSON | `parsed_output` is null → that document counts as failed |
| Hallucinated charge code | Dropped after validation against the database list |
| Classification call fails | `reason` falls back to the heuristic summary; codes left blank |
| Upload over limit | 413 with the limit stated |

## Testing

`node --test` over compiled JS, matching every other app. Pure functions carry
the logic and the tests:

- `looksExtractable` — the Sweetwater markdown (98 chars, no currency) routes to
  fallback; the Amazon markdown routes to text; a price-free page routes to
  fallback.
- `combineDocs` — items concatenated; shipping/tax/discount summed across
  documents into at most three tagged rows; a promo stays negative; vendors
  deduplicated case-insensitively; failed documents collected, not fatal.
- `validateClassification` — a valid code passes; an unknown code is dropped; a
  sub-code belonging to a different parent is dropped; empties tolerated.
- `heuristicSummary` — three titles then `+N more`; long titles elided.
- `chargeCodeTree` — flat rows assembled into parents with children.
- `formatting` — `fmtAmount`, `fmtDate`, `displayCode` round-trips.

The pipeline's network calls are not unit-tested, consistent with the rest of
the repo; the fixtures above are taken from the real files measured in this
spec.

## Out of scope

- Storing the uploaded receipts. The original does not, and an audit trail is a
  separate feature with its own retention question.
- Approval workflow. The Approvals app exists; wiring expense requests into it
  is a later decision.
- Editing a saved request in place. Open it back into the form and save a new
  one, as the Artifact did.
