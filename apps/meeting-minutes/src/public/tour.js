// ── Walkthrough engine ──────────────────────────────────────────────────────
// A guided tour over the real app, driven against the user's own practice
// meeting (see demo.ts). Steps are data (tour-steps.js); this file shows them.
//
// The dimming is four panels framing the spotlighted control rather than one
// sheet with a hole, so the control itself stays clickable. Every frame the
// anchor is looked up again and the panels follow it: the app rebuilds parts
// of the page under the tour (topics, the status poll), and a stale element
// would leave the spotlight on nothing.
// Spec: docs/superpowers/specs/2026-09-17-meeting-minutes-walkthrough-design.md §5
var tour = {
  on: false, i: 0, steps: [], practiceId: null, raf: 0, el: null, lastKey: '', waitingSince: 0
};
var TOUR_KEY = 'grmc.minutes.tour';

function tourStore(v){
  try {
    if(v === undefined) return JSON.parse(localStorage.getItem(TOUR_KEY) || '{}') || {};
    localStorage.setItem(TOUR_KEY, JSON.stringify(v));
  } catch(e){ return {}; }
}

// Start (or restart) the tour: make a fresh practice meeting, then step 1.
function startTour(resumeAt){
  if(tour.on) return;
  var go = function(id){
    tour.practiceId = id; tour.on = true; tour.steps = TOUR_STEPS;
    tour.i = Math.max(0, Math.min(resumeAt || 0, tour.steps.length - 1));
    tourBuild();
    tourEnter();
  };
  var offer = document.getElementById('tour-offer'); if(offer) offer.hidden = true;
  if(resumeAt){
    api('/api/practice').then(function(res){
      if(res && res.ok && res.meetingId) go(res.meetingId);
      else startFresh();
    });
    return;
  }
  startFresh();
  function startFresh(){
    resumeAt = 0;
    api('/api/practice', { method:'POST' }).then(function(res){
      if(!res || !res.ok){ alert('The practice meeting couldn’t be set up. ' + plainError((res && res.error) || '')); return; }
      if(typeof loadMeetings === 'function') loadMeetings();
      go(res.meetingId);
    });
  }
}

function endTour(finished){
  if(!tour.on) return;
  if(!finished && typeof meetingRec !== 'undefined' && meetingRec
     && !confirm('A practice recording is running. Leave the walkthrough anyway? The recording carries on until you stop it.')) return;
  tour.on = false;
  cancelAnimationFrame(tour.raf);
  if(tour.el){ tour.el.remove(); tour.el = null; }
  document.removeEventListener('keydown', tourKeys, true);
  var s = tourStore(); s.step = null; if(finished) s.done = true; s.dismissed = true; tourStore(s);
}

function tourBuild(){
  var el = document.createElement('div');
  el.id = 'tour';
  el.innerHTML = '<div class="tour-dim" data-side="t"></div><div class="tour-dim" data-side="r"></div>'
    + '<div class="tour-dim" data-side="b"></div><div class="tour-dim" data-side="l"></div>'
    + '<div class="tour-ring" hidden></div>'
    + '<div class="tour-card" role="dialog" aria-modal="false" aria-labelledby="tour-title">'
    +   '<div class="tour-count" id="tour-count"></div>'
    +   '<h3 id="tour-title"></h3><div class="tour-body" id="tour-body"></div>'
    +   '<div class="tour-wait" id="tour-wait" hidden></div>'
    +   '<div class="tour-actions"><button type="button" class="btn-sm" id="tour-back">Back</button>'
    +   '<span style="flex:1"></span>'
    +   '<button type="button" class="btn-link" id="tour-skip" hidden>Skip this step</button>'
    +   '<button type="button" class="btn btn-primary" id="tour-next">Next</button></div>'
    +   '<button type="button" class="tour-close" id="tour-close" aria-label="Leave the walkthrough">Leave walkthrough</button>'
    + '</div>';
  document.body.appendChild(el);
  tour.el = el;
  document.getElementById('tour-back').addEventListener('click', function(){ tourGo(tour.i - 1, -1); });
  document.getElementById('tour-next').addEventListener('click', function(){ tourNext(); });
  document.getElementById('tour-skip').addEventListener('click', function(){ tourGo(tour.i + 1, 1); });
  document.getElementById('tour-close').addEventListener('click', function(){ endTour(false); });
  document.addEventListener('keydown', tourKeys, true);
  tour.raf = requestAnimationFrame(tourFrame);
}

function tourKeys(e){
  if(e.key === 'Escape' && tour.on && !document.querySelector('.modal')){ e.stopPropagation(); endTour(false); }
}

function tourStep(){ return tour.steps[tour.i]; }

function tourNext(){
  var st = tourStep();
  if(st.finish){ st.finish(); return; }
  tourGo(tour.i + 1, 1);
}

// Move to step n, passing over any step that doesn't apply right now (a
// recording step when nothing is recording, say) in the direction of travel.
function tourGo(n, dir){
  dir = dir || 1;
  while(n >= 0 && n < tour.steps.length && tour.steps[n].skipIf && tour.steps[n].skipIf(tour)) n += dir;
  if(n < 0) n = 0;
  if(n >= tour.steps.length){ endTour(true); return; }
  tour.i = n;
  tourEnter();
}

// Get the app to the screen a step is about, then show it.
function tourEnter(){
  var st = tourStep();
  var s = tourStore(); s.step = tour.i; tourStore(s);
  tour.lastKey = ''; tour.waitingSince = Date.now();
  var onDetail = document.getElementById('view-detail').style.display !== 'none';
  if(st.view === 'list' && onDetail) showList();
  if(st.view === 'detail' && (!onDetail || !state.meeting || state.meeting.id !== tour.practiceId)){
    openMeeting(tour.practiceId);
  }
  if(st.enter){
    // The meeting may still be loading; run the step's setup once it is.
    var tries = 0;
    (function run(){
      if(st.view === 'detail' && !(state.meeting && state.meeting.id === tour.practiceId && document.getElementById('mtg-nav'))){
        if(tries++ < 50) setTimeout(run, 100);
        return;
      }
      if(tour.on && tourStep() === st) st.enter(tour);
    })();
  }
  tourRender();
}

function tourRender(){
  var st = tourStep(); if(!st || !tour.el) return;
  document.getElementById('tour-count').textContent = 'Walkthrough · step ' + (tour.i + 1) + ' of ' + tour.steps.length;
  document.getElementById('tour-title').textContent = typeof st.title === 'function' ? st.title(tour) : st.title;
  document.getElementById('tour-body').innerHTML = typeof st.body === 'function' ? st.body(tour) : st.body;
  document.getElementById('tour-back').disabled = tour.i === 0;
  document.getElementById('tour-skip').hidden = !st.optional;
  var next = document.getElementById('tour-next');
  next.textContent = st.nextLabel || (tour.i === tour.steps.length - 1 ? 'Finish' : 'Next');
  if(st.extra){ var x = st.extra(tour); if(x) document.getElementById('tour-body').appendChild(x); }
  tourCheck();
}

// A step that waits for something real (a click, a recording starting) keeps
// Next off until it happens, then moves on by itself.
function tourCheck(){
  var st = tourStep(); if(!st) return;
  var wait = document.getElementById('tour-wait'), next = document.getElementById('tour-next');
  if(!st.until){ wait.hidden = true; next.disabled = false; return; }
  var done = false;
  try { done = !!st.until(tour); } catch(e){ done = false; }
  if(done){ tourGo(tour.i + 1, 1); return; }
  next.disabled = true;
  wait.hidden = false;
  wait.textContent = st.hint || 'Waiting for you to do this…';
}

function tourFrame(){
  if(!tour.on) return;
  tour.raf = requestAnimationFrame(tourFrame);
  var st = tourStep(); if(!st) return;
  if(st.until) tourCheck();
  if(!tour.on) return;
  var sel = typeof st.anchor === 'function' ? st.anchor(tour) : st.anchor;
  var a = sel ? document.querySelector(sel) : null;
  var vw = window.innerWidth, vh = window.innerHeight;
  // Bring the control into view once per step, the first time it's there.
  if(a && tour.scrolledFor !== tour.i && a.getBoundingClientRect){
    tour.scrolledFor = tour.i;
    var rr = a.getBoundingClientRect();
    if((rr.top < 70 || rr.bottom > vh - 20) && a.scrollIntoView){ try { a.scrollIntoView({ block: rr.height > vh * 0.6 ? 'start' : 'center' }); } catch(e){} }
  }
  var r = a && a.getBoundingClientRect ? a.getBoundingClientRect() : null;
  var hole = r && r.width > 0 && r.height > 0 && vw >= 700
    ? { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), w: Math.min(vw, r.width + 16), h: Math.min(vh, r.height + 16) } : null;
  var key = hole ? [hole.x, hole.y, hole.w, hole.h].map(Math.round).join(',') : 'none';
  key += '|' + vw + 'x' + vh + '|' + tour.i;
  if(key === tour.lastKey) return;
  tour.lastKey = key;
  tourPlace(hole, vw, vh, a);
}

function tourPlace(hole, vw, vh, anchor){
  var dims = tour.el.querySelectorAll('.tour-dim'), ring = tour.el.querySelector('.tour-ring');
  var card = tour.el.querySelector('.tour-card');
  var set = function(el, x, y, w, h){ el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.width = Math.max(0, w) + 'px'; el.style.height = Math.max(0, h) + 'px'; };
  if(!hole){
    // Nothing to point at (yet, or on a narrow screen): dim lightly, card
    // docked in the corner.
    set(dims[0], 0, 0, vw, vh); set(dims[1], 0, 0, 0, 0); set(dims[2], 0, 0, 0, 0); set(dims[3], 0, 0, 0, 0);
    ring.hidden = true;
    card.className = 'tour-card docked';
    card.style.left = ''; card.style.top = '';
    return;
  }
  set(dims[0], 0, 0, vw, hole.y);
  set(dims[1], hole.x + hole.w, hole.y, vw - hole.x - hole.w, hole.h);
  set(dims[2], 0, hole.y + hole.h, vw, vh - hole.y - hole.h);
  set(dims[3], 0, hole.y, hole.x, hole.h);
  ring.hidden = false;
  set(ring, hole.x, hole.y, hole.w, hole.h);
  card.className = 'tour-card';
  // Beside the spotlight if there's room, else below or above it.
  var cw = card.offsetWidth || 360, ch = card.offsetHeight || 220, gap = 14, x, y;
  if(hole.x + hole.w + gap + cw <= vw - 12){ x = hole.x + hole.w + gap; y = hole.y; }
  else if(hole.x - gap - cw >= 12){ x = hole.x - gap - cw; y = hole.y; }
  else if(hole.y + hole.h + gap + ch <= vh - 12){ x = hole.x; y = hole.y + hole.h + gap; }
  else { x = hole.x; y = hole.y - gap - ch; }
  x = Math.max(12, Math.min(x, vw - cw - 12));
  y = Math.max(12, Math.min(y, vh - ch - 12));
  card.style.left = x + 'px'; card.style.top = y + 'px';
}

// The header button and the one-time offer on the meetings list.
function initTour(){
  var hr = document.querySelector('header .hright');
  if(hr && !document.getElementById('btn-tour')){
    var b = document.createElement('button');
    b.type = 'button'; b.id = 'btn-tour'; b.className = 'btn-hdr'; b.textContent = 'Walkthrough';
    b.title = 'A guided tour on a practice meeting';
    b.addEventListener('click', function(){ startTour(0); });
    hr.insertBefore(b, hr.firstChild);
  }
  var s = tourStore();
  var offer = document.getElementById('tour-offer');
  if(!offer) return;
  if(typeof s.step === 'number' && s.step > 0){
    offer.innerHTML = '<span>You were part-way through the walkthrough.</span>'
      + '<button type="button" class="btn btn-primary" id="tour-resume">Carry on where I left off</button>'
      + '<button type="button" class="btn-link" id="tour-no">No thanks</button>';
    offer.hidden = false;
    document.getElementById('tour-resume').addEventListener('click', function(){ startTour(s.step); });
  } else if(!s.dismissed && !s.done){
    offer.innerHTML = '<span><b>New here?</b> A 5-minute walkthrough shows how to take a meeting’s minutes, on a practice meeting only you can see.</span>'
      + '<button type="button" class="btn btn-primary" id="tour-yes">Show me how</button>'
      + '<button type="button" class="btn-link" id="tour-no">Not now</button>';
    offer.hidden = false;
    document.getElementById('tour-yes').addEventListener('click', function(){ startTour(0); });
  } else { offer.hidden = true; return; }
  document.getElementById('tour-no').addEventListener('click', function(){
    var t = tourStore(); t.dismissed = true; t.step = null; tourStore(t); offer.hidden = true;
  });
}

initTour();
