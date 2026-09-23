import { Pool } from "pg";

// Everything the narthex might want to change without a rebuild. The player
// reads these through the plan, so a change reaches the TV on its next poll.
export interface AppSettings {
  timezone: string;        // IANA zone the recurring schedule is written in
  imageSeconds: number;    // how long one photo holds
  slideSeconds: number;    // how long one PowerPoint/PDF slide holds
  transition: "none" | "fade";
  transitionMs: number;
  fit: "contain" | "cover";
  background: string;      // CSS colour behind letterboxed media
  clock: "off" | "time" | "time_date";
  clockPosition: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  footerText: string;      // optional standing line under everything
  idleMessage: string;     // shown when nothing at all is scheduled
  pollSeconds: number;     // how often the TV asks the server what to play
  videoLoopSingle: boolean; // a playlist of one video loops seamlessly
  hoursMode: "always" | "scheduled"; // is the screen awake round the clock?
}

export const DEFAULT_SETTINGS: AppSettings = {
  timezone: "America/Chicago",
  imageSeconds: 12,
  slideSeconds: 12,
  transition: "fade",
  transitionMs: 600,
  fit: "contain",
  background: "#092D3E",
  clock: "off",
  clockPosition: "bottom-right",
  footerText: "",
  idleMessage: "",
  pollSeconds: 10,
  videoLoopSingle: true,
  // Round the clock until somebody deliberately sets narthex hours: a screen
  // that is dark when it should not be is the worse of the two mistakes.
  hoursMode: "always",
};

const KEYS: Record<keyof AppSettings, string> = {
  timezone: "timezone",
  imageSeconds: "image_seconds",
  slideSeconds: "slide_seconds",
  transition: "transition",
  transitionMs: "transition_ms",
  fit: "fit",
  background: "background",
  clock: "clock",
  clockPosition: "clock_position",
  footerText: "footer_text",
  idleMessage: "idle_message",
  pollSeconds: "poll_seconds",
  videoLoopSingle: "video_loop_single",
  hoursMode: "hours_mode",
};

export type SettingResult<T> = { ok: true; value: T } | { ok: false; error: string };

const clamped = (label: string, min: number, max: number) =>
  (raw: unknown): SettingResult<number> => {
    const n = Number(raw);
    if (!isFinite(n)) return { ok: false, error: `${label} has to be a number.` };
    return { ok: true, value: Math.min(max, Math.max(min, Math.round(n))) };
  };

const chosen = <T extends string>(label: string, allowed: readonly T[]) =>
  (raw: unknown): SettingResult<T> =>
    (allowed as readonly string[]).includes(String(raw))
      ? { ok: true, value: String(raw) as T }
      : { ok: false, error: `${label} has to be one of: ${allowed.join(", ")}.` };

const text = (max: number) =>
  (raw: unknown): SettingResult<string> => ({ ok: true, value: String(raw ?? "").slice(0, max) });

/**
 * One validator per field, as a MAPPED TYPE over AppSettings — so leaving a
 * field out is a compile error, not a silent no-op.
 *
 * This is why: hoursMode was in AppSettings, in KEYS, and in the UI, but the
 * route validated its fields with a hand-written if-chain that had never been
 * given a branch for it. Choosing scheduled hours answered 200, changed
 * nothing, and the form sprang back on the next read. A setting that fails
 * silently is the worst possible answer to somebody who just changed it, and a
 * hand-maintained list of ifs will always eventually miss one.
 */
export const SETTING_VALIDATORS: {
  [K in keyof AppSettings]: (raw: unknown) => SettingResult<AppSettings[K]>;
} = {
  timezone: (raw) => {
    const tz = String(raw ?? "").trim();
    return isValidTimeZone(tz)
      ? { ok: true, value: tz }
      : { ok: false, error: `"${tz}" isn't a timezone I know.` };
  },
  imageSeconds: clamped("Seconds per photo", 1, 3600),
  slideSeconds: clamped("Seconds per slide", 1, 3600),
  transition: chosen("The transition", ["none", "fade"] as const),
  transitionMs: clamped("The crossfade length", 0, 5000),
  fit: chosen("How media fills the screen", ["contain", "cover"] as const),
  background: (raw) => {
    const value = String(raw ?? "").trim();
    return /^#[0-9a-fA-F]{3,8}$/.test(value)
      ? { ok: true, value }
      : { ok: false, error: "The background needs to be a hex colour." };
  },
  clock: chosen("The clock", ["off", "time", "time_date"] as const),
  clockPosition: chosen("The clock corner",
    ["top-left", "top-right", "bottom-left", "bottom-right"] as const),
  footerText: text(300),
  idleMessage: text(300),
  pollSeconds: clamped("The check-in interval", 3, 600),
  videoLoopSingle: (raw) => ({ ok: true, value: Boolean(raw) }),
  hoursMode: chosen("Operating hours", ["always", "scheduled"] as const),
};

/** Fields this endpoint accepts. Anything else is refused, not dropped. */
export const SETTABLE_KEYS: string[] = [
  ...Object.keys(SETTING_VALIDATORS),
  "defaultPlaylistId",
];

export function unknownSettingKeys(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((k) => !SETTABLE_KEYS.includes(k));
}

/** Validate a whole body at once. Stops at the first thing that is wrong. */
export function validateSettings(
  body: Record<string, unknown>
): SettingResult<Partial<AppSettings>> {
  const unknown = unknownSettingKeys(body);
  if (unknown.length) {
    return { ok: false, error: `This app doesn't have a setting called ${unknown.join(", ")}.` };
  }
  const patch: Partial<AppSettings> = {};
  for (const [field, validate] of Object.entries(SETTING_VALIDATORS)) {
    const raw = body[field];
    if (raw === undefined) continue;
    const result = validate(raw);
    if (!result.ok) return result;
    (patch as Record<string, unknown>)[field] = result.value;
  }
  return { ok: true, value: patch };
}

export async function getSetting(pool: Pool, key: string): Promise<string> {
  const r = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
  return r.rows[0] ? r.rows[0].value : "";
}

export async function setSetting(pool: Pool, key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

const num = (raw: string, fallback: number, min: number, max: number): number => {
  const n = Number(raw);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const oneOf = <T extends string>(raw: string, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;

// A stored value that no longer makes sense (a hand-edited row, a setting from
// an older build) must never stop the TV — every field falls back.
export function parseSettings(raw: Record<string, string>): AppSettings {
  const d = DEFAULT_SETTINGS;
  const tz = (raw[KEYS.timezone] || "").trim();
  return {
    timezone: isValidTimeZone(tz) ? tz : d.timezone,
    imageSeconds: num(raw[KEYS.imageSeconds], d.imageSeconds, 1, 3600),
    slideSeconds: num(raw[KEYS.slideSeconds], d.slideSeconds, 1, 3600),
    transition: oneOf(raw[KEYS.transition], ["none", "fade"] as const, d.transition),
    transitionMs: num(raw[KEYS.transitionMs], d.transitionMs, 0, 5000),
    fit: oneOf(raw[KEYS.fit], ["contain", "cover"] as const, d.fit),
    background: /^#[0-9a-fA-F]{3,8}$/.test(raw[KEYS.background] || "")
      ? raw[KEYS.background]
      : d.background,
    clock: oneOf(raw[KEYS.clock], ["off", "time", "time_date"] as const, d.clock),
    clockPosition: oneOf(
      raw[KEYS.clockPosition],
      ["top-left", "top-right", "bottom-left", "bottom-right"] as const,
      d.clockPosition
    ),
    footerText: (raw[KEYS.footerText] ?? d.footerText).slice(0, 300),
    idleMessage: (raw[KEYS.idleMessage] ?? d.idleMessage).slice(0, 300),
    pollSeconds: num(raw[KEYS.pollSeconds], d.pollSeconds, 3, 600),
    videoLoopSingle: raw[KEYS.videoLoopSingle] === undefined
      ? d.videoLoopSingle
      : raw[KEYS.videoLoopSingle] === "true",
    hoursMode: oneOf(raw[KEYS.hoursMode], ["always", "scheduled"] as const, d.hoursMode),
  };
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function loadSettings(pool: Pool): Promise<AppSettings> {
  const r = await pool.query<{ key: string; value: string }>("SELECT key, value FROM settings");
  const raw: Record<string, string> = {};
  for (const row of r.rows) raw[row.key] = row.value;
  return parseSettings(raw);
}

export async function saveSettings(pool: Pool, patch: Partial<AppSettings>): Promise<void> {
  for (const [field, key] of Object.entries(KEYS) as [keyof AppSettings, string][]) {
    const value = patch[field];
    if (value === undefined) continue;
    await setSetting(pool, key, String(value));
  }
}

// The default playlist is stored separately: it points at a row, so it is not
// part of the value-typed settings above.
export async function getDefaultPlaylistId(pool: Pool): Promise<number | null> {
  const raw = await getSetting(pool, "default_playlist_id");
  const n = Number(raw);
  return raw && isFinite(n) && n > 0 ? n : null;
}

export async function setDefaultPlaylistId(pool: Pool, id: number | null): Promise<void> {
  await setSetting(pool, "default_playlist_id", id === null ? "" : String(id));
}

// The two power hooks are stored as JSON, so they sit beside the value-typed
// settings above rather than inside them.
export async function getPowerActionRaw(pool: Pool, when: "on" | "off"): Promise<string> {
  return getSetting(pool, `power_${when}_action`);
}

export async function setPowerActionRaw(
  pool: Pool,
  when: "on" | "off",
  value: string
): Promise<void> {
  await setSetting(pool, `power_${when}_action`, value);
}
