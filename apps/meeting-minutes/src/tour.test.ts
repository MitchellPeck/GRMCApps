// The walkthrough engine (public/tour.js) driven inside a DOM, like
// modal.test.ts: index.html + app.js + the tour scripts, with fetch stubbed.
// Skips without jsdom.
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let JSDOM: any = null;
try { ({ JSDOM } = require("jsdom")); } catch { /* not installed — tests skip */ }
const PUBLIC_DIRS = [join(__dirname, "..", "src", "public"), join(__dirname, "public")];
const publicDir = PUBLIC_DIRS.find((d) => existsSync(join(d, "tour.js"))) ?? "";
const skip = !JSDOM || !publicDir;

const openWindows: any[] = [];
after(() => { for (const w of openWindows) { try { w.close(); } catch { /* gone */ } } });
const flush = () => new Promise((r) => setTimeout(r, 30));

function boot(stored?: object) {
  const dom = new JSDOM(readFileSync(join(publicDir, "index.html"), "utf8"), {
    runScripts: "outside-only", url: "https://minutes.test/", pretendToBeVisual: true,
  });
  const w = dom.window;
  openWindows.push(w);
  if (stored) w.localStorage.setItem("grmc.minutes.tour", JSON.stringify(stored));
  const calls: Array<{ path: string; method: string }> = [];
  w.fetch = (path: string, opts: any = {}) => {
    calls.push({ path, method: opts.method ?? "GET" });
    const body = path === "/api/practice" ? { ok: true, meetingId: 7 }
      : path === "/api/meetings" ? { ok: true, meetings: [] }
      : { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  w.MediaRecorder = function () { /* feature-detected */ };
  for (const f of ["app.js", "tour.js", "tour-steps.js"]) w.eval(readFileSync(join(publicDir, f), "utf8"));
  // The engine opens the practice meeting itself; here it is already open.
  w.eval(`openMeeting = function(){}; showList = function(){};
    state.meeting = { id: 7, title: 'PRACTICE', recording_status: 'idle', speaker_map: {} };
    state.items = [{ id: 1, title: 'A', transcript_segments: [], recordings: [], presenter_ids: [], action_items: [] },
                   { id: 2, title: 'B', transcript_segments: [], recordings: [], presenter_ids: [], action_items: [] },
                   { id: 3, title: 'C', transcript_segments: [], recordings: [], presenter_ids: [], action_items: [] }];
    state.attendeeIds = []; state.people = []; state.peopleById = {}; state.meetingRecordings = []; state.meetingSpeakerStats = [];`);
  return { w, doc: w.document, calls };
}
const stepTitle = (doc: any) => doc.getElementById("tour-title").textContent;
const goTo = (w: any, title: string) => w.eval(`tourGo(TOUR_STEPS.findIndex(function(s){ return s.title === ${JSON.stringify(title)}; }), 1)`);

test("first visit offers the walkthrough; Not now remembers", { skip }, () => {
  const { w, doc } = boot();
  const offer = doc.getElementById("tour-offer");
  assert.equal(offer.hidden, false);
  assert.match(offer.textContent, /walkthrough/);
  doc.getElementById("tour-no").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.equal(offer.hidden, true);
  assert.equal(JSON.parse(w.localStorage.getItem("grmc.minutes.tour")).dismissed, true);
  assert.ok(doc.getElementById("btn-tour"), "the header button stays for later");
});

test("starting makes a fresh practice meeting and shows step 1", { skip }, async () => {
  const { w, doc, calls } = boot();
  doc.getElementById("btn-tour").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await flush();
  assert.ok(calls.some((c) => c.path === "/api/practice" && c.method === "POST"));
  assert.equal(stepTitle(doc), "Welcome");
  assert.match(doc.getElementById("tour-count").textContent, /step 1 of/);
});

test("a step that waits keeps Next off, then moves on by itself", { skip }, async () => {
  const { w, doc } = boot();
  w.eval("startTour(0)"); await flush();
  goTo(w, "Open a topic");
  w.eval("tourCheck()");
  assert.equal(doc.getElementById("tour-next").disabled, true);
  assert.match(doc.getElementById("tour-wait").textContent, /Budget review/);
  w.eval("state.openItemId = 2; tourCheck()");
  assert.equal(stepTitle(doc), "Inside a topic");
});

test("recording steps are passed over when nothing is recording", { skip }, async () => {
  const { w, doc } = boot();
  w.eval("startTour(0)"); await flush();
  goTo(w, "3. Record");
  assert.equal(doc.getElementById("tour-skip").hidden, false, "optional: Skip is offered");
  doc.getElementById("tour-skip").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.equal(stepTitle(doc), "4. Voices");
});

test("with a recording running, the tour follows it into the console", { skip }, async () => {
  const { w, doc } = boot();
  w.eval("startTour(0)"); await flush();
  goTo(w, "3. Record");
  w.eval("meetingRec = { meetingId: 7, topicId: null, t0: performance.now() }; tourCheck()");
  assert.equal(stepTitle(doc), "Tap the topic being discussed");
  w.eval("meetingRec.topicId = 3; tourCheck()");
  assert.equal(stepTitle(doc), "Say a few words");
});

test("with no anchor on screen the card docks and nothing is spotlit", { skip }, async () => {
  const { w, doc } = boot();
  w.eval("startTour(0)"); await flush();
  goTo(w, "Inside a topic"); // #ibody-2 isn't on the page
  w.eval("tour.lastKey = ''; tourFrame()");
  assert.match(doc.querySelector(".tour-card").className, /docked/);
  assert.equal(doc.querySelector(".tour-ring").hidden, true);
});

test("Esc leaves, but asks first while a recording runs", { skip }, async () => {
  const { w, doc } = boot();
  w.eval("startTour(0)"); await flush();
  w.eval("meetingRec = { meetingId: 7 }");
  let asked = 0;
  w.confirm = () => { asked++; return false; };
  doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(asked, 1);
  assert.ok(doc.getElementById("tour"), "still there after No");
  w.eval("meetingRec = null");
  doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(doc.getElementById("tour"), null);
});

test("a reload part-way through offers to carry on from the same step", { skip }, async () => {
  const { w, doc, calls } = boot({ step: 4 });
  assert.match(doc.getElementById("tour-offer").textContent, /part-way/);
  doc.getElementById("tour-resume").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await flush();
  assert.ok(calls.some((c) => c.path === "/api/practice" && c.method === "GET"), "finds the existing practice meeting");
  assert.ok(!calls.some((c) => c.path === "/api/practice" && c.method === "POST"), "doesn't make a new one");
  assert.match(doc.getElementById("tour-count").textContent, /step 5 of/);
});

test("without an API key the minutes step says so and can be skipped", { skip }, async () => {
  const { w, doc } = boot();
  w.eval("startTour(0)"); await flush();
  w.eval("state.aiReady = false");
  goTo(w, "5. Minutes");
  assert.match(doc.getElementById("tour-body").textContent, /isn’t set up yet/);
  assert.equal(doc.getElementById("tour-skip").hidden, false);
});
