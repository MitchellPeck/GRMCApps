import { Identity } from "./identity";

const APPROVALS = "http://approvals:3000";

function authHeaders(id: Identity): Record<string, string> {
  // Forward the logged-in user's identity so Approvals applies its normal auth.
  return { "X-Auth-Email": id.email, "X-Auth-Name": id.name };
}

export async function listApprovedImages(id: Identity): Promise<Array<{ id: number; title: string; currentVersion: number }>> {
  const res = await fetch(`${APPROVALS}/api/approved`, { headers: authHeaders(id) });
  const data: any = await res.json();
  if (!data.ok) throw new Error(data.error || "Could not list approved images.");
  return data.images;
}

export async function getApprovedImageBytes(id: Identity, imageId: number): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await fetch(`${APPROVALS}/api/approved/${imageId}/image`, { headers: authHeaders(id) });
  if (!res.ok) throw new Error(`Could not fetch approved image (${res.status}).`);
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType };
}
