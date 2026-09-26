/**
 * Samsung Tizen televisions, over the set's own local WebSocket API.
 *
 * Why this exists when power-actions.ts is deliberately brand-agnostic: a
 * Samsung cannot be turned off by a plain HTTP request. It wants a WebSocket
 * session on port 8002, over TLS with a certificate it signed itself, carrying
 * a token that only exists once somebody has walked to the television and
 * pressed Allow on a prompt. That is a pairing flow, not a URL, and there is
 * nowhere to put it in a configured request.
 *
 * Everything here is pure or takes its transport as an argument, because none
 * of it can be tested against a real set from a build machine.
 *
 * The shape of the protocol:
 *
 *   - Connect to wss://<host>:8002/api/v2/channels/samsung.remote.control
 *     with `name` (base64 of whatever you want to appear on the TV) and, once
 *     you have one, `token`.
 *   - Without a token the set shows an Allow/Deny prompt and says nothing
 *     until it is answered. Allow returns `ms.channel.connect` carrying
 *     `data.token`; Deny returns `ms.channel.unauthorized`.
 *   - With a valid token it answers `ms.channel.connect` immediately and no
 *     prompt appears.
 *   - Keys are `ms.remote.control` messages. KEY_POWER toggles.
 */

export const REMOTE_PORT = 8002;
export const REMOTE_CHANNEL = "samsung.remote.control";

/** Long enough to walk to the television and press Allow. */
export const PAIR_TIMEOUT_MS = 45_000;
/** A paired set answers at once or is switched off. */
export const SEND_TIMEOUT_MS = 8_000;

export const EVENT_CONNECT = "ms.channel.connect";
export const EVENT_UNAUTHORIZED = "ms.channel.unauthorized";
export const EVENT_TIMEOUT = "ms.channel.timeOut";
export const EVENT_ERROR = "ms.error";

export interface SamsungConfig {
  host: string;
  mac: string;
  token: string;
  name: string;
  pairedAt: string | null;
}

export const NO_SAMSUNG: SamsungConfig = {
  host: "", mac: "", token: "", name: "Narthex TV", pairedAt: null,
};

const HOSTNAME = /^[a-zA-Z0-9.-]+$/;

export type HostResult = { ok: true; host: string } | { ok: false; error: string };

/**
 * Only a bare host or address, never a URL.
 *
 * This value is interpolated into the WebSocket URL, so anything that could
 * carry a path, a port, credentials or another scheme is refused here rather
 * than quietly pointing the pairing somewhere else.
 */
export function validateHost(raw: unknown): HostResult {
  const host = String(raw ?? "").trim();
  if (!host) return { ok: false, error: "Give the television's IP address." };
  if (!HOSTNAME.test(host)) {
    return { ok: false, error: "That should be just an IP address or hostname — no http://, port or path." };
  }
  if (host.length > 253) return { ok: false, error: "That address is too long." };
  return { ok: true, host };
}

/** The name the TV shows on its Allow prompt, base64 as the API wants it. */
export function encodeName(name: string): string {
  return Buffer.from(name || NO_SAMSUNG.name, "utf8").toString("base64");
}

export function websocketUrl(host: string, name: string, token?: string | null): string {
  const url = new URL(`wss://${host}:${REMOTE_PORT}/api/v2/channels/${REMOTE_CHANNEL}`);
  url.searchParams.set("name", encodeName(name));
  // Sent only when we have one: with no token the set raises its prompt,
  // which is the whole point of pairing.
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export function remoteKeyPayload(key: string): string {
  return JSON.stringify({
    method: "ms.remote.control",
    params: { Cmd: "Click", DataOfCmd: key, Option: "false", TypeOfRemote: "SendRemoteKey" },
  });
}

export interface SamsungEvent {
  event: string;
  token: string;
  message: string;
}

/** Never throws: a set that answers with something unexpected is not a crash. */
export function readEvent(raw: string): SamsungEvent {
  try {
    const body = JSON.parse(raw) as { event?: unknown; data?: Record<string, unknown> };
    const data = (body.data ?? {}) as Record<string, unknown>;
    return {
      event: String(body.event ?? ""),
      token: data.token ? String(data.token) : "",
      message: data.message ? String(data.message) : "",
    };
  } catch {
    return { event: "", token: "", message: "" };
  }
}

/**
 * One WebSocket, as little of it as this needs.
 *
 * An interface rather than `ws` directly so the handshake can be tested
 * without a television, which is the only way it ever gets tested.
 */
export interface SamsungSocket {
  send(text: string): void;
  close(): void;
  onMessage(handler: (raw: string) => void): void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: () => void): void;
}

export interface SamsungDeps {
  open(url: string): SamsungSocket;
  /** Injected so a test does not wait forty-five seconds. */
  setTimer(fn: () => void, ms: number): { cancel(): void };
}

export type PairOutcome =
  | { ok: true; token: string }
  | { ok: false; error: string; denied?: boolean };

/**
 * Open a session and wait for the set to say yes.
 *
 * With no token this makes the Allow prompt appear, so the wait is as long as
 * it takes somebody to walk over and answer it. A denial is reported as a
 * denial rather than a timeout, because they need different advice.
 */
export function pair(
  host: string,
  name: string,
  deps: SamsungDeps,
  timeoutMs = PAIR_TIMEOUT_MS
): Promise<PairOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: SamsungSocket | null = null;

    const finish = (outcome: PairOutcome) => {
      if (settled) return;
      settled = true;
      timer.cancel();
      try { socket?.close(); } catch { /* already gone */ }
      resolve(outcome);
    };

    const timer = deps.setTimer(() => finish({
      ok: false,
      error: "The television never answered. Check it is switched on, on the same network, "
           + "and that nobody dismissed the prompt.",
    }), timeoutMs);

    try {
      socket = deps.open(websocketUrl(host, name));
    } catch (e) {
      finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    socket.onMessage((raw) => {
      const message = readEvent(raw);
      if (message.event === EVENT_CONNECT) {
        // A set that was already paired under this name answers at once and
        // sends no token. Nothing is wrong; there is just nothing to store.
        if (!message.token) {
          finish({
            ok: false,
            error: "The television accepted the connection but sent no token. "
                 + "Remove this device under Settings → General → External Device Manager → "
                 + "Device Connection Manager → Device List, then pair again.",
          });
          return;
        }
        finish({ ok: true, token: message.token });
      } else if (message.event === EVENT_UNAUTHORIZED) {
        finish({ ok: false, denied: true, error: "The television refused. Deny was pressed, or the prompt timed out." });
      } else if (message.event === EVENT_ERROR) {
        finish({ ok: false, error: message.message || "The television reported an error." });
      }
    });

    socket.onError((error) => finish({
      ok: false,
      error: `Could not reach the television: ${error.message}`,
    }));

    // A close before any event means the set hung up: almost always the wrong
    // address, or port 8002 closed on an older model.
    socket.onClose(() => finish({
      ok: false,
      error: "The television closed the connection without answering. "
           + "Check the address, and that it is a 2018 or newer model.",
    }));
  });
}

export type SendOutcome = { ok: boolean; detail: string };

/** Press one key on a set already paired. */
export function sendKey(
  config: SamsungConfig,
  key: string,
  deps: SamsungDeps,
  timeoutMs = SEND_TIMEOUT_MS
): Promise<SendOutcome> {
  return new Promise((resolve) => {
    if (!config.host) return resolve({ ok: false, detail: "No television address is set." });
    if (!config.token) return resolve({ ok: false, detail: "This television has not been paired yet." });

    let settled = false;
    let socket: SamsungSocket | null = null;
    const finish = (outcome: SendOutcome) => {
      if (settled) return;
      settled = true;
      timer.cancel();
      try { socket?.close(); } catch { /* already gone */ }
      resolve(outcome);
    };

    const timer = deps.setTimer(() => finish({
      ok: false,
      // The ordinary case, not a fault: a Samsung stops answering on 8002 the
      // moment it is off, so "off" and "unreachable" look identical.
      detail: "The television did not answer. It is probably already off.",
    }), timeoutMs);

    try {
      socket = deps.open(websocketUrl(config.host, config.name, config.token));
    } catch (e) {
      finish({ ok: false, detail: e instanceof Error ? e.message : String(e) });
      return;
    }

    socket.onMessage((raw) => {
      const message = readEvent(raw);
      if (message.event === EVENT_CONNECT) {
        try {
          socket!.send(remoteKeyPayload(key));
          finish({ ok: true, detail: `Sent ${key} to ${config.host}` });
        } catch (e) {
          finish({ ok: false, detail: e instanceof Error ? e.message : String(e) });
        }
      } else if (message.event === EVENT_UNAUTHORIZED) {
        finish({
          ok: false,
          detail: "The television rejected the saved token. Pair it again.",
        });
      }
    });

    socket.onError((error) => finish({ ok: false, detail: error.message }));
    socket.onClose(() => finish({ ok: false, detail: "The television closed the connection." }));
  });
}

/**
 * The real transport.
 *
 * `rejectUnauthorized: false` is not a shortcut here. A Samsung serves port
 * 8002 with a certificate it signed itself, for a name that is not its IP
 * address; there is no certificate authority in the picture and no way to
 * obtain one. What actually authenticates the session is the pairing token,
 * which the set only issues to somebody standing in front of it. The
 * connection is to a fixed address on the church's own LAN.
 */
export function realDeps(): SamsungDeps {
  // Required lazily so the pure half of this file stays importable without ws.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WebSocket } = require("ws") as typeof import("ws");
  return {
    open(url) {
      const socket = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 10_000 });
      return {
        send: (text) => socket.send(text),
        close: () => socket.close(),
        onMessage: (h) => socket.on("message", (raw: unknown) => h(String(raw))),
        onError: (h) => socket.on("error", h),
        onClose: (h) => socket.on("close", h),
      };
    },
    setTimer(fn, ms) {
      const handle = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(handle) };
    },
  };
}
