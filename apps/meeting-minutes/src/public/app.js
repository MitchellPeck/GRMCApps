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
var state = { people: [], peopleById: {}, meeting: null, attendeeIds: [], items: [], whisperModel: 'small' };
// Learn which Whisper model the server loaded so the live stream matches it.
api('/api/transcription-config').then(function(r){ if(r && r.ok && r.model) state.whisperModel = r.model; }).catch(function(){});

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
  var name=prompt('Name:', p.name); if(name===null) return;
  var title=prompt('Role / title (optional):', p.title||''); if(title===null) return;
  var email=prompt('Email (optional):', p.email||''); if(email===null) return;
  api('/api/people/'+id, { method:'PUT', body:{ name:name, title:title, email:email } }).then(function(res){
    if(!res.ok){ msg('person-msg','err',res.error); return; }
    loadPeople();
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
    renderDetail();
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
    +'<div class="btn-row"><button class="btn btn-gold" id="btn-report" data-default="'+(m.report?'Regenerate report':'Generate report')+'">'+(m.report?'Regenerate report':'Generate report')+'</button></div>'
    +'<div id="report-box" style="margin-top:14px">'+(m.report?'<div class="report">'+renderMarkdown(m.report)+'</div>':'')+'</div>';

  document.getElementById('detail-body').innerHTML=h;

  renderAttendeeChips();
  renderItems();

  document.getElementById('btn-edit-meeting').addEventListener('click', editMeeting);
  document.getElementById('btn-upload-agenda').addEventListener('click', uploadAgenda);
  document.getElementById('btn-add-item').addEventListener('click', addItemManually);
  document.getElementById('btn-report').addEventListener('click', generateReport);
}

function editMeeting(){
  var m=state.meeting;
  var title=prompt('Meeting title:', m.title); if(title===null||!title.trim()) return;
  var date=prompt('Date:', m.meeting_date||''); if(date===null) return;
  var loc=prompt('Location:', m.location||''); if(loc===null) return;
  api('/api/meetings/'+m.id, { method:'PATCH', body:{ title:title, meetingDate:date, location:loc } }).then(function(res){
    if(!res.ok) return;
    m.title=title.trim(); m.meeting_date=date.trim(); m.location=loc.trim();
    document.getElementById('d-title-txt').textContent=m.title;
    document.getElementById('d-meta-txt').innerHTML=[m.meeting_date,m.location].filter(Boolean).map(esc).join(' &middot; ');
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
  // Presenter options depend on attendees — refresh open item bodies.
  state.items.forEach(function(it){ renderPresenterChips(it); });
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
  var title=prompt('Agenda item title:'); if(!title||!title.trim()) return;
  var desc=prompt('Details (optional):')||'';
  api('/api/meetings/'+state.meeting.id+'/items', { method:'POST', body:{ title:title, description:desc } }).then(function(res){
    if(!res.ok){ msg('agenda-msg','err',res.error); return; }
    api('/api/meetings/'+state.meeting.id).then(function(det){
      if(det.ok){ state.items=det.items; renderItems(); }
    });
  });
}

// ── Agenda item cards ───────────────────────────────────────────────────────
function renderItems(){
  var wrap=document.getElementById('items-wrap');
  if(!state.items.length){ wrap.innerHTML='<div class="empty">No agenda items yet. Upload an agenda or add items manually.</div>'; return; }
  wrap.innerHTML=state.items.map(function(it, idx){ return itemHtml(it, idx); }).join('');
  state.items.forEach(function(it){ wireItem(it); });
}

function itemHtml(it, idx){
  var done = it.status==='done';
  return '<div class="item" id="item-'+it.id+'">'
    +'<div class="ihead" data-toggle-item="'+it.id+'">'
      +'<div class="itop"><div class="inum'+(done?' done':'')+'">'+(done?'✓':(idx+1))+'</div>'
      +'<div><div class="ititle">'+esc(it.title)+'</div>'
      +(it.description?'<div class="idesc">'+esc(it.description)+'</div>':'')
      +'</div></div>'
      +(it.summary?'<span class="badge b-approved">summarized</span>':'')
    +'</div>'
    +'<div class="ibody collapsed" id="ibody-'+it.id+'">'
      +'<div class="sublbl">Presented by</div>'
      +'<div class="chips" id="pres-'+it.id+'"></div>'
      +'<div class="sublbl">Transcript (AI)</div>'
      +'<div class="rec-row">'
        +'<button class="btn-sm" data-rec="'+it.id+'">● Start recording</button>'
        +'<label class="btn-sm" style="cursor:pointer">Upload audio<input type="file" accept="audio/*,video/webm" data-audio="'+it.id+'" style="display:none"></label>'
        +'<span class="rec-status" id="recstat-'+it.id+'"></span>'
      +'</div>'
      +'<textarea id="tx-'+it.id+'" placeholder="Live transcription appears here. You can also edit it." style="margin-top:6px">'+esc(it.transcript)+'</textarea>'
      +'<div class="interim" id="interim-'+it.id+'"></div>'
      +'<div class="sublbl">Notes (typed)</div>'
      +'<textarea id="nt-'+it.id+'" placeholder="Optional manual notes">'+esc(it.notes)+'</textarea>'
      +'<div class="btn-row">'
        +'<button class="btn btn-primary btn-sm" data-summarize="'+it.id+'" data-default="'+(it.summary?'Re-summarize':'Summarize this item')+'">'+(it.summary?'Re-summarize':'Summarize this item')+'</button>'
        +'<button class="btn btn-danger btn-sm" data-del-item="'+it.id+'">Remove item</button>'
        +'<span id="imsg-'+it.id+'"></span>'
      +'</div>'
      +'<div id="sum-'+it.id+'">'+(it.summary?'<div class="sublbl">Summary</div><div class="summary-box">'+esc(it.summary)+'</div>':'')+'</div>'
    +'</div>'
  +'</div>';
}

function wireItem(it){
  document.querySelector('[data-toggle-item="'+it.id+'"]').addEventListener('click', function(){
    document.getElementById('ibody-'+it.id).classList.toggle('collapsed');
  });
  renderPresenterChips(it);
  var tx=document.getElementById('tx-'+it.id);
  var nt=document.getElementById('nt-'+it.id);
  tx.addEventListener('blur', function(){ saveItemField(it, { transcript: tx.value }); it.transcript=tx.value; });
  nt.addEventListener('blur', function(){ saveItemField(it, { notes: nt.value }); it.notes=nt.value; });
  document.querySelector('[data-rec="'+it.id+'"]').addEventListener('click', function(){ toggleRecording(it, this); });
  document.querySelector('[data-audio="'+it.id+'"]').addEventListener('change', function(){ uploadAudio(it, this); });
  document.querySelector('[data-summarize="'+it.id+'"]').addEventListener('click', function(){ summarize(it); });
  document.querySelector('[data-del-item="'+it.id+'"]').addEventListener('click', function(){ removeItem(it); });
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

function summarize(it){
  var tx=document.getElementById('tx-'+it.id), nt=document.getElementById('nt-'+it.id);
  it.transcript=tx.value; it.notes=nt.value;
  var imsg=document.getElementById('imsg-'+it.id);
  // Persist latest transcript/notes before summarizing.
  saveItemField(it, { transcript: tx.value, notes: nt.value }).then(function(){
    imsg.innerHTML='<span class="spin" style="border-top-color:var(--navy)"></span>';
    return api('/api/items/'+it.id+'/summarize', { method:'POST' });
  }).then(function(res){
    imsg.innerHTML='';
    if(!res.ok){ imsg.innerHTML='<span style="color:var(--rej-fg);font-size:12px">'+esc(res.error)+'</span>'; return; }
    it.summary=res.summary; it.status='done';
    document.getElementById('sum-'+it.id).innerHTML='<div class="sublbl">Summary</div><div class="summary-box">'+esc(res.summary)+'</div>';
    var btn=document.querySelector('[data-summarize="'+it.id+'"]'); btn.textContent='Re-summarize'; btn.setAttribute('data-default','Re-summarize');
    // Refresh number badge → check + summarized badge.
    var head=document.querySelector('[data-toggle-item="'+it.id+'"]');
    var num=head.querySelector('.inum'); num.classList.add('done'); num.textContent='✓';
    if(!head.querySelector('.badge')) head.insertAdjacentHTML('beforeend','<span class="badge b-approved">summarized</span>');
  }).catch(function(e){ imsg.innerHTML='<span style="color:var(--rej-fg);font-size:12px">'+esc(e.message)+'</span>'; });
}

function removeItem(it){
  if(!confirm('Remove "'+it.title+'"?')) return;
  api('/api/items/'+it.id, { method:'DELETE' }).then(function(){
    state.items=state.items.filter(function(x){ return x.id!==it.id; });
    renderItems();
  });
}

// ── Live transcription (self-hosted WhisperLive over WebSocket) ─────────────
// The browser captures mic audio, converts it to 16-bit PCM @ 16 kHz, and
// streams it to /ws/transcribe, which the server relays to the internal
// Whisper container. Segments come back as {text, completed}.
var activeRec = null; // { it, btn, ws, ctx, proc, source, gain, stream, base }

function downsampleTo16k(input, inRate){
  if(inRate === 16000) return input;
  var ratio = inRate / 16000;
  var outLen = Math.floor(input.length / ratio);
  var out = new Float32Array(outLen);
  for(var i=0;i<outLen;i++){
    // Average the source window mapped to each output sample (cheap anti-alias).
    var start = Math.floor(i*ratio), end = Math.floor((i+1)*ratio), sum=0, n=0;
    for(var j=start;j<end && j<input.length;j++){ sum+=input[j]; n++; }
    out[i] = n ? sum/n : input[start] || 0;
  }
  return out;
}
function floatTo16(f32){
  var out = new Int16Array(f32.length);
  for(var i=0;i<f32.length;i++){ var s=Math.max(-1,Math.min(1,f32[i])); out[i]= s<0 ? s*0x8000 : s*0x7fff; }
  return out;
}

function toggleRecording(it, btn){
  if(activeRec && activeRec.it.id===it.id){ stopRecording(); return; }
  if(activeRec){ stopRecording(); }
  var rs=document.getElementById('recstat-'+it.id);
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    rs.innerHTML='<span style="color:var(--rej-fg)">This browser cannot capture audio. Upload a recording instead.</span>';
    return;
  }
  rs.textContent='Starting microphone…';
  navigator.mediaDevices.getUserMedia({ audio:{ channelCount:1, echoCancellation:true, noiseSuppression:true } })
    .then(function(stream){ startStream(it, btn, stream); })
    .catch(function(e){ rs.innerHTML='<span style="color:var(--rej-fg)">Mic access denied: '+esc(e.message||e.name)+'</span>'; });
}

function startStream(it, btn, stream){
  var tx=document.getElementById('tx-'+it.id);
  var interimEl=document.getElementById('interim-'+it.id);
  var rs=document.getElementById('recstat-'+it.id);
  var base = tx.value;

  var AC = window.AudioContext || window.webkitAudioContext;
  var ctx = new AC();
  var source = ctx.createMediaStreamSource(stream);
  var proc = ctx.createScriptProcessor(4096, 1, 1);
  var gain = ctx.createGain(); gain.gain.value = 0; // silence local monitoring (no echo)

  var proto = location.protocol==='https:' ? 'wss' : 'ws';
  var ws = new WebSocket(proto+'://'+location.host+'/ws/transcribe');
  ws.binaryType='arraybuffer';
  var ready=false;

  activeRec = { it:it, btn:btn, ws:ws, ctx:ctx, proc:proc, source:source, gain:gain, stream:stream, base:base };

  ws.onopen=function(){
    ws.send(JSON.stringify({ uid:'mm-'+it.id+'-'+(state.meeting?state.meeting.id:0), language:'en', model:state.whisperModel, use_vad:true }));
    ready=true;
    rs.innerHTML='<span class="rec-dot"></span> Listening…';
  };
  ws.onmessage=function(ev){
    var data; try{ data=JSON.parse(ev.data); }catch(e){ return; }
    if(data.error){ rs.innerHTML='<span style="color:var(--rej-fg)">'+esc(data.error)+'</span>'; return; }
    if(!data.segments) return;
    var finals=data.segments.filter(function(s){return s.completed;}).map(function(s){return (s.text||'').trim();}).filter(Boolean).join(' ');
    var interim=data.segments.filter(function(s){return !s.completed;}).map(function(s){return (s.text||'').trim();}).filter(Boolean).join(' ');
    tx.value = base + (finals ? (base?'\n':'')+finals : '');
    if(interimEl) interimEl.textContent = interim;
  };
  ws.onerror=function(){ rs.innerHTML='<span style="color:var(--rej-fg)">Transcription connection error.</span>'; };

  proc.onaudioprocess=function(e){
    if(!ready || ws.readyState!==1) return;
    var input=e.inputBuffer.getChannelData(0);
    var ds=downsampleTo16k(input, ctx.sampleRate);
    ws.send(floatTo16(ds).buffer);
  };

  source.connect(proc); proc.connect(gain); gain.connect(ctx.destination);
  btn.innerHTML='<span class="rec-dot"></span> Stop recording';
}

function stopRecording(){
  if(!activeRec) return;
  var r=activeRec; activeRec=null;
  try { r.proc.onaudioprocess=null; r.source.disconnect(); r.proc.disconnect(); r.gain.disconnect(); } catch(e){}
  try { r.stream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
  try { r.ctx.close(); } catch(e){}
  // Give the server a moment to flush trailing segments, then close.
  setTimeout(function(){ try{ r.ws.close(); }catch(e){} }, 600);
  if(r.btn) r.btn.innerHTML='● Start recording';
  var interimEl=document.getElementById('interim-'+r.it.id); if(interimEl) interimEl.textContent='';
  var rs=document.getElementById('recstat-'+r.it.id);
  var tx=document.getElementById('tx-'+r.it.id);
  if(tx){ r.it.transcript=tx.value; saveItemField(r.it, { transcript: tx.value }); }
  if(rs) rs.textContent='Saved.';
}

// ── Audio upload → Whisper transcription ────────────────────────────────────
function uploadAudio(it, input){
  if(!input.files.length) return;
  var rs=document.getElementById('recstat-'+it.id);
  rs.innerHTML='<span class="spin" style="border-top-color:var(--navy)"></span> Transcribing…';
  var fd=new FormData(); fd.append('file', input.files[0]);
  apiForm('/api/items/'+it.id+'/transcribe', fd).then(function(res){
    input.value='';
    if(!res.ok){ rs.innerHTML='<span style="color:var(--rej-fg)">'+esc(res.error)+'</span>'; return; }
    it.transcript=res.transcript;
    document.getElementById('tx-'+it.id).value=res.transcript;
    rs.textContent='Transcribed.';
  }).catch(function(e){ rs.innerHTML='<span style="color:var(--rej-fg)">'+esc(e.message)+'</span>'; });
}

// ── Report ──────────────────────────────────────────────────────────────────
function generateReport(){
  setBtn('btn-report', true, 'Generating…');
  msg('report-msg','info','Writing the meeting report with AI…');
  api('/api/meetings/'+state.meeting.id+'/report', { method:'POST' }).then(function(res){
    setBtn('btn-report', false);
    if(!res.ok){ msg('report-msg','err',res.error); return; }
    msg('report-msg','ok','Report generated.');
    state.meeting.report=res.report;
    document.getElementById('report-box').innerHTML='<div class="report">'+renderMarkdown(res.report)+'</div>';
    document.getElementById('btn-report').setAttribute('data-default','Regenerate report');
    document.getElementById('btn-report').textContent='Regenerate report';
  }).catch(function(e){ setBtn('btn-report', false); msg('report-msg','err',e.message); });
}

// ── Boot ────────────────────────────────────────────────────────────────────
loadMe();
loadMeetings();
