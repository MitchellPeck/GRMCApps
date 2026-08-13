import { Pool } from "pg";
import { pool } from "./db";
import { DiarizedSegment, TranscriptionResult, transcribeAudio } from "./whisper";
import { SpeakerMap, distinctSpeakers, renderTranscript } from "./transcript";
import { absorbMicroTurns, assignPresenterToDominant } from "./speakers";
import { reconcileSpeakers } from "./claude";
import { listPeople } from "./people";
import {
  TranscribeStatus, getAgendaItem, getAttendeeIds, getMeeting, listUnfinishedTranscriptions,
  setTranscribeStatus, updateAgendaItem,
} from "./meetings";
import { getRecording, latestRecording } from "./recordings";
import { readFile } from "node:fs/promises";

export interface TranscribeJob {
  itemId: number;
  recordingId: number;
  path: string;
  fileName: string;
  mimeType: string;
}

// Every side effect is injected so the state machine can be tested with no
// database, filesystem, or network.
export interface QueueDeps {
  transcribe(job: TranscribeJob): Promise<TranscriptionResult>;
  reconcile(job: TranscribeJob, segments: DiarizedSegment[]): Promise<SpeakerMap>;
  setStatus(itemId: number, status: TranscribeStatus, error?: string): Promise<void>;
  saveResult(job: TranscribeJob, segments: DiarizedSegment[], map: SpeakerMap): Promise<void>;
  log(message: string): void;
}

export interface Queue {
  enqueue(job: TranscribeJob): void;
  size(): number;
  idle(): Promise<void>;
}

// A single-consumer FIFO. One transcription runs at a time: concurrent jobs
// would split the whisper container's thread budget and slow every one of them.
export function createQueue(deps: QueueDeps): Queue {
  const pending: TranscribeJob[] = [];
  const idleWaiters: Array<() => void> = [];
  let running = false;

  function releaseIdle(): void {
    while (idleWaiters.length) idleWaiters.shift()!();
  }

  async function runOne(job: TranscribeJob): Promise<void> {
    await deps.setStatus(job.itemId, "processing");
    const started = Date.now();
    const result = await deps.transcribe(job);
    const segments = absorbMicroTurns(result.segments);
    // Reconciliation is advisory: never let it fail a transcription.
    let map: SpeakerMap = {};
    try { map = await deps.reconcile(job, segments); } catch { map = {}; }
    await deps.saveResult(job, segments, map);
    await deps.setStatus(job.itemId, "done");
    const audioSeconds = segments.length ? segments[segments.length - 1].end : 0;
    const elapsed = (Date.now() - started) / 1000;
    const factor = audioSeconds > 0 ? (elapsed / audioSeconds).toFixed(2) : "n/a";
    deps.log(
      `transcribed item ${job.itemId}: ${audioSeconds.toFixed(1)}s audio in ${elapsed.toFixed(1)}s (realtime factor ${factor})`
    );
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const job = pending.shift()!;
        try {
          await runOne(job);
        } catch (e) {
          const message = (e as Error).message || "Transcription failed.";
          deps.log(`transcription failed for item ${job.itemId}: ${message}`);
          try { await deps.setStatus(job.itemId, "error", message); } catch { /* nothing left to do */ }
        }
      }
    } finally {
      running = false;
      releaseIdle();
    }
  }

  return {
    enqueue(job: TranscribeJob): void {
      pending.push(job);
      void drain();
    },
    size(): number {
      return pending.length + (running ? 1 : 0);
    },
    idle(): Promise<void> {
      if (!running && !pending.length) return Promise.resolve();
      return new Promise<void>((resolve) => { idleWaiters.push(resolve); });
    },
  };
}

// ── The real queue ──────────────────────────────────────────────────────────

async function realReconcile(job: TranscribeJob, segments: DiarizedSegment[]): Promise<SpeakerMap> {
  const item = await getAgendaItem(pool, job.itemId);
  if (!item) return {};
  const order = distinctSpeakers(segments);
  if (order.length < 2) return {};
  const meeting = await getMeeting(pool, item.meeting_id);
  const attendeeIds = await getAttendeeIds(pool, item.meeting_id);
  const people = await listPeople(pool, true);
  const byId = new Map(people.map((p) => [p.id, p]));
  const attendees = attendeeIds
    .map((id) => byId.get(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => (p.title ? `${p.name} (${p.title})` : p.name));
  if (!attendees.length) return {};
  const presenters = item.presenter_ids.map((id) => byId.get(id)?.name ?? "").filter(Boolean);
  return reconcileSpeakers(pool, {
    meetingTitle: meeting?.title ?? "",
    itemTitle: item.title,
    transcript: renderTranscript(segments, {}), // positional "Speaker N" labels
    speakerOrder: order,
    attendees,
    presenters,
  });
}

// Give the busiest voice to this item's presenter, but only when that presenter
// is actually marked present at the meeting.
async function withPresenterAssignment(
  itemId: number,
  segments: DiarizedSegment[],
  map: SpeakerMap
): Promise<SpeakerMap> {
  const item = await getAgendaItem(pool, itemId);
  if (!item || !item.presenter_ids.length) return map;
  const attendeeIds = new Set(await getAttendeeIds(pool, item.meeting_id));
  const presentPresenter = item.presenter_ids.find((id) => attendeeIds.has(id));
  if (presentPresenter === undefined) return map;
  const people = await listPeople(pool, true);
  const name = people.find((p) => p.id === presentPresenter)?.name ?? "";
  return assignPresenterToDominant(segments, map, name);
}

export const transcribeQueue: Queue = createQueue({
  transcribe: async (job) => {
    const buffer = await readFile(job.path);
    return transcribeAudio({ fileName: job.fileName, mimeType: job.mimeType, buffer });
  },
  reconcile: realReconcile,
  setStatus: (itemId, status, error) => setTranscribeStatus(pool, itemId, status, error ?? ""),
  saveResult: async (job, segments, map) => {
    const withPresenter = await withPresenterAssignment(job.itemId, segments, map);
    await updateAgendaItem(pool, job.itemId, { transcriptSegments: segments, speakerMap: withPresenter });
  },
  log: (message) => { console.log(`[transcribe] ${message}`); },
});

export function enqueueTranscription(job: TranscribeJob): void {
  transcribeQueue.enqueue(job);
}

// Re-enqueue any item whose transcription a restart interrupted. This is why
// audio is written to disk before a job is queued.
export async function recoverPendingJobs(dbPool: Pool = pool): Promise<number> {
  const itemIds = await listUnfinishedTranscriptions(dbPool);
  let recovered = 0;
  for (const itemId of itemIds) {
    const rec = await latestRecording(dbPool, itemId);
    if (!rec || !rec.storage_path) {
      await setTranscribeStatus(dbPool, itemId, "error", "Transcription was interrupted and no recording was stored.");
      continue;
    }
    await setTranscribeStatus(dbPool, itemId, "queued");
    enqueueTranscription({
      itemId,
      recordingId: rec.id,
      path: rec.storage_path,
      fileName: rec.file_name,
      mimeType: rec.mime_type,
    });
    recovered++;
  }
  return recovered;
}

// Queue a specific stored recording (used by the Retry / Re-transcribe action).
export async function enqueueStoredRecording(itemId: number, recordingId: number): Promise<boolean> {
  const rec = await getRecording(pool, recordingId);
  if (!rec || rec.item_id !== itemId || !rec.storage_path) return false;
  await setTranscribeStatus(pool, itemId, "queued");
  enqueueTranscription({
    itemId,
    recordingId: rec.id,
    path: rec.storage_path,
    fileName: rec.file_name,
    mimeType: rec.mime_type,
  });
  return true;
}
