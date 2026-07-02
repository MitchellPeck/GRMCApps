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

export function hasAudioExtension(name: string): boolean {
  return /\.(mp3|mp4|m4a|wav|webm|ogg|oga|mpeg|mpga|flac)$/i.test(name);
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

// Transcribe (and diarize) an audio recording via the self-hosted whisper
// container's OpenAI-compatible REST endpoint. No API key — the service runs on
// the private hubnet and audio never leaves the host. verbose_json gives
// per-segment `speaker` labels when diarization is enabled server-side.
export async function transcribeAudio(file: AudioFile): Promise<TranscriptionResult> {
  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed view so the Blob part type is exact.
  const bytes = new Uint8Array(file.buffer.byteLength);
  bytes.set(file.buffer);
  const blob = new Blob([bytes], { type: file.mimeType || "application/octet-stream" });
  form.append("file", blob, file.fileName || "audio.webm");
  form.append("model", "whisper-1"); // model is selected server-side; value ignored
  form.append("language", "en");
  form.append("response_format", "verbose_json");

  let res: Response;
  try {
    res = await fetch(`${config.whisperRestUrl}/v1/audio/transcriptions`, { method: "POST", body: form });
  } catch {
    throw new Error("Transcription service is unreachable. Is the whisper container running?");
  }

  const raw = await res.text();
  if (!res.ok) {
    let msg = raw;
    try { const j = JSON.parse(raw); msg = j.error?.message || j.detail || raw; } catch { /* keep raw */ }
    throw new Error(msg || `Transcription failed (${res.status})`);
  }
  return parseVerboseJson(raw);
}
