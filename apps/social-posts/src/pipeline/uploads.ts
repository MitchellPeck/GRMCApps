// Files uploaded straight to a media item: checked here, stored in the R2
// bucket under media/, and attached to the item by its public link. R2 links
// are unguessable but public, which is also what lets Metricool fetch them.
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { R2Creds, getR2Creds, uploadPublic } from "../r2";

export const UPLOAD_TYPES: Record<string, "image" | "video"> = {
  "image/jpeg": "image", "image/png": "image", "image/gif": "image", "image/webp": "image",
  "video/mp4": "video", "video/quicktime": "video",
};
// Cloudflare's tunnel refuses request bodies over 100 MB.
export const MAX_UPLOAD_BYTES = 100_000_000;

/** Why this file can't be uploaded, or "" if it can. */
export function uploadProblem(contentType: string, size: number): string {
  if (!UPLOAD_TYPES[contentType]) return "Upload a photo (JPG, PNG, GIF or WebP) or a video (MP4 or MOV).";
  if (!size) return "That file is empty.";
  if (size > MAX_UPLOAD_BYTES) return "That file is larger than 100 MB. Share a link to it instead.";
  return "";
}

type Put = (c: R2Creds, bytes: Buffer, contentType: string, seed: string, prefix: string) => Promise<string>;

export async function storeUpload(
  pool: Pool, bytes: Buffer, contentType: string, fileName: string, put: Put = uploadPublic,
): Promise<{ url: string; name: string; type: "image" | "video" }> {
  const problem = uploadProblem(contentType, bytes.length);
  if (problem) throw new Error(problem);
  const creds = await getR2Creds(pool);
  const seed = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  const url = await put(creds, bytes, contentType, seed, "media");
  return { url, name: (fileName || "upload").slice(0, 200), type: UPLOAD_TYPES[contentType] };
}
