/** A request URL safe to log: /gn/<token> links and OAuth codes are blanked out. */
export function redactUrl(url: string | undefined): string {
  return String(url ?? "")
    .replace(/\/gn\/[^/?#]+/, "/gn/[token]")
    .replace(/([?&](?:code|state|token)=)[^&#]*/gi, "$1[redacted]");
}
