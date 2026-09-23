(function () {
  "use strict";

  // ── state ────────────────────────────────────────────────────────────────
  var me = { email: "", name: "", permissions: {} };
  var mediaList = [];
  var playlists = [];
  var scheduleEntries = [];
  var screens = [];
  var settings = null;
  var defaultPlaylistId = null;
  var people = [];
  var openPlaylist = null;   // { playlist, items }
  var picked = {};           // media ids ticked in the "add media" picker
  var timezone = "America/Chicago";
  var hours = null;          // { mode, windows, state, neverOn, events, onAction, offAction }

  var $ = function (id) { return document.getElementById(id); };
  var HUB = "https://hub." + location.hostname.split(".").slice(1).join(".");

  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // ── helpers ──────────────────────────────────────────────────────────────
  function msg(el, text, kind) {
    var box = $(el);
    if (!box) return;
    if (!text) { box.innerHTML = ""; return; }
    var d = document.createElement("div");
    d.className = "alert alert-" + (kind || "info");
    d.textContent = text;
    box.innerHTML = "";
    box.appendChild(d);
    if (kind === "ok") setTimeout(function () { if (box.firstChild === d) box.innerHTML = ""; }, 3000);
  }

  function busy(id, on, label) {
    var b = $(id);
    if (!b) return;
    b.disabled = on;
    b.textContent = on ? (label || "Working…") : b.getAttribute("data-default");
  }

  async function api(method, url, body) {
    var res = await fetch(url, {
      method: method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin"
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || data.ok === false) throw new Error(data.error || "That didn't work. Try again.");
    return data;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function button(label, cls, onClick) {
    var b = el("button", cls || "btn-sm", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function fmtWhen(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString([], {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit"
    });
  }

  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function fmtDuration(ms) {
    if (!ms) return "";
    var total = Math.round(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  // <input type="datetime-local"> speaks local wall-clock with no zone, so both
  // directions go through the browser's own zone deliberately.
  function toLocalInput(date) {
    var d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return "";
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function fromLocalInput(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function can(name) { return Boolean(me.permissions && me.permissions[name]); }

  function applyPermissions() {
    document.querySelectorAll("[data-needs]").forEach(function (node) {
      node.hidden = !can(node.getAttribute("data-needs"));
    });
    var nothing = !can("upload") && !can("schedule") && !can("manage") && !can("admin");
    $("no-perms").hidden = !nothing;
    $("set-save").hidden = !can("admin");
    $("set-readonly").hidden = can("admin");
    document.querySelectorAll("#p-settings input, #p-settings select").forEach(function (node) {
      if (node.id && node.id.indexOf("set-") === 0) node.disabled = !can("admin");
    });
  }

  // ── tabs ─────────────────────────────────────────────────────────────────
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".panel").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      var panel = $("p-" + tab.getAttribute("data-tab"));
      if (panel) panel.classList.add("active");
      if (tab.getAttribute("data-tab") === "now") loadNow();
    });
  });

  // ── on now ───────────────────────────────────────────────────────────────
  function describeNow(data, into) {
    into.innerHTML = "";
    into.className = "";

    // Outside opening hours nothing else matters — say that first, and say
    // what WOULD be playing, so it doesn't read like a fault.
    if (data.power && data.power.on === false) {
      var dark = el("div", "alert alert-info",
        "The screen is off \u2014 outside the narthex's opening hours" +
        (data.power.changesAt ? ", coming back on " + fmtWhen(data.power.changesAt) : "") + ".");
      into.appendChild(dark);
    }

    var wrap = el("div", "now");
    var what = el("div", "now-what");

    if (!data.playlist) {
      what.appendChild(el("div", "now-title", "Nothing scheduled"));
      what.appendChild(el("div", "now-why",
        "The screen is showing its idle background. Schedule a playlist, or pick one " +
        "under Settings to play whenever nothing else is on."));
      wrap.appendChild(what);
      into.appendChild(wrap);
      return;
    }

    what.appendChild(el("div", "now-title", data.playlist.name));

    var why = el("div", "now-why");
    var lines = [];
    if (data.source === "default") {
      lines.push("Playing because nothing is scheduled right now — this is the standing default.");
    } else if (data.entry) {
      var modeText = {
        window: "Scheduled between two times",
        until_next: "Scheduled to play until something else starts",
        recurring: "A repeating slot"
      }[data.entry.mode] || "Scheduled";
      lines.push(modeText + (data.entry.label ? " — “" + data.entry.label + "”" : "") + ".");
    }
    if (data.startedAt) lines.push("Started " + fmtWhen(data.startedAt) + ".");
    lines.push(data.endsAt ? "Ends " + fmtWhen(data.endsAt) + "." : "No end — it plays until something else is scheduled.");
    if (data.changesAt && data.changesAt !== data.endsAt) {
      lines.push("Next change " + fmtWhen(data.changesAt) + ".");
    }
    lines.push(data.readyCount + " item" + (data.readyCount === 1 ? "" : "s") + " in the loop" +
      (data.pendingCount ? ", " + data.pendingCount + " still converting" : "") + ".");
    why.textContent = lines.join(" ");
    what.appendChild(why);

    wrap.appendChild(what);
    into.appendChild(wrap);

    if (!data.readyCount) {
      var warn = el("div", "alert alert-warn",
        data.pendingCount
          ? "Everything in this playlist is still converting, so the screen is blank for now."
          : "This playlist has nothing playable in it, so the screen is blank.");
      warn.style.marginTop = "12px";
      into.appendChild(warn);
    }
  }

  function renderTakeover(t) {
    var box = $("takeover-banner");
    box.innerHTML = "";
    if (!t || !t.active) return;
    var alert = el("div", "alert alert-err");
    alert.style.display = "flex";
    alert.style.alignItems = "center";
    alert.style.gap = "12px";
    var text = el("div");
    text.style.flex = "1";
    text.appendChild(el("strong", null, "On screen now: " + t.headline));
    if (t.body) text.appendChild(el("div", null, t.body));
    if (t.startedBy) {
      text.appendChild(el("div", "hint", "Put up by " + t.startedBy +
        (t.startedAt ? " " + fmtWhen(t.startedAt) : "")));
    }
    alert.appendChild(text);
    if (can("schedule")) {
      alert.appendChild(button("Clear it", "btn btn-secondary", async function () {
        try {
          await api("DELETE", "/api/takeover");
          loadNow();
        } catch (e) { msg("schedule-msg", e.message, "err"); }
      }));
    }
    box.appendChild(alert);
  }

  $("to-start").addEventListener("click", async function () {
    var headline = $("to-headline").value.trim();
    var body = $("to-body").value.trim();
    if (!headline && !body) { alert("Give the message something to say."); return; }
    if (!confirm("This replaces everything on the narthex screen immediately. Continue?")) return;
    busy("to-start", true);
    try {
      await api("POST", "/api/takeover", { headline: headline, body: body, urgent: $("to-urgent").checked });
      $("to-headline").value = "";
      $("to-body").value = "";
      loadNow();
    } catch (e) {
      msg("schedule-msg", e.message, "err");
    } finally {
      busy("to-start", false);
    }
  });

  async function loadNow() {
    try {
      var data = await api("GET", "/api/schedule/now");
      timezone = data.timezone || timezone;
      describeNow(data, $("now-box"));
      try {
        renderTakeover((await api("GET", "/api/takeover")).takeover);
      } catch (e) { /* the card is an extra; never let it break "on now" */ }
    } catch (e) {
      $("now-box").className = "empty";
      $("now-box").textContent = e.message;
    }
  }

  $("preview-go").addEventListener("click", async function () {
    var iso = fromLocalInput($("preview-at").value);
    if (!iso) { msg("preview-box", "Pick a date and time first.", "err"); return; }
    busy("preview-go", true);
    try {
      var data = await api("GET", "/api/schedule/now?at=" + encodeURIComponent(iso));
      var box = $("preview-box");
      box.innerHTML = "";
      var head = el("div", "hint", "At " + fmtWhen(iso) + " the screen would show:");
      head.style.marginTop = "12px";
      box.appendChild(head);
      var body = el("div");
      body.style.marginTop = "6px";
      describeNow(data, body);
      box.appendChild(body);
    } catch (e) {
      msg("preview-box", e.message, "err");
    } finally {
      busy("preview-go", false);
    }
  });

  function renderPreviewScreens() {
    var box = $("preview-screens");
    box.innerHTML = "";
    if (!can("manage")) {
      box.appendChild(el("span", "hint", "Only someone who can manage screens can preview them here."));
      return;
    }
    if (!screens.length) {
      box.appendChild(el("span", "hint", "No screens yet — add one under Screens."));
      return;
    }
    screens.forEach(function (screen) {
      box.appendChild(button(screen.name, "btn-sm", function () {
        $("preview-frame-wrap").hidden = false;
        // Cache-bust: a preview showing a stale player.css or player.js is
        // worse than useless, because it misrepresents what the TV is doing.
        $("preview-frame").src = "/player?t=" + encodeURIComponent(screen.token) +
          "&v=" + Date.now();
      }));
    });
    box.appendChild(button("Stop preview", "btn-sm", function () {
      $("preview-frame").src = "about:blank";
      $("preview-frame-wrap").hidden = true;
    }));
  }

  // ── schedule ─────────────────────────────────────────────────────────────
  var chosenDays = [];

  function renderDayPicker() {
    var box = $("s-days");
    box.innerHTML = "";
    DAYS.forEach(function (name, i) {
      var b = el("button", "day" + (chosenDays.indexOf(i) >= 0 ? " on" : ""), name);
      b.type = "button";
      b.addEventListener("click", function () {
        var at = chosenDays.indexOf(i);
        if (at >= 0) chosenDays.splice(at, 1); else chosenDays.push(i);
        renderDayPicker();
      });
      box.appendChild(b);
    });
  }

  var MODE_HINTS = {
    until_next: "Starts when you say and keeps playing — until another " +
      "“until something else” entry starts later. A timed entry can still " +
      "borrow the screen and hand it back.",
    window: "Plays only between those two moments, then the screen goes back to " +
      "whatever was standing before it.",
    recurring: "Repeats every week on the days you tick, in the app's timezone. " +
      "Daylight saving is handled — 08:00 stays 08:00."
  };

  function syncModeFields() {
    var mode = $("s-mode").value;
    $("s-mode-hint").textContent = MODE_HINTS[mode] || "";
    document.querySelectorAll("#p-schedule [data-mode]").forEach(function (node) {
      node.hidden = node.getAttribute("data-mode").split(" ").indexOf(mode) === -1;
    });
  }
  $("s-mode").addEventListener("change", syncModeFields);

  function scheduleLine(entry) {
    if (entry.mode === "recurring") {
      var days = entry.days && entry.days.length
        ? entry.days.map(function (d) { return DAYS[d]; }).join(", ")
        : "Every day";
      var range = entry.startTime + "–" + entry.endTime;
      var bounds = "";
      if (entry.effectiveFrom || entry.effectiveTo) {
        bounds = " (" + (entry.effectiveFrom || "any date") + " to " + (entry.effectiveTo || "no end") + ")";
      }
      return days + ", " + range + " " + timezone + bounds;
    }
    if (entry.mode === "window") {
      return fmtWhen(entry.startsAt) + " → " + fmtWhen(entry.endsAt);
    }
    return "From " + fmtWhen(entry.startsAt) + ", until something else starts";
  }

  var STATE_PILL = {
    active: ["pill pill-ok", "On now"],
    upcoming: ["pill pill-info", "Upcoming"],
    superseded: ["pill pill-pending", "Superseded"],
    finished: ["pill pill-pending", "Finished"],
    disabled: ["pill pill-rejected", "Off"]
  };

  function renderSchedule() {
    var box = $("schedule-list");
    box.innerHTML = "";
    if (!scheduleEntries.length) {
      box.className = "empty";
      box.textContent = "Nothing is scheduled yet.";
      return;
    }
    box.className = "";

    scheduleEntries.forEach(function (entry) {
      var row = el("div", "row" + (entry.state === "active" ? " is-active" : "") +
        (entry.enabled ? "" : " is-off"));
      var main = el("div", "row-main");

      var title = el("div", "row-title");
      title.appendChild(document.createTextNode(entry.playlistName));
      var pill = STATE_PILL[entry.state] || STATE_PILL.upcoming;
      var badge = el("span", pill[0], pill[1]);
      badge.style.marginLeft = "8px";
      title.appendChild(badge);
      if (entry.priority) {
        var p = el("span", "pill pill-info", "priority " + entry.priority);
        p.style.marginLeft = "6px";
        title.appendChild(p);
      }
      main.appendChild(title);

      var sub = el("div", "row-sub", scheduleLine(entry));
      if (entry.label) sub.textContent = "“" + entry.label + "” — " + sub.textContent;
      if (entry.currentEnd) sub.textContent += " · ends " + fmtTime(entry.currentEnd);
      else if (entry.nextStart) sub.textContent += " · next " + fmtWhen(entry.nextStart);
      main.appendChild(sub);

      row.appendChild(main);

      if (can("schedule")) {
        var actions = el("div", "row-actions");
        actions.appendChild(button(entry.enabled ? "Turn off" : "Turn on", "btn-sm", async function () {
          try {
            await api("PATCH", "/api/schedule/" + entry.id, { enabled: !entry.enabled });
            await loadSchedule();
            loadNow();
          } catch (e) { msg("schedule-msg", e.message, "err"); }
        }));
        actions.appendChild(button("Remove", "btn-sm", async function () {
          if (!confirm("Remove this from the schedule?")) return;
          try {
            await api("DELETE", "/api/schedule/" + entry.id);
            await loadSchedule();
            loadNow();
          } catch (e) { msg("schedule-msg", e.message, "err"); }
        }));
        row.appendChild(actions);
      }
      box.appendChild(row);
    });
  }

  $("s-save").addEventListener("click", async function () {
    var mode = $("s-mode").value;
    var body = {
      playlistId: Number($("s-playlist").value),
      mode: mode,
      label: $("s-label").value.trim(),
      priority: Number($("s-priority").value) || 0
    };
    if (mode === "recurring") {
      body.days = chosenDays.slice().sort();
      body.startTime = $("s-start-time").value;
      body.endTime = $("s-end-time").value;
      body.effectiveFrom = $("s-from").value || null;
      body.effectiveTo = $("s-to").value || null;
    } else {
      body.startsAt = fromLocalInput($("s-start").value);
      body.endsAt = mode === "window" ? fromLocalInput($("s-end").value) : null;
    }

    busy("s-save", true);
    try {
      await api("POST", "/api/schedule", body);
      msg("schedule-msg", "Scheduled.", "ok");
      $("s-label").value = "";
      await loadSchedule();
      loadNow();
    } catch (e) {
      msg("schedule-msg", e.message, "err");
    } finally {
      busy("s-save", false);
    }
  });

  async function loadSchedule() {
    var data = await api("GET", "/api/schedule");
    scheduleEntries = data.entries || [];
    timezone = data.timezone || timezone;
    renderSchedule();
  }

  // ── playlists ────────────────────────────────────────────────────────────
  function renderPlaylists() {
    var box = $("playlist-list");
    box.innerHTML = "";
    if (!playlists.length) {
      box.className = "empty";
      box.textContent = "No playlists yet.";
      return;
    }
    box.className = "";

    playlists.forEach(function (pl) {
      var row = el("div", "row clickable" + (openPlaylist && openPlaylist.playlist.id === pl.id ? " selected" : ""));
      var main = el("div", "row-main");
      var title = el("div", "row-title");
      title.appendChild(document.createTextNode(pl.name));
      if (pl.isDefault) {
        var d = el("span", "pill pill-ok", "default");
        d.style.marginLeft = "8px";
        title.appendChild(d);
      }
      main.appendChild(title);
      main.appendChild(el("div", "row-sub",
        pl.itemCount + " item" + (pl.itemCount === 1 ? "" : "s") +
        (pl.shuffle ? " · shuffled" : "")));
      row.appendChild(main);
      row.addEventListener("click", function () { openEditor(pl.id); });
      box.appendChild(row);
    });
  }

  function fillPlaylistSelects() {
    var sel = $("s-playlist");
    var current = sel.value;
    sel.innerHTML = "";
    playlists.forEach(function (pl) {
      var o = el("option", null, pl.name);
      o.value = pl.id;
      sel.appendChild(o);
    });
    if (current) sel.value = current;

    var def = $("set-default-playlist");
    var currentDefault = defaultPlaylistId;
    def.innerHTML = "";
    var none = el("option", null, "Nothing — leave the screen idle");
    none.value = "";
    def.appendChild(none);
    playlists.forEach(function (pl) {
      var o = el("option", null, pl.name);
      o.value = pl.id;
      def.appendChild(o);
    });
    def.value = currentDefault ? String(currentDefault) : "";
  }

  async function loadPlaylists() {
    var data = await api("GET", "/api/playlists");
    playlists = data.playlists || [];
    renderPlaylists();
    fillPlaylistSelects();
  }

  $("pl-create").addEventListener("click", async function () {
    var name = $("pl-name").value.trim();
    if (!name) { msg("playlists-msg", "Give the playlist a name.", "err"); return; }
    busy("pl-create", true);
    try {
      var data = await api("POST", "/api/playlists", { name: name });
      $("pl-name").value = "";
      await loadPlaylists();
      openEditor(data.playlist.id);
      msg("playlists-msg", "Created.", "ok");
    } catch (e) {
      msg("playlists-msg", e.message, "err");
    } finally {
      busy("pl-create", false);
    }
  });

  async function openEditor(id) {
    try {
      var data = await api("GET", "/api/playlists/" + id);
      openPlaylist = { playlist: data.playlist, items: data.items || [] };
      picked = {};
      $("playlist-editor").hidden = false;
      $("pe-title").textContent = data.playlist.name;
      $("pe-image-seconds").value = data.playlist.imageSeconds || "";
      $("pe-slide-seconds").value = data.playlist.slideSeconds || "";
      $("pe-fit").value = data.playlist.fit || "";
      $("pe-transition").value = data.playlist.transition || "";
      $("pe-footer").value = data.playlist.footerText || "";
      $("pe-shuffle").checked = Boolean(data.playlist.shuffle);
      $("pe-picker").hidden = true;
      renderItems();
      renderPlaylists();
    } catch (e) {
      msg("playlists-msg", e.message, "err");
    }
  }

  var STATUS_TEXT = { pending: "converting…", processing: "converting…", failed: "failed" };

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
           "-" + String(d.getDate()).padStart(2, "0");
  }

  function daysBetween(a, b) {
    return Math.round((Date.parse(b + "T00:00:00") - Date.parse(a + "T00:00:00")) / 86400000);
  }

  // What the date window means TODAY, said the way somebody scanning the list
  // needs to hear it: not "show_until 2026-10-27" but "expires in 4 days".
  function windowNote(item) {
    var today = todayKey();
    if (item.showFrom && today < item.showFrom) {
      var until = daysBetween(today, item.showFrom);
      return { text: "starts in " + until + " day" + (until === 1 ? "" : "s"), kind: "pill-info" };
    }
    if (item.showUntil && today > item.showUntil) {
      return { text: "expired", kind: "pill-rejected" };
    }
    if (item.showUntil) {
      var left = daysBetween(today, item.showUntil);
      if (left === 0) return { text: "last day", kind: "pill-pending" };
      return {
        text: "expires in " + left + " day" + (left === 1 ? "" : "s"),
        kind: left <= 3 ? "pill-pending" : "pill-ok"
      };
    }
    return null;
  }

  function itemMeta(item) {
    var bits = [];
    if (item.kind === "deck") bits.push(item.pageCount + " slide" + (item.pageCount === 1 ? "" : "s"));
    else if (item.kind === "video") bits.push("video" + (item.durationMs ? " · " + fmtDuration(item.durationMs) : ""));
    else bits.push("photo");
    if (item.status !== "ready") bits.push(STATUS_TEXT[item.status] || item.status);
    return bits.join(" · ");
  }

  function renderItems() {
    var box = $("pe-items");
    box.innerHTML = "";
    var items = openPlaylist.items;
    if (!items.length) {
      box.className = "empty";
      box.textContent = "No items yet. Add some media below.";
      return;
    }
    box.className = "";

    items.forEach(function (item, i) {
      var note = windowNote(item);
      var offAir = Boolean(note && (note.text === "expired" || /^starts in/.test(note.text)));
      var row = el("div", "item-row" + (item.enabled && !offAir ? "" : " is-off"));

      var shot = el("div", "item-shot");
      var img = el("img");
      img.src = "/api/media/" + item.mediaId + "/poster";
      img.alt = "";
      img.addEventListener("error", function () { img.remove(); });
      shot.appendChild(img);
      row.appendChild(shot);

      var main = el("div", "item-main");
      var name = el("div", "item-name");
      name.appendChild(document.createTextNode(item.title));
      if (note) {
        var pill = el("span", "pill " + note.kind, note.text);
        pill.style.marginLeft = "8px";
        name.appendChild(pill);
      }
      main.appendChild(name);
      main.appendChild(el("div", "item-meta", itemMeta(item)));
      if (can("schedule")) main.appendChild(itemDates(item));
      row.appendChild(main);

      if (can("schedule")) {
        var secs = el("div", "item-secs field");
        secs.style.margin = "0";
        var input = el("input");
        input.type = "number";
        input.min = "0";
        input.max = "3600";
        input.value = item.seconds || "";
        input.title = item.kind === "video"
          ? "Seconds to play before moving on. Empty plays the whole clip."
          : "Seconds on screen. Empty uses the playlist or app default.";
        input.addEventListener("change", async function () {
          try {
            var data = await api("PATCH", "/api/playlists/" + openPlaylist.playlist.id + "/items/" + item.id,
              { seconds: Number(input.value) || 0 });
            openPlaylist.items = data.items;
            renderItems();
          } catch (e) { msg("pe-msg", e.message, "err"); }
        });
        secs.appendChild(input);
        row.appendChild(secs);

        var actions = el("div", "row-actions");
        actions.appendChild(button("↑", "btn-sm", function () { move(i, -1); }));
        actions.appendChild(button("↓", "btn-sm", function () { move(i, 1); }));
        actions.appendChild(button(item.enabled ? "Skip" : "Play", "btn-sm", async function () {
          try {
            var data = await api("PATCH", "/api/playlists/" + openPlaylist.playlist.id + "/items/" + item.id,
              { enabled: !item.enabled });
            openPlaylist.items = data.items;
            renderItems();
          } catch (e) { msg("pe-msg", e.message, "err"); }
        }));
        actions.appendChild(button("Remove", "btn-sm", async function () {
          try {
            var data = await api("DELETE", "/api/playlists/" + openPlaylist.playlist.id + "/items/" + item.id);
            openPlaylist.items = data.items;
            renderItems();
            loadPlaylists();
          } catch (e) { msg("pe-msg", e.message, "err"); }
        }));
        row.appendChild(actions);
      }
      box.appendChild(row);
    });
  }

  function itemDates(item) {
    var wrap = el("div", "item-dates");
    ["showFrom", "showUntil"].forEach(function (field) {
      var label = el("label", null, field === "showFrom" ? "from" : "until");
      var input = el("input");
      input.type = "date";
      input.value = item[field] || "";
      input.title = field === "showFrom"
        ? "Do not show this before this date. Leave empty to start immediately."
        : "Stop showing this after this date. Leave empty to run indefinitely.";
      input.addEventListener("change", async function () {
        var body = {};
        body[field] = input.value || null;
        try {
          var data = await api("PATCH",
            "/api/playlists/" + openPlaylist.playlist.id + "/items/" + item.id, body);
          openPlaylist.items = data.items;
          renderItems();
          loadNow();
        } catch (e) { msg("pe-msg", e.message, "err"); }
      });
      label.appendChild(input);
      wrap.appendChild(label);
    });
    return wrap;
  }

  async function move(index, delta) {
    var items = openPlaylist.items.slice();
    var target = index + delta;
    if (target < 0 || target >= items.length) return;
    var tmp = items[index];
    items[index] = items[target];
    items[target] = tmp;
    try {
      var data = await api("POST", "/api/playlists/" + openPlaylist.playlist.id + "/reorder",
        { itemIds: items.map(function (i) { return i.id; }) });
      openPlaylist.items = data.items;
      renderItems();
    } catch (e) { msg("pe-msg", e.message, "err"); }
  }

  $("pe-add").addEventListener("click", function () {
    var box = $("pe-picker");
    box.hidden = !box.hidden;
    if (!box.hidden) renderPicker();
  });

  function renderPicker() {
    var box = $("pe-picker");
    box.innerHTML = "";
    var ready = mediaList.filter(function (m) { return m.status === "ready"; });
    if (!ready.length) {
      box.appendChild(el("div", "empty", "Nothing in the library yet — upload some media first."));
      return;
    }
    var grid = el("div", "tiles");
    ready.forEach(function (m) {
      grid.appendChild(mediaTile(m, true));
    });
    box.appendChild(grid);

    var row = el("div", "btn-row");
    row.appendChild(button("Add the ticked items", "btn btn-primary", async function () {
      var ids = Object.keys(picked).filter(function (k) { return picked[k]; }).map(Number);
      if (!ids.length) { msg("pe-msg", "Tick something first.", "err"); return; }
      try {
        var data = await api("POST", "/api/playlists/" + openPlaylist.playlist.id + "/items", { mediaIds: ids });
        openPlaylist.items = data.items;
        picked = {};
        box.hidden = true;
        renderItems();
        loadPlaylists();
        msg("pe-msg", "Added.", "ok");
      } catch (e) { msg("pe-msg", e.message, "err"); }
    }));
    box.appendChild(row);
  }

  $("pe-save").addEventListener("click", async function () {
    busy("pe-save", true);
    try {
      await api("PATCH", "/api/playlists/" + openPlaylist.playlist.id, {
        imageSeconds: Number($("pe-image-seconds").value) || 0,
        slideSeconds: Number($("pe-slide-seconds").value) || 0,
        fit: $("pe-fit").value,
        transition: $("pe-transition").value,
        footerText: $("pe-footer").value,
        shuffle: $("pe-shuffle").checked
      });
      msg("pe-msg", "Saved.", "ok");
      await loadPlaylists();
      loadNow();
    } catch (e) {
      msg("pe-msg", e.message, "err");
    } finally {
      busy("pe-save", false);
    }
  });

  $("pe-delete").addEventListener("click", async function () {
    if (!confirm("Delete “" + openPlaylist.playlist.name + "”? The media itself is kept.")) return;
    try {
      await api("DELETE", "/api/playlists/" + openPlaylist.playlist.id);
      finishDelete();
    } catch (e) {
      if (/still scheduled/i.test(e.message)) {
        if (!confirm(e.message + " Delete it anyway?")) return;
        try {
          await api("DELETE", "/api/playlists/" + openPlaylist.playlist.id + "?force=1");
          finishDelete();
          return;
        } catch (e2) { msg("pe-msg", e2.message, "err"); return; }
      }
      msg("pe-msg", e.message, "err");
    }
  });

  async function finishDelete() {
    openPlaylist = null;
    $("playlist-editor").hidden = true;
    await loadPlaylists();
    await loadSchedule();
    loadNow();
  }

  // ── media ────────────────────────────────────────────────────────────────
  function mediaTile(m, selectable) {
    var tile = el("div", "tile" + (selectable && picked[m.id] ? " picked" : ""));

    var shot = el("div", "tile-shot");
    if (m.hasPoster) {
      var img = el("img");
      img.src = "/api/media/" + m.id + "/poster";
      img.alt = "";
      img.addEventListener("error", function () {
        shot.textContent = m.status === "ready" ? "No preview" : (STATUS_TEXT[m.status] || m.status);
      });
      shot.appendChild(img);
    } else {
      shot.textContent = STATUS_TEXT[m.status] || "No preview";
    }
    tile.appendChild(shot);

    var body = el("div", "tile-body");
    body.appendChild(el("div", "tile-name", m.title));
    var meta = [];
    if (m.kind === "deck") meta.push(m.pageCount + " slides");
    else if (m.kind === "video") meta.push("video" + (m.durationMs ? " " + fmtDuration(m.durationMs) : ""));
    else meta.push("photo");
    meta.push(fmtBytes(m.byteSize));
    body.appendChild(el("div", "tile-meta", meta.join(" · ")));
    if (m.status === "failed" && m.error) {
      var err = el("div", "tile-meta", m.error);
      err.style.color = "var(--rej-fg)";
      body.appendChild(err);
    }
    tile.appendChild(body);

    if (selectable) {
      tile.classList.add("clickable");
      tile.addEventListener("click", function () {
        picked[m.id] = !picked[m.id];
        tile.classList.toggle("picked", Boolean(picked[m.id]));
      });
      return tile;
    }

    if (can("upload")) {
      var actions = el("div", "tile-actions");
      actions.appendChild(button("Rename", "btn-sm", async function () {
        var title = prompt("Name this", m.title);
        if (title === null || !title.trim()) return;
        try {
          await api("PATCH", "/api/media/" + m.id, { title: title.trim() });
          await loadMedia();
        } catch (e) { msg("media-msg", e.message, "err"); }
      }));
      actions.appendChild(button("Delete", "btn-sm", function () { deleteMedia(m); }));
      tile.appendChild(actions);
    }
    return tile;
  }

  async function deleteMedia(m, force) {
    if (!force && !confirm("Delete “" + m.title + "”?")) return;
    try {
      await api("DELETE", "/api/media/" + m.id + (force ? "?force=1" : ""));
      await loadMedia();
      if (openPlaylist) openEditor(openPlaylist.playlist.id);
      loadPlaylists();
      loadNow();
    } catch (e) {
      if (!force && /still in/i.test(e.message)) {
        if (confirm(e.message + " Delete it anyway?")) return deleteMedia(m, true);
        return;
      }
      msg("media-msg", e.message, "err");
    }
  }

  function renderMedia() {
    var box = $("media-grid");
    box.innerHTML = "";
    if (!mediaList.length) {
      box.className = "empty";
      box.textContent = "Nothing uploaded yet.";
      return;
    }
    box.className = "";
    var grid = el("div", "tiles");
    mediaList.forEach(function (m) { grid.appendChild(mediaTile(m, false)); });
    box.appendChild(grid);
  }

  async function loadMedia() {
    var data = await api("GET", "/api/media");
    mediaList = data.media || [];
    renderMedia();
    // Anything still converting: look again shortly, so the grid settles on
    // its own rather than needing a refresh.
    if (mediaList.some(function (m) { return m.status === "pending" || m.status === "processing"; })) {
      clearTimeout(loadMedia.timer);
      loadMedia.timer = setTimeout(loadMedia, 4000);
    }
  }

  async function upload(files) {
    if (!files || !files.length) return;
    var form = new FormData();
    for (var i = 0; i < files.length; i++) form.append("file" + i, files[i]);

    msg("upload-progress", "Uploading " + files.length + " file" + (files.length === 1 ? "" : "s") + "…", "info");
    try {
      var res = await fetch("/api/media", { method: "POST", body: form, credentials: "same-origin" });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || data.ok === false) throw new Error(data.error || "That upload didn't work.");

      var note = (data.media || []).length + " uploaded. Converting now — they'll be playable in a moment.";
      if (data.rejected && data.rejected.length) {
        note += " Skipped: " + data.rejected.map(function (r) { return r.fileName; }).join(", ") + ".";
      }
      msg("upload-progress", note, "ok");
      await loadMedia();
    } catch (e) {
      msg("upload-progress", e.message, "err");
    }
  }

  // ── announcements ───────────────────────────────────────────────────────
  var notices = [];
  var editingNotice = null;

  function noticeFields() {
    return {
      headline: $("no-headline").value.trim(),
      body: $("no-body").value.trim(),
      footnote: $("no-footnote").value.trim(),
      theme: $("no-theme").value
    };
  }

  function resetNoticeForm() {
    editingNotice = null;
    $("no-headline").value = "";
    $("no-body").value = "";
    $("no-footnote").value = "";
    $("no-theme").value = "navy";
    $("no-save").setAttribute("data-default", "Make the slide");
    $("no-save").textContent = "Make the slide";
    $("no-cancel").hidden = true;
  }

  $("no-cancel").addEventListener("click", resetNoticeForm);

  $("no-save").addEventListener("click", async function () {
    var body = noticeFields();
    if (!body.headline && !body.body) {
      msg("notice-msg", "Give the notice something to say.", "err");
      return;
    }
    busy("no-save", true, "Drawing\u2026");
    try {
      if (editingNotice) await api("PATCH", "/api/notices/" + editingNotice, body);
      else await api("POST", "/api/notices", body);
      resetNoticeForm();
      msg("notice-msg", "Drawing the slide \u2014 it'll appear in the media library in a moment.", "ok");
      await loadNotices();
      await loadMedia();
    } catch (e) {
      msg("notice-msg", e.message, "err");
    } finally {
      busy("no-save", false);
    }
  });

  function renderNotices() {
    var box = $("notice-list");
    box.innerHTML = "";
    if (!notices.length) {
      box.className = "empty";
      box.textContent = "No announcements yet.";
      return;
    }
    box.className = "";
    notices.forEach(function (n) {
      var row = el("div", "notice-row");

      var shot = el("div", "notice-shot");
      if (n.mediaId && n.status === "ready") {
        var img = el("img");
        img.src = "/api/media/" + n.mediaId + "/poster";
        img.alt = "";
        img.addEventListener("error", function () { img.remove(); });
        shot.appendChild(img);
      }
      row.appendChild(shot);

      var main = el("div", "notice-main");
      main.appendChild(el("div", "notice-head", n.headline || n.body));
      var sub = n.status === "ready" ? n.theme
        : n.status === "failed" ? "failed: " + n.error
        : "drawing\u2026";
      main.appendChild(el("div", "notice-sub", sub + (n.createdBy ? " \u00b7 " + n.createdBy : "")));
      row.appendChild(main);

      var actions = el("div", "row-actions");
      actions.appendChild(button("Edit", "btn-sm", function () {
        editingNotice = n.id;
        $("no-headline").value = n.headline;
        $("no-body").value = n.body;
        $("no-footnote").value = n.footnote;
        $("no-theme").value = n.theme;
        $("no-save").setAttribute("data-default", "Save and redraw");
        $("no-save").textContent = "Save and redraw";
        $("no-cancel").hidden = false;
        $("no-headline").focus();
      }));
      actions.appendChild(button("Delete", "btn-sm", async function () {
        if (!confirm("Delete this announcement? It is removed from any playlist using it.")) return;
        try {
          await api("DELETE", "/api/notices/" + n.id);
          await loadNotices();
          await loadMedia();
          loadPlaylists();
        } catch (e) { msg("notice-msg", e.message, "err"); }
      }));
      row.appendChild(actions);
      box.appendChild(row);
    });
  }

  async function loadNotices() {
    if (!can("upload")) return;
    var data = await api("GET", "/api/notices");
    notices = data.notices || [];
    renderNotices();
    if (notices.some(function (n) { return n.status === "pending" || n.status === "processing"; })) {
      clearTimeout(loadNotices.timer);
      loadNotices.timer = setTimeout(function () { loadNotices(); loadMedia(); }, 3000);
    }
  }

  // ── import from Approvals ───────────────────────────────────────────────
  $("appr-open").addEventListener("click", async function () {
    var box = $("appr-list");
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = "";
    box.appendChild(el("div", "empty", "Asking the Approvals app\u2026"));
    try {
      var data = await api("GET", "/api/approvals");
      renderApprovals(data.images || []);
    } catch (e) {
      box.innerHTML = "";
      box.appendChild(el("div", "alert alert-err", e.message));
    }
  });

  function renderApprovals(images) {
    var box = $("appr-list");
    box.innerHTML = "";
    if (!images.length) {
      box.appendChild(el("div", "empty", "Nothing is approved in the Approvals app yet."));
      return;
    }
    images.forEach(function (img) {
      var row = el("div", "row");
      var main = el("div", "row-main");
      main.appendChild(el("div", "row-title", img.title));
      main.appendChild(el("div", "row-sub", "Version " + img.currentVersion + " \u00b7 approved"));
      row.appendChild(main);

      var actions = el("div", "row-actions");
      var add = button("Add to media", "btn-sm btn-sm-gold", async function () {
        add.disabled = true;
        add.textContent = "Adding\u2026";
        try {
          await api("POST", "/api/media/from-approval", { approvalId: img.id, title: img.title });
          add.textContent = "Added";
          await loadMedia();
        } catch (e) {
          add.disabled = false;
          add.textContent = "Add to media";
          msg("media-msg", e.message, "err");
        }
      });
      actions.appendChild(add);
      row.appendChild(actions);
      box.appendChild(row);
    });
  }

  $("pick").addEventListener("click", function () { $("file").click(); });
  $("file").addEventListener("change", function () {
    upload($("file").files);
    $("file").value = "";
  });

  var drop = $("drop");
  ["dragenter", "dragover"].forEach(function (name) {
    drop.addEventListener(name, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (name) {
    drop.addEventListener(name, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files) upload(e.dataTransfer.files);
  });

  // ── screens ──────────────────────────────────────────────────────────────
  function kioskUrl(screen) {
    return location.origin + "/player?t=" + encodeURIComponent(screen.token);
  }

  function renderScreens() {
    var box = $("screen-list");
    box.innerHTML = "";
    if (!screens.length) {
      box.className = "empty";
      box.textContent = "No screens yet.";
      return;
    }
    box.className = "";

    screens.forEach(function (screen) {
      var row = el("div", "row" + (screen.enabled ? "" : " is-off"));
      var main = el("div", "row-main");

      var title = el("div", "row-title");
      title.appendChild(document.createTextNode(screen.name));
      var seen = screen.lastSeenAt ? new Date(screen.lastSeenAt) : null;
      var live = seen && Date.now() - seen.getTime() < 5 * 60 * 1000;
      var pill = el("span", "pill " + (live ? "pill-ok" : "pill-pending"),
        live ? "checked in" : seen ? "last seen " + fmtWhen(screen.lastSeenAt) : "never seen");
      pill.style.marginLeft = "8px";
      title.appendChild(pill);
      main.appendChild(title);

      var sub = [];
      if (screen.rotation) sub.push("rotated " + screen.rotation + "°");
      if (screen.lastPlaying) sub.push("showing “" + screen.lastPlaying + "”");
      main.appendChild(el("div", "row-sub", sub.join(" · ") || "Landscape"));
      main.appendChild(el("div", "kiosk-url", kioskUrl(screen)));
      row.appendChild(main);

      var actions = el("div", "row-actions");
      actions.appendChild(button("Copy link", "btn-sm btn-sm-gold", function (e) {
        navigator.clipboard.writeText(kioskUrl(screen)).then(function () {
          var b = e.target;
          b.classList.add("copied");
          b.textContent = "Copied";
          setTimeout(function () { b.classList.remove("copied"); b.textContent = "Copy link"; }, 1500);
        });
      }));
      actions.appendChild(button("Open", "btn-sm", function () {
        window.open(kioskUrl(screen), "_blank", "noopener");
      }));
      actions.appendChild(button("New link", "btn-sm", async function () {
        if (!confirm("Reissue this screen's link? The TV will need the new one.")) return;
        try {
          await api("POST", "/api/screens/" + screen.id + "/rotate-token");
          await loadScreens();
        } catch (e2) { msg("screens-msg", e2.message, "err"); }
      }));
      actions.appendChild(button("Remove", "btn-sm", async function () {
        if (!confirm("Remove this screen?")) return;
        try {
          await api("DELETE", "/api/screens/" + screen.id);
          await loadScreens();
        } catch (e2) { msg("screens-msg", e2.message, "err"); }
      }));
      row.appendChild(actions);
      box.appendChild(row);
    });
  }

  $("sc-create").addEventListener("click", async function () {
    var name = $("sc-name").value.trim();
    if (!name) { msg("screens-msg", "Give the screen a name.", "err"); return; }
    busy("sc-create", true);
    try {
      await api("POST", "/api/screens", { name: name, rotation: Number($("sc-rotation").value) });
      $("sc-name").value = "";
      await loadScreens();
      msg("screens-msg", "Added. Open its link on the Mac that drives the TV.", "ok");
    } catch (e) {
      msg("screens-msg", e.message, "err");
    } finally {
      busy("sc-create", false);
    }
  });

  async function loadScreens() {
    if (!can("manage")) return;
    var data = await api("GET", "/api/screens");
    screens = data.screens || [];
    renderScreens();
    renderPreviewScreens();
  }

  // ── settings ─────────────────────────────────────────────────────────────
  function fillSettings() {
    if (!settings) return;
    $("set-timezone").value = settings.timezone;
    $("set-image-seconds").value = settings.imageSeconds;
    $("set-slide-seconds").value = settings.slideSeconds;
    $("set-fit").value = settings.fit;
    $("set-transition").value = settings.transition;
    $("set-transition-ms").value = settings.transitionMs;
    $("set-background").value = /^#[0-9a-f]{6}$/i.test(settings.background) ? settings.background : "#092d3e";
    $("set-clock").value = settings.clock;
    $("set-clock-position").value = settings.clockPosition;
    $("set-footer").value = settings.footerText;
    $("set-idle").value = settings.idleMessage;
    $("set-poll").value = settings.pollSeconds;
    $("set-loop").checked = settings.videoLoopSingle;
    $("set-default-playlist").value = defaultPlaylistId ? String(defaultPlaylistId) : "";
  }

  $("set-save").addEventListener("click", async function () {
    busy("set-save", true);
    try {
      var data = await api("PUT", "/api/settings", {
        timezone: $("set-timezone").value.trim(),
        imageSeconds: Number($("set-image-seconds").value),
        slideSeconds: Number($("set-slide-seconds").value),
        fit: $("set-fit").value,
        transition: $("set-transition").value,
        transitionMs: Number($("set-transition-ms").value),
        background: $("set-background").value,
        clock: $("set-clock").value,
        clockPosition: $("set-clock-position").value,
        footerText: $("set-footer").value,
        idleMessage: $("set-idle").value,
        pollSeconds: Number($("set-poll").value),
        videoLoopSingle: $("set-loop").checked,
        defaultPlaylistId: Number($("set-default-playlist").value) || 0
      });
      settings = data.settings;
      defaultPlaylistId = data.defaultPlaylistId;
      timezone = settings.timezone;
      fillSettings();
      msg("settings-msg", "Saved.", "ok");
      await loadPlaylists();
      loadNow();
    } catch (e) {
      msg("settings-msg", e.message, "err");
    } finally {
      busy("set-save", false);
    }
  });

  async function loadSettings() {
    var data = await api("GET", "/api/settings");
    settings = data.settings;
    defaultPlaylistId = data.defaultPlaylistId;
    timezone = settings.timezone;
    fillSettings();
  }

  // ── operating hours ──────────────────────────────────────────────────────
  var FULL_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function renderHours() {
    if (!hours) return;
    $("hours-mode").value = hours.mode;
    $("hours-box").hidden = hours.mode !== "scheduled";
    $("hours-tz").textContent = hours.timezone;

    var state = $("hours-state");
    state.innerHTML = "";
    if (hours.neverOn) {
      // Every row switched off is a decision we obey, so say out loud what it
      // means rather than letting someone find out on a Sunday morning.
      var warn = el("div", "alert alert-warn",
        "Every row below is switched off, so the screen will stay dark until one is " +
        "turned back on. Choose \u201cAlways on\u201d above if that isn't what you meant.");
      state.appendChild(warn);
    } else if (hours.mode === "scheduled" && hours.state) {
      var line = hours.state.on
        ? "The screen is on" + (hours.state.changesAt ? ", going dark " + fmtWhen(hours.state.changesAt) : "")
        : "The screen is dark" + (hours.state.changesAt ? ", coming on " + fmtWhen(hours.state.changesAt) : "");
      state.appendChild(el("div", "alert alert-info", line + "."));
    }

    var box = $("hours-list");
    box.innerHTML = "";
    if (!hours.windows.length) {
      box.className = "empty";
      box.textContent = "No hours set yet \u2014 with none, the screen stays on.";
      return;
    }
    box.className = "";

    hours.windows.forEach(function (win) {
      var row = el("div", "hours-row" + (win.enabled ? "" : " is-off"));
      row.appendChild(el("div", "hours-day", FULL_DAYS[win.day]));
      var span = win.startTime + " \u2013 " + win.endTime;
      if (win.endTime <= win.startTime) span += " (overnight)";
      row.appendChild(el("div", "hours-span", span));

      var actions = el("div", "row-actions");
      actions.appendChild(button(win.enabled ? "Turn off" : "Turn on", "btn-sm", async function () {
        try {
          await api("PATCH", "/api/hours/" + win.id, { enabled: !win.enabled });
          await loadHours();
          loadNow();
        } catch (e) { msg("settings-msg", e.message, "err"); }
      }));
      actions.appendChild(button("Remove", "btn-sm", async function () {
        try {
          await api("DELETE", "/api/hours/" + win.id);
          await loadHours();
          loadNow();
        } catch (e) { msg("settings-msg", e.message, "err"); }
      }));
      row.appendChild(actions);
      box.appendChild(row);
    });
  }

  $("hours-mode").addEventListener("change", async function () {
    try {
      await api("PUT", "/api/settings", { hoursMode: $("hours-mode").value });
      await loadHours();
      await loadSettings();
      loadNow();
    } catch (e) { msg("settings-msg", e.message, "err"); }
  });

  $("hr-add").addEventListener("click", async function () {
    busy("hr-add", true);
    try {
      await api("POST", "/api/hours", {
        day: Number($("hr-day").value),
        startTime: $("hr-from").value,
        endTime: $("hr-to").value
      });
      await loadHours();
      loadNow();
    } catch (e) {
      msg("settings-msg", e.message, "err");
    } finally {
      busy("hr-add", false);
    }
  });

  $("hr-seed").addEventListener("click", async function () {
    busy("hr-seed", true);
    try {
      await api("POST", "/api/hours/seed");
      await loadHours();
      loadNow();
    } catch (e) {
      msg("settings-msg", e.message, "err");
    } finally {
      busy("hr-seed", false);
    }
  });

  // ── the power hook ───────────────────────────────────────────────────────
  var POWER_KINDS = [
    ["none", "Nothing \u2014 just blank the screen"],
    ["http", "Send a web request"],
    ["wol", "Send a Wake-on-LAN packet"]
  ];

  function powerEditor(when) {
    var id = "power-" + when;
    var box = $(id);
    box.innerHTML = "";
    box.appendChild(el("div", "pe-head",
      when === "on" ? "When opening hours start" : "When opening hours end"));

    var parsed = { kind: "none" };
    try {
      var raw = when === "on" ? hours.onAction : hours.offAction;
      if (raw) parsed = JSON.parse(raw);
    } catch (e) { /* a hand-edited row; fall back to Nothing */ }

    var kindField = el("div", "field");
    kindField.appendChild(el("label", null, "Action"));
    var kind = el("select");
    kind.id = id + "-kind";
    POWER_KINDS.forEach(function (k) {
      var o = el("option", null, k[1]);
      o.value = k[0];
      kind.appendChild(o);
    });
    kind.value = parsed.kind || "none";
    kindField.appendChild(kind);
    box.appendChild(kindField);

    var httpBox = el("div");
    var row = el("div", "row2");
    row.appendChild(field(id + "-method", "Method", "text", parsed.method || "POST"));
    row.appendChild(field(id + "-url", "URL", "text", parsed.url || ""));
    httpBox.appendChild(row);
    httpBox.appendChild(field(id + "-headers", "Headers as JSON (optional)", "text",
      parsed.headers ? JSON.stringify(parsed.headers) : ""));
    httpBox.appendChild(field(id + "-body", "Body (optional)", "text", parsed.body || ""));
    box.appendChild(httpBox);

    var wolBox = el("div");
    var wolRow = el("div", "row2");
    wolRow.appendChild(field(id + "-mac", "TV's MAC address", "text", parsed.mac || ""));
    wolRow.appendChild(field(id + "-ip", "TV's IP (optional, but more reliable)", "text", parsed.ip || ""));
    wolBox.appendChild(wolRow);
    box.appendChild(wolBox);

    function sync() {
      httpBox.hidden = kind.value !== "http";
      wolBox.hidden = kind.value !== "wol";
    }
    kind.addEventListener("change", sync);
    sync();
  }

  function field(id, label, type, value) {
    var wrap = el("div", "field");
    var lab = el("label", null, label);
    lab.setAttribute("for", id);
    wrap.appendChild(lab);
    var input = el("input");
    input.type = type;
    input.id = id;
    input.value = value || "";
    wrap.appendChild(input);
    return wrap;
  }

  function readPowerEditor(when) {
    var id = "power-" + when;
    var kind = $(id + "-kind").value;
    if (kind === "none") return { kind: "none" };
    if (kind === "wol") {
      return { kind: "wol", mac: $(id + "-mac").value.trim(), ip: $(id + "-ip").value.trim() };
    }
    var headers = {};
    var raw = $(id + "-headers").value.trim();
    if (raw) {
      try { headers = JSON.parse(raw); }
      catch (e) { throw new Error("The " + when + " headers aren't valid JSON."); }
    }
    return {
      kind: "http",
      method: $(id + "-method").value.trim() || "POST",
      url: $(id + "-url").value.trim(),
      headers: headers,
      body: $(id + "-body").value
    };
  }

  function renderPowerEvents() {
    var box = $("power-events");
    box.innerHTML = "";
    if (!hours || !hours.events || !hours.events.length) return;
    var list = el("div", "events");
    hours.events.forEach(function (ev) {
      var line = el("div", ev.ok ? "" : "bad",
        fmtWhen(ev.firedAt) + " \u00b7 " + ev.action + " \u00b7 " + (ev.ok ? "sent" : "failed") +
        (ev.detail ? " \u00b7 " + ev.detail : ""));
      list.appendChild(line);
    });
    box.appendChild(list);
  }

  $("power-save").addEventListener("click", async function () {
    busy("power-save", true);
    try {
      var body = { onAction: readPowerEditor("on"), offAction: readPowerEditor("off") };
      await api("PUT", "/api/power", body);
      await loadHours();
      msg("settings-msg", "Power actions saved.", "ok");
    } catch (e) {
      msg("settings-msg", e.message, "err");
    } finally {
      busy("power-save", false);
    }
  });

  ["on", "off"].forEach(function (when) {
    $("power-test-" + when).addEventListener("click", async function () {
      busy("power-test-" + when, true, "Sending\u2026");
      try {
        var data = await api("POST", "/api/power/test/" + when);
        msg("settings-msg", "Sent: " + data.detail, "ok");
      } catch (e) {
        msg("settings-msg", e.message, "err");
      } finally {
        busy("power-test-" + when, false);
        await loadHours();
      }
    });
  });

  async function loadHours() {
    if (!can("admin")) return;
    var data = await api("GET", "/api/hours");
    hours = data;
    timezone = data.timezone || timezone;
    renderHours();
    powerEditor("on");
    powerEditor("off");
    renderPowerEvents();
  }

  // ── the idle screen ─────────────────────────────────────────────────────
  var idle = null;

  function fillIdle() {
    if (!idle) return;
    $("idle-headline").value = idle.headline || "";
    $("idle-message").value = idle.message || "";
    $("idle-theme").value = idle.theme || "navy";
    $("idle-mark").checked = Boolean(idle.showMark);

    var sel = $("idle-logo");
    sel.innerHTML = "";
    var none = el("option", null, "No logo");
    none.value = "0";
    sel.appendChild(none);
    mediaList
      .filter(function (m) { return m.kind === "image" && m.status === "ready"; })
      .forEach(function (m) {
        var o = el("option", null, m.title);
        o.value = m.id;
        sel.appendChild(o);
      });
    sel.value = String(idle.logoMediaId || 0);
    showIdlePreview();
  }

  // The rendered slide is served to screens only, so the preview borrows the
  // logo itself rather than pretending to be the finished picture.
  function showIdlePreview() {
    var wrap = $("idle-preview-wrap");
    if (!idle || !idle.logoMediaId) { wrap.hidden = true; return; }
    $("idle-preview").src = "/api/media/" + idle.logoMediaId + "/file";
    $("idle-preview").style.objectFit = "contain";
    $("idle-preview").style.background = "#092D3E";
    wrap.hidden = false;
  }

  $("idle-save").addEventListener("click", async function () {
    busy("idle-save", true);
    try {
      var data = await api("PUT", "/api/idle", {
        headline: $("idle-headline").value,
        message: $("idle-message").value,
        theme: $("idle-theme").value,
        logoMediaId: Number($("idle-logo").value) || 0,
        showMark: $("idle-mark").checked
      });
      idle = data.idle;
      fillIdle();
      msg("idle-msg", "Saved. The screen redraws it within a poll or two.", "ok");
      loadNow();
    } catch (e) {
      msg("idle-msg", e.message, "err");
    } finally {
      busy("idle-save", false);
    }
  });

  async function loadIdleSettings() {
    if (!can("admin")) return;
    idle = (await api("GET", "/api/idle")).idle;
    fillIdle();
  }

  // ── permissions ──────────────────────────────────────────────────────────
  var FLAGS = [
    ["canUpload", "Upload"],
    ["canSchedule", "Schedule"],
    ["canManage", "Manage"],
    ["isAdmin", "Admin"]
  ];

  function renderPermissions(users) {
    var box = $("perm-table");
    box.innerHTML = "";
    if (!users.length) {
      box.className = "empty";
      box.textContent = "Nobody has permissions yet.";
      return;
    }
    box.className = "";

    var table = el("table", "matrix");
    var head = el("tr");
    head.appendChild(el("th", null, "Who"));
    FLAGS.forEach(function (f) { head.appendChild(el("th", "mid", f[1])); });
    head.appendChild(el("th", "mid", ""));
    table.appendChild(head);

    users.forEach(function (u) {
      var tr = el("tr");
      var who = el("td", "who");
      who.appendChild(document.createTextNode(u.name || u.email));
      if (u.name) who.appendChild(el("small", null, u.email));
      tr.appendChild(who);

      FLAGS.forEach(function (f) {
        var td = el("td", "mid");
        var cb = el("input");
        cb.type = "checkbox";
        cb.checked = Boolean(u[f[0]]);
        cb.addEventListener("change", async function () {
          var patch = { email: u.email };
          patch[f[0]] = cb.checked;
          try {
            var data = await api("PUT", "/api/permissions", patch);
            renderPermissions(data.users);
          } catch (e) {
            cb.checked = !cb.checked;
            msg("settings-msg", e.message, "err");
          }
        });
        td.appendChild(cb);
        tr.appendChild(td);
      });

      var actions = el("td", "mid");
      actions.appendChild(button("Remove", "btn-sm", async function () {
        if (!confirm("Remove " + u.email + " from Narthex TV permissions?")) return;
        try {
          var data = await api("DELETE", "/api/permissions/" + encodeURIComponent(u.email));
          renderPermissions(data.users);
        } catch (e) { msg("settings-msg", e.message, "err"); }
      }));
      tr.appendChild(actions);
      table.appendChild(tr);
    });
    box.appendChild(table);
  }

  $("perm-add").addEventListener("click", async function () {
    var email = $("perm-email").value;
    if (!email) return;
    busy("perm-add", true);
    try {
      var person = people.find(function (p) { return p.email === email; });
      var data = await api("PUT", "/api/permissions", {
        email: email,
        name: person ? person.name : "",
        canUpload: true
      });
      renderPermissions(data.users);
      msg("settings-msg", "Added with upload rights. Tick more as needed.", "ok");
    } catch (e) {
      msg("settings-msg", e.message, "err");
    } finally {
      busy("perm-add", false);
    }
  });

  async function loadPermissions() {
    if (!can("admin")) return;
    var data = await api("GET", "/api/permissions");
    renderPermissions(data.users);
  }

  // The hub is the directory of who may open this app at all.
  async function loadPeople() {
    if (!can("admin")) return;
    try {
      var res = await fetch(HUB + "/api/users?app=narthex-tv", { credentials: "include" });
      var data = await res.json();
      people = (data && data.users) || [];
    } catch (e) {
      people = [];
    }
    var sel = $("perm-email");
    sel.innerHTML = "";
    if (!people.length) {
      var o = el("option", null, "Couldn't reach the hub directory");
      o.value = "";
      sel.appendChild(o);
      return;
    }
    people.forEach(function (p) {
      var opt = el("option", null, p.name ? p.name + " (" + p.email + ")" : p.email);
      opt.value = p.email;
      sel.appendChild(opt);
    });
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  async function start() {
    document.querySelectorAll("[data-default]").forEach(function (b) {
      if (!b.getAttribute("data-default")) b.setAttribute("data-default", b.textContent);
    });
    renderDayPicker();
    syncModeFields();
    FULL_DAYS.forEach(function (name, i) {
      var o = el("option", null, name);
      o.value = i;
      $("hr-day").appendChild(o);
    });
    $("power-hint").innerHTML =
      "Recipes: a <strong>Roku TV</strong> answers POST http://&lt;ip&gt;:8060/keypress/PowerOff " +
      "and /keypress/PowerOn with no authentication at all. A <strong>Samsung</strong> needs a " +
      "paired token for off and Wake-on-LAN for on, with Network Standby enabled \u2014 the " +
      "simplest route there is a smart plug or Home Assistant webhook. Anything that exposes " +
      "an HTTP endpoint on your network will work.";
    $("preview-at").value = toLocalInput(new Date());

    try {
      var identity = await api("GET", "/api/me");
      me = identity;
      $("me-label").textContent = identity.name || identity.email;
    } catch (e) {
      $("me-label").textContent = "";
    }
    applyPermissions();

    await Promise.all([
      loadSettings().catch(function (e) { msg("settings-msg", e.message, "err"); }),
      loadMedia().catch(function (e) { msg("media-msg", e.message, "err"); }),
    ]);
    await loadPlaylists().catch(function (e) { msg("playlists-msg", e.message, "err"); });
    await loadSchedule().catch(function (e) { msg("schedule-msg", e.message, "err"); });
    await loadScreens().catch(function (e) { msg("screens-msg", e.message, "err"); });
    await loadPermissions().catch(function () { /* not an admin */ });
    await loadHours().catch(function (e) { msg("settings-msg", e.message, "err"); });
    await loadNotices().catch(function (e) { msg("notice-msg", e.message, "err"); });
    await loadIdleSettings().catch(function (e) { msg("idle-msg", e.message, "err"); });
    await loadPeople();
    loadNow();

    // The "on now" card is a live answer, so it refreshes itself.
    setInterval(function () {
      if ($("p-now").classList.contains("active")) loadNow();
    }, 30000);
  }

  start();
})();
