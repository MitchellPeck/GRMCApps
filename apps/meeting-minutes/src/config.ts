function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: 3000,
  databaseUrl: `postgres://${required("MEETINGMINUTES_DB_USER")}:${required("MEETINGMINUTES_DB_PASSWORD")}@postgres:5432/${required("MEETINGMINUTES_DB_NAME")}`,
  // Self-hosted Whisper transcription with speaker diarization (internal,
  // keyless). Recorded audio is POSTed to the OpenAI-compatible REST endpoint;
  // audio never leaves the host.
  whisperRestUrl: process.env.WHISPER_REST_URL || "http://whisper:9000",
  // Longest a single transcription may take. Whisper sends nothing until the
  // whole job is done, so the connection is legitimately silent that entire
  // time and this socket timeout is, in effect, the job deadline. It exists
  // only so a wedged whisper cannot block the serial queue forever — set it
  // well above the slowest meeting you expect (a whole-meeting recording of an
  // hour needs hours here at CPU speeds). 0 disables it.
  whisperTimeoutMs: Number(process.env.WHISPER_TIMEOUT_MS || 4 * 60 * 60 * 1000),
  // Whole-meeting recordings are sent to whisper in parts of about this many
  // seconds (cut at pauses). One 70-minute request crashed the whisper
  // container every time; ten-minute parts keep its memory flat.
  whisperChunkSeconds: Math.max(60, Number(process.env.WHISPER_CHUNK_SECONDS || 600)),
  // Send a throwaway clip at boot so the first real recording does not pay
  // for loading the model. Set WHISPER_WARMUP=0 to skip it.
  whisperWarmUp: process.env.WHISPER_WARMUP !== "0",
  // Persistent storage for meeting audio, mounted from the `minutesdata`
  // volume. Recordings are kept for the life of the meeting so a transcription
  // can always be retried or the original audio downloaded.
  dataDir: process.env.MINUTES_DATA_DIR || "/data",
};
