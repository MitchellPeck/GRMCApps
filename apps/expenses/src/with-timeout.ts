// Resolve with `fallback` if `work` has not settled within `ms`.
//
// This exists because of a real failure: on node:20-alpine, pdf2md neither
// resolved nor threw — it simply never settled — so /api/extract hung until the
// browser gave up with ERR_CONNECTION_CLOSED, with nothing in the log after
// "extraction starting". A promise that never settles cannot be caught, so the
// only defence is to stop waiting on it.
//
// A rejection is still a rejection: only silence becomes the fallback.
export function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // unref so a pending timer never holds the event loop open after the work
    // has already finished.
    const timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer.unref === "function") timer.unref();

    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}
