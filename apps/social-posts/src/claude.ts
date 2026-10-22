import { Pool } from "pg";
import { getSetting } from "./settings";

export function stripJsonFences(raw: string): string {
  return raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
}

/** A JSON schema for an object whose keys are each a required string. */
export function stringsSchema(keys: string[]): object {
  return {
    type: "object", additionalProperties: false, required: keys,
    properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
  };
}

export interface ClaudeOptions {
  /** The reply must be JSON matching this schema (structured outputs): no prose, no fences. */
  schema?: object;
  maxTokens?: number;
}

// Overloaded, rate limited or a passing server fault: worth another go.
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
const RETRY_DELAYS_MS = [1500, 4000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callClaude(
  pool: Pool,
  systemPrompt: string,
  userPrompt: string,
  opts: ClaudeOptions = {},
): Promise<string> {
  const key = await getSetting(pool, "anthropic_api_key");
  if (!key) throw new Error("No Anthropic API key. Go to Settings to add it.");

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    // Room for three platforms' captions at once; 2048 could cut a long Facebook post off mid-JSON.
    max_tokens: opts.maxTokens ?? 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    ...(opts.schema ? { output_config: { format: { type: "json_schema", schema: opts.schema } } } : {}),
  });

  let data: any;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body,
      });
    } catch (e) {
      if (attempt < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
      throw new Error("Couldn't reach Claude: " + (e as Error).message);
    }
    if (RETRYABLE.has(res.status) && attempt < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
    // An error page from a proxy isn't JSON; say what happened instead of "not readable".
    const text = await res.text();
    try { data = JSON.parse(text); }
    catch { throw new Error(`Claude's service answered ${res.status}${RETRYABLE.has(res.status) ? " (busy)" : ""}. Try again in a minute.`); }
    break;
  }
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  if (data.stop_reason === "refusal") throw new Error("Claude declined to write this one. Reword the brief or instructions and try again.");
  if (data.stop_reason === "max_tokens") throw new Error("Claude's reply ran too long and was cut off. Try again.");
  const out = (Array.isArray(data.content) ? data.content : [])
    .filter((b: any) => typeof b?.text === "string").map((b: any) => b.text as string).join("");
  if (!out.trim()) throw new Error("Claude came back empty. Try again.");
  return out;
}
