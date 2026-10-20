// Browser-side regression tests for the shared modal's destructive-action gate
// and for the whole-meeting recording lock on the per-topic recorder.
//
// These drive the real src/public/app.js inside a DOM. jsdom is deliberately
// NOT a dependency of this app — it would ship in the runtime image, which
// installs devDependencies to build. Install it where you run the tests
// (`npm i -D jsdom`) and these run; without it they skip, the same way the
// database tests skip without TEST_DATABASE_URL.
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let JSDOM: any = null;
try { ({ JSDOM } = require("jsdom")); } catch { /* not installed — tests skip */ }

// src/public when running from a plain `tsc` build, dist/public in the image.
const PUBLIC_DIRS = [join(__dirname, "..", "src", "public"), join(__dirname, "public")];
const publicDir = PUBLIC_DIRS.find((d) => existsSync(join(d, "app.js"))) ?? "";
const skip = !JSDOM || !publicDir;

interface Call { path: string; method: string }

// JSON request bodies, keyed by the call they belong to, for tests that check
// what was sent. Kept off Call so existing deepEqual checks are unaffected.
const sentBodies = new WeakMap<Call, any>();

// jsdom windows keep live timers, which hold the event loop open and stop the
// test process from ever exiting. Close every window this file opened.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const openWindows: any[] = [];
after(() => {
  for (const w of openWindows) { try { w.close(); } catch { /* already torn down */ } }
  openWindows.length = 0;
});

// Boot index.html + app.js in a DOM with fetch stubbed, then put the page into
// "one meeting open, one agenda item" state. Returns the window plus the list
// of requests the page has made so far.
function boot(): { w: any; doc: any; calls: Call[] } {
  const dom = new JSDOM(readFileSync(join(publicDir, "index.html"), "utf8"), {
    runScripts: "outside-only",
    url: "https://minutes.test/",
  });
  const w = dom.window;
  openWindows.push(w);
  const calls: Call[] = [];
  w.fetch = (path: string, opts: { method?: string; body?: string } = {}) => {
    const call = { path, method: opts.method ?? "GET" };
    calls.push(call);
    if (typeof opts.body === "string") sentBodies.set(call, JSON.parse(opts.body));
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, recordingId: 7 }) });
  };
  w.MediaRecorder = function () { /* app.js feature-detects this on load */ };
  w.eval(readFileSync(join(publicDir, "app.js"), "utf8"));
  w.eval(`
    state.meeting = { id: 42, title: 'April Board Meeting', meeting_date: '2026-04-14',
                      location: 'Hall', description: '', status: 'draft', recording_status: 'idle' };
    state.items = [{ id: 1, title: 'Budget', description: '', transcript: '', notes: '',
                     transcript_segments: [], speaker_map: {}, speaker_stats: [], recordings: [],
                     presenter_ids: [], action_items: [], summary: '', transcribe_status: 'idle',
                     transcribe_error: '', transcript_source: '' }];
    state.attendeeIds = []; state.people = []; state.peopleById = {};
    state.meetingRecordings = []; state.meetingSpeakerStats = [];
  `);
  calls.length = 0;
  return { w, doc: w.document, calls };
}

function pressEnter(w: any, el: any): void {
  el.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}
function typeConfirm(w: any, doc: any, text: string): any {
  const el = doc.getElementById("mf-danger-confirm");
  el.value = text;
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
  return el;
}

// The bug this file exists for: Enter in the delete-confirmation box was
// handled by the modal's document-level Enter handler, which ran the SAVE
// action. The meeting was silently patched and the dialog closed, so the
// meeting was still there — "delete meeting does not work".
test("Enter in the confirmation box deletes, it does not save", { skip }, () => {
  const { w, doc, calls } = boot();
  w.eval("editMeeting()");
  pressEnter(w, typeConfirm(w, doc, "DELETE"));
  assert.deepEqual(calls, [{ path: "/api/meetings/42", method: "DELETE" }]);
});

test("Enter in an ordinary field still saves", { skip }, () => {
  const { w, doc, calls } = boot();
  w.eval("editMeeting()");
  pressEnter(w, doc.getElementById("mf-title"));
  assert.deepEqual(calls, [{ path: "/api/meetings/42", method: "PATCH" }]);
});

test("a mistyped confirmation neither deletes nor saves", { skip }, () => {
  const { w, doc, calls } = boot();
  w.eval("editMeeting()");
  pressEnter(w, typeConfirm(w, doc, "delet"));
  assert.deepEqual(calls, []);
  assert.equal(doc.getElementById("modal-danger-btn").disabled, true);
});

test("clicking the delete button after confirming deletes", { skip }, async () => {
  const { w, doc, calls } = boot();
  w.eval("editMeeting()");
  typeConfirm(w, doc, "DELETE");
  const btn = doc.getElementById("modal-danger-btn");
  assert.equal(btn.disabled, false);
  btn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(calls[0], { path: "/api/meetings/42", method: "DELETE" });
});

// The second reason delete "did not work": the gate demanded a character-exact
// retype of the meeting title. Titles that come out of AI agenda extraction
// carry em dashes, curly quotes and doubled spaces, and those meetings could
// not be deleted at all, by anyone, ever.
test("every meeting is deletable regardless of what it is called", { skip }, () => {
  const awkward = [
    "Board Meeting — Special Session",   // em dash
    "Pastor’s Report",              // curly apostrophe
    "Finance  Committee",                // doubled space
    "  Trustees (Q2)  ",                 // stray padding
    "예배 위원회",                        // non-latin
  ];
  for (const title of awkward) {
    const { w, doc, calls } = boot();
    w.eval(`state.meeting.title = ${JSON.stringify(title)}; editMeeting();`);
    typeConfirm(w, doc, "DELETE");
    assert.equal(doc.getElementById("modal-danger-btn").disabled, false, `blocked on: ${title}`);
    doc.getElementById("modal-danger-btn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    assert.deepEqual(calls[0], { path: "/api/meetings/42", method: "DELETE" }, `no DELETE for: ${title}`);
  }
});

test("the confirmation is case-insensitive and tolerates padding", { skip }, () => {
  for (const typed of ["delete", "  Delete  ", "DELETE"]) {
    const { w, doc } = boot();
    w.eval("editMeeting()");
    typeConfirm(w, doc, typed);
    assert.equal(doc.getElementById("modal-danger-btn").disabled, false, `blocked on: ${JSON.stringify(typed)}`);
  }
});

test("the dialog names the meeting being deleted", { skip }, () => {
  const { w, doc } = boot();
  w.eval("editMeeting()");
  assert.match(doc.querySelector(".modal-danger .hint").textContent, /April Board Meeting/);
});

// One microphone: while the whole meeting is being recorded, a topic's own
// Record / Upload audio controls must not be reachable.
test("a whole-meeting recording hides the per-topic recorder and shows the banner", { skip }, () => {
  const { w, doc } = boot();
  w.eval("renderDetail()");
  assert.equal(doc.getElementById("recrow-1").hidden, false);
  assert.equal(doc.getElementById("reclock-1").hidden, true);
  assert.equal(doc.getElementById("rec-banner").hidden, true);

  w.eval(`
    meetingRec = { meetingId: 42, recordingId: 7, title: 'April Board Meeting', topic: '',
                   mr: {}, stream: { getTracks: function(){ return []; } },
                   t0: performance.now(), chain: Promise.resolve(), failedChunk: null, timer: null };
    renderMeetingRecUi();
  `);
  assert.equal(doc.getElementById("recrow-1").hidden, true);
  assert.equal(doc.getElementById("reclock-1").hidden, false);
  assert.equal(doc.getElementById("rec-banner").hidden, false);
  assert.match(doc.getElementById("rec-banner").textContent, /Recording/);
  assert.ok(doc.body.classList.contains("has-rec-banner"));

  // Re-rendering the agenda mid-recording must not bring the controls back.
  w.eval("renderItems()");
  assert.equal(doc.getElementById("recrow-1").hidden, true);

  w.eval("meetingRec = null; renderMeetingRecUi();");
  assert.equal(doc.getElementById("recrow-1").hidden, false);
  assert.equal(doc.getElementById("rec-banner").hidden, true);
  assert.equal(doc.body.classList.contains("has-rec-banner"), false);
});

test("opening a topic while recording names it in the banner", { skip }, () => {
  const { w, doc } = boot();
  w.eval("renderDetail()");
  w.eval(`
    meetingRec = { meetingId: 42, recordingId: 7, title: 'April Board Meeting', topic: '',
                   mr: {}, stream: { getTracks: function(){ return []; } },
                   t0: performance.now(), chain: Promise.resolve(), failedChunk: null, timer: null };
    renderMeetingRecUi();
    postTopicMarker(1);
  `);
  assert.match(doc.getElementById("rec-banner").textContent, /Filing under: Budget/);
});

// The red bar outlived the microphone: finalizeMeetingRecording() cleared the
// recorder and its 1s repaint timer but did not repaint, so the banner stayed
// frozen on "Recording" for the whole upload-and-finish round trip.
test("stopping a meeting recording clears the recording bar immediately", { skip }, async () => {
  const { w, doc } = boot();
  w.eval("renderDetail()");
  w.eval(`
    meetingRec = { meetingId: 42, recordingId: 7, title: 'April Board Meeting', topic: '',
                   mr: { state: 'inactive' }, stream: { getTracks: function(){ return []; } },
                   t0: performance.now(), chain: Promise.resolve(), failedChunk: null,
                   timer: setInterval(function(){}, 1000) };
    renderMeetingRecUi();
  `);
  const banner = doc.getElementById("rec-banner");
  assert.match(banner.textContent, /Recording/);

  w.eval("finalizeMeetingRecording()");
  // Synchronously, before any upload or /finish response has come back.
  assert.equal(w.eval("meetingRec"), null);
  assert.ok(!/Recording ·/.test(banner.textContent), "must not still claim to be recording");
  assert.match(banner.textContent, /Finishing upload/);

  await new Promise((r) => setTimeout(r, 50)); // let the chain settle
  assert.equal(banner.hidden, true, "bar is gone once the server has the recording");
  assert.equal(doc.body.classList.contains("has-rec-banner"), false);
});

// Summaries are written on the server now, so a finished meeting recording
// needs nothing from the page — but the page must keep polling until they land.
test("the page keeps polling while summaries are queued on the server", { skip }, () => {
  const { w } = boot();
  w.eval("state.items[0].summarize_status = 'queued'; state.report = { status: 'idle', changes: [] };");
  assert.equal(w.eval("anyPendingWork()"), true);
  w.eval("state.items[0].summarize_status = 'idle'; state.report = { status: 'pending', changes: [] };");
  assert.equal(w.eval("anyPendingWork()"), true, "a pending report also keeps the poll alive");
  w.eval("state.report = { status: 'idle', changes: [] };");
  assert.equal(w.eval("anyPendingWork()"), false);
});

test("guests are offered as speakers and everyone not present is listed absent", { skip }, () => {
  const { w, doc } = boot();
  w.eval(`
    state.people = [{ id: 9, name: 'Alice', active: true }, { id: 10, name: 'Bob', active: true },
                    { id: 11, name: 'Old', active: false }];
    state.peopleById = { 9: state.people[0], 10: state.people[1], 11: state.people[2] };
    state.attendeeIds = [9];
    state.guests = [{ id: 1, meeting_id: 42, name: 'Gina', title: 'Architect' }];
    state.items[0].transcript_segments = [{ text: 'hello', speaker: 'SPEAKER_00', start: 0, end: 1 }];
    state.items[0].speaker_stats = [{ speaker: 'SPEAKER_00', label: 'Speaker 1', seconds: 1, share: 1, sample: 'hello' }];
    renderDetail();
  `);
  const options = [...doc.querySelectorAll("select[data-spk] option")].map((o: any) => o.value);
  assert.deepEqual(options, ["", "Alice", "Gina"]);
  assert.equal(doc.getElementById("absent-line").textContent, "Absent: Bob");
  assert.match(doc.getElementById("guest-chips").textContent, /Gina/);
});

test("a guest can be made a topic's presenter, listed above the attendees", { skip }, () => {
  const { w, doc, calls } = boot();
  w.eval(`
    state.people = [{ id: 9, name: 'Alice', active: true }];
    state.peopleById = { 9: state.people[0] };
    state.attendeeIds = [9];
    state.guests = [{ id: 5, meeting_id: 42, name: 'Gina', title: 'Architect' }];
    renderDetail();
  `);
  const pres = doc.getElementById("pres-1");
  const groups = [...pres.querySelectorAll(".pres-group-lbl")].map((l: any) => l.textContent);
  assert.deepEqual(groups, ["Guests", "Attendees"]);
  const chip = pres.querySelector('.chip[data-pg="5"]');
  assert.match(chip.textContent, /Gina/);
  chip.click();
  const patch = calls.find((c) => c.path === "/api/items/1" && c.method === "PATCH");
  assert.ok(patch, "the choice is saved");
  assert.deepEqual(sentBodies.get(patch), { guestPresenterIds: [5] });
  assert.ok(doc.getElementById("pres-1").querySelector('.chip[data-pg="5"]').classList.contains("on"));
});

test("a guest is a presenter choice even with no attendees selected", { skip }, () => {
  const { w, doc } = boot();
  w.eval(`
    state.guests = [{ id: 5, meeting_id: 42, name: 'Gina', title: '' }];
    renderDetail();
  `);
  assert.ok(doc.getElementById("pres-1").querySelector('.chip[data-pg="5"]'));
});

test("report style saves the instructions and the example, and blanks clear them", { skip }, () => {
  const { doc, calls } = boot();
  doc.getElementById("s-report-instructions").value = "One section per schedule.";
  doc.getElementById("s-report-example").value = "";
  doc.getElementById("btn-save-style").click();
  const post = calls.find((c) => c.path === "/api/settings" && c.method === "POST");
  assert.ok(post, "the style is saved");
  assert.deepEqual(sentBodies.get(post), { reportInstructions: "One section per schedule.", reportExample: "" });
});

test("an out-of-date report says what changed and offers Docs and PDF", { skip }, () => {
  const { w, doc } = boot();
  w.eval(`
    state.meeting.report = '# April Board Meeting';
    state.report = { status: 'idle', error: '', generatedAt: null, changes: ['Summary changed: Budget'] };
    renderDetail();
  `);
  assert.match(doc.getElementById("report-stale").textContent, /out of date.*Summary changed: Budget/s);
  assert.equal(doc.getElementById("report-actions").style.display, "");
  assert.equal(doc.getElementById("btn-report-gdoc").getAttribute("href"), "/api/meetings/42/google-doc");
  assert.ok(doc.getElementById("btn-report-print"));
  assert.equal(doc.getElementById("btn-report-dl"), null, "the Markdown download is gone");
});

test("changing a speaker assignment rewrites that item's summary", { skip }, async () => {
  const { w, doc, calls } = boot();
  w.eval(`
    state.attendeeIds = [9]; state.people = [{ id: 9, name: 'Alice', active: true }];
    state.peopleById = { 9: { id: 9, name: 'Alice', active: true } };
    state.items[0].transcript = 'Speaker 1: hello';
    state.items[0].summary = 'stale summary';
    state.items[0].transcript_segments = [{ text: 'hello', speaker: 'SPEAKER_00', start: 0, end: 1 }];
    state.items[0].speaker_stats = [{ speaker: 'SPEAKER_00', label: 'Speaker 1', seconds: 1, share: 1, sample: 'hello' }];
    renderDetail();
  `);
  const sel = doc.querySelector('select[data-spk]');
  sel.value = "Alice";
  sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.equal(w.eval("state.items[0].summary"), "", "the stale summary is cleared at once");

  await new Promise((r) => setTimeout(r, 1800)); // past the debounce
  assert.ok(
    calls.some((c) => c.path === "/api/items/1/summarize"),
    `expected a resummarize, saw: ${JSON.stringify(calls.map((c) => c.path))}`
  );
});

test("leaving a meeting cancels a pending resummarize", { skip }, async () => {
  const { w, calls } = boot();
  w.eval("renderDetail(); scheduleSummarize(state.items[0], 40); stopPolling();");
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(!calls.some((c) => /summarize/.test(c.path)), "no summarize after navigating away");
});

// A sleeping screen suspends the page and the MediaRecorder with it, so a
// running recording must hold a Screen Wake Lock, re-take it when the tab
// comes back (browsers drop it on hide), and let it go when recording stops.
test("recording holds a screen wake lock and releases it on stop", { skip }, async () => {
  const { w, doc } = boot();
  const requests: string[] = [];
  let released = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = null;
  Object.defineProperty(w.navigator, "wakeLock", {
    configurable: true,
    value: {
      request(type: string) {
        requests.push(type);
        const listeners: Array<() => void> = [];
        const lock = {
          addEventListener(_: string, fn: () => void) { listeners.push(fn); },
          release() { released++; listeners.forEach((fn) => fn()); return Promise.resolve(); },
          drop() { listeners.forEach((fn) => fn()); },
        };
        current = lock;
        return Promise.resolve(lock);
      },
    },
  });
  let visibility = "visible";
  Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => visibility });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  w.eval("renderDetail()");
  w.eval(`
    meetingRec = { meetingId: 42, recordingId: 7, title: 'April Board Meeting', topic: '',
                   mr: { state: 'inactive' }, stream: { getTracks: function(){ return []; } },
                   t0: performance.now(), chain: Promise.resolve(), failedChunk: null, timer: null };
    syncWakeLock(); syncWakeLock();
  `);
  await tick();
  assert.deepEqual(requests, ["screen"], "one lock, not one per call");

  // Tab hidden: the browser drops the lock. Coming back must re-take it.
  visibility = "hidden"; current.drop();
  doc.dispatchEvent(new w.Event("visibilitychange"));
  await tick();
  assert.equal(requests.length, 1, "no request while hidden");
  visibility = "visible";
  doc.dispatchEvent(new w.Event("visibilitychange"));
  await tick();
  assert.equal(requests.length, 2);

  w.eval("finalizeMeetingRecording()");
  await tick();
  assert.equal(released, 1, "stopping releases the lock");
  doc.dispatchEvent(new w.Event("visibilitychange"));
  await tick();
  assert.equal(requests.length, 2, "no lock once recording has stopped");
});

// A processed meeting had no way back in: Retry only appears on error, so a
// finished-but-wrong result (e.g. bad speakers) could never be reprocessed.
test("a processed meeting recording can be reprocessed after confirming", { skip }, async () => {
  const { w, doc, calls } = boot();
  w.eval(`
    state.meeting.recording_status = 'done';
    state.meetingRecordings = [{ id: 7 }];
    renderDetail(); renderMeetingRecUi();
  `);
  const btn = doc.getElementById("btn-mrec-reprocess");
  assert.ok(btn, "reprocess button is shown once processed");

  w.confirm = () => false;
  btn.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.filter((c) => c.path.includes("/reprocess")).length, 0, "cancel does nothing");

  w.confirm = () => true;
  btn.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.filter((c) => c.path.includes("/reprocess")), [{ path: "/api/meeting-recordings/7/reprocess", method: "POST" }]);
  assert.equal(w.eval("state.meeting.recording_status"), "queued");
});

// One short quote was not enough to tell voices apart: each speaker row now
// offers several longer samples, each playable from the meeting recording.
test("meeting speaker rows offer playable samples", { skip }, () => {
  const { w, doc } = boot();
  w.eval(`
    state.meeting.recording_status = 'done';
    state.meetingRecordings = [{ id: 7 }];
    state.meetingSpeakerStats = [{ speaker: 'SPEAKER_00', label: 'Speaker 1', seconds: 30, share: 1,
      sample: 'Good evening', samples: [
        { text: 'Good evening everyone, let us begin.', start: 3, end: 9 },
        { text: 'The <b>finance</b> committee met twice.', start: 3700, end: 3712 },
      ] }];
    renderDetail(); renderMeetingSpeakerPanel();
  `);
  const more = doc.querySelector("#meeting-speakers .spk-more");
  assert.ok(more, "samples are offered");
  assert.match(more.querySelector("summary").textContent, /2 samples of Speaker 1/);
  const items = more.querySelectorAll("li");
  assert.equal(items.length, 2);
  assert.match(items[1].textContent, /61:40 The <b>finance<\/b> committee/); // escaped, not HTML
  const play = items[0].querySelector(".spk-play");
  assert.equal(play.getAttribute("data-rec"), "7");
  assert.equal(play.getAttribute("data-start"), "3");
});
