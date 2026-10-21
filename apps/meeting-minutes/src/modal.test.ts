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

// ── Report view: playing sections, regenerating edited minutes ─────────────

test("report lines with a time range get a play button; plain lines don't", { skip }, () => {
  const { w } = boot();
  const html: string = w.eval(`renderMarkdown(${JSON.stringify(
    "### 1. Budget <!--t:m12:600.0-1200.0-->\n### 2. Roof\n- [ ] Send — **Bob** <!--t:i4:5.0-9.0-->"
  )})`);
  assert.equal((html.match(/class="sec-play"/g) || []).length, 2);
  assert.match(html, /data-src="m" data-rec="12" data-start="600.0" data-end="1200.0"/);
  assert.match(html, /data-src="i" data-rec="4" data-start="5.0" data-end="9.0"/);
  assert.match(html, /<span class="sec-time">10:00–20:00<\/span>/);
  assert.doesNotMatch(html, /<!--t:/);
  assert.match(html, /<h3>2\. Roof<\/h3>/);
});

test("a report without ranges renders as before", { skip }, () => {
  const { w } = boot();
  const html: string = w.eval(`renderMarkdown("### 1. Budget\\n- [ ] Send — **Bob**")`);
  assert.equal(html, '<h3>1. Budget</h3><ul><li class="todo">&#9744; Send — <strong>Bob</strong></li></ul>');
});

test("pressing play on a section loads that stretch of the right recording", { skip }, () => {
  const { w, doc } = boot();
  const played: string[] = [];
  w.Audio = function () { return { src: "", play() { played.push(this.src); return Promise.resolve(); }, pause() {}, addEventListener() {}, removeAttribute() {}, load() {} }; };
  const box = doc.createElement("div");
  box.innerHTML = w.eval(`renderMarkdown("### 1. Budget <!--t:m12:600.0-1200.0-->\\n- [ ] Send <!--t:i4:5.0-9.0-->")`);
  doc.body.appendChild(box);
  const btns = box.querySelectorAll(".sec-play");
  btns[0].dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  btns[1].dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(played, [
    "/api/meeting-recordings/12/section?start=600.00&end=1200.00",
    "/api/recordings/4/section?start=5.00&end=9.00",
  ]);
});

function bootWithReport(answers: any[]) {
  const b = boot();
  const sent: any[] = [];
  b.w.fetch = (path: string, opts: { method?: string; body?: string } = {}) => {
    if (path.endsWith("/report") && opts.method === "POST") {
      sent.push(opts.body ? JSON.parse(opts.body) : {});
      const a = answers.shift() ?? { ok: true, report: { status: "pending", changes: [] } };
      return Promise.resolve({ ok: !a.status, status: a.status ?? 200, json: () => Promise.resolve(a.body ?? a) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  };
  b.w.eval(`state.meeting.report = "# Minutes"; state.meeting.report_generated_at = "2026-04-14T10:00:00Z"; renderDetail();`);
  return { ...b, sent };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test("regenerating edited minutes asks first and sends replaceEdits", { skip }, async () => {
  const edited = { status: 409, body: { ok: false, edited: true, error: "Regenerating replaces the edits you've made to these minutes." } };
  const { w, doc, sent } = bootWithReport([edited]);
  let asked = "";
  w.confirm = (q: string) => { asked = q; return true; };
  doc.getElementById("btn-report").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await flush();
  assert.match(asked, /replaces the edits/);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].replaceEdits, true);
});

test("declining keeps the edited minutes", { skip }, async () => {
  const edited = { status: 409, body: { ok: false, edited: true, error: "Regenerating replaces the edits you've made to these minutes." } };
  const { w, doc, sent } = bootWithReport([edited]);
  w.confirm = () => false;
  doc.getElementById("btn-report").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(doc.getElementById("btn-report").disabled, false);
});

test("the report shows its approximate length", { skip }, () => {
  const { w, doc } = bootWithReport([]);
  w.eval(`state.report = { status: "idle", error: "", changes: [], pages: 5.5 }; renderReportState();`);
  assert.match(doc.getElementById("report-pages").textContent, /≈ 5\.5 pages/);
});

function fakeAudio(w: any) {
  const players: any[] = [];
  w.Audio = function () {
    const handlers: Record<string, Array<() => void>> = {};
    const a = { src: "", paused: true,
      play() { a.paused = false; return Promise.resolve(); }, pause() { a.paused = true; },
      removeAttribute(k: string) { if (k === "src") a.src = ""; }, load() {},
      addEventListener(ev: string, fn: () => void) { (handlers[ev] = handlers[ev] || []).push(fn); },
      fire(ev: string) { (handlers[ev] || []).forEach((fn) => fn()); } };
    players.push(a);
    return a;
  };
  return players;
}

test("a section shows it is loading until audio plays", { skip }, () => {
  const { w, doc } = boot();
  const players = fakeAudio(w);
  const box = doc.createElement("div");
  box.innerHTML = w.eval(`renderMarkdown("### 1. Budget <!--t:m12:600.0-1200.0-->")`);
  doc.body.appendChild(box);
  const btn = box.querySelector(".sec-play");
  btn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.ok(btn.classList.contains("loading"));
  players[0].fire("playing");
  assert.ok(!btn.classList.contains("loading"));
  assert.equal(btn.innerHTML, "■");
});

test("a section that can't play says why", { skip }, async () => {
  const { w, doc } = boot();
  const players = fakeAudio(w);
  w.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false, error: "Recording file is missing." }) });
  w.eval("renderDetail()");
  doc.getElementById("report-box").innerHTML = w.eval(`renderMarkdown("### 1. Budget <!--t:m12:600.0-1200.0-->")`);
  const btn = doc.querySelector("#report-box .sec-play");
  btn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  players[0].fire("error");
  await new Promise((r) => setTimeout(r, 20));
  assert.match(doc.getElementById("report-msg").textContent, /Recording file is missing/);
  assert.equal(btn.innerHTML, "▶");
  assert.ok(!btn.classList.contains("loading"));
});

test("a section longer than one part plays on into the next part", { skip }, () => {
  const { w, doc } = boot();
  const players = fakeAudio(w);
  const box = doc.createElement("div");
  // 0:00–1:10:00, longer than the 30-minute parts the server cuts.
  box.innerHTML = w.eval(`renderMarkdown("### 1. Finance <!--t:m12:0.0-4200.0-->")`);
  doc.body.appendChild(box);
  box.querySelector(".sec-play").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.equal(players[0].src, "/api/meeting-recordings/12/section?start=0.00&end=1800.00");
  players[0].fire("ended");
  assert.equal(players[0].src, "/api/meeting-recordings/12/section?start=1800.00&end=3600.00");
  players[0].fire("ended");
  assert.equal(players[0].src, "/api/meeting-recordings/12/section?start=3600.00&end=4200.00");
  players[0].fire("ended");
  assert.equal(box.querySelector(".sec-play").innerHTML, "▶");
});

test("a report stuck generating offers Cancel", { skip }, async () => {
  const { w, doc, sent } = bootWithReport([]);
  const calls: string[] = [];
  const orig = w.fetch;
  w.fetch = (path: string, opts: any = {}) => {
    calls.push(`${opts.method ?? "GET"} ${path}`);
    if (path.endsWith("/report/cancel")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, report: { status: "idle", error: "", changes: [] } }) });
    }
    return orig(path, opts);
  };
  w.eval(`state.report = { status: "pending", error: "", changes: [] }; renderReportState();`);
  const cancel = doc.getElementById("btn-report-cancel");
  assert.ok(cancel && !cancel.hidden, "Cancel shown while generating");
  cancel.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await flush();
  assert.ok(calls.includes("POST /api/meetings/42/report/cancel"));
  assert.equal(doc.getElementById("btn-report-cancel").hidden, true);
  assert.equal(sent.length, 0);
});

// ── Fix a name or word ──────────────────────────────────────────────────────

function bootFix(answers: Record<string, any>) {
  const b = boot();
  const posts: Array<{ path: string; body: any }> = [];
  b.w.fetch = (path: string, opts: { method?: string; body?: string } = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (opts.method === "POST") posts.push({ path, body });
    const key = Object.keys(answers).find((k) => path.endsWith(k) && (k !== "/fix" || !!body?.dryRun === answers[k].dry));
    const a = key ? answers[key] : { ok: true };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(a) });
  };
  b.w.eval("renderDetail()");
  return { ...b, posts };
}

const counts = { transcripts: 3, summaries: 1, actionItems: 0, report: 2, speakers: 0, guests: 0 };

test("checking a fix shows how many places would change", { skip }, async () => {
  const { w, doc, posts } = bootFix({ "/fix": { ok: true, dry: true, counts, total: 6, changeId: null, libraryMatches: [] } });
  doc.getElementById("fix-from").value = "John";
  doc.getElementById("fix-to").value = "Jon";
  doc.getElementById("btn-fix-preview").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await flush();
  assert.deepEqual(posts[0], { path: "/api/meetings/42/fix", body: { from: "John", to: "Jon", dryRun: true } });
  assert.match(doc.getElementById("fix-result").textContent, /Will change 6 places: 3 in transcripts, 1 in summaries, 2 in the report/);
});

test("applying a fix offers Undo, and Undo sends the change back", { skip }, async () => {
  const { w, doc, posts } = bootFix({
    "/fix": { ok: true, dry: false, counts, total: 6, changeId: 9, libraryMatches: [{ id: 3, name: "John Hale" }] },
  });
  doc.getElementById("fix-from").value = "John";
  doc.getElementById("fix-to").value = "Jon";
  doc.getElementById("btn-fix-apply").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await flush();
  assert.match(doc.getElementById("fix-result").textContent, /Changed 6 places/);
  assert.match(doc.getElementById("fix-result").textContent, /People list still spells this “John Hale”/);
  doc.querySelector(".fix-undo").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await flush();
  assert.equal(posts[1].path, "/api/meetings/42/changes/9/undo");
});

test("a fix can be limited to one topic", { skip }, async () => {
  const { w, doc, posts } = bootFix({ "/fix": { ok: true, dry: true, counts, total: 6, changeId: null, libraryMatches: [] } });
  doc.getElementById("fix-from").value = "John";
  doc.getElementById("fix-to").value = "Jon";
  doc.getElementById("fix-scope").value = "1";
  doc.getElementById("btn-fix-preview").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await flush();
  assert.equal(posts[0].body.itemId, 1);
});

test("a transcript from the recording is read-only and never saved on blur", { skip }, () => {
  const { w, doc, calls } = boot();
  w.eval(`state.items[0].transcript = "Speaker 1: hi"; state.items[0].transcript_segments = [{ text: "hi", speaker: "S0", start: 0, end: 1 }]; renderDetail();`);
  const tx = doc.getElementById("tx-1");
  assert.equal(tx.readOnly, true);
  tx.value = "edited";
  tx.dispatchEvent(new w.Event("blur"));
  assert.ok(!calls.some((c: any) => c.method === "PATCH"));
});

test("a fix doesn't stop a recording in progress", { skip }, async () => {
  const { w, doc } = bootFix({ "/fix": { ok: true, dry: false, counts, total: 6, changeId: 9, libraryMatches: [] } });
  let stopped = false;
  w.eval("var __stop = stopRecording;");
  w.stopRecording = () => { stopped = true; };
  doc.getElementById("fix-from").value = "John";
  doc.getElementById("fix-to").value = "Jon";
  doc.getElementById("btn-fix-apply").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await flush();
  assert.equal(stopped, false);
});

test("after the report, renaming a topic's voice doesn't ask for a new summary", { skip }, async () => {
  const { w, doc, calls } = boot();
  w.eval(`state.meeting.report = "# M"; state.meeting.report_generated_at = "2026-04-14T10:00:00Z";
    state.items[0].transcript_segments = [{ text: "hi", speaker: "S0", start: 0, end: 1 }];
    state.items[0].transcript = "Speaker 1: hi"; state.items[0].summary = "Speaker 1 said hi.";
    state.items[0].speaker_stats = [{ speaker: "S0", seconds: 1, samples: [] }];
    state.attendeeIds = []; state.guests = [{ id: 5, name: "Linda", title: "" }]; renderDetail();`);
  const sel = doc.querySelector('[data-spk="S0"]');
  assert.ok(sel, "speaker dropdown rendered");
  sel.value = "Linda";
  sel.dispatchEvent(new w.Event("change"));
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(w.eval("state.items[0].summary"), "Speaker 1 said hi.");
  assert.ok(!calls.some((c: any) => c.path.endsWith("/summarize")), "no new summary requested");
});

// ── Edit lock ───────────────────────────────────────────────────────────────

test("someone else's meeting is read-only, with their name, and play still works", { skip }, () => {
  const { w, doc } = boot();
  w.eval(`state.meeting.report = "### 1. Budget <!--t:m12:600.0-1200.0-->"; state.meeting.report_generated_at = "2026-04-14T10:00:00Z";
    state.lock = { held: false, holder: { email: "ann@x", name: "Ann" } }; renderDetail();`);
  const banner = doc.getElementById("lock-banner");
  assert.ok(banner, "banner shown");
  assert.match(banner.textContent, /Being edited by Ann/);
  assert.equal(doc.getElementById("fix-from").readOnly, true, "text stays selectable for copying");
  assert.equal(doc.getElementById("btn-report").disabled, true);
  assert.equal(doc.querySelector("#report-box .sec-play").disabled, false);
  assert.equal(doc.getElementById("btn-report-print").disabled, false);
});

test("your own meeting is editable", { skip }, () => {
  const { w, doc } = boot();
  w.eval(`state.lock = { held: true, holder: { email: "me@x", name: "Me" } }; renderDetail();`);
  assert.equal(doc.getElementById("lock-banner"), null);
  assert.equal(doc.getElementById("fix-from").disabled, false);
});

test("a write refused because someone else took the meeting turns the page read-only", { skip }, async () => {
  const { w, doc } = boot();
  w.eval("renderDetail()");
  w.fetch = () => Promise.resolve({ ok: false, status: 423,
    json: () => Promise.resolve({ ok: false, locked: true, holder: "Bob", error: "Bob is editing this meeting." }) });
  await w.eval("saveItemField(state.items[0], { notes: 'x' })");
  await flush();
  assert.match(doc.getElementById("lock-banner").textContent, /Being edited by Bob/);
  assert.equal(doc.getElementById("fix-from").readOnly, true);
});

test("leaving a meeting lets go of its lock", { skip }, async () => {
  const { w, calls } = boot();
  w.eval("state.lock = { held: true, holder: { email: '', name: '' } }; lockMeetingId = 42; showList()");
  await flush();
  assert.ok(calls.some((c: any) => c.method === "DELETE" && c.path === "/api/meetings/42/lock"));
});

// ── Edit lock: losing it never loses work ───────────────────────────────────

function stubFetch(w: any, route: (path: string, opts: any) => any) {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  w.fetch = (path: string, opts: any = {}) => {
    const body = typeof opts.body === "string" ? JSON.parse(opts.body) : undefined;
    calls.push({ path, method: opts.method ?? "GET", body });
    const a = route(path, opts) ?? { ok: true };
    return Promise.resolve({ ok: a.ok !== false, status: a.status ?? 200, json: () => Promise.resolve(a) });
  };
  return calls;
}

test("losing the lock keeps what you were typing on screen", { skip }, async () => {
  const { w, doc } = boot();
  w.eval("state.lock = { held: true, holder: { email: 'me@x', name: 'Me' } }; renderDetail();");
  doc.getElementById("nt-1").value = "Half-typed notes about the roof";
  stubFetch(w, (p) => p.endsWith("/lock") ? { ok: true, held: false, holder: { email: "b@x", name: "Bob" } } : { ok: true });
  w.eval("lockHeartbeat()");
  await flush();
  assert.match(doc.getElementById("lock-banner").textContent, /Being edited by Bob/);
  assert.equal(doc.getElementById("nt-1").value, "Half-typed notes about the roof");
  assert.match(doc.getElementById("lock-banner").textContent, /copy anything you haven’t saved/);
});

test("the heartbeat says when you've been typing or are recording", { skip }, async () => {
  const { w, doc } = boot();
  w.eval("state.lock = { held: true, holder: { email: 'me@x', name: 'Me' } }; renderDetail();");
  const calls = stubFetch(w, (p) => p.endsWith("/lock") ? { ok: true, held: true, holder: {} } : { ok: true });
  w.eval("lockHeartbeat()");
  await flush();
  doc.getElementById("nt-1").dispatchEvent(new w.Event("input", { bubbles: true }));
  w.eval("lockHeartbeat()");
  await flush();
  const beats = calls.filter((c) => c.path.endsWith("/lock")).map((c) => c.body);
  assert.deepEqual(beats, [{ active: false, recording: false }, { active: true, recording: false }]);
});

test("read-only chips can't be toggled", { skip }, async () => {
  const { w, doc } = boot();
  w.eval(`state.people = [{ id: 7, name: "Ann", active: true }]; state.peopleById = { 7: state.people[0] };
    state.lock = { held: false, holder: { name: "Bob" } }; renderDetail();`);
  const calls = stubFetch(w, () => ({ ok: true }));
  const chip = doc.querySelector("#attendee-chips .chip");
  assert.ok(chip, "an attendee chip");
  chip.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await flush();
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
  assert.deepEqual(Array.from(w.eval("state.attendeeIds")), []);
});

test("a refused upload also turns the page read-only", { skip }, async () => {
  const { w, doc } = boot();
  w.eval("renderDetail()");
  stubFetch(w, () => ({ ok: false, status: 423, locked: true, holder: "Bob", error: "Bob is editing this meeting." }));
  await w.eval("apiForm('/api/meetings/42/agenda', new FormData())");
  await flush();
  assert.match(doc.getElementById("lock-banner").textContent, /Bob/);
});

test("a viewer opening and closing topics asks for no summaries", { skip }, async () => {
  const { w } = boot();
  w.eval(`state.items[0].notes = "some notes"; state.lock = { held: false, holder: { name: "Bob" } }; renderDetail();`);
  const calls = stubFetch(w, () => ({ ok: true }));
  await w.eval("summarizeIfNeeded(state.items[0])");
  assert.equal(calls.length, 0);
});

test("going back to the list mid-recording keeps the recorder's lock", { skip }, () => {
  const { w } = boot();
  const calls = stubFetch(w, () => ({ ok: true }));
  w.eval(`state.lock = { held: true, holder: {} }; lockMeetingId = 42;
    meetingRec = { meetingId: 42, recordingId: 7, title: "x", mr: { state: "recording", stop(){}, requestData(){} }, stream: { getTracks(){ return []; } }, t0: 0 };
    stopRecording = function(){};
    showList();`);
  assert.ok(!calls.some((c) => c.method === "DELETE"), "lock kept while recording");
});

// ── Meeting page in sections ────────────────────────────────────────────────

const visible = (doc: any) => Array.from(doc.querySelectorAll("#detail-body section[data-sec]"))
  .filter((el: any) => !el.hidden).map((el: any) => el.getAttribute("data-sec"));

function bootTwoTopics() {
  const b = boot();
  b.w.eval(`state.items.push({ id: 2, title: 'Roof', description: '', transcript: '', notes: '', transcript_segments: [],
    speaker_map: {}, speaker_stats: [], recordings: [], presenter_ids: [], action_items: [], summary: '',
    transcribe_status: 'idle', transcribe_error: '', transcript_source: '' });`);
  return b;
}

test("the meeting opens on the section that fits where it is", { skip }, () => {
  const { w, doc } = boot();
  w.eval("state.section = null; renderDetail()");
  assert.deepEqual(visible(doc), ["agenda"]);
  w.eval("state.section = null; state.items = []; renderDetail()");
  assert.deepEqual(visible(doc), ["details"]);
  w.eval("state.section = null; state.meeting.report = '# M'; renderDetail()");
  assert.deepEqual(visible(doc), ["minutes"]);
});

test("the side menu switches sections, and a redraw keeps the one you're on", { skip }, () => {
  const { w, doc } = boot();
  w.eval("state.section = null; renderDetail()");
  doc.querySelector('#mtg-nav [data-sec="people"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(visible(doc), ["people"]);
  assert.ok(doc.querySelector('#mtg-nav [data-sec="people"]').classList.contains("active"));
  w.eval("renderDetail()");
  assert.deepEqual(visible(doc), ["people"]);
  const sel = doc.getElementById("mtg-nav-select");
  sel.value = "speakers";
  sel.dispatchEvent(new w.Event("change"));
  assert.deepEqual(visible(doc), ["speakers"]);
});

test("a topic in the menu shows just that topic, opened", { skip }, () => {
  const { w, doc } = bootTwoTopics();
  w.eval("state.section = null; renderDetail()");
  doc.querySelector('#mtg-nav [data-topic="2"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(visible(doc), ["agenda"]);
  assert.equal(doc.getElementById("item-1").hidden, true);
  assert.equal(doc.getElementById("item-2").hidden, false);
  assert.ok(!doc.getElementById("ibody-2").classList.contains("collapsed"));
  doc.querySelector('#mtg-nav [data-sec="agenda"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.equal(doc.getElementById("item-1").hidden, false);
});

test("switching sections never stops a recording", { skip }, () => {
  const { w, doc } = boot();
  w.eval("state.section = null; renderDetail(); var __stopped = false; stopRecording = function(){ __stopped = true; };");
  for (const sec of ["people", "minutes", "recording", "agenda"]) {
    doc.querySelector(`#mtg-nav [data-sec="${sec}"]`).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  }
  assert.equal(w.eval("__stopped"), false);
});

test("the recording bar's Next topic opens the following topic", { skip }, () => {
  const { w, doc } = bootTwoTopics();
  const calls = stubFetch(w, () => ({ ok: true }));
  w.eval(`renderDetail();
    meetingRec = { meetingId: 42, recordingId: 7, title: "M", topic: "Budget", topicId: 1, t0: performance.now(),
      mr: { state: "recording" }, stream: { getTracks(){ return []; } } };
    renderRecBanner();`);
  const next = doc.getElementById("rb-next");
  assert.ok(next, "Next topic shown");
  next.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.ok(!doc.getElementById("ibody-2").classList.contains("collapsed"));
  assert.ok(calls.some((c) => c.path === "/api/meeting-recordings/7/marker" && c.body.itemId === 2));
  assert.equal(doc.getElementById("rb-next"), null, "no Next on the last topic");
});

test("the menu shows how things stand", { skip }, () => {
  const { w, doc } = boot();
  w.eval(`state.attendeeIds = [1, 2]; state.guests = [{ id: 9, name: "Gina", title: "" }];
    state.meetingSpeakerStats = [{ speaker: "S0" }, { speaker: "S1" }]; state.meeting.speaker_map = { S0: "Ann" };
    state.meeting.report = "# M"; state.report = { status: "idle", error: "", changes: ["Attendance changed"] };
    state.items[0].transcribe_status = "processing"; renderDetail();`);
  const hint = (sel: string) => doc.querySelector(`#mtg-nav ${sel} .nav-hint`)?.textContent;
  assert.equal(hint('[data-sec="people"]'), "3");
  assert.equal(hint('[data-sec="speakers"]'), "1 unnamed");
  assert.equal(hint('[data-sec="minutes"]'), "out of date");
  assert.equal(hint('[data-topic="1"]'), "transcribing…");
  w.eval(`state.report.status = "pending"; renderReportState();`);
  assert.equal(hint('[data-sec="minutes"]'), "generating…");
});

// ── The Minutes editor ──────────────────────────────────────────────────────

const REPORT = "# Board\n\n## Summary\nThe board met.\n\n### 1. Budget <!--t:m12:600.0-1200.0-->\n- **Income:** $5\n- [ ] Send — **Bob** (Budget) <!--t:m12:700.0-720.0-->";

test("report lines split off their markers and join back the same", { skip }, () => {
  const { w } = boot();
  const lines = w.eval(`reportLines(${JSON.stringify(REPORT)})`);
  assert.equal(lines.length, 6);
  assert.deepEqual({ ...lines[3] }, { text: "### 1. Budget", marker: "<!--t:m12:600.0-1200.0-->" });
  assert.equal(w.eval(`joinReportLines(reportLines(${JSON.stringify(REPORT)}))`), REPORT);
});

test("replacing a line keeps its marker, removes it when emptied, and splits a paste", { skip }, () => {
  const { w } = boot();
  const md = (expr: string) => w.eval(`joinReportLines(${expr})`);
  const L = `reportLines(${JSON.stringify(REPORT)})`;
  assert.match(md(`replaceLine(${L}, 3, "### 1. Budget and Finance")`), /### 1\. Budget and Finance <!--t:m12:600\.0-1200\.0-->/);
  assert.doesNotMatch(md(`replaceLine(${L}, 2, "   ")`), /The board met/);
  const split = md(`replaceLine(${L}, 2, "First line.\\n\\nSecond line.")`);
  assert.match(split, /## Summary\nFirst line\.\nSecond line\.\n/);
  assert.equal(w.eval(`estimatePagesJS("word ".repeat(800))`), 2);
});

function bootMinutes(answer: (path: string, opts: any) => any = () => ({ ok: true, report: { status: "idle", changes: [], pages: 1 } })) {
  const b = boot();
  const calls = stubFetch(b.w, answer);
  b.w.eval(`state.meeting.report = ${JSON.stringify(REPORT)}; state.meeting.report_generated_at = "2026-04-14T10:00:00Z";
    state.report = { status: "idle", error: "", changes: [], pages: 1 }; state.section = "minutes"; renderDetail();`);
  return { ...b, calls };
}

test("clicking a line edits it without showing marker text, and saving keeps the marker", { skip }, async () => {
  const { w, doc, calls } = bootMinutes();
  const block = doc.querySelector('#report-editor .rblock[data-line="3"]');
  block.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const ta = doc.querySelector("#report-editor textarea.rblock-edit");
  assert.ok(ta, "textarea opened");
  assert.equal(ta.value, "### 1. Budget");
  ta.value = "### 1. Budget and Finance";
  ta.dispatchEvent(new w.Event("blur"));
  assert.match(doc.getElementById("report-save").textContent, /Saving/);
  await new Promise((r) => setTimeout(r, 950));
  const puts = calls.filter((c) => c.method === "PUT" && c.path === "/api/meetings/42/report");
  assert.equal(puts.length, 1);
  assert.match(puts[0].body.markdown, /### 1\. Budget and Finance <!--t:m12:600\.0-1200\.0-->/);
  assert.match(doc.getElementById("report-save").textContent, /Saved/);
  assert.ok(doc.querySelector('#report-editor .rblock[data-line="3"] .sec-play'), "▶ still there");
});

test("a save the server refuses shows why and keeps the edit", { skip }, async () => {
  const { w, doc } = bootMinutes((p, o) => o.method === "PUT"
    ? { ok: false, status: 409, error: "The report is being written. Try again when it finishes, or cancel it." } : { ok: true });
  doc.querySelector('#report-editor .rblock[data-line="2"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const ta = doc.querySelector("#report-editor textarea.rblock-edit");
  ta.value = "The board met at length.";
  ta.dispatchEvent(new w.Event("blur"));
  await new Promise((r) => setTimeout(r, 950));
  assert.match(doc.getElementById("report-save").textContent, /being written/);
  assert.match(doc.getElementById("report-editor").textContent, /The board met at length\./);
});

test("Escape cancels an edit", { skip }, () => {
  const { w, doc, calls } = bootMinutes();
  doc.querySelector('#report-editor .rblock[data-line="2"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const ta = doc.querySelector("#report-editor textarea.rblock-edit");
  ta.value = "nope";
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.match(doc.getElementById("report-editor").textContent, /The board met\./);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});

test("while the report is being written, or someone else edits, lines don't open", { skip }, () => {
  const { w, doc } = bootMinutes();
  w.eval(`state.report.status = "pending"; renderReportState();`);
  doc.querySelector('#report-editor .rblock[data-line="2"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.equal(doc.querySelector("#report-editor textarea"), null);
  w.eval(`state.report.status = "idle"; state.lock = { held: false, holder: { name: "Bob" } }; renderDetail();`);
  doc.querySelector('#report-editor .rblock[data-line="2"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.equal(doc.querySelector("#report-editor textarea"), null);
});

test("no report yet: no editor", { skip }, () => {
  const { w, doc } = boot();
  w.eval(`state.meeting.report = ""; state.section = "minutes"; renderDetail();`);
  assert.equal(doc.getElementById("report-editor"), null);
});

// ── Minutes edits are never silently lost ──────────────────────────────────

function editLine(w: any, doc: any, line: number, text: string) {
  doc.querySelector(`#report-editor .rblock[data-line="${line}"]`).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const ta = doc.querySelector("#report-editor textarea.rblock-edit");
  ta.value = text;
  ta.dispatchEvent(new w.Event("blur"));
}

test("a refresh while an edit is unsaved keeps the edit and saves it", { skip }, async () => {
  const { w, doc, calls } = bootMinutes((p, o) => {
    if (o.method === "PUT") return { ok: true, report: { status: "idle", changes: [], pages: 1 } };
    if (p === "/api/meetings/42") return { ok: true, meeting: { id: 42, title: "M", report: "# Server copy", report_generated_at: "2026-04-14T10:00:00Z" },
      attendeeIds: [], items: [], guests: [], report: { status: "idle", changes: [] } };
    return { ok: true };
  });
  editLine(w, doc, 2, "The board met at length.");
  w.eval("refreshMeeting(42)");
  await flush();
  assert.match(w.eval("state.meeting.report"), /The board met at length\./);
  await new Promise((r) => setTimeout(r, 950));
  const put = calls.filter((c) => c.method === "PUT").pop();
  assert.match(put!.body.markdown, /The board met at length\./);
});

test("a save that can't reach the server says so, and Back tries again", { skip }, async () => {
  const b = bootMinutes();
  let fail = true;
  const puts: any[] = [];
  b.w.fetch = (path: string, opts: any = {}) => {
    if (opts.method === "PUT") { puts.push(JSON.parse(opts.body)); if (fail) return Promise.reject(new TypeError("Failed to fetch")); }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, report: { status: "idle", changes: [] } }) });
  };
  b.w.confirm = () => false;
  editLine(b.w, b.doc, 2, "Edited offline.");
  await new Promise((r) => setTimeout(r, 950));
  assert.match(b.doc.getElementById("report-save").textContent, /Couldn’t save/);
  fail = false;
  b.w.eval("showList()");
  await flush();
  assert.equal(puts.length, 2, "retried on the way out");
  assert.match(puts[1].markdown, /Edited offline\./);
});

test("Open in Google Docs right after an edit saves the edit first", { skip }, async () => {
  const { w, doc, calls } = bootMinutes();
  const opened: any = { location: "" };
  w.open = () => opened;
  editLine(w, doc, 2, "Last fix.");
  doc.getElementById("btn-report-gdoc").dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  await flush();
  assert.ok(calls.some((c) => c.method === "PUT"), "saved before export");
  assert.equal(opened.location, "/api/meetings/42/google-doc");
});

test("regenerating right after an edit saves it first, so the warning knows", { skip }, async () => {
  const { w, doc, calls } = bootMinutes();
  editLine(w, doc, 2, "Edited.");
  doc.getElementById("btn-report").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await flush();
  const order = calls.filter((c) => c.path.endsWith("/report")).map((c) => c.method);
  assert.deepEqual(order.slice(0, 2), ["PUT", "POST"]);
});

test("losing the lock with a line open keeps what was typed", { skip }, async () => {
  const { w, doc } = bootMinutes();
  doc.querySelector('#report-editor .rblock[data-line="2"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  doc.querySelector("#report-editor textarea.rblock-edit").value = "Half a sentence";
  w.eval("lockedBy({ name: 'Bob' })");
  await flush();
  assert.match(doc.getElementById("detail-body").innerHTML + w.eval("state.meeting.report"), /Half a sentence/);
});

test("a read-only phone viewer can still switch sections", { skip }, () => {
  const { w, doc } = boot();
  w.eval(`state.lock = { held: false, holder: { name: "Bob" } }; renderDetail();`);
  assert.equal(doc.getElementById("mtg-nav-select").disabled, false);
});

test("clicking another line while one is open opens it straight away", { skip }, () => {
  const { w, doc } = bootMinutes();
  doc.querySelector('#report-editor .rblock[data-line="2"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const ta = doc.querySelector("#report-editor textarea.rblock-edit");
  ta.value = "Changed.";
  const other = doc.querySelector('#report-editor .rblock[data-line="4"]');
  other.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));
  ta.dispatchEvent(new w.Event("blur"));
  const open = doc.querySelector("#report-editor textarea.rblock-edit");
  assert.ok(open, "the second line opened");
  assert.equal(open.value, "- **Income:** $5");
});

test("a line can be opened from the keyboard", { skip }, () => {
  const { w, doc } = bootMinutes();
  const block = doc.querySelector('#report-editor .rblock[data-line="2"]');
  assert.equal(block.getAttribute("tabindex"), "0");
  block.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.ok(doc.querySelector("#report-editor textarea.rblock-edit"));
});
