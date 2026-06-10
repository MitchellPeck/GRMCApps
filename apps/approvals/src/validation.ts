export const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateUpload(mime: string, size: number): ValidationResult {
  if (!ALLOWED_MIME.has(mime)) {
    return { ok: false, error: `Unsupported file type "${mime}". Allowed: PNG, JPG, WebP, GIF, PDF.` };
  }
  if (size <= 0) {
    return { ok: false, error: "File is empty." };
  }
  if (size > MAX_BYTES) {
    return { ok: false, error: "File is too large (max 10 MB)." };
  }
  return { ok: true };
}
