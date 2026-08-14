// ── HTTP helpers ────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
async function apiForm(path, formData) {
  const res = await fetch(path, { method: 'POST', body: formData });
  return res.json();
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
      +'<div class="field"><input type="text" id="mf-danger-confirm" placeholder="'+esc(opts.danger.confirmText)+'"></div>'
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
      if(opts.danger){
        var dc=document.getElementById('mf-danger-confirm');
        var db=document.getElementById('modal-danger-btn');
        if(db) db.disabled = !dc || dc.value.trim() !== opts.danger.confirmText;
      }
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

  document.getElementById('modal-save').addEventListener('click', save);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', function(e){
    if(e.target && e.target.id==='modal-backdrop') closeModal();
  });
  modalEsc=function(e){
    if(e.key==='Escape'){ closeModal(); return; }
    if(e.key==='Enter' && e.target && e.target.tagName!=='TEXTAREA'){ save(); }
  };
  document.addEventListener('keydown', modalEsc);

  if(opts.danger){
    var confirmEl=document.getElementById('mf-danger-confirm');
    var dangerBtn=document.getElementById('modal-danger-btn');
    confirmEl.addEventListener('input', function(){
      dangerBtn.disabled = confirmEl.value.trim() !== opts.danger.confirmText;
    });
    dangerBtn.addEventListener('click', function(){
      if(dangerBtn.disabled) return;
      setBtn('modal-danger-btn', true, 'Deleting...');
      opts.danger.onConfirm(done);
    });
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
    if(b){ if(!inList){ out.push('<ul>'); inList=true; } out.push('<li>'+inline(b[1])+'</li>'); continue; }
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
  stopPolling(); state.reportPending=false;
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
  stopPolling(); state.reportPending=false;
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
    +'<div class="hint" style="margin-bottom:8px">Select attendees from the people library (add more under the People tab). Attendees become selectable as presenters below.</div>'
    +'<div class="chips" id="attendee-chips"></div></div>';

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
    +'<div class="btn-row"><button class="btn btn-gold" id="btn-report" data-default="'+(m.report?'Regenerate report':'Generate report')+'">'+(m.report?'Regenerate report':'Generate report')+'</button>'
    +'<span id="report-actions"'+(m.report?'':' style="display:none"')+'>'
    +'<a class="btn btn-secondary" id="btn-report-dl" href="/api/meetings/'+m.id+'/report.md" download>Download .md</a> '
    +'<button class="btn btn-secondary" id="btn-report-print" data-default="Print / PDF">Print / PDF</button>'
    +'</span></div>'
    +'<div id="report-box" style="margin-top:14px">'+(m.report?'<div class="report">'+renderMarkdown(m.report)+'</div>':'')+'</div>';

  document.getElementById('detail-body').innerHTML=h;

  renderAttendeeChips();
  renderItems();
  renderMeetingRecUi();
  renderMeetingSpeakerPanel();

  document.getElementById('btn-edit-meeting').addEventListener('click', editMeeting);
  document.getElementById('btn-upload-agenda').addEventListener('click', uploadAgenda);
  document.getElementById('btn-add-item').addEventListener('click', addItemManually);
  document.getElementById('btn-meeting-rec').addEventListener('click', toggleMeetingRecording);
  document.getElementById('btn-report').addEventListener('click', generateReport);
  document.getElementById('btn-report-print').addEventListener('click', function(){ window.print(); });
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
      }).catch(function(e){ done(e.message); });
    },
    danger: {
      label: 'Delete meeting',
      hint: 'Deleting this meeting also deletes its agenda items, transcripts, recordings, and report. This cannot be undone. Type the meeting title to confirm.',
      confirmText: m.title,
      onConfirm: function(done){
        api('/api/meetings/'+m.id, { method:'DELETE' }).then(function(res){
          if(res && res.ok===false){ done(res.error||'Could not delete.'); return; }
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
}
function toggleAttendee(pid){
  var i=state.attendeeIds.indexOf(pid);
  if(i>=0) state.attendeeIds.splice(i,1); else state.attendeeIds.push(pid);
  api('/api/meetings/'+state.meeting.id+'/attendees', { method:'PUT', body:{ personIds:state.attendeeIds } });
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
    it.presenter_ids=f.presenter_ids; it.transcript_source=f.transcript_source;
    // Never clobber text the user is actively editing.
    var tx=document.getElementById('tx-'+it.id);
    if(!tx || document.activeElement!==tx) it.transcript=f.transcript;
    var nt=document.getElementById('nt-'+it.id);
    if(!nt || document.activeElement!==nt) it.notes=f.notes;
    if(!it._summarizing && !it._dirty){ it.summary=f.summary; it.action_items=f.action_items; }
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
      +'<div class="chips" id="pres-'+it.id+'"></div>'
      +'<div class="sublbl">Transcript (AI, with speaker labels)</div>'
      +'<div class="rec-row">'
        +'<button class="btn-sm" data-rec="'+it.id+'">● Record</button>'
        +'<label class="btn-sm" style="cursor:pointer">Upload audio<input type="file" accept="audio/*,video/webm" data-audio="'+it.id+'" style="display:none"></label>'
        +'<span class="rec-status" id="recstat-'+it.id+'"></span>'
      +'</div>'
      +'<div class="speakers" id="spk-'+it.id+'"></div>'
      +'<div class="recordings" id="rec-'+it.id+'"></div>'
      +'<textarea id="tx-'+it.id+'" placeholder="Record or upload audio to transcribe. Speakers are labeled once you record; you can also edit this text." style="margin-top:6px">'+esc(it.transcript)+'</textarea>'
      +'<div class="sublbl">Notes (typed)</div>'
      +'<textarea id="nt-'+it.id+'" placeholder="Optional manual notes">'+esc(it.notes)+'</textarea>'
      +'<div class="hint" style="margin-top:8px">The summary is generated automatically when you collapse this item or open another. Editing the transcript or notes clears it so it regenerates.</div>'
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
  if(it._summarizing) return '<span class="badge b-pending"><span class="spin" style="border-top-color:var(--pending-fg)"></span> Summarizing&hellip;</span>';
  if(it._summaryError) return '<span class="badge b-rejected">Summary failed</span>';
  if(it.summary && !it._dirty) return '<span class="badge b-approved">Summary ready</span>';
  if(itemHasContent(it)) return '<span class="badge b-changes_requested">Needs summary</span>';
  return '';
}
function refreshBadge(it){
  var b=document.getElementById('badge-'+it.id); if(b) b.innerHTML=itemBadgeInner(it);
}

// Rendered summary + action-item list for an item.
function summaryHtml(it){
  var h='';
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

// Content changed → the existing summary is stale. Clear it (locally + server)
// and mark the item so it regenerates when collapsed / another item opens.
function invalidateSummary(it){
  it._dirty=true; it._summaryError=false;
  if(it.summary || (it.action_items && it.action_items.length)){
    it.summary=''; it.action_items=[];
    var sumEl=document.getElementById('sum-'+it.id); if(sumEl) sumEl.innerHTML='';
    saveItemField(it, { summary:'', actionItems:[], status:'pending' });
  }
  refreshBadge(it);
}

// Generate the summary when there is something to summarize AND no
// transcription is pending for this item. A queued or in-flight transcription
// always wins: summarizing now would describe a transcript about to change.
function summarizeIfNeeded(it){
  if(isTranscribing(it) || meetingProcessing()) return Promise.resolve();
  if(!itemHasContent(it)) return Promise.resolve();
  if(it.summary && !it._dirty) return Promise.resolve();
  if(it._summarizing) return it._summarizing;
  return autoSummarize(it);
}

// Generate the summary + action items for one item. Returns a promise and
// stores it on it._summarizing so concurrent triggers coalesce.
function autoSummarize(it){
  it._summarizing = saveItemField(it, { transcript: it.transcript, notes: it.notes })
    .then(function(){ refreshBadge(it); return api('/api/items/'+it.id+'/summarize', { method:'POST' }); })
    .then(function(res){
      it._summarizing=null;
      if(!res.ok){ it._summaryError=true; refreshBadge(it); var im=document.getElementById('imsg-'+it.id); if(im) im.innerHTML='<span style="color:var(--rej-fg);font-size:12px">'+esc(res.error)+'</span>'; return; }
      it.summary=res.summary; it.action_items=res.actionItems||[]; it._dirty=false; it._summaryError=false; it.status='done';
      var sumEl=document.getElementById('sum-'+it.id); if(sumEl) sumEl.innerHTML=summaryHtml(it);
      // Auto-linked people from action items may have joined the meeting / this item.
      if(res.attendeeIds){ state.attendeeIds=res.attendeeIds; renderAttendeeChips(); }
      if(res.presenterIds){ it.presenter_ids=res.presenterIds; }
      state.items.forEach(function(x){ renderPresenterChips(x); });
      refreshBadge(it);
    })
    .catch(function(e){ it._summarizing=null; it._summaryError=true; refreshBadge(it); });
  refreshBadge(it);
  return it._summarizing;
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
  var attendees=state.attendeeIds.map(function(id){ return state.peopleById[id]; }).filter(Boolean);
  var opts=function(sel){
    var o='<option value="">— unlabeled —</option>';
    attendees.forEach(function(p){ o+='<option value="'+esc(p.name)+'"'+(sel===p.name?' selected':'')+'>'+esc(p.name)+'</option>'; });
    // Keep a currently-set name that isn't in the attendee list as an option too.
    if(sel && attendees.every(function(p){return p.name!==sel;})) o+='<option value="'+esc(sel)+'" selected>'+esc(sel)+'</option>';
    return o;
  };
  el.innerHTML='<div class="sublbl">Who is speaking?</div><div class="spk-rows">'
    + stats.map(function(st){
        var cur=(it.speaker_map||{})[st.speaker]||'';
        var pct=Math.round(st.share*100);
        return '<div class="spk-row"><span class="spk-tag">'+esc(st.label)+'</span>'
          +'<span class="spk-share">'+pct+'%</span>'
          +'<select data-spk="'+esc(st.speaker)+'">'+opts(cur)+'</select>'
          +(st.sample?'<div class="spk-sample">&ldquo;'+esc(st.sample)+'&rdquo;</div>':'')
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
    });
  });
}

// Meeting-wide speaker naming: one set of voices for the whole recording.
// Saving rewrites every meeting-sourced topic's transcript server-side.
var savingMspk=false; // true only while a PUT .../speaker-map is in flight (blocks double-submit)
function renderMeetingSpeakerPanel(){
  var el=document.getElementById('meeting-speakers'); if(!el) return;
  var stats=state.meetingSpeakerStats||[];
  if(!stats.length){ el.innerHTML=''; return; }
  var map=(state.meeting && state.meeting.speaker_map)||{};
  var attendees=state.attendeeIds.map(function(id){ return state.peopleById[id]; }).filter(Boolean);
  var opts=function(sel){
    var o='<option value="">— unlabeled —</option>';
    attendees.forEach(function(p){ o+='<option value="'+esc(p.name)+'"'+(sel===p.name?' selected':'')+'>'+esc(p.name)+'</option>'; });
    if(sel && attendees.every(function(p){return p.name!==sel;})) o+='<option value="'+esc(sel)+'" selected>'+esc(sel)+'</option>';
    return o;
  };
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
          msg('mspk-msg','ok','Speakers saved — transcripts updated.');
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
  if(!attendees.length){ el.innerHTML='<span class="chip empty-hint">Select attendees above first.</span>'; return; }
  el.innerHTML=attendees.map(function(p){
    var on=it.presenter_ids.indexOf(p.id)>=0;
    return '<span class="chip pres'+(on?' on':'')+'" data-pp="'+p.id+'">'+esc(p.name)+'</span>';
  }).join('');
  el.querySelectorAll('.chip[data-pp]').forEach(function(c){
    c.addEventListener('click', function(){
      var pid=Number(c.getAttribute('data-pp'));
      var i=it.presenter_ids.indexOf(pid);
      if(i>=0) it.presenter_ids.splice(i,1); else it.presenter_ids.push(pid);
      saveItemField(it, { presenterIds: it.presenter_ids });
      renderPresenterChips(it);
    });
  });
}

function saveItemField(it, fields){
  return api('/api/items/'+it.id, { method:'PATCH', body:fields });
}

function removeItem(it){
  if(!confirm('Remove "'+it.title+'"?')) return;
  api('/api/items/'+it.id, { method:'DELETE' }).then(function(){
    state.items=state.items.filter(function(x){ return x.id!==it.id; });
    renderItems();
  });
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

function toggleRecording(it, btn){
  if(activeRec && activeRec.it.id===it.id){ stopRecording(); return; }
  if(activeRec){ stopRecording(); }
  var rs=document.getElementById('recstat-'+it.id);
  if(meetingRec){ rs.innerHTML='<span style="color:var(--rej-fg)">The meeting recording is running — it will capture this topic automatically.</span>'; return; }
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
      btn.innerHTML='<span class="rec-dot"></span> Stop &amp; transcribe';
      rs.innerHTML='<span class="rec-dot"></span> Recording…';
    })
    .catch(function(e){ rs.innerHTML='<span style="color:var(--rej-fg)">Mic access denied: '+esc(e.message||e.name)+'</span>'; });
}

function stopRecording(){
  if(!activeRec) return;
  var r=activeRec; activeRec=null;
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
  transcribeBlob(it, f, f.type);
}

// ── Whole-meeting recording ─────────────────────────────────────────────────
// One MediaRecorder for the entire meeting. ~20s chunks upload as they are
// produced (strictly ordered by a promise chain), so a crash loses seconds,
// not the meeting. Topic clicks lay down markers; processing segments by them.
var meetingRec=null; // {meetingId, recordingId, mr, stream, t0, chain, failedChunk, timer}
var meetingRecStarting=false; // true only during the getUserMedia→POST /recording/start window

function meetingElapsedSeconds(){ return meetingRec ? (performance.now()-meetingRec.t0)/1000 : 0; }
function fmtClock(s){ var m=Math.floor(s/60), r=Math.floor(s%60); return m+':'+(r<10?'0':'')+r; }

function renderMeetingRecUi(){
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
        if(rb) rb.addEventListener('click', function(){
          var last=state.meetingRecordings[state.meetingRecordings.length-1];
          api('/api/meeting-recordings/'+last.id+'/reprocess', { method:'POST' }).then(function(res){
            if(!res.ok){ msg('mrec-msg','err',res.error||'Could not queue processing.'); return; }
            state.meeting.recording_status='queued';
            renderMeetingRecUi();
            startPolling();
          })['catch'](function(e){ msg('mrec-msg','err',e.message); });
        });
      }
      else if(rs==='done' && state.meetingRecordings && state.meetingRecordings.length){
        var lastRec=state.meetingRecordings[state.meetingRecordings.length-1];
        ex.innerHTML='<div class="hint">Processed. <a href="/api/meeting-recordings/'+lastRec.id+'/download">Download the recording</a></div>';
      }
      else ex.innerHTML='';
    }
  }
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
          meetingRec={ meetingId:state.meeting.id, recordingId:res.recordingId, mr:mr, stream:stream,
                       t0:performance.now(), chain:Promise.resolve(), failedChunk:null, timer:null };
          meetingRecStarting=false;
          mr.ondataavailable=function(e){ if(e.data && e.data.size) uploadMeetingChunk(e.data); };
          mr.onstop=function(){ finalizeMeetingRecording(); };
          mr.start(20000);
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
  window.onbeforeunload=null;
  if(rec.timer) clearInterval(rec.timer);
  try { rec.stream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
  rec.chain.then(function(){
    if(rec.failedChunk){
      var fd=new FormData(); fd.append('file', rec.failedChunk, 'chunk.webm');
      return apiForm('/api/meeting-recordings/'+rec.recordingId+'/chunk', fd)['catch'](function(){});
    }
  }).then(function(){
    return api('/api/meeting-recordings/'+rec.recordingId+'/finish', { method:'POST' });
  }).then(function(res){
    if(!res || !res.ok){ msg('mrec-msg','err',(res&&res.error)||'Could not queue processing.'); renderMeetingRecUi(); return; }
    state.meeting.recording_status='queued';
    renderMeetingRecUi();
    if(typeof startPolling==='function') startPolling();
  })['catch'](function(e){ msg('mrec-msg','err',e.message); renderMeetingRecUi(); });
}

// ── Status polling ──────────────────────────────────────────────────────────
// Runs only while a meeting is open AND something is queued or transcribing.
var pollTimer=null, pollGen=0;

function anyTranscribing(){
  return state.items.some(function(it){ return isTranscribing(it); });
}

// True while the whole-meeting recording is queued or being processed.
function meetingProcessing(){
  var m=state.meeting;
  return !!m && (m.recording_status==='queued' || m.recording_status==='processing');
}
function anyPendingWork(){ return anyTranscribing() || meetingProcessing(); }

// Bumping pollGen invalidates every in-flight poll response: openMeeting and
// showList both call this on navigation, so a fetch started for the meeting
// you just left can never re-arm the timer or clobber the meeting you're
// looking at now with stale data.
function stopPolling(){
  pollGen++;
  if(pollTimer){ clearTimeout(pollTimer); pollTimer=null; }
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
    var settled=[];
    res.items.forEach(function(s){
      var it=state.items.filter(function(x){ return x.id===s.id; })[0];
      if(!it) return;
      var was=it.transcribe_status;
      it.transcribe_status=s.transcribeStatus;
      it.transcribe_error=s.transcribeError;
      if((was==='queued'||was==='processing') && !isTranscribing(it)) settled.push(it);
      else refreshItemView(it);
    });
    // Attendees can change behind our back: another user, or auto-linked people
    // from action items. Keep the chips and the speaker dropdowns honest.
    if(res.attendeeIds && res.attendeeIds.join(',')!==state.attendeeIds.join(',')){
      state.attendeeIds=res.attendeeIds;
      renderAttendeeChips();
      state.items.forEach(function(x){ renderPresenterChips(x); renderSpeakerMap(x); });
    }
    if(!settled.length && !meetingSettled){ afterPollRound(); return; }
    // Something finished — pull the full detail so we get segments, speaker map
    // and the rendered transcript, then decide about summaries.
    return api('/api/meetings/'+state.meeting.id).then(function(det){
      if(gen!==pollGen) return;
      if(det.ok){
        state.meeting=det.meeting;
        state.meetingRecordings = det.meetingRecordings || [];
        state.meetingSpeakerStats = det.meetingSpeakerStats || [];
        syncItems(det.items);
        renderMeetingRecUi();
        if(typeof renderMeetingSpeakerPanel==='function') renderMeetingSpeakerPanel();
        settled.forEach(function(it){
          var live=state.items.filter(function(x){ return x.id===it.id; })[0];
          if(live) onTranscriptionSettled(live);
        });
      }
      afterPollRound();
    });
  }).catch(function(){ if(gen===pollGen && anyPendingWork()) startPolling(); });
}

// Keep polling while work remains; once the queue drains, honour a pending
// "Generate report" click by re-invoking it automatically.
function afterPollRound(){
  if(anyPendingWork()){ startPolling(); return; }
  if(state.reportPending){ state.reportPending=false; generateReport(); }
}

// A transcription just finished. Its content is new, so any old summary is
// stale. If the topic is CLOSED, summarize it now — this is the deferred
// auto-summary the user asked for. If it is open, leave it: closing it will.
function onTranscriptionSettled(it){
  if(it.transcribe_status==='error'){ refreshItemView(it); return; }
  it._dirty=true; it._summaryError=false;
  refreshItemView(it);
  if(state.openItemId!==it.id) summarizeIfNeeded(it);
}

// ── Report ──────────────────────────────────────────────────────────────────
// Every item with content must be summarized first. Collapse the open item and
// summarize any pending items, then write the report.
function generateReport(){
  setBtn('btn-report', true, 'Preparing…');
  if(state.openItemId){ var open=state.items.filter(function(x){return x.id===state.openItemId;})[0]; if(open) collapseItem(open); }
  var busy=state.items.filter(function(it){ return isTranscribing(it); });
  if(busy.length || meetingProcessing()){
    // Wait for the queue: the poller re-invokes generateReport once the last
    // transcription settles, so the user clicks once and the report follows.
    msg('report-msg','info','Waiting for processing to finish&hellip;');
    setBtn('btn-report', true, 'Waiting…');
    state.reportPending=true;
    startPolling();
    return;
  }
  var pending=state.items.filter(function(it){ return itemHasContent(it) && (!it.summary || it._dirty || it._summarizing); });
  if(pending.length) msg('report-msg','info','Summarizing '+pending.length+' item'+(pending.length===1?'':'s')+' before the report…');
  var chain=Promise.resolve();
  pending.forEach(function(it){ chain=chain.then(function(){ return summarizeIfNeeded(it); }); });
  chain.then(function(){
    // Bail if any item still failed to summarize.
    var failed=state.items.filter(function(it){ return it._summaryError; });
    if(failed.length){ setBtn('btn-report', false); msg('report-msg','err','Some items could not be summarized. Fix those, then try again.'); return null; }
    setBtn('btn-report', true, 'Generating…');
    msg('report-msg','info','Writing the meeting report with AI…');
    return api('/api/meetings/'+state.meeting.id+'/report', { method:'POST' });
  }).then(function(res){
    if(!res){ return; }
    setBtn('btn-report', false);
    if(!res.ok){ msg('report-msg','err',res.error); return; }
    msg('report-msg','ok','Report generated.');
    state.meeting.report=res.report;
    document.getElementById('report-box').innerHTML='<div class="report">'+renderMarkdown(res.report)+'</div>';
    document.getElementById('btn-report').setAttribute('data-default','Regenerate report');
    document.getElementById('btn-report').textContent='Regenerate report';
    var ra=document.getElementById('report-actions'); if(ra) ra.style.display='';
  }).catch(function(e){ setBtn('btn-report', false); msg('report-msg','err',e.message); });
}

// ── Boot ────────────────────────────────────────────────────────────────────
loadMe();
loadMeetings();
