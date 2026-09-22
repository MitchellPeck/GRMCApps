import { execFile } from "node:child_process";
import { readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";

export interface RunResult {
  stdout: string;
  stderr: string;
}

// Every external tool goes through here: a fixed argv (never a shell string),
// a timeout, and an output cap so a runaway converter cannot take the app with
// it. LibreOffice additionally needs a writable HOME or it exits silently.
export function run(command: string, args: string[], timeoutMs = config.convertTimeoutMs): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, HOME: "/tmp" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim().split("\n").slice(-4).join(" ");
          return reject(new Error(`${command} failed: ${detail}`));
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

export interface Probe {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  codec: string;
  hasVideo: boolean;
}

export async function probe(path: string): Promise<Probe> {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
    60_000
  );
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
  };
  const video = (data.streams || []).find((s) => s.codec_type === "video");
  const seconds = Number(data.format?.duration);
  return {
    durationMs: isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    codec: video?.codec_name ?? "",
    hasVideo: Boolean(video),
  };
}

/**
 * Re-encode to something every browser plays. Audio is dropped outright (-an):
 * the narthex screen has no speakers and is never meant to make a sound, so the
 * safest place to guarantee that is the file itself, not a `muted` attribute
 * someone can lose.
 */
export async function transcodeVideo(src: string, dst: string): Promise<void> {
  await run("ffmpeg", [
    "-y", "-i", src,
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    // Never upscale; cap at 1080p and keep the aspect ratio even.
    "-vf", "scale='min(1920,iw)':-2",
    "-movflags", "+faststart",
    dst,
  ]);
}

export async function extractPoster(src: string, dst: string): Promise<void> {
  // One frame a second in, falling back to the very first frame for clips
  // shorter than that.
  try {
    await run("ffmpeg", ["-y", "-ss", "1", "-i", src, "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", dst], 120_000);
  } catch {
    await run("ffmpeg", ["-y", "-i", src, "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", dst], 120_000);
  }
}

/** Anything ffmpeg can decode into a JPEG the browser is certain to render. */
export async function normalizeImage(src: string, dst: string): Promise<void> {
  await run("ffmpeg", ["-y", "-i", src, "-frames:v", "1", "-vf", "scale='min(1920,iw)':-2", "-q:v", "3", dst], 180_000);
}

export async function makeThumbnail(src: string, dst: string): Promise<void> {
  await run("ffmpeg", ["-y", "-i", src, "-frames:v", "1", "-vf", "scale='min(480,iw)':-2", "-q:v", "5", dst], 120_000);
}

/**
 * PowerPoint (and Keynote-exported, and ODP) -> PDF via headless LibreOffice.
 * A private UserInstallation per run keeps two conversions from fighting over
 * one profile directory, which is the classic way soffice hangs forever.
 */
export async function convertToPdf(src: string, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const profile = join(outDir, ".loprofile");
  await run("soffice", [
    "--headless",
    "--norestore",
    "--nolockcheck",
    "--nodefault",
    `-env:UserInstallation=file://${profile}`,
    "--convert-to", "pdf",
    "--outdir", outDir,
    src,
  ]);
  // soffice exits 0 even when it could not load the document at all (it just
  // prints "source file could not be loaded"), so the only honest check is
  // whether a PDF actually appeared.
  const files = (await readdir(outDir)).filter((f) => f.toLowerCase().endsWith(".pdf"));
  if (!files.length) throw new Error("LibreOffice produced no PDF from that file.");
  return join(outDir, files[0]);
}

/** One JPEG per page, named slide-01.jpg, slide-02.jpg, … */
export async function pdfToImages(pdf: string, outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  await run("pdftoppm", [
    "-jpeg",
    "-jpegopt", "quality=88",
    // Fit 1080p without stretching: -1 on the other axis preserves the ratio.
    "-scale-to-x", "1920",
    "-scale-to-y", "-1",
    pdf,
    join(outDir, "slide"),
  ]);
  const files = (await readdir(outDir))
    .filter((f) => /^slide-?\d+\.jpg$/i.test(f))
    .sort((a, b) => pageNumber(a) - pageNumber(b));
  if (!files.length) throw new Error("No slides came out of that document.");
  return files.map((f) => join(outDir, f));
}

function pageNumber(name: string): number {
  const m = /(\d+)\.jpg$/i.exec(name);
  return m ? Number(m[1]) : 0;
}
