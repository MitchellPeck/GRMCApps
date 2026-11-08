// Grace Notes admin tab: issue page, paste sheet, people and sections. Vanilla JS; loaded before pipeline.js.
(function () {
'use strict';

var LETTER = /pastor|message|letter/i; // same test the server uses to find the letter
var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var STATE = { outstanding: ['Outstanding', 'pill-pending'], confirmed: ['Confirmed', 'pill-ok'], changed: ['Changed', 'pill-info'],
  'new': ['Added', 'pill-info'], none: ['No pieces', ''] };
var KINDS = { text: 'Text', events: 'Events list', glance: 'Grace at a Glance (automatic)' };

// ── helpers (copies of the small ones in pipeline.js) ────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function api(method, path, body) {
  return fetch(path, {
    method: method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  }).then(function (res) {
    return res.json().catch(function () { return { ok: false, error: 'The server answered ' + res.status + '. Try again in a moment.' }; });
  }, function () { return { ok: false, error: 'Couldn’t reach the server.' }; });
}
// Like api, but throws on { ok: false } so views can use one catch.
function call(method, path, body) {
  return api(method, path, body).then(function (d) { if (!d.ok) throw new Error(d.error || 'Something went wrong.'); return d; });
}
var toastTimer;
function toast(msg, kind) {
  var t = document.getElementById('pl-toast');
  if (!t) return;
  t.className = 'pl-toast show ' + (kind || '');
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.className = 'pl-toast'; }, kind === 'err' ? 7000 : 3500);
}
function parseDay(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
function dayLabel(iso) { var d = parseDay(iso); return d ? DOW[d.getDay()] + ' ' + MON[d.getMonth()] + ' ' + d.getDate() : ''; }
function isoOf(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
// First date after today that falls on the send weekday (mirrors nextIssueDate on the server).
function nextIssueDate(sendDow) {
  var d = new Date();
  d.setDate(d.getDate() + ((sendDow - d.getDay() + 6) % 7) + 1);
  return isoOf(d);
}
function remindedLabel(iso) {
  if (!iso) return 'not reminded yet';
  var d = new Date(iso);
  if (isNaN(d)) return 'not reminded yet';
  return 'reminded ' + DOW[d.getDay()] + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('no clipboard'));
}
function copyLink(url) { copyText(url).then(function () { toast('Link copied.', 'ok'); }, function () { toast('Couldn’t copy. Select the link and copy it by hand.', 'err'); }); }
function plain(html) { var d = document.createElement('div'); d.innerHTML = html; return d.textContent; }
function copyBlock(html, text) {
  var done = function () { toast('Copied.', 'ok'); };
  var fail = function () { toast('Couldn’t copy. Select the text and copy it by hand.', 'err'); };
  // Built inside the promise chain so a throw from ClipboardItem falls back to plain text.
  var rich = window.ClipboardItem && navigator.clipboard && navigator.clipboard.write
    ? Promise.resolve().then(function () {
      return navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
    })
    : Promise.reject(new Error('no rich clipboard'));
  rich.then(done, function () { copyText(text).then(done, fail); });
}
// Same order as effectiveImage() on the server: a linked event's picture wins.
function shownImage(p) { return p.eventId && p.eventImageUrl ? p.eventImageUrl : p.imageUrl || ''; }
function rangeOf(s, e) { return s ? (e && e > s ? dayLabel(s) + ' – ' + dayLabel(e) : dayLabel(s)) : ''; }
function cardTitle(t) { return '<h3 class="ct">' + t + '</h3>'; }

// ── rich text editor (copied approach from gn/contributor.js) ────────────────
function safeUrl(u) { u = String(u || '').trim(); return /^(https?:\/\/|mailto:)/i.test(u) ? u : ''; }
function cleanPasted(html) {
  var doc = new DOMParser().parseFromString(html, 'text/html');
  function walk(node) {
    var out = '';
    node.childNodes.forEach(function (n) {
      if (n.nodeType === 3) { out += esc(n.nodeValue); return; }
      if (n.nodeType !== 1) return;
      var tag = n.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'head') return;
      var inner = walk(n), st = n.style || {};
      var bold = (tag === 'b' || tag === 'strong') ? st.fontWeight !== 'normal' : parseInt(st.fontWeight, 10) >= 600 || st.fontWeight === 'bold';
      var ital = tag === 'i' || tag === 'em' || st.fontStyle === 'italic';
      if (tag === 'br') out += '<br>';
      else if (tag === 'a' && safeUrl(n.getAttribute('href'))) out += '<a href="' + esc(safeUrl(n.getAttribute('href'))) + '">' + inner + '</a>';
      else if (tag === 'ul' || tag === 'ol' || tag === 'li') out += '<' + tag + '>' + inner + '</' + tag + '>';
      else if (tag === 'p' || tag === 'div' || /^h[1-6]$/.test(tag)) out += '<p>' + inner + '</p>';
      else {
        if (bold && inner) inner = '<b>' + inner + '</b>';
        if (ital && inner) inner = '<i>' + inner + '</i>';
        out += inner;
      }
    });
    return out;
  }
  return walk(doc.body);
}
function makeEditor(initialHtml) {
  var wrap = document.createElement('div');
  wrap.innerHTML = '<div class="gnx-toolbar"></div><div class="gnx-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Piece text"></div>';
  var bar = wrap.firstChild, ed = wrap.lastChild;
  ed.innerHTML = initialHtml || ''; // sanitized on the server
  ed.addEventListener('paste', function (e) {
    var cd = e.clipboardData;
    if (!cd) return;
    e.preventDefault();
    var html = cd.getData('text/html');
    if (html) document.execCommand('insertHTML', false, cleanPasted(html)); else document.execCommand('insertText', false, cd.getData('text/plain'));
  });
  [['<b>B</b>', 'Bold', function () { document.execCommand('bold'); }], ['<i>I</i>', 'Italic', function () { document.execCommand('italic'); }],
    ['Link', 'Make a link', function () {
      var url = window.prompt('Web address for this link:', 'https://');
      if (!url) return;
      url = url.trim();
      if (!/^(https?:\/\/|mailto:)/i.test(url)) url = 'https://' + url;
      document.execCommand('createLink', false, url);
    }], ['List', 'Bulleted list', function () { document.execCommand('insertUnorderedList'); }]].forEach(function (t) {
    var b = document.createElement('button');
    b.type = 'button'; b.title = t[1]; b.setAttribute('aria-label', t[1]); b.innerHTML = t[0];
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function () { ed.focus(); t[2](); });
    bar.appendChild(b);
  });
  return { node: wrap, html: function () { return ed.textContent.trim() === '' && !ed.querySelector('a,li') ? '' : ed.innerHTML.trim(); } };
}

// ── routing ──────────────────────────────────────────────────────────────────
var current = null; // { main, arg } of the view on screen, for reloads

function nav(active) {
  var tabs = [['', 'Issue'], ['people', 'People'], ['sections', 'Sections']];
  return '<div class="gnx-subnav">' + tabs.map(function (t) {
    return '<a href="#gracenotes' + (t[0] ? '/' + t[0] : '') + '"' + (t[0] === active ? ' class="active" aria-current="page"' : '') + '>' + t[1] + '</a>';
  }).join('') + '</div>';
}
function reload() { return render(current.main, current.arg); }
function fail(e) { toast(e.message || 'Something went wrong.', 'err'); }

function render(main, arg) {
  current = { main: main, arg: arg || '' };
  main.onclick = main.onsubmit = null;
  var a = arg || '';
  if (a === 'people') return renderPeople(main);
  if (a === 'sections') return renderSections(main);
  return renderIssuePage(main, a.indexOf('issue/') === 0 ? a.slice(6) : '').catch(function (e) {
    main.innerHTML = nav('') + '<div class="alert alert-err">Couldn’t load Grace Notes: ' + esc(e.message) + '</div>';
  });
}

// Click handler shared by the three views: buttons carry data-act, and the handlers table maps act -> fn(button).
function wire(main, handlers) {
  main.onclick = function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || !main.contains(el) || el.disabled) return;
    var fn = handlers[el.getAttribute('data-act')];
    if (fn) { e.preventDefault(); fn(el); }
  };
}
function run(btn, p, okMsg, then) {
  btn.disabled = true;
  return p().then(function (d) { if (okMsg) toast(okMsg, 'ok'); return then ? then(d) : reload(); }, function (e) { btn.disabled = false; fail(e); });
}

// ── issue page ───────────────────────────────────────────────────────────────
function renderIssuePage(main, issueId) {
  return Promise.all([api('GET', '/api/gracenotes/issues'), api('GET', '/api/settings')]).then(function (r) {
    if (!r[0].ok) throw new Error(r[0].error);
    var issues = r[0].issues, settings = r[1].ok ? r[1] : {};
    var target = issueId ? issues.filter(function (i) { return i.id === issueId; })[0]
      : issues.filter(function (i) { return i.status === 'collecting'; })[0];
    var history = issues.filter(function (i) { return i.status === 'sent' && (!target || i.id !== target.id); });
    var histHtml = history.length ? '<section class="card">' + cardTitle('Sent issues') + history.map(function (i) {
      return '<div class="gnx-row"><a href="#gracenotes/issue/' + esc(i.id) + '">' + esc(dayLabel(i.issueDate)) + '</a><span class="hint">sent ' + esc((i.sentAt || '').slice(0, 10)) + '</span></div>';
    }).join('') + '</section>' : '';
    if (!target) return renderStart(main, settings, histHtml);
    return Promise.all([call('GET', '/api/gracenotes/issues/' + encodeURIComponent(target.id)), call('GET', '/api/gracenotes/issues/' + encodeURIComponent(target.id) + '/sheet'),
      call('GET', '/api/gracenotes/contributors'), call('GET', '/api/gracenotes/sections'),
      api('GET', '/api/pipeline/events?archived=false')]).then(function (d) {
      drawIssue(main, d[0], d[1].blocks, d[2].contributors, d[3].sections, settings, histHtml, d[4].ok ? d[4].events : []);
    });
  });
}

function renderStart(main, settings, histHtml) {
  var dow = settings.gnSendDow == null ? 3 : Number(settings.gnSendDow);
  main.innerHTML = nav('') + '<section class="card">' + cardTitle('Start an issue')
    + '<p class="hint">There is no issue being collected. The first one is filled in by hand; later ones copy forward from the last one sent.</p>'
    + '<div class="field"><label for="gnx-date">Issue date</label><input id="gnx-date" type="date" value="' + nextIssueDate(dow) + '"></div>'
    + '<div class="btn-row"><button class="btn btn-primary" type="button" data-act="start">Start issue</button></div></section>' + histHtml;
  wire(main, { start: function (b) {
    var v = document.getElementById('gnx-date').value;
    if (!v) return toast('Pick the date the issue goes out.', 'err');
    run(b, function () { return call('POST', '/api/gracenotes/issues', { issueDate: v }); }, 'Issue started.', function (d) {
      location.hash = '#gracenotes/issue/' + d.issue.id; return reload();
    });
  } });
  return Promise.resolve();
}

function drawIssue(main, data, blocks, people, sections, settings, histHtml, events) {
  var issue = data.issue, sent = issue.status === 'sent';
  var mailOn = !!(settings.hasResend && settings.mailFrom && settings.publicBaseUrl);
  var link = {};
  people.forEach(function (p) { link[p.id] = p.link; });
  var pieces = data.pieces.filter(function (p) { return p.status !== 'dropped'; });
  // Upcoming social events not already in this issue, for "Add an existing event" and "Link to event".
  var taken = {};
  pieces.forEach(function (p) { if (p.eventId) taken[p.eventId] = true; });
  var today = isoOf(new Date());
  var upcoming = (events || []).filter(function (e) { return !e.archived && e.startDate && e.startDate >= today && !taken[e.id]; })
    .sort(function (a, b) { return a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0; });
  var eventOptions = upcoming.map(function (e) {
    return '<option value="' + esc(e.id) + '">' + esc(rangeOf(e.startDate, e.endDate) + ' · ' + e.name) + '</option>';
  }).join('');
  var pickerHtml = function (act, id, label) {
    return '<div class="gnx-pick"><select aria-label="Event">' + eventOptions + '</select>'
      + '<button class="btn-sm" type="button" data-act="' + act + '" data-id="' + esc(id) + '">' + label + '</button></div>';
  };
  var html = nav('') + '<div class="gnx-head"><h2>Grace Notes for ' + esc(dayLabel(issue.issueDate)) + '</h2>'
    + '<span class="pill ' + (sent ? 'pill-ok' : 'pill-pending') + '">' + (sent ? 'Sent' : 'Collecting') + '</span></div>';
  if (!mailOn && !sent) html += '<div class="alert alert-info">Email reminders are off. Set them up in <a href="#settings">Settings</a>.</div>';

  html += '<section class="card">' + cardTitle('Who has checked in') + (data.contributors.length ? data.contributors.map(function (c) {
    var st = STATE[c.state] || STATE.none;
    var act = c.state === 'none' || sent ? '' : mailOn && c.hasEmail
      ? '<button class="btn-sm" type="button" data-act="nudge" data-id="' + esc(c.contributorId) + '">Nudge</button>'
      : '<button class="btn-sm" type="button" data-act="copy-link" data-url="' + esc(link[c.contributorId] || '') + '">Copy link</button>';
    return '<div class="gnx-row"><strong>' + esc(c.name) + '</strong><span class="pill ' + st[1] + '">' + st[0] + '</span>'
      + '<span class="hint">' + esc(remindedLabel(c.lastReminder)) + '</span>' + act + '</div>';
  }).join('') : '<p class="hint">No one is set up yet. Add people on the People tab.</p>') + '</section>';

  var sectionById = {};
  sections.forEach(function (s) { sectionById[s.id] = s; });
  var live = sections.filter(function (s) { return !s.retired; }).sort(function (a, b) { return a.position - b.position; });
  html += '<section class="card">' + cardTitle('Pieces') + live.map(function (s) {
    var mine = pieces.filter(function (p) { return p.sectionId === s.id; });
    var body = s.kind === 'glance' ? '<p class="hint">Built automatically from the events calendar.</p>'
      : mine.map(function (p) { return pieceHtml(p, s, data.reviews[p.id], sent, !!eventOptions); }).join('')
        + (s.kind === 'events' && !sent ? '<button class="btn-sm" type="button" data-act="add-item" data-sid="' + esc(s.id) + '">Add an item</button>'
          + (eventOptions ? '<div class="field gnx-existing"><label>Add an existing event</label>' + pickerHtml('add-existing', s.id, 'Add') + '</div>' : '') : '')
        + (!mine.length && s.kind !== 'events' ? '<p class="hint">Nothing yet.</p>' : '');
    return '<div class="gnx-section" data-sid="' + esc(s.id) + '"><h4>' + esc(s.title) + '</h4>' + body + '</div>';
  }).join('') + '</section>';

  html += '<section class="card">' + cardTitle('Paste sheet') + '<p class="hint">Copy each block and paste it into the matching Mailchimp block. Bold and links come along.</p>'
    + blocks.map(function (b, i) {
      return '<div class="gnx-block"><div class="gnx-blockhead"><strong>' + esc(b.title) + '</strong>'
        + (b.unchanged ? '<span class="pill">Same as last week · skip</span>' : '')
        + '<button class="btn-sm" type="button" data-act="copy-block" data-i="' + i + '">Copy</button></div>'
        + '<div class="gnx-preview">' + (b.html || '<span class="hint">Empty</span>') + '</div>' // sanitized on the server
        + (b.images.length ? '<div class="gnx-imgs">' + b.images.map(function (im) {
          var ok = /^https?:/i.test(im.url || '');
          return '<figure>' + (ok ? '<img src="' + esc(im.url) + '" alt="' + esc(im.alt) + '"><a class="btn-sm" href="' + esc(im.url) + '" download target="_blank" rel="noopener">Download</a>' : '') + '</figure>';
        }).join('') + '</div>' : '') + '</div>';
    }).join('')
    + (sent ? '' : '<div class="btn-row"><button class="btn btn-primary" type="button" data-act="mark-sent">Mark sent</button></div>') + '</section>' + histHtml;
  main.innerHTML = html;

  var byId = {};
  pieces.forEach(function (p) { byId[p.id] = p; });
  var h = {
    'copy-link': function (b) { copyLink(b.getAttribute('data-url')); },
    nudge: function (b) { run(b, function () { return call('POST', '/api/gracenotes/issues/' + encodeURIComponent(issue.id) + '/remind/' + encodeURIComponent(b.getAttribute('data-id'))); }, 'Reminder sent.'); },
    'copy-block': function (b) { var bl = blocks[+b.getAttribute('data-i')]; copyBlock(bl.html, bl.text || plain(bl.html)); },
    'mark-sent': function (b) {
      if (!window.confirm('Mark this issue as sent? It moves into history and the next one copies from it.')) return;
      run(b, function () { return call('POST', '/api/gracenotes/issues/' + encodeURIComponent(issue.id) + '/sent'); }, 'Marked sent.');
    },
    confirm: function (b) { run(b, function () { return call('POST', '/api/gracenotes/pieces/' + encodeURIComponent(b.getAttribute('data-id')) + '/confirm', {}); }, 'Confirmed.'); },
    drop: function (b) {
      if (!window.confirm('Take this out of the issue?')) return;
      run(b, function () { return call('POST', '/api/gracenotes/pieces/' + encodeURIComponent(b.getAttribute('data-id')) + '/drop', {}); }, 'Dropped.');
    },
    edit: function (b) { openEditor(b.closest('.gnx-piece'), byId[b.getAttribute('data-id')], sectionById); },
    'add-item': function (b) { openEditor(b.parentNode.insertBefore(document.createElement('div'), b), null, sectionById, issue.id, b.getAttribute('data-sid')); b.hidden = true; },
    review: function (b) {
      var label = b.textContent;
      b.textContent = 'Reviewing…';
      // On success the page redraws; on failure run() re-enables the button and the label comes back here.
      run(b, function () { return call('POST', '/api/gracenotes/pieces/' + encodeURIComponent(b.getAttribute('data-id')) + '/review', {}); }, null)
        .then(function () { if (b.isConnected) b.textContent = label; }, function () {});
    },
    'add-existing': function (b) {
      var ev = b.parentNode.querySelector('select').value;
      if (!ev) return;
      run(b, function () {
        return call('POST', '/api/gracenotes/issues/' + encodeURIComponent(issue.id) + '/sections/' + encodeURIComponent(b.getAttribute('data-id')) + '/items/from-event', { eventId: ev });
      }, 'Added.');
    },
    'show-link': function (b) {
      b.hidden = true;
      b.insertAdjacentHTML('afterend', pickerHtml('link-event', b.getAttribute('data-id'), 'Link'));
    },
    'link-event': function (b) {
      var ev = b.parentNode.querySelector('select').value;
      if (!ev) return;
      run(b, function () { return call('POST', '/api/gracenotes/pieces/' + encodeURIComponent(b.getAttribute('data-id')) + '/link', { eventId: ev }); }, 'Linked.');
    },
    decide: function (b) {
      b.disabled = true;
      api('POST', '/api/gracenotes/pieces/' + encodeURIComponent(b.getAttribute('data-id')) + '/review/' + encodeURIComponent(b.getAttribute('data-sid')), { decision: b.getAttribute('data-decision') })
        .then(function (d) { if (!d.ok) toast(d.error || 'Couldn’t apply that.', 'err'); else toast(b.getAttribute('data-decision') === 'accepted' ? 'Applied to the letter.' : 'Skipped.', 'ok'); return reload(); });
    },
  };
  wire(main, h);
}

function pieceHtml(p, section, review, sent, canLink) {
  var chip = { carried: ['Not checked', 'pill-pending'], confirmed: ['Confirmed', 'pill-ok'], changed: ['Changed', 'pill-info'], 'new': ['Added', 'pill-info'] }[p.status] || ['', ''];
  var title = p.title || p.eventName || '';
  var d = p.details || {};
  var facts = [rangeOf(p.eventStartDate, p.eventEndDate), d.when, d.place, d.cost, d.contact].filter(Boolean).map(esc).join(' · ');
  var isLetter = section.kind === 'text' && LETTER.test(section.title);
  var h = '<div class="gnx-piece" data-pid="' + esc(p.id) + '"><div class="gnx-piecehead">' + (title ? '<strong>' + esc(title) + '</strong>' : '')
    + '<span class="pill ' + chip[1] + '">' + chip[0] + '</span></div>'
    + (facts ? '<div class="hint">' + facts + '</div>' : '')
    + '<div class="gnx-body">' + (p.bodyHtml || '<span class="hint">No text.</span>') + '</div>' // sanitized on the server
    + (/^https?:/i.test(shownImage(p)) ? '<img class="gnx-thumb" src="' + esc(shownImage(p)) + '" alt="">' : '');
  if (!sent) {
    h += '<div class="gnx-acts">' + (p.status === 'carried' ? '<button class="btn-sm" type="button" data-act="confirm" data-id="' + esc(p.id) + '">Confirm</button>' : '')
      + '<button class="btn-sm" type="button" data-act="edit" data-id="' + esc(p.id) + '">Edit</button>'
      + (section.kind === 'events' ? '<button class="btn-sm" type="button" data-act="drop" data-id="' + esc(p.id) + '">Drop</button>' : '')
      + (section.kind === 'events' && !p.eventId && canLink ? '<button class="btn-sm" type="button" data-act="show-link" data-id="' + esc(p.id) + '">Link to event</button>' : '')
      + (isLetter ? '<button class="btn-sm" type="button" data-act="review" data-id="' + esc(p.id) + '">Review letter</button>' : '') + '</div>';
  }
  if (isLetter && review && review.length) h += reviewHtml(p.id, review, sent);
  return h + '</div>';
}

function reviewHtml(pieceId, list, sent) {
  return '<div class="gnx-review"><div class="hint">Claude suggests; nothing changes until you accept it.</div>' + list.map(function (s) {
    var open = s.state === 'open';
    return '<div class="gnx-sug ' + (s.kind === 'fact' ? 'fact' : 'grammar') + (open ? '' : ' done') + '">'
      + '<span class="pill ' + (s.kind === 'fact' ? 'pill-rejected' : 'pill-info') + '">' + (s.kind === 'fact' ? 'Fact check' : 'Grammar') + '</span> '
      + '<del>' + esc(s.original) + '</del> → <ins>' + esc(s.replacement) + '</ins>'
      + (s.reason ? '<div class="hint">' + esc(s.reason) + '</div>' : '')
      + (s.kind === 'fact' && s.source ? '<div class="hint">Source: ' + esc(s.source) + '</div>' : '')
      + (open && !sent ? '<div class="gnx-acts"><button class="btn-sm" type="button" data-act="decide" data-decision="accepted" data-id="' + esc(pieceId) + '" data-sid="' + esc(s.id) + '">Accept</button>'
        + '<button class="btn-sm" type="button" data-act="decide" data-decision="rejected" data-id="' + esc(pieceId) + '" data-sid="' + esc(s.id) + '">Reject</button></div>'
        : '<div class="hint">' + (s.state === 'missed' ? 'That sentence has changed since the review. Edit it by hand.' : s.state === 'accepted' ? 'Accepted' : s.state === 'rejected' ? 'Rejected' : '') + '</div>')
      + '</div>';
  }).join('') + '</div>';
}

// Edit in place (or add, when piece is null). Mitchell may edit any piece.
function openEditor(box, p, sectionById, issueId, sid) {
  var section = p ? sectionById[p.sectionId] : sectionById[sid];
  var isEvents = section.kind === 'events';
  var d = Object.assign({}, p ? p.details : {});
  var ed = makeEditor(p ? p.bodyHtml : '');
  box.className = 'gnx-piece editing';
  // R20: text sections have no heading field; the Mailchimp block has its own.
  box.innerHTML = (isEvents ? '<div class="field"><label>Name</label><input type="text" class="gnx-title"></div>' : '')
    + (isEvents ? '<div class="field"><label>Date</label><input type="date" class="gnx-date"></div>' : '') + '<div class="field gnx-edwrap"><label>Text</label></div>'
    + (isEvents ? '<div class="row2">' + [['when', 'Time'], ['place', 'Place'], ['cost', 'Cost'], ['contact', 'Contact'], ['link', 'Web link'], ['linkLabel', 'Link words']].map(function (x) {
      return '<div class="field"><label>' + x[1] + '</label><input type="text" data-d="' + x[0] + '"></div>';
    }).join('') + '</div>' : '')
    + '<div class="field"><label>Picture address (optional)</label><input type="text" class="gnx-img" placeholder="https://…"></div>'
    + '<div class="gnx-acts"><button class="btn btn-primary" type="button" data-x="save">Save</button><button class="btn btn-secondary" type="button" data-x="cancel">Cancel</button></div>';
  box.querySelector('.gnx-edwrap').appendChild(ed.node);
  if (isEvents) box.querySelector('.gnx-title').value = p ? p.title || p.eventName || '' : '';
  if (isEvents) box.querySelector('.gnx-date').value = p && p.eventStartDate ? p.eventStartDate.slice(0, 10) : '';
  box.querySelectorAll('[data-d]').forEach(function (i) { i.value = d[i.getAttribute('data-d')] || ''; });
  var startImg = p ? shownImage(p) : '';
  box.querySelector('.gnx-img').value = startImg;
  box.querySelector('[data-x=cancel]').onclick = function (e) { e.stopPropagation(); reload(); };
  box.querySelector('[data-x=save]').onclick = function (e) {
    e.stopPropagation();
    var payload = { bodyHtml: ed.html() };
    // Only a changed picture is sent, so saving never wipes the event's picture (as in contributor.js).
    var img = box.querySelector('.gnx-img').value.trim();
    if (img !== startImg) payload.imageUrl = img;
    if (isEvents) {
      payload.title = box.querySelector('.gnx-title').value.trim();
      var date = box.querySelector('.gnx-date').value;
      if (date) payload.startDate = date;
      box.querySelectorAll('[data-d]').forEach(function (i) { var v = i.value.trim(); if (v) d[i.getAttribute('data-d')] = v; else delete d[i.getAttribute('data-d')]; });
      payload.details = d;
      if (!p && !payload.title) return toast('Give the item a name first.', 'err');
    }
    var url = p ? '/api/gracenotes/pieces/' + encodeURIComponent(p.id) + '/edit'
      : '/api/gracenotes/issues/' + encodeURIComponent(issueId) + '/sections/' + encodeURIComponent(sid) + '/items';
    run(e.currentTarget, function () { return call('POST', url, payload); }, 'Saved.');
  };
}

// ── people ───────────────────────────────────────────────────────────────────
function renderPeople(main) {
  return Promise.all([call('GET', '/api/gracenotes/contributors'), call('GET', '/api/gracenotes/sections')]).then(function (r) {
    var people = r[0].contributors, sections = r[1].sections.filter(function (s) { return !s.retired && s.kind !== 'glance'; });
    var live = people.filter(function (p) { return !p.retired; }), gone = people.filter(function (p) { return p.retired; });
    main.innerHTML = nav('people') + '<section class="card">' + cardTitle('Add a person')
      + '<div class="row2"><div class="field"><label for="gnx-pn">Name</label><input id="gnx-pn" type="text"></div>'
      + '<div class="field"><label for="gnx-pe">Email</label><input id="gnx-pe" type="email"></div></div>'
      + '<div class="btn-row"><button class="btn btn-primary" type="button" data-act="add-person">Add</button></div></section>'
      + '<section class="card">' + cardTitle('People') + (live.length ? live.map(function (p) {
        var owns = sections.filter(function (s) { return s.ownerIds.indexOf(p.id) >= 0; });
        return '<div class="gnx-person" data-id="' + esc(p.id) + '"><div class="gnx-row"><strong>' + esc(p.name) + '</strong><span class="hint">' + esc(p.email || 'no email') + '</span>'
          + '<button class="btn-sm" type="button" data-act="copy-link" data-url="' + esc(p.link) + '">Copy link</button>'
          + '<button class="btn-sm" type="button" data-act="edit-person" data-id="' + esc(p.id) + '">Edit</button>'
          + '<button class="btn-sm" type="button" data-act="retire-person" data-id="' + esc(p.id) + '">Retire</button></div>'
          + '<div class="gnx-owns hint">Owns: ' + (sections.length ? sections.map(function (s) {
            return '<label><input type="checkbox" data-act="own" data-sid="' + esc(s.id) + '" data-id="' + esc(p.id) + '"' + (owns.indexOf(s) >= 0 ? ' checked' : '') + '> ' + esc(s.title) + '</label>';
          }).join(' ') : 'no sections yet') + '</div></div>';
      }).join('') : '<p class="hint">No one yet.</p>') + '</section>'
      + (gone.length ? '<section class="card">' + cardTitle('Retired') + gone.map(function (p) { return '<div class="gnx-row">' + esc(p.name) + '</div>'; }).join('') + '</section>' : '');
    var byId = {}, secById = {};
    people.forEach(function (p) { byId[p.id] = p; });
    sections.forEach(function (s) { secById[s.id] = s; });
    wire(main, {
      'copy-link': function (b) { copyLink(b.getAttribute('data-url')); },
      'add-person': function (b) {
        var name = document.getElementById('gnx-pn').value.trim(), email = document.getElementById('gnx-pe').value.trim();
        if (!name) return toast('Add a name first.', 'err');
        run(b, function () { return call('POST', '/api/gracenotes/contributors', { name: name, email: email }); }, 'Added.');
      },
      'edit-person': function (b) {
        var p = byId[b.getAttribute('data-id')];
        var name = window.prompt('Name:', p.name);
        if (name == null) return;
        var email = window.prompt('Email:', p.email);
        if (email == null) return;
        run(b, function () { return call('PATCH', '/api/gracenotes/contributors/' + encodeURIComponent(p.id), { name: name.trim(), email: email.trim() }); }, 'Saved.');
      },
      'retire-person': function (b) {
        var p = byId[b.getAttribute('data-id')];
        if (!window.confirm('Retire ' + p.name + '? Their old link will stop working.')) return;
        run(b, function () { return call('POST', '/api/gracenotes/contributors/' + encodeURIComponent(p.id) + '/retire', {}); }, 'Retired.');
      },
      own: function (cb) {
        var s = secById[cb.getAttribute('data-sid')], id = cb.getAttribute('data-id');
        var ids = s.ownerIds.filter(function (x) { return x !== id; });
        if (cb.checked) ids.push(id);
        call('PUT', '/api/gracenotes/sections/' + encodeURIComponent(s.id) + '/owners', { contributorIds: ids }).then(function () { toast('Saved.', 'ok'); return reload(); }, function (e) { fail(e); return reload(); });
      },
    });
  }).catch(function (e) { main.innerHTML = nav('people') + '<div class="alert alert-err">' + esc(e.message) + '</div>'; });
}

// ── sections ─────────────────────────────────────────────────────────────────
function renderSections(main) {
  return Promise.all([call('GET', '/api/gracenotes/sections'), call('GET', '/api/gracenotes/contributors')]).then(function (r) {
    var all = r[0].sections.slice().sort(function (a, b) { return a.position - b.position; });
    var people = r[1].contributors.filter(function (p) { return !p.retired; });
    var live = all.filter(function (s) { return !s.retired; }), gone = all.filter(function (s) { return s.retired; });
    main.innerHTML = nav('sections') + '<section class="card">' + cardTitle('Add a section')
      + '<div class="row2"><div class="field"><label for="gnx-st">Title</label><input id="gnx-st" type="text"></div>'
      + '<div class="field"><label for="gnx-sk">Kind</label><select id="gnx-sk">' + Object.keys(KINDS).map(function (k) { return '<option value="' + k + '">' + esc(KINDS[k]) + '</option>'; }).join('') + '</select></div></div>'
      + '<div class="btn-row"><button class="btn btn-primary" type="button" data-act="add-section">Add</button></div></section>'
      + '<section class="card">' + cardTitle('Sections, in email order') + (live.length ? live.map(function (s, i) {
        return '<div class="gnx-person"><div class="gnx-row"><strong>' + esc(s.title) + '</strong><span class="hint">' + esc(KINDS[s.kind] || s.kind) + '</span>'
          + '<button class="btn-sm" type="button" aria-label="Move up" data-act="move" data-dir="-1" data-id="' + esc(s.id) + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>'
          + '<button class="btn-sm" type="button" aria-label="Move down" data-act="move" data-dir="1" data-id="' + esc(s.id) + '"' + (i === live.length - 1 ? ' disabled' : '') + '>↓</button>'
          + '<button class="btn-sm" type="button" data-act="rename" data-id="' + esc(s.id) + '">Rename</button>'
          + '<button class="btn-sm" type="button" data-act="retire-section" data-id="' + esc(s.id) + '">Retire</button></div>'
          + (s.kind === 'glance' ? '' : '<div class="gnx-owns hint">Owners: ' + (people.length ? people.map(function (p) {
            return '<label><input type="checkbox" data-act="own" data-sid="' + esc(s.id) + '" data-id="' + esc(p.id) + '"' + (s.ownerIds.indexOf(p.id) >= 0 ? ' checked' : '') + '> ' + esc(p.name) + '</label>';
          }).join(' ') : 'add people first') + '</div>') + '</div>';
      }).join('') : '<p class="hint">No sections yet.</p>') + '</section>'
      + (gone.length ? '<section class="card">' + cardTitle('Retired') + gone.map(function (s) {
        return '<div class="gnx-row">' + esc(s.title) + '<button class="btn-sm" type="button" data-act="restore" data-id="' + esc(s.id) + '">Restore</button></div>';
      }).join('') + '</section>' : '');
    var byId = {};
    all.forEach(function (s) { byId[s.id] = s; });
    var patch = function (b, body, msg) { run(b, function () { return call('PATCH', '/api/gracenotes/sections/' + encodeURIComponent(b.getAttribute('data-id')), body); }, msg); };
    wire(main, {
      'add-section': function (b) {
        var title = document.getElementById('gnx-st').value.trim();
        if (!title) return toast('Give the section a title.', 'err');
        run(b, function () { return call('POST', '/api/gracenotes/sections', { title: title, kind: document.getElementById('gnx-sk').value }); }, 'Added.');
      },
      move: function (b) {
        var ids = live.map(function (s) { return s.id; }), i = ids.indexOf(b.getAttribute('data-id')), j = i + Number(b.getAttribute('data-dir'));
        if (j < 0 || j >= ids.length) return;
        ids.splice(j, 0, ids.splice(i, 1)[0]);
        run(b, function () { return call('POST', '/api/gracenotes/sections/order', { ids: ids.concat(gone.map(function (s) { return s.id; })) }); }, null);
      },
      rename: function (b) {
        var t = window.prompt('New title:', byId[b.getAttribute('data-id')].title);
        if (t && t.trim()) patch(b, { title: t.trim() }, 'Renamed.');
      },
      'retire-section': function (b) {
        if (window.confirm('Retire this section? It stops appearing in new issues.')) patch(b, { retired: true }, 'Retired.');
      },
      restore: function (b) { patch(b, { retired: false }, 'Restored.'); },
      own: function (cb) {
        var s = byId[cb.getAttribute('data-sid')], id = cb.getAttribute('data-id');
        var ids = s.ownerIds.filter(function (x) { return x !== id; });
        if (cb.checked) ids.push(id);
        call('PUT', '/api/gracenotes/sections/' + encodeURIComponent(s.id) + '/owners', { contributorIds: ids }).then(function () { toast('Saved.', 'ok'); return reload(); }, function (e) { fail(e); return reload(); });
      },
    });
  }).catch(function (e) { main.innerHTML = nav('sections') + '<div class="alert alert-err">' + esc(e.message) + '</div>'; });
}

window.GraceNotes = { render: render };
})();
