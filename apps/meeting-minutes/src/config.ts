function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: 3000,
  databaseUrl: `postgres://${required("MEETINGMINUTES_DB_USER")}:${required("MEETINGMINUTES_DB_PASSWORD")}@postgres:5432/${required("MEETINGMINUTES_DB_NAME")}`,
  // Self-hosted WhisperLive transcription service (internal, keyless). The
  // browser streams mic PCM to the app's /ws/transcribe, which relays to the
  // WS endpoint; uploaded audio files are transcribed via the REST endpoint.
  whisperWsUrl: process.env.WHISPER_WS_URL || "ws://whisper:9090",
  whisperRestUrl: process.env.WHISPER_REST_URL || "http://whisper:8000",
  // Must match the model the whisper container loaded (WHISPERLIVE_MODEL).
  whisperModel: process.env.WHISPER_MODEL || "small",
};
