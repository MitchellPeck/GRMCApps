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
function v(id){ return document.getElementById(id).value.trim(); }
function setBtn(id, loading, label){
  var b = document.getElementById(id); if(!b) return;
  if(loading){ b.disabled=true; b.innerHTML='<span class="spin"></span> '+(label||'Working...'); }
  else { b.disabled=false; b.textContent=b.getAttribute('data-default')||label||'Submit'; }
}
function msg(id, kind, text){
  var el=document.getElementById(id);
  el.innerHTML = text ? '<div class="alert alert-'+kind+'">'+esc(text)+'</div>' : '';
}
function fmtDate(s){ try { return new Date(s).toLocaleString(); } catch(e){ return s; } }
function statusLabel(s){ return s.replace('_',' '); }

// ── Tabs ────────────────────────────────────────────────────────────────────
function switchTab(id){
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('.panel').forEach(function(p){ p.classList.remove('active'); });
  var t=document.querySelector('[data-tab="'+id+'"]'); if(t) t.classList.add('active');
  var p=document.getElementById('p-'+id); if(p) p.classList.add('active');
  if(id==='inbox') loadList('inbox');
  if(id==='sent') loadList('sent');
  if(id==='new') loadApproverOptions();
  if(id==='settings') loadRoster();
}
document.querySelectorAll('.tab').forEach(function(t){
  t.addEventListener('click', function(){ switchTab(t.getAttribute('data-tab')); });
});

// ── Identity ────────────────────────────────────────────────────────────────
function loadMe(){
  api('/api/me').then(function(m){
    document.getElementById('me-label').textContent = m.name || m.email || '';
  }).catch(function(){});
}

// ── Request rendering ───────────────────────────────────────────────────────
function badge(status){ return '<span class="badge b-'+status+'">'+esc(statusLabel(status))+'</span>'; }

function previewHtml(reqId, versionNo, mime){
  var src='/api/requests/'+reqId+'/versions/'+versionNo+'/image';
  if(mime==='application/pdf'){
    return '<div class="preview"><div class="pdf">PDF &middot; <a href="'+src+'" target="_blank">open in new tab</a></div></div>';
  }
  return '<div class="preview"><a href="'+src+'" target="_blank"><img src="'+src+'" alt="graphic"></a></div>';
}

function logHtml(events){
  if(!events || !events.length) return '';
  var rows = events.map(function(e){
    var who = esc(e.actor_name || e.actor_email);
    var line = '<div class="logitem"><b>'+who+'</b> '+esc(statusLabel(e.type))+' &middot; v'+e.version_no+' &middot; '+esc(fmtDate(e.created_at));
    if(e.comment) line += '<span class="cmt">'+esc(e.comment)+'</span>';
    return line+'</div>';
  }).join('');
  return '<div class="log">'+rows+'</div>';
}

// Render one detailed request card with optional action controls.
function renderDetail(d, mode){
  var r=d.request;
  var latest=d.versions[d.versions.length-1];
  var h='<div class="rcard" id="rc-'+r.id+'">';
  h+='<div class="rhead"><div><div class="rtitle">'+esc(r.title)+'</div>'
    +'<div class="rmeta">from '+esc(r.submitter_name||r.submitter_email)+' &middot; to '+esc(r.approver_name||r.approver_email)
    +' &middot; v'+r.current_version+'</div></div>'+badge(r.status)+'</div>';
  if(r.description) h+='<div class="rdesc">'+esc(r.description)+'</div>';
  h+=previewHtml(r.id, latest.version_no, latest.mime_type);
  if(latest.note) h+='<div class="ver">Latest note: '+esc(latest.note)+'</div>';
  h+=logHtml(d.events);

  if(mode==='inbox' && r.status==='pending'){
    h+='<div class="field" style="margin-top:12px"><label>Comment (required to request changes)</label>'
      +'<textarea id="cmt-'+r.id+'" placeholder="Optional for approve/reject"></textarea></div>'
      +'<div class="btn-row">'
      +'<button class="btn btn-gold btn-sm" onclick="decide('+r.id+',\'approve\')">Approve</button>'
      +'<button class="btn btn-secondary btn-sm" onclick="decide('+r.id+',\'request_changes\')">Request changes</button>'
      +'<button class="btn btn-danger btn-sm" onclick="decide('+r.id+',\'reject\')">Reject</button>'
      +'<span id="amsg-'+r.id+'"></span></div>';
  }
  if(mode==='sent' && r.status==='changes_requested'){
    h+='<div class="field" style="margin-top:12px"><label>Upload new version</label>'
      +'<input type="file" id="nv-file-'+r.id+'" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" style="margin-bottom:8px">'
      +'<input type="text" id="nv-note-'+r.id+'" placeholder="What changed (optional)"></div>'
      +'<div class="btn-row"><button class="btn btn-primary btn-sm" onclick="uploadVersion('+r.id+')">Submit new version</button>'
      +'<span id="amsg-'+r.id+'"></span></div>';
  }
  h+='</div>';
  return h;
}

// ── Lists ───────────────────────────────────────────────────────────────────
function loadList(box){
  var listId = box==='inbox' ? 'inbox-list' : 'sent-list';
  var el=document.getElementById(listId);
  el.innerHTML='<div class="empty">Loading&hellip;</div>';
  api('/api/requests?box='+box).then(function(res){
    if(!res.ok){ el.innerHTML='<div class="alert alert-err">'+esc(res.error)+'</div>'; return; }
    if(!res.requests.length){
      el.innerHTML='<div class="empty">'+(box==='inbox'?'Nothing awaiting your approval.':'You have not submitted any requests yet.')+'</div>';
      return;
    }
    // Fetch full detail per request so previews + logs render.
    Promise.all(res.requests.map(function(r){ return api('/api/requests/'+r.id); }))
      .then(function(details){
        el.innerHTML = details.filter(function(d){ return d.ok; })
          .map(function(d){ return renderDetail(d, box); }).join('');
      });
  }).catch(function(e){ el.innerHTML='<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

// ── Actions ─────────────────────────────────────────────────────────────────
function decide(id, action){
  var comment = (document.getElementById('cmt-'+id)||{}).value || '';
  var amsg=document.getElementById('amsg-'+id);
  amsg.innerHTML='<span class="spin" style="border-top-color:var(--navy)"></span>';
  api('/api/requests/'+id+'/decision', { method:'POST', body:{ action:action, comment:comment } })
    .then(function(res){
      if(!res.ok){ amsg.innerHTML='<span style="color:#791F1F;font-size:12px">'+esc(res.error)+'</span>'; return; }
      loadList('inbox');
    });
}

function uploadVersion(id){
  var fileEl=document.getElementById('nv-file-'+id);
  var amsg=document.getElementById('amsg-'+id);
  if(!fileEl.files.length){ amsg.innerHTML='<span style="color:#791F1F;font-size:12px">Pick a file first.</span>'; return; }
  var fd=new FormData();
  fd.append('file', fileEl.files[0]);
  fd.append('note', (document.getElementById('nv-note-'+id)||{}).value || '');
  amsg.innerHTML='<span class="spin" style="border-top-color:var(--navy)"></span>';
  apiForm('/api/requests/'+id+'/versions', fd).then(function(res){
    if(!res.ok){ amsg.innerHTML='<span style="color:#791F1F;font-size:12px">'+esc(res.error)+'</span>'; return; }
    loadList('sent');
  });
}

// ── New request ─────────────────────────────────────────────────────────────
function loadApproverOptions(){
  api('/api/roster').then(function(res){
    var sel=document.getElementById('n-approver');
    if(!res.ok || !res.roster.length){
      sel.innerHTML='<option value="">No approvers — add one in Settings</option>';
      return;
    }
    sel.innerHTML = res.roster.map(function(p){
      return '<option value="'+p.id+'">'+esc(p.name)+' ('+esc(p.email)+')</option>';
    }).join('');
  });
}

document.getElementById('btn-new').addEventListener('click', function(){
  var fileEl=document.getElementById('n-file');
  if(!v('n-title')){ msg('new-msg','err','Title is required.'); return; }
  if(!fileEl.files.length){ msg('new-msg','err','Pick a graphic file.'); return; }
  var approverId=document.getElementById('n-approver').value;
  if(!approverId){ msg('new-msg','err','Choose an approver (add one in Settings).'); return; }
  var fd=new FormData();
  fd.append('title', v('n-title'));
  fd.append('description', v('n-desc'));
  fd.append('approverId', approverId);
  fd.append('file', fileEl.files[0]);
  setBtn('btn-new', true, 'Submitting...');
  apiForm('/api/requests', fd).then(function(res){
    setBtn('btn-new', false);
    if(!res.ok){ msg('new-msg','err',res.error); return; }
    msg('new-msg','ok','Submitted for approval.');
    document.getElementById('n-title').value='';
    document.getElementById('n-desc').value='';
    fileEl.value='';
  }).catch(function(e){ setBtn('btn-new', false); msg('new-msg','err',e.message); });
});

// ── Roster ──────────────────────────────────────────────────────────────────
function loadRoster(){
  var el=document.getElementById('roster-list');
  api('/api/roster?all=1').then(function(res){
    if(!res.ok){ el.innerHTML='<div class="alert alert-err">'+esc(res.error)+'</div>'; return; }
    if(!res.roster.length){ el.innerHTML='<div class="empty">No approvers yet.</div>'; return; }
    el.innerHTML = res.roster.map(function(p){
      return '<div class="roster-row'+(p.active?'':' off')+'">'
        +'<div><div class="roster-name">'+esc(p.name)+'</div><div class="roster-email">'+esc(p.email)+'</div></div>'
        +'<button class="btn-sm" onclick="toggleRoster('+p.id+','+(!p.active)+')">'+(p.active?'Deactivate':'Reactivate')+'</button>'
        +'</div>';
    }).join('');
  });
}

function toggleRoster(id, active){
  api('/api/roster/'+id, { method:'POST', body:{ active:active } }).then(function(){ loadRoster(); });
}

document.getElementById('btn-roster').addEventListener('click', function(){
  if(!v('r-name') || !v('r-email')){ msg('roster-msg','err','Name and email are required.'); return; }
  setBtn('btn-roster', true, 'Adding...');
  api('/api/roster', { method:'POST', body:{ name:v('r-name'), email:v('r-email') } }).then(function(res){
    setBtn('btn-roster', false);
    if(!res.ok){ msg('roster-msg','err',res.error); return; }
    msg('roster-msg','ok','Added.');
    document.getElementById('r-name').value='';
    document.getElementById('r-email').value='';
    loadRoster();
  }).catch(function(e){ setBtn('btn-roster', false); msg('roster-msg','err',e.message); });
});

// ── Boot ────────────────────────────────────────────────────────────────────
loadMe();
loadList('inbox');
