export interface HubUrls {
  publicUrl: string;
  cookieDomain: string;
  redirectUri: string;
}

// All hub-facing URLs derive from the single BASE_DOMAIN. The hub always lives
// at hub.<baseDomain>; the session cookie is shared across .<baseDomain>.
export function deriveHubUrls(baseDomain: string): HubUrls {
  const publicUrl = `https://hub.${baseDomain}`;
  return {
    publicUrl,
    cookieDomain: `.${baseDomain}`,
    redirectUri: `${publicUrl}/auth/callback`,
  };
}
