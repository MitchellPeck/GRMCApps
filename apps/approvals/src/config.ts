function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: 3000,
  databaseUrl: `postgres://${required("APPROVALS_DB_USER")}:${required("APPROVALS_DB_PASSWORD")}@postgres:5432/${required("APPROVALS_DB_NAME")}`,
};
