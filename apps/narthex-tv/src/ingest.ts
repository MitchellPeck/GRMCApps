export type MediaKind = "image" | "video" | "deck";

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic", "heif"];
const VIDEO_EXT = ["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv", "mpg", "mpeg", "m2v", "mts", "mxf"];
const DECK_EXT = ["pptx", "ppt", "pptm", "ppsx", "pps", "odp", "pdf", "key"];

// Formats every browser we care about decodes without help. Anything else is
// re-encoded at ingest so the player never has to cope with a surprise.
const BROWSER_IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "avif"];
const BROWSER_VIDEO_CODECS = ["h264", "vp8", "vp9", "av1"];
const BROWSER_VIDEO_EXT = ["mp4", "m4v", "webm"];

export function extensionOf(fileName: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(fileName || "").trim());
  return m ? m[1].toLowerCase() : "";
}

export function detectKind(fileName: string, mimeType: string): MediaKind | null {
  const ext = extensionOf(fileName);
  if (IMAGE_EXT.includes(ext)) return "image";
  if (VIDEO_EXT.includes(ext)) return "video";
  if (DECK_EXT.includes(ext)) return "deck";

  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "deck";
  if (mime.includes("presentation") || mime.includes("powerpoint")) return "deck";
  return null;
}

export function isBrowserImage(fileName: string): boolean {
  return BROWSER_IMAGE_EXT.includes(extensionOf(fileName));
}

export function needsTranscode(fileName: string, codec: string): boolean {
  if (!BROWSER_VIDEO_EXT.includes(extensionOf(fileName))) return true;
  return !BROWSER_VIDEO_CODECS.includes(String(codec || "").toLowerCase());
}

export function contentTypeFor(fileName: string): string {
  const ext = extensionOf(fileName);
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", avif: "image/avif",
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm",
  };
  return map[ext] || "application/octet-stream";
}

/** The title we suggest when someone uploads without typing one. */
export function titleFromFileName(fileName: string): string {
  const base = String(fileName || "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base.slice(0, 120) || "Untitled";
}

/**
 * The uploaded name is used as a filename on disk, so it is reduced to
 * something that cannot escape its directory or surprise a shell.
 */
export function safeFileName(fileName: string): string {
  const raw = String(fileName || "").replace(/^.*[\\/]/, "");
  const ext = extensionOf(raw);
  const stem = raw
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  const safeStem = stem || "upload";
  return ext ? `${safeStem}.${ext}` : safeStem;
}
