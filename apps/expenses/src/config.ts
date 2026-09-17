function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: 3000,
  databaseUrl: `postgres://${required("EXPENSES_DB_USER")}:${required("EXPENSES_DB_PASSWORD")}@postgres:5432/${required("EXPENSES_DB_NAME")}`,
};
