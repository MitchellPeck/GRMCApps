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
  state.openItemId=null; // DOM rebuilt → all bodies collapsed
  if(!state.items.length){ wrap.innerHTML='<div class="empty">No agenda items yet. Upload an agenda or add items manually.</div>'; return; }
  wrap.innerHTML=state.items.map(function(it, idx){ return itemHtml(it, idx); }).join('');
  state.items.forEach(function(it){ wireItem(it); });
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
      +'<textarea id="tx-'+it.id+'" placeholder="Record or upload audio to transcribe. Speakers are labeled once you record; you can also edit this text." style="margin-top:6px">'+esc(it.transcript)+'</textarea>'
      +'<div class="sublbl">Notes (typed)</div>'
      +'<textarea id="nt-'+it.id+'" placeholder="Optional manual notes">'+esc(it.notes)+'</textarea>'
      +'<div class="hint" style="margin-top:8px">The summary is generated automatically when you collapse this item or open another. Editing the transcript or notes clears it so it regenerates.</div>'
      +'<div class="btn-row">'
        +'<button class="btn btn-danger btn-sm" data-del-item="'+it.id+'">Remove item</button>'
        +'<span id="imsg-'+it.id+'"></span>'
      +'</div>'
      +'<div id="sum-'+it.id+'">'+summaryHtml(it)+'</div>'
    +'</div>'
  +'</div>';
}

// True when the item has content worth summarizing.
function itemHasContent(it){ return !!((it.transcript && it.transcript.trim()) || (it.notes && it.notes.trim())); }

// The header status badge inner HTML for an item's current summary state.
function itemBadgeInner(it){
  if(it._summarizing) return '<span class="badge b-pending"><span class="spin" style="border-top-color:var(--pending-fg)"></span> Summary generating</span>';
  if(it._summaryError) return '<span class="badge b-rejected">Summary failed</span>';
  if(it.summary && !it._dirty) return '<span class="badge b-approved">Summary generated</span>';
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

function summarizeIfNeeded(it){
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
// Mirror of server transcript.ts renderTranscript so remapping updates instantly.
function renderTranscriptJS(segments, map){
  if(!segments || !segments.length) return '';
  var order=distinctSpeakersJS(segments);
  if(!order.length) return segments.map(function(s){return s.text;}).join(' ').trim();
  var lines=[], cur=null, buf=[];
  function flush(){
    if(cur===null || !buf.length) return;
    var name=(map[cur] && map[cur].trim()) || ('Speaker '+(order.indexOf(cur)+1));
    lines.push(name+': '+buf.join(' ').trim()); buf=[];
  }
  segments.forEach(function(s){
    var spk=s.speaker || order[0];
    if(spk!==cur){ flush(); cur=spk; }
    buf.push(s.text);
  });
  flush();
  return lines.join('\n');
}
function renderSpeakerMap(it){
  var el=document.getElementById('spk-'+it.id); if(!el) return;
  var speakers=distinctSpeakersJS(it.transcript_segments);
  if(speakers.length<1){ el.innerHTML=''; return; }
  var attendees=state.attendeeIds.map(function(id){ return state.peopleById[id]; }).filter(Boolean);
  var opts=function(sel){
    var o='<option value="">— unlabeled —</option>';
    attendees.forEach(function(p){ o+='<option value="'+esc(p.name)+'"'+(sel===p.name?' selected':'')+'>'+esc(p.name)+'</option>'; });
    // Keep a currently-set name that isn't in the attendee list as an option too.
    if(sel && attendees.every(function(p){return p.name!==sel;})) o+='<option value="'+esc(sel)+'" selected>'+esc(sel)+'</option>';
    return o;
  };
  el.innerHTML='<div class="sublbl">Who is speaking?</div><div class="spk-rows">'
    + speakers.map(function(spk, i){
        var cur=(it.speaker_map||{})[spk]||'';
        return '<div class="spk-row"><span class="spk-tag">Speaker '+(i+1)+'</span>'
          +'<select data-spk="'+esc(spk)+'">'+opts(cur)+'</select></div>';
      }).join('')
    + '</div><div class="hint">Label each voice; the transcript and summary use these names. Remapping relabels the transcript.</div>';
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

// Send a recorded/selected audio blob for transcription + diarization.
function transcribeBlob(it, blob, mime){
  var rs=document.getElementById('recstat-'+it.id);
  if(!blob || !blob.size){ rs.innerHTML='<span style="color:var(--rej-fg)">No audio captured.</span>'; return; }
  rs.innerHTML='<span class="spin" style="border-top-color:var(--navy)"></span> Transcribing &amp; identifying speakers…';
  var ext=(mime||'').indexOf('mp4')>=0?'m4a':(mime||'').indexOf('ogg')>=0?'ogg':'webm';
  var fd=new FormData(); fd.append('file', blob, 'item-'+it.id+'.'+ext);
  apiForm('/api/items/'+it.id+'/transcribe', fd).then(function(res){
    if(!res.ok){ rs.innerHTML='<span style="color:var(--rej-fg)">'+esc(res.error)+'</span>'; return; }
    it.transcript=res.transcript;
    it.speaker_map=res.speakerMap||{};
    // Reflect the newly diarized segments so the speaker map + re-render work.
    return api('/api/meetings/'+state.meeting.id).then(function(det){
      if(det.ok){ var fresh=det.items.filter(function(x){return x.id===it.id;})[0]; if(fresh){ it.transcript_segments=fresh.transcript_segments; it.speaker_map=fresh.speaker_map; } }
      document.getElementById('tx-'+it.id).value=it.transcript;
      renderSpeakerMap(it);
      invalidateSummary(it);
      var n=(res.speakers||[]).length;
      rs.textContent= n>1 ? ('Transcribed — '+n+' speakers detected. Label them below.') : 'Transcribed.';
    });
  }).catch(function(e){ rs.innerHTML='<span style="color:var(--rej-fg)">'+esc(e.message)+'</span>'; });
}

// ── Audio file upload → same transcription path ─────────────────────────────
function uploadAudio(it, input){
  if(!input.files.length) return;
  var f=input.files[0]; input.value='';
  transcribeBlob(it, f, f.type);
}

// ── Report ──────────────────────────────────────────────────────────────────
// Every item with content must be summarized first. Collapse the open item and
// summarize any pending items, then write the report.
function generateReport(){
  setBtn('btn-report', true, 'Preparing…');
  if(state.openItemId){ var open=state.items.filter(function(x){return x.id===state.openItemId;})[0]; if(open) collapseItem(open); }
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
  }).catch(function(e){ setBtn('btn-report', false); msg('report-msg','err',e.message); });
}

// ── Boot ────────────────────────────────────────────────────────────────────
loadMe();
loadMeetings();
