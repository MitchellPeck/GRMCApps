function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: 3000,
  publicUrl: required("HUB_PUBLIC_URL"),
  cookieDomain: required("COOKIE_DOMAIN"),
  sessionSecret: required("SESSION_SECRET"),
  databaseUrl: `postgres://${required("HUB_DB_USER")}:${required("HUB_DB_PASSWORD")}@postgres:5432/${required("HUB_DB_NAME")}`,
  google: {
    clientId: required("GOOGLE_CLIENT_ID"),
    clientSecret: required("GOOGLE_CLIENT_SECRET"),
    redirectUri: `${required("HUB_PUBLIC_URL")}/auth/callback`,
  },
};
