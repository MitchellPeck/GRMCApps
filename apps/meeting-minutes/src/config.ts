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
  // Persistent storage for meeting audio, mounted from the `minutesdata`
  // volume. Recordings are kept for the life of the meeting so a transcription
  // can always be retried or the original audio downloaded.
  dataDir: process.env.MINUTES_DATA_DIR || "/data",
};
