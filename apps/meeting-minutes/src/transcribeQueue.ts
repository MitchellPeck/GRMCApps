import { Pool } from "pg";
import { pool } from "./db";
import { applyActiveFixes } from "./fixes";
import { DiarizedSegment, TranscriptionResult, transcribeAudio } from "./whisper";
import { SpeakerMap, distinctSpeakers, renderTranscript } from "./transcript";
import { absorbMicroTurns, assignPresenterToDominant } from "./speakers";
import { reconcileSpeakers } from "./claude";
import { listPeople } from "./people";
import {
  TranscribeStatus, getAgendaItem, getAttendeeIds, getMeeting, listUnfinishedTranscriptions,
  setTranscribeStatus, updateAgendaItem, MeetingRecordingStatus, setMeetingRecordingStatus,
  listUnfinishedMeetingProcessing, listTopicMarkers, setMeetingSpeakerMap, listAgendaItems, addAgendaItem,
  presentPeople, listGuests, itemPresenterNames,
} from "./meetings";
import { getRecording, latestRecording, getMeetingRecording, latestMeetingRecording } from "./recordings";
import { segmentByMarkers, chronologicalSpeakerOrder, TopicMarker } from "./segmentation";
import { readFile } from "node:fs/promises";
import { transcribeLongAudio } from "./chunking";
import { embedSpeaker } from "./speakerEmbedding";
import { config } from "./config";
import { createQueue, Queue, QueueTask } from "./queue";
import { advanceReport, itemHasContent, requestSummary } from "./minutesWork";

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
  log(message: string): void; // must not throw; the queue guards every call site anyway
}

// The generic serial queue lives in queue.ts; re-exported for existing callers.
export { createQueue } from "./queue";
export type { Queue, QueueTask } from "./queue";

// ── Job timing ──────────────────────────────────────────────────────────────

// One line covering where a job's wall-clock actually went. The split matters:
// "slow transcription" is usually whisper on CPU, but it can equally be the
// speaker-reconciliation call to Claude, and the aggregate number cannot tell
// the two apart. Realtime factor is elapsed ÷ audio duration — under 1.0 is
// faster than the recording itself.
export function timingSummary(
  audioSeconds: number,
  started: number,
  transcribed: number,
  reconciled: number
): string {
  const whisper = (transcribed - started) / 1000;
  const reconcile = (reconciled - transcribed) / 1000;
  const elapsed = (Date.now() - started) / 1000;
  const factor = audioSeconds > 0 ? (elapsed / audioSeconds).toFixed(2) : "n/a";
  return `${audioSeconds.toFixed(1)}s audio in ${elapsed.toFixed(1)}s `
    + `(whisper ${whisper.toFixed(1)}s, speaker naming ${reconcile.toFixed(1)}s, realtime factor ${factor})`;
}

// ── Item transcription pipeline ─────────────────────────────────────────────

// The per-item pipeline: transcribe, absorb diarization glitches, reconcile
// speaker names (best-effort), save, and log timing. Exported standalone (no
// longer nested inside the queue) so both `createItemQueue` and the real
// queue can drive it — which is why its own log call is self-guarded.
export async function runItemJob(deps: QueueDeps, job: TranscribeJob): Promise<void> {
  await deps.setStatus(job.itemId, "processing");
  const started = Date.now();
  const result = await deps.transcribe(job);
  const transcribed = Date.now();
  const segments = absorbMicroTurns(result.segments);
  // Reconciliation is advisory: never let it fail a transcription.
  let map: SpeakerMap = {};
  try { map = await deps.reconcile(job, segments); } catch { map = {}; }
  const reconciled = Date.now();
  await deps.saveResult(job, segments, map);
  await deps.setStatus(job.itemId, "done");
  const audioSeconds = segments.length ? segments[segments.length - 1].end : 0;
  try {
    deps.log(`transcribed item ${job.itemId}: ${timingSummary(audioSeconds, started, transcribed, reconciled)}`);
  } catch { /* logging must never break the pipeline */ }
}

function itemTask(deps: QueueDeps, job: TranscribeJob): QueueTask {
  return {
    label: `item ${job.itemId}`,
    run: () => runItemJob(deps, job),
    fail: (message) => deps.setStatus(job.itemId, "error", message),
  };
}

// Test shim preserving the pre-generic-refactor injected-deps item semantics
// exactly: a fresh generic queue wired to `deps.log`, translating
// `TranscribeJob`s into `QueueTask`s via `runItemJob` / `deps.setStatus`.
export function createItemQueue(deps: QueueDeps): { enqueue(job: TranscribeJob): void; size(): number; idle(): Promise<void> } {
  const q = createQueue(deps.log);
  return {
    enqueue: (job: TranscribeJob) => q.enqueue(itemTask(deps, job)),
    size: () => q.size(),
    idle: () => q.idle(),
  };
}

// ── Meeting transcription pipeline ──────────────────────────────────────────

export interface MeetingJob {
  meetingId: number;
  recordingId: number;
  path: string;
  mimeType: string;
}

// Every side effect is injected, matching QueueDeps, so the whole-meeting
// pipeline is unit-tested with no database, filesystem, or network either.
export interface MeetingDeps {
  transcribe(job: MeetingJob): Promise<TranscriptionResult>;
  reconcile(job: MeetingJob, segments: DiarizedSegment[]): Promise<SpeakerMap>;
  setStatus(meetingId: number, status: MeetingRecordingStatus, error?: string): Promise<void>;
  loadMarkers(recordingId: number): Promise<TopicMarker[]>;
  fallbackItemId(meetingId: number): Promise<number>;
  presenterFor(itemId: number): Promise<string>;
  saveItem(itemId: number, segments: DiarizedSegment[], map: SpeakerMap, order: string[], recordingId: number): Promise<void>;
  saveMeetingMap(meetingId: number, map: SpeakerMap): Promise<void>;
  log(message: string): void; // must not throw
}

// Spec: docs/superpowers/specs/2026-08-14-whole-meeting-recording-design.md §3.
export async function runMeetingJob(d: MeetingDeps, job: MeetingJob): Promise<void> {
  await d.setStatus(job.meetingId, "processing");
  const started = Date.now();
  const result = await d.transcribe(job);
  const transcribed = Date.now();
  const segments = absorbMicroTurns(result.segments);
  let map: SpeakerMap = {};
  try { map = await d.reconcile(job, segments); } catch { map = {}; }
  const reconciled = Date.now();
  const markers = await d.loadMarkers(job.recordingId);
  const fallback = await d.fallbackItemId(job.meetingId);
  const byItem = segmentByMarkers(segments, markers, fallback);
  // Each topic's presenter claims that topic's dominant unnamed voice.
  for (const [itemId, segs] of byItem) {
    const presenter = await d.presenterFor(itemId);
    if (presenter) map = assignPresenterToDominant(segs, map, presenter);
  }
  const order = chronologicalSpeakerOrder([...byItem.values()]);
  for (const [itemId, segs] of byItem) {
    await d.saveItem(itemId, segs, map, order, job.recordingId);
  }
  await d.saveMeetingMap(job.meetingId, map);
  await d.setStatus(job.meetingId, "done");
  const audioSeconds = segments.length ? segments[segments.length - 1].end : 0;
  try {
    d.log(`processed meeting ${job.meetingId}: ${byItem.size} topic(s), `
      + timingSummary(audioSeconds, started, transcribed, reconciled));
  } catch { /* logging must never break the pipeline — a throw here must not flip a finished job to error */ }
}

function meetingTask(deps: MeetingDeps, job: MeetingJob): QueueTask {
  return {
    label: `meeting ${job.meetingId}`,
    run: () => runMeetingJob(deps, job),
    fail: (message) => deps.setStatus(job.meetingId, "error", message),
  };
}

// ── The real queue ──────────────────────────────────────────────────────────
// ONE shared instance carries both job kinds: items and whole-meetings both
// hit the same whisper container, so sharing the queue guarantees they never
// run concurrently.

function realLog(message: string): void {
  console.log(`[transcribe] ${message}`);
}

export const transcribeQueue: Queue = createQueue(realLog);

// Everyone present, library attendees and guests alike, as the "Name (Title)"
// strings speaker reconciliation chooses from.
async function presentLabels(meetingId: number): Promise<string[]> {
  return (await presentPeople(pool, meetingId)).map((p) => (p.title ? `${p.name} (${p.title})` : p.name));
}

async function realReconcile(job: TranscribeJob, segments: DiarizedSegment[]): Promise<SpeakerMap> {
  const item = await getAgendaItem(pool, job.itemId);
  if (!item) return {};
  const order = distinctSpeakers(segments);
  if (order.length < 2) return {};
  const meeting = await getMeeting(pool, item.meeting_id);
  const people = await listPeople(pool, true);
  const byId = new Map(people.map((p) => [p.id, p]));
  const attendees = await presentLabels(item.meeting_id);
  if (!attendees.length) return {};
  const guests = new Map((await listGuests(pool, item.meeting_id)).map((g) => [g.id, g.name]));
  const presenters = itemPresenterNames(item, new Map([...byId].map(([id, p]) => [id, p.name])), guests);
  return reconcileSpeakers(pool, {
    meetingTitle: meeting?.title ?? "",
    itemTitle: item.title,
    transcript: renderTranscript(segments, {}), // positional "Speaker N" labels
    speakerOrder: order,
    attendees,
    presenters,
  });
}

// The presenter-if-attendee name for an item: "" when the item has no
// presenter, or none of its presenters are marked present at the meeting.
// A guest presenter counts, after any library presenter who is present.
// Shared by the per-item presenter fill (below) and the whole-meeting one
// (`realMeetingDeps.presenterFor`). `dbPool` defaults to the real singleton
// but is overridable — tests inject a pool pointed at TEST_DATABASE_URL
// rather than the module's pool, which is always wired to the production
// `postgres` host.
export async function presenterNameForItem(itemId: number, dbPool: Pool = pool): Promise<string> {
  const item = await getAgendaItem(dbPool, itemId);
  if (!item) return "";
  const attendeeIds = new Set(await getAttendeeIds(dbPool, item.meeting_id));
  const presentPresenter = item.presenter_ids.find((id) => attendeeIds.has(id));
  if (presentPresenter !== undefined) {
    const people = await listPeople(dbPool, true);
    const name = people.find((p) => p.id === presentPresenter)?.name;
    if (name) return name;
  }
  // Guests are present by definition.
  if (!item.guest_presenter_ids.length) return "";
  const guests = await listGuests(dbPool, item.meeting_id);
  return guests.find((g) => g.id === item.guest_presenter_ids[0])?.name ?? "";
}

// Give the busiest voice to this item's presenter, but only when that
// presenter is actually marked present at the meeting (assignPresenterToDominant
// is itself a no-op on an empty name, so no presenter/non-attendee is a no-op).
async function withPresenterAssignment(
  itemId: number,
  segments: DiarizedSegment[],
  map: SpeakerMap,
  dbPool: Pool = pool
): Promise<SpeakerMap> {
  const name = await presenterNameForItem(itemId, dbPool);
  return assignPresenterToDominant(segments, map, name);
}

// Persist a finished per-topic transcription. New transcript content
// invalidates any previous summary; the client regenerates it under the
// summary gate once the item is closed. `dbPool` defaults to the real
// singleton (see `withPresenterAssignment` above); tests pass their own pool
// explicitly.
export async function saveTranscriptionResult(
  itemId: number,
  segments: DiarizedSegment[],
  map: SpeakerMap,
  recordingId: number,
  dbPool: Pool = pool
): Promise<void> {
  const withPresenter = await withPresenterAssignment(itemId, segments, map, dbPool);
  const item = await getAgendaItem(dbPool, itemId);
  const fixed = item ? await applyActiveFixes(dbPool, item.meeting_id, itemId, segments) : segments;
  await updateAgendaItem(dbPool, itemId, {
    transcriptSegments: fixed,
    transcriptRecordingId: recordingId,
    speakerMap: withPresenter,
    summary: "",
    actionItems: [],
    status: "pending",
    transcriptSource: "topic",
  });
}

const realItemDeps: QueueDeps = {
  transcribe: async (job) => {
    const buffer = await readFile(job.path);
    return transcribeAudio({ fileName: job.fileName, mimeType: job.mimeType, buffer });
  },
  reconcile: realReconcile,
  setStatus: async (itemId, status, error) => {
    await setTranscribeStatus(pool, itemId, status, error ?? "");
    // The new transcript needs a summary; a failure may be what a requested
    // report was waiting on.
    if (status === "done") await requestSummary(itemId);
    if (status === "error") {
      const item = await getAgendaItem(pool, itemId);
      if (item) await advanceReport(item.meeting_id);
    }
  },
  saveResult: (job, segments, map) => saveTranscriptionResult(job.itemId, segments, map, job.recordingId),
  log: realLog,
};

export function enqueueTranscription(job: TranscribeJob): void {
  transcribeQueue.enqueue(itemTask(realItemDeps, job));
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

// ── Whole-meeting real wiring ────────────────────────────────────────────────

// Mirrors realReconcile above at meeting scope: one Claude pass over the
// entire meeting transcript rather than one per topic.
async function realMeetingReconcile(job: MeetingJob, segments: DiarizedSegment[]): Promise<SpeakerMap> {
  const meeting = await getMeeting(pool, job.meetingId);
  if (!meeting) return {};
  const order = distinctSpeakers(segments);
  if (order.length < 2) return {};
  const people = await listPeople(pool, true);
  const byId = new Map(people.map((p) => [p.id, p]));
  const attendees = await presentLabels(job.meetingId);
  if (!attendees.length) return {};
  const items = await listAgendaItems(pool, job.meetingId);
  const names = new Map([...byId].map(([id, p]) => [id, p.name]));
  const guests = new Map((await listGuests(pool, job.meetingId)).map((g) => [g.id, g.name]));
  const presenters = [...new Set(items.flatMap((it) => itemPresenterNames(it, names, guests)))];
  return reconcileSpeakers(pool, {
    meetingTitle: meeting.title,
    itemTitle: "Full meeting",
    transcript: renderTranscript(segments, {}), // positional "Speaker N" labels
    speakerOrder: order,
    attendees,
    presenters,
  });
}

// The topic to attribute audio to when a recording carries no markers at all
// (e.g. the meeting was never clicked into a topic): the first agenda item by
// position, or a freshly-created placeholder when the meeting has none.
async function fallbackItemId(meetingId: number): Promise<number> {
  const items = await listAgendaItems(pool, meetingId);
  if (items.length) return items[0].id;
  const added = await addAgendaItem(pool, meetingId, "Meeting recording", "");
  if (!added.ok) throw new Error(added.error);
  return added.id;
}

async function saveMeetingItem(
  itemId: number,
  segments: DiarizedSegment[],
  map: SpeakerMap,
  order: string[],
  recordingId: number
): Promise<void> {
  const item = await getAgendaItem(pool, itemId);
  const fixed = item ? await applyActiveFixes(pool, item.meeting_id, itemId, segments) : segments;
  await updateAgendaItem(pool, itemId, {
    transcriptSegments: fixed,
    transcriptRecordingId: recordingId,
    speakerMap: map,
    summary: "",
    actionItems: [],
    status: "pending",
    transcriptSource: "meeting",
    speakerOrder: order,
  });
  await setTranscribeStatus(pool, itemId, "done");
}

const realMeetingDeps: MeetingDeps = {
  // Read-only on job.path: the stored recording is never modified, so a failed
  // run can always be reprocessed.
  transcribe: async (job) => transcribeLongAudio(job.path, config.whisperChunkSeconds, {
    transcribe: (file) => transcribeAudio(file),
    embed: embedSpeaker,
    log: (message) => realLog(`meeting ${job.meetingId}: ${message}`),
  }, {
    // Never report more voices than people marked present — and, when no one
    // is marked present, still no more than a page can sensibly show.
    maxSpeakers: (await presentPeople(pool, job.meetingId)).length || 12,
  }),
  reconcile: realMeetingReconcile,
  setStatus: async (meetingId, status, error) => {
    await setMeetingRecordingStatus(pool, meetingId, status, error ?? "");
    if (status === "done") {
      // Every topic the recording covered has a fresh, unsummarized transcript.
      for (const it of await listAgendaItems(pool, meetingId)) {
        if (it.transcript_source === "meeting" && itemHasContent(it) && !it.summary.trim()) await requestSummary(it.id);
      }
    }
    if (status === "error") await advanceReport(meetingId);
  },
  loadMarkers: (recordingId) => listTopicMarkers(pool, recordingId),
  fallbackItemId,
  presenterFor: (itemId) => presenterNameForItem(itemId),
  saveItem: saveMeetingItem,
  saveMeetingMap: (meetingId, map) => setMeetingSpeakerMap(pool, meetingId, map),
  log: realLog,
};

function enqueueMeetingTask(job: MeetingJob): void {
  transcribeQueue.enqueue(meetingTask(realMeetingDeps, job));
}

// Queue a stored whole-meeting recording for processing (used by finish and
// by the retry / reprocess action).
export async function enqueueMeetingProcessing(meetingId: number, recordingId: number): Promise<boolean> {
  const rec = await getMeetingRecording(pool, recordingId);
  if (!rec || rec.meeting_id !== meetingId || !rec.storage_path) return false;
  await setMeetingRecordingStatus(pool, meetingId, "queued");
  enqueueMeetingTask({ meetingId, recordingId: rec.id, path: rec.storage_path, mimeType: rec.mime_type });
  return true;
}

// Re-enqueue any meeting whose whole-recording processing a restart
// interrupted, mirroring `recoverPendingJobs` above.
export async function recoverPendingMeetingJobs(dbPool: Pool = pool): Promise<number> {
  const meetingIds = await listUnfinishedMeetingProcessing(dbPool);
  let recovered = 0;
  for (const meetingId of meetingIds) {
    const rec = await latestMeetingRecording(dbPool, meetingId);
    if (!rec || !rec.storage_path) {
      await setMeetingRecordingStatus(dbPool, meetingId, "error", "Processing was interrupted and no recording was stored.");
      continue;
    }
    await setMeetingRecordingStatus(dbPool, meetingId, "queued");
    enqueueMeetingTask({ meetingId, recordingId: rec.id, path: rec.storage_path, mimeType: rec.mime_type });
    recovered++;
  }
  return recovered;
}
