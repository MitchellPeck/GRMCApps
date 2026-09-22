function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// docker-compose passes NARTHEXTV_DATABASE_URL; the per-part fallback keeps the
// app runnable against any Postgres (a local one during development) without
// editing code.
function databaseUrl(): string {
  const url = process.env.NARTHEXTV_DATABASE_URL;
  if (url) return url;
  const user = required("NARTHEXTV_DB_USER");
  const password = required("NARTHEXTV_DB_PASSWORD");
  const name = required("NARTHEXTV_DB_NAME");
  return `postgres://${user}:${password}@postgres:5432/${name}`;
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  databaseUrl: databaseUrl(),
  // Media lives on a volume, not in Postgres: a single announcement video is
  // larger than every row the other apps store put together, and the player
  // needs byte-range requests over it.
  dataDir: process.env.NARTHEXTV_DATA_DIR || "/data",
  // A single upload. Big enough for a long 1080p announcement loop.
  maxFileBytes: Number(process.env.NARTHEXTV_MAX_FILE_MB || 512) * 1024 * 1024,
  maxFiles: Number(process.env.NARTHEXTV_MAX_FILES || 20),
  // How long one conversion may take before the queue gives up on it.
  convertTimeoutMs: Number(process.env.NARTHEXTV_CONVERT_TIMEOUT_MS || 20 * 60 * 1000),
};
