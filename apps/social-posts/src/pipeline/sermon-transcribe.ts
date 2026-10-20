// A sermon recording to text: ffmpeg pulls out 16 kHz mono audio and cuts it
// into parts Whisper can take, the Whisper server (the one Meeting Minutes
// uses) transcribes each part, and the parts are stitched back together with
// their real start times.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Segment { start: number; end: number; text: string }
export interface PartResult { offset: number; text: string; segments: Segment[] }

export function mergeParts(parts: PartResult[]): { text: string; segments: Segment[] } {
  return {
    text: parts.map((p) => p.text.trim()).filter(Boolean).join("\n\n"),
    segments: parts.flatMap((p) => p.segments.map((s) => ({
      start: Math.round((s.start + p.offset) * 100) / 100, end: Math.round((s.end + p.offset) * 100) / 100, text: s.text.trim(),
    }))),
  };
}

/** A WAV's length in seconds, from its fmt byte rate and data size. */
export function wavDurationSeconds(buf: Buffer): number {
  let pos = 12, byteRate = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4), size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(pos + 16);
    if (id === "data") return byteRate ? size / byteRate : 0;
    pos += 8 + size + (size % 2);
  }
  return 0;
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-nostats", "-nostdin", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    p.on("error", (e) => reject(new Error("ffmpeg isn't available: " + e.message)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("Couldn't read the recording's audio. " + err.trim().split("\n").pop()))));
  });
}

/** OpenAI-style transcription call. Uses node:http, not fetch: undici's
 *  header timeout would cut off a long part (as Meeting Minutes found). */
export function whisperTranscribe(baseUrl: string, wav: Buffer, timeoutMs = 60 * 60 * 1000): Promise<{ text: string; segments: Segment[] }> {
  const boundary = "----grmc" + Date.now().toString(16);
  const field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(field("model", "whisper-1") + field("language", "en") + field("response_format", "verbose_json")),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wav, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const url = new URL("/v1/audio/transcriptions", baseUrl);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": body.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let j: any = {};
        try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* reported below */ }
        if ((res.statusCode || 500) >= 300) return reject(new Error("Transcription failed: " + (j.error?.message || j.detail || `HTTP ${res.statusCode}`)));
        resolve({ text: String(j.text || ""), segments: (j.segments || []).filter((s: any) => String(s.text || "").trim())
          .map((s: any) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text) })) });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Transcription timed out.")));
    req.on("error", (e: NodeJS.ErrnoException) => reject(new Error(
      ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(e.code || "") ? "The transcription service isn't reachable." : "Transcription failed: " + e.message)));
    req.end(body);
  });
}

export async function transcribeRecording(
  input: string, opts: { whisperUrl: string; partSeconds?: number; onProgress?: (part: number, of: number) => Promise<void> | void },
): Promise<{ text: string; segments: Segment[]; durationSeconds: number }> {
  const work = await mkdtemp(join(tmpdir(), "sermon-"));
  try {
    const full = join(work, "full.wav");
    await ffmpeg(["-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", full]);
    await ffmpeg(["-i", full, "-c", "copy", "-f", "segment", "-segment_time", String(opts.partSeconds || 600),
                  "-reset_timestamps", "1", join(work, "part%03d.wav")]);
    const names = (await readdir(work)).filter((n) => /^part\d+\.wav$/.test(n)).sort();
    const parts: PartResult[] = [];
    let offset = 0;
    for (let i = 0; i < names.length; i++) {
      if (opts.onProgress) await opts.onProgress(i + 1, names.length);
      const wav = await readFile(join(work, names[i]));
      const r = await whisperTranscribe(opts.whisperUrl, wav);
      parts.push({ offset, text: r.text, segments: r.segments });
      // Each part's real length, not the requested cut, so times stay true.
      offset += wavDurationSeconds(wav);
    }
    return { ...mergeParts(parts), durationSeconds: Math.round(offset * 10) / 10 };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
