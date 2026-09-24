import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { config } from "./config";

export interface AudioFile {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

export interface DiarizedSegment {
  text: string;
  speaker: string; // e.g. "SPEAKER_00"; "" when diarization produced no label
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  segments: DiarizedSegment[];
}

// Containers whisper can decode. Single source of truth for both the upload
// filter and the filename we hand the transcription service.
export const AUDIO_EXTENSIONS = ["mp3", "mp4", "m4a", "wav", "webm", "ogg", "oga", "mpeg", "mpga", "flac"];

const MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm", "video/webm": "webm",
  "audio/mp4": "m4a", "video/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/flac": "flac",
};

export function hasAudioExtension(name: string): boolean {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name.trim())?.[1]?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.includes(ext);
}

// Normalize the whisper server's verbose_json segments into our shape.
export function parseVerboseJson(raw: string): TranscriptionResult {
  let data: any;
  try { data = JSON.parse(raw); } catch { return { text: raw.trim(), segments: [] }; }
  const segments: DiarizedSegment[] = Array.isArray(data.segments)
    ? data.segments
        .map((s: any) => ({
          text: String(s.text ?? "").trim(),
          speaker: String(s.speaker ?? "").trim(),
          start: Number(s.start ?? 0),
          end: Number(s.end ?? 0),
        }))
        .filter((s: DiarizedSegment) => s.text.length > 0)
    : [];
  return { text: String(data.text ?? "").trim(), segments };
}

// The extension is the only part of the upload filename whisper uses (it picks
// the decoder from it), so we send a generated name rather than the user's.
// That keeps arbitrary text out of the multipart headers entirely.
export function uploadName(fileName: string, mimeType: string): string {
  const fromName = /\.([A-Za-z0-9]+)$/.exec(fileName.trim())?.[1]?.toLowerCase() ?? "";
  if (AUDIO_EXTENSIONS.includes(fromName)) return `audio.${fromName}`;
  const fromMime = MIME_EXTENSIONS[mimeType.trim().toLowerCase().split(";")[0]];
  return `audio.${fromMime ?? "webm"}`;
}

// Build a multipart/form-data body by hand. Every part name and value below is
// a fixed ASCII literal except the audio bytes, so no escaping is required.
function multipartBody(boundary: string, file: AudioFile, fields: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${uploadName(file.fileName, file.mimeType)}"\r\n` +
    `Content-Type: ${/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType) ? file.mimeType : "application/octet-stream"}\r\n\r\n`
  ));
  parts.push(file.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

interface HttpResult { status: number; body: string }

// POST the body over node:http(s) rather than global fetch. Whisper answers
// only when the whole transcription is finished, and fetch/undici gives up
// waiting for response headers after 300 seconds — which silently capped every
// recording at roughly a hundred seconds of audio and surfaced as a bogus
// "service unreachable" error. A plain request has no such ceiling, so the
// only deadline is the configured one.
function postMultipart(url: string, body: Buffer, boundary: string, timeoutMs: number): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = transport(
      target,
      {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(body.byteLength),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(
          `Transcription did not finish within ${Math.round(timeoutMs / 60000)} minutes. ` +
          `Raise WHISPER_TIMEOUT_MS, or shorten the recording.`
        ));
      });
    }
    req.on("error", reject);
    req.end(body);
  });
}

// Transcribe (and diarize) an audio recording via the self-hosted whisper
// container's OpenAI-compatible REST endpoint. No API key — the service runs on
// the private hubnet and audio never leaves the host. verbose_json gives
// per-segment `speaker` labels when diarization is enabled server-side.
export async function transcribeAudio(file: AudioFile, timeoutMs?: number): Promise<TranscriptionResult> {
  const boundary = `----minutes${randomBytes(16).toString("hex")}`;
  const body = multipartBody(boundary, file, {
    model: "whisper-1", // model is selected server-side; value ignored
    language: "en",
    response_format: "verbose_json",
  });

  let res: HttpResult;
  try {
    res = await postMultipart(
      `${config.whisperRestUrl}/v1/audio/transcriptions`,
      body,
      boundary,
      timeoutMs ?? config.whisperTimeoutMs
    );
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
      throw new Error("Transcription service is unreachable. Is the whisper container running?");
    }
    if (err.code === "ECONNRESET" || /socket hang up/i.test(err.message || "")) {
      throw new Error(
        "The transcription service dropped the connection mid-job — the whisper container most likely " +
        "crashed or restarted (see `docker compose logs whisper`). The recording is kept; retry to reprocess it."
      );
    }
    throw new Error(err.message || "Transcription failed.");
  }

  if (res.status < 200 || res.status >= 300) {
    let msg = res.body;
    try { const j = JSON.parse(res.body); msg = j.error?.message || j.detail || res.body; } catch { /* keep raw */ }
    throw new Error(msg || `Transcription failed (${res.status})`);
  }
  return parseVerboseJson(res.body);
}

// ── Warm-up ─────────────────────────────────────────────────────────────────

// A valid, near-silent 16 kHz mono WAV. Whisper resamples everything to this
// anyway, so it is the cheapest possible input that still exercises the whole
// pipeline (decode → transcribe → diarize).
function silentWav(seconds: number): Buffer {
  const rate = 16000, samples = Math.round(rate * seconds), dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes); // header + 16-bit PCM zeroes
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);         // fmt chunk size
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);   // byte rate
  buf.writeUInt16LE(2, 32);          // block align
  buf.writeUInt16LE(16, 34);         // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

// The whisper image loads its ~465 MB model and its diarization models lazily,
// on the first request — so the first recording of the day pays for that on top
// of its own transcription, which is the classic "why did a 90-second clip take
// five minutes?". Sending a throwaway clip at boot moves that cost off the
// critical path. Best-effort in every respect: whisper may not be up yet, and
// nothing here may ever fail a boot.
export async function warmUpWhisper(log: (message: string) => void): Promise<boolean> {
  const started = Date.now();
  try {
    // Its own short deadline: a warm-up that has not landed in a few minutes
    // has nothing left to give, and must not hold a socket for hours.
    await transcribeAudio(
      { fileName: "warmup.wav", mimeType: "audio/wav", buffer: silentWav(0.5) },
      5 * 60 * 1000
    );
    log(`whisper warm-up finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return true;
  } catch (e) {
    // A cold miss only means the first real recording pays the load cost.
    log(`whisper warm-up skipped after ${((Date.now() - started) / 1000).toFixed(1)}s: ${(e as Error).message}`);
    return false;
  }
}
