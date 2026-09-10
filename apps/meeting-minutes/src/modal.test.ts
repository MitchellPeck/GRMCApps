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
  w.fetch = (path: string, opts: { method?: string } = {}) => {
    calls.push({ path, method: opts.method ?? "GET" });
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

// A whole-meeting recording writes transcripts straight onto every topic it
// covered, so those topics never pass through queued/processing and the poller
// never treated them as "settled" — nothing was ever summarized.
test("a finished meeting recording summarizes every topic", { skip }, async () => {
  const { w, calls } = boot();
  w.eval(`
    state.items = [
      { id: 1, title: 'Budget', description: '', transcript: 'Alice: numbers', notes: '',
        transcript_segments: [], speaker_map: {}, speaker_stats: [], recordings: [],
        presenter_ids: [], action_items: [], summary: '', transcribe_status: 'idle',
        transcribe_error: '', transcript_source: 'meeting' },
      { id: 2, title: 'Missions', description: '', transcript: 'Bob: report', notes: '',
        transcript_segments: [], speaker_map: {}, speaker_stats: [], recordings: [],
        presenter_ids: [], action_items: [], summary: '', transcribe_status: 'idle',
        transcribe_error: '', transcript_source: 'meeting' }
    ];
    state.meeting.recording_status = 'done';
    renderDetail();
  `);
  await w.eval("summarizeAllItems()");
  const summarized = calls.filter((c) => /\/summarize$/.test(c.path)).map((c) => c.path);
  assert.deepEqual(summarized, ["/api/items/1/summarize", "/api/items/2/summarize"]);
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
