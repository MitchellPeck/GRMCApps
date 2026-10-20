// The images (or videos) a Metricool send carries, made ready for Metricool:
// an Approvals file is copied to R2 first (Metricool needs a public URL), and
// every URL goes through Metricool's normalize step. Dependencies are passed
// in so the order and the mapping can be tested without the network.
import { decodeImageDataUrl } from "./r2";

export interface SendMediaInput {
  /** What the send box had ticked, in the order it should go out. */
  media?: Array<{ approvedImageId?: string; imageUrl?: string }>;
  // The single-image fields the send box used before carousels.
  imageUrl?: string; approvedImageId?: string; imageData?: string;
}
export interface SendMediaDeps {
  approvedBytes: (id: number) => Promise<{ bytes: Buffer; contentType: string }>;
  toR2: (bytes: Buffer, contentType: string, seed: string) => Promise<string>;
  normalize: (publicUrl: string) => Promise<string>;
}

export async function gatherSendMedia(b: SendMediaInput, deps: SendMediaDeps): Promise<string[]> {
  const picks = (b.media && b.media.length ? b.media : [{ approvedImageId: b.approvedImageId, imageUrl: b.imageUrl }])
    .filter((m) => m && ((m.approvedImageId && String(m.approvedImageId).trim()) || (m.imageUrl && m.imageUrl.trim())));
  const out: string[] = [];
  if (b.imageData) {
    const { bytes, contentType } = decodeImageDataUrl(b.imageData);
    out.push(await deps.normalize(await deps.toR2(bytes, contentType, `upload-${Date.now()}`)));
  }
  for (const m of picks) {
    if (m.approvedImageId) {
      const { bytes, contentType } = await deps.approvedBytes(Number(m.approvedImageId));
      out.push(await deps.normalize(await deps.toR2(bytes, contentType, `${m.approvedImageId}-${Date.now()}`)));
    } else {
      out.push(await deps.normalize(m.imageUrl!.trim()));
    }
  }
  return out;
}
