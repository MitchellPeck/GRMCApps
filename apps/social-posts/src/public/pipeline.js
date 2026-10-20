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
function shortDate(iso){ if (!iso) return 'No date'; var d = parseIso(iso); return DOW[d.getDay()]+' '+MONTHS[d.getMonth()].slice(0,3)+' '+d.getDate(); }
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
function statusBadge(s, kind){ return '<span class="pl-status pl-s-'+esc(s)+(kind === 'media' ? ' pl-media-s' : '')+'">'+esc(label(s))+'</span>'; }
function mediaProgress(item){
  if (item.noMediaNeeded) return '<span class="pl-prog pl-prog-none">No media needed</span>';
  if (!item.mediaTotal) return '<span class="pl-prog pl-prog-gap">No media planned</span>';
  var pct = Math.round(100 * item.mediaDone / item.mediaTotal);
  return '<span class="pl-prog" title="'+item.mediaDone+' of '+item.mediaTotal+' captured">'
    + '<span class="pl-bar"><span style="width:'+pct+'%"></span></span>'+item.mediaDone+' of '+item.mediaTotal+' captured</span>';
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
  var main = $('pl-main');
  var views = { dashboard: renderDashboard, calendar: renderCalendar, board: renderBoard, events: renderEvents, event: renderEvent, gap: renderGapList };
  (views[r.view] || renderDashboard)(main, r.arg).catch(function(e){
    main.innerHTML = '<div class="alert alert-err">Couldn’t load this view: '+esc(e.message)+'</div>';
  });
}

function refreshEvents() {
  return api('GET', '/api/pipeline/events?archived=all').then(function(d){ S.events = d.events; });
}

// ── Dashboard ────────────────────────────────────────────────────────────────
function renderDashboard(main) {
  return Promise.all([
    api('GET', '/api/pipeline/dashboard/summary'),
    api('GET', '/api/pipeline/dashboard/gaps'),
  ]).then(function(res){
    var sum = res[0], gaps = res[1].gaps;
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

    var by = sum.byStatus;
    var flow = S.meta.contentStatuses.filter(function(s){ return s !== 'cancelled'; });
    html += '<section class="card"><h3 class="ct">Pipeline</h3><div class="pl-flow">'
      + flow.map(function(s){
          return '<a class="pl-flow-step" href="#board" data-act="filter-status" data-status="'+s+'"><strong>'+(by[s] || 0)+'</strong>'+statusBadge(s)+'</a>';
        }).join('')
      + '</div>'+(by.cancelled ? '<p class="hint">'+by.cancelled+' cancelled, kept for history.</p>' : '')+'</section>';

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
                   api('GET', '/api/pipeline/media' + mediaFilterQuery({ unscheduled: 1 }))]);
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
    + '<span class="pl-card-title">'+(i.publishTime ? '<span class="pl-time">'+esc(timeLabel(i.publishTime))+'</span> ' : '')+esc(i.title)+'</span>'
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
  var from = addDays(S.meta.today, -30);
  return Promise.all([
    api('GET', '/api/pipeline/content' + contentFilterQuery({ from: from, includeCancelled: showCancelled ? 1 : '' })),
    api('GET', '/api/pipeline/content' + contentFilterQuery({ undated: 1, includeCancelled: showCancelled ? 1 : '' })),
  ]).then(function(res){
    var items = res[0].items.concat(res[1].items);
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
    + '<span class="pl-title">'+esc(i.title)+'</span>'
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
    + '<div class="field"><label for="ef-notes">Notes and key messages</label><textarea id="ef-notes" name="notes">'+esc(e.notes || '')+'</textarea></div>'
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
      + '<button class="btn-sm" type="button" data-act="archive-event" data-id="'+esc(e.id)+'" data-archived="'+(e.archived ? '1' : '')+'">'+(e.archived ? 'Restore' : 'Archive')+'</button>'
      + '<button class="btn-sm btn-sm-gold" type="button" data-act="new-post" data-event="'+esc(e.id)+'">New post for this event</button></div></section>'
      + '<div id="pl-event-form"></div>'
      + '<div class="pl-stats"><span><strong>'+live.length+'</strong> posts</span><span><strong>'+done+' of '+d.media.length+'</strong> media captured</span></div>';

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
  });
}

// ── Editor drawer ────────────────────────────────────────────────────────────
var drawer = { id: null, item: null, media: [], source: null, opener: null };

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
  drawer.id = null; drawer.item = null; drawer.media = []; drawer.source = null;
  var f = S.filters;
  var item = {
    title: '', eventId: defaults.eventId || f.eventId || '', platforms: f.platform ? [f.platform] : ['instagram','facebook'],
    publishDate: defaults.date || '', publishTime: '', status: 'idea', ownerEmail: f.owner || '', brief: '', caption: '', noMediaNeeded: false,
  };
  openDrawer(editorHtml(item, true));
}

function openPost(id) {
  drawer.id = id;
  openDrawer('<div class="pl-drawer-body"><p class="empty">Loading…</p></div>');
  api('GET', '/api/pipeline/content/' + encodeURIComponent(id)).then(function(d){
    if (drawer.id !== id) return;
    drawer.item = d.item; drawer.media = d.media; drawer.source = d.source;
    $('pl-drawer').innerHTML = editorHtml(d.item, false);
  }).catch(function(e){
    $('pl-drawer').innerHTML = '<div class="pl-drawer-body"><div class="alert alert-err">'+esc(e.message)+'</div><button class="btn btn-secondary" data-act="close">Close</button></div>';
  });
}

function sourceHtml(src) {
  if (!src) return '';
  if (src.kind === 'series') {
    return '<p class="pl-source">Post '+src.postNumber+' of the “'+esc(src.seriesName)+'” series. <a href="/#series">Open it on the Series tab</a></p>';
  }
  var runs = { wednesday: 'Wednesday run', friday: 'Friday run', podcast: 'Podcast run' };
  return '<p class="pl-source">Drafted by the '+esc(runs[src.run] || src.run)+' ('+esc(src.key)+') on '+esc(String(src.draftedAt).slice(0, 10))+'. <a href="/#drafts">See it in Drafts</a></p>';
}

function editorHtml(i, isNew) {
  var m = S.meta;
  var blockers = isNew ? [] : readyBlockers(i, drawer.media);
  var gatedWarning = !isNew && m.gatedStatuses.indexOf(i.status) !== -1 && blockers.length
    ? '<div class="alert alert-warn">Marked '+label(i.status)+' but still waiting on: '+esc(blockers.join('; '))+'</div>' : '';
  return '<form class="pl-drawer-body" data-form="content">'
    + '<div class="pl-drawer-head"><h2>'+(isNew ? 'New post' : 'Edit post')+'</h2><button class="pl-x" type="button" data-act="close" aria-label="Close">×</button></div>'
    + sourceHtml(drawer.source) + gatedWarning
    + '<div class="field"><label for="pf-title">Title</label><input id="pf-title" type="text" name="title" required value="'+esc(i.title)+'" placeholder="Kids Camp: first day recap"></div>'
    + '<div class="row2"><div class="field"><label for="pf-date">Publish date</label><input id="pf-date" type="date" name="publishDate" required value="'+esc(i.publishDate || '')+'"></div>'
    + '<div class="field"><label for="pf-time">Time (optional)</label><input id="pf-time" type="time" name="publishTime" value="'+esc(i.publishTime || '')+'"></div></div>'
    + '<div class="row2"><div class="field"><label for="pf-event">Event or department</label><select id="pf-event" name="eventId">'+eventOptions(i.eventId, { blank: 'None' })+'</select></div>'
    + '<div class="field"><label for="pf-status">Status</label><select id="pf-status" name="status">'
    + m.contentStatuses.map(function(s){ return '<option value="'+s+'"'+(s === i.status ? ' selected' : '')+'>'+label(s)+'</option>'; }).join('')+'</select></div></div>'
    + '<fieldset class="field pl-plats"><legend class="lbl">Platforms</legend>'
    + m.platforms.map(function(p){ return '<label class="check"><input type="checkbox" name="platforms" value="'+esc(p.key)+'"'+(i.platforms.indexOf(p.key) !== -1 ? ' checked' : '')+'> '+esc(p.label)+'</label>'; }).join('')
    + '</fieldset>'
    + '<div class="field"><label for="pf-owner">Owner</label><input id="pf-owner" type="email" name="ownerEmail" list="pl-people" value="'+esc(i.ownerEmail)+'" placeholder="Who gets it published"></div>'
    + '<div class="field"><label for="pf-brief">Brief</label><textarea id="pf-brief" name="brief" placeholder="Purpose, angle and call to action in a sentence or two">'+esc(i.brief)+'</textarea></div>'
    + '<div class="field"><label for="pf-caption">Caption</label><textarea id="pf-caption" name="caption" class="pl-caption" placeholder="Written by hand, or filled in by the automated drafting">'+esc(i.caption)+'</textarea></div>'
    + '<label class="check pl-nomedia"><input type="checkbox" name="noMediaNeeded"'+(i.noMediaNeeded ? ' checked' : '')+'> No media needed (a text-only post)</label>'
    + '<div class="pl-form-msg" id="pf-msg"></div>'
    + '<div class="btn-row"><button class="btn btn-primary" type="submit">'+(isNew ? 'Create post' : 'Save changes')+'</button>'
    + '<button class="btn btn-secondary" type="button" data-act="close">'+(isNew ? 'Cancel' : 'Close')+'</button>'
    + (isNew ? '' : '<button class="btn btn-danger pl-right" type="button" data-act="delete-post">Delete post</button>')+'</div>'
    + '</form>'
    + (isNew ? '<p class="hint pl-drawer-pad">Create the post first, then list the media it needs.</p>' : checklistHtml(i));
}

function readyBlockers(item, media) {
  if (item.noMediaNeeded) return [];
  if (!media.length) return ['no media is listed yet'];
  return media.filter(function(m){ return m.status !== 'captured' && m.status !== 'edited'; })
    .map(function(m){ return m.description + ' (' + m.status + ')'; });
}

function checklistHtml(item) {
  var media = drawer.media, m = S.meta;
  var done = media.filter(function(x){ return x.status === 'captured' || x.status === 'edited'; }).length;
  var types = function(sel){ return m.mediaTypes.map(function(t){ return '<option value="'+t+'"'+(t === sel ? ' selected' : '')+'>'+label(t)+'</option>'; }).join(''); };
  var html = '<section class="pl-checklist" aria-label="Media checklist"><div class="pl-drawer-head"><h3>Media</h3>'
    + '<span class="pl-prog">'+(media.length ? done+' of '+media.length+' captured' : item.noMediaNeeded ? 'Not needed' : 'None listed')+'</span></div>';
  html += media.map(function(x){
    var late = x.gatherDate && item.publishDate && x.gatherDate > item.publishDate;
    return '<div class="pl-mrow" data-media="'+esc(x.id)+'">'
      + '<div class="pl-mline"><select data-mfield="status" aria-label="Status">'+m.mediaStatuses.map(function(s){ return '<option value="'+s+'"'+(s === x.status ? ' selected' : '')+'>'+label(s)+'</option>'; }).join('')+'</select>'
      + '<input type="text" data-mfield="description" value="'+esc(x.description)+'" aria-label="What to capture">'
      + '<button class="pl-x" type="button" data-act="delete-media" aria-label="Remove '+esc(x.description)+'">×</button></div>'
      + '<div class="pl-mline pl-mline-sm"><select data-mfield="type" aria-label="Type">'+types(x.type)+'</select>'
      + '<input type="date" data-mfield="gatherDate" value="'+esc(x.gatherDate || '')+'" aria-label="Gather date">'
      + '<input type="email" data-mfield="assigneeEmail" list="pl-people" value="'+esc(x.assigneeEmail)+'" placeholder="Who captures it" aria-label="Assignee"></div>'
      + '<div class="pl-mline pl-mline-sm"><input type="text" data-mfield="gatherLocation" value="'+esc(x.gatherLocation)+'" placeholder="Where" aria-label="Location">'
      + '<input type="url" data-mfield="fileLink" value="'+esc(x.fileLink)+'" placeholder="Link to the finished file" aria-label="File link"></div>'
      + '<input type="text" class="pl-mnotes" data-mfield="notes" value="'+esc(x.notes)+'" placeholder="Shot details, people, permissions" aria-label="Notes">'
      + (late ? '<p class="pl-gaptext">Gathered after the post publishes ('+esc(shortDate(item.publishDate))+').</p>' : '')
      + '</div>';
  }).join('');
  html += '<form class="pl-madd" data-form="media"><input type="text" name="description" placeholder="Add something to capture, e.g. volunteer interview at check-in" aria-label="New media" required>'
    + '<select name="type" aria-label="Type">'+types('photo')+'</select>'
    + '<input type="date" name="gatherDate" aria-label="Gather date">'
    + '<button class="btn-sm btn-sm-gold" type="submit">Add</button></form></section>';
  return html;
}

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
  return out;
}

function saveContent(form) {
  var body = readForm(form), msg = $('pf-msg'), btn = form.querySelector('[type=submit]');
  msg.innerHTML = '';
  if (!body.title) { msg.innerHTML = '<div class="alert alert-err">Give the post a title.</div>'; return; }
  if (!body.publishDate) { msg.innerHTML = '<div class="alert alert-err">Pick a publish date.</div>'; return; }
  btn.disabled = true;
  var req;
  if (drawer.id) {
    // Send only what changed, so a status change is judged on its own.
    var cur = drawer.item, patch = {};
    Object.keys(body).forEach(function(k){
      var a = body[k], b = cur[k] == null ? '' : cur[k];
      if (Array.isArray(a) ? a.join(',') !== (b || []).join(',') : a !== b) patch[k] = a;
    });
    if (!Object.keys(patch).length) { btn.disabled = false; closeDrawer(); return; }
    req = api('PATCH', '/api/pipeline/content/' + encodeURIComponent(drawer.id), patch);
  } else {
    req = api('POST', '/api/pipeline/content', body);
  }
  req.then(function(res){
    btn.disabled = false;
    warnAll(res.warnings);
    if (!drawer.id) {
      toast('Post created. Now list the media it needs.', 'ok');
      openPost(res.item.id);
    } else {
      toast('Saved.', 'ok');
      closeDrawer();
    }
    render();
  }).catch(function(e){
    btn.disabled = false;
    msg.innerHTML = '<div class="alert alert-err">'+esc(e.message)+'</div>';
  });
}

function reloadDrawer() {
  if (!drawer.id) return Promise.resolve();
  return api('GET', '/api/pipeline/content/' + encodeURIComponent(drawer.id)).then(function(d){
    drawer.item = d.item; drawer.media = d.media;
    // Keep unsaved edits in the post form; only the checklist is redrawn.
    var list = document.querySelector('.pl-checklist');
    if (list) list.outerHTML = checklistHtml(d.item);
  });
}

function saveMediaField(row, input) {
  var id = row.getAttribute('data-media'), field = input.getAttribute('data-mfield'), body = {};
  body[field] = input.value;
  if (field === 'description' && !input.value.trim()) { toast('Describe what needs capturing.', 'err'); return reloadDrawer(); }
  api('PATCH', '/api/pipeline/media/' + encodeURIComponent(id), body).then(function(res){
    warnAll(res.warnings);
    return reloadDrawer().then(render);
  }).catch(function(e){ toast(e.message, 'err'); reloadDrawer(); });
}

function addMedia(form) {
  var fd = new FormData(form);
  var body = { description: (fd.get('description') || '').trim(), type: fd.get('type'), gatherDate: fd.get('gatherDate') || null };
  if (!body.description) return;
  api('POST', '/api/pipeline/content/' + encodeURIComponent(drawer.id) + '/media', body).then(function(res){
    warnAll(res.warnings);
    return reloadDrawer().then(function(){
      var input = document.querySelector('.pl-madd input[name=description]');
      if (input) input.focus();
      render();
    });
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
      if (!confirm('Delete “' + drawer.item.title + '”' + (n ? ' and its ' + n + ' media item' + (n === 1 ? '' : 's') : '') + '? This can’t be undone.')) return;
      api('DELETE', '/api/pipeline/content/' + encodeURIComponent(drawer.id)).then(function(){
        toast('Post deleted.', 'ok'); closeDrawer(); render();
      }).catch(function(err){ toast(err.message, 'err'); });
      break;
    case 'delete-media':
      var row = el.closest('[data-media]');
      api('DELETE', '/api/pipeline/media/' + encodeURIComponent(row.getAttribute('data-media'))).then(function(){
        return reloadDrawer().then(render);
      }).catch(function(err){ toast(err.message, 'err'); });
      break;
    case 'new-event':
      $('pl-event-form').innerHTML = eventForm(); $('ef-name').focus(); break;
    case 'edit-event':
      $('pl-event-form').innerHTML = eventForm(eventById(el.getAttribute('data-id'))); $('ef-name').focus(); break;
    case 'cancel-event-form': $('pl-event-form').innerHTML = ''; break;
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
  if (el.hasAttribute('data-mfield')) saveMediaField(el.closest('[data-media]'), el);
});

document.addEventListener('submit', function(e){
  var form = e.target, kind = form.getAttribute('data-form');
  if (!kind) return;
  e.preventDefault();
  if (kind === 'content') return saveContent(form);
  if (kind === 'media') return addMedia(form);
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
Promise.all([api('GET', '/api/pipeline/meta'), refreshEvents(), loadPeople()]).then(function(res){
  S.meta = res[0];
  renderFilters();
  render();
}).catch(function(e){
  $('pl-main').innerHTML = '<div class="alert alert-err">The pipeline couldn’t load: '+esc(e.message)+'. Reload the page to try again.</div>';
});
})();
