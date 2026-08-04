import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { getSetting } from "./settings";

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

export function objectKey(contentType: string, seed: string): string {
  const ext = EXT[contentType] || "bin";
  return `metricool/${seed}-${Math.abs(hash(seed + contentType))}.${ext}`;
}

export function publicUrlFor(base: string, key: string): string {
  return `${base.replace(/\/+$/, "")}/${key}`;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Decode the data URL an <input type="file"> was read into. Rejects anything
// that isn't an image so we never hand Metricool an arbitrary blob.
export function decodeImageDataUrl(dataUrl: string): { bytes: Buffer; contentType: string } {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec((dataUrl || "").trim());
  if (!m) throw new Error("Uploaded file must be an image.");
  const bytes = Buffer.from(m[2], "base64");
  if (!bytes.length) throw new Error("Uploaded image is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("Uploaded image is larger than 10 MB.");
  return { bytes, contentType: m[1].toLowerCase() };
}

export interface R2Creds { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; publicBaseUrl: string; }
export async function getR2Creds(pool: Pool): Promise<R2Creds> {
  const accountId = await getSetting(pool, "r2_account_id");
  const accessKeyId = await getSetting(pool, "r2_access_key_id");
  const secretAccessKey = await getSetting(pool, "r2_secret_access_key");
  const bucket = await getSetting(pool, "r2_bucket");
  const publicBaseUrl = await getSetting(pool, "r2_public_base_url");
  if (!accessKeyId || !secretAccessKey || !bucket || !publicBaseUrl) throw new Error("Image hosting (R2) not configured — add R2 settings.");
  return { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl };
}

export async function uploadPublic(c: R2Creds, bytes: Buffer, contentType: string, seed: string): Promise<string> {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${c.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
  const key = objectKey(contentType, seed);
  await client.send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: bytes, ContentType: contentType }));
  return publicUrlFor(c.publicBaseUrl, key);
}
