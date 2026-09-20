async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error('Request failed: ' + res.status);
  return res.json();
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function v(id){ return document.getElementById(id).value.trim(); }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Escape a value for a single-quoted JS string inside an on* attribute — these
// carry DB-backed values (draft keys, series ids), so a stray quote must not
// break out of the handler.
function jsq(s){ return esc(String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'")).replace(/"/g,'&quot;'); }

function setBtn(id, loading, label) {
  var b = document.getElementById(id);
  if (!b) return;
  if (loading) { b.disabled=true; b.innerHTML='<span class="spin"></span> '+(label||'Working...'); }
  else { b.disabled=false; b.textContent=b.getAttribute('data-default')||label||'Submit'; }
}

function copyText(btn, text) {
  navigator.clipboard.writeText(text).then(function(){
    var o=btn.textContent; btn.textContent='Copied!'; btn.classList.add('copied');
    setTimeout(function(){ btn.textContent=o; btn.classList.remove('copied'); },2000);
  });
}

function switchTab(id) {
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('.panel').forEach(function(p){ p.classList.remove('active'); });
  var t=document.querySelector('[data-tab="'+id+'"]');
  if(t) t.classList.add('active');
  var p=document.getElementById('p-'+id);
  if(p) p.classList.add('active');
  if(id==='series') loadSeries();
  if(id==='pod') loadAngles();
  if(id==='drafts') loadDrafts();
  if(id==='settings') checkAuthStatus();
}

document.querySelectorAll('.tab').forEach(function(t){
  t.addEventListener('click', function(){ switchTab(t.getAttribute('data-tab')); });
});

// opts: { date, sourceType, sourceRef } — `date` is the day this post is meant
// to go out, so the Metricool modal opens on the right date.
function postCard(label, cls, text, uid, opts) {
  opts = opts || {};
  var ctx = "{date:'"+jsq(opts.date)+"',sourceType:'"+jsq(opts.sourceType)+"',sourceRef:'"+jsq(opts.sourceRef)+"'}";
  return '<div class="pcard"><div class="plabel"><span class="'+cls+'">'+esc(label)+'</span>'
    +'<div style="display:flex;gap:6px;align-items:center">'
    +'<button class="btn-sm btn-sm-gold" onclick="copyText(this,document.getElementById(\''+uid+'\').textContent)">Copy</button>'
    +'<button class="btn-sm" onclick="openMetricool(document.getElementById(\''+uid+'\').textContent,'+ctx+')">&#8594; Metricool</button>'
    +'</div></div>'
    +'<div class="ptext" id="'+uid+'">'+esc(text)+'</div></div>';
}

// One renderer for "here is the Mailchimp issue we found", used by both the
// preview button and the run results. The server decides what the dates mean —
// an unsent issue is never captioned as sent.
function campaignAlertClass(c) { return 'alert ' + (c.isDraft ? 'alert-warn' : 'alert-ok'); }

function campaignAlertBody(c, lead, withLink) {
  var body = (c.isDraft ? '<strong>DRAFT</strong> &mdash; ' : '')
    + (lead ? esc(lead) + ' ' : '')
    + '<strong>' + esc(c.subject || '(no subject)') + '</strong>'
    + (c.dateLine ? '<br>' + esc(c.dateLine) : '');
  if (withLink && c.archiveUrl) {
    body += '<br><a href="'+esc(c.archiveUrl)+'" target="_blank" style="font-size:11px;color:inherit">'+esc(c.archiveUrl)+'</a>';
  }
  return body;
}

function campaignAlert(c, lead, withLink) {
  return '<div class="'+campaignAlertClass(c)+'">'+campaignAlertBody(c, lead, withLink)+'</div>';
}

// ── Auth / Settings ───────────────────────────────────────────────────────────
function checkAuthStatus() {
  api('/api/settings').then(function(s){
    var dot=document.getElementById('auth-dot'), lbl=document.getElementById('auth-label');
    if (s.hasAnthropicKey) { dot.className='dot dot-ok'; lbl.textContent='API key set'; }
    else { dot.className='dot dot-err'; lbl.textContent='No API key'; }
    var hint=document.getElementById('s-ak-hint');
    if(hint) hint.textContent = s.hasAnthropicKey ? 'Current: '+s.anthropicKeyHint : 'No key saved.';
    var ms=document.getElementById('s-ms');
    if(ms && s.mailchimpServer) ms.value=s.mailchimpServer;
    // Metricool settings
    window._mcDefaults = { time: s.defaultPostTime, tz: s.defaultTimezone };
    var mcUser=document.getElementById('s-mc-user'); if(mcUser && s.metricoolUserId) mcUser.value=s.metricoolUserId;
    var mcBlog=document.getElementById('s-mc-blog'); if(mcBlog && s.metricoolBlogId) mcBlog.value=s.metricoolBlogId;
    var mcTime=document.getElementById('s-mc-time'); if(mcTime && s.defaultPostTime) mcTime.value=s.defaultPostTime;
    var mcTz=document.getElementById('s-mc-tz'); if(mcTz && s.defaultTimezone) mcTz.value=s.defaultTimezone;
    // Buzzsprout
    var bzHint=document.getElementById('s-bz-hint');
    if(bzHint) bzHint.textContent = s.hasBuzzsprout
      ? 'Connected' + (s.buzzsproutPodcastName ? ' to ' + s.buzzsproutPodcastName : '') + '.'
      : 'No token saved.';
    var bzPod=document.getElementById('s-bz-podcast'); if(bzPod && s.buzzsproutPodcastId) bzPod.value=s.buzzsproutPodcastId;
    if(s.buzzsproutPodcastName) window._bzPodcastName=s.buzzsproutPodcastName;
  }).catch(function(e){ console.error(e); });
}

function saveSettings() {
  setBtn('btn-settings', true, 'Saving...');
  api('/api/settings', {method:'POST', body:{ anthropicKey:v('s-ak'), mailchimpKey:v('s-mk'), mailchimpServer:v('s-ms'),
    metricoolToken:v('s-mc-token'), metricoolUserId:v('s-mc-user'), metricoolBlogId:v('s-mc-blog'),
    defaultPostTime:v('s-mc-time'), defaultTimezone:v('s-mc-tz'),
    r2AccountId:v('s-r2-account'), r2AccessKeyId:v('s-r2-key'), r2SecretAccessKey:v('s-r2-secret'),
    r2Bucket:v('s-r2-bucket'), r2PublicBaseUrl:v('s-r2-baseurl'),
    buzzsproutToken:v('s-bz-token'), buzzsproutPodcastId:v('s-bz-podcast'),
    buzzsproutPodcastName:window._bzPodcastName||'' }})
    .then(function(res){
      setBtn('btn-settings', false, 'Save settings');
      var el=document.getElementById('results-settings');
      if(res.ok){ el.innerHTML='<div class="alert alert-ok">Settings saved.</div>'; document.getElementById('s-ak').value=''; document.getElementById('s-mk').value=''; document.getElementById('s-bz-token').value=''; checkAuthStatus(); }
      else el.innerHTML='<div class="alert alert-err">'+esc(res.error)+'</div>';
    })
    .catch(function(e){ setBtn('btn-settings',false,'Save settings'); document.getElementById('results-settings').innerHTML='<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

// ── Wednesday ─────────────────────────────────────────────────────────────────
function fetchGraceNotesPreview() {
  var sunday = v('w-sunday');
  var btn = document.getElementById('btn-fetch-gn');
  btn.disabled=true; btn.textContent='Fetching...';
  api('/api/grace-notes' + (sunday ? '?sundayDate=' + encodeURIComponent(sunday) : ''))
    .then(function(res){
      btn.disabled=false; btn.textContent='Preview Grace Notes';
      if(!res.ok){
        document.getElementById('gn-badge').className='alert alert-warn';
        document.getElementById('gn-badge').textContent='Could not fetch: '+res.error;
        document.getElementById('gn-preview').style.display='block';
        return;
      }
      var gnBadge = document.getElementById('gn-badge');
      gnBadge.className = campaignAlertClass(res);
      gnBadge.innerHTML = campaignAlertBody(res, '', true);
      document.getElementById('w-content').value=res.preview||'';
      document.getElementById('w-url').value=res.archiveUrl||'';
      document.getElementById('gn-preview').style.display='block';
      document.getElementById('gn-manual').style.display='none';
    })
    .catch(function(e){
      btn.disabled=false; btn.textContent='Preview Grace Notes';
      alert('Error: '+e.message);
    });
}

function runWed() {
  var url = v('w-url') || v('w-url-manual');
  var content = v('w-content');
  var sunday = v('w-sunday');
  setBtn('btn-wed', true, 'Drafting...');
  document.getElementById('results-wed').innerHTML='';
  api('/api/draft/wednesday', {method:'POST', body:{ sundayDate:sunday, manualUrl:url, content:content, service:v('w-service') }})
    .then(function(res){
      setBtn('btn-wed',false);
      var el=document.getElementById('results-wed');
      if(!res.ok){ el.innerHTML='<div class="alert alert-err">'+esc(res.error)+'</div>'; return; }
      var html='';
      if(res.mailchimpFetched && res.campaign){
        html+=campaignAlert({ subject:res.subject, archiveUrl:res.archiveUrl,
          isDraft:res.campaign.isDraft, dateLine:res.campaign.dateLine }, 'Grace Notes fetched:', false);
      } else if(res.mailchimpError) {
        html+='<div class="alert alert-warn">Mailchimp unavailable: '+esc(res.mailchimpError)+'. Drafted from manual input.</div>';
      }
      var d=res.dates||{};
      html+=postCard('Wednesday - Grace Notes','lbl-wed',res.posts.wednesday||'','pw-wed',{date:d.wednesday,sourceType:'run',sourceRef:'wednesday'});
      html+=postCard('Saturday - Invite and preview','lbl-sat',res.posts.saturday||'','pw-sat',{date:d.saturday,sourceType:'run',sourceRef:'saturday'});
      el.innerHTML=html;
    })
    .catch(function(e){ setBtn('btn-wed',false); document.getElementById('results-wed').innerHTML='<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

function clearWed() {
  ['w-sunday','w-url','w-url-manual','w-content','w-service'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('gn-preview').style.display='none';
  document.getElementById('gn-manual').style.display='block';
  document.getElementById('results-wed').innerHTML='';
}

// ── Friday ────────────────────────────────────────────────────────────────────
function fetchBlogPreview() {
  var btn = document.getElementById('btn-fetch-blog');
  btn.disabled=true; btn.textContent='Fetching...';
  api('/api/blog')
    .then(function(res){
      btn.disabled=false; btn.textContent='Fetch blog post';
      if(!res.ok){
        document.getElementById('blog-badge').className='alert alert-warn';
        document.getElementById('blog-badge').textContent='Could not fetch: '+res.error;
        document.getElementById('blog-preview').style.display='block';
        return;
      }
      var blogBadge = document.getElementById('blog-badge');
      blogBadge.className = campaignAlertClass(res);
      blogBadge.innerHTML = campaignAlertBody(res, '', true);
      document.getElementById('f-content').value=res.preview||'';
      document.getElementById('f-url').value=res.archiveUrl||'';
      document.getElementById('blog-preview').style.display='block';
      document.getElementById('blog-manual').style.display='none';
    })
    .catch(function(e){
      btn.disabled=false; btn.textContent='Fetch blog post';
      alert('Error: '+e.message);
    });
}

function runFriday() {
  var url = v('f-url') || v('f-url-manual');
  var content = v('f-content') || v('f-content-manual');
  var subject = v('f-subject');
  setBtn('btn-fri', true, 'Drafting...');
  document.getElementById('results-fri').innerHTML='';
  api('/api/draft/friday', {method:'POST', body:{ date:v('f-date'), manualUrl:url, content:content, subject:subject }})
    .then(function(res){
      setBtn('btn-fri',false);
      var el=document.getElementById('results-fri');
      if(!res.ok){ el.innerHTML='<div class="alert alert-err">'+esc(res.error)+'</div>'; return; }
      var html='';
      if(res.mailchimpFetched && res.campaign){
        html+=campaignAlert({ subject:res.subject, archiveUrl:res.archiveUrl,
          isDraft:res.campaign.isDraft, dateLine:res.campaign.dateLine }, 'Blog fetched:', false);
      } else if(res.mailchimpError){
        html+='<div class="alert alert-warn">Mailchimp unavailable: '+esc(res.mailchimpError)+'. Drafted from manual input.</div>';
      }
      html+=postCard('Friday - Weekly blog','lbl-fri',res.posts.friday||'','pf-fri',{date:(res.dates||{}).friday,sourceType:'run',sourceRef:'friday'});
      el.innerHTML=html;
    })
    .catch(function(e){ setBtn('btn-fri',false); document.getElementById('results-fri').innerHTML='<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

function clearFriday() {
  ['f-date','f-url','f-url-manual','f-content','f-content-manual','f-subject'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('blog-preview').style.display='none';
  document.getElementById('blog-manual').style.display='block';
  document.getElementById('results-fri').innerHTML='';
}

// ── Podcast ───────────────────────────────────────────────────────────────────
var _podEpisodes = {};
var _podAngles = [];

// The angle list is served by the app so the checkboxes and the prompt can
// never drift apart.
function loadAngles() {
  if (_podAngles.length) return;
  api('/api/podcast/angles').then(function(res){
    if(!res.ok) return;
    _podAngles = res.angles || [];
    document.getElementById('pod-angles').innerHTML = _podAngles.map(function(a){
      var checked = a.key === 'announcement' ? ' checked' : '';
      return '<label class="check"><input type="checkbox" class="pod-angle" value="'+esc(a.key)+'"'+checked+'> '+esc(a.label)+'</label>';
    }).join('');
  }).catch(function(e){
    document.getElementById('pod-angles').innerHTML='<div class="alert alert-err">'+esc(e.message)+'</div>';
  });
}

function episodeAlertClass(ep) { return 'alert ' + (ep.isPublished ? 'alert-ok' : 'alert-warn'); }

function episodeAlertBody(ep, lead) {
  return (ep.isPublished ? '' : '<strong>NOT YET PUBLIC</strong> &mdash; ')
    + (lead ? esc(lead) + ' ' : '')
    + '<strong>' + esc(ep.title || '(untitled episode)') + '</strong>'
    + (ep.dateLine ? '<br>' + esc(ep.dateLine) : '')
    + (ep.durationLabel ? ' &middot; ' + esc(ep.durationLabel) : '');
}

function episodeAlert(ep, lead) {
  return '<div class="'+episodeAlertClass(ep)+'">'+episodeAlertBody(ep, lead)+'</div>';
}

function loadEpisodes() {
  var btn=document.getElementById('btn-load-eps');
  btn.disabled=true; btn.textContent='Loading...';
  api('/api/podcast/episodes').then(function(res){
    btn.disabled=false; btn.textContent='Load episodes';
    if(!res.ok){ alert('Error: '+res.error); return; }
    _podEpisodes = {};
    var sel=document.getElementById('pod-episode');
    var opts='<option value="">&mdash; choose an episode &mdash;</option>';
    (res.episodes||[]).forEach(function(ep){
      _podEpisodes[String(ep.id)] = ep;
      var mark = ep.isPrivate ? ' (private)' : (ep.isPublished ? '' : ' (not yet public)');
      opts += '<option value="'+esc(String(ep.id))+'">'+esc(ep.label)+mark+'</option>';
    });
    sel.innerHTML=opts;
    if(!(res.episodes||[]).length) alert('No episodes came back from Buzzsprout.');
  }).catch(function(e){
    btn.disabled=false; btn.textContent='Load episodes';
    alert('Error: '+e.message);
  });
}

function selectEpisode() {
  var id=document.getElementById('pod-episode').value;
  var badge=document.getElementById('pod-badge');
  var ep=_podEpisodes[id];
  if(!ep){ badge.style.display='none'; return; }
  badge.style.display='block';
  badge.className = episodeAlertClass(ep);
  badge.innerHTML = episodeAlertBody(ep, '');
  document.getElementById('pod-title').value = ep.title || '';
  document.getElementById('pod-content').value = ep.description || '';
  document.getElementById('pod-url').value = ep.listenUrl || '';
  document.getElementById('pod-date').value = ep.publishDate || '';
}

function pickedAngles() {
  return Array.prototype.slice.call(document.querySelectorAll('.pod-angle:checked')).map(function(c){ return c.value; });
}

function runPodcast() {
  var angles = pickedAngles();
  var el=document.getElementById('results-pod');
  if(!angles.length){ el.innerHTML='<div class="alert alert-warn">Pick at least one angle to draft.</div>'; return; }
  setBtn('btn-pod', true, 'Drafting...');
  el.innerHTML='';
  api('/api/draft/podcast', {method:'POST', body:{
    episodeId: document.getElementById('pod-episode').value,
    title: v('pod-title'), content: v('pod-content'),
    listenUrl: v('pod-url'), publishDate: v('pod-date'),
    angles: angles
  }}).then(function(res){
    setBtn('btn-pod',false);
    if(!res.ok){ el.innerHTML='<div class="alert alert-err">'+esc(res.error)+'</div>'; return; }
    var html='';
    if(res.buzzsproutFetched && res.episode){
      html += episodeAlert(res.episode, 'Episode:');
    } else if(res.buzzsproutError){
      html += '<div class="alert alert-warn">Buzzsprout unavailable: '+esc(res.buzzsproutError)+'. Drafted from what was on the form.</div>';
    }
    var dates=res.dates||{};
    angles.forEach(function(key){
      var text=res.posts[key];
      if(!text) return;
      var angle=_podAngles.filter(function(a){ return a.key===key; })[0];
      html += postCard(angle ? angle.label : key, 'lbl-pod', text, 'pp-'+key,
        {date:dates[key], sourceType:'podcast', sourceRef:key});
    });
    el.innerHTML=html;
  }).catch(function(e){
    setBtn('btn-pod',false);
    el.innerHTML='<div class="alert alert-err">'+esc(e.message)+'</div>';
  });
}

function clearPodcast() {
  ['pod-title','pod-content','pod-url','pod-date'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  var sel=document.getElementById('pod-episode'); if(sel) sel.value='';
  var badge=document.getElementById('pod-badge'); if(badge) badge.style.display='none';
  document.getElementById('results-pod').innerHTML='';
}

// ── Series ────────────────────────────────────────────────────────────────────
var _seriesData = {};

function loadSeries() {
  document.getElementById('series-list').innerHTML='<div class="hint" style="padding:8px 0">Loading series...</div>';
  api('/api/series')
    .then(function(res){
      if(!res.ok){ document.getElementById('series-list').innerHTML='<div class="alert alert-err">'+esc(res.error)+'</div>'; return; }
      document.getElementById('series-count').textContent=res.series.length+' series';
      var html='';
      res.series.forEach(function(s){
        var statusCls='sb-'+s.status;
        html+='<div class="series-card" id="sc-'+s.id+'">'
          +'<div class="series-header" onclick="toggleSeries(\''+s.id+'\')">'
          +'<span class="series-chevron" id="chev-'+s.id+'">&#8964;</span>'
          +'<div><div class="series-name">'+esc(s.name)+'</div><div class="series-meta">'+esc(s.description)+'</div></div>'
          +'<div class="series-badges"><span class="sbadge '+statusCls+'">'+esc(s.status)+'</span>'
          +'<button class="btn-sm" onclick="event.stopPropagation();pauseSeries(\''+s.id+'\',\''+s.status+'\')">'+( s.status==='active'?'Pause':'Resume')+'</button>'
          +'</div></div>'
          +'<div class="series-body" id="sb-'+s.id+'">'
          +'<div class="series-actions">'
          +'<button class="btn-sm" onclick="loadSeriesPosts(\''+s.id+'\')">Refresh posts</button>'
          +'<button class="btn-sm btn-sm-gold" onclick="draftAllPending(\''+s.id+'\')">Draft next pending</button>'
          +'</div>'
          +'<div id="sp-'+s.id+'"><div class="hint" style="padding:12px 16px">Click to expand, then Refresh posts.</div></div>'
          +'</div></div>';
      });
      document.getElementById('series-list').innerHTML=html;
    })
    .catch(function(e){ document.getElementById('series-list').innerHTML='<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

function toggleSeries(id) {
  var body=document.getElementById('sb-'+id);
  var chev=document.getElementById('chev-'+id);
  var isOpen=body.classList.contains('open');
  body.classList.toggle('open');
  chev.classList.toggle('open');
  if(!isOpen) loadSeriesPosts(id);
}

function loadSeriesPosts(seriesId) {
  document.getElementById('sp-'+seriesId).innerHTML='<div class="hint" style="padding:12px 16px">Loading posts...</div>';
  api('/api/series/' + seriesId + '/posts')
    .then(function(res){ renderSeriesPosts(seriesId, res); })
    .catch(function(e){ document.getElementById('sp-'+seriesId).innerHTML='<div class="alert alert-err" style="margin:12px 16px">'+esc(e.message)+'</div>'; });
}

function renderSeriesPosts(seriesId, res) {
  if(!res.ok){ document.getElementById('sp-'+seriesId).innerHTML='<div class="alert alert-err" style="margin:12px 16px">'+esc(res.error)+'</div>'; return; }
  _seriesData[seriesId]=res.posts;
  var posted=res.posts.filter(function(p){return p.status==='posted';}).length;
  var html='<div style="padding:8px 16px;font-size:11px;color:var(--muted)">'+posted+' of '+res.posts.length+' posted</div>';
  var lastPhase='';
  res.posts.forEach(function(p){
    if(p.phase && p.phase!==lastPhase){
      html+='<div style="padding:6px 16px 2px;font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--gold)">'+esc(p.phase)+'</div>';
      lastPhase=p.phase;
    }
    var bcls='pb-'+(p.status||'pending');
    var hasDraft=p.draft && p.draft.length>0;
    html+='<div class="post-row'+(hasDraft?' has-draft':'')+'" id="pr-'+seriesId+'-'+p.postIdx+'">'
      +'<div class="post-date">'+esc(p.date)+'</div>'
      +'<div>'+(p.phase&&p.phase!==lastPhase?'<div class="post-phase">'+esc(p.phase)+'</div>':'')+' <div class="post-title">'+esc(p.title)+'</div><div class="post-sub">'+esc(p.sub)+'</div></div>'
      +'<div><span class="pbadge '+bcls+'">'+esc(p.status)+'</span></div>'
      +'<div class="post-btns">';
    if(p.status!=='posted'){
      html+='<button class="btn-sm" id="dbtn-'+seriesId+'-'+p.postIdx+'" onclick="draftSeriesPost(\''+seriesId+'\','+p.postIdx+')">Draft</button>';
    }
    if(hasDraft){
      html+='<button class="btn-sm" onclick="toggleDraftPreview(\''+seriesId+'\','+p.postIdx+')">View</button>';
      html+='<button class="btn-sm" onclick="markPosted(\''+seriesId+'\','+p.postIdx+')">Posted</button>';
    }
    html+='<button class="btn-sm" onclick="editPostNotes(\''+seriesId+'\','+p.postIdx+')">Notes</button>';
    html+='</div></div>';
    if(hasDraft){
      var uid='draft-'+seriesId+'-'+p.postIdx;
      html+='<div class="post-draft-preview" id="pdp-'+seriesId+'-'+p.postIdx+'" style="display:none">'
        +'<div class="ptext" id="'+uid+'">'+esc(p.draft)+'</div>'
        +'<div style="display:flex;gap:6px;margin-top:6px">'
        +'<button class="btn-sm btn-sm-gold" onclick="copyText(this,document.getElementById(\''+uid+'\').textContent)">Copy</button>'
        +'<button class="btn-sm" onclick="openMetricool(document.getElementById(\''+uid+'\').textContent,{date:\''+jsq(p.scheduleDate)+'\',sourceType:\'series\',sourceRef:\''+jsq(seriesId)+'-'+p.postIdx+'\'})">&#8594; Metricool</button>'
        +'</div></div>';
    }
    if(p.notes){
      html+='<div style="padding:0 16px 8px;font-size:11px;color:var(--muted);font-style:italic">Note: '+esc(p.notes)+'</div>';
    }
  });
  document.getElementById('sp-'+seriesId).innerHTML=html;
}

function toggleDraftPreview(seriesId, postIdx) {
  var el=document.getElementById('pdp-'+seriesId+'-'+postIdx);
  if(el) el.style.display=el.style.display==='none'?'block':'none';
}

function draftSeriesPost(seriesId, postIdx) {
  var btn=document.getElementById('dbtn-'+seriesId+'-'+postIdx);
  if(btn){ btn.disabled=true; btn.textContent='...'; }
  api('/api/series/' + seriesId + '/posts/' + postIdx + '/draft', {method:'POST'})
    .then(function(res){
      if(btn){ btn.disabled=false; btn.textContent='Draft'; }
      if(!res.ok){ alert('Error: '+res.error); return; }
      loadSeriesPosts(seriesId);
    })
    .catch(function(e){ if(btn){ btn.disabled=false; btn.textContent='Draft'; } alert('Error: '+e.message); });
}

function draftAllPending(seriesId) {
  var posts=_seriesData[seriesId];
  if(!posts){ alert('Load the series posts first.'); return; }
  var pending=posts.filter(function(p){ return p.status==='pending'; });
  if(!pending.length){ alert('No pending posts in this series.'); return; }
  draftSeriesPost(seriesId, pending[0].postIdx);
}

function markPosted(seriesId, postIdx) {
  api('/api/series/' + seriesId + '/posts/' + postIdx, {method:'PATCH', body:{field:'status', value:'posted'}})
    .then(function(res){ if(res.ok) loadSeriesPosts(seriesId); })
    .catch(function(e){ console.error(e); });
}

function editPostNotes(seriesId, postIdx) {
  var posts=_seriesData[seriesId]||[];
  var post=posts.filter(function(p){ return p.postIdx===postIdx; })[0];
  var current=post?post.notes:'';
  var notes=prompt('Notes for this post:', current);
  if(notes===null) return;
  api('/api/series/' + seriesId + '/posts/' + postIdx, {method:'PATCH', body:{field:'notes', value:notes}})
    .then(function(res){ if(res.ok) loadSeriesPosts(seriesId); })
    .catch(function(e){ console.error(e); });
}

function pauseSeries(seriesId, currentStatus) {
  var newStatus=currentStatus==='active'?'paused':'active';
  api('/api/series/' + seriesId, {method:'PATCH', body:{ status: newStatus }})
    .then(function(res){ if(res.ok) loadSeries(); })
    .catch(function(e){ console.error(e); });
}

// ── New series form ───────────────────────────────────────────────────────────
var _planPosts = [];

function toggleNewSeriesForm() {
  var card=document.getElementById('new-series-card');
  card.style.display=card.style.display==='none'?'block':'none';
}

function cancelNewSeries() {
  document.getElementById('new-series-card').style.display='none';
  document.getElementById('ns-plan-area').style.display='none';
  _planPosts=[];
}

function generatePlan() {
  var name=v('ns-name'), desc=v('ns-desc'), count=parseInt(v('ns-count')||'6');
  if(!name){ alert('Please enter a series name.'); return; }
  setBtn('btn-gen-plan', true, 'Generating plan...');
  api('/api/series/plan', {method:'POST', body:{ name:name, description:desc, context:v('ns-context'), count:count, cadence:v('ns-cadence'), startDate:v('ns-start') }})
    .then(function(res){
      setBtn('btn-gen-plan', false, 'Generate post plan');
      if(!res.ok){ alert('Error: '+res.error); return; }
      _planPosts=res.posts;
      renderPlanRows();
      document.getElementById('ns-plan-area').style.display='block';
    })
    .catch(function(e){ setBtn('btn-gen-plan',false,'Generate post plan'); alert('Error: '+e.message); });
}

function renderPlanRows() {
  var html='';
  _planPosts.forEach(function(p, i){
    html+='<div class="post-plan-row" id="planrow-'+i+'">'
      +'<input type="text" value="'+esc(p.date||'')+'" placeholder="Date" onchange="_planPosts['+i+'].date=this.value">'
      +'<input type="text" value="'+esc(p.phase||'')+'" placeholder="Phase (optional)" onchange="_planPosts['+i+'].phase=this.value">'
      +'<input type="text" value="'+esc(p.title)+'" placeholder="Title" onchange="_planPosts['+i+'].title=this.value" style="font-weight:600">'
      +'<button class="btn-sm" onclick="removePlanRow('+i+')" style="color:#E24B4A;border-color:#E24B4A">✕</button>'
      +'</div>'
      +'<div style="padding:0 0 8px '+(80+120+8+8)+'px"><input type="text" value="'+esc(p.sub||'')+'" placeholder="Angle / description" onchange="_planPosts['+i+'].sub=this.value" style="font-size:12px;color:var(--muted)"></div>';
  });
  document.getElementById('ns-plan-rows').innerHTML=html;
}

function addPlanRow() {
  _planPosts.push({date:'',phase:'',title:'New post',sub:''});
  renderPlanRows();
}

function removePlanRow(i) {
  _planPosts.splice(i,1);
  renderPlanRows();
}

function saveSeries() {
  var name=v('ns-name');
  if(!name){ alert('Series name required.'); return; }
  if(!_planPosts.length){ alert('Add at least one post.'); return; }
  setBtn('btn-save-series', true, 'Saving...');
  api('/api/series', {method:'POST', body:{ name:name, description:v('ns-desc'), context:v('ns-context'), cadence:v('ns-cadence'), posts:_planPosts }})
    .then(function(res){
      setBtn('btn-save-series', false, 'Save series');
      if(!res.ok){ alert('Error: '+res.error); return; }
      cancelNewSeries();
      loadSeries();
    })
    .catch(function(e){ setBtn('btn-save-series',false,'Save series'); alert('Error: '+e.message); });
}

// ── Drafts ────────────────────────────────────────────────────────────────────
function loadDrafts() {
  document.getElementById('drafts-list').innerHTML='<div class="hint" style="padding:8px 0">Loading...</div>';
  api('/api/drafts')
    .then(function(res){
      if(!res.ok){ document.getElementById('drafts-list').innerHTML='<div class="alert alert-err">'+esc(res.error)+'</div>'; return; }
      if(!res.rows.length){ document.getElementById('drafts-list').innerHTML='<div class="hint" style="padding:8px 0">No drafts yet.</div>'; return; }
      var m={monday:'lbl-mon',tuesday:'lbl-tue',wednesday:'lbl-wed',thursday:'lbl-thu',friday:'lbl-fri',saturday:'lbl-sat'};
      var html='';
      res.rows.forEach(function(r,i){
        var uid='dr-'+i;
        html+='<div class="pcard"><div class="plabel"><span class="'+(m[r.key]||'lbl-mon')+'">'+esc(r.key)+' — '+esc(r.postDate||String(r.dateDrafted).split('T')[0])+'</span>'
          +'<div style="display:flex;gap:6px;align-items:center"><span class="pbadge pb-'+esc(r.status)+'">'+esc(r.status)+'</span>'
          +'<button class="btn-sm btn-sm-gold" onclick="copyText(this,document.getElementById(\''+uid+'\').textContent)">Copy</button>'
          +'<button class="btn-sm" onclick="openMetricool(document.getElementById(\''+uid+'\').textContent,{date:\''+jsq(r.scheduleDate)+'\',sourceType:\'draft\',sourceRef:\''+jsq(r.key)+'\'})">&#8594; Metricool</button>'
          +'</div></div>'
          +'<div class="ptext" id="'+uid+'">'+esc(r.text)+'</div></div>';
      });
      document.getElementById('drafts-list').innerHTML=html;
    })
    .catch(function(e){ document.getElementById('drafts-list').innerHTML='<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

// ── Metricool ─────────────────────────────────────────────────────────────────
var _mcCtx = { sourceType:'', sourceRef:'' };

var DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
var MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Read a YYYY-MM-DD box without letting the browser reinterpret it as UTC
// midnight (which shows the day before in every US timezone).
function describeDate(iso){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso||'')) return '';
  var p=iso.split('-').map(Number);
  var d=new Date(p[0],p[1]-1,p[2]);
  return DAY_NAMES[d.getDay()]+', '+MONTH_NAMES[p[1]-1]+' '+p[2];
}

function updateDateHint(){
  var hint=document.getElementById('mc-date-hint');
  if(hint) hint.textContent=describeDate(document.getElementById('mc-date').value);
}

// Show only the control for the chosen image source, so the send path is never
// ambiguous about which image it should use.
function switchImageSource(){
  var mode=document.getElementById('mc-image-source').value;
  ['upload','approved','url'].forEach(function(k){
    document.getElementById('mc-src-'+k).style.display = (mode===k) ? 'block' : 'none';
  });
  if(mode!=='upload') document.getElementById('mc-file').value='';
  if(mode!=='url') document.getElementById('mc-imgurl').value='';
  if(mode!=='approved') document.getElementById('mc-approved').value='';
}

// Metricool's autoPublish is one flag for the whole post, and Instagram has to
// publish itself — so ticking Instagram also commits whatever it's grouped with.
// Say that up front instead of letting it be a surprise after the fact.
function updatePublishHint(){
  var hint=document.getElementById('mc-publish-hint'); if(!hint) return;
  var ig=document.getElementById('mc-ig').checked;
  var others=[];
  if(document.getElementById('mc-fb').checked) others.push('Facebook');
  if(document.getElementById('mc-x').checked) others.push('X');
  if(!ig){ hint.textContent='Lands as a draft — approve it in Metricool to publish.'; return; }
  hint.textContent = others.length
    ? 'Instagram publishes automatically, so '+others.join(' and ')+' will too — nothing waits for approval.'
    : 'Publishes automatically at the scheduled time.';
}

// opts.date is the day this post belongs to (this week's Wednesday for a
// Wednesday draft, the series post's own date for a series draft).
function openMetricool(text, opts){
  opts = opts || {};
  _mcCtx = { sourceType: opts.sourceType||'', sourceRef: opts.sourceRef||'' };
  document.getElementById('mc-text').value = text || '';
  document.getElementById('mc-date').value = opts.date || new Date().toLocaleDateString('en-CA');
  document.getElementById('mc-time').value = (window._mcDefaults && _mcDefaults.time) || '09:00';
  document.getElementById('mc-image-source').value = 'none';
  document.getElementById('mc-msg').innerHTML = '';
  switchImageSource();
  updateDateHint();
  updatePublishHint();
  document.getElementById('mc-modal').style.display = 'flex';
  // Populate approved-image select
  var sel = document.getElementById('mc-approved');
  sel.innerHTML = '<option value="">— none —</option>';
  api('/api/metricool/approved-images').then(function(res){
    if (!res.ok || !res.images) return;
    res.images.forEach(function(img){
      var opt = document.createElement('option');
      opt.value = img.id;
      opt.textContent = img.title;
      sel.appendChild(opt);
    });
  }).catch(function(){ /* silently ignore if approvals not available */ });
}

function closeMetricool(){ document.getElementById('mc-modal').style.display='none'; }

// Resolve the chosen image into the fields the send endpoint expects. Uploads
// are read into a data URL here; the server puts them on R2 like it already
// does for approved images.
function readMetricoolImage(){
  var mode=document.getElementById('mc-image-source').value;
  if(mode==='approved') return Promise.resolve({ approvedImageId: document.getElementById('mc-approved').value });
  if(mode==='url') return Promise.resolve({ imageUrl: document.getElementById('mc-imgurl').value.trim() });
  if(mode!=='upload') return Promise.resolve({});
  var file=document.getElementById('mc-file').files[0];
  if(!file) return Promise.reject(new Error('Choose a file to upload, or pick a different image source.'));
  if(file.size > 10*1024*1024) return Promise.reject(new Error('That image is larger than 10 MB.'));
  return new Promise(function(resolve, reject){
    var reader=new FileReader();
    reader.onload=function(){ resolve({ imageData: String(reader.result) }); };
    reader.onerror=function(){ reject(new Error('Could not read that file.')); };
    reader.readAsDataURL(file);
  });
}

function submitMetricool(){
  var networks = [];
  if (document.getElementById('mc-fb').checked) networks.push('facebook');
  if (document.getElementById('mc-ig').checked) networks.push('instagram');
  // Metricool still calls X "twitter" in its API.
  if (document.getElementById('mc-x').checked) networks.push('twitter');
  if (!networks.length) { document.getElementById('mc-msg').innerHTML='<div class="alert alert-err">Pick at least one network.</div>'; return; }
  var dateTime = document.getElementById('mc-date').value + 'T' + (document.getElementById('mc-time').value||'09:00') + ':00';
  var tz = (window._mcDefaults && _mcDefaults.tz) || 'America/New_York';
  setBtn('mc-send-btn', true, 'Sending...');
  readMetricoolImage().then(function(image){
    var body = { text: document.getElementById('mc-text').value, networks: networks, dateTime: dateTime, timezone: tz,
      sourceType: _mcCtx.sourceType, sourceRef: _mcCtx.sourceRef };
    Object.keys(image).forEach(function(k){ body[k]=image[k]; });
    return api('/api/metricool/send', { method:'POST', body: body });
  }).then(function(res){
    setBtn('mc-send-btn', false);
    var el = document.getElementById('mc-msg');
    if(!res.ok){ el.innerHTML = '<div class="alert alert-err">'+esc(res.error)+'</div>'; return; }
    // Whether a human still has to press publish depends on the networks picked,
    // so say which of the two happened rather than a generic "sent".
    var fate = res.autoPublish
      ? ' It will publish automatically.'
      : ' Approve it in the Metricool planner to publish.';
    var extra = fate + (res.note? ' '+esc(res.note):'') + ((res.warnings&&res.warnings.length)? ' '+esc(res.warnings.join(' ')):'');
    el.innerHTML = '<div class="alert alert-ok">Sent to Metricool — scheduled '+esc(res.scheduledFor)+'.'+extra+'</div>';
  }).catch(function(e){ setBtn('mc-send-btn', false); document.getElementById('mc-msg').innerHTML = '<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

function loadBrands(){
  var btn=document.getElementById('btn-load-brands'); if(btn){btn.disabled=true;btn.textContent='Loading...';}
  api('/api/metricool/brands').then(function(res){
    if(btn){btn.disabled=false;btn.textContent='Load brands';}
    var sel=document.getElementById('mc-brands'); if(!sel) return;
    if(!res.ok){ alert('Error: '+res.error); return; }
    sel.innerHTML = (res.brands||[]).map(function(b){ return '<option value="'+esc(b.id)+'">'+esc(b.label)+'</option>'; }).join('');
    if(res.brands && res.brands.length){ document.getElementById('s-mc-blog').value = res.brands[0].id; }
  }).catch(function(e){ if(btn){btn.disabled=false;btn.textContent='Load brands';} alert('Error: '+e.message); });
}

function pickPodcast(sel){
  if(!sel.value) return;
  document.getElementById('s-bz-podcast').value = sel.value;
  var opt = sel.options[sel.selectedIndex];
  window._bzPodcastName = opt ? opt.textContent : '';
}

function loadPodcasts(){
  var btn=document.getElementById('btn-load-podcasts'); if(btn){btn.disabled=true;btn.textContent='Loading...';}
  api('/api/podcast/podcasts').then(function(res){
    if(btn){btn.disabled=false;btn.textContent='Load podcasts';}
    var sel=document.getElementById('bz-podcasts'); if(!sel) return;
    if(!res.ok){ alert('Error: '+res.error); return; }
    sel.innerHTML=(res.podcasts||[]).map(function(p){ return '<option value="'+esc(p.id)+'">'+esc(p.title)+'</option>'; }).join('');
    if(res.podcasts && res.podcasts.length){
      document.getElementById('s-bz-podcast').value=res.podcasts[0].id;
      window._bzPodcastName=res.podcasts[0].title;
    }
  }).catch(function(e){ if(btn){btn.disabled=false;btn.textContent='Load podcasts';} alert('Error: '+e.message); });
}

// ── Init ──────────────────────────────────────────────────────────────────────
// en-CA renders as YYYY-MM-DD in the browser's own timezone, which is what
// <input type="date"> wants — toISOString() would hand back the UTC day.
function todayLocal(){ return new Date().toLocaleDateString('en-CA'); }

document.getElementById('f-date').value=todayLocal();
// Default w-sunday to the coming Sunday.
(function(){
  var d=new Date(); var day=d.getDay(); var diff=day===0?7:7-day;
  d.setDate(d.getDate()+diff);
  var el=document.getElementById('w-sunday'); if(el) el.value=d.toLocaleDateString('en-CA');
})();
document.getElementById('ns-start').value=todayLocal();
document.getElementById('mc-date').addEventListener('change', updateDateHint);
checkAuthStatus();
