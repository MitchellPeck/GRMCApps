import { config } from "./config";

export interface AudioFile {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

export function hasAudioExtension(name: string): boolean {
  return /\.(mp3|mp4|m4a|wav|webm|ogg|oga|mpeg|mpga|flac)$/i.test(name);
}

// Transcribe an uploaded audio recording via the self-hosted WhisperLive
// container's OpenAI-compatible REST endpoint. No API key — the service runs
// on the private hubnet and audio never leaves the host.
export async function transcribeAudio(file: AudioFile): Promise<string> {
  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed view so the Blob part type is exact.
  const bytes = new Uint8Array(file.buffer.byteLength);
  bytes.set(file.buffer);
  const blob = new Blob([bytes], { type: file.mimeType || "application/octet-stream" });
  form.append("file", blob, file.fileName || "audio.webm");
  form.append("model", "whisper-1"); // model is selected server-side; value ignored
  form.append("language", "en");
  form.append("response_format", "json");

  let res: Response;
  try {
    res = await fetch(`${config.whisperRestUrl}/v1/audio/transcriptions`, { method: "POST", body: form });
  } catch (e) {
    throw new Error("Transcription service is unreachable. Is the whisper container running?");
  }

  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error?.message || JSON.parse(text).detail || text; } catch { /* keep raw */ }
    throw new Error(msg || `Transcription failed (${res.status})`);
  }
  try {
    const data = JSON.parse(text);
    return String(data.text ?? "").trim();
  } catch {
    return text.trim(); // plain-text response_format fallback
  }
}
