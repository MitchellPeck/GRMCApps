function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: 3000,
  databaseUrl: `postgres://${required("MEETINGMINUTES_DB_USER")}:${required("MEETINGMINUTES_DB_PASSWORD")}@postgres:5432/${required("MEETINGMINUTES_DB_NAME")}`,
};
