import { Pool } from "pg";
import { getSetting } from "./settings";

const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";

export interface AudioFile {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

export function hasAudioExtension(name: string): boolean {
  return /\.(mp3|mp4|m4a|wav|webm|ogg|oga|mpeg|mpga|flac)$/i.test(name);
}

// Optional server-side transcription of an uploaded audio recording via
// OpenAI Whisper. Only used when an OpenAI key is configured in Settings — the
// primary transcription path is the browser's live speech recognition, which
// needs no key.
export async function transcribeAudio(pool: Pool, file: AudioFile): Promise<string> {
  const key = await getSetting(pool, "openai_api_key");
  if (!key) throw new Error("No OpenAI API key. Add one in Settings to transcribe uploaded audio.");

  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed view so the Blob part type is exact.
  const bytes = new Uint8Array(file.buffer.byteLength);
  bytes.set(file.buffer);
  const blob = new Blob([bytes], { type: file.mimeType || "application/octet-stream" });
  form.append("file", blob, file.fileName || "audio.webm");
  form.append("model", "whisper-1");
  form.append("response_format", "text");

  const res = await fetch(WHISPER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });

  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch { /* keep raw */ }
    throw new Error(msg || `Transcription failed (${res.status})`);
  }
  return text.trim();
}
