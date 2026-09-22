import { Pool } from "pg";
import { resolvePower } from "./power";
import { listWindows, recordPowerEvent } from "./hours";
import { getPowerActionRaw, getSetting, loadSettings, setSetting } from "./settings";
import { ActionDeps, parseAction, realDeps, runAction } from "./power-actions";

const LAST_STATE_KEY = "power_last_state";

export interface RunnerDeps {
  now(): Date;
  actions: ActionDeps;
  log(message: string): void;
}

/**
 * One tick of the operating-hours clock: work out whether the screen should be
 * awake, and if that differs from the last thing we recorded, fire the
 * configured power action once.
 *
 * The last state is persisted rather than held in memory so a container
 * restart mid-evening does not fire "off" all over again — and so the very
 * first tick on a fresh install records where we are WITHOUT firing anything.
 * An app that powers somebody's television the moment it is deployed would be
 * a nasty surprise.
 */
export async function tickPower(pool: Pool, deps: RunnerDeps): Promise<void> {
  const settings = await loadSettings(pool);
  const windows = await listWindows(pool);
  const state = resolvePower(settings.hoursMode, windows, deps.now(), settings.timezone);
  const want = state.on ? "on" : "off";

  const previous = await getSetting(pool, LAST_STATE_KEY);
  if (previous === want) return;

  await setSetting(pool, LAST_STATE_KEY, want);
  if (!previous) {
    deps.log(`narthex-tv: screen is ${want}; noting it without firing a power action`);
    return;
  }

  const parsed = parseAction(await getPowerActionRaw(pool, want));
  if (!parsed.ok) {
    deps.log(`narthex-tv: power action for "${want}" is misconfigured — ${parsed.error}`);
    await recordPowerEvent(pool, want, false, parsed.error);
    return;
  }
  if (parsed.action.kind === "none") {
    deps.log(`narthex-tv: screen ${want} (blanking only, no power action configured)`);
    return;
  }

  const result = await runAction(parsed.action, deps.actions);
  await recordPowerEvent(pool, want, result.ok, result.detail);
  deps.log(`narthex-tv: screen ${want} — ${result.ok ? "sent" : "FAILED"}: ${result.detail}`);
}

const TICK_MS = 30_000;

/** Starts the ticker and hands back a function that stops it. */
export function startPowerRunner(
  pool: Pool,
  log: (message: string) => void,
  deps: Partial<RunnerDeps> = {}
): () => void {
  const full: RunnerDeps = {
    now: deps.now ?? (() => new Date()),
    actions: deps.actions ?? realDeps,
    log: deps.log ?? log,
  };

  let stopped = false;
  const run = async () => {
    if (stopped) return;
    try {
      await tickPower(pool, full);
    } catch (e) {
      // A power hook must never take the app down with it; the screen blanking
      // itself does not depend on this running at all.
      log(`narthex-tv: power tick failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  void run();
  const timer = setInterval(run, TICK_MS);
  // Node should be free to exit on a signal without waiting for this.
  if (typeof timer.unref === "function") timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
