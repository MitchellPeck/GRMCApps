// Content Pipeline — one page over the same three records (events, posts,
// media). Every view below is a filtered read; nothing is cached between views
// except the shared filter choice, which follows you from screen to screen.
(function(){
'use strict';

// ── Plumbing ─────────────────────────────────────────────────────────────────
function api(method, path, body) {
  return fetch(path, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(function(res){
    if (!res.ok) throw new Error('The server answered ' + res.status + '. Try again in a moment.');
    return res.json();
  }).then(function(data){
    if (!data.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  });
}

function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function $(id){ return document.getElementById(id); }
function qs(obj){
  var parts = [];
  Object.keys(obj).forEach(function(k){ if (obj[k] !== '' && obj[k] != null && obj[k] !== false) parts.push(encodeURIComponent(k)+'='+encodeURIComponent(obj[k])); });
  return parts.length ? '?' + parts.join('&') : '';
}

var toastTimer;
function toast(msg, kind) {
  var t = $('pl-toast');
  t.className = 'pl-toast show ' + (kind || '');
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.className = 'pl-toast'; }, kind === 'err' ? 7000 : 3500);
}
function warnAll(warnings){ if (warnings && warnings.length) toast(warnings.join(' '), 'warn'); }

function storeGet(k){ try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
function storeSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window */ } }

// ── Dates (calendar dates only — never through a timezone) ───────────────────
var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function parseIso(iso){ var p = iso.split('-').map(Number); return new Date(p[0], p[1]-1, p[2]); }
function isoOf(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function addDays(iso, n){ var d = parseIso(iso); d.setDate(d.getDate()+n); return isoOf(d); }
// The year only appears when it isn't this year — a copied event a year out
// mustn't read as next week.
function shortDate(iso){
  if (!iso) return 'No date';
  var d = parseIso(iso), thisYear = S.meta ? Number(S.meta.today.slice(0, 4)) : new Date().getFullYear();
  return DOW[d.getDay()]+' '+MONTHS[d.getMonth()].slice(0,3)+' '+d.getDate()+(d.getFullYear() !== thisYear ? ', '+d.getFullYear() : '');
}
function rangeLabel(a, b){
  if (!a && !b) return '';
  if (a && b && a !== b) return shortDate(a) + ' – ' + shortDate(b);
  return shortDate(a || b);
}
function timeLabel(t){
  if (!t) return '';
  var h = Number(t.slice(0,2)), m = t.slice(3,5);
  return (h % 12 || 12) + (m === '00' ? '' : ':' + m) + (h < 12 ? 'am' : 'pm');
}

// ── State ────────────────────────────────────────────────────────────────────
var S = {
  meta: null, events: [], people: [],
  filters: storeGet('pipeline.filters') || { eventId: '', platform: '', status: '', owner: '' },
  cal: storeGet('pipeline.cal') || { lens: 'publish', view: 'month', anchor: '' },
  // What the current view rendered from, so drag-and-drop can update in place.
  rows: { content: {}, media: {} },
};

function label(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function eventById(id){ for (var i = 0; i < S.events.length; i++) if (S.events[i].id === id) return S.events[i]; return null; }
function personName(email){
  if (!email) return '';
  for (var i = 0; i < S.people.length; i++) if (S.people[i].email.toLowerCase() === email.toLowerCase()) return S.people[i].name || email;
  return email;
}
function initials(email){
  var n = personName(email);
  if (!n) return '';
  var parts = n.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0] || '').charAt(0) + (parts[1] || '').charAt(0)).toUpperCase();
}
var PLATFORM_SHORT = { instagram: 'IG', facebook: 'FB', x: 'X' };
function platformChips(list){
  return (list || []).map(function(p){
    var meta = (S.meta.platforms || []).filter(function(x){ return x.key === p; })[0];
    return '<span class="pl-plat" title="'+esc(meta ? meta.label : p)+'">'+esc(PLATFORM_SHORT[p] || p.slice(0,2).toUpperCase())+'</span>';
  }).join('');
}
function recMark(i){ return i.recurrenceId ? '<span class="pl-rec" title="Repeats" aria-label="Repeats">↻</span> ' : ''; }
// Media statuses as people say them: "captured" is shown as Collected, and
// "edited" as Final file (the finished file is attached).
var MEDIA_LABELS = { needed: 'Needed', scheduled: 'Scheduled', captured: 'Collected', edited: 'Final file' };
function mediaLabel(s){ return MEDIA_LABELS[s] || label(s); }
function statusBadge(s, kind){ return '<span class="pl-status pl-s-'+esc(s)+(kind === 'media' ? ' pl-media-s' : '')+'">'+esc(kind === 'media' ? mediaLabel(s) : label(s))+'</span>'; }
function mediaProgress(item){
  if (item.noMediaNeeded) return '<span class="pl-prog pl-prog-none">No media needed</span>';
  if (!item.mediaTotal) return '<span class="pl-prog pl-prog-gap">No media planned</span>';
  var pct = Math.round(100 * item.mediaDone / item.mediaTotal);
  return '<span class="pl-prog" title="'+item.mediaDone+' of '+item.mediaTotal+' collected">'
    + '<span class="pl-bar"><span style="width:'+pct+'%"></span></span>'+item.mediaDone+' of '+item.mediaTotal+' collected</span>';
}

// ── Filters (shared by every screen) ─────────────────────────────────────────
function eventOptions(selected, opts){
  opts = opts || {};
  var groups = { event: [], department: [], series: [] };
  S.events.forEach(function(e){ if (!e.archived || e.id === selected) (groups[e.kind] || groups.event).push(e); });
  var html = '<option value="">'+esc(opts.blank || 'All events')+'</option>';
  [['event','Events'],['department','Departments'],['series','Series & weekly runs']].forEach(function(g){
    if (!groups[g[0]].length) return;
    html += '<optgroup label="'+g[1]+'">' + groups[g[0]].map(function(e){
      return '<option value="'+esc(e.id)+'"'+(e.id === selected ? ' selected' : '')+'>'+esc(e.name)+'</option>';
    }).join('') + '</optgroup>';
  });
  return html;
}

function renderFilters() {
  var f = S.filters, m = S.meta;
  var people = S.people.map(function(p){ return '<option value="'+esc(p.email)+'"'+(p.email === f.owner ? ' selected' : '')+'>'+esc(p.name || p.email)+'</option>'; }).join('');
  if (f.owner && !S.people.some(function(p){ return p.email === f.owner; })) people += '<option value="'+esc(f.owner)+'" selected>'+esc(f.owner)+'</option>';
  $('pl-filters').innerHTML =
      '<label class="pl-f"><span>Event</span><select data-filter="eventId">'+eventOptions(f.eventId)+'</select></label>'
    + '<label class="pl-f"><span>Platform</span><select data-filter="platform"><option value="">All platforms</option>'
    +   m.platforms.map(function(p){ return '<option value="'+esc(p.key)+'"'+(p.key === f.platform ? ' selected' : '')+'>'+esc(p.label)+'</option>'; }).join('')+'</select></label>'
    + '<label class="pl-f"><span>Status</span><select data-filter="status"><option value="">Any status</option>'
    +   m.contentStatuses.map(function(s){ return '<option value="'+s+'"'+(s === f.status ? ' selected' : '')+'>'+label(s)+'</option>'; }).join('')+'</select></label>'
    + '<label class="pl-f"><span>Owner</span><select data-filter="owner"><option value="">Anyone</option>'+people+'</select></label>'
    + (f.eventId || f.platform || f.status || f.owner ? '<button class="btn-sm pl-clear" type="button" data-act="clear-filters">Clear filters</button>' : '');
}

// The dashboard's week lists come pre-built from the server, so the shared
// filters are applied to them here.
function matchItem(i) {
  var f = S.filters;
  return (!f.eventId || i.eventId === f.eventId) && (!f.platform || i.platforms.indexOf(f.platform) !== -1)
    && (!f.status || i.status === f.status) && (!f.owner || (i.ownerEmail || '').toLowerCase() === f.owner.toLowerCase());
}
function matchMedia(m) {
  var f = S.filters;
  return (!f.eventId || m.eventId === f.eventId) && (!f.owner || (m.assigneeEmail || '').toLowerCase() === f.owner.toLowerCase());
}

function contentFilterQuery(extra) {
  var f = S.filters, q = { eventId: f.eventId, platform: f.platform, status: f.status, ownerEmail: f.owner };
  Object.keys(extra || {}).forEach(function(k){ q[k] = extra[k]; });
  return qs(q);
}
// Media has no platform or post status of its own; the event and the person
// (as assignee) carry over.
function mediaFilterQuery(extra) {
  var f = S.filters, q = { eventId: f.eventId, assigneeEmail: f.owner };
  Object.keys(extra || {}).forEach(function(k){ q[k] = extra[k]; });
  return qs(q);
}

// ── Routing ──────────────────────────────────────────────────────────────────
function route() {
  var h = location.hash.replace(/^#/, '') || 'dashboard';
  var parts = h.split('/');
  return { view: parts[0], arg: decodeURIComponent(parts.slice(1).join('/')) };
}

function render() {
  var r = route();
  var tabView = r.view === 'event' ? 'events' : r.view === 'gap' ? 'dashboard' : r.view;
  document.querySelectorAll('#pl-tabs .tab').forEach(function(t){
    var on = t.getAttribute('data-view') === tabView;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  // The filters only narrow the dashboard, calendar and board; anywhere else
  // they'd sit there doing nothing. Settings has no use for New post either.
  $('pl-filters').hidden = !({ dashboard: 1, calendar: 1, board: 1 })[r.view];
  document.querySelector('.pl-toolbar').hidden = r.view === 'settings';
  var main = $('pl-main');
  var views = { dashboard: renderDashboard, calendar: renderCalendar, board: renderBoard, events: renderEvents, event: renderEvent,
    gap: renderGapList, recurring: renderRecurring, mine: renderMine, settings: renderSettings };
  // Returned so callers can act once the view has finished drawing.
  return (views[r.view] || renderDashboard)(main, r.arg).catch(function(e){
    main.innerHTML = '<div class="alert alert-err">Couldn’t load this view: '+esc(e.message)+'</div>';
  });
}

function refreshEvents() {
  return api('GET', '/api/pipeline/events?archived=all').then(function(d){ S.events = d.events; });
}

// ── Dashboard ────────────────────────────────────────────────────────────────
// The board's scope: posts publishing from 30 days ago on, plus undated ones,
// narrowed by the shared filters. The dashboard counts this same set, so its
// numbers always match the board's columns.
function loadBoardItems(includeCancelled) {
  var from = addDays(S.meta.today, -30), c = includeCancelled ? 1 : '';
  return Promise.all([
    api('GET', '/api/pipeline/content' + contentFilterQuery({ from: from, includeCancelled: c })),
    api('GET', '/api/pipeline/content' + contentFilterQuery({ undated: 1, includeCancelled: c })),
  ]).then(function(res){ return { from: from, items: res[0].items.concat(res[1].items) }; });
}

function renderDashboard(main) {
  return Promise.all([
    api('GET', '/api/pipeline/dashboard/summary'),
    api('GET', '/api/pipeline/dashboard/gaps'),
    loadBoardItems(false),
  ]).then(function(res){
    var sum = res[0], gaps = res[1].gaps, board = res[2];
    sum.posts = sum.posts.filter(matchItem);
    sum.capture = sum.capture.filter(matchMedia);
    var total = gaps.reduce(function(n, g){ return n + g.count; }, 0);
    var html = '<section class="pl-gaps'+(total ? '' : ' pl-gaps-clear')+'" aria-label="Gaps">'
      + '<h2>'+(total ? 'What’s missing' : 'Nothing is missing')+'</h2>'
      + (total ? '' : '<p>Every post due soon is ready and every capture is on the calendar.</p>')
      + '<div class="pl-gap-grid">'
      + gaps.map(function(g){
          return '<a class="pl-gap'+(g.count ? '' : ' zero')+'" href="#gap/'+esc(g.key)+'"><strong>'+g.count+'</strong><span>'+esc(g.label)+'</span></a>';
        }).join('')
      + '</div></section>';

    var by = {};
    board.items.forEach(function(i){ by[i.status] = (by[i.status] || 0) + 1; });
    var flow = S.meta.contentStatuses.filter(function(s){ return s !== 'cancelled'; });
    html += '<section class="card"><h3 class="ct">Pipeline</h3><div class="pl-flow">'
      + flow.map(function(s){
          return '<a class="pl-flow-step" href="#board" data-act="filter-status" data-status="'+s+'"><strong>'+(by[s] || 0)+'</strong>'+statusBadge(s)+'</a>';
        }).join('')
      + '</div><p class="hint">The same posts as the board: publishing from '+esc(shortDate(board.from))+' on, plus undated ones'
      + (S.filters.eventId || S.filters.platform || S.filters.status || S.filters.owner ? ', with your filters' : '')+'.</p></section>';

    html += '<div class="pl-two">'
      + '<section class="card"><h3 class="ct">Publishing this week</h3>'
      + (sum.posts.length ? '<ul class="pl-agenda">'+sum.posts.map(agendaPost).join('')+'</ul>'
          : '<p class="empty">Nothing is scheduled to publish in the next '+S.meta.upcomingDays+' days. <button class="btn-sm" data-act="new-post">Plan a post</button></p>')
      + '</section>'
      + '<section class="card"><h3 class="ct">Capture days this week</h3>'
      + (sum.capture.length ? '<ul class="pl-agenda">'+sum.capture.map(agendaMedia).join('')+'</ul>'
          : '<p class="empty">No media is being gathered in the next '+S.meta.upcomingDays+' days.</p>')
      + '</section></div>';

    html += '<section class="card"><h3 class="ct">Coming up</h3>'
      + (sum.upcomingEvents.length ? '<ul class="pl-events-mini">'+sum.upcomingEvents.map(function(e){
          return '<li><a href="#event/'+encodeURIComponent(e.id)+'"><span class="pl-swatch" style="background:'+esc(e.color)+'"></span>'
            + '<span class="pl-ev-name">'+esc(e.name)+'</span><span class="muted">'+esc(rangeLabel(e.startDate, e.endDate))+'</span></a></li>';
        }).join('')+'</ul>'
        : '<p class="empty">No dated events ahead. <a href="#events">Add an event</a> so its posts and captures have a home.</p>')
      + '</section>';
    main.innerHTML = html;
  });
}

function agendaPost(i) {
  S.rows.content[i.id] = i;
  return '<li><button class="pl-row" data-act="open" data-id="'+esc(i.id)+'" style="--ev:'+esc(i.eventColor || 'var(--rule)')+'">'
    + '<span class="pl-when">'+esc(shortDate(i.publishDate))+(i.publishTime ? ' '+esc(timeLabel(i.publishTime)) : '')+'</span>'
    + '<span class="pl-what"><span class="pl-title">'+esc(i.title)+'</span><span class="pl-sub">'+esc(i.eventName || 'No event')+' '+platformChips(i.platforms)+'</span></span>'
    + statusBadge(i.status)+'</button></li>';
}
function agendaMedia(m) {
  S.rows.media[m.id] = m;
  return '<li><button class="pl-row" data-act="open" data-id="'+esc(m.contentItemId)+'" style="--ev:'+esc(m.eventColor || 'var(--rule)')+'">'
    + '<span class="pl-when">'+esc(shortDate(m.gatherDate))+'</span>'
    + '<span class="pl-what"><span class="pl-title">'+esc(m.description)+'</span><span class="pl-sub">'+esc(label(m.type))+' for “'+esc(m.itemTitle)+'”'
    + (m.assigneeEmail ? ' · '+esc(personName(m.assigneeEmail)) : ' · <em>nobody assigned</em>')+'</span></span>'
    + statusBadge(m.status, 'media')+'</button></li>';
}

// ── Gap lists ────────────────────────────────────────────────────────────────
function renderGapList(main, key) {
  return api('GET', '/api/pipeline/dashboard/gaps').then(function(res){
    var gap = res.gaps.filter(function(g){ return g.key === key; })[0];
    if (!gap) { main.innerHTML = '<div class="alert alert-err">That alert doesn’t exist. <a href="#dashboard">Back to the dashboard</a></div>'; return; }
    var head = '<p class="pl-back"><a href="#dashboard">Dashboard</a></p><h2 class="pl-h2">'+esc(gap.label)+'</h2>';
    if (!gap.count) { main.innerHTML = head + '<p class="empty">Nothing here right now.</p>'; return; }
    var ids = gap.ids.join(',');
    var req = gap.kind === 'content'
      ? api('GET', '/api/pipeline/content' + qs({ ids: ids }))
      : api('GET', '/api/pipeline/media' + qs({ ids: ids }));
    return req.then(function(d){
      var list = gap.kind === 'content' ? d.items.map(agendaPost) : d.media.map(agendaMedia);
      main.innerHTML = head + '<p class="hint">These ignore the filters above, so nothing hides from the count.</p>'
        + '<section class="card"><ul class="pl-agenda">'+list.join('')+'</ul></section>';
    });
  });
}

// ── Calendar (one component, two lenses) ─────────────────────────────────────
function calRange() {
  var c = S.cal, anchor = c.anchor || S.meta.today;
  if (c.view === 'week') {
    var start = addDays(anchor, -parseIso(anchor).getDay());
    return { start: start, end: addDays(start, 6), anchor: anchor };
  }
  var a = parseIso(anchor), first = new Date(a.getFullYear(), a.getMonth(), 1);
  var start2 = addDays(isoOf(first), -first.getDay());
  var last = new Date(a.getFullYear(), a.getMonth() + 1, 0);
  var end = addDays(isoOf(last), 6 - last.getDay());
  return { start: start2, end: end, anchor: anchor, month: a.getMonth() };
}

function calTitle(r) {
  if (S.cal.view === 'week') return 'Week of ' + shortDate(r.start);
  var a = parseIso(r.anchor); return MONTHS[a.getMonth()] + ' ' + a.getFullYear();
}

function renderCalendar(main) {
  var c = S.cal, r = calRange(), publish = c.lens === 'publish';
  var load = publish
    ? Promise.all([api('GET', '/api/pipeline/content' + contentFilterQuery({ from: r.start, to: r.end })),
                   api('GET', '/api/pipeline/content' + contentFilterQuery({ undated: 1 }))])
    : Promise.all([api('GET', '/api/pipeline/media' + mediaFilterQuery({ from: r.start, to: r.end })),
                   // Only media still to collect needs a day; collected work stays off the tray.
                   api('GET', '/api/pipeline/media' + mediaFilterQuery({ unscheduled: 1, status: 'needed' }))]);
  return load.then(function(res){
    var rows = publish ? res[0].items : res[0].media;
    var tray = publish ? res[1].items : res[1].media;
    var byDay = {};
    rows.forEach(function(x){ var d = publish ? x.publishDate : x.gatherDate; (byDay[d] = byDay[d] || []).push(x); });
    var card = publish ? postCard : mediaCard;

    var html = '<div class="pl-calhead">'
      + '<div class="pl-seg" role="group" aria-label="Calendar">'
      +   '<button type="button" data-act="lens" data-lens="publish" aria-pressed="'+publish+'">Publish dates</button>'
      +   '<button type="button" data-act="lens" data-lens="capture" aria-pressed="'+!publish+'">Capture dates</button></div>'
      + '<div class="pl-calnav"><button class="btn-sm" type="button" data-act="cal-move" data-dir="-1" aria-label="Previous">‹</button>'
      +   '<h2>'+esc(calTitle(r))+'</h2>'
      +   '<button class="btn-sm" type="button" data-act="cal-move" data-dir="1" aria-label="Next">›</button>'
      +   '<button class="btn-sm" type="button" data-act="cal-today">Today</button></div>'
      + '<div class="pl-seg" role="group" aria-label="Range">'
      +   '<button type="button" data-act="cal-view" data-v="month" aria-pressed="'+(c.view === 'month')+'">Month</button>'
      +   '<button type="button" data-act="cal-view" data-v="week" aria-pressed="'+(c.view === 'week')+'">Week</button></div>'
      + '</div>';

    var days = [];
    for (var d = r.start; d <= r.end; d = addDays(d, 1)) days.push(d);
    html += '<div class="pl-cal pl-cal-'+c.view+'" role="grid">'
      + DOW.map(function(n){ return '<div class="pl-dow" role="columnheader">'+n+'</div>'; }).join('')
      + days.map(function(day){
          var dd = parseIso(day), list = byDay[day] || [];
          var cls = 'pl-day' + (day === S.meta.today ? ' today' : '') + (r.month != null && dd.getMonth() !== r.month ? ' out' : '');
          return '<div class="'+cls+'" role="gridcell" data-drop="'+day+'"><div class="pl-dnum">'
            + '<span class="pl-dlabel">'+DOW[dd.getDay()]+' '+MONTHS[dd.getMonth()].slice(0,3)+' </span>'+dd.getDate()+'</div>'
            + list.map(card).join('')
            + (publish ? '<button class="pl-add" type="button" data-act="new-post" data-date="'+day+'" aria-label="New post on '+esc(shortDate(day))+'">+</button>' : '')
            + '</div>';
        }).join('')
      + '</div>';

    if (!publish && (S.filters.platform || S.filters.status)) {
      html += '<p class="hint">Platform and status filters apply to posts, so they don’t narrow capture dates. Owner shows media assigned to that person.</p>';
    }
    html += '<section class="pl-tray" data-drop="">'
      + '<h3>'+(publish ? 'Posts with no publish date' : 'Media with no gather date')+' <span class="badge-count'+(tray.length ? '' : ' zero')+'">'+tray.length+'</span></h3>'
      + (tray.length ? '<div class="pl-tray-list">'+tray.map(card).join('')+'</div>'
          : '<p class="hint">'+(publish ? 'Every post has a date.' : 'Every capture has a day. Drag a card here to unschedule it.')+'</p>')
      + (tray.length ? '<p class="hint">Drag a card onto a day to schedule it'+(publish ? '' : ', or back here to unschedule it')+'.</p>' : '')
      + '</section>';
    main.innerHTML = html;
  });
}

function postCard(i) {
  S.rows.content[i.id] = i;
  var dim = i.status === 'published' ? ' done' : '';
  return '<div class="pl-card'+dim+'" role="button" tabindex="0" draggable="true" data-kind="content" data-id="'+esc(i.id)+'" data-act="open" style="--ev:'+esc(i.eventColor || 'var(--rule)')+'"'
    + ' title="'+esc(i.title + (i.eventName ? ' — ' + i.eventName : ''))+'">'
    + '<span class="pl-card-title">'+recMark(i)+(i.publishTime ? '<span class="pl-time">'+esc(timeLabel(i.publishTime))+'</span> ' : '')+esc(i.title)+'</span>'
    + '<span class="pl-card-meta">'+platformChips(i.platforms)+statusBadge(i.status)+'</span></div>';
}

function mediaCard(m) {
  S.rows.media[m.id] = m;
  var dim = m.status === 'captured' || m.status === 'edited' ? ' done' : '';
  var late = m.gatherDate && m.itemPublishDate && m.gatherDate > m.itemPublishDate;
  return '<div class="pl-card'+dim+(late ? ' late' : '')+'" role="button" tabindex="0" draggable="true" data-kind="media" data-id="'+esc(m.id)+'" data-act="open" data-item="'+esc(m.contentItemId)+'" style="--ev:'+esc(m.eventColor || 'var(--rule)')+'"'
    + ' title="'+esc(m.description+' for '+m.itemTitle+(late ? ' — gathered after the post publishes' : ''))+'">'
    + '<span class="pl-card-title">'+esc(m.description)+'</span>'
    + '<span class="pl-card-meta"><span class="pl-type">'+esc(label(m.type))+'</span>'
    + (m.assigneeEmail ? '<span class="pl-who" title="'+esc(personName(m.assigneeEmail))+'">'+esc(initials(m.assigneeEmail))+'</span>' : '<span class="pl-who none" title="Nobody assigned">?</span>')
    + statusBadge(m.status, 'media')+'</span>'
    + '<span class="pl-card-for">For “'+esc(m.itemTitle)+'”'+(m.itemPublishDate ? ', '+esc(shortDate(m.itemPublishDate)) : '')+'</span></div>';
}

// Drag a card to a day: move it on screen immediately, save, and put it back
// if the save fails.
var dragging = null;
document.addEventListener('dragstart', function(e){
  var el = e.target.closest && e.target.closest('[draggable="true"]');
  if (!el) return;
  dragging = { kind: el.getAttribute('data-kind'), id: el.getAttribute('data-id') };
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', dragging.id); } catch (err) { /* old browsers */ }
  el.classList.add('dragging');
});
document.addEventListener('dragend', function(e){
  var el = e.target.closest && e.target.closest('[draggable="true"]');
  if (el) el.classList.remove('dragging');
  document.querySelectorAll('.drop-over').forEach(function(x){ x.classList.remove('drop-over'); });
  dragging = null;
});
document.addEventListener('dragover', function(e){
  var zone = dragging && e.target.closest && e.target.closest('[data-drop]');
  if (!zone) return;
  // The board's columns take content only; the tray takes whatever the lens shows.
  if (zone.hasAttribute('data-status') && dragging.kind !== 'content') return;
  e.preventDefault();
  document.querySelectorAll('.drop-over').forEach(function(x){ if (x !== zone) x.classList.remove('drop-over'); });
  zone.classList.add('drop-over');
});
document.addEventListener('drop', function(e){
  var zone = dragging && e.target.closest && e.target.closest('[data-drop]');
  if (!zone) return;
  e.preventDefault();
  var d = dragging; dragging = null;
  zone.classList.remove('drop-over');
  if (zone.hasAttribute('data-status')) return moveStatus(d.id, zone.getAttribute('data-status'));
  moveDate(d.kind, d.id, zone.getAttribute('data-drop') || null);
});

function moveDate(kind, id, date) {
  var row = kind === 'content' ? S.rows.content[id] : S.rows.media[id];
  if (!row) return;
  var field = kind === 'content' ? 'publishDate' : 'gatherDate';
  if (row[field] === date) return;
  if (kind === 'content' && !date) { toast('A post needs a publish date. Open it to change the date instead.', 'warn'); return; }
  var before = row[field];
  // Optimistic: show it where it was dropped straight away.
  var el = document.querySelector('[data-kind="'+kind+'"][data-id="'+CSS.escape(id)+'"]');
  var zone = document.querySelector('[data-drop="'+(date || '')+'"]');
  if (el && zone) {
    var target = zone.querySelector('.pl-tray-list') || zone;
    var add = target.querySelector('.pl-add');
    target.insertBefore(el, add || null);
    el.classList.add('saving');
  }
  var path = kind === 'content' ? '/api/pipeline/content/' : '/api/pipeline/media/';
  var body = {}; body[field] = date;
  api('PATCH', path + encodeURIComponent(id), body).then(function(res){
    toast((kind === 'content' ? 'Moved to ' : 'Gather date set to ') + (date ? shortDate(date) : 'unscheduled') + '.', 'ok');
    warnAll(res.warnings);
    render();
  }).catch(function(err){
    row[field] = before;
    toast('Couldn’t move it: ' + err.message, 'err');
    render();
  });
}

// ── Board ────────────────────────────────────────────────────────────────────
function renderBoard(main) {
  var showCancelled = !!storeGet('pipeline.boardCancelled');
  // Published work older than a month is history, not pipeline.
  return loadBoardItems(showCancelled).then(function(res){
    var items = res.items, from = res.from;
    var cols = S.meta.contentStatuses.filter(function(s){ return s !== 'cancelled' || showCancelled; });
    var html = '<div class="pl-boardhead"><p class="hint">Posts publishing from '+esc(shortDate(from))+' on, plus undated ones. Drag a card to another column, or change its status on the card.</p>'
      + '<label class="check"><input type="checkbox" data-act="toggle-cancelled"'+(showCancelled ? ' checked' : '')+'> Show cancelled</label></div>'
      + '<div class="pl-board">' + cols.map(function(s){
          var list = items.filter(function(i){ return i.status === s; });
          return '<section class="pl-col" data-drop="" data-status="'+s+'"><h3>'+statusBadge(s)+' <span class="pl-count">'+list.length+'</span></h3>'
            + (list.length ? list.map(boardCard).join('') : '<p class="pl-col-empty">None</p>') + '</section>';
        }).join('') + '</div>';
    main.innerHTML = html;
  });
}

function boardCard(i) {
  S.rows.content[i.id] = i;
  return '<article class="pl-bcard" draggable="true" data-kind="content" data-id="'+esc(i.id)+'" style="--ev:'+esc(i.eventColor || 'var(--rule)')+'">'
    + '<button class="pl-bcard-open" type="button" data-act="open" data-id="'+esc(i.id)+'">'
    + '<span class="pl-title">'+recMark(i)+esc(i.title)+'</span>'
    + '<span class="pl-sub">'+esc(shortDate(i.publishDate))+(i.eventName ? ' · '+esc(i.eventName) : '')+'</span></button>'
    + '<div class="pl-bcard-foot">'+platformChips(i.platforms)+mediaProgress(i)+'</div>'
    + '<select class="pl-quick" data-act="quick-status" data-id="'+esc(i.id)+'" aria-label="Status of '+esc(i.title)+'">'
    + S.meta.contentStatuses.map(function(s){ return '<option value="'+s+'"'+(s === i.status ? ' selected' : '')+'>'+label(s)+'</option>'; }).join('')
    + '</select></article>';
}

function moveStatus(id, status) {
  var row = S.rows.content[id];
  if (!row || row.status === status) return;
  api('PATCH', '/api/pipeline/content/' + encodeURIComponent(id), { status: status }).then(function(res){
    toast('Moved “'+row.title+'” to '+label(status)+'.', 'ok');
    warnAll(res.warnings);
    render();
  }).catch(function(err){
    toast(err.message, 'err');
    render(); // puts the card and its select back
  });
}

// ── Events ───────────────────────────────────────────────────────────────────
function renderEvents(main) {
  var showArchived = !!storeGet('pipeline.eventsArchived');
  return refreshEvents().then(function(){
    var list = S.events.filter(function(e){ return showArchived || !e.archived; });
    var group = function(kind, title, hint) {
      var rows = list.filter(function(e){ return e.kind === kind; });
      return '<section class="card"><h3 class="ct">'+title+'</h3>'+(hint ? '<p class="hint pl-under">'+hint+'</p>' : '')
        + (rows.length ? '<ul class="pl-events">'+rows.map(function(e){
            return '<li><a href="#event/'+encodeURIComponent(e.id)+'"><span class="pl-swatch" style="background:'+esc(e.color)+'"></span>'
              + '<span class="pl-ev-name">'+esc(e.name)+(e.archived ? ' <span class="muted">(archived)</span>' : '')+'</span>'
              + '<span class="muted">'+esc(rangeLabel(e.startDate, e.endDate))+'</span>'
              + '<span class="pl-count">'+(e.itemCount || 0)+' post'+(e.itemCount === 1 ? '' : 's')+'</span></a></li>';
          }).join('')+'</ul>' : '<p class="empty">None yet.</p>')
        + '</section>';
    };
    main.innerHTML = '<div class="pl-boardhead"><button class="btn btn-secondary" type="button" data-act="new-event">New event or department</button>'
      + '<label class="check"><input type="checkbox" data-act="toggle-archived"'+(showArchived ? ' checked' : '')+'> Show archived</label></div>'
      + '<div id="pl-event-form"></div>'
      + group('event', 'Events', 'Dated happenings like Kids Camp or Easter.')
      + group('department', 'Departments', 'Ongoing ministries whose posts don’t belong to one date.')
      + group('series', 'Series & weekly runs', 'Created for each post series and each automated run.');
  });
}

function eventForm(e) {
  e = e || { name: '', kind: 'event', color: '', startDate: '', endDate: '', ownerEmail: '', notes: '' };
  return '<form class="card pl-form" data-form="event" data-id="'+esc(e.id || '')+'">'
    + '<h3 class="ct">'+(e.id ? 'Edit event' : 'New event or department')+'</h3>'
    + '<div class="row2"><div class="field"><label for="ef-name">Name</label><input id="ef-name" type="text" name="name" required value="'+esc(e.name)+'" placeholder="Kids Camp: GALAXY"></div>'
    + '<div class="field"><label for="ef-kind">Kind</label><select id="ef-kind" name="kind">'
    + S.meta.eventKinds.map(function(k){ return '<option value="'+k+'"'+(k === e.kind ? ' selected' : '')+'>'+label(k)+'</option>'; }).join('')+'</select></div></div>'
    + '<div class="row3"><div class="field"><label for="ef-start">Starts</label><input id="ef-start" type="date" name="startDate" value="'+esc(e.startDate || '')+'"></div>'
    + '<div class="field"><label for="ef-end">Ends</label><input id="ef-end" type="date" name="endDate" value="'+esc(e.endDate || '')+'"></div>'
    + '<div class="field"><label for="ef-color">Colour</label><input id="ef-color" type="color" name="color" value="'+esc(e.color || '#092D3E')+'"></div></div>'
    + '<div class="field"><label for="ef-owner">Owner</label><input id="ef-owner" type="email" name="ownerEmail" list="pl-people" value="'+esc(e.ownerEmail || '')+'" placeholder="Who is accountable for this event’s content"></div>'
    + '<div class="field"><label for="ef-notes">Notes, key messages and background for drafting</label><textarea id="ef-notes" name="notes">'+esc(e.notes || '')+'</textarea></div>'
    + '<div class="pl-form-msg"></div>'
    + '<div class="btn-row"><button class="btn btn-primary" type="submit">'+(e.id ? 'Save event' : 'Create event')+'</button>'
    + '<button class="btn btn-secondary" type="button" data-act="cancel-event-form">Cancel</button></div></form>';
}

function renderEvent(main, id) {
  return Promise.all([api('GET', '/api/pipeline/events/' + encodeURIComponent(id)), refreshEvents()]).then(function(res){
    var d = res[0], e = d.event;
    d.items.forEach(function(i){ S.rows.content[i.id] = i; });
    var live = d.items.filter(function(i){ return i.status !== 'cancelled'; });
    var done = d.media.filter(function(m){ return m.status === 'captured' || m.status === 'edited'; }).length;
    var html = '<p class="pl-back"><a href="#events">Events</a></p>'
      + '<section class="pl-evhead" style="--ev:'+esc(e.color)+'"><div><h2 class="pl-h2">'+esc(e.name)+(e.archived ? ' <span class="muted">(archived)</span>' : '')+'</h2>'
      + '<p class="muted">'+esc(label(e.kind))+(e.startDate || e.endDate ? ' · '+esc(rangeLabel(e.startDate, e.endDate)) : '')
      + (e.ownerEmail ? ' · Owner: '+esc(personName(e.ownerEmail)) : '')+'</p>'
      + (e.notes ? '<p class="pl-notes">'+esc(e.notes)+'</p>' : '')+'</div>'
      + '<div class="pl-evactions"><button class="btn-sm" type="button" data-act="edit-event" data-id="'+esc(e.id)+'">Edit</button>'
      + '<button class="btn-sm" type="button" data-act="duplicate-event" data-id="'+esc(e.id)+'">Duplicate</button>'
      + (e.drafting && e.drafting.source && e.drafting.source.kind === 'buzzsprout'
          ? '<button class="btn-sm btn-sm-gold" type="button" data-act="plan-episode" data-id="'+esc(e.id)+'">Plan posts from an episode</button>' : '')
      + (e.kind === 'series' ? '<button class="btn-sm btn-sm-gold" type="button" data-act="plan-series" data-id="'+esc(e.id)+'">Plan posts with Claude</button>' : '')
      + '<button class="btn-sm" type="button" data-act="archive-event" data-id="'+esc(e.id)+'" data-archived="'+(e.archived ? '1' : '')+'">'+(e.archived ? 'Restore' : 'Archive')+'</button>'
      + '<button class="btn-sm btn-sm-gold" type="button" data-act="new-post" data-event="'+esc(e.id)+'">New post for this event</button></div></section>'
      + '<div id="pl-event-form"></div>'
      + '<div class="pl-stats"><span><strong>'+live.length+'</strong> posts</span><span><strong>'+done+' of '+d.media.length+'</strong> media collected</span></div>'
      + draftingCardHtml(e);

    html += '<section class="card"><h3 class="ct">Posts</h3>'
      + (d.items.length ? '<ol class="pl-timeline">'+d.items.map(function(i){
          return '<li class="'+(i.status === 'cancelled' ? 'cancelled' : '')+'"><button class="pl-row" data-act="open" data-id="'+esc(i.id)+'" style="--ev:'+esc(e.color)+'">'
            + '<span class="pl-when">'+esc(shortDate(i.publishDate))+'</span>'
            + '<span class="pl-what"><span class="pl-title">'+esc(i.title)+'</span><span class="pl-sub">'+platformChips(i.platforms)+mediaProgress(i)+'</span></span>'
            + statusBadge(i.status)+'</button></li>';
        }).join('')+'</ol>'
        : '<p class="empty">No posts yet. <button class="btn-sm" data-act="new-post" data-event="'+esc(e.id)+'">Plan the first one</button></p>')
      + '</section>';

    html += '<section class="card"><h3 class="ct">Media to gather</h3>'
      + (d.media.length ? '<table class="pl-table"><thead><tr><th>Gather</th><th>What</th><th>Who</th><th>For post</th><th>Status</th></tr></thead><tbody>'
          + d.media.map(function(m){
              var late = m.gatherDate && m.itemPublishDate && m.gatherDate > m.itemPublishDate;
              return '<tr><td>'+(m.gatherDate ? esc(shortDate(m.gatherDate)) : '<span class="pl-gaptext">Not scheduled</span>')+(late ? ' <span class="pl-gaptext" title="After the post publishes">late</span>' : '')+'</td>'
                + '<td>'+esc(m.description)+' <span class="muted">('+esc(m.type)+')</span></td>'
                + '<td>'+(m.assigneeEmail ? esc(personName(m.assigneeEmail)) : '<span class="pl-gaptext">Nobody</span>')+'</td>'
                + '<td><button class="pl-link" data-act="open" data-id="'+esc(m.contentItemId)+'">'+esc(m.itemTitle)+'</button></td>'
                + '<td>'+statusBadge(m.status, 'media')+'</td></tr>';
            }).join('') + '</tbody></table>'
          : '<p class="empty">No media listed for this event’s posts yet. Open a post to add what it needs.</p>')
      + '</section>';
    main.innerHTML = html;
    var dform = main.querySelector('form[data-form=drafting]');
    if (dform) showDraftingFields(dform);
  });
}

// ── Planning several posts at once ───────────────────────────────────────────
function episodePlanForm(e) {
  var angles = (e.drafting && e.drafting.angles) || [];
  return '<form class="card pl-form" data-form="plan-episode" data-id="'+esc(e.id)+'">'
    + '<h3 class="ct">Plan posts from an episode</h3>'
    + '<div class="field"><label for="pe-ep">Episode</label><select id="pe-ep" name="episodeId"><option value="">Loading episodes…</option></select></div>'
    + '<fieldset class="field"><legend class="lbl">One post for each angle you tick</legend>'
    + (angles.length ? angles.map(function(a){
        return '<label class="check"><input type="checkbox" name="angles" value="'+esc(a.key)+'"'+(a.key === 'announcement' ? ' checked' : '')+'> '
          + esc(a.label)+' <span class="muted">('+(a.offsetDays ? (a.offsetDays > 0 ? '+' : '')+a.offsetDays+' days' : 'episode day')+')</span></label>';
      }).join('') : '<p class="hint">This event has no angles. Add them in its Drafting section.</p>')
    + '</fieldset><div class="pl-form-msg"></div>'
    + '<div class="btn-row"><button class="btn btn-primary" type="submit">Create posts</button>'
    + '<button class="btn btn-secondary" type="button" data-act="cancel-event-form">Cancel</button></div></form>';
}

function planRowHtml(p) {
  return '<div class="pl-plan-row">'
    + '<input type="date" data-plan="date" value="'+esc(p.date || '')+'" aria-label="Date">'
    + '<input type="text" data-plan="phase" value="'+esc(p.phase || '')+'" placeholder="Phase (optional)" aria-label="Phase">'
    + '<input type="text" data-plan="title" value="'+esc(p.title || '')+'" placeholder="Title" aria-label="Title">'
    + '<button class="pl-x" type="button" data-act="remove-plan-row" aria-label="Remove">×</button>'
    + '<input type="text" data-plan="sub" value="'+esc(p.sub || '')+'" placeholder="Angle for this post" aria-label="Angle"></div>';
}

function seriesPlanForm(e) {
  return '<form class="card pl-form" data-form="plan-series-propose" data-id="'+esc(e.id)+'">'
    + '<h3 class="ct">Plan posts with Claude</h3>'
    + '<p class="hint pl-under">Claude proposes titles and angles from this series’ notes. You edit the list before anything is saved.</p>'
    + '<div class="row3"><div class="field"><label for="ps-count">Number of posts</label><input id="ps-count" type="number" name="count" min="1" max="52" value="6"></div>'
    + '<div class="field"><label for="ps-cad">Cadence</label><select id="ps-cad" name="cadence"><option value="weekly">Weekly</option><option value="biweekly">Every other week</option><option value="monthly">Monthly</option></select></div>'
    + '<div class="field"><label for="ps-start">First post</label><input id="ps-start" type="date" name="startDate" value="'+esc(S.meta.today)+'"></div></div>'
    + '<div class="pl-form-msg"></div><div class="btn-row"><button class="btn btn-primary" type="submit">Propose a plan</button>'
    + '<button class="btn btn-secondary" type="button" data-act="cancel-event-form">Cancel</button></div></form>';
}

function showPlanRows(eventId, posts) {
  $('pl-event-form').innerHTML = '<form class="card pl-form" data-form="plan-series" data-id="'+esc(eventId)+'">'
    + '<h3 class="ct">Check the plan</h3><div id="ps-rows">'+posts.map(planRowHtml).join('')+'</div>'
    + '<button class="btn-sm" type="button" data-act="add-plan-row">Add a post</button>'
    + '<div class="pl-form-msg"></div><div class="btn-row"><button class="btn btn-primary" type="submit">Save these posts</button>'
    + '<button class="btn btn-secondary" type="button" data-act="cancel-event-form">Cancel</button></div></form>';
}

function offerDraftAll(items) {
  $('pl-event-form').innerHTML = '<div class="card"><h3 class="ct">'+items.length+' post'+(items.length === 1 ? '' : 's')+' created</h3>'
    + '<p class="hint pl-under">Draft them all now, or open each one and draft it there.</p>'
    + '<div class="btn-row"><button class="btn btn-gold" type="button" data-act="draft-all" data-ids="'+esc(items.map(function(i){ return i.id; }).join(','))+'">Draft all with Claude</button>'
    + '<button class="btn btn-secondary" type="button" data-act="cancel-event-form">Done</button></div><div id="pl-draft-all-msg"></div></div>';
}

function draftAllFor(ids, btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Drafting '+ids.length+'…';
  api('POST', '/api/pipeline/draft-all', { ids: ids }).then(function(d){
    var failed = d.results.filter(function(r){ return !r.ok; });
    btn.textContent = 'Drafted';
    $('pl-draft-all-msg').innerHTML = failed.length
      ? '<div class="alert alert-warn">'+(ids.length - failed.length)+' drafted. '+failed.length+' didn’t: '
        + esc(failed.map(function(r){ return r.error; }).join(' ')) + ' Open those posts to try again.</div>'
      : '<div class="alert alert-ok">All '+ids.length+' drafted.</div>';
    toast(failed.length ? (ids.length - failed.length) + ' drafted, ' + failed.length + ' need another try.' : 'All ' + ids.length + ' drafted.', failed.length ? 'warn' : 'ok');
  }).catch(function(e){ btn.disabled = false; btn.textContent = 'Draft all with Claude'; toast(e.message, 'err'); });
}

// ── Drafting profile (on an event) ───────────────────────────────────────────
var CUTOFF_LABELS = {
  latest: 'The newest issue',
  postDate: 'The newest issue on or before the post’s date',
  followingSunday: 'The newest issue by the Sunday after the post (Grace Notes)',
};

function angleRowHtml(a) {
  return '<div class="pl-angle-row">'
    + '<input type="text" data-angle="label" value="'+esc(a.label)+'" placeholder="Angle name" aria-label="Angle name">'
    + '<label class="pl-inline"><input type="number" data-angle="offsetDays" value="'+esc(a.offsetDays)+'" min="-30" max="60" aria-label="Days after the episode"> days after</label>'
    + '<button class="pl-x" type="button" data-act="remove-angle" aria-label="Remove angle">×</button>'
    + '<input type="hidden" data-angle="key" value="'+esc(a.key)+'">'
    + '<textarea data-angle="instructions" placeholder="What a post from this angle does" aria-label="Instructions">'+esc(a.instructions)+'</textarea></div>';
}

function draftingCardHtml(e) {
  var d = e.drafting || {}, src = d.source || { kind: 'none' };
  var opt = function(v, t, cur){ return '<option value="'+v+'"'+(v === cur ? ' selected' : '')+'>'+t+'</option>'; };
  return '<form class="card pl-drafting" data-form="drafting" data-id="'+esc(e.id)+'">'
    + '<h3 class="ct">Drafting</h3>'
    + '<p class="hint pl-under">How Draft with Claude writes this event’s posts. A recurring post or a single post can override the instructions.'
    + ' Background comes from the event’s notes'+(e.notes ? '' : ' (empty: <button class="pl-link" type="button" data-act="edit-event" data-id="'+esc(e.id)+'">add some</button>)')+'.</p>'
    + '<div class="row2"><div class="field"><label for="dr-kind">Source</label><select id="dr-kind" name="kind" data-act="dr-kind">'
    +   opt('none', 'None', src.kind) + opt('mailchimp', 'A Mailchimp newsletter', src.kind) + opt('buzzsprout', 'A podcast episode (Buzzsprout)', src.kind) + '</select></div>'
    + '<div class="field" data-dr="mailchimp"><label for="dr-subject">Campaigns whose subject contains</label>'
    +   '<input id="dr-subject" type="text" name="subjectContains" value="'+esc(src.subjectContains || '')+'" placeholder="grace notes"></div></div>'
    + '<div class="field" data-dr="mailchimp"><label for="dr-cutoff">Which issue</label><select id="dr-cutoff" name="cutoff">'
    +   ['latest', 'postDate', 'followingSunday'].map(function(c){ return opt(c, CUTOFF_LABELS[c], src.cutoff || 'latest'); }).join('') + '</select></div>'
    + '<div class="field"><label for="dr-instr">Instructions for each post</label>'
    +   '<textarea id="dr-instr" name="instructions" class="pl-instr" placeholder="What each post should do, e.g. Warm summary of what’s inside this week’s issue. End with the link.">'+esc(d.instructions || '')+'</textarea></div>'
    + '<div class="field" data-dr="buzzsprout"><span class="lbl">Angles</span><div id="dr-angles">'+(d.angles || []).map(angleRowHtml).join('')+'</div>'
    +   '<button class="btn-sm" type="button" data-act="add-angle">Add an angle</button>'
    +   '<div class="hint">Each angle becomes its own post when you plan posts from an episode.</div></div>'
    + '<div class="pl-form-msg"></div>'
    + '<div class="btn-row"><button class="btn btn-primary" type="submit">Save drafting</button></div></form>';
}

function showDraftingFields(form) {
  var kind = form.querySelector('[name=kind]').value;
  form.querySelectorAll('[data-dr]').forEach(function(el){ el.hidden = el.getAttribute('data-dr') !== kind; });
}

function readDraftingForm(form) {
  var fd = new FormData(form), kind = fd.get('kind');
  var source = kind === 'mailchimp' ? { kind: kind, subjectContains: String(fd.get('subjectContains') || '').trim(), cutoff: fd.get('cutoff') } : { kind: kind };
  var angles = Array.prototype.map.call(form.querySelectorAll('.pl-angle-row'), function(row, i){
    var g = function(k){ return row.querySelector('[data-angle='+k+']').value; };
    var label = g('label').trim();
    // New angles get a key from their name; existing ones keep theirs.
    var key = g('key') || label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || ('angle-' + (i + 1));
    return { key: /^[a-z]/.test(key) ? key : 'a-' + key, label: label, offsetDays: Number(g('offsetDays') || 0), instructions: g('instructions').trim() };
  });
  return { source: source, instructions: String(fd.get('instructions') || '').trim(), angles: kind === 'buzzsprout' ? angles : [] };
}

// ── Editor drawer ────────────────────────────────────────────────────────────
// One editor, the same wherever it's opened and whether or not the post has
// been saved yet. Before the first save, media lives only here (drawer.media)
// and is created along with the post.
var drawer = { id: null, item: null, media: [], source: null, recurrence: null, opener: null, capTab: '', sourceRef: null };
var tmpSeq = 0;

function openDrawer(html) {
  var d = $('pl-drawer');
  drawer.opener = document.activeElement;
  d.innerHTML = html;
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  $('pl-scrim').hidden = false;
  var first = d.querySelector('input,select,textarea,button');
  if (first) first.focus();
}
function closeDrawer() {
  var d = $('pl-drawer');
  d.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  $('pl-scrim').hidden = true;
  drawer.id = null;
  if (drawer.opener && drawer.opener.focus) drawer.opener.focus();
}

function newPost(defaults) {
  drawer.id = null; drawer.item = null; drawer.media = []; drawer.source = null; drawer.recurrence = null; drawer.capTab = '';
  drawer.sourceRef = null;
  var f = S.filters;
  var item = {
    title: '', eventId: defaults.eventId || f.eventId || '', platforms: f.platform ? [f.platform] : ['instagram','facebook'],
    publishDate: defaults.date || '', publishTime: '', status: 'idea', ownerEmail: f.owner || '', brief: '', caption: '',
    noMediaNeeded: false, captionMode: 'same', captions: {},
  };
  openDrawer(editorHtml(item));
  loadSourcePanel();
}

function openPost(id) {
  drawer.id = id; drawer.capTab = '';
  openDrawer('<div class="pl-drawer-body"><p class="empty">Loading…</p></div>');
  api('GET', '/api/pipeline/content/' + encodeURIComponent(id)).then(function(d){
    if (drawer.id !== id) return;
    drawer.item = d.item; drawer.media = d.media; drawer.source = d.source; drawer.recurrence = d.recurrence;
    drawer.sourceRef = d.item.sourceRef || null;
    $('pl-drawer').innerHTML = editorHtml(d.item);
    loadSourcePanel();
  }).catch(function(e){
    $('pl-drawer').innerHTML = '<div class="pl-drawer-body"><div class="alert alert-err">'+esc(e.message)+'</div><button class="btn btn-secondary" data-act="close">Close</button></div>';
  });
}

function sourceHtml(src) {
  if (!src) return '';
  if (src.kind === 'series') return '<p class="pl-source">Post '+src.postNumber+' of the “'+esc(src.seriesName)+'” series.</p>';
  var runs = { wednesday: 'Wednesday run', friday: 'Friday run', podcast: 'Podcast run' };
  return '<p class="pl-source">First drafted by the '+esc(runs[src.run] || src.run)+' on '+esc(String(src.draftedAt).slice(0, 10))+'.</p>';
}

function platformMeta(key){ return S.meta.platforms.filter(function(p){ return p.key === key; })[0]; }

// Length as the platform counts it: X charges 23 for any link.
function countChars(key, text) {
  var p = platformMeta(key), s = text || '';
  if (!p || !p.urlLength) return Array.from(s).length;
  var urls = s.match(/https?:\/\/\S+/g) || [];
  return Array.from(s.replace(/https?:\/\/\S+/g, '')).length + urls.length * p.urlLength;
}
function counterHtml(key, text) {
  var p = platformMeta(key), n = countChars(key, text);
  return '<span class="pl-count-chip'+(n > p.limit ? ' over' : '')+'" data-count="'+esc(key)+'">'+esc(p.label)+' '+n+' / '+p.limit+'</span>';
}

function editorHtml(i) {
  var m = S.meta, isNew = !drawer.id;
  var blockers = readyBlockers(i, drawer.media);
  var gatedWarning = !isNew && m.gatedStatuses.indexOf(i.status) !== -1 && blockers.length
    ? '<div class="alert alert-warn">Marked '+label(i.status)+' but still waiting on: '+esc(blockers.join('; '))+'</div>' : '';
  var separate = i.captionMode === 'separate';
  var selected = m.platforms.filter(function(p){ return i.platforms.indexOf(p.key) !== -1; });
  if (!drawer.capTab || i.platforms.indexOf(drawer.capTab) === -1) drawer.capTab = selected.length ? selected[0].key : '';
  return '<form class="pl-drawer-body" data-form="content">'
    + '<div class="pl-drawer-head"><h2>'+(isNew ? 'New post' : 'Edit post')+'</h2><button class="pl-x" type="button" data-act="close" aria-label="Close">×</button></div>'
    + sourceHtml(drawer.source) + recurrenceBanner() + gatedWarning
    + '<div class="field"><label for="pf-title">Title</label><input id="pf-title" type="text" name="title" required value="'+esc(i.title)+'" placeholder="Kids Camp: first day recap"></div>'
    + '<div class="row2"><div class="field"><label for="pf-date">Publish date</label><input id="pf-date" type="date" name="publishDate" required value="'+esc(i.publishDate || '')+'"></div>'
    + '<div class="field"><label for="pf-time">Time (optional)</label><input id="pf-time" type="time" name="publishTime" value="'+esc(i.publishTime || '')+'"></div></div>'
    + '<div class="row2"><div class="field"><label for="pf-event">Event or department</label><select id="pf-event" name="eventId">'+eventOptions(i.eventId, { blank: 'None' })+'</select></div>'
    + '<div class="field"><label for="pf-status">Status</label><select id="pf-status" name="status">'
    + m.contentStatuses.map(function(s){ return '<option value="'+s+'"'+(s === i.status ? ' selected' : '')+'>'+label(s)+'</option>'; }).join('')+'</select></div></div>'
    + '<fieldset class="field pl-plats"><legend class="lbl">Platforms</legend>'
    + m.platforms.map(function(p){
        var blocked = p.needsImage && i.noMediaNeeded;
        return '<label class="check'+(blocked ? ' is-blocked' : '')+'"><input type="checkbox" name="platforms" data-act="platform" value="'+esc(p.key)+'"'
          + (i.platforms.indexOf(p.key) !== -1 && !blocked ? ' checked' : '')+(blocked ? ' disabled' : '')+'> '+esc(p.label)+'</label>';
      }).join('')
    + '<p class="hint" data-plat-hint'+(i.noMediaNeeded ? '' : ' hidden')+'>Instagram needs an image, so it’s off for text-only posts.</p>'
    + '</fieldset>'
    + '<div class="field"><label for="pf-owner">Owner</label><input id="pf-owner" type="email" name="ownerEmail" list="pl-people" value="'+esc(i.ownerEmail)+'" placeholder="Who gets it published"></div>'
    + '<div class="field"><label for="pf-brief">Brief</label><textarea id="pf-brief" name="brief" placeholder="Purpose, angle and call to action in a sentence or two">'+esc(i.brief)+'</textarea></div>'

    + (i.phase ? '<p class="hint">Phase: '+esc(i.phase)+'</p>' : '')
    + '<section class="pl-source-panel" id="pf-source" aria-live="polite"><p class="hint">Checking where this post drafts from…</p></section>'
    + '<details class="pl-override"'+((i.drafting && (i.drafting.instructions || i.drafting.source)) ? ' open' : '')+'><summary>Drafting for this post</summary>'
    +   '<div class="field"><label for="pf-instr">Instructions</label><textarea id="pf-instr" name="draftInstructions" class="pl-instr" placeholder="Leave empty to use the event’s">'+esc((i.drafting && i.drafting.instructions) || '')+'</textarea></div>'
    +   '<label class="check"><input type="checkbox" name="draftNoSource" data-act="src-toggle"'+(i.drafting && i.drafting.source && i.drafting.source.kind === 'none' ? ' checked' : '')+'> Don’t use the event’s source for this post</label>'
    + '</details>'
    + '<div class="field pl-caption-block"><div class="pl-label-row"><span class="lbl">Caption</span>'
    + '<div class="pl-seg pl-seg-sm" role="group" aria-label="Caption per platform">'
    +   '<button type="button" data-act="cap-mode" data-mode="same" aria-pressed="'+!separate+'">Same everywhere</button>'
    +   '<button type="button" data-act="cap-mode" data-mode="separate" aria-pressed="'+separate+'">Different for each</button></div>'
    + '<button class="btn-sm" type="button" data-act="draft-caption">'+(i.caption || Object.keys(i.captions || {}).length ? 'Redraft with Claude' : 'Draft with Claude')+'</button></div>'
    + '<input type="hidden" name="captionMode" value="'+(separate ? 'separate' : 'same')+'">'
    + '<div class="pl-cap-same"'+(separate ? ' hidden' : '')+'>'
    +   '<textarea id="pf-caption" name="caption" class="pl-caption" aria-label="Caption" placeholder="Written by hand, drafted with Claude, or filled in by the weekly runs">'+esc(i.caption)+'</textarea>'
    +   '<div class="pl-counts">'+selected.map(function(p){ return counterHtml(p.key, i.caption); }).join('')+'</div></div>'
    + '<div class="pl-cap-separate"'+(separate ? '' : ' hidden')+'>'
    +   '<div class="pl-captabs" role="tablist">'+selected.map(function(p){
          return '<button type="button" role="tab" data-act="cap-tab" data-tab="'+esc(p.key)+'" aria-selected="'+(p.key === drawer.capTab)+'">'+esc(p.label)+'</button>';
        }).join('')+'</div>'
    +   m.platforms.map(function(p){
          var text = (i.captions || {})[p.key] || '';
          return '<div class="pl-cappane" role="tabpanel" data-pane="'+esc(p.key)+'"'+(p.key === drawer.capTab ? '' : ' hidden')+'>'
            + '<textarea name="caption-'+esc(p.key)+'" class="pl-caption" aria-label="'+esc(p.label)+' caption" placeholder="'+esc(p.label)+' caption">'+esc(text)+'</textarea>'
            + '<div class="pl-counts">'+counterHtml(p.key, text)+'</div></div>';
        }).join('')
    + '</div></div>'

    + '<label class="check pl-nomedia"><input type="checkbox" name="noMediaNeeded" data-act="no-media"'+(i.noMediaNeeded ? ' checked' : '')+'> No media needed (a text-only post)</label>'
    + (drawer.recurrence ? '<fieldset class="field pl-scope"><legend class="lbl">Apply changes to</legend>'
        + '<label class="check"><input type="radio" name="scope" value="this" checked> This post only</label>'
        + '<label class="check"><input type="radio" name="scope" value="future"> This and later posts in the series</label></fieldset>' : '')
    + '<div class="pl-form-msg" id="pf-msg"></div>'
    + '<div class="btn-row"><button class="btn btn-primary" type="submit">'+(isNew ? 'Create post' : 'Save changes')+'</button>'
    + '<button class="btn btn-gold" type="button" data-act="send-metricool">Send to Metricool</button>'
    + (drawer.recurrence ? '' : '<button class="btn btn-secondary" type="button" data-act="make-recurring">Make it repeat</button>')
    + '<button class="btn btn-secondary" type="button" data-act="close">'+(isNew ? 'Cancel' : 'Close')+'</button>'
    + (isNew ? '' : '<button class="btn btn-danger pl-right" type="button" data-act="delete-post">'+(drawer.recurrence ? 'Skip this date' : 'Delete post')+'</button>')
    + '</div></form>'
    + (drawer.id ? '<details class="pl-history" data-act="history"><summary>Earlier drafts</summary><div id="pf-history"><p class="hint">Loading…</p></div></details>' : '')
    + mediaSectionHtml(i);
}

function recurrenceBanner() {
  var r = drawer.recurrence;
  if (!r) return '';
  return '<p class="pl-source pl-rec-banner">↻ '+esc(r.summary)+(drawer.item && drawer.item.detached ? ' (this one has been edited on its own)' : '')
    + ' <button class="pl-link" type="button" data-act="edit-recurrence" data-id="'+esc(r.id)+'">Edit the series</button></p>';
}

function isCollected(m){ return m.status === 'captured' || m.status === 'edited'; }

function readyBlockers(item, media) {
  if (item.noMediaNeeded) return [];
  if (!media.length) return ['no media is listed yet'];
  return media.filter(function(m){ return !isCollected(m); })
    .map(function(m){ return m.description + ' (' + mediaLabel(m.status).toLowerCase() + ')'; });
}

// ── Media: one row design for every post ──
function mediaSectionHtml(item) {
  var media = drawer.media, m = S.meta;
  var done = media.filter(isCollected).length;
  var types = function(sel){ return m.mediaTypes.map(function(t){ return '<option value="'+t+'"'+(t === sel ? ' selected' : '')+'>'+label(t)+'</option>'; }).join(''); };
  var html = '<section class="pl-checklist" aria-label="Media"><div class="pl-drawer-head"><h3>Media</h3>'
    + '<span class="pl-prog">'+(media.length ? done+' of '+media.length+' collected' : item.noMediaNeeded ? 'Not needed' : 'None listed yet')+'</span></div>';
  html += media.map(function(x){
    var late = x.gatherDate && item.publishDate && x.gatherDate > item.publishDate;
    var file = x.approvalId
      ? '<div class="pl-file"><img src="/api/pipeline/approved/'+encodeURIComponent(x.approvalId)+'/image" alt="" loading="lazy">'
        + '<span><strong>'+esc(x.approvalTitle || 'Approved file')+'</strong><br><span class="muted">From Approvals</span></span>'
        + '<button class="btn-sm" type="button" data-act="clear-approval">Remove</button></div>'
      : x.fileType
      ? '<div class="pl-file">'+(x.fileType === 'image'
          ? '<img src="'+esc(x.fileLink)+'" alt="" loading="lazy">'
          : '<span class="pl-file-video" aria-hidden="true">▶</span>')
        + '<span><strong><a href="'+esc(x.fileLink)+'" target="_blank" rel="noopener">'+esc(x.fileName || 'Uploaded file')+'</a></strong><br><span class="muted">Uploaded '+(x.fileType === 'video' ? 'video' : 'photo')+'</span></span>'
        + '<button class="btn-sm" type="button" data-act="clear-file">Remove</button></div>'
      : '<div class="pl-mline pl-mline-sm pl-attach"><button class="btn-sm" type="button" data-act="pick-approval">Choose from Approvals</button>'
        + '<button class="btn-sm" type="button" data-act="upload-file">Upload a file</button>'
        + '<input type="file" data-upload hidden accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime">'
        + '<input type="url" data-mfield="fileLink" value="'+esc(x.fileLink)+'" placeholder="or paste a link (optional)" aria-label="Link to the file"></div>';
    return '<div class="pl-mrow'+(isCollected(x) ? ' is-done' : '')+'" data-media="'+esc(x.id)+'">'
      + '<div class="pl-mline"><label class="pl-collect" title="Collected"><input type="checkbox" data-mcollect'+(isCollected(x) ? ' checked' : '')+'><span>Collected</span></label>'
      + '<input type="text" data-mfield="description" value="'+esc(x.description)+'" aria-label="What to collect">'
      + '<button class="pl-x" type="button" data-act="delete-media" aria-label="Remove '+esc(x.description)+'">×</button></div>'
      + '<div class="pl-mline pl-mline-sm"><select data-mfield="type" aria-label="Type">'+types(x.type)+'</select>'
      + '<input type="date" data-mfield="gatherDate" value="'+esc(x.gatherDate || '')+'" aria-label="Gather date">'
      + '<input type="email" data-mfield="assigneeEmail" list="pl-people" value="'+esc(x.assigneeEmail)+'" placeholder="Who collects it" aria-label="Who collects it"></div>'
      + '<div class="pl-mline pl-mline-sm"><input type="text" data-mfield="gatherLocation" value="'+esc(x.gatherLocation)+'" placeholder="Where" aria-label="Location">'
      + '<input type="text" data-mfield="notes" value="'+esc(x.notes)+'" placeholder="Shot details, people, permissions" aria-label="Notes"></div>'
      + file
      + '<div class="pl-picker" hidden></div>'
      + '<p class="pl-mstatus">'+statusBadge(x.status, 'media')+(late ? ' <span class="pl-gaptext">Collected after the post publishes ('+esc(shortDate(item.publishDate))+').</span>' : '')+'</p>'
      + '</div>';
  }).join('');
  html += '<form class="pl-madd" data-form="media"><input type="text" name="description" placeholder="Add something to collect, e.g. volunteer interview at check-in" aria-label="New media" required>'
    + '<select name="type" aria-label="Type">'+types('photo')+'</select>'
    + '<input type="date" name="gatherDate" aria-label="Gather date">'
    + '<button class="btn-sm btn-sm-gold" type="submit">Add</button></form></section>';
  return html;
}

function redrawMedia() {
  var list = document.querySelector('.pl-checklist');
  if (list) list.outerHTML = mediaSectionHtml(drawer.item || readForm(document.querySelector('form[data-form=content]')));
}

function reloadDrawer() {
  if (!drawer.id) { redrawMedia(); return Promise.resolve(); }
  return api('GET', '/api/pipeline/content/' + encodeURIComponent(drawer.id)).then(function(d){
    drawer.item = d.item; drawer.media = d.media;
    // Keep unsaved edits in the post form; only the media section is redrawn.
    redrawMedia();
  });
}

// Before the post exists its media is edited in place here, following the
// same rules the server applies afterwards.
function localMediaStatus(x) {
  if (isCollected(x)) return (x.approvalId || x.fileLink) ? 'edited' : 'captured';
  return x.gatherDate ? 'scheduled' : 'needed';
}

function mediaChange(id, body) {
  if (!drawer.id) {
    var x = drawer.media.filter(function(m){ return m.id === id; })[0];
    if (!x) return;
    Object.keys(body).forEach(function(k){ x[k] = body[k]; });
    x.status = body.status || localMediaStatus(x);
    redrawMedia();
    return;
  }
  api('PATCH', '/api/pipeline/media/' + encodeURIComponent(id), body).then(function(res){
    warnAll(res.warnings);
    return reloadDrawer().then(render);
  }).catch(function(e){ toast(e.message, 'err'); reloadDrawer(); });
}

function saveMediaField(row, input) {
  var field = input.getAttribute('data-mfield'), body = {};
  body[field] = field === 'gatherDate' ? (input.value || null) : input.value;
  if (field === 'description' && !input.value.trim()) { toast('Describe what needs collecting.', 'err'); return reloadDrawer(); }
  mediaChange(row.getAttribute('data-media'), body);
}

function toggleCollected(row, checked) {
  var id = row.getAttribute('data-media');
  var x = drawer.media.filter(function(m){ return m.id === id; })[0];
  if (!x) return;
  var status = checked ? ((x.approvalId || x.fileLink) ? 'edited' : 'captured') : (x.gatherDate ? 'scheduled' : 'needed');
  mediaChange(id, { status: status });
}

function addMedia(form) {
  var fd = new FormData(form);
  var body = { description: (fd.get('description') || '').trim(), type: fd.get('type'), gatherDate: fd.get('gatherDate') || null };
  if (!body.description) return;
  if (!drawer.id) {
    var x = { id: 'tmp-' + (++tmpSeq), description: body.description, type: body.type, gatherDate: body.gatherDate,
      gatherLocation: '', assigneeEmail: '', fileLink: '', notes: '', approvalId: null, approvalTitle: '', fileName: '', fileType: '', status: 'needed' };
    x.status = localMediaStatus(x);
    drawer.media.push(x);
    redrawMedia();
    var input = document.querySelector('.pl-madd input[name=description]');
    if (input) input.focus();
    return;
  }
  api('POST', '/api/pipeline/content/' + encodeURIComponent(drawer.id) + '/media', body).then(function(res){
    warnAll(res.warnings);
    return reloadDrawer().then(function(){
      var input = document.querySelector('.pl-madd input[name=description]');
      if (input) input.focus();
      render();
    });
  }).catch(function(e){ toast(e.message, 'err'); });
}

function deleteMedia(row) {
  var id = row.getAttribute('data-media');
  if (!drawer.id) { drawer.media = drawer.media.filter(function(m){ return m.id !== id; }); redrawMedia(); return; }
  api('DELETE', '/api/pipeline/media/' + encodeURIComponent(id)).then(function(){
    return reloadDrawer().then(render);
  }).catch(function(err){ toast(err.message, 'err'); });
}

// ── Uploading a file straight to a media item ──
var UPLOAD_TYPES = { 'image/jpeg': 'image', 'image/png': 'image', 'image/gif': 'image', 'image/webp': 'image', 'video/mp4': 'video', 'video/quicktime': 'video' };
var MAX_UPLOAD = 100000000;
function uploadMediaFile(row, input) {
  var file = input.files[0];
  input.value = '';
  if (!file) return;
  if (!UPLOAD_TYPES[file.type]) { toast('Upload a photo (JPG, PNG, GIF or WebP) or a video (MP4 or MOV).', 'err'); return; }
  if (file.size > MAX_UPLOAD) { toast('That file is larger than 100 MB. Share a link to it instead.', 'err'); return; }
  var btn = row.querySelector('[data-act=upload-file]');
  btn.disabled = true; btn.innerHTML = '<span class="spin pl-spin-dark"></span> Uploading…';
  // Raw bytes, not base64: the server stores them in R2 and hands back the link.
  fetch('/api/pipeline/uploads', { method: 'POST', headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) }, body: file })
    .then(function(r){ if (!r.ok) throw new Error(r.status === 413 ? 'That file is too large to upload.' : 'The upload failed (' + r.status + '). Try again.'); return r.json(); })
    .then(function(d){
      if (!d.ok) throw new Error(d.error);
      // A file attached is the finished file.
      mediaChange(row.getAttribute('data-media'), { fileLink: d.url, fileName: d.name, fileType: d.type, status: 'edited' });
    })
    .catch(function(e){ btn.disabled = false; btn.textContent = 'Upload a file'; toast(e.message, 'err'); });
}

// ── Picking a finished file from Approvals ──
var approvedCache = null;
function openApprovalPicker(row) {
  var picker = row.querySelector('.pl-picker');
  picker.hidden = false;
  picker.innerHTML = '<p class="hint">Loading approved files…</p>';
  (approvedCache ? Promise.resolve(approvedCache) : api('GET', '/api/metricool/approved-images').then(function(d){ approvedCache = d.images || []; return approvedCache; }))
    .then(function(images){
      if (!images.length) { picker.innerHTML = '<p class="hint">Nothing has been approved yet. Files appear here once they’re signed off in Approvals.</p>'; return; }
      picker.innerHTML = '<div class="pl-picker-head"><span class="lbl">Approved files</span><button class="pl-x" type="button" data-act="close-picker" aria-label="Close">×</button></div>'
        + '<div class="pl-picker-grid">' + images.map(function(img){
          return '<button type="button" class="pl-pick" data-act="choose-approval" data-approval="'+esc(img.id)+'" data-title="'+esc(img.title)+'">'
            + '<img src="/api/pipeline/approved/'+encodeURIComponent(img.id)+'/image" alt="" loading="lazy"><span>'+esc(img.title)+'</span></button>';
        }).join('') + '</div>';
    })
    .catch(function(e){ picker.innerHTML = '<p class="pl-gaptext">Couldn’t reach Approvals: '+esc(e.message)+'</p>'; });
}

// ── Reading and saving the post ──
function readForm(form) {
  var fd = new FormData(form), out = {};
  out.title = (fd.get('title') || '').trim();
  out.publishDate = fd.get('publishDate') || '';
  out.publishTime = fd.get('publishTime') || '';
  out.eventId = fd.get('eventId') || '';
  out.status = fd.get('status');
  out.platforms = fd.getAll('platforms');
  out.ownerEmail = (fd.get('ownerEmail') || '').trim();
  out.brief = fd.get('brief') || '';
  out.caption = fd.get('caption') || '';
  out.noMediaNeeded = fd.get('noMediaNeeded') === 'on';
  out.captionMode = fd.get('captionMode') === 'separate' ? 'separate' : 'same';
  out.captions = {};
  S.meta.platforms.forEach(function(p){ var v = (fd.get('caption-' + p.key) || '').trim(); if (v) out.captions[p.key] = v; });
  var instr = (fd.get('draftInstructions') || '').trim(), noSource = fd.get('draftNoSource') === 'on';
  out.drafting = {};
  if (instr) out.drafting.instructions = instr;
  if (noSource) out.drafting.source = { kind: 'none' };
  out.sourceRef = drawer.sourceRef;
  out.phase = drawer.item ? drawer.item.phase || '' : '';
  return out;
}
function formScope(form) {
  var r = form.querySelector('input[name=scope]:checked');
  return r ? r.value : 'this';
}

// Compare form values with what was loaded. Objects are compared with their
// keys sorted: the database hands jsonb keys back in its own order, and a
// difference in order alone must not count as an edit.
function canonical(v) {
  return JSON.stringify(v == null ? null : v, function(_k, x){
    if (!x || typeof x !== 'object' || Array.isArray(x)) return x;
    var out = {}; Object.keys(x).sort().forEach(function(k){ out[k] = x[k]; }); return out;
  });
}
function sameValue(a, b) {
  if (a && typeof a === 'object') return canonical(a) === canonical(b);
  if (a == null) return b == null;
  return a === (b == null ? '' : b);
}

// Resolves with the saved post (creating it first if it's new), or rejects
// with a message already shown in the editor.
function savePost(form, opts) {
  opts = opts || {};
  var body = readForm(form), msg = $('pf-msg'), btn = form.querySelector('[type=submit]');
  msg.innerHTML = '';
  var bad = !body.title ? 'Give the post a title.' : !body.publishDate ? 'Pick a publish date.' : '';
  if (bad) { msg.innerHTML = '<div class="alert alert-err">'+bad+'</div>'; return Promise.reject(new Error(bad)); }
  btn.disabled = true;
  var req;
  if (drawer.id) {
    // Send only what changed, so a status change is judged on its own.
    var cur = drawer.item, patch = {};
    Object.keys(body).forEach(function(k){ if (!sameValue(body[k], cur[k])) patch[k] = body[k]; });
    if (!Object.keys(patch).length) { btn.disabled = false; return Promise.resolve({ item: cur, unchanged: true }); }
    patch.scope = formScope(form);
    req = api('PATCH', '/api/pipeline/content/' + encodeURIComponent(drawer.id), patch);
  } else {
    req = api('POST', '/api/pipeline/content', body).then(function(res){
      // The media listed before the post existed goes in with it.
      var pending = drawer.media.slice();
      drawer.id = res.item.id;
      return pending.reduce(function(chain, x){
        return chain.then(function(){
          return api('POST', '/api/pipeline/content/' + encodeURIComponent(res.item.id) + '/media', {
            description: x.description, type: x.type, gatherDate: x.gatherDate, gatherLocation: x.gatherLocation,
            assigneeEmail: x.assigneeEmail, fileLink: x.fileLink, notes: x.notes,
            approvalId: x.approvalId, approvalTitle: x.approvalTitle, fileName: x.fileName, fileType: x.fileType, status: x.status,
          });
        });
      }, Promise.resolve()).then(function(){ return res; });
    });
  }
  return req.then(function(res){
    btn.disabled = false;
    warnAll(res.warnings);
    if (!opts.quiet) toast(formScope(form) === 'future' ? 'Saved, and applied to later posts in the series.' : 'Saved.', 'ok');
    render();
    return res;
  }, function(e){
    btn.disabled = false;
    msg.innerHTML = '<div class="alert alert-err">'+esc(e.message)+'</div>';
    throw e;
  });
}

function saveContent(form) {
  var wasNew = !drawer.id;
  savePost(form).then(function(res){
    if (wasNew) openPost(res.item.id); else closeDrawer();
  }).catch(function(){ /* shown in the editor */ });
}

// ── Caption controls ──
function setCaptionMode(mode) {
  var form = document.querySelector('form[data-form=content]');
  var cur = readForm(form);
  form.querySelector('[name=captionMode]').value = mode;
  // Carry the text across so switching never loses work.
  if (mode === 'separate') {
    cur.platforms.forEach(function(k){
      var box = form.querySelector('[name="caption-' + k + '"]');
      if (box && !box.value.trim()) box.value = cur.caption;
    });
  } else if (!cur.caption.trim()) {
    var first = cur.platforms.map(function(k){ return cur.captions[k]; }).filter(Boolean)[0];
    if (first) form.querySelector('[name=caption]').value = first;
  }
  refreshCaptionUi();
}

function refreshCaptionUi() {
  var form = document.querySelector('form[data-form=content]');
  if (!form) return;
  var cur = readForm(form), separate = cur.captionMode === 'separate';
  form.querySelectorAll('[data-act=cap-mode]').forEach(function(b){ b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === cur.captionMode)); });
  form.querySelector('.pl-cap-same').hidden = separate;
  form.querySelector('.pl-cap-separate').hidden = !separate;
  if (cur.platforms.indexOf(drawer.capTab) === -1) drawer.capTab = cur.platforms[0] || '';
  form.querySelector('.pl-captabs').innerHTML = S.meta.platforms.filter(function(p){ return cur.platforms.indexOf(p.key) !== -1; }).map(function(p){
    return '<button type="button" role="tab" data-act="cap-tab" data-tab="'+esc(p.key)+'" aria-selected="'+(p.key === drawer.capTab)+'">'+esc(p.label)+'</button>';
  }).join('') || '<p class="hint">Pick a platform above.</p>';
  form.querySelectorAll('[data-pane]').forEach(function(pane){ pane.hidden = pane.getAttribute('data-pane') !== drawer.capTab; });
  form.querySelector('.pl-cap-same .pl-counts').innerHTML = cur.platforms.map(function(k){ return counterHtml(k, cur.caption); }).join('');
  form.querySelectorAll('[data-pane]').forEach(function(pane){
    var k = pane.getAttribute('data-pane');
    pane.querySelector('.pl-counts').innerHTML = counterHtml(k, cur.captions[k] || '');
  });
}

// Instagram won't take a post without an image: a text-only post can't go
// there. Shared by the post editor and the recurring-post form.
function applyImageRuleTo(form, changed) {
  var noMedia = form.querySelector('[name=noMediaNeeded]').checked;
  S.meta.platforms.forEach(function(p){
    if (!p.needsImage) return;
    var box = form.querySelector('[name=platforms][value="' + p.key + '"]');
    if (noMedia && box.checked && changed === 'no-media') toast(p.label + ' needs an image, so it’s been unticked.', 'warn');
    if (noMedia) box.checked = false;
    box.disabled = noMedia;
    box.closest('label').classList.toggle('is-blocked', noMedia);
  });
  var hint = form.querySelector('[data-plat-hint]');
  if (hint) hint.hidden = !noMedia;
}
function applyImageRule(changed) {
  applyImageRuleTo(document.querySelector('form[data-form=content]'), changed);
  refreshCaptionUi();
}

// ── Source panel: what Draft with Claude will work from ──
var sourceTimer;
function loadSourcePanel() {
  clearTimeout(sourceTimer);
  sourceTimer = setTimeout(function(){
    var form = document.querySelector('form[data-form=content]'), panel = $('pf-source');
    if (!form || !panel) return;
    var body = readForm(form); body.contentItemId = drawer.id;
    api('POST', '/api/pipeline/source/preview', body).then(function(res){
      drawer.preview = res;
      panel.innerHTML = sourcePanelHtml(res);
      panel.hidden = !panel.innerHTML;
    }).catch(function(e){ panel.innerHTML = '<div class="alert alert-err">'+esc(e.message)+'</div>'; });
  }, 250);
}

function sourcePanelHtml(res) {
  var eff = res.effective, s = res.source, ref = drawer.sourceRef;
  var paste = '<button class="btn-sm" type="button" data-act="src-paste">Paste content instead</button>';
  var reset = ref ? ' <button class="pl-link" type="button" data-act="src-reset">Use the event’s choice</button>' : '';
  if (res.error) {
    return '<div class="alert alert-warn">Couldn’t reach the source: '+esc(res.error)+' <a href="#settings">Settings</a></div>' + paste;
  }
  var kind = ref ? ref.kind : (eff ? eff.source.kind : 'none');
  if (kind === 'none') return '';
  var head = '<div class="pl-label-row"><span class="lbl">Drafts from</span>'
    + '<span>'+(kind !== 'manual' ? '<button class="btn-sm" type="button" data-act="src-change" data-kind="'+kind+'">Change</button> ' : '')+paste+'</span></div>';
  if (kind === 'buzzsprout' && !s) return head + '<p class="pl-gaptext">Pick the episode this post is about.</p><div id="pf-src-list"></div>';
  if (!s) return head + '<p class="hint">Nothing found to draft from.</p>' + reset;
  var marks = (s.isDraft ? ' <span class="pl-status pl-s-drafted">Not sent yet</span>' : '')
    + (s.notYetPublic ? ' <span class="pl-status pl-s-drafted">Not out yet</span>' : '');
  return head
    + '<p class="pl-src-title"><strong>'+esc(s.title)+'</strong>'+marks+'</p>'
    + (s.dateLine ? '<p class="hint">'+esc(s.dateLine)+'</p>' : '')
    + (s.url ? '<p class="hint"><a href="'+esc(s.url)+'" target="_blank" rel="noopener">'+esc(s.url)+'</a></p>' : '')
    + (s.excerpt ? '<p class="pl-src-excerpt">'+esc(s.excerpt)+'…</p>' : '')
    + (ref ? '<p class="hint">Picked for this post.'+reset+'</p>' : '')
    + '<div id="pf-src-list"></div>';
}

function showSourceChoices(kind) {
  var list = $('pf-src-list');
  list.innerHTML = '<p class="hint">Loading…</p>';
  var eff = drawer.preview && drawer.preview.effective;
  var req = kind === 'buzzsprout'
    ? api('GET', '/api/pipeline/sources/episodes').then(function(d){
        return d.episodes.map(function(ep){
          return { ref: { kind: 'buzzsprout', id: String(ep.id), title: ep.title, url: ep.listenUrl, date: ep.publishDate },
                   label: ep.label + (ep.isPublished ? '' : ' (not out yet)') };
        });
      })
    : api('GET', '/api/pipeline/sources/campaigns?subject=' + encodeURIComponent(eff.source.subjectContains || '')).then(function(d){
        return d.campaigns.map(function(c){
          return { ref: { kind: 'mailchimp', id: c.id, title: c.subject, url: c.archiveUrl, date: c.issueDate },
                   label: c.subject + (c.isDraft ? ' (not sent)' : '') + (c.dateLine ? ' — ' + c.dateLine : '') };
        });
      });
  req.then(function(rows){
    drawer.sourceChoices = rows;
    list.innerHTML = rows.length
      ? '<ul class="pl-src-choices">' + rows.map(function(r, i){
          return '<li><button type="button" class="pl-link" data-act="src-pick" data-i="'+i+'">'+esc(r.label)+'</button></li>';
        }).join('') + '</ul>'
      : '<p class="hint">Nothing to choose from.</p>';
  }).catch(function(e){ list.innerHTML = '<p class="pl-gaptext">'+esc(e.message)+'</p>'; });
}

function loadHistory() {
  var box = $('pf-history');
  api('GET', '/api/pipeline/content/' + encodeURIComponent(drawer.id) + '/drafts').then(function(d){
    drawer.history = d.drafts;
    box.innerHTML = d.drafts.length
      ? '<ul class="pl-history-list">' + d.drafts.map(function(h, i){
          var first = (h.captionMode === 'separate' ? (h.captions.instagram || h.captions.facebook || h.captions.x || '') : h.caption).split('\n')[0];
          return '<li><span class="hint">'+esc(new Date(h.at).toLocaleString())+' · '+(h.origin === 'run' ? 'weekly run' : 'Claude')
            + (h.captionMode === 'separate' ? ' · per platform' : '')+'</span><span class="pl-history-text">'+esc(first)+'</span>'
            + '<button class="btn-sm" type="button" data-act="restore-draft" data-i="'+i+'">Restore</button></li>';
        }).join('') + '</ul>'
      : '<p class="hint">No earlier drafts yet.</p>';
  }).catch(function(e){ box.innerHTML = '<p class="pl-gaptext">'+esc(e.message)+'</p>'; });
}

function draftCaption(btn) {
  var form = document.querySelector('form[data-form=content]');
  btn.disabled = true;
  var was = btn.textContent;
  btn.innerHTML = '<span class="spin pl-spin-dark"></span> Drafting…';
  var req = readForm(form); req.contentItemId = drawer.id;
  api('POST', '/api/pipeline/draft-caption', req).then(function(res){
    btn.disabled = false; btn.textContent = 'Redraft with Claude';
    if (res.captions) {
      Object.keys(res.captions).forEach(function(k){
        var box = form.querySelector('[name="caption-' + k + '"]');
        if (box) box.value = res.captions[k];
      });
    } else {
      form.querySelector('[name=caption]').value = res.caption;
    }
    refreshCaptionUi();
    if (res.source && res.source.kind !== 'manual') {
      drawer.sourceRef = { kind: res.source.kind, id: res.source.id, title: res.source.title, url: res.source.url, date: res.source.date };
    }
    if ($('pf-history') && $('pf-history').closest('details').open) loadHistory();
    if (res.warnings && res.warnings.length) toast(res.warnings.join(' '), 'warn');
    else toast(res.captions ? 'Drafted for each platform. Review them, then save.' : 'Draft ready. Edit it if you like, then save.', 'ok');
  }).catch(function(e){
    btn.disabled = false; btn.textContent = was;
    $('pf-msg').innerHTML = '<div class="alert alert-err">'+esc(e.message)+'</div>';
  });
}

// Metricool calls X "twitter".
var METRICOOL_NETWORK = { instagram: 'instagram', facebook: 'facebook', x: 'twitter' };

function sendToMetricool() {
  var form = document.querySelector('form[data-form=content]');
  var cur = readForm(form);
  var texts = null;
  if (cur.captionMode === 'separate') {
    texts = {};
    var missing = cur.platforms.filter(function(k){ return !cur.captions[k]; });
    if (missing.length) {
      $('pf-msg').innerHTML = '<div class="alert alert-err">Write a caption for '+esc(missing.map(function(k){ return platformMeta(k).label; }).join(' and '))+' first.</div>';
      return;
    }
    cur.platforms.forEach(function(k){ texts[METRICOOL_NETWORK[k]] = cur.captions[k]; });
  } else if (!cur.caption.trim()) {
    $('pf-msg').innerHTML = '<div class="alert alert-err">Write or draft a caption first.</div>'; return;
  }
  var blockers = readyBlockers(cur, drawer.media);
  if (blockers.length && !confirm('Still waiting on: ' + blockers.join('; ') + '.\n\nSend to Metricool anyway?')) return;
  // Sending needs a saved post to mark as Scheduled afterwards.
  savePost(form, { quiet: true }).then(function(res){
    var id = res.item.id;
    var approved = drawer.media.filter(function(m){ return m.approvalId; })[0];
    var uploaded = drawer.media.filter(function(m){ return m.fileType === 'image' && m.fileLink; })[0];
    openMetricool(cur.caption, {
      date: cur.publishDate, time: cur.publishTime, texts: texts,
      networks: cur.platforms.map(function(p){ return METRICOOL_NETWORK[p]; }).filter(Boolean),
      approvedImageId: approved ? approved.approvalId : '',
      imageUrl: !approved && uploaded ? uploaded.fileLink : '',
      sourceType: 'content', sourceRef: id, contentItemId: id,
      // The server marks the post Scheduled; show that.
      onSent: function(){ openPost(id); render(); },
    });
  }).catch(function(){ /* shown in the editor */ });
}

// "Make it repeat" from any one-off post: this post becomes the first in the series.
function makeRecurring(form) {
  var cur = readForm(form);
  cur.mediaTemplate = drawer.media.map(function(x){
    var offset = x.gatherDate && cur.publishDate
      ? Math.round((parseIso(x.gatherDate) - parseIso(cur.publishDate)) / 86400000) : 0;
    return { description: x.description, type: x.type, offsetDays: offset, assigneeEmail: x.assigneeEmail };
  });
  openRecurrence(null, cur, drawer.id);
}

// ── Recurring posts ──────────────────────────────────────────────────────────
var WEEKDAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function renderRecurring(main) {
  return api('GET', '/api/pipeline/recurrences').then(function(d){
    var list = d.recurrences;
    var html = '<div class="pl-boardhead"><p class="hint">Each recurring post keeps its next '+Math.round(S.meta.recurrenceHorizonDays / 7)+' weeks on the calendar as ordinary posts you can plan, give media and send. Skip a date by opening that post.</p>'
      + '<button class="btn btn-primary" type="button" data-act="new-recurrence">New recurring post</button></div>';
    if (!list.length) {
      main.innerHTML = html + '<p class="empty">Nothing repeats yet. Set one up for anything you post on a rhythm: a weekly devotional, a monthly volunteer thank-you.</p>';
      return;
    }
    html += '<section class="card"><ul class="pl-recs">' + list.map(function(r){
      return '<li class="'+(r.active ? '' : 'paused')+'" style="--ev:'+esc(r.eventColor || 'var(--rule)')+'">'
        + '<button class="pl-rec-open" type="button" data-act="edit-recurrence" data-id="'+esc(r.id)+'">'
        + '<span class="pl-title">'+esc(r.title)+(r.active ? '' : ' <span class="muted">(paused)</span>')+'</span>'
        + '<span class="pl-sub">'+esc(r.summary)+(r.eventName ? ' · '+esc(r.eventName) : '')+' '+platformChips(r.platforms)+'</span>'
        + (r.nextDates.length ? '<span class="pl-sub">Next: '+r.nextDates.map(shortDate).map(esc).join(', ')+'</span>' : '')
        + '</button>'
        + '<button class="btn-sm" type="button" data-act="toggle-recurrence" data-id="'+esc(r.id)+'" data-active="'+(r.active ? '1' : '')+'">'+(r.active ? 'Pause' : 'Resume')+'</button>'
        + '</li>';
    }).join('') + '</ul></section>';
    main.innerHTML = html;
  });
}

function tplRowHtml(m) {
  var before = -(m.offsetDays || 0);
  return '<div class="pl-tpl-row">'
    + '<input type="text" data-tpl="description" value="'+esc(m.description)+'" placeholder="What to capture each time" aria-label="What to capture">'
    + '<select data-tpl="type" aria-label="Type">'+S.meta.mediaTypes.map(function(t){ return '<option value="'+t+'"'+(t === m.type ? ' selected' : '')+'>'+label(t)+'</option>'; }).join('')+'</select>'
    + '<label class="pl-inline"><input type="number" data-tpl="before" min="-30" max="90" value="'+before+'" aria-label="Days before the post"> days before</label>'
    + '<input type="email" data-tpl="assigneeEmail" list="pl-people" value="'+esc(m.assigneeEmail || '')+'" placeholder="Who" aria-label="Who captures it">'
    + '<button class="pl-x" type="button" data-act="remove-tpl-row" aria-label="Remove">×</button></div>';
}

function openRecurrence(id, prefill, fromContentId) {
  var load = id ? api('GET', '/api/pipeline/recurrences/' + encodeURIComponent(id)).then(function(d){ return d.recurrence; })
                : Promise.resolve(null);
  openDrawer('<div class="pl-drawer-body"><p class="empty">Loading…</p></div>');
  load.then(function(r){
    $('pl-drawer').innerHTML = recurrenceFormHtml(r, prefill || {}, fromContentId);
    applyImageRuleTo(document.querySelector('form[data-form=recurrence]'));
    previewRule();
  })
    .catch(function(e){ $('pl-drawer').innerHTML = '<div class="pl-drawer-body"><div class="alert alert-err">'+esc(e.message)+'</div></div>'; });
}

function recurrenceFormHtml(r, pre, fromContentId) {
  var start = pre.publishDate || S.meta.today, startDow = parseIso(start).getDay();
  var rule = r ? r.rule : { freq: 'weekly', interval: 1, weekdays: [startDow], monthDay: parseIso(start).getDate(),
    nth: Math.min(4, Math.ceil(parseIso(start).getDate() / 7)), weekday: startDow, startDate: start, endDate: null, count: null };
  var v = r || { title: pre.title || '', brief: pre.brief || '', eventId: pre.eventId || '', platforms: pre.platforms || ['instagram','facebook'],
    publishTime: pre.publishTime || '', ownerEmail: pre.ownerEmail || '', noMediaNeeded: !!pre.noMediaNeeded,
    mediaTemplate: pre.mediaTemplate || [], active: true };
  var ends = rule.endDate ? 'on' : rule.count ? 'after' : 'never';
  var opt = function(val, text, cur){ return '<option value="'+val+'"'+(String(val) === String(cur) ? ' selected' : '')+'>'+text+'</option>'; };
  return '<form class="pl-drawer-body" data-form="recurrence" data-id="'+esc(r ? r.id : '')+'" data-from="'+esc(fromContentId || '')+'"'
    // The form edits only the instructions; an override's source rides along untouched.
    + ' data-source="'+esc(JSON.stringify((r && r.drafting && r.drafting.source) || null))+'">'
    + (fromContentId ? '<p class="pl-source">This post becomes the first in the series, on its own date.</p>' : '')
    + '<div class="pl-drawer-head"><h2>'+(r ? 'Recurring post' : 'New recurring post')+'</h2><button class="pl-x" type="button" data-act="close" aria-label="Close">×</button></div>'
    + (r && r.draftKey ? '<p class="pl-source">The weekly run fills each of these with its draft.</p>' : '')
    + '<div class="field"><label for="rf-title">Title</label><input id="rf-title" type="text" name="title" required value="'+esc(v.title)+'" placeholder="Midweek devotional"></div>'

    + '<fieldset class="pl-repeat" data-rule><legend class="lbl">Repeats</legend>'
    + '<div class="row2"><div class="field"><label for="rf-freq">How often</label><select id="rf-freq" name="freq" data-act="rec-freq">'
    +   opt('weekly', 'Weekly', rule.freq) + opt('monthly_date', 'Monthly on a date', rule.freq) + opt('monthly_weekday', 'Monthly on a weekday', rule.freq) + '</select></div>'
    + '<div class="field"><label for="rf-every">Every</label><div class="pl-inline"><input id="rf-every" type="number" name="interval" min="1" max="52" value="'+rule.interval+'">'
    +   ' <span data-unit>'+(rule.freq === 'weekly' ? 'week(s)' : 'month(s)')+'</span></div></div></div>'
    + '<div class="field" data-freq="weekly"><span class="lbl">On</span><div class="pl-days">'
    +   WEEKDAY_NAMES.map(function(n, i){ return '<label class="pl-day-pick"><input type="checkbox" name="weekdays" value="'+i+'"'+(rule.weekdays.indexOf(i) !== -1 ? ' checked' : '')+'><span>'+n.slice(0,3)+'</span></label>'; }).join('')
    + '</div></div>'
    + '<div class="field" data-freq="monthly_date"><label for="rf-mday">Day of the month</label><input id="rf-mday" type="number" name="monthDay" min="1" max="31" value="'+(rule.monthDay || 1)+'">'
    +   '<div class="hint">Months without that day use their last day.</div></div>'
    + '<div class="row2" data-freq="monthly_weekday"><div class="field"><label for="rf-nth">Which</label><select id="rf-nth" name="nth">'
    +   opt(1, '1st', rule.nth) + opt(2, '2nd', rule.nth) + opt(3, '3rd', rule.nth) + opt(4, '4th', rule.nth) + opt(-1, 'Last', rule.nth) + '</select></div>'
    + '<div class="field"><label for="rf-wday">Day</label><select id="rf-wday" name="weekday">'+WEEKDAY_NAMES.map(function(n, i){ return opt(i, n, rule.weekday); }).join('')+'</select></div></div>'
    + '<div class="row2"><div class="field"><label for="rf-start">Starts</label><input id="rf-start" type="date" name="startDate" value="'+esc(rule.startDate)+'" required></div>'
    + '<div class="field"><label for="rf-ends">Ends</label><select id="rf-ends" name="ends" data-act="rec-ends">'
    +   opt('never', 'Never', ends) + opt('on', 'On a date', ends) + opt('after', 'After a number of posts', ends) + '</select></div></div>'
    + '<div class="field" data-ends="on"><label for="rf-end">Last date</label><input id="rf-end" type="date" name="endDate" value="'+esc(rule.endDate || '')+'"></div>'
    + '<div class="field" data-ends="after"><label for="rf-count">Number of posts</label><input id="rf-count" type="number" name="count" min="1" max="520" value="'+(rule.count || 6)+'"></div>'
    + '<p class="pl-preview" id="rf-preview" aria-live="polite"></p>'
    + '</fieldset>'

    + '<div class="row2"><div class="field"><label for="rf-event">Event or department</label><select id="rf-event" name="eventId">'+eventOptions(v.eventId, { blank: 'None' })+'</select></div>'
    + '<div class="field"><label for="rf-time">Time (optional)</label><input id="rf-time" type="time" name="publishTime" value="'+esc(v.publishTime || '')+'"></div></div>'
    + '<fieldset class="field pl-plats"><legend class="lbl">Platforms</legend>'
    + S.meta.platforms.map(function(p){ return '<label class="check"><input type="checkbox" name="platforms" data-act="platform" value="'+esc(p.key)+'"'+(v.platforms.indexOf(p.key) !== -1 ? ' checked' : '')+'> '+esc(p.label)+'</label>'; }).join('')
    + '<p class="hint" data-plat-hint hidden>Instagram needs an image, so it’s off for text-only posts.</p>'
    + '</fieldset>'
    + '<div class="field"><label for="rf-owner">Owner</label><input id="rf-owner" type="email" name="ownerEmail" list="pl-people" value="'+esc(v.ownerEmail)+'" placeholder="Who gets each one published"></div>'
    + '<div class="field"><label for="rf-brief">Brief</label><textarea id="rf-brief" name="brief" placeholder="What each post is for">'+esc(v.brief)+'</textarea></div>'
    + '<div class="field"><label for="rf-instr">Drafting instructions for each post</label>'
    +   '<textarea id="rf-instr" name="draftInstructions" class="pl-instr" placeholder="Leave empty to use the event’s">'+esc((r && r.drafting && r.drafting.instructions) || (pre.drafting && pre.drafting.instructions) || '')+'</textarea>'
    +   '<div class="hint">For posts that need different drafting from the rest of their event, like the Saturday invite.</div></div>'
    + '<div class="field"><span class="lbl">Media each time</span><div id="rf-tpl">'+(v.mediaTemplate || []).map(tplRowHtml).join('')+'</div>'
    +   '<button class="btn-sm" type="button" data-act="add-tpl-row">Add something to capture</button>'
    +   (r ? '<div class="hint">Changes reach upcoming posts nobody has started on. Media someone added or already collected stays.</div>' : '')+'</div>'
    + '<label class="check pl-nomedia"><input type="checkbox" name="noMediaNeeded" data-act="no-media"'+(v.noMediaNeeded ? ' checked' : '')+'> No media needed (text-only posts)</label>'
    + '<div class="pl-form-msg" id="rf-msg"></div>'
    + '<div class="btn-row"><button class="btn btn-primary" type="submit">'+(r ? 'Save series' : 'Create recurring post')+'</button>'
    + '<button class="btn btn-secondary" type="button" data-act="close">Cancel</button>'
    + (r ? '<button class="btn btn-danger pl-right" type="button" data-act="delete-recurrence" data-id="'+esc(r.id)+'">End series</button>' : '')+'</div>'
    + '</form>';
}

function showFreqFields(freq) {
  document.querySelectorAll('form[data-form=recurrence] [data-freq]').forEach(function(el){ el.hidden = el.getAttribute('data-freq') !== freq; });
  var unit = document.querySelector('form[data-form=recurrence] [data-unit]');
  if (unit) unit.textContent = freq === 'weekly' ? 'week(s)' : 'month(s)';
}
function showEndFields(ends) {
  document.querySelectorAll('form[data-form=recurrence] [data-ends]').forEach(function(el){ el.hidden = el.getAttribute('data-ends') !== ends; });
}

function readRule(form) {
  var fd = new FormData(form), ends = fd.get('ends');
  return {
    freq: fd.get('freq'), interval: Number(fd.get('interval') || 1),
    weekdays: fd.getAll('weekdays').map(Number), monthDay: Number(fd.get('monthDay')),
    nth: Number(fd.get('nth')), weekday: Number(fd.get('weekday')), startDate: fd.get('startDate'),
    endDate: ends === 'on' ? (fd.get('endDate') || null) : null,
    count: ends === 'after' ? Number(fd.get('count')) : null,
  };
}

var previewTimer;
function previewRule() {
  var form = document.querySelector('form[data-form=recurrence]');
  if (!form) return;
  showFreqFields(form.querySelector('[name=freq]').value);
  showEndFields(form.querySelector('[name=ends]').value);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(function(){
    api('POST', '/api/pipeline/recurrences/preview', { rule: readRule(form) }).then(function(d){
      $('rf-preview').innerHTML = '<strong>'+esc(d.summary)+'.</strong> '
        + (d.dates.length ? 'Next: ' + d.dates.map(shortDate).map(esc).join(', ') : 'No dates from today on.');
      $('rf-preview').className = 'pl-preview';
    }).catch(function(e){
      $('rf-preview').textContent = e.message;
      $('rf-preview').className = 'pl-preview pl-gaptext';
    });
  }, 250);
}

function saveRecurrence(form) {
  var fd = new FormData(form), id = form.getAttribute('data-id'), msg = $('rf-msg');
  var body = {
    title: (fd.get('title') || '').trim(), brief: fd.get('brief') || '', eventId: fd.get('eventId') || null,
    platforms: fd.getAll('platforms'), publishTime: fd.get('publishTime') || null,
    ownerEmail: (fd.get('ownerEmail') || '').trim(), noMediaNeeded: fd.get('noMediaNeeded') === 'on',
    rule: readRule(form), fromContentId: form.getAttribute('data-from') || undefined,
    drafting: (function(){
      var d = { instructions: (fd.get('draftInstructions') || '').trim() };
      var src = JSON.parse(form.getAttribute('data-source') || 'null');
      if (src) d.source = src;
      return d;
    })(),
    mediaTemplate: Array.prototype.map.call(form.querySelectorAll('.pl-tpl-row'), function(row){
      var g = function(k){ return row.querySelector('[data-tpl='+k+']').value; };
      return { description: g('description').trim(), type: g('type'), offsetDays: -Number(g('before') || 0), assigneeEmail: g('assigneeEmail').trim() };
    }).filter(function(m){ return m.description; }),
  };
  msg.innerHTML = '';
  var btn = form.querySelector('[type=submit]'); btn.disabled = true;
  (id ? api('PATCH', '/api/pipeline/recurrences/' + encodeURIComponent(id), body) : api('POST', '/api/pipeline/recurrences', body))
    .then(function(d){
      var next = d.recurrence.nextDates;
      toast((id ? 'Series saved. ' : 'Recurring post created. ') + (next.length ? 'Next one: ' + shortDate(next[0]) + '.' : ''), 'ok');
      closeDrawer(); render();
    }).catch(function(e){ btn.disabled = false; msg.innerHTML = '<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

function toggleRecurrence(id, active) {
  api('PATCH', '/api/pipeline/recurrences/' + encodeURIComponent(id), { active: active }).then(function(){
    toast(active ? 'Resumed. Upcoming posts are back on the calendar.' : 'Paused. Upcoming posts nobody had started are off the calendar.', 'ok');
    render();
  }).catch(function(e){ toast(e.message, 'err'); });
}

function deleteRecurrence(id) {
  if (!confirm('End this series? Upcoming posts nobody has started on are removed. Anything already worked on, and everything in the past, stays.')) return;
  api('DELETE', '/api/pipeline/recurrences/' + encodeURIComponent(id)).then(function(d){
    toast('Series ended. ' + d.removed + ' upcoming post' + (d.removed === 1 ? '' : 's') + ' removed.', 'ok');
    closeDrawer(); render();
  }).catch(function(e){ toast(e.message, 'err'); });
}

// ── Duplicate an event ───────────────────────────────────────────────────────
function duplicateForm(e) {
  var year = /(\d{4})/.exec(e.name);
  var name = year ? e.name.replace(year[1], String(Number(year[1]) + 1)) : e.name + ' (copy)';
  var nextStart = e.startDate ? addDays(e.startDate, 364) : '';
  return '<form class="card pl-form" data-form="duplicate" data-id="'+esc(e.id)+'">'
    + '<h3 class="ct">Duplicate “'+esc(e.name)+'”</h3>'
    + '<p class="hint pl-under">Copies the event with all its posts and media. Every date moves by the same amount; copies start again as ideas, and nothing is collected yet.</p>'
    + '<div class="row2"><div class="field"><label for="df-name">New name</label><input id="df-name" type="text" name="name" required value="'+esc(name)+'"></div>'
    + (e.startDate
      ? '<div class="field"><label for="df-start">New start date</label><input id="df-start" type="date" name="startDate" required value="'+esc(nextStart)+'"><div class="hint">Was '+esc(shortDate(e.startDate))+'.</div></div>'
      : '<div class="field"><label for="df-shift">Move dates by (days)</label><input id="df-shift" type="number" name="shiftDays" required value="364"></div>')
    + '</div><div class="pl-form-msg"></div>'
    + '<div class="btn-row"><button class="btn btn-primary" type="submit">Duplicate event</button>'
    + '<button class="btn btn-secondary" type="button" data-act="cancel-event-form">Cancel</button></div></form>';
}

function submitDuplicate(form) {
  var fd = new FormData(form), id = form.getAttribute('data-id');
  var body = { name: (fd.get('name') || '').trim(), startDate: fd.get('startDate') || null,
               shiftDays: fd.get('shiftDays') != null ? Number(fd.get('shiftDays')) : null };
  api('POST', '/api/pipeline/events/' + encodeURIComponent(id) + '/duplicate', body).then(function(d){
    toast('Copied ' + d.items + ' post' + (d.items === 1 ? '' : 's') + ' and ' + d.media + ' media item' + (d.media === 1 ? '' : 's') + '.', 'ok');
    return refreshEvents().then(function(){ renderFilters(); location.hash = '#event/' + encodeURIComponent(d.event.id); });
  }).catch(function(e){ form.querySelector('.pl-form-msg').innerHTML = '<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

// ── My work ──────────────────────────────────────────────────────────────────
function renderMine(main) {
  var me = S.me && S.me.email;
  if (!me) { main.innerHTML = '<p class="empty">Sign in through the hub to see your work.</p>'; return Promise.resolve(); }
  var today = S.meta.today;
  return Promise.all([
    api('GET', '/api/pipeline/content' + qs({ ownerEmail: me, from: addDays(today, -7) })),
    api('GET', '/api/pipeline/content' + qs({ ownerEmail: me, undated: 1 })),
    api('GET', '/api/pipeline/media' + qs({ assigneeEmail: me, status: 'needed,scheduled' })),
    api('GET', '/api/pipeline/media' + qs({ status: 'needed,scheduled', to: addDays(today, 21) })),
    api('GET', '/api/pipeline/media' + qs({ status: 'needed', unscheduled: 1 })),
    api('GET', '/api/pipeline/ical'),
  ]).then(function(res){
    var open = function(i){ return i.status !== 'published' && i.status !== 'cancelled'; };
    var posts = res[0].items.concat(res[1].items).filter(open);
    var mine = res[2].media;
    var seen = {};
    var free = res[3].media.concat(res[4].media).filter(function(m){
      if (m.assigneeEmail || seen[m.id] || (m.itemPublishDate && m.itemPublishDate < today)) return false;
      seen[m.id] = true; return true;
    });
    var feed = res[5];
    var html = '<p class="hint">Yours, whatever the filters above say. Signed in as '+esc(personName(me))+'.</p>'
      + '<div class="pl-two"><section class="card"><h3 class="ct">Posts you own</h3>'
      + (posts.length ? '<ul class="pl-agenda">'+posts.map(agendaPost).join('')+'</ul>' : '<p class="empty">Nothing waiting on you.</p>')
      + '</section><section class="card"><h3 class="ct">Media you’re collecting</h3>'
      + (mine.length ? '<ul class="pl-agenda">'+mine.map(agendaMedia).join('')+'</ul>' : '<p class="empty">Nothing assigned to you to collect.</p>')
      + '</section></div>';
    html += '<section class="card"><h3 class="ct">Nobody is collecting these</h3>'
      + (free.length ? '<ul class="pl-agenda">'+free.map(function(m){
          return agendaMedia(m).replace('</li>', '<button class="btn-sm btn-sm-gold pl-take" type="button" data-act="take-media" data-id="'+esc(m.id)+'">I’ll take it</button></li>');
        }).join('')+'</ul>'
        : '<p class="empty">Every capture coming up has someone on it.</p>')
      + '</section>';
    html += '<section class="card"><h3 class="ct">Capture days on your phone</h3>'
      + '<p class="pl-under hint">Subscribe in Apple Calendar or Google Calendar (“add from URL”). It updates as plans change. Anyone with the link can see the capture schedule, so share it only with the team.</p>'
      + '<div class="field"><label for="ical-mine">Just your captures</label><div class="pl-copyrow"><input id="ical-mine" type="text" readonly value="'+esc(feed.mineUrl)+'">'
      + '<button class="btn-sm" type="button" data-act="copy" data-target="ical-mine">Copy</button></div></div>'
      + '<div class="field"><label for="ical-all">Everyone’s captures</label><div class="pl-copyrow"><input id="ical-all" type="text" readonly value="'+esc(feed.url)+'">'
      + '<button class="btn-sm" type="button" data-act="copy" data-target="ical-all">Copy</button></div></div>'
      + '<button class="btn-sm" type="button" data-act="reset-ical">Reset the link</button></section>';
    main.innerHTML = html;
  });
}

// ── Settings ─────────────────────────────────────────────────────────────────
// Keys never come back from the server: a blank key box means "keep the saved one".
function renderSettings(main) {
  return api('GET', '/api/settings').then(function(s){
    var keyHint = function(has, what){ return '<div class="hint">' + (has ? esc(what) + ' is set. Leave blank to keep it.' : 'Not set yet.') + '</div>'; };
    main.innerHTML = '<form class="pl-settings" data-form="settings">'
      + '<section class="card"><h3 class="ct">Drafting</h3>'
      +   '<div class="field"><label for="st-voice">House voice</label><textarea id="st-voice" name="houseVoice" class="pl-voice">'+esc(s.houseVoice)+'</textarea>'
      +   '<div class="hint">Every draft follows these rules, whatever the event.</div></div>'
      +   '<div class="field"><label for="st-ak">Anthropic API key</label><input id="st-ak" type="text" name="anthropicKey" autocomplete="off" placeholder="sk-ant-…">'
      +   '<div class="hint">'+(s.hasAnthropicKey ? 'Current: '+esc(s.anthropicKeyHint)+'. Leave blank to keep it.' : 'Not set yet. Draft with Claude needs it.')+'</div></div></section>'
      + '<section class="card"><h3 class="ct">Mailchimp</h3><div class="row2">'
      +   '<div class="field"><label for="st-mk">API key</label><input id="st-mk" type="text" name="mailchimpKey" autocomplete="off" placeholder="xxxxxxxx-us21">'+keyHint(s.hasMailchimp, 'A key')+'</div>'
      +   '<div class="field"><label for="st-ms">Server prefix</label><input id="st-ms" type="text" name="mailchimpServer" value="'+esc(s.mailchimpServer)+'" placeholder="us21"></div></div></section>'
      + '<section class="card"><h3 class="ct">Podcast (Buzzsprout)</h3>'
      +   '<div class="field"><label for="st-bz">API token</label><input id="st-bz" type="text" name="buzzsproutToken" autocomplete="off" placeholder="From Profile → API in Buzzsprout">'
      +   '<div class="hint">'+(s.hasBuzzsprout ? 'Connected' + (s.buzzsproutPodcastName ? ' to '+esc(s.buzzsproutPodcastName) : '') + '.' : 'Not connected.')+'</div></div>'
      +   '<div class="field"><label for="st-bzp">Podcast</label><div class="pl-copyrow"><input id="st-bzp" type="text" name="buzzsproutPodcastId" value="'+esc(s.buzzsproutPodcastId)+'" placeholder="Podcast ID">'
      +   '<input type="hidden" name="buzzsproutPodcastName" value="'+esc(s.buzzsproutPodcastName)+'">'
      +   '<button class="btn-sm" type="button" data-act="load-podcasts">Load podcasts</button></div><select id="st-bz-list" hidden></select>'
      +   '<div class="hint">Save the token first, then load the podcasts on the account.</div></div></section>'
      + '<section class="card"><h3 class="ct">Metricool</h3>'
      +   '<div class="field"><label for="st-mc">API token</label><input id="st-mc" type="text" name="metricoolToken" autocomplete="off">'+keyHint(s.hasMetricool, 'A token')+'</div>'
      +   '<div class="row2"><div class="field"><label for="st-mcu">User ID</label><input id="st-mcu" type="text" name="metricoolUserId" value="'+esc(s.metricoolUserId)+'"></div>'
      +   '<div class="field"><label for="st-mcb">Brand</label><div class="pl-copyrow"><input id="st-mcb" type="text" name="metricoolBlogId" value="'+esc(s.metricoolBlogId)+'" placeholder="Blog / brand ID">'
      +   '<button class="btn-sm" type="button" data-act="load-brands">Load brands</button></div><select id="st-mc-list" hidden></select></div></div>'
      +   '<div class="row2"><div class="field"><label for="st-time">Default post time</label><input id="st-time" type="time" name="defaultPostTime" value="'+esc(s.defaultPostTime)+'"></div>'
      +   '<div class="field"><label for="st-tz">Timezone</label><input id="st-tz" type="text" name="defaultTimezone" value="'+esc(s.defaultTimezone)+'" placeholder="America/New_York"></div></div></section>'
      + '<section class="card"><h3 class="ct">Image hosting (R2)</h3>'
      +   '<div class="hint pl-under">'+(s.hasR2 ? 'Configured. Fill a box only to change it.' : 'Needed to send uploaded or approved images to Metricool.')+'</div>'
      +   '<div class="row2"><div class="field"><label for="st-r2a">Account ID</label><input id="st-r2a" type="text" name="r2AccountId" autocomplete="off"></div>'
      +   '<div class="field"><label for="st-r2k">Access key ID</label><input id="st-r2k" type="text" name="r2AccessKeyId" autocomplete="off"></div></div>'
      +   '<div class="row2"><div class="field"><label for="st-r2s">Secret access key</label><input id="st-r2s" type="text" name="r2SecretAccessKey" autocomplete="off"></div>'
      +   '<div class="field"><label for="st-r2b">Bucket</label><input id="st-r2b" type="text" name="r2Bucket" placeholder="grmc-media"></div></div>'
      +   '<div class="field"><label for="st-r2u">Public base URL</label><input id="st-r2u" type="text" name="r2PublicBaseUrl" placeholder="https://media.grmc.app"></div></section>'
      + '<div class="pl-form-msg" id="st-msg"></div>'
      + '<div class="btn-row"><button class="btn btn-primary" type="submit">Save settings</button></div></form>';
  });
}

function saveSettings(form) {
  var body = {}, btn = form.querySelector('[type=submit]');
  new FormData(form).forEach(function(v, k){ body[k] = String(v).trim(); });
  btn.disabled = true;
  api('POST', '/api/settings', body).then(function(){
    toast('Settings saved.', 'ok');
    // Approved images and defaults may have changed; refetch next time they're used.
    approvedCache = null; window._mcDefaults = null;
    return render();
  }).catch(function(e){ btn.disabled = false; $('st-msg').innerHTML = '<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

function loadPicker(path, listKey, selectId, inputName, toOption) {
  var sel = $(selectId);
  api('GET', path).then(function(d){
    var rows = d[listKey] || [];
    if (!rows.length) { toast('Nothing came back. Check the saved token.', 'warn'); return; }
    sel.innerHTML = rows.map(function(r){ var o = toOption(r); return '<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>'; }).join('');
    sel.hidden = false;
    sel.onchange = function(){
      var form = sel.closest('form');
      form.querySelector('[name='+inputName+']').value = sel.value;
      var name = form.querySelector('[name=buzzsproutPodcastName]');
      if (inputName === 'buzzsproutPodcastId' && name) name.value = sel.options[sel.selectedIndex].textContent;
    };
    sel.onchange();
  }).catch(function(e){ toast(e.message, 'err'); });
}

// ── One delegated handler for every button and form ──────────────────────────
document.addEventListener('click', function(e){
  var el = e.target.closest('[data-act]');
  if (!el) return;
  var act = el.getAttribute('data-act');
  if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type === 'checkbox')) return; // handled on change
  switch (act) {
    case 'open':
      e.preventDefault();
      openPost(el.getAttribute('data-item') || el.getAttribute('data-id'));
      break;
    case 'new-post':
      e.preventDefault();
      newPost({ date: el.getAttribute('data-date') || '', eventId: el.getAttribute('data-event') || '' });
      break;
    case 'close': closeDrawer(); break;
    case 'clear-filters':
      S.filters = { eventId: '', platform: '', status: '', owner: '' };
      storeSet('pipeline.filters', S.filters); renderFilters(); render(); break;
    case 'filter-status':
      S.filters.status = el.getAttribute('data-status');
      storeSet('pipeline.filters', S.filters); renderFilters(); break;
    case 'lens': S.cal.lens = el.getAttribute('data-lens'); storeSet('pipeline.cal', S.cal); render(); break;
    case 'cal-view': S.cal.view = el.getAttribute('data-v'); storeSet('pipeline.cal', S.cal); render(); break;
    case 'cal-today': S.cal.anchor = ''; storeSet('pipeline.cal', S.cal); render(); break;
    case 'cal-move':
      var dir = Number(el.getAttribute('data-dir')), a = S.cal.anchor || S.meta.today;
      if (S.cal.view === 'week') S.cal.anchor = addDays(a, 7 * dir);
      else { var d = parseIso(a); S.cal.anchor = isoOf(new Date(d.getFullYear(), d.getMonth() + dir, 1)); }
      storeSet('pipeline.cal', S.cal); render(); break;
    case 'delete-post':
      var n = drawer.media.length;
      if (drawer.recurrence) {
        if (!confirm('Skip “' + drawer.item.title + '” on ' + shortDate(drawer.item.publishDate) + '? The rest of the series carries on.')) return;
      } else if (!confirm('Delete “' + drawer.item.title + '”' + (n ? ' and its ' + n + ' media item' + (n === 1 ? '' : 's') : '') + '? This can’t be undone.')) return;
      api('DELETE', '/api/pipeline/content/' + encodeURIComponent(drawer.id)).then(function(res){
        toast(res.skipped ? 'Skipped. It stays cancelled on that date.' : 'Post deleted.', 'ok'); closeDrawer(); render();
      }).catch(function(err){ toast(err.message, 'err'); });
      break;
    case 'draft-caption': draftCaption(el); break;
    case 'send-metricool': sendToMetricool(); break;
    case 'make-recurring': makeRecurring(el.closest('form')); break;
    case 'new-recurrence': openRecurrence(null, {}); break;
    case 'edit-recurrence': openRecurrence(el.getAttribute('data-id')); break;
    case 'toggle-recurrence': toggleRecurrence(el.getAttribute('data-id'), !el.getAttribute('data-active')); break;
    case 'delete-recurrence': deleteRecurrence(el.getAttribute('data-id')); break;
    case 'add-tpl-row':
      $('rf-tpl').insertAdjacentHTML('beforeend', tplRowHtml({ description: '', type: 'photo', offsetDays: 0, assigneeEmail: '' }));
      $('rf-tpl').lastElementChild.querySelector('input').focus();
      break;
    case 'remove-tpl-row': el.closest('.pl-tpl-row').remove(); break;
    case 'take-media':
      api('PATCH', '/api/pipeline/media/' + encodeURIComponent(el.getAttribute('data-id')), { assigneeEmail: S.me.email }).then(function(){
        toast('It’s yours. It’s on your list and your calendar feed.', 'ok'); render();
      }).catch(function(err){ toast(err.message, 'err'); });
      break;
    case 'copy':
      var target = $(el.getAttribute('data-target'));
      target.select();
      (navigator.clipboard ? navigator.clipboard.writeText(target.value) : Promise.reject()).then(function(){ toast('Link copied.', 'ok'); })
        .catch(function(){ document.execCommand('copy'); toast('Link copied.', 'ok'); });
      break;
    case 'reset-ical':
      if (!confirm('Reset the calendar link? Everyone subscribed with the old link stops getting updates until they subscribe again.')) return;
      api('POST', '/api/pipeline/ical/reset').then(function(){ toast('New link made. The old one no longer works.', 'ok'); render(); })
        .catch(function(err){ toast(err.message, 'err'); });
      break;
    case 'duplicate-event':
      $('pl-event-form').innerHTML = duplicateForm(eventById(el.getAttribute('data-id')));
      $('df-name').focus();
      break;
    case 'delete-media': deleteMedia(el.closest('[data-media]')); break;
    case 'plan-episode':
      var pe = eventById(el.getAttribute('data-id'));
      $('pl-event-form').innerHTML = episodePlanForm(pe);
      api('GET', '/api/pipeline/sources/episodes').then(function(d){
        $('pe-ep').innerHTML = d.episodes.length
          ? d.episodes.map(function(ep){ return '<option value="'+esc(ep.id)+'">'+esc(ep.label)+(ep.isPublished ? '' : ' (not out yet)')+'</option>'; }).join('')
          : '<option value="">No episodes found</option>';
      }).catch(function(err){ $('pe-ep').innerHTML = '<option value="">'+esc(err.message)+'</option>'; });
      break;
    case 'plan-series':
      $('pl-event-form').innerHTML = seriesPlanForm(eventById(el.getAttribute('data-id'))); break;
    case 'add-plan-row':
      $('ps-rows').insertAdjacentHTML('beforeend', planRowHtml({})); break;
    case 'remove-plan-row': el.closest('.pl-plan-row').remove(); break;
    case 'draft-all': draftAllFor(el.getAttribute('data-ids').split(','), el); break;
    case 'src-change': showSourceChoices(el.getAttribute('data-kind')); break;
    case 'src-pick':
      drawer.sourceRef = drawer.sourceChoices[Number(el.getAttribute('data-i'))].ref; loadSourcePanel(); break;
    case 'src-reset': drawer.sourceRef = null; loadSourcePanel(); break;
    case 'src-paste':
      $('pf-source').insertAdjacentHTML('beforeend', '<div class="pl-paste"><textarea id="pf-paste" placeholder="Paste the newsletter or show notes text">'
        + esc(drawer.sourceRef && drawer.sourceRef.kind === 'manual' ? drawer.sourceRef.content : '')
        + '</textarea><input type="url" id="pf-paste-url" placeholder="Link to it (optional)" value="'
        + esc(drawer.sourceRef && drawer.sourceRef.kind === 'manual' ? drawer.sourceRef.url || '' : '')
        + '"><button class="btn-sm btn-sm-gold" type="button" data-act="src-use-paste">Use this</button></div>');
      $('pf-paste').focus();
      break;
    case 'src-use-paste':
      if (!$('pf-paste').value.trim()) { toast('Paste the content first.', 'err'); return; }
      drawer.sourceRef = { kind: 'manual', content: $('pf-paste').value.trim(), url: $('pf-paste-url').value.trim(), title: 'Pasted content' };
      loadSourcePanel(); break;
    case 'restore-draft':
      var h = drawer.history[Number(el.getAttribute('data-i'))], cf = document.querySelector('form[data-form=content]');
      setCaptionMode(h.captionMode);
      if (h.captionMode === 'separate') Object.keys(h.captions).forEach(function(k){ var box = cf.querySelector('[name="caption-'+k+'"]'); if (box) box.value = h.captions[k]; });
      else cf.querySelector('[name=caption]').value = h.caption;
      refreshCaptionUi(); toast('Restored. Save to keep it.', 'ok');
      break;
    case 'add-angle':
      $('dr-angles').insertAdjacentHTML('beforeend', angleRowHtml({ key: '', label: '', offsetDays: 0, instructions: '' }));
      $('dr-angles').lastElementChild.querySelector('input').focus();
      break;
    case 'remove-angle': el.closest('.pl-angle-row').remove(); break;
    case 'load-podcasts':
      loadPicker('/api/podcast/podcasts', 'podcasts', 'st-bz-list', 'buzzsproutPodcastId', function(p){ return { value: p.id, label: p.title }; });
      break;
    case 'load-brands':
      loadPicker('/api/metricool/brands', 'brands', 'st-mc-list', 'metricoolBlogId', function(b){ return { value: b.id, label: b.label }; });
      break;
    case 'cap-mode': setCaptionMode(el.getAttribute('data-mode')); break;
    case 'cap-tab':
      drawer.capTab = el.getAttribute('data-tab'); refreshCaptionUi();
      var pane = document.querySelector('[data-pane="' + drawer.capTab + '"] textarea');
      if (pane) pane.focus();
      break;
    case 'pick-approval': openApprovalPicker(el.closest('[data-media]')); break;
    case 'close-picker': el.closest('.pl-picker').hidden = true; break;
    case 'choose-approval':
      // A signed-off file is the finished file, so the item is done.
      mediaChange(el.closest('[data-media]').getAttribute('data-media'),
        { approvalId: Number(el.getAttribute('data-approval')), approvalTitle: el.getAttribute('data-title'), status: 'edited' });
      break;
    case 'upload-file': el.closest('[data-media]').querySelector('[data-upload]').click(); break;
    case 'clear-file':
      mediaChange(el.closest('[data-media]').getAttribute('data-media'), { fileLink: '', fileName: '', fileType: '' });
      break;
    case 'clear-approval':
      mediaChange(el.closest('[data-media]').getAttribute('data-media'), { approvalId: null, approvalTitle: '' });
      break;
    case 'new-event':
      $('pl-event-form').innerHTML = eventForm(); $('ef-name').focus(); break;
    case 'edit-event':
      $('pl-event-form').innerHTML = eventForm(eventById(el.getAttribute('data-id'))); $('ef-name').focus(); break;
    case 'cancel-event-form': $('pl-event-form').innerHTML = ''; render(); break;
    case 'archive-event':
      var archived = !el.getAttribute('data-archived');
      api('PATCH', '/api/pipeline/events/' + encodeURIComponent(el.getAttribute('data-id')), { archived: archived }).then(function(){
        toast(archived ? 'Archived. Its posts stay in history.' : 'Restored.', 'ok');
        return refreshEvents().then(function(){ renderFilters(); render(); });
      }).catch(function(err){ toast(err.message, 'err'); });
      break;
  }
});

document.addEventListener('change', function(e){
  var el = e.target;
  if (el.hasAttribute('data-filter')) {
    S.filters[el.getAttribute('data-filter')] = el.value;
    storeSet('pipeline.filters', S.filters);
    renderFilters(); render();
    return;
  }
  var act = el.getAttribute('data-act');
  if (act === 'quick-status') return moveStatus(el.getAttribute('data-id'), el.value);
  if (act === 'toggle-cancelled') { storeSet('pipeline.boardCancelled', el.checked); return render(); }
  if (act === 'toggle-archived') { storeSet('pipeline.eventsArchived', el.checked); return render(); }
  if (act === 'dr-kind') return showDraftingFields(el.closest('form'));
  if (act === 'src-toggle' || ((el.name === 'publishDate' || el.name === 'eventId') && el.closest('form[data-form=content]'))) loadSourcePanel();
  if (el.hasAttribute('data-mfield')) return saveMediaField(el.closest('[data-media]'), el);
  if (el.hasAttribute('data-mcollect')) return toggleCollected(el.closest('[data-media]'), el.checked);
  if (el.hasAttribute('data-upload')) return uploadMediaFile(el.closest('[data-media]'), el);
  if (act === 'no-media' || act === 'platform') {
    var f = el.closest('form');
    if (f.getAttribute('data-form') === 'content') return act === 'no-media' ? applyImageRule('no-media') : refreshCaptionUi();
    return applyImageRuleTo(f, act);
  }
  if (el.closest('form[data-form=recurrence]')) {
    if (act === 'rec-freq') showFreqFields(el.value);
    if (act === 'rec-ends') showEndFields(el.value);
    previewRule();
  }
});
document.addEventListener('input', function(e){
  if (e.target.classList && e.target.classList.contains('pl-caption')) refreshCaptionUi();
  if (e.target.closest && e.target.closest('form[data-form=recurrence]') && e.target.closest('[data-rule]')) previewRule();
});

document.addEventListener('submit', function(e){
  var form = e.target, kind = form.getAttribute('data-form');
  if (!kind) return;
  e.preventDefault();
  if (kind === 'content') return saveContent(form);
  if (kind === 'media') return addMedia(form);
  if (kind === 'recurrence') return saveRecurrence(form);
  if (kind === 'settings') return saveSettings(form);
  if (kind === 'plan-episode') {
    var pfd = new FormData(form);
    api('POST', '/api/pipeline/events/' + encodeURIComponent(form.getAttribute('data-id')) + '/plan-episode',
      { episodeId: pfd.get('episodeId'), angles: pfd.getAll('angles') })
      .then(function(d){ return refreshEvents().then(function(){ return render(); }).then(function(){ offerDraftAll(d.items); }); })
      .catch(function(err){ form.querySelector('.pl-form-msg').innerHTML = '<div class="alert alert-err">'+esc(err.message)+'</div>'; });
    return;
  }
  if (kind === 'plan-series-propose') {
    var sfd = new FormData(form), sbtn = form.querySelector('[type=submit]');
    sbtn.disabled = true; sbtn.innerHTML = '<span class="spin"></span> Planning…';
    api('POST', '/api/pipeline/events/' + encodeURIComponent(form.getAttribute('data-id')) + '/plan-series/propose',
      { count: Number(sfd.get('count')), cadence: sfd.get('cadence'), startDate: sfd.get('startDate') })
      .then(function(d){ showPlanRows(form.getAttribute('data-id'), d.posts); })
      .catch(function(err){ sbtn.disabled = false; sbtn.textContent = 'Propose a plan'; form.querySelector('.pl-form-msg').innerHTML = '<div class="alert alert-err">'+esc(err.message)+'</div>'; });
    return;
  }
  if (kind === 'plan-series') {
    var posts = Array.prototype.map.call(form.querySelectorAll('.pl-plan-row'), function(row){
      var g = function(k){ return row.querySelector('[data-plan='+k+']').value.trim(); };
      return { date: g('date'), phase: g('phase'), title: g('title'), sub: g('sub') };
    });
    api('POST', '/api/pipeline/events/' + encodeURIComponent(form.getAttribute('data-id')) + '/plan-series', { posts: posts })
      .then(function(d){ return refreshEvents().then(function(){ return render(); }).then(function(){ offerDraftAll(d.items); }); })
      .catch(function(err){ form.querySelector('.pl-form-msg').innerHTML = '<div class="alert alert-err">'+esc(err.message)+'</div>'; });
    return;
  }
  if (kind === 'drafting') {
    var dmsg = form.querySelector('.pl-form-msg');
    api('PATCH', '/api/pipeline/events/' + encodeURIComponent(form.getAttribute('data-id')), { drafting: readDraftingForm(form) })
      .then(function(){ toast('Drafting saved. New drafts for this event use it.', 'ok'); return refreshEvents().then(render); })
      .catch(function(err){ dmsg.innerHTML = '<div class="alert alert-err">'+esc(err.message)+'</div>'; });
    return;
  }
  if (kind === 'duplicate') return submitDuplicate(form);
  if (kind === 'event') {
    var fd = new FormData(form), id = form.getAttribute('data-id');
    var body = { name: (fd.get('name') || '').trim(), kind: fd.get('kind'), color: fd.get('color'),
      startDate: fd.get('startDate') || null, endDate: fd.get('endDate') || null,
      ownerEmail: (fd.get('ownerEmail') || '').trim(), notes: fd.get('notes') || '' };
    var msg = form.querySelector('.pl-form-msg');
    (id ? api('PATCH', '/api/pipeline/events/' + encodeURIComponent(id), body) : api('POST', '/api/pipeline/events', body))
      .then(function(res){
        toast(id ? 'Event saved.' : 'Event created.', 'ok');
        return refreshEvents().then(function(){
          renderFilters();
          if (id) render(); else location.hash = '#event/' + encodeURIComponent(res.event.id);
        });
      }).catch(function(err){ msg.innerHTML = '<div class="alert alert-err">'+esc(err.message)+'</div>'; });
  }
});

document.addEventListener('toggle', function(e){
  if (e.target.matches && e.target.matches('details.pl-history') && e.target.open) loadHistory();
}, true);
$('pl-scrim').addEventListener('click', closeDrawer);
// Calendar cards are divs (draggable buttons misbehave in Firefox), so give
// them a button's keyboard behaviour.
document.addEventListener('keydown', function(e){
  if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute && e.target.getAttribute('role') === 'button') {
    e.preventDefault(); e.target.click();
  }
});
document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && $('pl-drawer').classList.contains('open')) closeDrawer(); });
window.addEventListener('hashchange', function(){ render(); $('pl-main').focus({ preventScroll: true }); });

// The hub's user directory, for owner and assignee suggestions. Typing any
// email still works if the hub can't be reached.
function loadPeople() {
  var labels = location.hostname.split('.');
  if (labels.length < 2) return Promise.resolve();
  var hub = location.protocol + '//hub.' + labels.slice(1).join('.');
  return fetch(hub + '/api/users?app=social-posts', { credentials: 'include' })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      S.people = (d && d.users) || [];
      $('pl-people').innerHTML = S.people.map(function(p){ return '<option value="'+esc(p.email)+'">'+esc(p.name || p.email)+'</option>'; }).join('');
    })
    .catch(function(){ S.people = []; });
}

// ── Start ────────────────────────────────────────────────────────────────────
Promise.all([api('GET', '/api/pipeline/meta'), refreshEvents(), loadPeople(),
             api('GET', '/api/me').catch(function(){ return { email: '' }; })]).then(function(res){
  S.meta = res[0];
  S.me = res[3];
  renderFilters();
  render();
}).catch(function(e){
  $('pl-main').innerHTML = '<div class="alert alert-err">The pipeline couldn’t load: '+esc(e.message)+'. Reload the page to try again.</div>';
});
})();
