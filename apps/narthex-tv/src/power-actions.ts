import { createSocket } from "node:dgram";

/**
 * What to do when the screen's operating hours start or end, beyond blanking
 * the picture.
 *
 * Deliberately generic rather than one brand's protocol. Every television
 * speaks something different, half of them need a pairing step, and none of it
 * can be tested from a build machine — so this is a configured request an
 * administrator points at whatever their TV (or smart plug, or Home Assistant,
 * or Pi) actually answers to, with recipes in the setup notes.
 */
export type PowerAction =
  | { kind: "none" }
  | { kind: "http"; method: string; url: string; headers: Record<string, string>; body: string }
  | { kind: "wol"; mac: string; ip: string };

export const NO_ACTION: PowerAction = { kind: "none" };

const MAC = /^([0-9A-Fa-f]{2})([:-]?)([0-9A-Fa-f]{2})(\2[0-9A-Fa-f]{2}){4}$/;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export type ParseResult =
  | { ok: true; action: PowerAction }
  | { ok: false; error: string };

export function parseAction(raw: unknown): ParseResult {
  if (raw === null || raw === undefined || raw === "") return { ok: true, action: NO_ACTION };

  let value: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "That power action isn't valid JSON." };
    }
  } else if (typeof raw === "object") {
    value = raw as Record<string, unknown>;
  } else {
    return { ok: false, error: "That power action isn't something I understand." };
  }

  const kind = String(value.kind ?? "none");
  if (kind === "none") return { ok: true, action: NO_ACTION };

  if (kind === "http") {
    const url = String(value.url ?? "").trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: "That isn't a valid URL." };
    }
    // Only the two schemes a TV, plug or hub ever answers on. Anything else
    // (file:, ftp:, a shell-looking string) is a configuration mistake.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "The URL has to start with http:// or https://." };
    }
    const method = String(value.method ?? "POST").toUpperCase();
    if (!METHODS.includes(method)) {
      return { ok: false, error: `${method} isn't a method I'll send.` };
    }
    const headers: Record<string, string> = {};
    const rawHeaders = value.headers;
    if (rawHeaders && typeof rawHeaders === "object") {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
        headers[String(k)] = String(v);
      }
    }
    return {
      ok: true,
      action: { kind: "http", method, url, headers, body: String(value.body ?? "") },
    };
  }

  if (kind === "wol") {
    const mac = String(value.mac ?? "").trim();
    if (!MAC.test(mac)) {
      return { ok: false, error: "That isn't a MAC address (aa:bb:cc:dd:ee:ff)." };
    }
    return { ok: true, action: { kind: "wol", mac, ip: String(value.ip ?? "").trim() } };
  }

  return { ok: false, error: `"${kind}" isn't a power action I know.` };
}

export function serializeAction(action: PowerAction): string {
  return action.kind === "none" ? "" : JSON.stringify(action);
}

/** 6 bytes of 0xFF followed by the target MAC sixteen times. */
export function magicPacket(mac: string): Buffer {
  const bytes = mac.replace(/[^0-9A-Fa-f]/g, "");
  const address = Buffer.from(bytes, "hex");
  const packet = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) address.copy(packet, 6 + i * 6);
  return packet;
}

export interface ActionDeps {
  request(action: Extract<PowerAction, { kind: "http" }>): Promise<{ status: number }>;
  wake(packet: Buffer, target: string): Promise<void>;
}

export interface ActionResult {
  ok: boolean;
  detail: string;
}

export async function runAction(action: PowerAction, deps: ActionDeps): Promise<ActionResult> {
  try {
    if (action.kind === "none") return { ok: true, detail: "No action configured." };

    if (action.kind === "http") {
      const res = await deps.request(action);
      const ok = res.status >= 200 && res.status < 400;
      return { ok, detail: `${action.method} ${action.url} → ${res.status}` };
    }

    // A directed packet reaches a TV whose address the router still knows; the
    // broadcast is the fallback for one that has dropped off the ARP table.
    const target = action.ip || "255.255.255.255";
    await deps.wake(magicPacket(action.mac), target);
    return { ok: true, detail: `Wake-on-LAN sent to ${action.mac} via ${target}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export const realDeps: ActionDeps = {
  async request(action) {
    // A TV on the LAN answers in milliseconds or not at all; never let a
    // hanging request hold up the hours ticker.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(action.url, {
        method: action.method,
        headers: action.headers,
        body: action.method === "GET" ? undefined : action.body || undefined,
        signal: controller.signal,
      });
      return { status: res.status };
    } finally {
      clearTimeout(timer);
    }
  },

  wake(packet, target) {
    return new Promise<void>((resolve, reject) => {
      const socket = createSocket("udp4");
      const done = (err?: Error) => {
        try { socket.close(); } catch { /* already closed */ }
        if (err) reject(err); else resolve();
      };
      socket.once("error", done);
      socket.bind(() => {
        try {
          socket.setBroadcast(true);
        } catch { /* not permitted for a directed packet; harmless */ }
        socket.send(packet, 0, packet.length, 9, target, (err) => done(err ?? undefined));
      });
    });
  },
};
