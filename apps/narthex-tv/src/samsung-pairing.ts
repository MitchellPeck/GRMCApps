import { Pool } from "pg";
import {
  NO_SAMSUNG, PAIR_TIMEOUT_MS, SamsungConfig, SamsungDeps, pair, realDeps, sendKey, validateHost,
} from "./samsung";
import { getSamsung, setSamsung } from "./settings";

/**
 * Pairing, which is a conversation rather than a request.
 *
 * Somebody presses Pair here, then walks to the narthex and presses Allow on
 * the television. That is a minute of wall-clock time, so the HTTP request
 * cannot be the thing that waits for it: a browser, a proxy or Cloudflare will
 * give up long before a person does. The attempt runs here instead and the
 * settings screen asks how it went.
 *
 * One at a time, on purpose. The television shows one prompt, and a second
 * attempt while the first is up replaces it with another the first request can
 * no longer hear the answer to.
 */
export type PairingStatus =
  | { state: "idle" }
  | { state: "waiting"; host: string; since: string }
  | { state: "paired"; host: string; at: string }
  | { state: "failed"; host: string; error: string; denied: boolean };

let current: PairingStatus = { state: "idle" };
let running = false;

export function pairingStatus(): PairingStatus {
  return current;
}

/** Only for tests: there is one television and one module-level attempt. */
export function resetPairing(): void {
  current = { state: "idle" };
  running = false;
}

export type StartResult = { ok: true } | { ok: false; error: string };

export function startPairing(
  pool: Pool,
  host: string,
  name: string,
  deps: SamsungDeps = realDeps(),
  timeoutMs = PAIR_TIMEOUT_MS
): StartResult {
  if (running) return { ok: false, error: "A pairing attempt is already waiting for the television." };

  const checked = validateHost(host);
  if (!checked.ok) return { ok: false, error: checked.error };

  running = true;
  current = { state: "waiting", host: checked.host, since: new Date().toISOString() };

  // Deliberately not awaited: the caller answers straight away and the
  // settings screen polls. Errors land in `current`, never unhandled.
  void (async () => {
    try {
      const outcome = await pair(checked.host, name, deps, timeoutMs);
      if (outcome.ok) {
        const at = new Date().toISOString();
        await setSamsung(pool, { host: checked.host, name, token: outcome.token, pairedAt: at });
        current = { state: "paired", host: checked.host, at };
      } else {
        current = {
          state: "failed", host: checked.host,
          error: outcome.error, denied: Boolean(outcome.denied),
        };
      }
    } catch (e) {
      current = {
        state: "failed", host: checked.host,
        error: e instanceof Error ? e.message : String(e), denied: false,
      };
    } finally {
      running = false;
    }
  })();

  return { ok: true };
}

export async function loadConfig(pool: Pool): Promise<SamsungConfig> {
  const stored = await getSamsung(pool);
  return { ...NO_SAMSUNG, ...stored };
}

/** What power-actions.ts calls when an hours boundary fires a samsung action. */
export async function pressKey(
  pool: Pool,
  key: string,
  deps: SamsungDeps = realDeps()
): Promise<{ ok: boolean; detail: string }> {
  return sendKey(await loadConfig(pool), key, deps);
}
