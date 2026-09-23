import { Identity } from "./identity";

// Over the internal Docker network, not the database. Each app owns its own
// schema; reaching into the approvals database would couple them permanently
// and bypass the checks Approvals applies. Social Posts does the same.
const APPROVALS = process.env.APPROVALS_URL || "http://approvals:3000";

export interface ApprovedImage {
  id: number;
  title: string;
  currentVersion: number;
}

function authHeaders(id: Identity): Record<string, string> {
  // Forward the signed-in user so Approvals applies its own authorisation —
  // this app never sees more than that person is allowed to.
  return { "X-Auth-Email": id.email, "X-Auth-Name": id.name };
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function listApprovedImages(id: Identity): Promise<ApprovedImage[]> {
  return withTimeout(async (signal) => {
    const res = await fetch(`${APPROVALS}/api/approved`, { headers: authHeaders(id), signal });
    if (!res.ok) throw new Error(`Approvals answered ${res.status}.`);
    const data = (await res.json()) as { ok?: boolean; error?: string; images?: ApprovedImage[] };
    if (!data.ok) throw new Error(data.error || "Could not list approved graphics.");
    return data.images ?? [];
  }, 10_000);
}

export async function getApprovedImageBytes(
  id: Identity,
  imageId: number
): Promise<{ bytes: Buffer; contentType: string }> {
  return withTimeout(async (signal) => {
    const res = await fetch(`${APPROVALS}/api/approved/${imageId}/image`, {
      headers: authHeaders(id),
      signal,
    });
    if (!res.ok) throw new Error(`Could not fetch that graphic (${res.status}).`);
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") || "application/octet-stream",
    };
  }, 60_000);
}

/** A filename for the imported bytes, from the content type Approvals sent. */
export function fileNameForApproval(title: string, contentType: string): string {
  const ext =
    contentType.includes("png") ? "png" :
    contentType.includes("webp") ? "webp" :
    contentType.includes("gif") ? "gif" :
    contentType.includes("avif") ? "avif" : "jpg";
  const stem = String(title || "approved")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60) || "approved";
  return `${stem}.${ext}`;
}
