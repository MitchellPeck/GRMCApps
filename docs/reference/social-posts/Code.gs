// ── Script Properties ─────────────────────────────────────────────────────────
// ANTHROPIC_API_KEY    — set via Settings tab
// MAILCHIMP_API_KEY    — set via Settings tab
// MAILCHIMP_SERVER     — e.g. "us21", set via Settings tab
// SPREADSHEET_ID       — auto-set on first run
// ─────────────────────────────────────────────────────────────────────────────

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('GRMC Social Posts')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── Constants ─────────────────────────────────────────────────────────────────

var VOICE = "GRMC voice rules: short, punchy, warm but not stiff. Salutations ('Family of Grace', 'Hey everyone') should be used sparingly, and rarely on content for both members and guests. Salutations are acceptible on posts that are more towards members. Open as an invitation, not insider communication. 2-4 sentences, line breaks between thoughts. No hashtags unless natural. Sentence case. No em-dashes as decoration.";

var HISTORY_SERIES_POSTS = [
  {date:"Jun 9",  phase:"Phase 1 - Our roots",          title:"Where it all began",        sub:"Founding in 2022 by ministers who came out of retirement - Randy Mickler, Charlie Marus, Ted Sauter - the East Cobb neighborhood, the original vision"},
  {date:"Jun 16", phase:"",                               title:"The people who built this",  sub:"The founding ministerial team - their combined decades of ministry across the Southeast and why they chose to start something new"},
  {date:"Jun 23", phase:"",                               title:"The building has a story",   sub:"History of the physical church at 1200 Indian Hills Pkwy - what it has meant to the East Cobb community"},
  {date:"Jun 30", phase:"",                               title:"A neighborhood, a calling",  sub:"East Cobb and Marietta - the community GRMC was planted to serve and the values that shaped its location"},
  {date:"Jul 7",  phase:"",                               title:"Through the early years",    sub:"What it took to establish a new congregation - growth, challenges, and the people who showed up from the start"},
  {date:"Jul 14", phase:"",                               title:"A mission in three words",   sub:"Honor God. Proclaim Christ. Serve others. Unpacking GRMC core mission and how it plays out week to week"},
  {date:"Jul 21", phase:"Phase 2 - Who we are now",      title:"Grace today",                sub:"Snapshot of GRMC right now - congregation, ministries, Sunday worship at 11am, what makes it distinct"},
  {date:"Jul 28", phase:"",                               title:"Our people, our story",      sub:"Spotlight: longtime members who embody the spirit of Grace Resurrection"},
  {date:"Aug 4",  phase:"",                               title:"Where worship happens",      sub:"A/V, music, production - the behind-the-scenes team that makes Sunday happen every week"},
  {date:"Aug 11", phase:"",                               title:"Serving beyond these walls", sub:"Outreach, missions, community partnerships - GRMC in Cobb County and beyond"},
  {date:"Aug 18", phase:"",                               title:"Every generation matters",   sub:"Youth, children ministry, young adults - multigenerational vision and NextGen leadership under Rev. Bacon"},
  {date:"Aug 25", phase:"Phase 3 - Where we are headed", title:"A vision for Grace",         sub:"Rev. Williams on where God is calling GRMC next - growth, discipleship, presence in East Cobb"},
  {date:"Sep 1",  phase:"",                               title:"You are part of this story", sub:"Invitation - the future of GRMC is still being written, and it includes you"}
];

// ── Settings ──────────────────────────────────────────────────────────────────

function getSettings() {
  var props = PropertiesService.getScriptProperties();
  var ak = props.getProperty('ANTHROPIC_API_KEY') || '';
  var mk = props.getProperty('MAILCHIMP_API_KEY') || '';
  return {
    anthropicKeyHint: ak ? ak.substring(0, 10) + '...' : '',
    hasAnthropicKey:  ak.length > 0,
    mailchimpServer:  props.getProperty('MAILCHIMP_SERVER') || '',
    hasMailchimp:     !!(mk && props.getProperty('MAILCHIMP_SERVER'))
  };
}

function saveSettings(s) {
  try {
    var props = PropertiesService.getScriptProperties();
    if (s.anthropicKey    && s.anthropicKey.trim())    props.setProperty('ANTHROPIC_API_KEY',  s.anthropicKey.trim());
    if (s.mailchimpKey    && s.mailchimpKey.trim())    props.setProperty('MAILCHIMP_API_KEY',  s.mailchimpKey.trim());
    if (s.mailchimpServer && s.mailchimpServer.trim()) props.setProperty('MAILCHIMP_SERVER',   s.mailchimpServer.trim());
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

// ── Claude API ────────────────────────────────────────────────────────────────

function callClaude(systemPrompt, userPrompt) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('No Anthropic API key. Go to Settings to add it.');
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }),
    muteHttpExceptions: true
  };
  var raw = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options).getContentText();
  var data = JSON.parse(raw);
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.content[0].text;
}

// ── Mailchimp ─────────────────────────────────────────────────────────────────

function getMailchimpAuth() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('MAILCHIMP_API_KEY');
  var server = props.getProperty('MAILCHIMP_SERVER');
  if (!key || !server) throw new Error('Mailchimp credentials not configured. Go to Settings.');
  return {
    base: 'https://' + server + '.api.mailchimp.com/3.0',
    opts: { method: 'get', headers: { 'Authorization': 'Basic ' + Utilities.base64Encode('anystring:' + key) }, muteHttpExceptions: true }
  };
}

// Returns the most recent Grace Notes campaign (sent or draft), filtered by subject.
// beforeDate: ISO date string — if provided, skip campaigns last updated after that Sunday.
function getLatestGraceNotes(beforeDate) {
  var mc = getMailchimpAuth();
  // Fetch all statuses so we catch drafts too — sort by created_at desc
  var url = mc.base + '/campaigns?count=30&sort_field=create_time&sort_dir=DESC'
    + '&fields=campaigns.id,campaigns.status,campaigns.settings.subject_line,campaigns.archive_url,campaigns.send_time,campaigns.create_time';
  var campaigns = JSON.parse(UrlFetchApp.fetch(url, mc.opts).getContentText()).campaigns || [];
  // Keep Grace Notes only, skip resends
  var gnCampaigns = campaigns.filter(function(c) {
    var subj = (c.settings.subject_line || '').toLowerCase();
    return subj.indexOf('grace notes') !== -1 && subj.indexOf('resend') === -1;
  });
  if (!gnCampaigns.length) throw new Error('No Grace Notes campaigns found in Mailchimp.');
  var target = gnCampaigns[0];
  // If beforeDate supplied, prefer the most recent one whose create_time is on or before that Sunday
  if (beforeDate) {
    var cutoff = new Date(beforeDate + 'T23:59:59');
    for (var i = 0; i < gnCampaigns.length; i++) {
      var t = new Date(gnCampaigns[i].create_time);
      if (t <= cutoff) { target = gnCampaigns[i]; break; }
    }
  }
  var contentRes = JSON.parse(UrlFetchApp.fetch(mc.base + '/campaigns/' + target.id + '/content?fields=plain_text', mc.opts).getContentText());
  var plainText = contentRes.plain_text || '';
  // Strip Mailchimp boilerplate header (everything before the first real paragraph)
  // The content starts after the archive/logo/date header block
  var cleaned = plainText;
  // Drop everything up to and including the first horizontal rule block (-----)
  var hrIdx = cleaned.indexOf('----');
  if (hrIdx !== -1) {
    // Find the end of that line and start from there
    var afterHr = cleaned.indexOf('\n', hrIdx);
    if (afterHr !== -1) cleaned = cleaned.substring(afterHr + 1).trim();
  }
  // Also strip footer (unsubscribe block) — Mailchimp footers start with standard markers
  var footerMarkers = ['*|IF:REWARDS|*', 'Unsubscribe', 'unsubscribe', '*|UNSUB|*', 'Copyright ©'];
  for (var fi = 0; fi < footerMarkers.length; fi++) {
    var fIdx = cleaned.indexOf(footerMarkers[fi]);
    if (fIdx !== -1 && fIdx > cleaned.length * 0.5) {
      cleaned = cleaned.substring(0, fIdx).trim();
      break;
    }
  }
  return {
    subject:    target.settings.subject_line,
    archiveUrl: target.archive_url || '',
    status:     target.status,
    sentAt:     target.send_time || target.create_time,
    preview:    cleaned.substring(0, 4000)
  };
}

// Fetch Grace Notes without drafting — for preview in the UI
function fetchGraceNotes(sundayDate) {
  try {
    var gn = getLatestGraceNotes(sundayDate || null);
    return { ok: true, subject: gn.subject, archiveUrl: gn.archiveUrl, sentAt: gn.sentAt, preview: gn.preview };
  } catch(e) { return { ok: false, error: e.message }; }
}

// ── Monday / Wednesday / Friday drafts ─────────────────────────────────────────────────

function draftMondayPosts(params) {
  try {
    var thu = getActiveSeriesThursdayItem(params.date);
    var lines = ['Draft three GRMC social posts.', '', VOICE, '', '--- CONTEXT ---',
      'SUNDAY DATE: ' + (params.date || 'this past Sunday'), 'SERMON TITLE: ' + params.sermon];
    if (params.pulpit)     { lines.push('', 'PULPIT AI SUMMARY:', params.pulpit); }
    if (params.events)     { lines.push('', 'UPCOMING EVENTS:', params.events); }
    if (params.highlights) { lines.push('', 'PEOPLE / HIGHLIGHTS:', params.highlights); }
    if (thu) {
      lines.push('', 'THURSDAY SERIES - post ' + (thu.postIdx + 1) + ' of ' + thu.total + ' (' + thu.date + ') from series "' + thu.seriesName + '":');
      lines.push(thu.title + ' - ' + thu.sub);
    }
    lines.push('', '--- POSTS TO DRAFT ---', '',
      '1. MONDAY - Service recap', 'Celebratory, invites people who missed to feel the energy. Reference sermon theme meaningfully.',
      '', '2. TUESDAY - Upcoming events', 'Highlight 1-2 events max. Clear CTA with date/time/location.');
    if (thu) {
      lines.push('', '3. THURSDAY - ' + thu.seriesName + ' series post (' + thu.date + ')',
        'Topic: ' + thu.title + '. Angle: ' + thu.sub,
        'Educational but not lecture-y. Next chapter in an unfolding story. Series context: ' + thu.context);
    } else {
      lines.push('', '3. THURSDAY - no active series post scheduled for this week. Write a general GRMC community post.');
    }
    var sys = 'You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. Return ONLY a JSON object with keys "monday", "tuesday", "thursday" each a string. No markdown fences, just valid JSON.';
    var raw = callClaude(sys, lines.join('\n')).replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
    var posts = JSON.parse(raw);
    savePostDrafts('monday', params.date, posts);
    if (thu) updateSeriesPostField(thu.seriesId, thu.postIdx, 'status', 'drafted');
    return { ok: true, posts: posts, seriesLabel: thu ? 'Post ' + (thu.postIdx+1) + ' of ' + thu.total + ': ' + thu.title : '' };
  } catch(e) { return { ok: false, error: e.message }; }
}

function draftWedPosts(params) {
  try {
    var graceNotes = null; var mailchimpError = null;
    if (!params.manualUrl) {
      try { graceNotes = getLatestGraceNotes(params.sundayDate || null); }
      catch(e) { mailchimpError = e.message; }
    }
    var archiveUrl  = params.manualUrl || (graceNotes ? graceNotes.archiveUrl : '(not provided)');
    var contentText = params.content   || (graceNotes ? graceNotes.preview    : '');
    var subject     = graceNotes ? graceNotes.subject : '';
    var sundayLabel = params.sundayDate ? 'Sunday ' + params.sundayDate : 'this Sunday';
    var lines = ['Draft two GRMC social posts.', '', VOICE, '', '--- CONTEXT ---',
      'UPCOMING SUNDAY DATE: ' + sundayLabel,
      'GRACE NOTES SUBJECT: ' + (subject || '(not available)'),
      'GRACE NOTES ARCHIVE URL: ' + archiveUrl, '', 'GRACE NOTES CONTENT:', contentText || '(not provided)', '',
      'THIS SUNDAY SERVICE PREVIEW:', params.service || '(not provided - write a warm general invite to Sunday 11am worship)',
      '', '--- POSTS TO DRAFT ---', '',
      '1. WEDNESDAY - Grace Notes post',
      'Warm summary of what is inside this week Grace Notes. End with the archive link. Make people feel there is something worth reading, not just a notification.',
      '', '2. SATURDAY - Invite and preview',
      'Anticipatory invite for ' + sundayLabel + ' service. Warm, specific to what is happening. Should make someone who has not been in a while feel welcomed back.'];
    var sys = 'You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. Return ONLY a JSON object with keys "wednesday" and "saturday" each a string. No markdown fences, just valid JSON.';
    var raw = callClaude(sys, lines.join('\n')).replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
    var posts = JSON.parse(raw);
    savePostDrafts('wednesday', params.sundayDate || '', posts);
    return { ok: true, posts: posts, mailchimpFetched: !!graceNotes, mailchimpError: mailchimpError, archiveUrl: archiveUrl, subject: subject, sentAt: graceNotes ? graceNotes.sentAt : '' };
  } catch(e) { return { ok: false, error: e.message }; }
}

function getLatestBlog() {
  var mc = getMailchimpAuth();
  var url = mc.base + '/campaigns?count=30&sort_field=create_time&sort_dir=DESC'
    + '&fields=campaigns.id,campaigns.status,campaigns.settings.subject_line,campaigns.archive_url,campaigns.send_time,campaigns.create_time';
  var campaigns = JSON.parse(UrlFetchApp.fetch(url, mc.opts).getContentText()).campaigns || [];
  var blogCampaigns = campaigns.filter(function(c) {
    var subj = (c.settings.subject_line || '').toLowerCase();
    return subj.indexOf('weekly blog') !== -1 && subj.indexOf('resend') === -1;
  });
  if (!blogCampaigns.length) throw new Error('No Weekly Blog campaigns found in Mailchimp.');
  var target = blogCampaigns[0];
  var contentRes = JSON.parse(UrlFetchApp.fetch(mc.base + '/campaigns/' + target.id + '/content?fields=plain_text', mc.opts).getContentText());
  var cleaned = contentRes.plain_text || '';
  var hrIdx = cleaned.indexOf('----');
  if (hrIdx !== -1) {
    var afterHr = cleaned.indexOf('\n', hrIdx);
    if (afterHr !== -1) cleaned = cleaned.substring(afterHr + 1).trim();
  }
  var footerMarkers = ['*|IF:REWARDS|*', 'Unsubscribe', 'unsubscribe', '*|UNSUB|*', 'Copyright ©'];
  for (var fi = 0; fi < footerMarkers.length; fi++) {
    var fIdx = cleaned.indexOf(footerMarkers[fi]);
    if (fIdx !== -1 && fIdx > cleaned.length * 0.5) {
      cleaned = cleaned.substring(0, fIdx).trim();
      break;
    }
  }
  return {
    subject:    target.settings.subject_line,
    archiveUrl: target.archive_url || '',
    status:     target.status,
    sentAt:     target.send_time || target.create_time,
    preview:    cleaned.substring(0, 4000)
  };
}

function fetchBlog() {
  try {
    var blog = getLatestBlog();
    return { ok: true, subject: blog.subject, archiveUrl: blog.archiveUrl, sentAt: blog.sentAt, preview: blog.preview };
  } catch(e) { return { ok: false, error: e.message }; }
}

function draftFridayPost(params) {
  try {
    var blog = null; var mailchimpError = null;
    if (!params.manualUrl) {
      try { blog = getLatestBlog(); }
      catch(e) { mailchimpError = e.message; }
    }
    var archiveUrl  = params.manualUrl || (blog ? blog.archiveUrl : '(not provided)');
    var contentText = params.content   || (blog ? blog.preview    : '');
    var subject     = blog ? blog.subject : '';
    var lines = [
      'Draft one GRMC social media post promoting this week\'s blog post.', '', VOICE, '',
      '--- CONTEXT ---',
      'BLOG POST SUBJECT: ' + (subject || params.subject || '(not available)'),
      'BLOG ARCHIVE URL: ' + archiveUrl,
      '', 'BLOG CONTENT:', contentText || '(not provided)',
      '', '--- POST TO DRAFT ---', '',
      'FRIDAY - Weekly blog post',
      'Tease the most compelling idea or question from the blog. Make someone want to read it.',
      'End with the archive URL on its own line.',
      'Do not summarize everything — hook with one strong thread.'
    ];
    var sys = 'You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. Return ONLY a JSON object with key "friday" containing the post text string. No markdown fences, just valid JSON.';
    var raw = callClaude(sys, lines.join('\n')).replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
    var posts = JSON.parse(raw);
    savePostDrafts('friday', params.date || '', posts);
    return { ok: true, posts: posts, mailchimpFetched: !!blog, mailchimpError: mailchimpError, archiveUrl: archiveUrl, subject: subject, sentAt: blog ? blog.sentAt : '' };
  } catch(e) { return { ok: false, error: e.message }; }
}

// ── Series management ─────────────────────────────────────────────────────────
// Sheet: Series  — cols: id | name | description | context | cadence | status | createdAt
// Sheet: SeriesPosts — cols: seriesId | postIdx | date | phase | title | sub | status | draft | notes

function getSeriesSheet() { return getOrCreateSheet('Series', ['ID','Name','Description','Context','Cadence','Status','Created']); }
function getSeriesPostsSheet() { return getOrCreateSheet('SeriesPosts', ['SeriesID','PostIdx','Date','Phase','Title','Angle','Status','Draft','Notes']); }

function getAllSeries() {
  try {
    var sheet = getSeriesSheet();
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) {
      seedHistorySeries();
      data = sheet.getDataRange().getValues();
    }
    var rows = [];
    for (var i = 1; i < data.length; i++) {
      rows.push({ id: String(data[i][0]), name: String(data[i][1]), description: String(data[i][2] || ''),
        context: String(data[i][3] || ''), cadence: String(data[i][4] || 'weekly'),
        status: String(data[i][5] || 'active'), createdAt: String(data[i][6] || '') });
    }
    return { ok: true, series: rows };
  } catch(e) { Logger.log('getAllSeries: ' + e.message); return { ok: false, error: e.message }; }
}

function getSeriesPosts(seriesId) {
  try {
    var sheet = getSeriesPostsSheet();
    var data = sheet.getDataRange().getValues();
    var rows = [];
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(seriesId)) {
        rows.push({ seriesId: String(data[i][0]), postIdx: Number(data[i][1]),
          date: String(data[i][2] || ''), phase: String(data[i][3] || ''),
          title: String(data[i][4] || ''), sub: String(data[i][5] || ''),
          status: String(data[i][6] || 'pending'), draft: String(data[i][7] || ''), notes: String(data[i][8] || '') });
      }
    }
    rows.sort(function(a,b){ return a.postIdx - b.postIdx; });
    return { ok: true, posts: rows };
  } catch(e) { return { ok: false, error: e.message }; }
}

function createSeries(params) {
  try {
    var sheet = getSeriesSheet();
    var id = 'series-' + Date.now();
    sheet.appendRow([id, params.name, params.description || '', params.context || '', params.cadence || 'weekly', 'active', new Date().toISOString()]);
    // Create posts from params.posts array [{date, phase, title, sub}]
    if (params.posts && params.posts.length) {
      var postsSheet = getSeriesPostsSheet();
      params.posts.forEach(function(p, i) {
        postsSheet.appendRow([id, i, p.date || '', p.phase || '', p.title, p.sub || '', 'pending', '', '']);
      });
    }
    return { ok: true, id: id };
  } catch(e) { return { ok: false, error: e.message }; }
}

function addSeriesPost(seriesId, post) {
  try {
    var sheet = getSeriesPostsSheet();
    var data = sheet.getDataRange().getValues();
    var maxIdx = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(seriesId)) maxIdx = Math.max(maxIdx, Number(data[i][1]));
    }
    sheet.appendRow([seriesId, maxIdx + 1, post.date || '', post.phase || '', post.title, post.sub || '', 'pending', '', '']);
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

function updateSeriesPostField(seriesId, postIdx, field, value) {
  try {
    var sheet = getSeriesPostsSheet();
    var data = sheet.getDataRange().getValues();
    var colMap = { date:3, phase:4, title:5, sub:6, status:7, draft:8, notes:9 };
    var col = colMap[field];
    if (!col) return { ok: false, error: 'Unknown field: ' + field };
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(seriesId) && Number(data[i][1]) === Number(postIdx)) {
        sheet.getRange(i + 1, col).setValue(value);
        return { ok: true };
      }
    }
    return { ok: false, error: 'Post not found' };
  } catch(e) { return { ok: false, error: e.message }; }
}

function updateSeriesMeta(seriesId, fields) {
  try {
    var sheet = getSeriesSheet();
    var data = sheet.getDataRange().getValues();
    var colMap = { name:2, description:3, context:4, cadence:5, status:6 };
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(seriesId)) {
        Object.keys(fields).forEach(function(f) {
          var col = colMap[f];
          if (col) sheet.getRange(i + 1, col).setValue(fields[f]);
        });
        return { ok: true };
      }
    }
    return { ok: false, error: 'Series not found' };
  } catch(e) { return { ok: false, error: e.message }; }
}

function draftSeriesPost(seriesId, postIdx) {
  try {
    var seriesRes = getAllSeries();
    if (!seriesRes.ok) throw new Error(seriesRes.error);
    var series = null;
    seriesRes.series.forEach(function(s) { if (s.id === seriesId) series = s; });
    if (!series) throw new Error('Series not found: ' + seriesId);

    var postsRes = getSeriesPosts(seriesId);
    if (!postsRes.ok) throw new Error(postsRes.error);
    var post = null;
    postsRes.posts.forEach(function(p) { if (p.postIdx === postIdx) post = p; });
    if (!post) throw new Error('Post not found');

    var lines = [
      'Draft a GRMC social media post for the "' + series.name + '" series.', '', VOICE, '',
      'SERIES NAME: ' + series.name,
      'SERIES DESCRIPTION: ' + series.description,
      'SERIES CONTEXT: ' + series.context,
      '', 'THIS POST: ' + (postIdx + 1) + ' of ' + postsRes.posts.length,
      'SCHEDULED DATE: ' + (post.date || 'TBD'),
      'TITLE: ' + post.title,
      'ANGLE: ' + (post.sub || ''),
    ];
    if (post.phase) lines.push('PHASE: ' + post.phase);
    lines.push('', 'Write it as the next chapter in an unfolding story, not a standalone fact post.');
    lines.push('Tone: educational but not lecture-y, warm, inviting, makes people want to follow along.');

    var sys = 'You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. Return ONLY a JSON object with key "post" containing the post text string. No markdown fences, just valid JSON.';
    var raw = callClaude(sys, lines.join('\n')).replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
    var result = JSON.parse(raw);
    updateSeriesPostField(seriesId, postIdx, 'status', 'drafted');
    updateSeriesPostField(seriesId, postIdx, 'draft', result.post);
    return { ok: true, post: result.post, seriesName: series.name };
  } catch(e) { return { ok: false, error: e.message }; }
}

function generateSeriesPostsWithClaude(params) {
  try {
    var lines = [
      'Generate a post schedule for a social media series called "' + params.name + '".',
      'Description: ' + params.description,
      'Context: ' + params.context,
      'Number of posts: ' + params.count,
      'Cadence: ' + (params.cadence || 'weekly'),
      'Start date: ' + (params.startDate || 'TBD'),
      '',
      'Return ONLY a JSON array of objects, each with: date (string), phase (string, group label or empty), title (short post title), sub (angle/description for this post, 1-2 sentences).',
      'Plan the arc: build toward a conclusion, group into 2-3 phases if it makes sense.',
      'No markdown fences, just valid JSON array.'
    ];
    var sys = 'You are a social media content strategist for Grace Resurrection Methodist Church (GRMC) in Marietta, GA.';
    var raw = callClaude(sys, lines.join('\n')).replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
    var posts = JSON.parse(raw);
    return { ok: true, posts: posts };
  } catch(e) { return { ok: false, error: e.message }; }
}

// ── Seed built-in History series ──────────────────────────────────────────────

function seedHistorySeries() {
  var sheet = getSeriesSheet();
  var id = 'series-history';
  sheet.appendRow([id, 'History of GRMC', '13-week series on the founding, present, and future of Grace Resurrection',
    'Founded in 2022 in East Cobb/Marietta by Rev. Dr. Randy Mickler, Rev. Charlie Marus, Rev. Dr. Ted Sauter - experienced ministers who came out of retirement. 1200 Indian Hills Pkwy, Marietta GA. Senior Pastor Rev. James Williams joined Oct 2024; Associate Pastor Rev. Taylor Bacon joined Nov 2025.',
    'weekly', 'active', new Date().toISOString()]);
  var postsSheet = getSeriesPostsSheet();
  HISTORY_SERIES_POSTS.forEach(function(p, i) {
    postsSheet.appendRow([id, i, p.date, p.phase, p.title, p.sub, 'pending', '', '']);
  });
}

// ── Active series Thursday helper (for Monday run) ────────────────────────────

function getActiveSeriesThursdayItem(dateStr) {
  try {
    var ref = dateStr ? new Date(dateStr + 'T12:00:00') : new Date();
    var year = ref.getFullYear();
    var months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    var seriesRes = getAllSeries();
    if (!seriesRes.ok) return null;
    var active = seriesRes.series.filter(function(s){ return s.status === 'active'; });
    var best = null; var minDiff = Infinity;
    active.forEach(function(s) {
      var postsRes = getSeriesPosts(s.id);
      if (!postsRes.ok) return;
      postsRes.posts.forEach(function(p, i) {
        if (p.status === 'posted') return;
        var parts = p.date.split(' ');
        if (parts.length < 2 || !months.hasOwnProperty(parts[0])) return;
        var d = new Date(year, months[parts[0]], parseInt(parts[1]), 12);
        var diff = Math.abs(ref - d);
        if (diff < minDiff) {
          minDiff = diff;
          best = { seriesId: s.id, seriesName: s.name, context: s.context,
            postIdx: p.postIdx, total: postsRes.posts.length,
            date: p.date, title: p.title, sub: p.sub, phase: p.phase };
        }
      });
    });
    return best;
  } catch(e) { Logger.log('getActiveSeriesThursdayItem: ' + e.message); return null; }
}

// ── Sheet helpers ─────────────────────────────────────────────────────────────

function getSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPREADSHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch(e) {} }
  var ss = SpreadsheetApp.create('GRMC Social Posts Data');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  Logger.log('Created spreadsheet: ' + ss.getUrl());
  return ss;
}

function getOrCreateSheet(name, headers) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers) { sheet.appendRow(headers); sheet.setFrozenRows(1); }
  }
  return sheet;
}

function savePostDrafts(run, postDate, posts) {
  try {
    var sheet = getOrCreateSheet('PostDrafts', ['Date Drafted','Run','Post Date','Key','Text','Status']);
    var now = new Date().toISOString();
    Object.keys(posts).forEach(function(key) { sheet.appendRow([now, run, postDate, key, posts[key], 'draft']); });
  } catch(e) { Logger.log('savePostDrafts: ' + e.message); }
}

function getRecentDrafts() {
  try {
    var sheet = getOrCreateSheet('PostDrafts', ['Date Drafted','Run','Post Date','Key','Text','Status']);
    var data = sheet.getDataRange().getValues();
    var rows = [];
    var start = Math.max(1, data.length - 20);
    for (var i = start; i < data.length; i++) {
      rows.push({ dateDrafted: String(data[i][0]), run: String(data[i][1]), postDate: String(data[i][2]), key: String(data[i][3]), text: String(data[i][4]), status: String(data[i][5]) });
    }
    return { ok: true, rows: rows.reverse() };
  } catch(e) { return { ok: false, error: e.message }; }
}
