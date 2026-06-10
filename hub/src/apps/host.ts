// Extract the app subdomain from a forwarded host, requiring it to sit directly
// under the configured base domain. Returns null if it doesn't match (reject).
export function subdomainFromHost(host: string, baseDomain: string): string | null {
  const suffix = "." + baseDomain;
  if (!host.endsWith(suffix)) return null;
  const subdomain = host.slice(0, -suffix.length);
  return subdomain.length > 0 ? subdomain : null;
}
