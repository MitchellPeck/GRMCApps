(function () {
  "use strict";

  // ── state ────────────────────────────────────────────────────────────────
  var me = { email: "", name: "", permissions: {} };
  var queued = [];        // {key, file}
  var items = [];         // {id, title, price, autoType?}
  var codeTree = [];
  var cards = [];
  var approvers = [];
  var people = [];        // GRMCApps users granted this app
  var settings = {};
  var orgName = "Grace Resurrection Methodist Church";
  var detailId = null;

  var $ = function (id) { return document.getElementById(id); };
  var HUB = "https://hub." + location.hostname.split(".").slice(1).join(".");

  // ── helpers ──────────────────────────────────────────────────────────────
  // `keep` holds an "ok" message on screen instead of fading it after 3s —
  // for confirmations the user has to read, not just glimpse.
  function msg(el, text, kind, keep) {
    var box = $(el);
    if (!box) return null;
    if (!text) { box.innerHTML = ""; return null; }
    var d = document.createElement("div");
    d.className = "alert alert-" + (kind || "info");
    d.setAttribute("role", kind === "err" ? "alert" : "status");
    d.textContent = text;
    box.innerHTML = "";
    box.appendChild(d);
    if (kind === "ok" && !keep) setTimeout(function () { if (box.firstChild === d) box.innerHTML = ""; }, 3000);
    return d;
  }

  // A message with one button in it, e.g. "Reload" after a stale save.
  function msgAction(el, text, kind, label, fn) {
    var d = msg(el, text, kind, true);
    if (!d) return;
    var b = el_("button", "btn", label);
    b.style.marginLeft = "10px";
    b.addEventListener("click", fn);
    d.appendChild(b);
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
    if (!res.ok || data.ok === false) {
      // The body rides along so callers can read flags such as `stale`.
      var err = new Error(data.error || "That didn't work. Try again.");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function fmtAmount(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    return (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
  }

  var MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];

  // Split the ISO string rather than going through Date: new Date("2026-09-17")
  // parses as UTC midnight and renders as the 16th west of Greenwich.
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "").trim());
    if (!m) return "—";
    return MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + ", " + Number(m[1]);
  }

  function fmtWhen(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    return isNaN(d.getTime()) ? "" : d.toLocaleString();
  }

  function displayCode(code) {
    var v = String(code || "").trim();
    if (!v) return "—";
    for (var i = 0; i < codeTree.length; i++) {
      if (codeTree[i].code === v) return v + " — " + codeTree[i].label;
      for (var j = 0; j < codeTree[i].subs.length; j++) {
        if (codeTree[i].subs[j].code === v) return v + " — " + codeTree[i].subs[j].label;
      }
    }
    return v;
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
           String(d.getDate()).padStart(2, "0");
  }

  function newId() { return "it_" + Math.random().toString(36).slice(2, 9); }
  function can(p) { return !!me.permissions[p]; }

  function stageClass(stage) {
    if (stage === "Withdrawn" || stage === "Voided") return "st-void";
    if (stage === "Rejected") return "st-rej";
    if (stage === "Complete") return "st-ok";
    if (stage === "Changes requested") return "st-warn";
    return "st-pend";
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  var el_ = el;   // msg() takes a parameter named `el`

  // Options are built as nodes, never HTML strings: code labels, card
  // nicknames and people's names are typed by users and would otherwise be
  // parsed as markup. `rows` is [[value, text], …]; `blank` adds a first
  // empty-valued option with that text.
  function setOptions(target, rows, blank) {
    target.textContent = "";
    if (blank !== undefined) target.appendChild(new Option(blank, ""));
    rows.forEach(function (r) { target.appendChild(new Option(r[1], String(r[0]))); });
  }

  // Sets a select's value only when that option exists, otherwise the blank.
  function selectValue(sel, value) {
    sel.value = value || "";
    if (sel.value !== (value || "")) sel.value = "";
  }

  // On a 409 the server says the request moved on since this page loaded;
  // anything sent now would act on numbers the user hasn't seen.
  function showActionError(box, err, id) {
    if (err.data && err.data.stale) {
      msgAction(box, err.message, "warn", "Reload", function () { openDetail(id); });
    } else {
      msg(box, err.message, "err");
    }
  }

  // ── tabs ─────────────────────────────────────────────────────────────────
  function showTab(name) {
    document.querySelectorAll(".tab").forEach(function (x) {
      x.classList.toggle("active", x.getAttribute("data-tab") === name);
    });
    document.querySelectorAll(".panel").forEach(function (x) { x.classList.remove("active"); });
    var panel = $("p-" + name);
    if (panel) panel.classList.add("active");
  }

  // #/r/<id> is a link to one request — what notification emails point at.
  // Leaving the request clears it, so a reload lands where the user now is.
  function clearLink() {
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }
  function linkedId() {
    var m = /^#\/r\/(\d+)$/.exec(location.hash);
    return m ? Number(m[1]) : null;
  }
  window.addEventListener("hashchange", function () {
    var id = linkedId();
    if (id) openDetail(id);
  });

  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      var name = t.getAttribute("data-tab");
      clearLink();
      showTab(name);
      if (name === "history") loadHistory();
      if (name === "queue") loadQueue();
      if (name === "settings") loadSettingsTab();
    });
  });

  $("btn-back").addEventListener("click", function () { clearLink(); showTab("history"); loadHistory(); });

  // ── kind / payment drive the form ────────────────────────────────────────
  function required() {
    var kind = $("f_kind").value;
    var payment = $("f_payment").value;
    return {
      card: payment === "church_card",
      receipts: kind === "post_purchase",
      estimate: kind === "pre_purchase"
    };
  }

  function applyKindPayment() {
    var need = required();
    $("card-field").hidden = !need.card;
    $("estimate-field").hidden = !need.estimate;
    $("amount-field").hidden = need.estimate;
    $("import-card").hidden = !need.receipts;

    var kind = $("f_kind").value;
    var payment = $("f_payment").value;
    var parts = [];
    parts.push(kind === "pre_purchase"
      ? "Approval is requested before buying; receipts are added afterwards."
      : "The purchase has already happened; attach the receipts.");
    parts.push(payment === "reimbursement"
      ? "Your own money — you'll be marked reimbursed once paid back."
      : "Charged to a church card, so nothing is owed back to you.");
    $("kind-hint").textContent = parts.join(" ");
    $("btn-save").setAttribute("data-default",
      kind === "pre_purchase" ? "Request approval" : "Submit for approval");
    $("btn-save").textContent = $("btn-save").getAttribute("data-default");
  }

  $("f_kind").addEventListener("change", function () { applyKindPayment(); loadCards(); });
  $("f_payment").addEventListener("change", applyKindPayment);

  // ── upload queue ─────────────────────────────────────────────────────────
  // No `capture` attribute: with accept="application/pdf,image/*" phones offer
  // their own camera / photo library / files sheet, desktops a file picker.
  $("f-receipts").addEventListener("change", async function (ev) {
    var files = Array.from(ev.target.files || []);
    ev.target.value = "";
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var key = f.name + "::" + f.size;
      if (queued.some(function (q) { return q.key === key; })) continue;
      queued.push({ key: key, file: await shrinkImage(f) });
    }
    renderQueue();
  });

  // Phone photos are 3–10 MB and often HEIC. The model takes images up to
  // 5 MB in JPEG/PNG/WebP/GIF, so re-encode anything the browser can decode
  // as a JPEG capped at 2400px on the long edge — plenty for receipt text.
  // If the browser can't decode it (HEIC on desktop Chrome), send it as is.
  var MAX_EDGE = 2400;
  async function shrinkImage(file) {
    if (!/^image\//.test(file.type) || file.type === "image/gif") return file;
    try {
      var bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      var scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 4 * 1024 * 1024 && /jpeg|png|webp/.test(file.type)) {
        bmp.close();
        return file;
      }
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      var blob = await new Promise(function (res) { canvas.toBlob(res, "image/jpeg", 0.85); });
      if (!blob) return file;
      var name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
      return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
    } catch (e) {
      return file;
    }
  }

  function renderQueue() {
    var wrap = $("file-queue");
    if (!queued.length) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = "";
    var box = el("div", "fq");
    queued.forEach(function (q) {
      var row = el("div", "fq-row");
      row.appendChild(el("span", "fq-name", q.file.name));
      row.appendChild(el("span", "fq-size", (q.file.size / 1024).toFixed(0) + " KB"));
      var x = el("button", "fq-x", "×");
      x.title = "Remove";
      x.addEventListener("click", function () {
        queued = queued.filter(function (i) { return i.key !== q.key; });
        renderQueue();
      });
      row.appendChild(x);
      box.appendChild(row);
    });
    wrap.appendChild(box);
  }

  // ── extraction ───────────────────────────────────────────────────────────
  $("btn-extract").addEventListener("click", async function () {
    if (!queued.length) { msg("import-msg", "Add at least one receipt first.", "warn"); return; }
    busy("btn-extract", true, "Reading " + queued.length + " file" + (queued.length > 1 ? "s" : "") + "…");
    msg("import-msg", "");
    try {
      var fd = new FormData();
      queued.forEach(function (q) { fd.append("files", q.file, q.file.name); });
      var res = await fetch("/api/extract", { method: "POST", body: fd, credentials: "same-origin" });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || data.ok === false) throw new Error(data.error || "Extraction failed.");

      items = (data.items || []).map(function (i) {
        return { id: newId(), title: i.title, price: Number(i.price) || 0, autoType: i.autoType || null };
      });
      renderItems();
      if (data.vendor) $("f_vendor").value = data.vendor;
      if (data.reason) $("f_reason").value = data.reason;
      if (data.chargeCode) {
        $("f_chargeCode").value = data.chargeCode;
        onChargeCodeChange();
        if (data.subChargeCode) $("f_subChargeCode").value = data.subChargeCode;
      }

      var real = items.filter(function (i) { return !i.autoType; }).length;
      var note = "Extracted " + real + " item" + (real === 1 ? "" : "s") + " from " +
                 data.documentCount + " document" + (data.documentCount === 1 ? "" : "s") + ".";
      if (data.failed && data.failed.length) note += " Could not read: " + data.failed.join(", ") + ".";
      msg("import-msg", note + " Review below.", (data.failed && data.failed.length) ? "warn" : "ok");
    } catch (err) {
      msg("import-msg", err.message, "err");
    } finally {
      busy("btn-extract", false);
    }
  });

  // ── items ────────────────────────────────────────────────────────────────
  $("btn-add-item").addEventListener("click", function () {
    items.push({ id: newId(), title: "", price: 0, autoType: null });
    renderItems();
  });

  function itemsTotal() {
    return items.reduce(function (s, i) { return s + (parseFloat(i.price) || 0); }, 0);
  }

  // With line items on the form the amount is their total, never typed — so
  // the two cannot disagree on the record. With none it is typed by hand.
  function syncAmount() {
    var locked = items.length > 0;
    $("f_amount").readOnly = locked;
    if (locked) $("f_amount").value = itemsTotal().toFixed(2);
    $("amount-hint").hidden = !locked;
  }

  function renderItems() {
    var wrap = $("items-wrap");
    syncAmount();
    if (!items.length) {
      wrap.innerHTML = '<div class="empty">No items yet — add receipts and extract, or add an item manually.</div>';
      return;
    }
    wrap.innerHTML = "";
    var table = el("table", "items");
    table.innerHTML = "<thead><tr><th>Item</th><th>Price</th><th></th></tr></thead>";
    var tbody = el("tbody");
    items.forEach(function (it) {
      var tr = el("tr", it.autoType ? "auto" : "");
      var td1 = el("td", "t-title");
      var ti = el("input"); ti.type = "text"; ti.value = it.title;
      ti.addEventListener("input", function () { it.title = ti.value; });
      td1.appendChild(ti);

      var td2 = el("td", "num");
      var pi = el("input"); pi.type = "number"; pi.step = "0.01"; pi.value = it.price;
      pi.addEventListener("input", function () {
        it.price = parseFloat(pi.value) || 0;
        $("items-total").textContent = fmtAmount(itemsTotal());
        syncAmount();
      });
      td2.appendChild(pi);

      var td3 = el("td", "act");
      var x = el("button", "fq-x", "×");
      x.addEventListener("click", function () {
        items = items.filter(function (i) { return i.id !== it.id; });
        renderItems();
      });
      td3.appendChild(x);

      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    var foot = el("div", "items-foot");
    var tot = el("div", "items-total");
    tot.appendChild(document.createTextNode("Total: "));
    var strong = el("strong", "", fmtAmount(itemsTotal()));
    strong.id = "items-total";
    tot.appendChild(strong);
    foot.appendChild(tot);
    wrap.appendChild(foot);
  }

  // ── charge codes ─────────────────────────────────────────────────────────
  function buildChargeDatalist() {
    setOptions($("chargeCodeList"), codeTree.map(function (c) { return [c.code, c.code + " — " + c.label]; }));
    onChargeCodeChange();
  }

  function onChargeCodeChange() {
    var value = $("f_chargeCode").value.trim();
    var parent = codeTree.find(function (c) { return c.code === value; });
    var subs = parent ? parent.subs : [];
    $("sub-field").style.display = subs.length ? "" : "none";
    if (!subs.length) { $("f_subChargeCode").value = ""; return; }
    setOptions($("subChargeCodeList"), subs.map(function (s) { return [s.code, s.code + " — " + s.label]; }));
  }
  $("f_chargeCode").addEventListener("input", onChargeCodeChange);

  // ── cards & people ───────────────────────────────────────────────────────
  async function loadCards() {
    // Submitting on someone's behalf lists THEIR cards, not the submitter's.
    var subject = can("submitForOthers") ? findEmailByName($("f_purchasedBy").value) : "";
    var url = "/api/cards" + (subject ? "?for=" + encodeURIComponent(subject) : "");
    try {
      var data = await api("GET", url);
      cards = data.cards || [];
    } catch (e) { cards = []; }
    var sel = $("f_card");
    var keep = sel.value;
    setOptions(sel, cards.map(function (c) { return [c.id, c.nickname + " ••" + c.last4]; }),
               "— choose a card —");
    selectValue(sel, keep);
    $("card-hint").textContent = cards.length ? "" :
      (subject && subject.toLowerCase() !== me.email.toLowerCase()
        ? "They are not listed on any card." : "You are not listed on any card.");
  }

  function findEmailByName(name) {
    var n = String(name || "").trim().toLowerCase();
    // People without a name are listed (and so picked) by their email.
    var hit = people.find(function (p) {
      return (p.name || "").trim().toLowerCase() === n || String(p.email || "").toLowerCase() === n;
    });
    return hit ? hit.email : "";
  }

  async function loadPeople() {
    try {
      var res = await fetch(HUB + "/api/users?app=expenses", { credentials: "include" });
      var data = await res.json();
      people = data.users || [];
    } catch (e) { people = []; }
    setOptions($("peopleList"), people.map(function (p) { return [p.name || p.email, p.email]; }));
    if ($("c-primary")) setOptions($("c-primary"), peopleRows(), "— choose —");
  }

  function peopleRows() {
    return people.map(function (p) { return [p.email, p.name || p.email]; });
  }

  async function loadApprovers() {
    try {
      var data = await api("GET", "/api/approvers");
      approvers = data.approvers || [];
    } catch (e) { approvers = []; }
    renderApproverOptions();
  }

  // Nobody approves their own spending: not the person keying it in, and not
  // the person who bought it when that is someone else. The server refuses
  // both; leaving them out of the list stops the choice being offered.
  function renderApproverOptions() {
    var sel = $("f_approver");
    var keep = sel.value || me.permissions.defaultApprover || "";
    var out = {};
    if (!settings.allowSelfApproval) {
      out[String(me.email || "").toLowerCase()] = true;
      var buyer = findEmailByName($("f_purchasedBy").value);
      if (buyer) out[buyer.toLowerCase()] = true;
    }
    setOptions(sel, approvers
      .filter(function (a) { return !out[String(a.email).toLowerCase()]; })
      .map(function (a) { return [a.email, a.name || a.email]; }),
      "— choose an approver —");
    selectValue(sel, keep);
  }

  // The purchaser decides whose cards are listed and who may approve.
  $("f_purchasedBy").addEventListener("change", function () {
    renderApproverOptions();
    loadCards();
  });

  // ── submit ───────────────────────────────────────────────────────────────
  $("btn-save").addEventListener("click", async function () {
    busy("btn-save", true, "Submitting…");
    try {
      var need = required();
      var body = {
        kind: $("f_kind").value,
        paymentMethod: $("f_payment").value,
        requestDate: $("f_date").value,
        amount: need.estimate ? 0 : parseFloat($("f_amount").value) || 0,
        estimatedAmount: need.estimate ? parseFloat($("f_estimate").value) || 0 : null,
        reason: $("f_reason").value,
        vendor: $("f_vendor").value,
        chargeCode: $("f_chargeCode").value,
        subChargeCode: $("f_subChargeCode").value,
        cardId: need.card ? ($("f_card").value || null) : null,
        card: need.card ? ($("f_card").selectedOptions[0] || {}).text || "" : "",
        purchasedBy: $("f_purchasedBy").value,
        purchasedByEmail: findEmailByName($("f_purchasedBy").value),
        submittedBy: $("f_submittedBy").value,
        approverEmail: $("f_approver").value,
        approvedBy: ($("f_approver").selectedOptions[0] || {}).text || "",
        items: items.map(function (i) {
          return { title: i.title, price: i.price, autoType: i.autoType };
        })
      };
      var saved = await api("POST", "/api/requests", body);
      var approverName = body.approvedBy || "the approver";

      // Receipts attach after the request exists — the same endpoint the
      // pre-purchase completion flow uses days later. The request is saved
      // either way, so a failed upload must not read as success.
      var files = queued.map(function (q) { return q.file; });
      var up = files.length ? await uploadReceipts(saved.id, files) : { failed: [] };

      resetForm();
      loadQueue();
      await openDetail(saved.id);
      if (up.failed.length) {
        var failedFiles = files.filter(function (f) { return up.failed.indexOf(f.name) !== -1; });
        msgAction("receipts-msg",
          "Your request was saved, but these receipts didn't upload: " + up.failed.join(", ") +
          ". Add them below." + (up.error ? " (" + up.error + ")" : ""),
          "warn", "Try again",
          function () { addReceipts(saved.id, failedFiles.length ? failedFiles : files); });
      } else {
        msg("detail-note", "Sent to " + approverName + ". You'll see their decision here.", "ok", true);
      }
    } catch (err) {
      msg("form-msg", err.message, "err");
    } finally {
      busy("btn-save", false);
    }
  });

  $("btn-clear").addEventListener("click", resetForm);

  function resetForm() {
    items = []; queued = [];
    renderItems(); renderQueue();
    ["f_amount", "f_estimate", "f_reason", "f_vendor", "f_chargeCode", "f_subChargeCode"]
      .forEach(function (id) { $(id).value = ""; });
    $("f_date").value = todayISO();
    applyDefaults();
    onChargeCodeChange();
    msg("import-msg", "");
  }

  function applyDefaults() {
    var locked = !can("submitForOthers");
    $("f_purchasedBy").value = locked ? me.name : (settings.defaultPurchasedBy || me.name);
    $("f_submittedBy").value = locked ? me.name : (settings.defaultSubmittedBy || me.name);
    $("f_purchasedBy").readOnly = locked;
    $("f_submittedBy").readOnly = locked;
    $("behalf-hint").hidden = locked;
    renderApproverOptions();
    loadCards();
  }

  // ── PDF (unchanged layout) ───────────────────────────────────────────────
  function buildPdfBlob(d, pdfItems) {
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ unit: "pt", format: "letter" });
    var marginX = 54, rightX = 558, y = 64;

    doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(20);
    doc.text(orgName, marginX, y);
    y += 18;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); doc.setTextColor(120);
    doc.text("Expense Request — Receipts for purchases made on behalf of the church", marginX, y);
    doc.setTextColor(20);
    y += 26;
    doc.setDrawColor(30); doc.setLineWidth(1);
    doc.line(marginX, y, rightX, y);
    y += 24;

    function row(label, value) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
      doc.text(label, marginX, y);
      doc.setFont("helvetica", "normal"); doc.setFontSize(11.5);
      doc.text(value || "—", marginX + 170, y);
      y += 16;
      doc.setDrawColor(215); doc.setLineWidth(0.6);
      doc.line(marginX, y, rightX, y);
      y += 18;
    }

    row("Date", fmtDate(d.date));
    row("Amount", fmtAmount(d.amount));

    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
    doc.text("Reason for purchase", marginX, y);
    y += 16;
    doc.setFont("helvetica", "normal"); doc.setFontSize(11.5);
    var reasonLines = doc.splitTextToSize(d.reason || "—", rightX - marginX);
    doc.text(reasonLines, marginX, y);
    y += reasonLines.length * 14 + 8;
    doc.setDrawColor(215);
    doc.line(marginX, y, rightX, y);
    y += 18;

    row("Charge code", displayCode(d.chargeCode));
    row("Sub-charge code", displayCode(d.subChargeCode));
    row("Vendor", d.vendor);
    row("Purchased by", d.purchasedBy);
    if (d.paymentMethod === "reimbursement") {
      row("Payment", "Reimbursement to " + (d.purchasedBy || "purchaser") + " (personal funds)");
      if (d.reimbursedAt) {
        row("Reimbursed", fmtDate(d.reimbursedAt) +
            (d.reimbursementReference ? " · " + d.reimbursementReference : ""));
      }
    } else {
      row("Payment", "Church card");
      row("Charged to which card", d.card);
    }
    row("Submitted by", d.submittedBy);
    row("Approved by", d.approvedBy);

    y += 30;
    doc.setDrawColor(20); doc.setLineWidth(1);
    doc.line(marginX, y, marginX + 210, y);
    doc.line(marginX + 260, y, marginX + 470, y);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(120);
    doc.text("Submitted by — signature & date", marginX, y + 12);
    doc.text("Approved by — signature & date", marginX + 260, y + 12);

    if (pdfItems.length) {
      doc.addPage();
      var ay = 50;
      doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(20);
      doc.text("Itemized Receipts", marginX, ay);
      ay += 10;
      doc.setDrawColor(30); doc.setLineWidth(1);
      doc.line(marginX, ay, rightX, ay);
      ay += 24;

      pdfItems.forEach(function (item) {
        var titleLines = doc.splitTextToSize(item.title || "Item", rightX - marginX - 90);
        var rowH = Math.max(18, titleLines.length * 14 + 6);
        if (ay + rowH > 730) { doc.addPage(); ay = 50; }
        doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); doc.setTextColor(20);
        doc.text(titleLines, marginX, ay);
        doc.setFont("helvetica", "bold");
        doc.text(fmtAmount(item.price), rightX - 60, ay);
        ay += rowH;
        doc.setDrawColor(230); doc.setLineWidth(0.6);
        doc.line(marginX, ay - 4, rightX, ay - 4);
        ay += 4;
      });

      ay += 16;
      doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(20);
      doc.text("Total", marginX, ay);
      doc.text(fmtAmount(pdfItems.reduce(function (s, i) { return s + (Number(i.price) || 0); }, 0)),
               rightX - 60, ay);
    }
    return doc.output("blob");
  }

  function downloadPdf(d, pdfItems) {
    var blob = buildPdfBlob(d, pdfItems);
    var namePart = String(d.submittedBy || "form").replace(/[^\w\- ]+/g, "").trim() || "form";
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "Expense Request - " + namePart + " - " + (d.date || todayISO()) + ".pdf";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  $("btn-pdf").addEventListener("click", function () {
    downloadPdf({
      date: $("f_date").value,
      amount: parseFloat($("f_amount").value) || parseFloat($("f_estimate").value) || 0,
      reason: $("f_reason").value,
      vendor: $("f_vendor").value,
      chargeCode: $("f_chargeCode").value,
      subChargeCode: $("f_subChargeCode").value,
      purchasedBy: $("f_purchasedBy").value,
      paymentMethod: $("f_payment").value,
      card: ($("f_card").selectedOptions[0] || {}).text || "",
      submittedBy: $("f_submittedBy").value,
      approvedBy: ($("f_approver").selectedOptions[0] || {}).text || ""
    }, items);
  });

  // ── lists ────────────────────────────────────────────────────────────────
  function requestRow(r, onOpen) {
    var row = el("div", "hrow");
    var main = el("div", "hrow-main");
    main.appendChild(el("div", "hrow-title", r.reason || "(no reason given)"));
    var bits = [fmtDate(r.request_date), r.vendor, displayCode(r.charge_code),
                r.submitted_by || r.created_by_name || r.submitted_by_email].filter(Boolean);
    main.appendChild(el("div", "hrow-sub", bits.join(" · ")));

    var badges = el("div", "hrow-sub");
    badges.appendChild(el("span", "stage " + stageClass(r.stage), r.stage));
    badges.appendChild(el("span", "tagp", r.payment_method === "reimbursement" ? "Reimbursement" : "Church card"));
    if (r.kind === "pre_purchase") badges.appendChild(el("span", "tagp", "Pre-purchase"));
    if (r.approval_method === "paper") badges.appendChild(el("span", "tagp", "Paper"));
    main.appendChild(badges);

    row.appendChild(main);
    row.appendChild(el("div", "hrow-amt", fmtAmount(r.amount || r.estimated_amount || 0)));
    var open = el("button", "btn", "Open");
    open.addEventListener("click", function () { onOpen(r.id); });
    row.appendChild(open);
    return row;
  }

  async function loadQueue() {
    try {
      var data = await api("GET", "/api/queue");
      $("queue-count").textContent = data.count ? "(" + data.count + ")" : "";
      var list = $("queue-list");
      list.innerHTML = "";
      if (!data.requests.length) {
        list.innerHTML = '<div class="empty">Nothing is waiting on you.</div>';
        return 0;
      }
      data.requests.forEach(function (r) { list.appendChild(requestRow(r, openDetail)); });
      return data.count;
    } catch (err) { msg("queue-msg", err.message, "err"); return 0; }
  }

  async function loadHistory() {
    try {
      var data = await api("GET", "/api/requests");
      var stage = $("h-stage").value;
      var payment = $("h-payment").value;
      var q = $("h-search").value.trim().toLowerCase();
      var rows = data.requests.filter(function (r) {
        if (stage && r.stage !== stage) return false;
        if (payment && r.payment_method !== payment) return false;
        if (q) {
          var hay = [r.reason, r.vendor, r.submitted_by, r.submitted_by_email].join(" ").toLowerCase();
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      });
      var list = $("history-list");
      list.innerHTML = "";
      if (!rows.length) { list.innerHTML = '<div class="empty">No matching requests.</div>'; return; }
      rows.forEach(function (r) { list.appendChild(requestRow(r, openDetail)); });
    } catch (err) { msg("history-msg", err.message, "err"); }
  }

  ["h-stage", "h-payment"].forEach(function (id) {
    $(id).addEventListener("change", loadHistory);
  });
  $("h-search").addEventListener("input", loadHistory);

  // ── detail ───────────────────────────────────────────────────────────────
  async function openDetail(id) {
    // A different request starts at the top; a redraw of this one stays put.
    if (detailId !== id) window.scrollTo(0, 0);
    detailId = id;
    if (linkedId() !== id) history.replaceState(null, "", "#/r/" + id);
    showTab("detail");
    var body = $("detail-body");
    body.innerHTML = '<div class="empty">Loading…</div>';
    try {
      var d = await api("GET", "/api/requests/" + id);
      renderDetail(d);
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(el("div", "alert alert-err", err.message));
    }
  }

  // All-or-nothing on the server: a non-2xx means none of the files were
  // stored. Never throws; resolves to the names that did not make it.
  async function uploadReceipts(id, files) {
    var names = files.map(function (f) { return f.name; });
    try {
      var fd = new FormData();
      files.forEach(function (f) { fd.append("files", f, f.name); });
      var res = await fetch("/api/requests/" + id + "/receipts",
                            { method: "POST", body: fd, credentials: "same-origin" });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || data.ok === false) return { added: [], failed: names, error: data.error || "" };
      return { added: data.added || [], failed: data.rejected || [], error: "" };
    } catch (e) {
      return { added: [], failed: names, error: "The connection dropped." };
    }
  }

  // Upload from the detail page, then redraw so the list shows the new files.
  // Whatever failed stays in hand behind a "Try again" button.
  async function addReceipts(id, files) {
    if (!files.length) return;
    msg("receipts-msg", "Uploading " + files.length + " file" + (files.length > 1 ? "s" : "") + "…", "info");
    var up = await uploadReceipts(id, files);
    await openDetail(id);
    if (up.failed.length) {
      var retry = files.filter(function (f) { return up.failed.indexOf(f.name) !== -1; });
      msgAction("receipts-msg", "These receipts didn't upload: " + up.failed.join(", ") + "." +
                (up.error ? " " + up.error : ""), "warn", "Try again",
                function () { addReceipts(id, retry.length ? retry : files); });
    } else {
      msg("receipts-msg", "Added " + up.added.length + " receipt" + (up.added.length === 1 ? "" : "s") + ".", "ok");
    }
  }

  function field(label, value) {
    var f = el("div", "dfield");
    f.appendChild(el("div", "dlabel", label));
    f.appendChild(el("div", "dvalue", value || "—"));
    return f;
  }

  // ── editing ────────────────────────────────────────────────────────────────

  function editField(label, id, type, value, attrs) {
    var f = el("div", "field");
    var l = el("label", "", label);
    l.setAttribute("for", id);
    f.appendChild(l);
    var i = el(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") i.type = type;
    i.id = id;
    i.value = value === null || value === undefined ? "" : value;
    Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); });
    f.appendChild(i);
    return f;
  }

  function editPanel(d) {
    var r = d.request;
    var allowed = d.allowed || {};
    // Saving a request the approver sent back also sends it back to them —
    // otherwise the edit sits in "changes requested" where nobody looks.
    var sendBack = r.status === "changes_requested" && allowed.resubmit;
    var undecided = r.status === "pending" || r.status === "changes_requested";
    // Kept separate from the `items` global, which belongs to the new-request
    // form — both can be alive at once.
    var editItems = d.items.map(function (i) {
      return { title: i.title, price: Number(i.price) || 0, autoType: i.autoType || null };
    });

    var wrap = el("div", "card");
    wrap.id = "edit-panel";
    wrap.style.display = "none";
    wrap.appendChild(el("div", "ct", "Edit request"));
    wrap.appendChild(el("div", "", "")).id = "edit-msg";

    var g1 = el("div", "grid2");
    g1.appendChild(editField("Date", "e_date", "date", r.request_date || ""));
    var af = editField("Amount", "e_amount", "number", Number(r.amount).toFixed(2),
      { step: "0.01", min: "0", inputmode: "decimal" });
    var ah = el("div", "hint", "Total of the line items");
    ah.id = "e_amount_hint";
    af.appendChild(ah);
    g1.appendChild(af);
    wrap.appendChild(g1);

    if (r.kind === "pre_purchase" && undecided) {
      wrap.appendChild(editField("Estimate", "e_estimate", "number",
        r.estimated_amount === null || r.estimated_amount === undefined ? "" : Number(r.estimated_amount).toFixed(2),
        { step: "0.01", min: "0", inputmode: "decimal" }));
    }

    wrap.appendChild(editField("Vendor", "e_vendor", "text", r.vendor));

    var g2 = el("div", "grid2");
    g2.appendChild(editField("Charge code", "e_chargeCode", "text", r.charge_code,
      { list: "chargeCodeList", autocomplete: "off" }));
    g2.appendChild(editField("Sub-charge code", "e_subChargeCode", "text", r.sub_charge_code,
      { list: "editSubCodeList", autocomplete: "off" }));
    wrap.appendChild(g2);

    // Its own datalist: the new-request form owns subChargeCodeList and the two
    // panels can hold different parent codes at the same time.
    var dl = el("datalist");
    dl.id = "editSubCodeList";
    wrap.appendChild(dl);
    // Scoped to `wrap`, not the document: this runs once while the panel is
    // still detached, before it has been appended.
    function syncSubCodes() {
      var typed = wrap.querySelector("#e_chargeCode").value.trim();
      var parent = codeTree.find(function (c) { return c.code === typed; });
      setOptions(dl, ((parent && parent.subs) || []).map(function (sub) {
        return [sub.code, sub.code + " — " + sub.label];
      }));
    }

    wrap.appendChild(editField("Reason", "e_reason", "textarea", r.reason));

    if (r.payment_method === "church_card") {
      var cf = el("div", "field");
      var cl = el("label", "", "Card");
      cl.setAttribute("for", "e_card");
      cf.appendChild(cl);
      var sel = el("select");
      sel.id = "e_card";
      var opts = cards.slice();
      // The card already on the request may not be one of the viewer's own.
      if (r.card_id && !opts.some(function (c) { return c.id === r.card_id; })) {
        opts.unshift({ id: r.card_id, nickname: r.card_label || r.card || "Current card", last4: "" });
      }
      setOptions(sel, opts.map(function (c) {
        return [c.id, c.last4 ? c.nickname + " ••" + c.last4 : c.nickname];
      }));
      selectValue(sel, r.card_id === null || r.card_id === undefined ? "" : String(r.card_id));
      cf.appendChild(sel);
      wrap.appendChild(cf);
    }

    // Line items, so a corrected total and the items that justify it cannot
    // drift apart on the record.
    var ic = el("div", "field");
    ic.appendChild(el("label", "", "Line items"));
    var rows = el("div");
    ic.appendChild(rows);
    wrap.appendChild(ic);

    function total() {
      return editItems.reduce(function (sum, i) { return sum + (Number(i.price) || 0); }, 0);
    }
    // Same rule as the new-request form: items present → amount is their total.
    // Scoped to `wrap`: the first call runs before the panel is attached.
    function syncAmount() {
      var a = wrap.querySelector("#e_amount");
      var locked = editItems.length > 0;
      a.readOnly = locked;
      if (locked) a.value = total().toFixed(2);
      wrap.querySelector("#e_amount_hint").hidden = !locked;
    }
    function drawItems() {
      rows.innerHTML = "";
      editItems.forEach(function (it, idx) {
        var row = el("div", "grid2");
        var t = el("input");
        t.type = "text"; t.value = it.title; t.placeholder = "Item";
        t.addEventListener("input", function () { it.title = t.value; });
        var priceWrap = el("div", "btn-row");
        var pr = el("input");
        pr.type = "number"; pr.step = "0.01"; pr.min = "0"; pr.value = Number(it.price).toFixed(2);
        pr.addEventListener("input", function () {
          it.price = parseFloat(pr.value) || 0;
          syncAmount();
        });
        var rm = el("button", "btn", "Remove");
        rm.addEventListener("click", function () {
          editItems.splice(idx, 1);
          drawItems();
        });
        priceWrap.appendChild(pr);
        priceWrap.appendChild(rm);
        row.appendChild(t);
        row.appendChild(priceWrap);
        rows.appendChild(row);
      });
      if (!editItems.length) rows.appendChild(el("div", "empty", "No line items."));
      syncAmount();
    }
    drawItems();

    var add = el("button", "btn", "Add item");
    add.addEventListener("click", function () {
      editItems.push({ title: "", price: 0, autoType: null });
      drawItems();
    });
    wrap.appendChild(add);

    wrap.appendChild(editField("Note (optional)", "e_note", "text", "",
      { placeholder: "What changed, and why" }));

    var saveLabel = sendBack ? "Save and send back to approver" : "Save changes";
    var save = el("button", "btn btn-primary", saveLabel);
    save.id = "btn-edit-save";
    save.setAttribute("data-default", saveLabel);
    save.addEventListener("click", async function () {
      busy("btn-edit-save", true, "Saving…");
      var payload = {
        version: r.version,
        requestDate: $("e_date").value,
        amount: parseFloat($("e_amount").value) || 0,
        vendor: $("e_vendor").value,
        reason: $("e_reason").value,
        chargeCode: $("e_chargeCode").value,
        subChargeCode: $("e_subChargeCode").value,
        items: editItems,
        note: $("e_note").value
      };
      if ($("e_card") && $("e_card").value) payload.cardId = Number($("e_card").value);
      if ($("e_estimate")) payload.estimatedAmount = parseFloat($("e_estimate").value) || 0;
      var out;
      try {
        out = await api("PATCH", "/api/requests/" + r.id, payload);
      } catch (err) {
        showActionError("edit-msg", err, r.id);
        busy("btn-edit-save", false);
        return;
      }
      try {
        if (sendBack) {
          // PATCH bumped the version; resubmit against the one it returned.
          try {
            await api("POST", "/api/requests/" + r.id + "/resubmit", { version: out.version });
          } catch (err) {
            await openDetail(r.id);
            msg("detail-msg", "Your changes were saved, but the request wasn't sent back: " +
                err.message, "err");
            return;
          }
          await openDetail(r.id);
          msg("detail-msg", "Saved and sent back to " + approverLabel(r) + ".", "ok", true);
          return;
        }
        await openDetail(r.id);
        msg("detail-msg", out.reapprovalRequired
          ? "Saved. That is a large enough change that the request has gone back to the approver."
          : "Saved.", "ok");
      } finally {
        busy("btn-edit-save", false);
      }
    });
    var srow = el("div", "btn-row");
    srow.appendChild(save);
    wrap.appendChild(srow);

    syncSubCodes();
    wrap.querySelector("#e_chargeCode").addEventListener("input", syncSubCodes);
    return wrap;
  }

  var CHANGE_LABELS = {
    requestDate: "Date", amount: "Amount", reason: "Reason", vendor: "Vendor",
    chargeCode: "Charge code", subChargeCode: "Sub-code", cardId: "Card",
    approverEmail: "Approver", approvedBy: "Approver name", items: "Line items"
  };

  function changeValue(field, value) {
    if (value === null || value === "" || value === undefined) return "\u2014";
    if (field === "amount") return fmtAmount(value);
    if (field === "items") return (value.length || 0) + (value.length === 1 ? " item" : " items");
    return String(value);
  }

  function describeChanges(changes) {
    return Object.keys(changes).map(function (field) {
      var c = changes[field];
      return (CHANGE_LABELS[field] || field) + ": " +
             changeValue(field, c.from) + " \u2192 " + changeValue(field, c.to);
    });
  }

  var EVENT_LABELS = {
    submitted: "Submitted", approved: "Approved", rejected: "Rejected",
    changes_requested: "Changes requested", approved_on_paper: "Approved on paper",
    comment: "Comment", receipt_added: "Receipt added", receipt_removed: "Receipt removed",
    actuals_completed: "Actual cost recorded", reapproval_required: "Sent back for re-approval",
    reimbursed: "Reimbursed", edited: "Edited", withdrawn: "Withdrawn",
    resubmitted: "Sent back to approver", voided: "Voided"
  };

  function has(v) { return v !== undefined && v !== null; }

  function approverLabel(r) { return r.approved_by || r.approver_email || "the approver"; }

  function lastEvent(events, types) {
    for (var i = events.length - 1; i >= 0; i--) {
      if (types.indexOf(events[i].type) !== -1) return { at: i, e: events[i] };
    }
    return null;
  }

  // "approved $X, now $Y" while a request is back with the approver because
  // its amount moved after approval. Events arrive oldest first, so the later
  // index is the more recent one.
  function reapprovalText(r, events) {
    if (r.status !== "pending") return "";
    var back = lastEvent(events, ["reapproval_required"]);
    if (!back) return "";
    var ok = lastEvent(events, ["approved", "approved_on_paper"]);
    if (ok && ok.at > back.at) return "";
    var m = back.e.meta || {};
    var was = has(m.approvedAmount) ? m.approvedAmount : m.estimate;
    var now = has(m.approvedAmount) ? m.amount : m.actual;
    if (!has(was) || !has(now)) return "Back for re-approval.";
    return "Back for re-approval: approved " + fmtAmount(was) + ", now " + fmtAmount(now);
  }

  // A small form hidden behind the button that reveals it, so rarely used
  // actions (paper approval, void) don't crowd the common ones.
  function reveal(btn, box, focus) {
    box.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", function () {
      box.hidden = !box.hidden;
      btn.setAttribute("aria-expanded", String(!box.hidden));
      if (!box.hidden && focus) focus.focus();
    });
  }

  function labelled(text, input) {
    var f = el("div", "field");
    var l = el("label", "", text);
    l.setAttribute("for", input.id);
    f.appendChild(l);
    f.appendChild(input);
    return f;
  }

  function dateInput(id) {
    var i = el("input");
    i.type = "date"; i.id = id; i.max = todayISO(); i.value = todayISO();
    return i;
  }

  function renderDetail(d) {
    var r = d.request;
    var allowed = d.allowed || {};
    var body = $("detail-body");
    body.innerHTML = "";

    var head = el("div", "card");
    head.appendChild(el("div", "", "")).id = "detail-note";
    var again = reapprovalText(r, d.events);
    if (again) head.appendChild(el("div", "alert alert-warn", again));
    var title = el("div", "ct", r.reason || "(no reason given)");
    head.appendChild(title);
    var badges = el("div", "", "");
    badges.appendChild(el("span", "stage " + stageClass(r.stage), r.stage));
    badges.appendChild(el("span", "tagp", r.kind === "pre_purchase" ? "Pre-purchase" : "Already purchased"));
    badges.appendChild(el("span", "tagp", r.payment_method === "reimbursement" ? "Reimbursement" : "Church card"));
    if (r.approval_method) badges.appendChild(el("span", "tagp", r.approval_method === "paper" ? "Approved on paper" : "Approved digitally"));
    head.appendChild(badges);

    var grid = el("div", "dgrid");
    grid.appendChild(field("Amount", fmtAmount(r.amount)));
    if (r.estimated_amount) grid.appendChild(field("Estimated", fmtAmount(r.estimated_amount)));
    if (has(r.approved_amount) && Math.abs(Number(r.approved_amount) - Number(r.amount)) >= 0.005) {
      grid.appendChild(field("Approved amount", fmtAmount(r.approved_amount)));
    }
    grid.appendChild(field("Date", fmtDate(r.request_date)));
    grid.appendChild(field("Vendor", r.vendor));
    grid.appendChild(field("Charge code", displayCode(r.charge_code)));
    if (r.sub_charge_code) grid.appendChild(field("Sub-code", displayCode(r.sub_charge_code)));
    grid.appendChild(field("Purchased by", r.purchased_by));
    grid.appendChild(field("Submitted by", r.submitted_by || r.created_by_name));
    if (r.card_label) grid.appendChild(field("Card", r.card_label));
    grid.appendChild(field("Approver", r.approved_by || r.approver_email));
    if (r.reimbursed_at) grid.appendChild(field("Reimbursed", fmtDate(r.reimbursed_at) +
      (r.reimbursement_reference ? " · " + r.reimbursement_reference : "")));
    if (r.voided_at) grid.appendChild(field("Voided", fmtDate(r.voided_at) +
      (r.void_reason ? " · " + r.void_reason : "")));
    head.appendChild(grid);

    var pdfBtn = el("button", "btn btn-gold", "Download PDF");
    pdfBtn.addEventListener("click", function () {
      downloadPdf({
        date: r.request_date, amount: r.amount, reason: r.reason, vendor: r.vendor,
        chargeCode: r.charge_code, subChargeCode: r.sub_charge_code,
        purchasedBy: r.purchased_by, card: r.card_label || r.card,
        paymentMethod: r.payment_method, reimbursedAt: r.reimbursed_at,
        reimbursementReference: r.reimbursement_reference,
        submittedBy: r.submitted_by, approvedBy: r.approved_by
      }, d.items);
    });
    var actions = el("div", "btn-row");
    actions.appendChild(pdfBtn);
    head.appendChild(actions);
    body.appendChild(head);

    // Items
    if (d.items.length) {
      var ic = el("div", "card");
      ic.appendChild(el("div", "ct", "Line items"));
      var t = el("table", "items");
      t.innerHTML = "<thead><tr><th>Item</th><th>Price</th></tr></thead>";
      var tb = el("tbody");
      d.items.forEach(function (i) {
        var tr = el("tr", i.autoType ? "auto" : "");
        tr.appendChild(el("td", "", i.title));
        tr.appendChild(el("td", "num", fmtAmount(i.price)));
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      ic.appendChild(t);
      body.appendChild(ic);
    }

    // Receipts
    var rc = el("div", "card");
    rc.appendChild(el("div", "ct", "Receipts"));
    rc.appendChild(el("div", "", "")).id = "receipts-msg";
    if (!d.receipts.length) {
      rc.appendChild(el("div", "empty", "No receipts attached."));
    } else {
      d.receipts.forEach(function (rec) {
        var row = el("div", "hrow");
        var m = el("div", "hrow-main");
        m.appendChild(el("div", "hrow-title", rec.file_name));
        m.appendChild(el("div", "hrow-sub", (rec.byte_size / 1024).toFixed(0) + " KB · " + rec.uploaded_by_email));
        row.appendChild(m);
        var view = el("a", "btn", "View");
        view.href = "/api/requests/" + r.id + "/receipts/" + rec.id;
        view.target = "_blank";
        view.rel = "noopener";
        view.style.textDecoration = "none";
        row.appendChild(view);
        rc.appendChild(row);
      });
    }
    if (allowed.addReceipts) {
      // The input stays in the tab order (sr-only, not `hidden`) so the
      // label-styled button is reachable from the keyboard.
      var up = el("label", "btn btn-gold file-btn", "Add receipts");
      var fi = el("input", "sr-only");
      fi.type = "file"; fi.multiple = true; fi.accept = "application/pdf,image/*";
      fi.addEventListener("change", async function () {
        var picked = Array.from(fi.files || []);
        fi.value = "";
        var files = [];
        for (var i = 0; i < picked.length; i++) files.push(await shrinkImage(picked[i]));
        addReceipts(r.id, files);
      });
      up.appendChild(fi);
      var urow = el("div", "btn-row");
      urow.appendChild(up);
      rc.appendChild(urow);
    }
    body.appendChild(rc);

    // Actions
    var ac = el("div", "card");
    ac.appendChild(el("div", "ct", "Actions"));
    ac.appendChild(el("div", "", "")).id = "detail-msg";

    if (allowed.resubmit) {
      var asked = lastEvent(d.events, ["changes_requested"]);
      var banner = el("div", "alert alert-warn");
      banner.appendChild(el("strong", "", "Changes were requested"));
      if (asked && asked.e.comment) {
        banner.appendChild(el("div", "", (asked.e.actor_name || asked.e.actor_email) + ": " + asked.e.comment));
      }
      banner.appendChild(el("div", "", "Make the changes with Edit request, then send it back."));
      ac.appendChild(banner);
      var reply = el("textarea");
      reply.id = "d-reply";
      reply.placeholder = "Reply to the approver (optional)";
      reply.setAttribute("aria-label", "Reply to the approver (optional)");
      ac.appendChild(reply);
      var sbrow = el("div", "btn-row");
      var sb = el("button", "btn btn-primary", "Send back to approver");
      sb.id = "btn-resubmit";
      sb.setAttribute("data-default", "Send back to approver");
      sb.addEventListener("click", function () { resubmit(r); });
      sbrow.appendChild(sb);
      ac.appendChild(sbrow);
    }

    if (allowed.decide) {
      var comment = el("textarea");
      comment.id = "d-comment";
      comment.placeholder = "Comment (required to reject or request changes)";
      comment.setAttribute("aria-label", "Comment (required to reject or request changes)");
      ac.appendChild(comment);
      var brow = el("div", "btn-row");
      [["approve", "Approve", "btn btn-primary"],
       ["request_changes", "Request changes", "btn btn-gold"],
       ["reject", "Reject", "btn btn-danger"]].forEach(function (a) {
        var b = el("button", a[2], a[1]);
        b.addEventListener("click", function () { decide(r, a[0]); });
        brow.appendChild(b);
      });
      ac.appendChild(brow);
    }

    if (allowed.paperApprove) {
      var prow = el("div", "btn-row");
      var paper = el("button", "btn", "Record paper approval");
      prow.appendChild(paper);
      ac.appendChild(prow);
      var pbox = el("div", "subform");
      var pdate = dateInput("d-paper-date");
      var pnote = el("input"); pnote.type = "text"; pnote.id = "d-paper-note";
      pnote.placeholder = "Who signed, where the paper is kept";
      var pg = el("div", "grid2");
      pg.appendChild(labelled("Date it was signed", pdate));
      pg.appendChild(labelled("Note (optional)", pnote));
      pbox.appendChild(pg);
      var pb = el("button", "btn btn-primary", "Record");
      pb.addEventListener("click", function () { paperApprove(r); });
      var pbrow = el("div", "btn-row");
      pbrow.appendChild(pb);
      pbox.appendChild(pbrow);
      ac.appendChild(pbox);
      reveal(paper, pbox, pdate);
    }

    if (allowed.completeActuals) {
      var arow = el("div", "btn-row");
      var actual = el("input"); actual.type = "number"; actual.step = "0.01"; actual.min = "0";
      actual.setAttribute("inputmode", "decimal");
      actual.id = "d-actual"; actual.placeholder = "Actual amount";
      actual.setAttribute("aria-label", "Actual amount");
      arow.appendChild(actual);
      var ab = el("button", "btn btn-primary", "Complete with actuals");
      ab.addEventListener("click", function () { completeActuals(r); });
      arow.appendChild(ab);
      ac.appendChild(arow);
    }

    if (allowed.reimburse) {
      var rg = el("div", "grid2");
      rg.appendChild(labelled("Paid on", dateInput("d-paidon")));
      var ref = el("input"); ref.type = "text"; ref.id = "d-ref"; ref.placeholder = "Cheque no., transfer";
      rg.appendChild(labelled("Reference", ref));
      ac.appendChild(rg);
      var rrow = el("div", "btn-row");
      var rb = el("button", "btn btn-primary", "Mark reimbursed");
      rb.addEventListener("click", function () { markReimbursed(r); });
      rrow.appendChild(rb);
      ac.appendChild(rrow);
    }

    var lastRow = el("div", "btn-row");

    if (allowed.edit) {
      var editBtn = el("button", "btn", "Edit request");
      editBtn.addEventListener("click", function () {
        var panel = $("edit-panel");
        var open = panel.style.display === "none";
        panel.style.display = open ? "" : "none";
        editBtn.textContent = open ? "Hide editor" : "Edit request";
        if (open) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      lastRow.appendChild(editBtn);
    }

    // The server decides which of these applies (and refuses both once money
    // has moved); the labels only have to say honestly what will happen.
    if (allowed.delete) {
      lastRow.appendChild(removeButton(r, "Delete request",
        "Delete this request? Nothing has been decided on it yet, so it is removed completely."));
    }
    if (allowed.withdraw) {
      lastRow.appendChild(removeButton(r, "Withdraw request",
        "Withdraw this request? It stays on the record, marked withdrawn."));
    }

    var vbox = null;
    if (allowed.void) {
      var vb = el("button", "btn btn-danger", "Void…");
      lastRow.appendChild(vb);
      vbox = el("div", "subform");
      vbox.appendChild(el("p", "hint", "Voiding keeps the request and its history but takes it off the books."));
      var vreason = el("input"); vreason.type = "text"; vreason.id = "d-void-reason";
      vreason.placeholder = "Why it is being voided";
      vbox.appendChild(labelled("Reason", vreason));
      var vrow = el("div", "btn-row");
      var vgo = el("button", "btn btn-danger", "Void request");
      vgo.addEventListener("click", function () { voidRequest(r); });
      vrow.appendChild(vgo);
      vbox.appendChild(vrow);
      reveal(vb, vbox, vreason);
    }
    if (lastRow.childNodes.length) ac.appendChild(lastRow);
    if (vbox) ac.appendChild(vbox);
    // Kept even when empty: its message box also reports comment errors.
    if (ac.childNodes.length === 2) ac.appendChild(el("div", "empty", "Nothing for you to do on this request."));
    body.appendChild(ac);

    if (allowed.edit) body.appendChild(editPanel(d));

    // Timeline + comments
    var tc = el("div", "card");
    tc.appendChild(el("div", "ct", "History"));
    var tl = el("div", "timeline");
    d.events.forEach(function (e) {
      var item = el("div", "tl-item");
      item.appendChild(el("div", "tl-type", EVENT_LABELS[e.type] || e.type.replace(/_/g, " ")));
      var who = (e.actor_name || e.actor_email) + " · " + fmtWhen(e.created_at);
      item.appendChild(el("div", "tl-who", who));
      if (e.comment) item.appendChild(el("div", "tl-comment", e.comment));
      var m = e.meta || {};
      if (has(m.estimate)) {
        item.appendChild(el("div", "tl-comment",
          "Estimated " + fmtAmount(m.estimate) + ", actual " + fmtAmount(m.actual)));
      }
      if (has(m.approvedAmount)) {
        item.appendChild(el("div", "tl-comment",
          "Approved at " + fmtAmount(m.approvedAmount) + ", now " + fmtAmount(m.amount)));
      }
      // Older events carry the pre-edit amount under this name.
      if (has(m.previousAmount)) {
        item.appendChild(el("div", "tl-comment",
          "Approved at " + fmtAmount(m.previousAmount) + ", corrected to " + fmtAmount(m.amount)));
      }
      if (m.approvedOn) item.appendChild(el("div", "tl-comment", "Signed on " + fmtDate(m.approvedOn)));
      if (m.paidOn) item.appendChild(el("div", "tl-comment", "Paid on " + fmtDate(m.paidOn)));
      if (m.changes) {
        describeChanges(m.changes).forEach(function (line) {
          item.appendChild(el("div", "tl-comment", line));
        });
      }
      tl.appendChild(item);
    });
    tc.appendChild(tl);

    if (allowed.comment) {
      var cbox = el("textarea"); cbox.id = "d-newcomment"; cbox.placeholder = "Add a comment";
      cbox.setAttribute("aria-label", "Add a comment");
      tc.appendChild(cbox);
      var crow = el("div", "btn-row");
      var cb = el("button", "btn btn-gold", "Comment");
      cb.addEventListener("click", async function () {
        var text = $("d-newcomment").value.trim();
        if (!text) return;
        try { await api("POST", "/api/requests/" + r.id + "/comments", { comment: text }); openDetail(r.id); }
        catch (err) { msg("detail-msg", err.message, "err"); }
      });
      crow.appendChild(cb);
      tc.appendChild(crow);
    }
    body.appendChild(tc);
  }

  function removeButton(r, label, question) {
    var b = el("button", "btn btn-danger", label);
    b.addEventListener("click", async function () {
      if (!confirm(question)) return;
      try {
        var out = await api("DELETE", "/api/requests/" + r.id, { version: r.version });
        if (out.mode === "hard") {
          showTab("history"); loadHistory(); loadQueue();
          msg("history-msg", "Request deleted.", "ok");
        } else {
          await openDetail(r.id);
          msg("detail-msg", "Withdrawn.", "ok");
        }
      } catch (err) { showActionError("detail-msg", err, r.id); }
    });
    return b;
  }

  async function decide(r, action) {
    var comment = (($("d-comment") || {}).value || "").trim();
    if (action !== "approve" && !comment) {
      msg("detail-msg", action === "reject"
        ? "Say why you are rejecting it, so they know."
        : "Say what needs to change, so they know what to do.", "warn");
      $("d-comment").focus();
      return;
    }
    try {
      await api("POST", "/api/requests/" + r.id + "/decision",
                { action: action, comment: comment, version: r.version });
      await openDetail(r.id); loadQueue();
      msg("detail-msg", action === "approve" ? "Approved."
        : action === "reject" ? "Rejected." : "Sent back for changes.", "ok");
    } catch (err) { showActionError("detail-msg", err, r.id); }
  }

  async function resubmit(r) {
    busy("btn-resubmit", true, "Sending…");
    try {
      await api("POST", "/api/requests/" + r.id + "/resubmit",
                { comment: (($("d-reply") || {}).value || "").trim(), version: r.version });
      await openDetail(r.id); loadQueue();
      msg("detail-msg", "Sent back to " + approverLabel(r) + ".", "ok", true);
    } catch (err) {
      showActionError("detail-msg", err, r.id);
      busy("btn-resubmit", false);
    }
  }

  async function paperApprove(r) {
    var on = ($("d-paper-date") || {}).value || "";
    if (!on) { msg("detail-msg", "Choose the date it was signed.", "warn"); return; }
    try {
      await api("POST", "/api/requests/" + r.id + "/paper-approval",
                { approvedOn: on, note: ($("d-paper-note") || {}).value || "", version: r.version });
      await openDetail(r.id); loadQueue();
      msg("detail-msg", "Paper approval recorded.", "ok");
    } catch (err) { showActionError("detail-msg", err, r.id); }
  }

  async function completeActuals(r) {
    try {
      var out = await api("POST", "/api/requests/" + r.id + "/actuals",
                          { amount: parseFloat(($("d-actual") || {}).value) || 0, version: r.version });
      await openDetail(r.id);
      if (out.reapprovalRequired) {
        msg("detail-msg", "That is over the approved estimate, so it has gone back for re-approval.", "warn");
      }
    } catch (err) { showActionError("detail-msg", err, r.id); }
  }

  async function markReimbursed(r) {
    var paidOn = ($("d-paidon") || {}).value || "";
    if (!paidOn) { msg("detail-msg", "Choose the date it was paid.", "warn"); return; }
    try {
      await api("POST", "/api/requests/" + r.id + "/reimburse",
                { paidOn: paidOn, reference: ($("d-ref") || {}).value || "", version: r.version });
      await openDetail(r.id);
      msg("detail-msg", "Marked reimbursed.", "ok");
    } catch (err) { showActionError("detail-msg", err, r.id); }
  }

  async function voidRequest(r) {
    var reason = (($("d-void-reason") || {}).value || "").trim();
    if (!reason) { msg("detail-msg", "Say why it is being voided.", "warn"); return; }
    try {
      await api("POST", "/api/requests/" + r.id + "/void", { reason: reason, version: r.version });
      await openDetail(r.id); loadQueue();
      msg("detail-msg", "Voided. It stays on the record but no longer counts as spend.", "ok");
    } catch (err) { showActionError("detail-msg", err, r.id); }
  }

  // ── reports ──────────────────────────────────────────────────────────────
  function reportQuery() {
    var p = new URLSearchParams();
    if ($("r-from").value) p.set("from", $("r-from").value);
    if ($("r-to").value) p.set("to", $("r-to").value);
    return p.toString();
  }

  $("btn-report").addEventListener("click", async function () {
    try {
      var data = await api("GET", "/api/reports/by-code?" + reportQuery());
      var body = $("report-body");
      body.innerHTML = "";
      if (!data.totals.length) { body.innerHTML = '<div class="empty">No approved spend in that range.</div>'; return; }
      var t = el("table", "items");
      t.innerHTML = "<thead><tr><th>Charge code</th><th>GL account</th><th>Requests</th><th>Total</th></tr></thead>";
      var tb = el("tbody");
      data.totals.forEach(function (row) {
        var tr = el("tr");
        tr.appendChild(el("td", "", displayCode(row.chargeCode)));
        tr.appendChild(el("td", "", row.glAccount || "—"));
        tr.appendChild(el("td", "", String(row.count)));
        tr.appendChild(el("td", "num", fmtAmount(row.total)));
        tb.appendChild(tr);
      });
      var tr2 = el("tr");
      tr2.appendChild(el("td", "", "Total"));
      tr2.appendChild(el("td", "", ""));
      tr2.appendChild(el("td", "", ""));
      tr2.appendChild(el("td", "num", fmtAmount(data.grandTotal)));
      tb.appendChild(tr2);
      t.appendChild(tb);
      body.appendChild(t);
    } catch (err) { msg("reports-msg", err.message, "err"); }
  });

  $("btn-csv").addEventListener("click", function () {
    window.location.href = "/api/export.csv?" + reportQuery();
  });
  $("btn-gl-csv").addEventListener("click", function () {
    window.location.href = "/api/export-gl.csv?" + reportQuery();
  });

  // ── settings ─────────────────────────────────────────────────────────────
  async function loadSettingsTab() {
    if (can("admin")) { loadPermissionsMatrix(); loadCardsAdmin(); }
    if (can("manage")) loadCodes();
  }

  // Mirrors ROLE_PRESETS in permissions.ts; the server applies the preset, this
  // only shows which one a row matches.
  var ROLES = [
    ["submitter", "Submitter", { can_submit: 1 }],
    ["approver", "Approver", { can_submit: 1, can_approve: 1 }],
    ["assistant", "Office assistant", { can_submit: 1, can_submit_for_others: 1, can_manage: 1, can_pay: 1 }],
    ["accountant", "Accountant (read-only)", { can_audit: 1 }]
  ];
  var ROLE_FLAGS = ["can_submit", "can_submit_for_others", "can_approve", "can_manage", "can_pay", "can_audit"];
  function roleOf(p) {
    var hit = ROLES.find(function (r) {
      return ROLE_FLAGS.every(function (f) { return !!p[f] === !!r[2][f]; });
    });
    return hit ? hit[0] : null;
  }

  async function loadPermissionsMatrix() {
    var list = $("perm-list");
    try {
      var data = await api("GET", "/api/permissions");
      var byEmail = {};
      data.permissions.forEach(function (p) { byEmail[p.email.toLowerCase()] = p; });
      // Everyone the hub granted the app appears, whether or not they have a
      // row yet — so a new person is ready to tick rather than hunted for.
      var merged = people.map(function (u) {
        return byEmail[u.email.toLowerCase()] || { email: u.email, name: u.name };
      });
      Object.keys(byEmail).forEach(function (e) {
        if (!merged.some(function (m) { return m.email.toLowerCase() === e; })) merged.push(byEmail[e]);
      });

      // No "Edit own": revising your own undecided request comes with
      // submitting it, so there is nothing left to grant.
      var flags = [["can_submit", "Submit"], ["can_submit_for_others", "For others"],
                   ["can_approve", "Approve"], ["can_manage", "Office"], ["can_pay", "Pay"],
                   ["can_audit", "Read all"], ["is_admin", "Admin"]];
      list.innerHTML = "";
      var t = el("table", "umatrix");
      t.innerHTML = "<thead><tr><th>User</th><th>Role</th>" +
        flags.map(function (f) { return '<th class="c">' + f[1] + "</th>"; }).join("") +
        "<th>Default approver</th></tr></thead>";
      var tb = el("tbody");
      merged.forEach(function (p) {
        var tr = el("tr");
        var td = el("td");
        td.appendChild(el("strong", "", p.name || "—"));
        td.appendChild(el("div", "muted", p.email));
        tr.appendChild(td);
        var rt = el("td");
        var rsel = el("select");
        rsel.setAttribute("aria-label", "Role for " + (p.name || p.email));
        // "Custom" is offered only while the ticks match no role.
        var fillRole = function () {
          var r = roleOf(p);
          setOptions(rsel, ROLES.map(function (x) { return [x[0], x[1]]; }), r ? undefined : "Custom");
          selectValue(rsel, r || "");
        };
        fillRole();
        rsel.addEventListener("change", async function () {
          if (!rsel.value) return;
          try {
            await api("PUT", "/api/permissions/" + encodeURIComponent(p.email), { name: p.name || "", role: rsel.value });
            msg("perm-msg", "Saved.", "ok");
            loadPermissionsMatrix();
          } catch (err) { msg("perm-msg", err.message, "err"); }
        });
        rt.appendChild(rsel);
        tr.appendChild(rt);
        flags.forEach(function (f) {
          var c = el("td", "c");
          var box = el("input"); box.type = "checkbox"; box.checked = !!p[f[0]];
          box.addEventListener("change", async function () {
            var patch = { name: p.name || "" };
            patch[f[0]] = box.checked;
            try {
              await api("PUT", "/api/permissions/" + encodeURIComponent(p.email), patch);
              p[f[0]] = box.checked;
              fillRole();
              msg("perm-msg", "Saved.", "ok");
            }
            catch (err) { box.checked = !box.checked; msg("perm-msg", err.message, "err"); }
          });
          c.appendChild(box);
          tr.appendChild(c);
        });
        var dt = el("td");
        var sel = el("select");
        setOptions(sel, peopleRows(), "—");
        selectValue(sel, p.default_approver_email || "");
        sel.addEventListener("change", async function () {
          try { await api("PUT", "/api/permissions/" + encodeURIComponent(p.email),
                          { default_approver_email: sel.value }); msg("perm-msg", "Saved.", "ok"); }
          catch (err) { msg("perm-msg", err.message, "err"); }
        });
        dt.appendChild(sel);
        tr.appendChild(dt);
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      list.appendChild(t);
    } catch (err) { msg("perm-msg", err.message, "err"); }
  }

  async function loadCardsAdmin() {
    try {
      var data = await api("GET", "/api/cards");
      var list = $("cards-list");
      list.innerHTML = "";
      if (!data.cards.length) { list.innerHTML = '<div class="empty">No cards yet.</div>'; return; }
      data.cards.forEach(function (c) {
        var row = el("div", "hrow");
        var m = el("div", "hrow-main");
        m.appendChild(el("div", "hrow-title", c.nickname + " ••" + c.last4));
        m.appendChild(el("div", "hrow-sub",
          "Primary: " + c.primary_email + (c.additional.length ? " · Also: " + c.additional.join(", ") : "")));
        row.appendChild(m);

        var addSel = el("select");
        setOptions(addSel, peopleRows(), "+ add user");
        addSel.addEventListener("change", async function () {
          if (!addSel.value) return;
          var next = c.additional.concat([addSel.value]);
          try { await api("PATCH", "/api/cards/" + c.id, { additional: next }); loadCardsAdmin(); }
          catch (err) { msg("cards-msg", err.message, "err"); }
        });
        row.appendChild(addSel);

        var x = el("button", "fq-x", "×");
        x.addEventListener("click", async function () {
          if (!confirm("Delete " + c.nickname + "?")) return;
          try { await api("DELETE", "/api/cards/" + c.id); loadCardsAdmin(); }
          catch (err) { msg("cards-msg", err.message, "err"); }
        });
        row.appendChild(x);
        list.appendChild(row);
      });
    } catch (err) { msg("cards-msg", err.message, "err"); }
  }

  $("btn-add-card").addEventListener("click", async function () {
    busy("btn-add-card", true, "Adding…");
    try {
      await api("POST", "/api/cards", {
        nickname: $("c-nickname").value,
        last4: $("c-last4").value,
        primaryEmail: $("c-primary").value,
        additional: []
      });
      $("c-nickname").value = ""; $("c-last4").value = "";
      loadCardsAdmin();
      msg("cards-msg", "Card added.", "ok");
    } catch (err) { msg("cards-msg", err.message, "err"); }
    finally { busy("btn-add-card", false); }
  });

  async function loadCodes() {
    var data = await api("GET", "/api/charge-codes");
    codeTree = data.codes || [];
    buildChargeDatalist();
    var list = $("codes-list");
    if (!list) return;
    list.innerHTML = "";
    codeTree.forEach(function (p) {
      var box = el("div", "code-parent");
      box.appendChild(codeLine(p, false));
      p.subs.forEach(function (s) { box.appendChild(codeLine(s, true)); });
      list.appendChild(box);
    });
    if ($("cc-parent")) {
      setOptions($("cc-parent"), codeTree.map(function (p) { return [p.id, "Sub-code of " + p.code]; }),
                 "Top-level code");
    }
  }

  function codeLine(node, isSub) {
    var line = el("div", "code-line" + (isSub ? " code-sub" : ""));
    line.appendChild(el("span", "code-num", node.code));
    line.appendChild(el("span", "code-label", node.label));
    var gl = el("input", "code-gl");
    gl.type = "text";
    gl.value = node.gl_account || "";
    gl.placeholder = "GL " + node.code;
    gl.setAttribute("aria-label", "GL account for " + node.code);
    gl.addEventListener("change", async function () {
      try {
        await api("PATCH", "/api/charge-codes/" + node.id, { glAccount: gl.value });
        node.gl_account = gl.value.trim();
        msg("codes-msg", "GL account saved.", "ok");
      } catch (err) { msg("codes-msg", err.message, "err"); }
    });
    line.appendChild(gl);
    var x = el("button", "code-x", "×");
    x.setAttribute("aria-label", "Delete " + node.code);
    x.addEventListener("click", async function () {
      if (!confirm("Delete " + node.code + " " + node.label + (isSub ? "?" : "? Its sub-codes go too."))) return;
      try { await api("DELETE", "/api/charge-codes/" + node.id); await loadCodes(); msg("codes-msg", "Deleted.", "ok"); }
      catch (err) { msg("codes-msg", err.message, "err"); }
    });
    line.appendChild(x);
    return line;
  }

  $("btn-add-code").addEventListener("click", async function () {
    busy("btn-add-code", true, "Adding…");
    try {
      await api("POST", "/api/charge-codes", {
        code: $("cc-code").value, label: $("cc-label").value, glAccount: $("cc-gl").value,
        parentId: $("cc-parent").value ? Number($("cc-parent").value) : null
      });
      $("cc-code").value = ""; $("cc-label").value = ""; $("cc-gl").value = "";
      await loadCodes();
      msg("codes-msg", "Code added.", "ok");
    } catch (err) { msg("codes-msg", err.message, "err"); }
    finally { busy("btn-add-code", false); }
  });

  $("btn-save-rules").addEventListener("click", async function () {
    busy("btn-save-rules", true, "Saving…");
    try {
      var data = await api("PUT", "/api/settings", {
        allowSelfApproval: $("s_selfApprove").checked ? "true" : "false",
        overageTolerancePct: String((parseFloat($("s_tolPct").value) || 0) / 100),
        overageToleranceAbs: String(parseFloat($("s_tolAbs").value) || 0)
      });
      settings = data.settings;
      msg("rules-msg", "Rules saved.", "ok");
    } catch (err) { msg("rules-msg", err.message, "err"); }
    finally { busy("btn-save-rules", false); }
  });

  $("btn-save-defaults").addEventListener("click", async function () {
    busy("btn-save-defaults", true, "Saving…");
    try {
      var body = {
        orgName: $("s_org").value,
        defaultPurchasedBy: $("s_purchasedBy").value,
        defaultCard: $("s_card").value,
        defaultSubmittedBy: $("s_submittedBy").value,
        defaultApprovedBy: $("s_approvedBy").value
      };
      if ($("s_key").value.trim()) body.anthropicApiKey = $("s_key").value.trim();
      var data = await api("PUT", "/api/settings", body);
      settings = data.settings;
      orgName = settings.orgName || orgName;
      $("s_key").value = "";
      renderSettings();
      msg("defaults-msg", "Saved.", "ok");
    } catch (err) { msg("defaults-msg", err.message, "err"); }
    finally { busy("btn-save-defaults", false); }
  });

  $("btn-save-mail").addEventListener("click", async function () {
    busy("btn-save-mail", true, "Saving…");
    try {
      var body = { mailFrom: $("s_mailFrom").value };
      if ($("s_resendKey").value.trim()) body.resendApiKey = $("s_resendKey").value.trim();
      var data = await api("PUT", "/api/settings", body);
      settings = data.settings;
      $("s_resendKey").value = "";
      renderSettings();
      msg("mail-msg", "Saved.", "ok");
    } catch (err) { msg("mail-msg", err.message, "err"); }
    finally { busy("btn-save-mail", false); }
  });

  $("btn-test-mail").addEventListener("click", async function () {
    busy("btn-test-mail", true, "Sending…");
    try {
      var data = await api("POST", "/api/settings/test-email", {});
      msg("mail-msg", "Sent to " + data.to + ". Check that inbox (and its spam folder).", "ok", true);
    } catch (err) { msg("mail-msg", err.message, "err"); }
    finally { busy("btn-test-mail", false); }
  });

  function renderSettings() {
    $("s_mailFrom").value = settings.mailFrom || "";
    $("resend-hint").textContent = (settings.hasResendKey
      ? "A key is stored (" + settings.resendKeyHint + "). Leave blank to keep it."
      : "No key stored yet — no emails will be sent.") +
      (settings.appUrl ? " Links in emails open " + settings.appUrl + "." : "");
    $("s_org").value = settings.orgName || "";
    $("s_purchasedBy").value = settings.defaultPurchasedBy || "";
    $("s_card").value = settings.defaultCard || "";
    $("s_submittedBy").value = settings.defaultSubmittedBy || "";
    $("s_approvedBy").value = settings.defaultApprovedBy || "";
    $("s_selfApprove").checked = !!settings.allowSelfApproval;
    $("s_tolPct").value = Math.round((settings.overageTolerancePct || 0.1) * 100);
    $("s_tolAbs").value = settings.overageToleranceAbs || 25;
    $("key-hint").textContent = settings.hasApiKey
      ? "A key is stored (" + settings.apiKeyHint + "). Leave blank to keep it."
      : "No key stored yet — receipt reading will not work until one is saved.";
  }

  function applyPermissionVisibility() {
    document.querySelectorAll("[data-needs]").forEach(function (node) {
      node.hidden = !can(node.getAttribute("data-needs"));
    });
    var maySubmit = can("submit");
    var member = maySubmit || can("approve") || can("manage") || can("pay") || can("audit") || can("admin");
    $("submit-area").hidden = !maySubmit;
    $("no-perms").hidden = member;
    // Someone who never submits has no use for the form as a front page.
    $("tab-new").hidden = member && !maySubmit;
    $("history-title").textContent = can("viewAll") ? "All requests" : "Your requests";
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  (async function init() {
    try {
      me = await api("GET", "/api/me");
      $("me-label").textContent = me.name || me.email || "";
    } catch (e) { /* header stays blank */ }

    applyPermissionVisibility();

    try {
      var s = await api("GET", "/api/settings");
      settings = s.settings;
      orgName = settings.orgName || orgName;
      renderSettings();
    } catch (e) { /* non-admins cannot read settings; defaults stand */ }

    await loadPeople();
    try { await loadCodes(); } catch (e) { /* charge codes are optional to render */ }
    await loadApprovers();

    $("f_date").value = todayISO();
    applyKindPayment();
    applyDefaults();   // also loads the purchaser's cards
    renderItems();
    var waiting = await loadQueue();

    // Land where this person's work is: the request a link points at, then
    // decisions waiting on them, then — for anyone who does not submit — the
    // screen they came for.
    var linked = linkedId();
    if (linked) openDetail(linked);
    else if (can("approve") && waiting > 0) showTab("queue");
    else if (!can("submit") && can("reports")) showTab("reports");
    else if (!can("submit") && can("approve")) showTab("queue");
    else if (!can("submit") && can("viewAll")) { showTab("history"); loadHistory(); }
    else if (!can("submit") && can("admin")) { showTab("settings"); loadSettingsTab(); }
  })();
})();
