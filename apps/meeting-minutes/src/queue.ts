// The generic serial queue shared by transcription and AI work.

// One unit of work on the shared queue. Item transcription and whole-meeting
// transcription both reduce to {label, run, fail} so they can share one
// serial runner and can never run concurrently.
export interface QueueTask {
  label: string;
  run(): Promise<void>;
  fail(message: string): Promise<void>;
}

export interface Queue {
  enqueue(task: QueueTask): void;
  size(): number;
  idle(): Promise<void>;
}

// A single-consumer FIFO. One task runs at a time: concurrent transcriptions
// would split the whisper container's thread budget and slow every one of
// them. Generic over `{label, run, fail}` so every job kind (per-item,
// whole-meeting) can share this one runner.
export function createQueue(log: (message: string) => void): Queue {
  const pending: QueueTask[] = [];
  const idleWaiters: Array<() => void> = [];
  let running = false;

  function releaseIdle(): void {
    while (idleWaiters.length) idleWaiters.shift()!();
  }

  // `log` is documented as must-not-throw, but we guard anyway: a throwing
  // logger (e.g. EPIPE on stdout) must never be mistaken for a job failure or
  // escape as an unhandled rejection.
  function safeLog(message: string): void {
    try { log(message); } catch { /* logging must never break the queue */ }
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const task = pending.shift()!;
        try {
          await task.run();
        } catch (e) {
          const message = (e as Error).message || `${task.label} failed.`;
          safeLog(`${task.label} failed: ${message}`);
          try { await task.fail(message); } catch { /* nothing left to do */ }
        }
      }
    } finally {
      running = false;
      releaseIdle();
    }
  }

  return {
    enqueue(task: QueueTask): void {
      pending.push(task);
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
