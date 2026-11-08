// Grace Notes contributor page. Vanilla JS, no build step. The link's token is the only credential.
(function () {
  "use strict";

  var token = location.pathname.split("/")[2] || "";
  var base = "/gn/" + encodeURIComponent(token) + "/api";
  var app = document.getElementById("app");
  var view = null;
  var MAX_BYTES = 10000000;
  var PHOTO_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  var GENERIC = "Something went wrong. Try again in a minute.";
  var OFFLINE = "Couldn't reach the server. Check your connection and try again.";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // ---------- small helpers ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // h("div", {class: "x", onclick: fn}, child, "text", ...) builds nodes without ever parsing server text as HTML.
  function h(tag, attrs) {
    var el = document.createElement(tag);
    for (var k in attrs || {}) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { append(el, x); });
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
  function safeUrl(u) {
    u = String(u || "").trim();
    return /^(https?:\/\/|mailto:)/i.test(u) ? u : "";
  }
  // Plain calendar date, never through UTC.
  function parseDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function dayLabel(iso) {
    var d = parseDay(iso);
    return d ? DAYS[d.getDay()] + " " + MONTHS[d.getMonth()] + " " + d.getDate() : "";
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.className = "gn-toast show" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "gn-toast" + (isErr ? " err" : ""); }, isErr ? 7000 : 3500);
  }

  // Always resolves to {ok, ...}. Network failure, a non-JSON answer, a 404 or a 413 all become a plain sentence.
  function call(method, path, body, headers) {
    var opts = { method: method, headers: headers || {}, credentials: "same-origin" };
    if (body !== undefined) {
      if (body instanceof Blob) opts.body = body;
      else { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
    }
    return fetch(base + path, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
        if (data && typeof data === "object" && typeof data.ok === "boolean") {
          if (!data.ok && !data.error) data.error = GENERIC;
          return data;
        }
        if (res.status === 404) return { ok: false, error: "This link isn't active. Ask Mitchell for a new one." };
        if (res.status === 413) return { ok: false, error: "That picture is over 10 MB." };
        return { ok: false, error: GENERIC };
      });
    }, function () { return { ok: false, error: OFFLINE }; })
      .catch(function () { return { ok: false, error: GENERIC }; });
  }

  // Runs an action with the button disabled; shows the success message or the error.
  function busy(btn, fn, okMsg) {
    if (btn.disabled) return;
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = "Saving...";
    fn().then(function (r) {
      if (r && r.ok) {
        toast(okMsg || "Saved. Thank you!");
        return load(btn.closest(".gn-card"));
      }
      btn.disabled = false;
      btn.textContent = label;
      toast((r && r.error) || GENERIC, true);
    }, function () {
      btn.disabled = false;
      btn.textContent = label;
      toast(GENERIC, true);
    });
  }

  // ---------- rendering a piece as it reads in the email ----------
  function readOnly(p) {
    var box = h("div", { class: "gn-read" });
    var title = p.title || p.eventName || "";
    var empty = !title && !p.bodyHtml;
    if (empty) {
      box.appendChild(h("p", { class: "gn-empty" }, "Nothing here yet."));
      return box;
    }
    if (title) box.appendChild(h("h3", null, title));
    var d = p.details || {};
    var facts = [];
    var when = p.eventStartDate ? dayLabel(p.eventStartDate) : "";
    if (when) facts.push(["Date", when]);
    if (d.when) facts.push(["When", d.when]);
    if (d.place) facts.push(["Where", d.place]);
    if (d.cost) facts.push(["Cost", d.cost]);
    if (d.contact) facts.push(["Contact", d.contact]);
    if (facts.length || safeUrl(d.link)) {
      var f = h("p", { class: "gn-facts" });
      facts.forEach(function (x, i) {
        if (i) f.appendChild(h("br"));
        f.appendChild(h("b", null, x[0] + ": ")); f.appendChild(document.createTextNode(x[1]));
      });
      if (safeUrl(d.link)) {
        if (facts.length) f.appendChild(h("br"));
        f.appendChild(h("a", { href: safeUrl(d.link), target: "_blank", rel: "noopener" }, d.linkLabel || "More information"));
      }
      box.appendChild(f);
    }
    if (p.bodyHtml) {
      var body = h("div");
      body.innerHTML = p.bodyHtml; // sanitized on the server before it was saved
      box.appendChild(body);
    }
    var shownImg = p.imageUrl || p.eventImageUrl || "";
    if (/^https?:\/\//i.test(shownImg)) box.appendChild(h("img", { src: shownImg, alt: "" }));
    return box;
  }

  // ---------- the editor ----------
  function cleanPasted(html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    function walk(node) {
      var out = "";
      node.childNodes.forEach(function (n) {
        if (n.nodeType === 3) { out += esc(n.nodeValue); return; }
        if (n.nodeType !== 1) return;
        var tag = n.tagName.toLowerCase(), inner = walk(n), st = n.style || {};
        var bold = (tag === "b" || tag === "strong") ? st.fontWeight !== "normal" : parseInt(st.fontWeight, 10) >= 600 || st.fontWeight === "bold";
        var ital = tag === "i" || tag === "em" || st.fontStyle === "italic";
        if (tag === "script" || tag === "style" || tag === "head") return;
        if (tag === "br") out += "<br>";
        else if (tag === "a" && safeUrl(n.getAttribute("href"))) out += '<a href="' + esc(safeUrl(n.getAttribute("href"))) + '">' + inner + "</a>";
        else if (tag === "ul" || tag === "ol" || tag === "li") out += "<" + tag + ">" + inner + "</" + tag + ">";
        else if (tag === "p" || tag === "div" || /^h[1-6]$/.test(tag)) out += "<p>" + inner + "</p>";
        else {
          if (bold && inner) inner = "<b>" + inner + "</b>";
          if (ital && inner) inner = "<i>" + inner + "</i>";
          out += inner;
        }
      });
      return out;
    }
    return walk(doc.body);
  }

  function makeEditor(initialHtml) {
    var ed = h("div", { class: "gn-editor", contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": "Your words", "data-placeholder": "Write here..." });
    ed.innerHTML = initialHtml || ""; // sanitized on the server
    ed.addEventListener("paste", function (e) {
      var cd = e.clipboardData;
      if (!cd) return;
      e.preventDefault();
      var html = cd.getData("text/html");
      if (html) document.execCommand("insertHTML", false, cleanPasted(html));
      else document.execCommand("insertText", false, cd.getData("text/plain"));
    });
    function tool(label, title, run) {
      return h("button", {
        type: "button", title: title, "aria-label": title,
        onmousedown: function (e) { e.preventDefault(); },
        onclick: function () { ed.focus(); run(); },
      }, label);
    }
    var bar = h("div", { class: "gn-toolbar" },
      tool(h("b", null, "B"), "Bold", function () { document.execCommand("bold"); }),
      tool(h("i", null, "I"), "Italic", function () { document.execCommand("italic"); }),
      tool("Link", "Make a link", function () {
        var url = window.prompt("Paste the web address for this link:", "https://");
        if (!url) return;
        url = url.trim();
        if (!/^(https?:\/\/|mailto:)/i.test(url)) url = "https://" + url;
        document.execCommand("createLink", false, url);
      }),
      tool("List", "Bulleted list", function () { document.execCommand("insertUnorderedList"); }));
    return {
      node: h("div", null, bar, ed),
      html: function () {
        var t = ed.innerHTML.trim();
        return ed.textContent.trim() === "" && !ed.querySelector("a,li") ? "" : t;
      },
    };
  }

  function field(label, input) {
    var id = "f" + Math.random().toString(36).slice(2);
    input.id = id;
    return h("div", { class: "field" }, h("label", { for: id }, label), input);
  }
  function textInput(value, type) { var i = h("input", { type: type || "text", autocomplete: "off" }); i.value = value || ""; return i; }

  // kind "events" shows a date and the details fields; "text" is just words and a picture.
  function makeForm(p, kind, onSave, onCancel, saveLabel) {
    var isEvents = kind === "events";
    var d = p ? Object.assign({}, p.details || {}) : {};
    var title = textInput(p ? p.title || p.eventName || "" : "");
    var date = textInput(p && p.eventStartDate ? p.eventStartDate.slice(0, 10) : "", "date");
    var editor = makeEditor(p ? p.bodyHtml : "");
    var det = {};
    var imageUrl = p ? p.imageUrl || p.eventImageUrl || "" : "";
    var uploading = false, picChanged = false;
    var preview = h("div", { class: "gn-pic" });
    var picInput = h("input", { type: "file", accept: PHOTO_TYPES.join(","), id: "pic" + Math.random().toString(36).slice(2) });
    var picLabel = h("label", { class: "btn btn-secondary", for: picInput.id }, "Add a picture");

    function drawPic() {
      preview.textContent = "";
      if (/^https?:\/\//i.test(imageUrl)) {
        preview.appendChild(h("img", { src: imageUrl, alt: "Your picture" }));
        preview.appendChild(h("button", { type: "button", class: "btn btn-secondary", onclick: function () { imageUrl = ""; picChanged = true; drawPic(); } }, "Take the picture off"));
      }
      picLabel.textContent = imageUrl ? "Pick a different picture" : "Add a picture";
    }
    picInput.addEventListener("change", function () {
      var f = picInput.files && picInput.files[0];
      if (!f) return;
      if (PHOTO_TYPES.indexOf(f.type) < 0) { toast("Upload a photo (JPG, PNG, GIF or WebP).", true); picInput.value = ""; return; }
      if (f.size > MAX_BYTES) { toast("That picture is over 10 MB.", true); picInput.value = ""; return; }
      uploading = true; save.disabled = true;
      picLabel.textContent = "Uploading...";
      call("POST", "/image", f, { "Content-Type": f.type }).then(function (r) {
        picInput.value = "";
        uploading = false; save.disabled = false;
        if (r.ok && r.url) { imageUrl = r.url; picChanged = true; toast("Picture added."); } else toast(r.error || GENERIC, true);
        drawPic();
      });
    });
    drawPic();

    var parts = [field(isEvents ? "Name of the event or item" : "Heading (optional)", title)];
    if (isEvents) parts.push(field("Date", date));
    parts.push(h("div", { class: "field" }, h("label", null, "Your words"), editor.node));
    if (isEvents) {
      var more = h("details", { class: "gn-more" }, h("summary", null, "More details (optional)"));
      [["when", "Time"], ["place", "Place"], ["cost", "Cost"], ["contact", "Who to contact"], ["link", "Web link"], ["linkLabel", "Words for the link"]].forEach(function (x) {
        det[x[0]] = textInput(d[x[0]], x[0] === "link" ? "url" : "text");
        more.appendChild(field(x[1], det[x[0]]));
      });
      parts.push(more);
    }
    parts.push(h("div", { class: "field" }, h("label", null, "Picture"), preview, picLabel, picInput));

    var save = h("button", { type: "button", class: "btn btn-primary btn-grow" }, saveLabel || "Save");
    var cancel = h("button", { type: "button", class: "btn btn-secondary" }, "Cancel");
    save.addEventListener("click", function () {
      if (uploading) return;
      var payload = { title: title.value.trim(), bodyHtml: editor.html() };
      if (isEvents) {
        if (!p && !payload.title) { toast("Please give it a name first.", true); title.focus(); return; }
        if (date.value) payload.startDate = date.value;
        Object.keys(det).forEach(function (k) {
          var v = det[k].value.trim();
          if (v) d[k] = v; else delete d[k];
        });
        payload.details = d;
      }
      if (picChanged) payload.imageUrl = imageUrl; // untouched pictures are not sent back
      busy(save, function () { return onSave(payload); });
    });
    cancel.addEventListener("click", onCancel);
    parts.push(h("div", { class: "gn-actions" }, save, cancel));
    return h("div", { class: "gn-form" }, parts);
  }

  // ---------- cards ----------
  var CHIPS = {
    carried: ["Please check", ""], confirmed: ["Checked", "ok"], changed: ["Changed", "info"], "new": ["Added", "info"],
  };

  function pieceCard(p) {
    var card = h("section", { class: "gn-card", "data-pid": p.id });
    var chip, isEvents, empty;
    card._update = function (np) { p = np; show(); };
    function show() {
      chip = CHIPS[p.status] || CHIPS.carried;
      isEvents = p.sectionKind === "events";
      empty = !p.title && !p.bodyHtml && !p.eventName;
      card.textContent = "";
      card.appendChild(h("div", { class: "gn-kicker" }, p.sectionTitle, empty ? null : h("span", { class: "gn-chip " + chip[1] }, chip[0])));
      card.appendChild(readOnly(p));
      var acts = h("div", { class: "gn-actions" });
      if (!empty && p.status === "carried") {
        var ok = h("button", { type: "button", class: "btn btn-primary btn-grow" }, "Looks right");
        ok.addEventListener("click", function () { busy(ok, function () { return call("POST", "/pieces/" + encodeURIComponent(p.id) + "/confirm", {}); }); });
        acts.appendChild(ok);
      }
      var edit = h("button", { type: "button", class: "btn " + (empty ? "btn-primary" : "btn-secondary") + " btn-grow", onclick: editing }, empty ? "Write something" : "Change something");
      acts.appendChild(edit);
      if (isEvents) {
        var drop = h("button", { type: "button", class: "btn-link" }, "Drop it");
        drop.addEventListener("click", function () {
          if (!window.confirm("Take this out of this week's issue?")) return;
          busy(drop, function () { return call("POST", "/pieces/" + encodeURIComponent(p.id) + "/drop", {}); }, "Taken out. Thank you!");
        });
        acts.appendChild(drop);
      }
      card.appendChild(acts);
    }
    function editing() {
      card.textContent = "";
      card.appendChild(h("div", { class: "gn-kicker" }, p.sectionTitle));
      card.appendChild(makeForm(p, p.sectionKind, function (payload) {
        return call("POST", "/pieces/" + encodeURIComponent(p.id) + "/edit", payload);
      }, show, "Save"));
    }
    show();
    return card;
  }

  function addCard(sections) {
    var card = h("section", { class: "gn-card gn-add" });
    function show() {
      card.textContent = "";
      card.appendChild(h("button", { type: "button", class: "gn-addbtn", onclick: open }, "+ Add something new for this issue"));
    }
    function open() {
      card.textContent = "";
      card.appendChild(h("div", { class: "gn-kicker" }, "Something new"));
      var sel = null;
      if (sections.length > 1) {
        sel = h("select");
        sections.forEach(function (s) { sel.appendChild(h("option", { value: s.id }, s.title)); });
        card.appendChild(field("Where should it go?", sel));
      }
      card.appendChild(makeForm(null, "events", function (payload) {
        var sid = sel ? sel.value : sections[0].id;
        return call("POST", "/sections/" + encodeURIComponent(sid) + "/items", payload);
      }, show, "Add it"));
    }
    card._reset = show;
    show();
    return card;
  }

  function historyList(items) {
    var wrap = h("div");
    var shown = 5;
    function draw() {
      wrap.textContent = "";
      items.slice(0, shown).forEach(function (it) {
        var open = false;
        var body = null;
        var caret = h("span", { class: "gn-caret", "aria-hidden": "true" }, "+");
        var label = it.title || it.sectionTitle || "Piece";
        var btn = h("button", { type: "button", "aria-expanded": "false" },
          h("span", null, label, h("small", null, dayLabel(it.issueDate) + (it.sectionTitle && it.title ? " · " + it.sectionTitle : ""))), caret);
        var box = h("div", { class: "gn-hist" }, btn);
        btn.addEventListener("click", function () {
          open = !open;
          btn.setAttribute("aria-expanded", String(open));
          caret.textContent = open ? "-" : "+";
          if (open) {
            body = readOnly({ title: "", bodyHtml: it.bodyHtml, details: it.details, imageUrl: it.imageUrl, eventStartDate: "", eventName: "" });
            if (!it.bodyHtml && !it.title) body = h("div", { class: "gn-read" }, h("p", { class: "gn-empty" }, "Nothing was written."));
            box.appendChild(body);
          } else if (body) { box.removeChild(body); body = null; }
        });
        wrap.appendChild(box);
      });
      if (items.length > shown) {
        wrap.appendChild(h("button", { type: "button", class: "btn btn-secondary", style: "width:100%", onclick: function () { shown = items.length; draw(); } }, "Show more"));
      }
    }
    draw();
    return wrap;
  }

  // ---------- page ----------
  function render() {
    app.textContent = "";
    if (view.name) app.appendChild(h("p", { class: "gn-hello" }, "Hello, " + view.name));
    var issue = view.issue;
    if (issue) {
      app.appendChild(h("h1", null, "Please check your piece"));
      app.appendChild(h("p", { class: "gn-issue" }, "Next issue · " + dayLabel(issue.issueDate), h("span", null, " · please check by Tue noon")));
      if (!view.pieces.length) app.appendChild(h("div", { class: "gn-note" }, "You don't have anything in this issue yet. You can add something below."));
      view.pieces.forEach(function (p) { app.appendChild(pieceCard(p)); });
      var targets = view.sections.filter(function (s) { return s.kind === "events"; });
      if (targets.length) app.appendChild(addCard(targets));
    } else {
      app.appendChild(h("h1", null, "Grace Notes"));
      app.appendChild(h("div", { class: "gn-note" }, "There's no issue open right now. Come back to this page when you get the next reminder."));
    }
    if (view.history && view.history.length) {
      app.appendChild(h("h2", null, "Earlier issues"));
      app.appendChild(historyList(view.history));
    }
  }

  // After a save: if other cards still have an open form, update only what changed so no draft is lost.
  function patch(saved) {
    var cards = Array.prototype.slice.call(app.querySelectorAll("[data-pid]"));
    var addCardEl = app.querySelector(".gn-add");
    var seen = {};
    view.pieces.forEach(function (p) {
      seen[p.id] = true;
      var el = cards.filter(function (c) { return c.getAttribute("data-pid") === p.id; })[0];
      if (el) { if (el === saved || !el.querySelector(".gn-form")) el._update(p); }
      else if (addCardEl) app.insertBefore(pieceCard(p), addCardEl);
    });
    cards.forEach(function (c) {
      if (!seen[c.getAttribute("data-pid")] && (c === saved || !c.querySelector(".gn-form"))) c.parentNode.removeChild(c);
    });
    if (saved && saved === addCardEl && saved._reset) saved._reset();
  }

  function load(saved) {
    return call("GET", "/view").then(function (r) {
      if (!r.ok && view) { toast(r.error, true); return; }
      if (!r.ok) {
        app.textContent = "";
        app.appendChild(h("div", { class: "gn-note" }, r.error));
        return;
      }
      var others = Array.prototype.some.call(app.querySelectorAll(".gn-card"), function (c) { return c !== saved && c.querySelector(".gn-form"); });
      var first = !view;
      view = r;
      if (!first && others) patch(saved); else render();
    });
  }

  load();
})();
