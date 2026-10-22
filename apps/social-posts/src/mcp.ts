// The content pipeline as an MCP server, so Claude Desktop (a custom connector)
// can read the calendar and plan or edit posts. Streamable HTTP, stateless:
// every POST is one JSON-RPC message answered with plain JSON, no sessions and
// no event stream. The tools go through the same parse and repo functions as
// the page, so every rule the page enforces holds here too. Nothing deletes.
import { Pool } from "pg";
import { addDays } from "./dates";
import { referenceDate } from "./schedule";
import { PLATFORMS } from "./pipeline/config";
import { CONTENT_STATUSES, MEDIA_STATUSES, isIsoDate, parseContentInput } from "./pipeline/rules";
import { HORIZON_DAYS, materialize } from "./pipeline/recurring";
import {
  createContent, dashboardGaps, getContent, listContent, listEvents, listMedia, updateContent,
} from "./pipeline/repo";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

export interface McpContext { db: Pool; email: string }

type Args = Record<string, unknown>;
interface Tool {
  name: string; description: string; inputSchema: object; readOnly: boolean;
  run: (args: Args, ctx: McpContext) => Promise<unknown>;
}

const platformKeys = PLATFORMS.map((p) => p.key);
const date = { type: "string", description: "A date like 2026-11-01." };

// The fields a post can be given, named as the page's API names them.
const postFields = {
  title: { type: "string" },
  publishDate: { ...date, description: "The day it goes out, like 2026-11-01, or null for undated." },
  publishTime: { type: "string", description: "Local time like 09:30 (church's time zone), or null." },
  platforms: { type: "array", items: { type: "string", enum: platformKeys } },
  status: { type: "string", enum: CONTENT_STATUSES,
    description: "ready needs its media collected first; idea/planned move forward on their own when a brief or caption is added." },
  eventId: { type: "string", description: "The event it belongs to (from list_events), or null." },
  ownerEmail: { type: "string" },
  brief: { type: "string", description: "What the post is for: the idea, in a sentence or two." },
  caption: { type: "string", description: "The caption every platform gets (captionMode same)." },
  captionMode: { type: "string", enum: ["same", "separate"] },
  captions: { type: "object", description: "With captionMode separate: a caption per platform key.",
    properties: Object.fromEntries(platformKeys.map((k) => [k, { type: "string" }])) },
  noMediaNeeded: { type: "boolean", description: "A text-only post. Instagram can't take one." },
};

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function dateArg(args: Args, key: string): string | undefined {
  const v = str(args, key);
  if (v && !isIsoDate(v)) throw new Error(`"${key}" must be a date like 2026-11-01.`);
  return v;
}
function listArg(args: Args, key: string, allowed: readonly string[]): string[] | undefined {
  const v = args[key];
  if (v == null) return undefined;
  const list = (Array.isArray(v) ? v : [v]).map(String);
  const bad = list.filter((s) => !allowed.includes(s));
  if (bad.length) throw new Error(`Unknown ${key}: ${bad.join(", ")}. Use ${allowed.join(", ")}.`);
  return list;
}

export const TOOLS: Tool[] = [
  {
    name: "list_posts", readOnly: true,
    description: "List social posts in the content pipeline, earliest first. With no dates, the next 30 days. Each has its id, title, publish date and time, status, platforms, event, owner, brief and caption(s).",
    inputSchema: { type: "object", properties: {
      from: date, to: date,
      status: { type: "array", items: { type: "string", enum: CONTENT_STATUSES } },
      platform: { type: "string", enum: platformKeys },
      eventId: { type: "string" }, ownerEmail: { type: "string" },
      undated: { type: "boolean", description: "Only posts with no publish date yet." },
      includeCancelled: { type: "boolean" },
    } },
    run: async (a, { db }) => {
      const today = await referenceDate(db);
      const undated = a.undated === true;
      let from = dateArg(a, "from"), to = dateArg(a, "to");
      if (undated) from = to = undefined;
      else if (!from && !to) { from = today; to = addDays(today, 30); }
      // Recurring posts exist HORIZON_DAYS ahead; looking further generates them, as the calendar does.
      if (to && to > addDays(today, HORIZON_DAYS)) await materialize(db, today, to);
      const posts = await listContent(db, {
        from, to, undated, statuses: listArg(a, "status", CONTENT_STATUSES), platform: str(a, "platform"),
        eventId: str(a, "eventId"), ownerEmail: str(a, "ownerEmail"), includeCancelled: a.includeCancelled === true,
      });
      return { today, from, to, count: posts.length, posts };
    },
  },
  {
    name: "get_post", readOnly: true,
    description: "One post in full: the post, its media (things to collect and attached files), where its caption came from, and the recurring post it belongs to.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: async (a, { db }) => {
      const r = await getContent(db, String(a.id || ""));
      if (!r.ok) throw new Error(r.error);
      return r.value;
    },
  },
  {
    name: "list_events", readOnly: true,
    description: "The events posts are grouped under (a series, a campaign, a one-off event), with their ids, dates, owner and notes.",
    inputSchema: { type: "object", properties: { includeArchived: { type: "boolean" } } },
    run: async (a, { db }) => ({ events: await listEvents(db, a.includeArchived === true ? {} : { archived: false }) }),
  },
  {
    name: "list_media", readOnly: true,
    description: "Media to collect for posts (photos, video), with when and where it's being captured and who is on it. With no dates, the next 30 days.",
    inputSchema: { type: "object", properties: {
      from: date, to: date,
      status: { type: "array", items: { type: "string", enum: MEDIA_STATUSES } },
      assigneeEmail: { type: "string" },
      unscheduled: { type: "boolean", description: "Only media with no capture date yet." },
    } },
    run: async (a, { db }) => {
      const today = await referenceDate(db);
      const unscheduled = a.unscheduled === true;
      const media = await listMedia(db, {
        from: unscheduled ? undefined : dateArg(a, "from") ?? today,
        to: unscheduled ? undefined : dateArg(a, "to") ?? addDays(today, 30),
        unscheduled, statuses: listArg(a, "status", MEDIA_STATUSES), assigneeEmail: str(a, "assigneeEmail"),
      });
      return { today, count: media.length, media };
    },
  },
  {
    name: "find_gaps", readOnly: true,
    description: "What needs attention, as the dashboard shows it: posts coming up that aren't ready, media with no capture date, quiet stretches with nothing posting.",
    inputSchema: { type: "object", properties: {} },
    run: async (_a, { db }) => dashboardGaps(db, await referenceDate(db)),
  },
  {
    name: "create_post", readOnly: false,
    description: "Add a post to the content pipeline. Only title is required. Platforms default to Instagram and Facebook. Recorded as created by the person whose link this is.",
    inputSchema: { type: "object", properties: postFields, required: ["title"] },
    run: async (a, { db, email }) => {
      const input = parseContentInput(a, "create");
      if (!input.ok) throw new Error(input.error);
      const r = await createContent(db, input.value, email);
      if (!r.ok) throw new Error(r.error);
      return { post: r.value };
    },
  },
  {
    name: "update_post", readOnly: false,
    description: "Change a post: send its id and only the fields to change. For one occurrence of a recurring post, scope \"future\" applies the change to it and every later occurrence nobody has worked on yet.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, ...postFields,
      scope: { type: "string", enum: ["this", "future"] },
    }, required: ["id"] },
    run: async (a, { db }) => {
      const { id, scope, ...fields } = a;
      const input = parseContentInput(fields, "patch");
      if (!input.ok) throw new Error(input.error);
      const r = await updateContent(db, String(id || ""), input.value, scope === "future" ? "future" : "this");
      if (!r.ok) throw new Error(r.error);
      return { post: r.value.item, warnings: r.value.warnings };
    },
  },
];

const INSTRUCTIONS = "GRMC's social media content pipeline: posts planned for Instagram, Facebook and X, grouped under events, "
  + "each moving idea → planned → drafted → ready → scheduled → published. Dates are the church's local dates. "
  + "Check list_events for an event's id before creating posts under it. Nothing here deletes or publishes; "
  + "sending to Metricool is done on the page.";

interface RpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

const reply = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const error = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** One JSON-RPC message in, its answer out; null for a notification (answered 202, no body). */
export async function handleMessage(msg: unknown, ctx: McpContext): Promise<object | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return error(null, -32600, "Invalid request.");
  const m = msg as RpcRequest;
  if (typeof m.method !== "string") return "id" in m ? null : error(null, -32600, "Invalid request."); // a response to us
  if (!("id" in m) || m.id === undefined) return null;
  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion || "");
      return reply(m.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "grmc-social-posts", title: "GRMC Social Posts", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping": return reply(m.id, {});
    case "tools/list":
      return reply(m.id, { tools: TOOLS.map((t) => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema,
        annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false },
      })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return error(m.id, -32602, `Unknown tool: ${String(m.params?.name)}.`);
      const args = (m.params?.arguments && typeof m.params.arguments === "object" ? m.params.arguments : {}) as Args;
      try {
        const out = await tool.run(args, ctx);
        return reply(m.id, { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
      } catch (e) {
        // A tool that can't do what was asked says why, so Claude can fix the call.
        return reply(m.id, { content: [{ type: "text", text: (e as Error).message }], isError: true });
      }
    }
    default: return error(m.id, -32601, `Method not found: ${m.method}.`);
  }
}
