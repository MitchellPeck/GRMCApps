// ── HTTP helpers ────────────────────────────────────────────────────────────
// Always resolves to an object with a boolean `ok`. Without this, a 500 (or a
// proxy's HTML error page) came back as a payload with no `ok` field at all,
// and any caller testing `res.ok === false` read the failure as success — which
// is how a delete that never happened could still close its dialog and report
// nothing. A failed request is now indistinguishable from `{ok:false}`.
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return normalizeApiResult(res);
}
async function normalizeApiResult(res){
  var data = null;
  try { data = await res.json(); } catch(e){ data = null; }
  if(data && typeof data.ok === 'boolean') return data;
  if(res.ok) return data && typeof data === 'object' ? data : { ok: true };
  var detail = (data && (data.error || data.message)) || (res.statusText || '');
  return { ok: false, error: 'Request failed (' + res.status + (detail ? ': ' + detail : '') + ').' };
}

async function apiForm(path, formData) {
  const res = await fetch(path, { method: 'POST', body: formData });
  return normalizeApiResult(res);
}
function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function v(id){ var el=document.getElementById(id); return el ? el.value.trim() : ''; }
function setBtn(id, loading, label){
  var b = document.getElementById(id); if(!b) return;
  if(loading){ b.disabled=true; b.innerHTML='<span class="spin"></span> '+(label||'Working...'); }
  else { b.disabled=false; b.textContent=b.getAttribute('data-default')||label||'Submit'; }
}
function msg(id, kind, text){
  var el=document.getElementById(id); if(!el) return;
  el.innerHTML = text ? '<div class="alert alert-'+kind+'">'+esc(text)+'</div>' : '';
}
function fmtDate(s){ if(!s) return ''; try { return new Date(s).toLocaleString(); } catch(e){ return s; } }

// ── Modal ───────────────────────────────────────────────────────────────────
// One shared dialog for every edit flow. Fields are declared as data; onSave
// receives the collected values plus a done(errorOrNull) callback so it can
// keep the modal open and show a server error.
var modalEsc = null;
// The word that unlocks any destructive modal action. Compared case-insensitively.
var DANGER_WORD = 'DELETE';

function closeModal(){
  var root=document.getElementById('modal-root');
  if(root) root.innerHTML='';
  if(modalEsc){ document.removeEventListener('keydown', modalEsc); modalEsc=null; }
}

function modalFieldHtml(f){
  var id='mf-'+f.id;
  if(f.type==='checkbox'){
    return '<div class="field modal-check"><input type="checkbox" id="'+id+'"'+(f.value?' checked':'')+'>'
      +'<label for="'+id+'" style="margin:0">'+esc(f.label)+'</label></div>';
  }
  var input;
  if(f.type==='textarea'){
    input='<textarea id="'+id+'" placeholder="'+esc(f.placeholder||'')+'">'+esc(f.value||'')+'</textarea>';
  } else if(f.type==='select'){
    input='<select id="'+id+'">'+(f.options||[]).map(function(o){
      return '<option value="'+esc(o.value)+'"'+(String(o.value)===String(f.value)?' selected':'')+'>'+esc(o.label)+'</option>';
    }).join('')+'</select>';
  } else {
    input='<input type="text" id="'+id+'" value="'+esc(f.value||'')+'" placeholder="'+esc(f.placeholder||'')+'">';
  }
  return '<div class="field"><label for="'+id+'">'+esc(f.label)+'</label>'+input+'</div>';
}

function openModal(opts){
  closeModal();
  var root=document.getElementById('modal-root');
  if(!root) return;
  var fields=opts.fields||[];
  var h='<div class="modal-backdrop" id="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">'
    +'<h3>'+esc(opts.title)+'</h3>'
    +'<div id="modal-msg"></div>'
    +fields.map(modalFieldHtml).join('');
  if(opts.danger){
    h+='<div class="modal-danger"><div class="hint">'+esc(opts.danger.hint)+'</div>'
      +'<div class="field"><label for="mf-danger-confirm">Type <strong>'+DANGER_WORD+'</strong> to confirm</label>'
      +'<input type="text" id="mf-danger-confirm" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="'+DANGER_WORD+'"></div>'
      +'<button class="btn btn-danger" id="modal-danger-btn" data-default="'+esc(opts.danger.label)+'" disabled>'+esc(opts.danger.label)+'</button></div>';
  }
  h+='<div class="modal-actions">'
    +'<button class="btn btn-secondary" id="modal-cancel">Cancel</button>'
    +'<button class="btn btn-primary" id="modal-save" data-default="'+esc(opts.saveLabel||'Save')+'">'+esc(opts.saveLabel||'Save')+'</button>'
    +'</div></div></div>';
  root.innerHTML=h;

  function values(){
    var out={};
    fields.forEach(function(f){
      var el=document.getElementById('mf-'+f.id);
      if(!el) return;
      out[f.id] = f.type==='checkbox' ? el.checked : el.value;
    });
    return out;
  }
  function done(err){
    if(err){
      setBtn('modal-save', false); setBtn('modal-danger-btn', false);
      // A failed action must never leave the danger gate open: re-apply the
      // typed-confirmation check after the reset.
      dangerGate();
      msg('modal-msg','err',err);
      return;
    }
    closeModal();
  }
  function save(){
    var vals=values();
    var missing=fields.filter(function(f){ return f.required && !String(vals[f.id]||'').trim(); })[0];
    if(missing){ msg('modal-msg','err',missing.label+' is required.'); return; }
    msg('modal-msg','',''); setBtn('modal-save', true, 'Saving...');
    opts.onSave(vals, done);
  }

  // The danger gate. This deliberately does NOT ask the user to retype the
  // record's name: titles come out of AI agenda extraction carrying em dashes,
  // curly quotes and double spaces, and a character-exact match made those
  // records impossible to delete at all. One fixed, plain-ASCII word is
  // typeable no matter what the record is called. `dangerGate` is re-run from
  // `done()` too, so a failed action can never leave the gate open.
  var confirmEl=null, dangerBtn=null;
  function dangerReady(){
    return !!(opts.danger && confirmEl && confirmEl.value.trim().toUpperCase()===DANGER_WORD);
  }
  function dangerGate(){
    if(dangerBtn) dangerBtn.disabled = !dangerReady();
  }
  function runDanger(){
    if(!dangerReady()) return;
    msg('modal-msg','','');
    setBtn('modal-danger-btn', true, 'Deleting...');
    opts.danger.onConfirm(done);
  }

  document.getElementById('modal-save').addEventListener('click', save);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', function(e){
    if(e.target && e.target.id==='modal-backdrop') closeModal();
  });
  modalEsc=function(e){
    if(e.key==='Escape'){ closeModal(); return; }
    if(e.key!=='Enter' || !e.target || e.target.tagName==='TEXTAREA') return;
    // Enter inside the confirmation box means "do the dangerous thing", never
    // "save". Routing it to save() silently saved the meeting and closed the
    // dialog, which read as "delete does not work".
    if(e.target===confirmEl){ e.preventDefault(); runDanger(); return; }
    save();
  };
  document.addEventListener('keydown', modalEsc);

  if(opts.danger){
    confirmEl=document.getElementById('mf-danger-confirm');
    dangerBtn=document.getElementById('modal-danger-btn');
    confirmEl.addEventListener('input', dangerGate);
    dangerBtn.addEventListener('click', runDanger);
  }

  var first=fields[0];
  if(first){ var fe=document.getElementById('mf-'+first.id); if(fe) fe.focus(); }
}

// Minimal, safe Markdown → HTML (headings, bullets, bold, paragraphs).
function renderMarkdown(md){
  var lines = String(md||'').split(/\r?\n/), out=[], inList=false;
  function closeList(){ if(inList){ out.push('</ul>'); inList=false; } }
  function inline(t){
    return esc(t).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
                 .replace(/`(.+?)`/g,'<code>$1</code>');
  }
  for(var i=0;i<lines.length;i++){
    var ln=lines[i];
    var h=ln.match(/^(#{1,3})\s+(.*)$/);
    if(h){ closeList(); out.push('<h'+h[1].length+'>'+inline(h[2])+'</h'+h[1].length+'>'); continue; }
    var b=ln.match(/^\s*[-*]\s+(.*)$/);
    if(b){
      if(!inList){ out.push('<ul>'); inList=true; }
      var box=b[1].match(/^\[ \]\s+(.*)$/);
      out.push(box ? '<li class="todo">&#9744; '+inline(box[1])+'</li>' : '<li>'+inline(b[1])+'</li>');
      continue;
    }
    if(ln.trim()===''){ closeList(); continue; }
    closeList(); out.push('<p>'+inline(ln)+'</p>');
  }
  closeList();
  return out.join('');
}

// ── App state ───────────────────────────────────────────────────────────────
var state = { people: [], peopleById: {}, meeting: null, attendeeIds: [], items: [] };

// ── Tabs / views ────────────────────────────────────────────────────────────
function switchTab(id){
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('.panel').forEach(function(p){ p.classList.remove('active'); });
  var t=document.querySelector('[data-tab="'+id+'"]'); if(t) t.classList.add('active');
  var p=document.getElementById('p-'+id); if(p) p.classList.add('active');
  if(id==='meetings') loadMeetings();
  if(id==='people') loadPeople();
  if(id==='settings') loadSettings();
}
document.querySelectorAll('.tab').forEach(function(t){
  t.addEventListener('click', function(){ switchTab(t.getAttribute('data-tab')); });
});
function showList(){
  stopRecording();
  stopPolling();
  // Summarize the item left open, so nothing is lost on the way out.
  if(state.openItemId && state.items){
    var open=state.items.filter(function(x){return x.id===state.openItemId;})[0];
    if(open) summarizeIfNeeded(open);
  }
  document.getElementById('view-detail').style.display='none';
  document.getElementById('view-list').style.display='block';
  loadMeetings();
}
function showDetail(){
  document.getElementById('view-list').style.display='none';
  document.getElementById('view-detail').style.display='block';
}
document.getElementById('btn-back').addEventListener('click', showList);

// ── Identity ────────────────────────────────────────────────────────────────
function loadMe(){
  api('/api/me').then(function(m){
    document.getElementById('me-label').textContent = m.name || m.email || '';
  }).catch(function(){});
}

// ── Meetings list ───────────────────────────────────────────────────────────
function loadMeetings(){
  var el=document.getElementById('meetings-list');
  api('/api/meetings').then(function(res){
    if(!res.ok){ el.innerHTML='<div class="alert alert-err">'+esc(res.error)+'</div>'; return; }
    if(!res.meetings.length){ el.innerHTML='<div class="empty">No meetings yet. Create one above.</div>'; return; }
    el.innerHTML = res.meetings.map(function(m){
      var status = m.status==='completed' ? '<span class="badge b-approved">completed</span>'
                 : m.status==='in_progress' ? '<span class="badge b-changes_requested">in progress</span>'
                 : '<span class="badge b-pending">draft</span>';
      var meta=[m.meeting_date, m.location].filter(Boolean).map(esc).join(' &middot; ');
      return '<div class="mcard" data-id="'+m.id+'">'
        +'<div class="mhead"><div><div class="mtitle">'+esc(m.title)+'</div>'
        +(meta?'<div class="mmeta">'+meta+'</div>':'')+'</div>'+status+'</div>'
        +'<div class="mstats"><span>'+m.item_count+' agenda item'+(m.item_count===1?'':'s')+'</span>'
        +'<span>'+m.attendee_count+' present</span>'
        +(m.report_generated_at?'<span>report ready</span>':'')+'</div></div>';
    }).join('');
    el.querySelectorAll('.mcard').forEach(function(c){
      c.addEventListener('click', function(){ openMeeting(Number(c.getAttribute('data-id'))); });
    });
  }).catch(function(e){ el.innerHTML='<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

document.getElementById('btn-new-meeting').addEventListener('click', function(){
  if(!v('m-title')){ msg('new-msg','err','A title is required.'); return; }
  setBtn('btn-new-meeting', true, 'Creating...');
  api('/api/meetings', { method:'POST', body:{
    title:v('m-title'), meetingDate:v('m-date'), location:v('m-loc'), description:v('m-desc')
  }}).then(function(res){
    setBtn('btn-new-meeting', false);
    if(!res.ok){ msg('new-msg','err',res.error); return; }
    ['m-title','m-date','m-loc','m-desc'].forEach(function(id){ document.getElementById(id).value=''; });
    msg('new-msg','ok','Meeting created.');
    openMeeting(res.id);
  }).catch(function(e){ setBtn('btn-new-meeting', false); msg('new-msg','err',e.message); });
});

// ── People library ──────────────────────────────────────────────────────────
function loadPeople(){
  var el=document.getElementById('people-list');
  return api('/api/people?all=1').then(function(res){
    if(!res.ok){ el.innerHTML='<div class="alert alert-err">'+esc(res.error)+'</div>'; return; }
    if(!res.people.length){ el.innerHTML='<div class="empty">No people yet.</div>'; return; }
    el.innerHTML = res.people.map(function(p){
      var sub=[p.title, p.email].filter(Boolean).map(esc).join(' &middot; ');
      return '<div class="person-row'+(p.active?'':' off')+'">'
        +'<div><div class="person-name">'+esc(p.name)+'</div>'
        +(sub?'<div class="person-sub">'+sub+'</div>':'')+'</div>'
        +'<div class="person-actions">'
        +'<button class="btn-sm" data-edit="'+p.id+'">Edit</button>'
        +'<button class="btn-sm" data-toggle="'+p.id+'" data-active="'+(!p.active)+'">'+(p.active?'Deactivate':'Reactivate')+'</button>'
        +'</div></div>';
    }).join('');
    el.querySelectorAll('[data-toggle]').forEach(function(b){
      b.addEventListener('click', function(){
        api('/api/people/'+b.getAttribute('data-toggle')+'/active',
          { method:'POST', body:{ active: b.getAttribute('data-active')==='true' } }).then(loadPeople);
      });
    });
    el.querySelectorAll('[data-edit]').forEach(function(b){
      b.addEventListener('click', function(){ editPerson(Number(b.getAttribute('data-edit')), res.people); });
    });
  }).catch(function(e){ el.innerHTML='<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

function editPerson(id, people){
  var p = people.filter(function(x){ return x.id===id; })[0]; if(!p) return;
  openModal({
    title: 'Edit person',
    fields: [
      { id:'name', label:'Name', type:'text', value:p.name, required:true },
      { id:'title', label:'Role / title', type:'text', value:p.title||'', placeholder:'e.g. Treasurer' },
      { id:'email', label:'Email', type:'text', value:p.email||'', placeholder:'name@grmc.org' },
      { id:'active', label:'Active (appears in attendee lists)', type:'checkbox', value:!!p.active }
    ],
    onSave: function(v, done){
      api('/api/people/'+id, { method:'PUT', body:{
        name:v.name, title:v.title, email:v.email, active:v.active
      }}).then(function(res){
        if(!res.ok){ done(res.error||'Could not save.'); return; }
        done(null);
        loadPeople();
      }).catch(function(e){ done(e.message); });
    }
  });
}

document.getElementById('btn-add-person').addEventListener('click', function(){
  if(!v('pr-name')){ msg('person-msg','err','A name is required.'); return; }
  setBtn('btn-add-person', true, 'Adding...');
  api('/api/people', { method:'POST', body:{ name:v('pr-name'), title:v('pr-title'), email:v('pr-email') } })
    .then(function(res){
      setBtn('btn-add-person', false);
      if(!res.ok){ msg('person-msg','err',res.error); return; }
      ['pr-name','pr-title','pr-email'].forEach(function(id){ document.getElementById(id).value=''; });
      msg('person-msg','ok','Added.');
      loadPeople();
    }).catch(function(e){ setBtn('btn-add-person', false); msg('person-msg','err',e.message); });
});

// ── Settings ────────────────────────────────────────────────────────────────
function loadSettings(){
  api('/api/settings').then(function(res){
    if(!res.ok) return;
    document.getElementById('s-anthropic-hint').innerHTML = res.hasAnthropicKey
      ? 'Saved (' + esc(res.anthropicKeyHint) + '). Enter a new key to replace it.'
      : 'Used to extract agendas, summarize items, and write the report.';
  });
}
document.getElementById('btn-save-settings').addEventListener('click', function(){
  setBtn('btn-save-settings', true, 'Saving...');
  api('/api/settings', { method:'POST', body:{ anthropicKey:v('s-anthropic') } })
    .then(function(res){
      setBtn('btn-save-settings', false);
      if(!res.ok){ msg('settings-msg','err',res.error); return; }
      document.getElementById('s-anthropic').value='';
      msg('settings-msg','ok','Saved.');
      loadSettings();
    }).catch(function(e){ setBtn('btn-save-settings', false); msg('settings-msg','err',e.message); });
});

// ══════════════════════════════════════════════════════════════════════════
//  MEETING DETAIL
// ══════════════════════════════════════════════════════════════════════════
function personName(id){ var p=state.peopleById[id]; return p ? p.name : '#'+id; }

function openMeeting(id){
  stopRecording();
  stopPolling();
  showDetail();
  document.getElementById('detail-body').innerHTML='<div class="empty">Loading&hellip;</div>';
  Promise.all([ api('/api/people?all=1'), api('/api/meetings/'+id) ]).then(function(r){
    var peopleRes=r[0], det=r[1];
    if(!det.ok){ document.getElementById('detail-body').innerHTML='<div class="alert alert-err">'+esc(det.error)+'</div>'; return; }
    state.people = (peopleRes.ok?peopleRes.people:[]);
    state.peopleById = {}; state.people.forEach(function(p){ state.peopleById[p.id]=p; });
    state.meeting = det.meeting;
    state.attendeeIds = det.attendeeIds;
    state.items = det.items;
    state.meetingRecordings = det.meetingRecordings || [];
    state.meetingSpeakerStats = det.meetingSpeakerStats || [];
    state.guests = det.guests || [];
    state.report = det.report || null;
    renderDetail();
    if(anyPendingWork()) startPolling();
  });
}

function renderDetail(){
  var m=state.meeting;
  var meta=[m.meeting_date, m.location].filter(Boolean).map(esc).join(' &middot; ');
  var h='';
  // Header
  h+='<div class="dhead"><h2 id="d-title-txt">'+esc(m.title)+'</h2>'
    +(meta?'<div class="dmeta" id="d-meta-txt">'+meta+'</div>':'<div class="dmeta" id="d-meta-txt"></div>')
    +'<div class="dedit"><button class="btn-sm" id="btn-edit-meeting">Edit details</button></div></div>';

  // Attendees
  h+='<div class="card"><div class="ct">Who is present?</div>'
    +'<div class="hint" style="margin-bottom:8px">Select who is present from the people library (add more under the People tab). Anyone not selected is recorded as absent. Attendees become selectable as presenters below.</div>'
    +'<div class="chips" id="attendee-chips"></div>'
    +'<div class="hint" id="absent-line" style="margin-top:8px"></div>'
    +'<div class="sublbl">Guests</div>'
    +'<div class="hint" style="margin-bottom:6px">Visitors for this meeting only. Guests count as present and can be named as speakers or chosen as presenters on an agenda item.</div>'
    +'<div class="chips" id="guest-chips"></div>'
    +'<div id="guest-msg"></div>'
    +'<div class="guest-add"><input type="text" id="g-name" placeholder="Guest name">'
    +'<input type="text" id="g-title" placeholder="Role (optional)">'
    +'<button class="btn-sm" id="btn-add-guest" data-default="Add guest">Add guest</button></div>'
    +'</div>';

  // Meeting recording
  h+='<div class="card"><div class="ct">Meeting recording</div>'
    +'<div id="mrec-msg"></div>'
    +'<div class="btn-row"><button class="btn btn-primary" id="btn-meeting-rec" data-default="● Record meeting">● Record meeting</button>'
    +'<span class="rec-status" id="mrec-status"></span></div>'
    +'<div class="hint">One recording for the whole meeting. Open each topic as you discuss it — that click files the audio under the right topic. Processing starts when you stop.</div>'
    +'<div id="mrec-extra"></div></div>';

  // Meeting-wide speaker naming (populated once transcripts with meeting-wide
  // speaker labels exist; empty until then)
  h+='<div id="meeting-speakers"></div>';

  // Agenda upload
  h+='<div class="card"><div class="ct">Agenda</div>'
    +'<div id="agenda-msg"></div>'
    +(m.agenda_file_name?'<div class="hint" style="margin-bottom:8px">Loaded from: '+esc(m.agenda_file_name)+'</div>':'')
    +'<div class="field"><label>Upload agenda (PDF, image, or text)</label>'
    +'<input type="file" id="agenda-file" accept="application/pdf,image/png,image/jpeg,image/webp,image/gif,text/plain,.txt,.md"></div>'
    +'<div class="btn-row"><button class="btn btn-primary" id="btn-upload-agenda" data-default="Extract agenda items">Extract agenda items</button>'
    +'<button class="btn btn-secondary" id="btn-add-item" data-default="Add item manually">Add item manually</button></div>'
    +'<div class="hint" style="margin-top:6px">Uploading replaces the current agenda items.</div></div>';

  // Agenda items (the run-the-meeting flow)
  h+='<div class="section-title">Run the meeting</div>';
  h+='<div id="items-wrap"></div>';

  // Report
  h+='<hr class="hr"><div class="section-title">Report</div>'
    +'<div id="report-msg"></div>'
    +'<div id="report-stale"></div>'
    +'<div class="btn-row"><button class="btn btn-gold" id="btn-report" data-default="Generate report">Generate report</button>'
    +'<span id="report-actions" style="display:none">'
    // A plain link in a new tab: the server sends it through Google consent
    // if needed, then on to the new Doc, with no popup blocker involved.
    +'<a class="btn btn-secondary" id="btn-report-gdoc" href="/api/meetings/'+m.id+'/google-doc" target="_blank" rel="noopener">Open in Google Docs</a> '
    +'<button class="btn btn-secondary" id="btn-report-print">Print PDF</button>'
    +'</span></div>'
    +'<div class="hint" id="report-hint">The report waits for any transcription and summaries still in progress, then writes itself. You can close this page meanwhile.</div>'
    +'<div id="report-box" style="margin-top:14px">'+(m.report?'<div class="report">'+renderMarkdown(m.report)+'</div>':'')+'</div>';

  document.getElementById('detail-body').innerHTML=h;

  renderAttendeeChips();
  renderGuests();
  renderItems();
  renderMeetingRecUi();
  renderMeetingSpeakerPanel();

  document.getElementById('btn-edit-meeting').addEventListener('click', editMeeting);
  document.getElementById('btn-upload-agenda').addEventListener('click', uploadAgenda);
  document.getElementById('btn-add-item').addEventListener('click', addItemManually);
  document.getElementById('btn-meeting-rec').addEventListener('click', toggleMeetingRecording);
  document.getElementById('btn-report').addEventListener('click', generateReport);
  document.getElementById('btn-report-print').addEventListener('click', function(){ window.print(); });
  document.getElementById('btn-add-guest').addEventListener('click', addGuest);
  document.getElementById('g-name').addEventListener('keydown', function(e){ if(e.key==='Enter') addGuest(); });
  document.getElementById('g-title').addEventListener('keydown', function(e){ if(e.key==='Enter') addGuest(); });
  renderReportState();
}

function editMeeting(){
  var m=state.meeting;
  openModal({
    title: 'Edit meeting',
    fields: [
      { id:'title', label:'Title', type:'text', value:m.title, required:true },
      { id:'date', label:'Date', type:'text', value:m.meeting_date||'', placeholder:'e.g. 2026-04-14 or Apr 14, 7pm' },
      { id:'loc', label:'Location', type:'text', value:m.location||'', placeholder:'e.g. Fellowship Hall / Zoom' },
      { id:'desc', label:'Description', type:'textarea', value:m.description||'' },
      { id:'status', label:'Status', type:'select', value:m.status||'draft', options:[
        { value:'draft', label:'Draft' },
        { value:'in_progress', label:'In progress' },
        { value:'completed', label:'Completed' }
      ]}
    ],
    onSave: function(v, done){
      api('/api/meetings/'+m.id, { method:'PATCH', body:{
        title:v.title, meetingDate:v.date, location:v.loc, description:v.desc, status:v.status
      }}).then(function(res){
        if(!res.ok){ done(res.error||'Could not save.'); return; }
        m.title=v.title.trim(); m.meeting_date=v.date.trim();
        m.location=v.loc.trim(); m.description=v.desc.trim(); m.status=v.status;
        document.getElementById('d-title-txt').textContent=m.title;
        document.getElementById('d-meta-txt').innerHTML=[m.meeting_date,m.location].filter(Boolean).map(esc).join(' &middot; ');
        done(null);
        refreshReportSoon();
      }).catch(function(e){ done(e.message); });
    },
    danger: {
      label: 'Delete meeting',
      // openModal escapes this, so pass the raw title.
      hint: 'Deleting “'+m.title+'” also deletes its agenda items, transcripts, recordings, and report. This cannot be undone.',
      onConfirm: function(done){
        api('/api/meetings/'+m.id, { method:'DELETE' }).then(function(res){
          if(!res || !res.ok){ done((res && res.error) || 'Could not delete.'); return; }
          done(null);
          showList();
        }).catch(function(e){ done(e.message); });
      }
    }
  });
}

// ── Attendees ───────────────────────────────────────────────────────────────
function renderAttendeeChips(){
  var el=document.getElementById('attendee-chips');
  var active=state.people.filter(function(p){ return p.active || state.attendeeIds.indexOf(p.id)>=0; });
  if(!active.length){ el.innerHTML='<span class="chip empty-hint">No people in the library yet — add some under the People tab.</span>'; return; }
  el.innerHTML=active.map(function(p){
    var on=state.attendeeIds.indexOf(p.id)>=0;
    return '<span class="chip'+(on?' on':'')+'" data-pid="'+p.id+'">'+esc(p.name)+'</span>';
  }).join('');
  el.querySelectorAll('.chip[data-pid]').forEach(function(c){
    c.addEventListener('click', function(){ toggleAttendee(Number(c.getAttribute('data-pid'))); });
  });
  var absent=state.people.filter(function(p){ return p.active && state.attendeeIds.indexOf(p.id)<0; });
  var al=document.getElementById('absent-line');
  if(al) al.textContent = absent.length ? 'Absent: '+absent.map(function(p){ return p.name; }).join(', ') : 'Everyone is present.';
}

// ── Guests ──────────────────────────────────────────────────────────────────
function renderGuests(){
  var el=document.getElementById('guest-chips'); if(!el) return;
  var guests=state.guests||[];
  el.innerHTML = guests.length ? guests.map(function(g){
    return '<span class="chip on guest">'+esc(g.name)+(g.title?' <span class="guest-title">'+esc(g.title)+'</span>':'')
      +' <button class="chip-x" data-gid="'+g.id+'" title="Remove '+esc(g.name)+'" aria-label="Remove '+esc(g.name)+'">&times;</button></span>';
  }).join('') : '<span class="chip empty-hint">No guests.</span>';
  el.querySelectorAll('[data-gid]').forEach(function(b){
    b.addEventListener('click', function(){ removeGuest(Number(b.getAttribute('data-gid'))); });
  });
}
// Guests are speaker choices, so every speaker dropdown follows the list.
function guestsChanged(){
  renderGuests();
  refreshReportSoon();
  // A removed guest no longer presents anything (the server drops it too).
  var gids=(state.guests||[]).map(function(g){ return g.id; });
  state.items.forEach(function(it){
    it.guest_presenter_ids=(it.guest_presenter_ids||[]).filter(function(id){ return gids.indexOf(id)>=0; });
    renderPresenterChips(it); renderSpeakerMap(it);
  });
  renderMeetingSpeakerPanel();
}
function addGuest(){
  var name=v('g-name'), title=v('g-title');
  if(!name){ msg('guest-msg','err','Enter the guest’s name.'); return; }
  var mid=state.meeting.id;
  setBtn('btn-add-guest', true, 'Adding…');
  api('/api/meetings/'+mid+'/guests', { method:'POST', body:{ name:name, title:title } }).then(function(res){
    setBtn('btn-add-guest', false);
    if(!state.meeting || state.meeting.id!==mid) return;
    if(!res.ok){ msg('guest-msg','err',res.error); return; }
    msg('guest-msg','','');
    document.getElementById('g-name').value=''; document.getElementById('g-title').value='';
    state.guests=res.guests||[];
    guestsChanged();
  });
}
function removeGuest(gid){
  api('/api/guests/'+gid, { method:'DELETE' }).then(function(res){
    if(!res.ok){ msg('guest-msg','err',res.error); return; }
    state.guests=(state.guests||[]).filter(function(g){ return g.id!==gid; });
    guestsChanged();
  });
}

// Names a voice can be given: attendees, then guests, each name once.
function speakerChoices(){
  var names=[];
  state.attendeeIds.forEach(function(id){ var p=state.peopleById[id]; if(p && names.indexOf(p.name)<0) names.push(p.name); });
  (state.guests||[]).forEach(function(g){ if(names.indexOf(g.name)<0) names.push(g.name); });
  return names;
}
function speakerOptions(sel){
  var names=speakerChoices();
  var o='<option value="">— unlabeled —</option>';
  names.forEach(function(n){ o+='<option value="'+esc(n)+'"'+(sel===n?' selected':'')+'>'+esc(n)+'</option>'; });
  // Keep a currently-set name that is no longer offered as an option too.
  if(sel && names.indexOf(sel)<0) o+='<option value="'+esc(sel)+'" selected>'+esc(sel)+'</option>';
  return o;
}
function toggleAttendee(pid){
  var i=state.attendeeIds.indexOf(pid);
  if(i>=0) state.attendeeIds.splice(i,1); else state.attendeeIds.push(pid);
  api('/api/meetings/'+state.meeting.id+'/attendees', { method:'PUT', body:{ personIds:state.attendeeIds } }).then(refreshReportSoon);
  renderAttendeeChips();
  // Both presenter chips and the speaker dropdowns are built from the attendee
  // list, so both have to be rebuilt the moment it changes.
  state.items.forEach(function(it){
    renderPresenterChips(it);
    renderSpeakerMap(it);
  });
}

// ── Agenda upload / add ─────────────────────────────────────────────────────
function uploadAgenda(){
  var fileEl=document.getElementById('agenda-file');
  if(!fileEl.files.length){ msg('agenda-msg','err','Choose an agenda file first.'); return; }
  var fd=new FormData(); fd.append('file', fileEl.files[0]);
  setBtn('btn-upload-agenda', true, 'Extracting...');
  msg('agenda-msg','info','Extracting agenda items with AI…');
  apiForm('/api/meetings/'+state.meeting.id+'/agenda', fd).then(function(res){
    setBtn('btn-upload-agenda', false);
    if(!res.ok){ msg('agenda-msg','err',res.error); return; }
    state.items=res.items; fileEl.value='';
    msg('agenda-msg','ok','Extracted '+res.items.length+' agenda item'+(res.items.length===1?'':'s')+'.');
    renderItems();
  }).catch(function(e){ setBtn('btn-upload-agenda', false); msg('agenda-msg','err',e.message); });
}
function addItemManually(){
  openModal({
    title: 'Add agenda item',
    saveLabel: 'Add item',
    fields: [
      { id:'title', label:'Title', type:'text', value:'', required:true },
      { id:'desc', label:'Details (optional)', type:'textarea', value:'' }
    ],
    onSave: function(v, done){
      api('/api/meetings/'+state.meeting.id+'/items', { method:'POST', body:{ title:v.title, description:v.desc } })
        .then(function(res){
          if(!res.ok){ done(res.error||'Could not add the item.'); return; }
          done(null);
          return api('/api/meetings/'+state.meeting.id).then(function(det){
            if(det.ok){ state.items=det.items; renderItems(); }
          });
        }).catch(function(e){ done(e.message); });
    }
  });
}

function editItem(it){
  openModal({
    title: 'Edit agenda item',
    fields: [
      { id:'title', label:'Title', type:'text', value:it.title, required:true },
      { id:'desc', label:'Details (optional)', type:'textarea', value:it.description||'' }
    ],
    onSave: function(v, done){
      api('/api/items/'+it.id, { method:'PATCH', body:{ title:v.title, description:v.desc.trim() } })
        .then(function(res){
          if(!res.ok){ done(res.error||'Could not save.'); return; }
          it.title=v.title.trim(); it.description=v.desc.trim();
          done(null);
          renderItems();
          refreshReportSoon();
        }).catch(function(e){ done(e.message); });
    }
  });
}

// ── Agenda item cards ───────────────────────────────────────────────────────
function renderItems(){
  var wrap=document.getElementById('items-wrap');
  state.openItemId=null; // DOM rebuilt → all bodies collapsed
  if(!state.items.length){ wrap.innerHTML='<div class="empty">No agenda items yet. Upload an agenda or add items manually.</div>'; return; }
  wrap.innerHTML=state.items.map(function(it, idx){ return itemHtml(it, idx); }).join('');
  state.items.forEach(function(it){ wireItem(it); });
  // The rebuilt rows default to showing the per-topic recorder; re-apply the
  // whole-meeting lock so a rebuild mid-recording cannot bring them back.
  syncItemRecControls();
}

// Update everything about one already-rendered item without touching the
// open/collapsed state — the poll runs every 3s and must never collapse the
// topic the user is typing in.
function refreshItemView(it){
  refreshBadge(it);
  renderSpeakerMap(it);
  renderRecordings(it);
  var tx=document.getElementById('tx-'+it.id);
  if(tx && document.activeElement!==tx && tx.value!==it.transcript) tx.value=it.transcript;
  var sumEl=document.getElementById('sum-'+it.id);
  if(sumEl) sumEl.innerHTML=summaryHtml(it);
  // While this item is the one actively being recorded (e.g. re-recording it,
  // or recording it again right after a previous clip was queued), leave its
  // rec-status line showing "Recording…" — never let a poll's transcribe
  // status for this item clobber that indicator out from under the user.
  if(!(typeof activeRec!=='undefined' && activeRec && activeRec.it.id===it.id)){
    var rs=document.getElementById('recstat-'+it.id);
    if(rs){
      if(it.transcribe_status==='queued') rs.textContent='Queued — transcription starts when the one ahead finishes.';
      else if(it.transcribe_status==='processing') rs.innerHTML='<span class="spin" style="border-top-color:var(--navy)"></span> Transcribing &amp; identifying speakers&hellip;';
      else if(it.transcribe_status==='error') rs.innerHTML='<span style="color:var(--rej-fg)">'+esc(it.transcribe_error||'Transcription failed.')+'</span>';
      else rs.textContent='';
    }
  }
}

// Merge a freshly fetched item list into state. Rebuilds the DOM only when the
// set of items actually changed; otherwise patches each card in place.
function syncItems(fresh){
  var sameSet = state.items.length===fresh.length && state.items.every(function(old, i){ return old.id===fresh[i].id; });
  if(!sameSet){ state.items=fresh; renderItems(); return; }
  fresh.forEach(function(f, i){
    var it=state.items[i];
    it.title=f.title; it.description=f.description;
    it.transcribe_status=f.transcribe_status; it.transcribe_error=f.transcribe_error;
    it.transcript_segments=f.transcript_segments; it.speaker_map=f.speaker_map;
    it.speaker_stats=f.speaker_stats; it.recordings=f.recordings||[];
    it.presenter_ids=f.presenter_ids; it.guest_presenter_ids=f.guest_presenter_ids||[];
    it.transcript_source=f.transcript_source;
    // Never clobber text the user is actively editing.
    var tx=document.getElementById('tx-'+it.id);
    if(!tx || document.activeElement!==tx) it.transcript=f.transcript;
    var nt=document.getElementById('nt-'+it.id);
    if(!nt || document.activeElement!==nt) it.notes=f.notes;
    it.summary=f.summary; it.action_items=f.action_items;
    it.summarize_status=f.summarize_status; it.summarize_error=f.summarize_error;
    refreshItemView(it);
    renderPresenterChips(it);
  });
}

function itemHtml(it, idx){
  return '<div class="item" id="item-'+it.id+'">'
    +'<div class="ihead" data-toggle-item="'+it.id+'">'
      +'<div class="itop"><div class="inum" id="inum-'+it.id+'">'+(idx+1)+'</div>'
      +'<div><div class="ititle">'+esc(it.title)+'</div>'
      +(it.description?'<div class="idesc">'+esc(it.description)+'</div>':'')
      +'</div></div>'
      +'<span class="item-badge" id="badge-'+it.id+'">'+itemBadgeInner(it)+'</span>'
    +'</div>'
    +'<div class="ibody collapsed" id="ibody-'+it.id+'">'
      +'<div class="sublbl">Presented by</div>'
      +'<div class="pres-groups" id="pres-'+it.id+'"></div>'
      +'<div class="sublbl">Transcript (AI, with speaker labels)</div>'
      +'<div class="rec-row" id="recrow-'+it.id+'">'
        +'<button class="btn-sm" data-rec="'+it.id+'">● Record</button>'
        +'<label class="btn-sm" style="cursor:pointer">Upload audio<input type="file" accept="audio/*,video/webm" data-audio="'+it.id+'" style="display:none"></label>'
        +'<span class="rec-status" id="recstat-'+it.id+'"></span>'
      +'</div>'
      // Shown in place of the per-topic controls while the whole meeting is
      // being recorded — that recorder already captures this topic.
      +'<div class="hint rec-locked" id="reclock-'+it.id+'" hidden>'
        +'<span class="rec-dot"></span> The meeting recording is capturing this topic. '
        +'Open a topic as it comes up and the audio is filed under it automatically.'
      +'</div>'
      +'<div class="speakers" id="spk-'+it.id+'"></div>'
      +'<div class="recordings" id="rec-'+it.id+'"></div>'
      +'<textarea id="tx-'+it.id+'" placeholder="Record or upload audio to transcribe. Speakers are labeled once you record; you can also edit this text." style="margin-top:6px">'+esc(it.transcript)+'</textarea>'
      +'<div class="sublbl">Notes (typed)</div>'
      +'<textarea id="nt-'+it.id+'" placeholder="Optional manual notes">'+esc(it.notes)+'</textarea>'
      +'<div class="hint" style="margin-top:8px">The summary is written on the server when you close this item, or a couple of minutes after your last edit &mdash; even if you leave the page.</div>'
      +'<div class="btn-row">'
        +'<button class="btn-sm" data-edit-item="'+it.id+'">Edit item</button>'
        +'<button class="btn btn-danger btn-sm" data-del-item="'+it.id+'">Remove item</button>'
        +'<span id="imsg-'+it.id+'"></span>'
      +'</div>'
      +'<div id="sum-'+it.id+'">'+summaryHtml(it)+'</div>'
    +'</div>'
  +'</div>';
}

// True when the item has content worth summarizing.
function itemHasContent(it){ return !!((it.transcript && it.transcript.trim()) || (it.notes && it.notes.trim())); }

// True while this item's audio is queued or being transcribed.
function isTranscribing(it){
  return it.transcribe_status==='queued' || it.transcribe_status==='processing';
}

// The header status badge for an item's current transcription + summary state.
function itemBadgeInner(it){
  if(it.transcribe_status==='queued') return '<span class="badge b-pending">Queued to transcribe</span>';
  if(it.transcribe_status==='processing') return '<span class="badge b-pending"><span class="spin" style="border-top-color:var(--pending-fg)"></span> Transcribing&hellip;</span>';
  if(it.transcribe_status==='error') return '<span class="badge b-rejected">Transcription failed</span>';
  if(it.summarize_status==='processing') return '<span class="badge b-pending"><span class="spin" style="border-top-color:var(--pending-fg)"></span> Summarizing&hellip;</span>';
  if(it.summarize_status==='queued') return '<span class="badge b-pending">Summary queued</span>';
  if(it.summarize_status==='error') return '<span class="badge b-rejected" title="'+esc(it.summarize_error)+'">Summary failed</span>';
  if(it.summary) return '<span class="badge b-approved">Summary ready</span>';
  if(itemHasContent(it)) return '<span class="badge b-changes_requested">Needs summary</span>';
  return '';
}
function refreshBadge(it){
  var b=document.getElementById('badge-'+it.id); if(b) b.innerHTML=itemBadgeInner(it);
}

// Rendered summary + action-item list for an item.
function summaryHtml(it){
  var h='';
  if(it.summarize_status==='error' && it.summarize_error) h+='<div class="alert alert-err" style="margin-top:8px">'+esc(it.summarize_error)+'</div>';
  if(it.summary) h+='<div class="sublbl">Summary</div><div class="summary-box">'+esc(it.summary)+'</div>';
  h+=actionItemsHtml(it.action_items);
  return h;
}
function actionItemsHtml(items){
  if(!items || !items.length) return '';
  var rows=items.map(function(a){
    return '<li><span class="ai-task">'+esc(a.task)+'</span> <span class="ai-owner">'+esc(a.owner||'Unassigned')+'</span></li>';
  }).join('');
  return '<div class="sublbl">Action items</div><ul class="action-list">'+rows+'</ul>';
}

function wireItem(it){
  document.querySelector('[data-toggle-item="'+it.id+'"]').addEventListener('click', function(){ toggleItemOpen(it); });
  renderPresenterChips(it);
  renderSpeakerMap(it);
  renderRecordings(it);
  var tx=document.getElementById('tx-'+it.id);
  var nt=document.getElementById('nt-'+it.id);
  tx.addEventListener('blur', function(){
    if(tx.value===it.transcript) return;
    it.transcript=tx.value; saveItemField(it, { transcript: tx.value }); invalidateSummary(it);
  });
  nt.addEventListener('blur', function(){
    if(nt.value===it.notes) return;
    it.notes=nt.value; saveItemField(it, { notes: nt.value }); invalidateSummary(it);
  });
  document.querySelector('[data-rec="'+it.id+'"]').addEventListener('click', function(){ toggleRecording(it, this); });
  document.querySelector('[data-audio="'+it.id+'"]').addEventListener('change', function(){ uploadAudio(it, this); });
  document.querySelector('[data-edit-item="'+it.id+'"]').addEventListener('click', function(){ editItem(it); });
  document.querySelector('[data-del-item="'+it.id+'"]').addEventListener('click', function(){ removeItem(it); });
}

// ── Accordion open/close (drives auto-summary) ──────────────────────────────
// Opening an item collapses whichever was open (summarizing it if needed);
// closing the current item summarizes it. One item open at a time.
function toggleItemOpen(it){
  var body=document.getElementById('ibody-'+it.id);
  var isOpen=!body.classList.contains('collapsed');
  if(isOpen){ collapseItem(it); return; }
  if(state.openItemId && state.openItemId!==it.id){
    var prev=state.items.filter(function(x){return x.id===state.openItemId;})[0];
    if(prev) collapseItem(prev);
  }
  body.classList.remove('collapsed');
  state.openItemId=it.id;
  postTopicMarker(it.id);
}
function collapseItem(it){
  var body=document.getElementById('ibody-'+it.id);
  if(body) body.classList.add('collapsed');
  if(state.openItemId===it.id) state.openItemId=null;
  summarizeIfNeeded(it);
}

// Content changed → the existing summary is stale. The server clears it and
// queues a fresh one when it saves the change; mirror that here at once.
function invalidateSummary(it){
  it.summary=''; it.action_items=[]; it.summarize_status='queued'; it.summarize_error='';
  var sumEl=document.getElementById('sum-'+it.id); if(sumEl) sumEl.innerHTML='';
  refreshBadge(it);
  startPolling();
}

// Ask the server to summarize now rather than after the edit delay. A queued
// or in-flight transcription always wins: the server summarizes once it lands.
function summarizeIfNeeded(it){
  if(isTranscribing(it) || meetingProcessing()) return Promise.resolve();
  if(!itemHasContent(it)) return Promise.resolve();
  if(it.summary || it.summarize_status==='processing') return Promise.resolve();
  it.summarize_status='queued'; refreshBadge(it);
  var mid=state.meeting && state.meeting.id;
  return api('/api/items/'+it.id+'/summarize', { method:'POST' }).then(function(res){
    if(!state.meeting || state.meeting.id!==mid) return;
    if(!res.ok){
      it.summarize_status='error'; it.summarize_error=res.error||'Could not queue the summary.';
      refreshItemView(it); return;
    }
    startPolling();
  });
}

// Speaker assignments arrive one dropdown at a time, so wait for the user to
// stop changing them before spending a summarize call on the item.
var summarizeTimers={};
function scheduleSummarize(it, delayMs){
  if(summarizeTimers[it.id]) clearTimeout(summarizeTimers[it.id]);
  summarizeTimers[it.id]=setTimeout(function(){
    delete summarizeTimers[it.id];
    // Re-read from state: the item object may have been replaced by a poll.
    var live=(state.items||[]).filter(function(x){ return x.id===it.id; })[0];
    if(live) summarizeIfNeeded(live);
  }, delayMs||1500);
}
function clearScheduledSummaries(){
  Object.keys(summarizeTimers).forEach(function(k){ clearTimeout(summarizeTimers[k]); });
  summarizeTimers={};
}

// ── Speaker → person mapping ────────────────────────────────────────────────
function distinctSpeakersJS(segments){
  var seen=[];
  (segments||[]).forEach(function(s){ if(s.speaker && seen.indexOf(s.speaker)<0) seen.push(s.speaker); });
  return seen;
}
// Mirror of server transcript.ts resolveSpeakerName.
function resolveSpeakerNameJS(speaker, map, order){
  var mapped = map ? map[speaker] : '';
  if(mapped && mapped.trim()) return mapped.trim();
  var idx = order.indexOf(speaker);
  return idx >= 0 ? ('Speaker '+(idx+1)) : 'Speaker';
}
// Mirror of server transcript.ts renderTranscript so remapping updates
// instantly. Merges consecutive turns that resolve to the same display name.
function renderTranscriptJS(segments, map){
  if(!segments || !segments.length) return '';
  var order=distinctSpeakersJS(segments);
  if(!order.length) return segments.map(function(s){return s.text;}).join(' ').trim();
  var lines=[], curName=null, buf=[];
  function flush(){
    if(curName===null || !buf.length) return;
    lines.push(curName+': '+buf.join(' ').trim()); buf=[];
  }
  segments.forEach(function(s){
    var spk = s.speaker || order[0];
    var name = resolveSpeakerNameJS(spk, map||{}, order);
    if(name!==curName){ flush(); curName=name; }
    buf.push(s.text);
  });
  flush();
  return lines.join('\n');
}
function renderSpeakerMap(it){
  var el=document.getElementById('spk-'+it.id); if(!el) return;
  if(it.transcript_source==='meeting'){
    el.innerHTML='<div class="hint">Speakers for this topic are labeled meeting-wide &mdash; use &ldquo;Who spoke in this meeting?&rdquo; above.</div>';
    return;
  }
  var stats=it.speaker_stats||[];
  if(!stats.length){ el.innerHTML=''; return; }
  var opts=speakerOptions;
  el.innerHTML='<div class="sublbl">Who is speaking?</div><div class="spk-rows">'
    + stats.map(function(st){
        var cur=(it.speaker_map||{})[st.speaker]||'';
        var pct=Math.round(st.share*100);
        return '<div class="spk-row"><span class="spk-tag">'+esc(st.label)+'</span>'
          +'<span class="spk-share">'+pct+'%</span>'
          +'<select data-spk="'+esc(st.speaker)+'">'+opts(cur)+'</select>'
          +(st.sample?'<div class="spk-sample">&ldquo;'+esc(st.sample)+'&rdquo;</div>':'')
          +speakerSamplesHtml(st, null)
          +'</div>';
      }).join('')
    + '</div><div class="hint">Voices are listed by how much they spoke. Several rows can be the same person — set them to the same name and their lines merge. Remapping relabels the transcript.</div>';
  el.querySelectorAll('select[data-spk]').forEach(function(sel){
    sel.addEventListener('change', function(){
      var spk=sel.getAttribute('data-spk');
      it.speaker_map=it.speaker_map||{};
      if(sel.value) it.speaker_map[spk]=sel.value; else delete it.speaker_map[spk];
      // Instant local re-render, then persist (server renders identically).
      var tx=document.getElementById('tx-'+it.id);
      tx.value=renderTranscriptJS(it.transcript_segments, it.speaker_map);
      it.transcript=tx.value;
      saveItemField(it, { speakerMap: it.speaker_map });
      invalidateSummary(it);
      // Naming a voice changes who said what, so the summary and its action
      // items are now wrong. Rewrite them without waiting for the topic to be
      // collapsed.
      scheduleSummarize(it);
    });
  });
}

// Several longer excerpts per voice, collapsed under the row: one quote of a
// few words is rarely enough to tell who is speaking. With a recording id each
// excerpt gets a play button that fetches just that stretch of audio.
function speakerSamplesHtml(st, recId){
  var list=st.samples||[];
  if(!list.length) return '';
  return '<details class="spk-more"><summary>'+list.length+' sample'+(list.length===1?'':'s')+' of '+esc(st.label)+'</summary>'
    +'<ol class="spk-excerpts">'
    + list.map(function(x){
        var play = recId
          ? '<button type="button" class="btn-sm spk-play" data-rec="'+recId+'" data-start="'+x.start+'" data-end="'+x.end+'" title="Play this clip">&#9654;</button>'
          : '';
        return '<li>'+play+'<span class="spk-at">'+fmtClock(x.start)+'</span> '+esc(x.text)+'</li>';
      }).join('')
    +'</ol></details>';
}

// One player for every sample button on the page. A second click on the
// playing clip stops it.
var samplePlayer=null, samplePlayingBtn=null;
function stopSample(){
  if(samplePlayer){ try { samplePlayer.pause(); } catch(e){} }
  if(samplePlayingBtn){ samplePlayingBtn.innerHTML='&#9654;'; samplePlayingBtn=null; }
}
document.addEventListener('click', function(e){
  var btn=e.target && e.target.closest ? e.target.closest('.spk-play') : null;
  if(!btn) return;
  e.preventDefault();
  if(samplePlayingBtn===btn){ stopSample(); return; }
  stopSample();
  if(!samplePlayer){
    samplePlayer=new Audio();
    samplePlayer.addEventListener('ended', stopSample);
  }
  // Pad the turn slightly: diarization boundaries clip the first syllable.
  var start=Math.max(0, Number(btn.getAttribute('data-start'))-0.3);
  var end=Math.min(Number(btn.getAttribute('data-end'))+0.3, start+45);
  samplePlayer.src='/api/meeting-recordings/'+btn.getAttribute('data-rec')+'/clip?start='+start.toFixed(2)+'&end='+end.toFixed(2);
  samplePlayingBtn=btn;
  btn.innerHTML='&#9632;';
  var p=samplePlayer.play();
  if(p && p['catch']) p['catch'](function(){ if(samplePlayingBtn===btn) stopSample(); });
});

// Meeting-wide speaker naming: one set of voices for the whole recording.
// Saving rewrites every meeting-sourced topic's transcript server-side.
var savingMspk=false; // true only while a PUT .../speaker-map is in flight (blocks double-submit)
function renderMeetingSpeakerPanel(){
  var el=document.getElementById('meeting-speakers'); if(!el) return;
  var stats=state.meetingSpeakerStats||[];
  if(!stats.length){ el.innerHTML=''; return; }
  var map=(state.meeting && state.meeting.speaker_map)||{};
  // Samples are on the processed recording's timeline, so they can be played.
  var recs=state.meetingRecordings||[];
  var recId=recs.length ? recs[recs.length-1].id : null;
  var opts=speakerOptions;
  el.innerHTML='<div class="card"><div class="ct">Who spoke in this meeting?</div>'
    +'<div id="mspk-msg"></div>'
    +'<div class="spk-rows">'
    + stats.map(function(st){
        var cur=map[st.speaker]||'';
        var pct=Math.round(st.share*100);
        return '<div class="spk-row"><span class="spk-tag">'+esc(st.label)+'</span>'
          +'<span class="spk-share">'+pct+'%</span>'
          +'<select data-mspk="'+esc(st.speaker)+'">'+opts(cur)+'</select>'
          +(st.sample?'<div class="spk-sample">&ldquo;'+esc(st.sample)+'&rdquo;</div>':'')
          +speakerSamplesHtml(st, recId)
          +'</div>';
      }).join('')
    +'</div>'
    +'<div class="hint">One set of voices for the whole meeting &mdash; assign a name once and every topic updates. Saving re-labels all topic transcripts.</div>'
    +'<div class="btn-row"><button class="btn btn-primary" id="btn-save-mspk" data-default="Save speakers"'+((savingMspk||meetingProcessing())?' disabled':'')+'>Save speakers</button></div>'
    +'</div>';
  document.getElementById('btn-save-mspk').addEventListener('click', function(){
    if(savingMspk || meetingProcessing()) return;
    var newMap={};
    el.querySelectorAll('select[data-mspk]').forEach(function(sel){
      if(sel.value) newMap[sel.getAttribute('data-mspk')]=sel.value;
    });
    savingMspk=true;
    var mid=state.meeting.id;
    setBtn('btn-save-mspk', true, 'Saving...');
    api('/api/meetings/'+mid+'/speaker-map', { method:'PUT', body:{ speakerMap:newMap } })
      .then(function(res){
        if(!res.ok){ savingMspk=false; setBtn('btn-save-mspk', false); msg('mspk-msg','err',res.error||'Could not save.'); return; }
        savingMspk=false;
        if(!state.meeting || state.meeting.id!==mid) return;
        return api('/api/meetings/'+mid).then(function(det){
          if(!state.meeting || state.meeting.id!==mid) return;
          if(det.ok){
            state.meeting=det.meeting;
            state.meetingRecordings=det.meetingRecordings||[];
            state.meetingSpeakerStats=det.meetingSpeakerStats||[];
            state.attendeeIds=det.attendeeIds;
            syncItems(det.items);
          }
          renderMeetingSpeakerPanel();
          // The server cleared every meeting-sourced summary and queued them
          // again; the poll shows them landing.
          msg('mspk-msg','ok','Speakers saved — transcripts updated. Summaries are being rewritten.');
          startPolling();
        });
      })['catch'](function(e){ savingMspk=false; setBtn('btn-save-mspk', false); msg('mspk-msg','err',e.message); });
  });
}

// Every recording ever attached to this item. They are kept for the life of
// the meeting, so the original audio is always downloadable, and any of them
// can be sent through transcription again via "Transcribe again".
function renderRecordings(it){
  var el=document.getElementById('rec-'+it.id); if(!el) return;
  var recs=it.recordings||[];
  if(!recs.length){ el.innerHTML=''; return; }
  el.innerHTML='<div class="sublbl">Recordings</div><ul class="rec-list">'
    + recs.map(function(r){
        var size=r.byte_size ? (Math.round(r.byte_size/1024/102.4)/10)+' MB' : '';
        return '<li><span class="rec-name">'+esc(r.file_name||('recording '+r.id))+'</span>'
          +(size?'<span class="rec-size">'+esc(size)+'</span>':'')
          +'<a class="btn-sm" href="/api/recordings/'+r.id+'/download">Download</a>'
          +'<button class="btn-sm" data-retry="'+it.id+'" data-rec-id="'+r.id+'">Transcribe again</button></li>';
      }).join('')
    + '</ul>';
  el.querySelectorAll('[data-retry]').forEach(function(b){
    b.addEventListener('click', function(){
      api('/api/items/'+it.id+'/retranscribe', { method:'POST', body:{ recordingId: Number(b.getAttribute('data-rec-id')) } })
        .then(function(res){
          if(!res.ok){ msg('imsg-'+it.id,'err',res.error); return; }
          it.transcribe_status='queued'; it.transcribe_error='';
          refreshItemView(it);
          startPolling();
        }).catch(function(e){ msg('imsg-'+it.id,'err',e.message); });
    });
  });
}

function renderPresenterChips(it){
  var el=document.getElementById('pres-'+it.id); if(!el) return;
  var attendees=state.attendeeIds.map(function(id){ return state.peopleById[id]; }).filter(Boolean);
  var guests=state.guests||[];
  if(!it.guest_presenter_ids) it.guest_presenter_ids=[];
  if(!attendees.length && !guests.length){ el.innerHTML='<span class="chip empty-hint">Select attendees or add guests above first.</span>'; return; }
  // Guests first, in their own group, so a visiting speaker is easy to find.
  var html='';
  if(guests.length){
    html+='<div class="pres-group"><div class="pres-group-lbl">Guests</div><div class="chips">'
      +guests.map(function(g){
        var on=it.guest_presenter_ids.indexOf(g.id)>=0;
        return '<span class="chip pres guest-pres'+(on?' on':'')+'" data-pg="'+g.id+'">'+esc(g.name)
          +(g.title?' <span class="guest-title">'+esc(g.title)+'</span>':'')+'</span>';
      }).join('')+'</div></div>';
  }
  html+='<div class="pres-group">'+(guests.length?'<div class="pres-group-lbl">Attendees</div>':'')+'<div class="chips">'
    +(attendees.length ? attendees.map(function(p){
      var on=it.presenter_ids.indexOf(p.id)>=0;
      return '<span class="chip pres'+(on?' on':'')+'" data-pp="'+p.id+'">'+esc(p.name)+'</span>';
    }).join('') : '<span class="chip empty-hint">No attendees selected.</span>')+'</div></div>';
  el.innerHTML=html;
  el.querySelectorAll('.chip[data-pp]').forEach(function(c){
    c.addEventListener('click', function(){
      var pid=Number(c.getAttribute('data-pp'));
      var i=it.presenter_ids.indexOf(pid);
      if(i>=0) it.presenter_ids.splice(i,1); else it.presenter_ids.push(pid);
      saveItemField(it, { presenterIds: it.presenter_ids }).then(refreshReportSoon);
      renderPresenterChips(it);
    });
  });
  el.querySelectorAll('.chip[data-pg]').forEach(function(c){
    c.addEventListener('click', function(){
      var gid=Number(c.getAttribute('data-pg'));
      var i=it.guest_presenter_ids.indexOf(gid);
      if(i>=0) it.guest_presenter_ids.splice(i,1); else it.guest_presenter_ids.push(gid);
      saveItemField(it, { guestPresenterIds: it.guest_presenter_ids }).then(refreshReportSoon);
      renderPresenterChips(it);
    });
  });
}

function saveItemField(it, fields){
  return api('/api/items/'+it.id, { method:'PATCH', body:fields });
}

function removeItem(it){
  if(!confirm('Remove "'+it.title+'"?')) return;
  // Only drop it from the list once the server confirms; otherwise the item
  // silently reappears on the next load and the failure is never reported.
  api('/api/items/'+it.id, { method:'DELETE' }).then(function(res){
    if(!res || !res.ok){ msg('imsg-'+it.id,'err',(res && res.error) || 'Could not remove the item.'); return; }
    state.items=state.items.filter(function(x){ return x.id!==it.id; });
    renderItems();
    refreshReportSoon();
  })['catch'](function(e){ msg('imsg-'+it.id,'err',e.message); });
}

// ── Recording → diarized transcription ──────────────────────────────────────
// Record the agenda item with MediaRecorder; on stop, upload the audio to the
// self-hosted Whisper service, which transcribes AND labels who is speaking.
var activeRec = null; // { it, btn, mr, stream, chunks }

function pickMime(){
  var opts=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg'];
  for(var i=0;i<opts.length;i++){ if(window.MediaRecorder && MediaRecorder.isTypeSupported(opts[i])) return opts[i]; }
  return '';
}

// ── Keep the screen awake while recording ───────────────────────────────────
// A laptop or tablet that sleeps mid-meeting suspends the page and with it the
// MediaRecorder. Hold a Screen Wake Lock while either recorder runs. Browsers
// drop the lock whenever the tab is hidden, so re-request it on return.
var wakeLock=null, wakeLockPending=false;

function recordingInProgress(){ return !!(activeRec || meetingRec); }

function syncWakeLock(){
  if(recordingInProgress()){
    if(wakeLock || wakeLockPending || !navigator.wakeLock || document.visibilityState!=='visible') return;
    wakeLockPending=true;
    navigator.wakeLock.request('screen').then(function(l){
      wakeLockPending=false;
      wakeLock=l;
      l.addEventListener('release', function(){ if(wakeLock===l) wakeLock=null; });
      // Recording may have stopped while the request was in flight.
      if(!recordingInProgress()) syncWakeLock();
    })['catch'](function(){ wakeLockPending=false; });
  } else if(wakeLock){
    var l=wakeLock; wakeLock=null;
    try { l.release()['catch'](function(){}); } catch(e){}
  }
}
document.addEventListener('visibilitychange', syncWakeLock);

function toggleRecording(it, btn){
  if(activeRec && activeRec.it.id===it.id){ stopRecording(); return; }
  if(activeRec){ stopRecording(); }
  var rs=document.getElementById('recstat-'+it.id);
  // Defence in depth: the controls are hidden during a whole-meeting recording,
  // but there is only one microphone, so never start a second capture.
  if(meetingRec){
    rs.innerHTML='<span style="color:var(--rej-fg)">'
      +(meetingRecordingActive()
          ? 'The meeting recording is capturing this topic already.'
          : 'A recording of &ldquo;'+esc(meetingRec.title||'another meeting')+'&rdquo; is running — stop it first.')
      +'</span>';
    return;
  }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder){
    rs.innerHTML='<span style="color:var(--rej-fg)">This browser cannot record audio. Upload a recording instead.</span>';
    return;
  }
  rs.textContent='Starting microphone…';
  navigator.mediaDevices.getUserMedia({ audio:{ channelCount:1, echoCancellation:true, noiseSuppression:true } })
    .then(function(stream){
      var mime=pickMime();
      var mr=new MediaRecorder(stream, mime?{ mimeType:mime }:undefined);
      var chunks=[];
      mr.ondataavailable=function(e){ if(e.data && e.data.size) chunks.push(e.data); };
      mr.onstop=function(){
        try { stream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
        var blob=new Blob(chunks, { type: mime || 'audio/webm' });
        transcribeBlob(it, blob, mime);
      };
      activeRec={ it:it, btn:btn, mr:mr, stream:stream, chunks:chunks };
      mr.start();
      syncWakeLock();
      btn.innerHTML='<span class="rec-dot"></span> Stop &amp; transcribe';
      rs.innerHTML='<span class="rec-dot"></span> Recording…';
    })
    .catch(function(e){ rs.innerHTML='<span style="color:var(--rej-fg)">Mic access denied: '+esc(e.message||e.name)+'</span>'; });
}

function stopRecording(){
  if(!activeRec) return;
  var r=activeRec; activeRec=null;
  syncWakeLock();
  if(r.btn) r.btn.innerHTML='● Record';
  try { if(r.mr.state!=='inactive') r.mr.stop(); } catch(e){
    try { r.stream.getTracks().forEach(function(t){ t.stop(); }); } catch(e2){}
  }
}

// Hand a recorded/selected audio blob to the server and return immediately.
// The serial queue does the work; the status poll reports progress, so the
// user can move straight on to the next topic.
function transcribeBlob(it, blob, mime){
  var rs=document.getElementById('recstat-'+it.id);
  if(!blob || !blob.size){ if(rs) rs.innerHTML='<span style="color:var(--rej-fg)">No audio captured.</span>'; return; }
  if(rs) rs.innerHTML='<span class="spin" style="border-top-color:var(--navy)"></span> Uploading audio&hellip;';
  var ext=(mime||'').indexOf('mp4')>=0?'m4a':(mime||'').indexOf('ogg')>=0?'ogg':'webm';
  var fd=new FormData(); fd.append('file', blob, 'item-'+it.id+'.'+ext);
  apiForm('/api/items/'+it.id+'/transcribe', fd).then(function(res){
    if(!res.ok){ if(rs) rs.innerHTML='<span style="color:var(--rej-fg)">'+esc(res.error)+'</span>'; return; }
    it.transcribe_status='queued'; it.transcribe_error='';
    refreshItemView(it);
    startPolling();
  }).catch(function(e){ if(rs) rs.innerHTML='<span style="color:var(--rej-fg)">'+esc(e.message)+'</span>'; });
}

// ── Audio file upload → same transcription path ─────────────────────────────
function uploadAudio(it, input){
  if(!input.files.length) return;
  var f=input.files[0]; input.value='';
  // The control is hidden during a whole-meeting recording; refuse anyway so a
  // stray upload cannot land a second transcript on a topic being captured.
  if(meetingRecordingActive()){
    var rs=document.getElementById('recstat-'+it.id);
    if(rs) rs.innerHTML='<span style="color:var(--rej-fg)">The meeting recording is capturing this topic already.</span>';
    return;
  }
  transcribeBlob(it, f, f.type);
}

// ── Whole-meeting recording ─────────────────────────────────────────────────
// One MediaRecorder for the entire meeting. ~20s chunks upload as they are
// produced (strictly ordered by a promise chain), so a crash loses seconds,
// not the meeting. Topic clicks lay down markers; processing segments by them.
var meetingRec=null; // {meetingId, recordingId, title, topic, mr, stream, t0, chain, failedChunk, timer}
var meetingRecStarting=false; // true only during the getUserMedia→POST /recording/start window
var meetingRecFinishing=false; // true from "Stop" until the server accepts the recording

function meetingElapsedSeconds(){ return meetingRec ? (performance.now()-meetingRec.t0)/1000 : 0; }
function fmtClock(s){ var m=Math.floor(s/60), r=Math.floor(s%60); return m+':'+(r<10?'0':'')+r; }

// True while the whole-meeting recorder is running for the meeting on screen.
// There is one microphone, so per-topic capture is meaningless during it.
function meetingRecordingActive(){
  return !!(meetingRec && state.meeting && meetingRec.meetingId===state.meeting.id);
}

// Swap each topic's Record / Upload audio controls for an explanatory note
// while the whole meeting is being recorded. Hiding the controls (rather than
// disabling them) keeps a single, unambiguous way to capture audio.
function syncItemRecControls(){
  var locked=meetingRecordingActive();
  (state.items||[]).forEach(function(it){
    var row=document.getElementById('recrow-'+it.id);
    var note=document.getElementById('reclock-'+it.id);
    if(row) row.hidden=locked;
    if(note) note.hidden=!locked;
  });
}

// ── Global recording banner ─────────────────────────────────────────────────
// The whole-meeting recorder keeps running when you scroll away or go back to
// the meetings list, so its status is rendered into a viewport-fixed banner
// driven by the recorder itself rather than by the detail view.
function renderRecBanner(){
  var el=document.getElementById('rec-banner');
  if(!el) return;
  // Between "Stop" and the server accepting the recording the microphone is
  // already off, so the bar must stop claiming to record. It stays up, in a
  // neutral colour, only while audio is still being uploaded.
  if(!meetingRec && meetingRecFinishing){
    el.className='finishing';
    el.innerHTML='<span class="spin" style="border-top-color:var(--navy)"></span>'
      +'<span class="rb-title">Finishing upload&hellip;</span>'
      +'<span class="rb-topic">Keep this tab open until it completes.</span>';
    el.hidden=false;
    document.body.classList.add('has-rec-banner');
    return;
  }
  if(!meetingRec){
    el.hidden=true;
    el.className='';
    el.innerHTML='';
    document.body.classList.remove('has-rec-banner');
    return;
  }
  el.className='';
  var onThisMeeting = state.meeting && state.meeting.id===meetingRec.meetingId;
  el.innerHTML='<span class="rec-dot"></span>'
    +'<span class="rb-title">Recording &middot; '+esc(meetingRec.title||'meeting')+'</span>'
    +'<span class="rb-clock">'+fmtClock(meetingElapsedSeconds())+'</span>'
    // Audio files under the most recently opened topic and keeps doing so until
    // another is opened — collapsing a topic lays down no marker.
    +(meetingRec.topic
        ? '<span class="rb-topic">Filing under: '+esc(meetingRec.topic)+'</span>'
        : '<span class="rb-topic rb-warn">No topic opened yet &mdash; audio files under the first item</span>')
    +'<span class="rb-actions">'
      +(onThisMeeting ? '' : '<button class="btn-sm" id="rb-open">Open meeting</button> ')
      +'<button class="btn-sm" id="rb-stop">Stop &amp; process</button>'
    +'</span>';
  el.hidden=false;
  document.body.classList.add('has-rec-banner');
  var open=document.getElementById('rb-open');
  if(open) open.addEventListener('click', function(){ openMeeting(meetingRec.meetingId); });
  document.getElementById('rb-stop').addEventListener('click', function(){ stopMeetingRecording(); });
}

function renderMeetingRecUi(){
  // Both of these must run even on the list view, where the meeting card below
  // does not exist: the recorder outlives the detail view.
  renderRecBanner();
  syncItemRecControls();
  var b=document.getElementById('btn-meeting-rec');
  var st=document.getElementById('mrec-status');
  var ex=document.getElementById('mrec-extra');
  if(!b) return;
  if(meetingRec){
    if(!state.meeting || meetingRec.meetingId!==state.meeting.id){
      b.disabled=true;
      b.textContent='Recording another meeting…';
      if(st) st.textContent='';
      if(ex) ex.innerHTML='';
      return;
    }
    b.disabled=false;
    b.innerHTML='<span class="rec-dot"></span> Stop &amp; process ('+fmtClock(meetingElapsedSeconds())+')';
    if(st) st.innerHTML='<span class="rec-dot"></span> Recording the whole meeting&hellip;';
    if(ex) ex.innerHTML='';
    return;
  }
  b.disabled = meetingProcessing();
  b.textContent=b.getAttribute('data-default')||'● Record meeting';
  if(st) st.textContent='';
  if(ex){
    var m=state.meeting||{};
    if(m.recording_status==='recording' && state.meetingRecordings && state.meetingRecordings.length){
      ex.innerHTML='<div class="hint">A meeting recording was interrupted before it was processed.</div>'
        +'<button class="btn-sm" id="btn-mrec-resume">Process interrupted recording</button>';
      document.getElementById('btn-mrec-resume').addEventListener('click', function(){
        var last=state.meetingRecordings[state.meetingRecordings.length-1];
        api('/api/meeting-recordings/'+last.id+'/finish', { method:'POST' }).then(function(res){
          if(!res.ok){ msg('mrec-msg','err',res.error||'Could not queue processing.'); return; }
          state.meeting.recording_status='queued';
          renderMeetingRecUi();
          if(typeof startPolling==='function') startPolling();
        })['catch'](function(e){ msg('mrec-msg','err',e.message); });
      });
    } else {
      var rs=m.recording_status;
      if(rs==='queued'){ ex.innerHTML='<div class="hint">Queued for processing&hellip;</div>'; }
      else if(rs==='processing'){ ex.innerHTML='<div class="hint"><span class="spin" style="border-top-color:var(--navy)"></span> Processing the meeting recording&hellip;</div>'; }
      else if(rs==='error'){
        ex.innerHTML='<div class="alert alert-err">'+esc(m.recording_error||'Processing failed.')+'</div>'
          +(state.meetingRecordings && state.meetingRecordings.length
            ? '<button class="btn-sm" id="btn-mrec-retry">Retry processing</button>' : '');
        var rb=document.getElementById('btn-mrec-retry');
        if(rb) rb.addEventListener('click', reprocessMeetingRecording);
      }
      else if(rs==='done' && state.meetingRecordings && state.meetingRecordings.length){
        var lastRec=state.meetingRecordings[state.meetingRecordings.length-1];
        ex.innerHTML='<div class="hint">Processed. <a href="/api/meeting-recordings/'+lastRec.id+'/download">Download the recording</a></div>'
          +'<button class="btn-sm" id="btn-mrec-reprocess">Reprocess recording</button>';
        document.getElementById('btn-mrec-reprocess').addEventListener('click', function(){
          // Reprocessing rewrites every topic's transcript, speakers and
          // summary from the stored audio; the audio itself is untouched.
          if(!confirm('Reprocess the meeting recording? This replaces every topic\'s transcript, speaker names and summary. The recording itself is kept.')) return;
          reprocessMeetingRecording();
        });
      }
      else ex.innerHTML='';
    }
  }
}

// Queue the latest stored meeting recording for processing again.
function reprocessMeetingRecording(){
  var last=state.meetingRecordings[state.meetingRecordings.length-1];
  api('/api/meeting-recordings/'+last.id+'/reprocess', { method:'POST' }).then(function(res){
    if(!res.ok){ msg('mrec-msg','err',res.error||'Could not queue processing.'); return; }
    state.meeting.recording_status='queued';
    renderMeetingRecUi();
    startPolling();
  })['catch'](function(e){ msg('mrec-msg','err',e.message); });
}

function uploadMeetingChunk(blob){
  if(!meetingRec) return;
  var rec=meetingRec;
  function send(b){
    var fd=new FormData(); fd.append('file', b, 'chunk.webm');
    return apiForm('/api/meeting-recordings/'+rec.recordingId+'/chunk', fd).then(function(res){
      if(!res.ok) throw new Error(res.error||'Chunk upload failed');
    });
  }
  rec.chain = rec.chain.then(function(){
    var payload = rec.failedChunk ? new Blob([rec.failedChunk, blob], { type: blob.type||'audio/webm' }) : blob;
    rec.failedChunk = null;
    return send(payload)['catch'](function(){
      return new Promise(function(r){ setTimeout(r, 2000); }).then(function(){ return send(payload); });
    })['catch'](function(){
      // Carry the audio forward: prepending to the next upload preserves order.
      rec.failedChunk = payload;
    });
  });
}

function postTopicMarker(itemId){
  if(!meetingRec || !state.meeting || meetingRec.meetingId!==state.meeting.id) return;
  var it=(state.items||[]).filter(function(x){ return x.id===itemId; })[0];
  meetingRec.topic = it ? it.title : '';
  renderRecBanner();
  api('/api/meeting-recordings/'+meetingRec.recordingId+'/marker', {
    method:'POST', body:{ itemId: itemId, atSeconds: meetingElapsedSeconds() }
  })['catch'](function(){});
}

function toggleMeetingRecording(){
  if(meetingRec){
    if(state.meeting && meetingRec.meetingId===state.meeting.id) stopMeetingRecording();
    return;
  }
  if(meetingRecStarting) return;
  if(meetingProcessing()){ msg('mrec-msg','err','The previous recording is still processing — wait for it to finish.'); return; }
  if(activeRec){ msg('mrec-msg','err','Stop the topic recording first — there is one microphone.'); return; }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder){
    msg('mrec-msg','err','This browser cannot record audio.'); return;
  }
  meetingRecStarting=true;
  var sb=document.getElementById('btn-meeting-rec'); if(sb) sb.disabled=true;
  function startFailed(message){
    meetingRecStarting=false;
    var bb=document.getElementById('btn-meeting-rec'); if(bb) bb.disabled=false;
    if(message) msg('mrec-msg','err',message);
  }
  msg('mrec-msg','','');
  navigator.mediaDevices.getUserMedia({ audio:{ channelCount:1, echoCancellation:true, noiseSuppression:true } })
    .then(function(stream){
      var mime=pickMime();
      api('/api/meetings/'+state.meeting.id+'/recording/start', { method:'POST', body:{ mimeType: mime||'audio/webm' } })
        .then(function(res){
          if(!res.ok){
            try { stream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
            startFailed(res.error||'Could not start the recording.');
            return;
          }
          var mr=new MediaRecorder(stream, mime?{ mimeType:mime }:undefined);
          meetingRec={ meetingId:state.meeting.id, recordingId:res.recordingId,
                       title:state.meeting.title, topic:'', mr:mr, stream:stream,
                       t0:performance.now(), chain:Promise.resolve(), failedChunk:null, timer:null };
          meetingRecStarting=false;
          mr.ondataavailable=function(e){ if(e.data && e.data.size) uploadMeetingChunk(e.data); };
          mr.onstop=function(){ finalizeMeetingRecording(); };
          mr.start(20000);
          syncWakeLock();
          state.meeting.recording_status='recording';
          meetingRec.timer=setInterval(renderMeetingRecUi, 1000);
          window.onbeforeunload=function(){ return 'A meeting recording is running.'; };
          if(state.openItemId) postTopicMarker(state.openItemId);
          renderMeetingRecUi();
        })['catch'](function(e){
          try { stream.getTracks().forEach(function(t){ t.stop(); }); } catch(_){}
          startFailed(e.message);
        });
    })['catch'](function(e){ startFailed('Mic access denied: '+(e.message||e.name)); });
}

function stopMeetingRecording(){
  if(!meetingRec) return;
  var st=document.getElementById('mrec-status');
  if(st) st.innerHTML='<span class="spin" style="border-top-color:var(--navy)"></span> Finishing upload&hellip;';
  try { if(meetingRec.mr.state!=='inactive') meetingRec.mr.stop(); } catch(e){ finalizeMeetingRecording(); }
}

function finalizeMeetingRecording(){
  var rec=meetingRec; if(!rec) return;
  meetingRec=null;
  syncWakeLock();
  window.onbeforeunload=null;
  if(rec.timer) clearInterval(rec.timer);
  try { rec.stream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
  // Repaint NOW. Clearing meetingRec and the 1s timer without re-rendering left
  // the red recording bar frozen on screen for the whole upload-and-finish
  // round trip — the microphone was already off but the UI still said
  // "Recording". The bar switches to a neutral "finishing" state instead.
  meetingRecFinishing=true;
  renderMeetingRecUi();
  var settle=function(){ meetingRecFinishing=false; renderMeetingRecUi(); };
  rec.chain.then(function(){
    if(rec.failedChunk){
      var fd=new FormData(); fd.append('file', rec.failedChunk, 'chunk.webm');
      return apiForm('/api/meeting-recordings/'+rec.recordingId+'/chunk', fd)['catch'](function(){});
    }
  }).then(function(){
    return api('/api/meeting-recordings/'+rec.recordingId+'/finish', { method:'POST' });
  }).then(function(res){
    if(!res || !res.ok){ msg('mrec-msg','err',(res&&res.error)||'Could not queue processing.'); settle(); return; }
    // The meeting on screen may have changed while the upload drained.
    if(state.meeting && state.meeting.id===rec.meetingId) state.meeting.recording_status='queued';
    settle();
    if(typeof startPolling==='function') startPolling();
  })['catch'](function(e){ msg('mrec-msg','err',e.message); settle(); });
}

// ── Status polling ──────────────────────────────────────────────────────────
// Runs only while a meeting is open AND something is queued or transcribing.
var pollTimer=null, pollGen=0;
// Extra rounds after something settles: the server queues the follow-on
// summary a moment after the transcription finishes, and the poll must not
// stop in that gap.
var pollGrace=0;

function anyTranscribing(){
  return state.items.some(function(it){ return isTranscribing(it); });
}

// True while the whole-meeting recording is queued or being processed.
function meetingProcessing(){
  var m=state.meeting;
  return !!m && (m.recording_status==='queued' || m.recording_status==='processing');
}
function anySummarizing(){
  return state.items.some(function(it){ return it.summarize_status==='queued' || it.summarize_status==='processing'; });
}
function reportPending(){ return !!(state.report && state.report.status==='pending'); }
function anyPendingWork(){ return anyTranscribing() || meetingProcessing() || anySummarizing() || reportPending() || pollGrace>0; }

// Bumping pollGen invalidates every in-flight poll response: openMeeting and
// showList both call this on navigation, so a fetch started for the meeting
// you just left can never re-arm the timer or clobber the meeting you're
// looking at now with stale data.
function stopPolling(){
  pollGen++; pollGrace=0;
  if(pollTimer){ clearTimeout(pollTimer); pollTimer=null; }
  // Both callers are navigations. A debounced summarize queued against the
  // meeting being left must not fire against the one being opened.
  clearScheduledSummaries();
}

function startPolling(){
  if(pollTimer) return;
  pollTimer=setTimeout(pollOnce, 3000);
}

function pollOnce(){
  pollTimer=null;
  if(!state.meeting){ return; }
  var gen=pollGen;
  api('/api/meetings/'+state.meeting.id+'/status').then(function(res){
    if(gen!==pollGen) return;
    if(!res.ok){ if(anyPendingWork()) startPolling(); return; }
    var wasMeetingBusy = meetingProcessing();
    if(res.meeting && state.meeting){
      state.meeting.recording_status = res.meeting.recordingStatus || state.meeting.recording_status;
      state.meeting.recording_error  = res.meeting.recordingError || '';
    }
    var meetingSettled = wasMeetingBusy && !meetingProcessing();
    if(res.meeting && state.meeting) renderMeetingRecUi();
    if(pollGrace>0) pollGrace--;
    var settled=[], summariesLanded=false;
    res.items.forEach(function(s){
      var it=state.items.filter(function(x){ return x.id===s.id; })[0];
      if(!it) return;
      var was=it.transcribe_status;
      it.transcribe_status=s.transcribeStatus;
      it.transcribe_error=s.transcribeError;
      var wasSummarizing=it.summarize_status==='queued' || it.summarize_status==='processing';
      it.summarize_status=s.summarizeStatus;
      it.summarize_error=s.summarizeError;
      if(wasSummarizing && s.summarizeStatus!=='queued' && s.summarizeStatus!=='processing') summariesLanded=true;
      if((was==='queued'||was==='processing') && !isTranscribing(it)) settled.push(it);
      else refreshItemView(it);
    });
    if(res.guests && JSON.stringify(res.guests)!==JSON.stringify(state.guests||[])){
      state.guests=res.guests; guestsChanged();
    }
    var reportWasPending=reportPending();
    if(res.report){ state.report=res.report; }
    var reportLanded=reportWasPending && !reportPending();
    if(!reportLanded) renderReportState();
    // Attendees can change behind our back: another user, or auto-linked people
    // from action items. Keep the chips and the speaker dropdowns honest.
    if(res.attendeeIds && res.attendeeIds.join(',')!==state.attendeeIds.join(',')){
      state.attendeeIds=res.attendeeIds;
      renderAttendeeChips();
      state.items.forEach(function(x){ renderPresenterChips(x); renderSpeakerMap(x); });
    }
    if(settled.length || meetingSettled) pollGrace=2;
    if(!settled.length && !meetingSettled && !summariesLanded && !reportLanded){ afterPollRound(); return; }
    // Something finished — pull the full detail so we get segments, speaker
    // map, rendered transcripts, new summaries, and any finished report.
    return api('/api/meetings/'+state.meeting.id).then(function(det){
      if(gen!==pollGen) return;
      if(det.ok){
        state.meeting=det.meeting;
        state.meetingRecordings = det.meetingRecordings || [];
        state.meetingSpeakerStats = det.meetingSpeakerStats || [];
        syncItems(det.items);
        renderMeetingRecUi();
        if(typeof renderMeetingSpeakerPanel==='function') renderMeetingSpeakerPanel();
        state.guests = det.guests || state.guests;
        if(det.report) state.report = det.report;
        if(reportLanded && state.report.status==='idle' && det.meeting.report){
          showReport(det.meeting.report);
          msg('report-msg','ok','Report generated.');
        }
        renderReportState();
        settled.forEach(function(it){
          var live=state.items.filter(function(x){ return x.id===it.id; })[0];
          if(live) refreshItemView(live);
        });
        // Summaries of the new transcripts are queued by the server itself.
      }
      afterPollRound();
    });
  }).catch(function(){ if(gen===pollGen && anyPendingWork()) startPolling(); });
}

// Keep polling while work remains on the server.
function afterPollRound(){
  if(anyPendingWork()) startPolling();
}

// ── Report ──────────────────────────────────────────────────────────────────
// Every item with content must be summarized first. Collapse the open item and
// summarize any pending items, then write the report.
function generateReport(){
  if(state.openItemId){ var open=state.items.filter(function(x){return x.id===state.openItemId;})[0]; if(open) collapseItem(open); }
  setBtn('btn-report', true, 'Starting…');
  var mid=state.meeting.id;
  api('/api/meetings/'+mid+'/report', { method:'POST' }).then(function(res){
    if(!state.meeting || state.meeting.id!==mid) return;
    if(!res.ok){ setBtn('btn-report', false); msg('report-msg','err',res.error); return; }
    state.report=res.report;
    if(typeof res.markdown==='string'){ showReport(res.markdown); msg('report-msg','ok','Report generated.'); }
    renderReportState();
    if(reportPending()) startPolling();
  });
}

function showReport(markdown){
  state.meeting.report=markdown;
  document.getElementById('report-box').innerHTML='<div class="report">'+renderMarkdown(markdown)+'</div>';
}

// The report controls follow the server: generating, failed, or ready — and,
// when ready, whether it still matches the item summaries.
// Edits that change what the report would say (attendance, guests, titles,
// presenters) re-check whether the saved report is still current. Debounced:
// a run of chip clicks costs one request.
var reportRefreshTimer=null;
function refreshReportSoon(){
  if(!state.meeting || !state.meeting.report) return;
  if(reportRefreshTimer) clearTimeout(reportRefreshTimer);
  var mid=state.meeting.id;
  reportRefreshTimer=setTimeout(function(){
    reportRefreshTimer=null;
    api('/api/meetings/'+mid+'/status').then(function(res){
      if(!res.ok || !state.meeting || state.meeting.id!==mid || !res.report) return;
      state.report=res.report; renderReportState();
    });
  }, 600);
}

function renderReportState(){
  var btn=document.getElementById('btn-report'); if(!btn || !state.meeting) return;
  var r=state.report||{ status:'idle', error:'', changes:[] };
  var has=!!state.meeting.report;
  var ra=document.getElementById('report-actions'); if(ra) ra.style.display = has ? '' : 'none';
  btn.setAttribute('data-default', has ? 'Regenerate report' : 'Generate report');
  if(r.status==='pending'){
    setBtn('btn-report', true, 'Generating…');
    var waiting=state.items.filter(function(it){ return isTranscribing(it) || it.summarize_status==='queued' || it.summarize_status==='processing'; }).length;
    msg('report-msg','info', meetingProcessing() ? 'Waiting for the meeting recording to finish processing…'
      : waiting ? 'Waiting for '+waiting+' item'+(waiting===1?'':'s')+' to finish transcribing or summarizing…'
      : 'Writing the report…');
  } else {
    setBtn('btn-report', false);
    var cur=document.getElementById('report-msg');
    if(r.status==='error') msg('report-msg','err',r.error||'The report could not be generated.');
    else if(cur && /alert-(info|err)/.test(cur.innerHTML)) msg('report-msg','','');
  }
  var st=document.getElementById('report-stale');
  if(st){
    var changes=(has && r.status!=='pending') ? (r.changes||[]) : [];
    st.innerHTML = changes.length
      ? '<div class="alert alert-warn"><strong>This report is out of date.</strong> Since it was generated'
        +(r.generatedAt?' ('+esc(fmtDate(r.generatedAt))+')':'')+':<ul>'
        +changes.map(function(c){ return '<li>'+esc(c)+'</li>'; }).join('')
        +'</ul>Regenerate it to bring it up to date.</div>'
      : (has && r.status!=='pending' ? '<div class="hint report-current">Up to date with the agenda item summaries'
        +(r.generatedAt?' &middot; generated '+esc(fmtDate(r.generatedAt)):'')+'.</div>' : '');
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
loadMe();
loadMeetings();
