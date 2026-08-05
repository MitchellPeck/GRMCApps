// Whether a browser Origin belongs to one of our own apps. Used to let an app
// page read the hub's registry for the cross-app switcher without opening that
// endpoint up to the whole web.
export function isSiblingOrigin(origin: string, baseDomain: string): boolean {
  if (!origin.startsWith("https://")) return false;
  const host = origin.slice("https://".length);
  if (host.includes("/") || host.includes(":")) return false;
  return subdomainFromHost(host, baseDomain) !== null;
}

// Extract the app subdomain from a forwarded host, requiring it to sit directly
// under the configured base domain. Returns null if it doesn't match (reject).
export function subdomainFromHost(host: string, baseDomain: string): string | null {
  const suffix = "." + baseDomain;
  if (!host.endsWith(suffix)) return null;
  const subdomain = host.slice(0, -suffix.length);
  return subdomain.length > 0 ? subdomain : null;
}
