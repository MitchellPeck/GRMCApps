// ── Walkthrough steps ───────────────────────────────────────────────────────
// In the order a real meeting happens, on the practice meeting from demo.ts:
// topic 1 and 2 come already recorded and summarized; topic 3 is empty, for
// the user to record into if they choose.
//
// Each step: view ('list' | 'detail'), anchor (selector, or a function of the
// tour), title, body (HTML), enter (run once the screen is ready), until (Next
// waits for it and the tour moves on by itself), hint (shown while waiting),
// optional (offers Skip), skipIf (passed over when true).
function tourTopic(n){ var it = (state.items || [])[n]; return it ? it.id : 0; }
function tourRecording(){ return typeof meetingRec !== 'undefined' && !!meetingRec; }

var TOUR_STEPS = [
  { view: 'list', anchor: null,
    title: 'Welcome',
    body: '<p>This walkthrough shows how to take a meeting’s minutes, start to finish, in about five minutes.</p>'
      + '<p>It uses a <b>practice meeting</b> that only you can see. Click and type anything you like; nothing in it is real, and you can delete it at the end.</p>'
      + '<p>You can leave at any time with “Leave walkthrough” or the Esc key.</p>' },

  { view: 'list', anchor: function(t){ return '.mcard[data-id="' + t.practiceId + '"]'; },
    title: 'Open the practice meeting',
    body: '<p>Every meeting is listed here, newest first, with where it stands.</p><p><b>Click the practice meeting</b> to open it.</p>',
    until: function(t){ return state.meeting && state.meeting.id === t.practiceId && document.getElementById('view-detail').style.display !== 'none'; },
    hint: 'Click “PRACTICE — April Board Meeting”.' },

  { view: 'detail', anchor: '#next-step',
    enter: function(){ showSection('agenda'); },
    title: 'This bar tells you what to do next',
    body: '<p>Whenever you’re not sure what to do, look here. It always shows the <b>one next step</b> and a button that does it.</p>' },

  { view: 'detail', anchor: '#mtg-nav',
    title: 'The steps of a meeting',
    body: '<p>Down the side are the steps, in the order they happen: <b>1. Agenda, 2. Attendance, 3. Record, 4. Voices, 5. Minutes</b>.</p>'
      + '<p>A tick (✓) means that step is done. Click any step to go to it.</p>' },

  { view: 'detail', anchor: '#items-wrap',
    enter: function(){ showSection('agenda'); },
    title: '1. Agenda: the topics',
    body: '<p>The topics usually come from the agenda file: choose the file and its topics are read for you. You can also type them in with “+ Add topic”.</p>'
      + '<p>This practice meeting already has three.</p>' },

  { view: 'detail', anchor: function(){ return '[data-toggle-item="' + tourTopic(1) + '"]'; },
    enter: function(){ showSection('agenda'); },
    title: 'Open a topic',
    body: '<p><b>Click “Budget review”</b> to open it.</p>',
    until: function(){ return state.openItemId === tourTopic(1); },
    hint: 'Click the “Budget review” topic.' },

  { view: 'detail', anchor: function(){ return '#ibody-' + tourTopic(1); },
    title: 'Inside a topic',
    body: '<p><b>Your notes</b>: type motions, votes, anything the minutes must include. They save by themselves.</p>'
      + '<p>Below that is the <b>summary</b> and the <b>action items</b> (who will do what). These are written for you from the recording and your notes.</p>' },

  { view: 'detail', anchor: '#attendee-list',
    enter: function(){ showSection('people'); },
    title: '2. Attendance',
    body: '<p>Tap a name to mark someone present or absent.</p>'
      + '<p>This matters later: <b>only people marked here can be named as speakers</b>. Someone missing from the list can be added just below.</p>' },

  { view: 'detail', anchor: '#btn-meeting-rec',
    enter: function(){ showSection('recording'); },
    title: '3. Record',
    body: '<p>When the meeting begins, press <b>Start recording</b>, once, for the whole meeting.</p>'
      + '<p>Want to try it? Press it now and allow the microphone. Or press “Skip this step”; the practice meeting already has recordings.</p>',
    until: function(){ return tourRecording(); },
    hint: 'Press “Start recording”, or skip this step.',
    optional: true },

  { view: 'detail', anchor: function(){ return '#rec-console [data-rc-topic="' + tourTopic(2) + '"]'; },
    skipIf: function(){ return !tourRecording(); },
    enter: function(){ if(typeof openRecConsole === 'function' && !recConsoleOpen) openRecConsole(); },
    title: 'Tap the topic being discussed',
    body: '<p>This is the note-taking screen. As each topic comes up, tap it, so the recording is filed under the right topic.</p>'
      + '<p><b>Tap “Building repairs — roof quote”</b> now.</p>',
    until: function(){ return tourRecording() && meetingRec.topicId === tourTopic(2); },
    hint: 'Tap “Building repairs — roof quote”.',
    optional: true },

  { view: 'detail', anchor: '#rc-notes',
    skipIf: function(){ return !tourRecording(); },
    title: 'Say a few words',
    body: '<p>Talk for about 15 seconds, as if reporting on the roof: “We have one quote, for ten thousand dollars…”</p>'
      + '<p>You can type notes in this box at the same time.</p>',
    until: function(){ return tourRecording() && meetingElapsedSeconds() >= 15; },
    hint: 'Keep talking… the tour moves on after 15 seconds.',
    optional: true },

  { view: 'detail', anchor: '#rc-stop',
    skipIf: function(){ return !tourRecording(); },
    title: 'Stop recording',
    body: '<p>When the meeting ends, press <b>Stop recording</b> and say yes. It’s then typed up for you on the server; that takes a few minutes, and you can close the page meanwhile.</p>',
    until: function(){ return !tourRecording(); },
    hint: 'Press “Stop recording”.' },

  { view: 'detail', anchor: '#meeting-speakers',
    enter: function(){ showSection('speakers'); },
    title: '4. Voices',
    body: '<p>After a recording is typed up, each voice in it appears here. Press ▶ to hear one, then <b>choose who it is</b>. Once is enough for the whole meeting.</p>'
      + '<p>These three are already named. If you recorded, your voice appears here when it’s been typed up; try naming it.</p>' },

  { view: 'detail', anchor: '#fix-panel',
    title: 'Correct a misheard name',
    body: '<p>If the recording misheard a name or word, type the wrong spelling and the right one, then press <b>Show where it appears</b> and <b>Change all</b>. It’s corrected everywhere at once.</p>' },

  { view: 'detail', anchor: '#btn-report',
    enter: function(){ showSection('minutes'); },
    title: '5. Minutes',
    body: function(){
      if(state.aiReady === false){
        return '<p>Here you’d press <b>Write the minutes</b>, and full minutes would be written from the topics, notes and recording, with every action item collected at the end.</p>'
          + '<p>The AI isn’t set up yet on this app, so it can’t write them now. Ask whoever set up the app to finish it under Settings › Technical setup.</p>';
      }
      return '<p>Press <b>Write the minutes</b>. Full minutes are written from the topics, notes and recording, with every action item collected at the end. It takes a minute or two.</p>';
    },
    until: function(){ return state.aiReady !== false && !!(state.meeting && (state.meeting.report || (state.report && state.report.status === 'pending'))); },
    hint: 'Press “Write the minutes”, or skip this step.',
    optional: true },

  { view: 'detail', anchor: '#report-box',
    skipIf: function(){ return !(state.meeting && (state.meeting.report || (state.report && state.report.status === 'pending'))); },
    title: 'Check, change, print',
    body: '<p>Read the minutes over. <b>Click any line to change it</b>; changes save as you go.</p>'
      + '<p>Then press <b>Print or save as PDF</b>, or open them in Google Docs. The panel beside them answers questions about the meeting and can make changes for you.</p>' },

  { view: 'detail', anchor: null,
    title: 'That’s it',
    body: '<p>For a real meeting, press <b>+ New meeting</b> on the meetings list and follow the bar at the top of the page.</p>'
      + '<p>You can take this walkthrough again any time with the <b>Walkthrough</b> button at the top right.</p>',
    extra: function(t){
      var row = document.createElement('div');
      row.className = 'tour-finish';
      row.innerHTML = '<button type="button" class="btn btn-secondary" id="tour-delete">Delete the practice meeting</button>';
      row.querySelector('button').addEventListener('click', function(){
        var b = this; b.disabled = true; b.textContent = 'Deleting…';
        api('/api/practice', { method: 'DELETE' }).then(function(res){
          if(res && res.ok){ endTour(true); showList(); }
          else { b.disabled = false; b.textContent = 'Delete the practice meeting'; alert(plainError((res && res.error) || 'It couldn’t be deleted.')); }
        });
      });
      return row;
    },
    nextLabel: 'Finish and keep it',
    finish: function(){ endTour(true); } },
];
