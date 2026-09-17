function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// docker-compose passes EXPENSES_DATABASE_URL; the per-part fallback keeps the
// app runnable against any Postgres (a local one during development) without
// editing code.
function databaseUrl(): string {
  const url = process.env.EXPENSES_DATABASE_URL;
  if (url) return url;
  const user = required("EXPENSES_DB_USER");
  const password = required("EXPENSES_DB_PASSWORD");
  const name = required("EXPENSES_DB_NAME");
  return `postgres://${user}:${password}@postgres:5432/${name}`;
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  databaseUrl: databaseUrl(),
};
