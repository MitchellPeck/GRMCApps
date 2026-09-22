/*
 * The narthex TV client.
 *
 * It is deliberately dumb: the server has already decided what should be on
 * screen and flattened it into a list of pictures and videos, so all this does
 * is show them in order, ask again every few seconds, and never stop. Every
 * failure path ends in "keep playing what we have" rather than a black screen.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var params = new URLSearchParams(location.search);
  // The token normally arrives in the kiosk URL. It is also remembered, so a
  // reload that loses the query string (a typo'd bookmark, a restored tab)
  // still comes back up.
  var token = (params.get("t") || params.get("token") || "").trim();
  try {
    if (token) localStorage.setItem("narthex.token", token);
    else token = localStorage.getItem("narthex.token") || "";
  } catch (e) { /* private mode: the URL is then the only source */ }

  var stage = $("stage");
  var layers = [$("layer-a"), $("layer-b")];
  var front = 0;             // which layer is currently visible

  var plan = null;           // the plan we are playing
  var frames = [];
  var index = -1;
  var advanceTimer = null;
  var pollTimer = null;
  var pendingPlan = null;    // a newer plan, waiting for the current frame to end
  var offlineSince = 0;
  var startedAt = Date.now();
  var clearStamp = 0;      // invalidates a pending "wipe the old layer" timer
  var lastHeartbeat = 0;

  var DEFAULT_POLL_MS = 10000;
  var RELOAD_AFTER_MS = 24 * 60 * 60 * 1000;  // shed any browser leak once a day
  var HEARTBEAT_MS = 60000;

  // ── helpers ──────────────────────────────────────────────────────────────

  function apiUrl(path) {
    return path + (path.indexOf("?") === -1 ? "?" : "&") + "t=" + encodeURIComponent(token);
  }

  function clearAdvance() {
    if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; }
  }

  function setStatus(text) {
    var el = $("status");
    if (!text) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = text;
    el.hidden = false;
  }

  // ── plan fetching ────────────────────────────────────────────────────────

  async function fetchPlan() {
    if (!token) {
      showIdle("This screen isn't paired yet. Open Narthex TV → Screens and use the link for this display.");
      return;
    }
    try {
      var res = await fetch(apiUrl("/api/player/plan"), { cache: "no-store" });
      if (res.status === 401) {
        showIdle("This screen isn't paired. Its link may have been reissued — get a fresh one from Narthex TV → Screens.");
        offlineSince = 0;
        setStatus("");
        return;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      if (!data || !data.ok || !data.plan) throw new Error("bad plan");

      offlineSince = 0;
      setStatus("");
      applyPlan(data.plan);
      rememberPlan(data.plan);
    } catch (e) {
      // The screen keeps playing whatever it already has. We only say so once
      // the outage has lasted long enough to be worth a human noticing.
      if (!offlineSince) offlineSince = Date.now();
      if (Date.now() - offlineSince > 60000) {
        setStatus("Offline — showing the last schedule");
      }
      if (!plan) {
        var cached = recallPlan();
        if (cached) applyPlan(cached);
      }
    } finally {
      schedulePoll();
    }
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    var ms = plan && plan.display && plan.display.pollSeconds
      ? plan.display.pollSeconds * 1000
      : DEFAULT_POLL_MS;
    pollTimer = setTimeout(fetchPlan, ms);
  }

  // Keeping the last plan lets a screen that boots before the network is up
  // come back to something rather than to nothing. The media itself comes from
  // the browser's own HTTP cache.
  function rememberPlan(p) {
    try { localStorage.setItem("narthex.plan", JSON.stringify(p)); } catch (e) {}
  }
  function recallPlan() {
    try {
      var raw = localStorage.getItem("narthex.plan");
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function applyPlan(next) {
    if (plan && plan.revision === next.revision) { plan = next; return; }

    // A different schedule entry has taken the screen: that is a scheduled
    // moment, so it cuts in now rather than waiting out the current slide.
    // An edit to the same playlist waits for the boundary instead, so nobody
    // saving a caption makes the TV jump.
    // A single-frame plan is also applied at once: a still photo or a looping
    // video has no frame boundary to wait for, so waiting would mean never.
    var immediate =
      !plan || plan.sourceKey !== next.sourceKey || index < 0 || frames.length <= 1;
    if (immediate) {
      plan = next;
      frames = next.frames || [];
      applyDisplay(next.display);
      index = -1;
      pendingPlan = null;
      advance();
    } else {
      pendingPlan = next;
      applyDisplay(next.display);
    }
  }

  function applyDisplay(display) {
    if (!display) return;
    document.documentElement.style.setProperty("--bg", display.background || "#092D3E");
    document.documentElement.style.setProperty(
      "--transition-ms",
      (display.transition === "none" ? 0 : display.transitionMs || 0) + "ms"
    );
    stage.classList.toggle("no-transition", display.transition === "none");
    applyRotation(display.rotation || 0);

    var footer = $("footer");
    if (display.footerText) {
      footer.textContent = display.footerText;
      footer.hidden = false;
    } else {
      footer.hidden = true;
    }

    var clock = $("clock");
    clock.className = "chrome pos-" + (display.clockPosition || "bottom-right");
    clock.hidden = display.clock === "off" || !display.clock;
    $("clock-date").hidden = display.clock !== "time_date";
  }

  // A portrait TV is a landscape browser window turned on its side: rotate the
  // stage and swap its dimensions so the picture still fills the panel.
  function applyRotation(deg) {
    var w = window.innerWidth;
    var h = window.innerHeight;
    if (deg === 90 || deg === 270) {
      stage.style.width = h + "px";
      stage.style.height = w + "px";
      stage.style.left = (w - h) / 2 + "px";
      stage.style.top = (h - w) / 2 + "px";
    } else {
      stage.style.width = "";
      stage.style.height = "";
      stage.style.left = "";
      stage.style.top = "";
    }
    stage.style.transform = deg ? "rotate(" + deg + "deg)" : "";
  }

  // ── playback ─────────────────────────────────────────────────────────────

  function showIdle(text) {
    clearAdvance();
    frames = [];
    index = -1;
    layers.forEach(function (l) { l.classList.remove("visible"); l.innerHTML = ""; });
    $("idle-text").textContent = text || "";
    $("idle").hidden = false;
  }

  function hideIdle() { $("idle").hidden = true; }

  function advance() {
    clearAdvance();

    // A newer plan was waiting for this boundary.
    if (pendingPlan) {
      plan = pendingPlan;
      frames = plan.frames || [];
      pendingPlan = null;
      index = -1;
    }

    // Once a day, at a frame boundary, start clean. An unattended browser that
    // has been decoding video for months is the one thing here that drifts.
    if (Date.now() - startedAt > RELOAD_AFTER_MS) {
      location.reload();
      return;
    }

    if (!frames.length) {
      var message = (plan && plan.display && plan.display.idleMessage) || "";
      showIdle(message);
      return;
    }
    hideIdle();

    index = (index + 1) % frames.length;
    render(frames[index]);
    heartbeat();
  }

  function render(frame) {
    var back = layers[1 - front];
    back.innerHTML = "";
    // Anything queued to wipe this layer is now stale.
    back.dataset.stamp = String(++clearStamp);

    var el;
    if (frame.kind === "video") {
      el = document.createElement("video");
      // muted + playsinline are what let a video autoplay at all without a
      // click; the file itself also has no audio track (see convert.ts).
      el.muted = true;
      el.defaultMuted = true;
      el.playsInline = true;
      el.autoplay = true;
      el.preload = "auto";
      el.src = frame.url + urlToken(frame.url);

      var loopIt = frames.length === 1 && frame.ms === null &&
        plan && plan.display && plan.display.loopSingleVideo;
      if (loopIt) {
        el.loop = true;
      } else {
        // Whichever comes first wins: the clip ending, or the cap on it.
        // advance() cancels the other.
        el.addEventListener("ended", advance, { once: true });
      }
      // A clip that will not play must not freeze the loop.
      el.addEventListener("error", function () { setTimeout(advance, 500); }, { once: true });
      el.addEventListener("loadeddata", function () { swap(back); }, { once: true });
    } else {
      el = document.createElement("img");
      el.decoding = "async";
      el.src = frame.url + urlToken(frame.url);
      el.addEventListener("load", function () { swap(back); }, { once: true });
      el.addEventListener("error", function () { setTimeout(advance, 500); }, { once: true });
    }

    el.className = "fit-" + (frame.fit === "cover" ? "cover" : "contain");
    el.setAttribute("alt", "");
    back.appendChild(el);
    if (frame.kind === "video") {
      el.play().catch(function () { /* autoplay refused: the first frame still shows */ });
    }
    // Belt and braces: show it anyway if neither load nor error ever fires.
    setTimeout(function () { if (layers[front] !== back) swap(back); }, 4000);

    if (frame.ms !== null && frame.ms !== undefined) {
      advanceTimer = setTimeout(advance, Math.max(500, frame.ms));
    }
    preloadNext();
  }

  function urlToken(url) {
    return (url.indexOf("?") === -1 ? "?" : "&") + "t=" + encodeURIComponent(token);
  }

  function swap(back) {
    if (layers[front] === back) return;   // already the visible layer
    var frontEl = layers[front];
    var stamp = String(++clearStamp);
    frontEl.dataset.stamp = stamp;

    back.classList.add("visible");
    frontEl.classList.remove("visible");
    front = 1 - front;

    // Free the old element only after the crossfade, and only if nothing has
    // been rendered into that layer since — the stamp is what tells us.
    setTimeout(function () {
      if (frontEl.dataset.stamp !== stamp) return;
      frontEl.innerHTML = "";
    }, 1200);
  }

  // Warms the browser cache for whatever comes next so a crossfade never waits
  // on the network.
  function preloadNext() {
    if (frames.length < 2) return;
    var next = frames[(index + 1) % frames.length];
    if (!next || next.kind !== "image") return;
    var img = new Image();
    img.src = next.url + urlToken(next.url);
  }

  // ── chrome ───────────────────────────────────────────────────────────────

  function tickClock() {
    var now = new Date();
    $("clock-time").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    $("clock-date").textContent = now.toLocaleDateString([], {
      weekday: "long", month: "long", day: "numeric",
    });
  }

  function heartbeat() {
    if (!token || Date.now() - lastHeartbeat < HEARTBEAT_MS) return;
    lastHeartbeat = Date.now();
    var playing = plan ? (plan.playlistName || "") : "";
    fetch(apiUrl("/api/player/heartbeat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: plan ? plan.revision : "", playing: playing }),
    }).catch(function () { /* the screen does not care whether this lands */ });
  }

  // Chrome will happily blank a kiosk display on the OS's schedule. Asking for
  // a wake lock is best-effort; it is not a substitute for turning sleep off on
  // the Mac, which the setup notes also cover.
  async function keepAwake() {
    try {
      if (!("wakeLock" in navigator)) return;
      await navigator.wakeLock.request("screen");
    } catch (e) { /* denied or unsupported */ }
  }

  // ── boot ─────────────────────────────────────────────────────────────────

  window.addEventListener("resize", function () {
    if (plan && plan.display) applyRotation(plan.display.rotation || 0);
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      keepAwake();
      fetchPlan();
    }
  });

  // A network that comes back should not wait out the poll interval.
  window.addEventListener("online", fetchPlan);

  tickClock();
  setInterval(tickClock, 1000);
  keepAwake();
  setInterval(keepAwake, 10 * 60 * 1000);
  fetchPlan();
})();
