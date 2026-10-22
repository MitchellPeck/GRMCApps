// The "Send to Metricool" dialog, shared by Social Posts and the Content
// Pipeline. It brings its own markup and helpers so either page can include
// it with one <script> tag and call openMetricool(text, opts).
//
// opts: { date, time, networks: ['facebook','instagram','twitter'],
//         texts: { facebook: '…', instagram: '…', twitter: '…' }  — a different
//                text per network; each distinct text is sent as its own post,
//         files: [{ label, approvedImageId, imageUrl }] — the post's Media field,
//                in order; each is listed ticked, and all ticked ones are sent,
//         publish: 'scheduled' (the default) or 'draft' — which option starts picked,
//         approvedImageId, imageUrl (a public image to attach),
//         sourceType, sourceRef, contentItemId, onSent(res) }

function mcEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function mcApi(path, opts) {
  opts = opts || {};
  return fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(function(res){ if (!res.ok) throw new Error('Request failed: ' + res.status); return res.json(); });
}
function mcSetBtn(id, loading, label) {
  var b = document.getElementById(id);
  if (!b) return;
  if (loading) { b.disabled=true; b.innerHTML='<span class="spin"></span> '+(label||'Working...'); }
  else { b.disabled=false; b.textContent=b.getAttribute('data-default')||label||'Submit'; }
}
// Default post time and timezone. Social Posts already fills _mcDefaults from
// its settings check; anywhere else, fetch them on first open.
function loadMetricoolDefaults(){
  return mcApi('/api/settings').then(function(s){
    window._mcDefaults = { time: s.defaultPostTime, tz: s.defaultTimezone };
  }).catch(function(){ /* fall back to 09:00 America/New_York */ });
}

document.body.insertAdjacentHTML('beforeend', "<div id=\"mc-modal\" style=\"display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;align-items:center;justify-content:center\">\n  <div class=\"card\" style=\"max-width:520px;width:92%;max-height:90vh;overflow:auto\">\n    <div class=\"ct\">Send to Metricool</div>\n    <div class=\"field\"><label>Post text</label><textarea id=\"mc-text\" style=\"min-height:120px\"></textarea></div>\n    <div class=\"field\"><label>Networks</label>\n      <label class=\"check\"><input type=\"checkbox\" id=\"mc-fb\" checked> Facebook</label>\n      <label class=\"check\"><input type=\"checkbox\" id=\"mc-ig\" checked> Instagram</label>\n      <label class=\"check\"><input type=\"checkbox\" id=\"mc-x\" checked> X</label>\n    </div>\n    <div class=\"field\"><label>Send as</label>\n      <label class=\"check\"><input type=\"radio\" name=\"mc-publish\" value=\"scheduled\" checked onchange=\"updatePublishHint()\"> Scheduled</label>\n      <label class=\"check\"><input type=\"radio\" name=\"mc-publish\" value=\"draft\" onchange=\"updatePublishHint()\"> Draft</label>\n      <div class=\"hint\" id=\"mc-publish-hint\"></div>\n    </div>\n    <div class=\"row2\">\n      <div class=\"field\"><label>Date</label><input type=\"date\" id=\"mc-date\"><div class=\"hint\" id=\"mc-date-hint\"></div></div>\n      <div class=\"field\"><label>Time</label><input type=\"time\" id=\"mc-time\"></div>\n    </div>\n    <div id=\"mc-image-area\">\n      <div class=\"field\"><label>Image</label>\n        <select id=\"mc-image-source\" onchange=\"switchImageSource()\">\n          <option value=\"none\">No image</option>\n          <option value=\"upload\">Upload an image</option>\n          <option value=\"approved\">Choose an approved image</option>\n          <option value=\"url\">Use an image URL</option>\n        </select>\n      </div>\n      <div class=\"field\" id=\"mc-src-upload\" style=\"display:none\">\n        <label>File</label><input type=\"file\" id=\"mc-file\" accept=\"image/*\">\n        <div class=\"hint\">JPG, PNG, GIF or WebP, up to 10 MB.</div>\n      </div>\n      <div class=\"field\" id=\"mc-src-approved\" style=\"display:none\">\n        <label>Approved image</label><select id=\"mc-approved\"></select>\n      </div>\n      <div class=\"field\" id=\"mc-src-url\" style=\"display:none\">\n        <label>Image URL (must be public)</label><input type=\"text\" id=\"mc-imgurl\" placeholder=\"https://...\">\n      </div>\n    </div>\n    <div id=\"mc-msg\"></div>\n    <div class=\"btn-row\">\n      <button class=\"btn btn-primary\" id=\"mc-send-btn\" data-default=\"Send to Metricool\" onclick=\"submitMetricool()\">Send to Metricool</button>\n      <button class=\"btn btn-secondary\" onclick=\"closeMetricool()\">Cancel</button>\n    </div>\n  </div>\n</div>\n");
document.getElementById('mc-date').addEventListener('change', function(){ updateDateHint(); });
// Per-network texts render here, in place of the single text box, when a
// caller has a different caption for each network.
document.getElementById('mc-text').closest('.field').insertAdjacentHTML('afterend', '<div id="mc-texts"></div>');
// The post's files, when the caller has them (the pipeline's Media field).
document.getElementById('mc-image-area').insertAdjacentHTML('beforebegin', '<div id="mc-files"></div>');
var MC_NETWORK_LABELS = { facebook: 'Facebook', instagram: 'Instagram', twitter: 'X' };

var _mcCtx = { sourceType:'', sourceRef:'', contentItemId:'' };

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

// Scheduled or draft is the sender's call, and it holds for every network ticked.
function mcPublishMode(){ return document.querySelector('input[name="mc-publish"]:checked').value; }
function updatePublishHint(){
  var hint=document.getElementById('mc-publish-hint'); if(!hint) return;
  hint.textContent = mcPublishMode() === 'draft'
    ? 'Lands in the Metricool planner as a draft — nothing publishes until you schedule it there.'
    : 'Publishes automatically at the date and time below.';
}

// opts.date is the day this post belongs to (this week's Wednesday for a
// Wednesday draft, the series post's own date for a series draft).
function openMetricool(text, opts){
  opts = opts || {};
  _mcCtx = { sourceType: opts.sourceType||'', sourceRef: opts.sourceRef||'', contentItemId: opts.contentItemId||'', onSent: opts.onSent||null };
  if (!window._mcDefaults) loadMetricoolDefaults();
  document.getElementById('mc-text').value = text || '';
  _mcCtx.texts = opts.texts || null;
  _mcCtx.files = opts.files && opts.files.length ? opts.files : null;
  document.getElementById('mc-files').innerHTML = !_mcCtx.files ? '' : '<div class="field"><label>Images and videos (sent in this order)</label>'
    + _mcCtx.files.map(function(f, i){
        return '<label class="check" style="display:flex"><input type="checkbox" data-mcfile="'+i+'" checked> '+mcEsc(f.label)+'</label>';
      }).join('') + '</div>';
  document.getElementById('mc-image-area').style.display = _mcCtx.files ? 'none' : '';
  document.getElementById('mc-text').closest('.field').style.display = opts.texts ? 'none' : '';
  document.getElementById('mc-texts').innerHTML = !opts.texts ? '' : Object.keys(opts.texts).map(function(n){
    return '<div class="field"><label for="mc-text-'+n+'">'+mcEsc(MC_NETWORK_LABELS[n] || n)+' text</label>'
      + '<textarea id="mc-text-'+n+'" style="min-height:90px">'+mcEsc(opts.texts[n])+'</textarea></div>';
  }).join('');
  document.getElementById('mc-date').value = opts.date || new Date().toLocaleDateString('en-CA');
  document.getElementById('mc-time').value = opts.time || (window._mcDefaults && _mcDefaults.time) || '09:00';
  // Callers that know the post's platforms pre-tick just those networks.
  if (opts.networks) {
    document.getElementById('mc-fb').checked = opts.networks.indexOf('facebook') !== -1;
    document.getElementById('mc-ig').checked = opts.networks.indexOf('instagram') !== -1;
    document.getElementById('mc-x').checked = opts.networks.indexOf('twitter') !== -1;
  }
  document.getElementById('mc-image-source').value = opts.approvedImageId ? 'approved' : opts.imageUrl ? 'url' : 'none';
  document.querySelector('input[name="mc-publish"][value="'+(opts.publish === 'draft' ? 'draft' : 'scheduled')+'"]').checked = true;
  document.getElementById('mc-msg').innerHTML = '';
  switchImageSource();
  if (opts.imageUrl) document.getElementById('mc-imgurl').value = opts.imageUrl;
  updateDateHint();
  updatePublishHint();
  document.getElementById('mc-modal').style.display = 'flex';
  // Populate approved-image select
  var sel = document.getElementById('mc-approved');
  sel.innerHTML = '<option value="">— none —</option>';
  mcApi('/api/metricool/approved-images').then(function(res){
    if (!res.ok || !res.images) return;
    res.images.forEach(function(img){
      var opt = document.createElement('option');
      opt.value = img.id;
      opt.textContent = img.title;
      sel.appendChild(opt);
    });
    if (opts.approvedImageId) sel.value = String(opts.approvedImageId);
  }).catch(function(){ /* silently ignore if approvals not available */ });
}

function closeMetricool(){ document.getElementById('mc-modal').style.display='none'; }

// Resolve the chosen image into the fields the send endpoint expects. Uploads
// are read into a data URL here; the server puts them on R2 like it already
// does for approved images.
function readMetricoolImage(){
  if (_mcCtx.files) {
    var media = _mcCtx.files.filter(function(_f, i){ return document.querySelector('[data-mcfile="'+i+'"]').checked; })
      .map(function(f){ return f.approvedImageId ? { approvedImageId: f.approvedImageId } : { imageUrl: f.imageUrl }; });
    return Promise.resolve({ media: media });
  }
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
  var publish = mcPublishMode();
  // One send per distinct text: with a single caption that's one post to every
  // network; with separate captions, each network gets its own.
  var groups = [], byText = {};
  networks.forEach(function(n){
    var box = _mcCtx.texts && document.getElementById('mc-text-' + n);
    var text = box ? box.value : document.getElementById('mc-text').value;
    if (!text.trim()) return;
    if (!byText[text]) { byText[text] = { text: text, networks: [] }; groups.push(byText[text]); }
    byText[text].networks.push(n);
  });
  if (!groups.length) { document.getElementById('mc-msg').innerHTML='<div class="alert alert-err">There’s no text to send.</div>'; return; }
  mcSetBtn('mc-send-btn', true, 'Sending...');
  readMetricoolImage().then(function(image){
    if (groups.length > 1) return sendGroups(groups, image, dateTime, tz, publish);
    var body = { text: groups[0].text, networks: groups[0].networks, dateTime: dateTime, timezone: tz, publish: publish,
      sourceType: _mcCtx.sourceType, sourceRef: _mcCtx.sourceRef, contentItemId: _mcCtx.contentItemId };
    Object.keys(image).forEach(function(k){ body[k]=image[k]; });
    return mcApi('/api/metricool/send', { method:'POST', body: body });
  }).then(function(res){
    mcSetBtn('mc-send-btn', false);
    var el = document.getElementById('mc-msg');
    if(!res.ok){ el.innerHTML = '<div class="alert alert-err">'+mcEsc(res.error)+'</div>'; return; }
    // Say which of the two happened rather than a generic "sent".
    var fate = res.autoPublish
      ? ' It will publish automatically.'
      : ' It’s a draft — schedule it in the Metricool planner to publish.';
    var extra = fate + (res.note? ' '+mcEsc(res.note):'') + ((res.warnings&&res.warnings.length)? ' '+mcEsc(res.warnings.join(' ')):'');
    var each = res.sentTo ? ' Each network got its own text (' + mcEsc(res.sentTo.join(', ')) + ').' : '';
    el.innerHTML = '<div class="alert alert-ok">Sent to Metricool '+(res.autoPublish ? '— scheduled ' : 'as a draft for ')+mcEsc(res.scheduledFor)+'.'+each+extra+'</div>';
    if (_mcCtx.onSent) _mcCtx.onSent(res);
  }).catch(function(e){ mcSetBtn('mc-send-btn', false); document.getElementById('mc-msg').innerHTML = '<div class="alert alert-err">'+mcEsc(e.message)+'</div>'; });
}

// Send each network's own text as its own Metricool post, one after another,
// and report exactly which went if one fails part-way.
function sendGroups(groups, image, dateTime, tz, publish) {
  var sent = [], last = null;
  return groups.reduce(function(chain, g){
    return chain.then(function(){
      var body = { text: g.text, networks: g.networks, dateTime: dateTime, timezone: tz, publish: publish,
        sourceType: _mcCtx.sourceType, sourceRef: _mcCtx.sourceRef, contentItemId: _mcCtx.contentItemId };
      Object.keys(image).forEach(function(k){ body[k]=image[k]; });
      return mcApi('/api/metricool/send', { method:'POST', body: body }).then(function(res){
        var names = g.networks.map(function(n){ return MC_NETWORK_LABELS[n] || n; }).join(' and ');
        if (!res.ok) throw new Error((sent.length ? 'Sent ' + sent.join(', ') + ', but ' : '') + names + ' failed: ' + res.error);
        sent.push(names); last = res;
      });
    });
  }, Promise.resolve()).then(function(){
    return { ok: true, scheduledFor: last.scheduledFor, autoPublish: last.autoPublish, note: last.note,
             warnings: last.warnings, sentTo: sent };
  });
}
