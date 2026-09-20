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
    if (stage === "Withdrawn") return "st-void";
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

  // ── tabs ─────────────────────────────────────────────────────────────────
  function showTab(name) {
    document.querySelectorAll(".tab").forEach(function (x) {
      x.classList.toggle("active", x.getAttribute("data-tab") === name);
    });
    document.querySelectorAll(".panel").forEach(function (x) { x.classList.remove("active"); });
    var panel = $("p-" + name);
    if (panel) panel.classList.add("active");
  }

  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      var name = t.getAttribute("data-tab");
      showTab(name);
      if (name === "history") loadHistory();
      if (name === "queue") loadQueue();
      if (name === "settings") loadSettingsTab();
    });
  });

  $("btn-back").addEventListener("click", function () { showTab("history"); loadHistory(); });

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
  $("f-receipts").addEventListener("change", function (ev) {
    Array.from(ev.target.files || []).forEach(function (f) {
      var key = f.name + "::" + f.size;
      if (!queued.some(function (q) { return q.key === key; })) queued.push({ key: key, file: f });
    });
    ev.target.value = "";
    renderQueue();
  });

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
    if (!queued.length) { msg("import-msg", "Add at least one PDF first.", "warn"); return; }
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
      updateAmountFromItems();
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

  function updateAmountFromItems() { $("f_amount").value = itemsTotal().toFixed(2); }

  function renderItems() {
    var wrap = $("items-wrap");
    if (!items.length) {
      wrap.innerHTML = '<div class="empty">No items yet — add PDFs and extract, or add an item manually.</div>';
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
    var sync = el("button", "btn btn-gold", "Update amount from items");
    sync.addEventListener("click", updateAmountFromItems);
    foot.appendChild(tot); foot.appendChild(sync);
    wrap.appendChild(foot);
  }

  // ── charge codes ─────────────────────────────────────────────────────────
  function buildChargeDatalist() {
    $("chargeCodeList").innerHTML = codeTree.map(function (c) {
      return '<option value="' + c.code + '">' + c.code + " — " + c.label + "</option>";
    }).join("");
    onChargeCodeChange();
  }

  function onChargeCodeChange() {
    var value = $("f_chargeCode").value.trim();
    var parent = codeTree.find(function (c) { return c.code === value; });
    var subs = parent ? parent.subs : [];
    $("sub-field").style.display = subs.length ? "" : "none";
    if (!subs.length) { $("f_subChargeCode").value = ""; return; }
    $("subChargeCodeList").innerHTML = subs.map(function (s) {
      return '<option value="' + s.code + '">' + s.code + " — " + s.label + "</option>";
    }).join("");
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
    sel.innerHTML = '<option value="">— choose a card —</option>' + cards.map(function (c) {
      return '<option value="' + c.id + '">' + c.nickname + " ••" + c.last4 + "</option>";
    }).join("");
    $("card-hint").textContent = cards.length ? "" : "You are not listed on any card.";
  }

  function findEmailByName(name) {
    var n = String(name || "").trim().toLowerCase();
    var hit = people.find(function (p) { return (p.name || "").trim().toLowerCase() === n; });
    return hit ? hit.email : "";
  }

  async function loadPeople() {
    try {
      var res = await fetch(HUB + "/api/users?app=expenses", { credentials: "include" });
      var data = await res.json();
      people = data.users || [];
    } catch (e) { people = []; }
    $("peopleList").innerHTML = people.map(function (p) {
      return '<option value="' + (p.name || p.email) + '">' + p.email + "</option>";
    }).join("");
    var opts = '<option value="">— choose —</option>' + people.map(function (p) {
      return '<option value="' + p.email + '">' + (p.name || p.email) + "</option>";
    }).join("");
    if ($("c-primary")) $("c-primary").innerHTML = opts;
  }

  async function loadApprovers() {
    try {
      var data = await api("GET", "/api/approvers");
      approvers = data.approvers || [];
    } catch (e) { approvers = []; }
    var def = me.permissions.defaultApprover || "";
    $("f_approver").innerHTML = '<option value="">— choose an approver —</option>' +
      approvers.map(function (a) {
        return '<option value="' + a.email + '"' + (a.email === def ? " selected" : "") + ">" +
               (a.name || a.email) + "</option>";
      }).join("");
  }

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

      // Receipts attach after the request exists — the same endpoint the
      // pre-purchase completion flow uses days later.
      if (queued.length) {
        var fd = new FormData();
        queued.forEach(function (q) { fd.append("files", q.file, q.file.name); });
        await fetch("/api/requests/" + saved.id + "/receipts",
                    { method: "POST", body: fd, credentials: "same-origin" });
      }

      msg("form-msg", "Submitted for approval.", "ok");
      resetForm();
      loadQueue();
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
    row("Charged to which card", d.card);
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
        return;
      }
      data.requests.forEach(function (r) { list.appendChild(requestRow(r, openDetail)); });
    } catch (err) { msg("queue-msg", err.message, "err"); }
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
    detailId = id;
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

  function field(label, value) {
    var f = el("div", "dfield");
    f.appendChild(el("div", "dlabel", label));
    f.appendChild(el("div", "dvalue", value || "—"));
    return f;
  }

  // ── editing ────────────────────────────────────────────────────────────────

  // Mirrors checkEdit on the server, which is the gate that actually counts.
  // The submitter revises their own request until it is decided; manage reaches
  // one step further, into an approved request whose real charge came in
  // different from the one that was approved.
  function canEditRequest(r) {
    var mine = r.submitted_by_email.toLowerCase() === me.email.toLowerCase();
    if (can("manage")) {
      return r.status === "pending" || r.status === "changes_requested" || r.status === "approved";
    }
    return mine && (r.status === "pending" || r.status === "changes_requested");
  }

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
    g1.appendChild(editField("Amount", "e_amount", "number", Number(r.amount).toFixed(2),
      { step: "0.01", min: "0" }));
    wrap.appendChild(g1);

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
      dl.innerHTML = ((parent && parent.subs) || []).map(function (sub) {
        return '<option value="' + sub.code + '">' + sub.code + " — " + sub.label + "</option>";
      }).join("");
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
      sel.innerHTML = opts.map(function (c) {
        var label = c.last4 ? c.nickname + " ••" + c.last4 : c.nickname;
        return '<option value="' + c.id + '"' + (c.id === r.card_id ? " selected" : "") + ">" + label + "</option>";
      }).join("");
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
          $("e_amount").value = total().toFixed(2);
        });
        var rm = el("button", "btn", "Remove");
        rm.addEventListener("click", function () {
          editItems.splice(idx, 1);
          drawItems();
          $("e_amount").value = total().toFixed(2);
        });
        priceWrap.appendChild(pr);
        priceWrap.appendChild(rm);
        row.appendChild(t);
        row.appendChild(priceWrap);
        rows.appendChild(row);
      });
      if (!editItems.length) rows.appendChild(el("div", "empty", "No line items."));
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

    var save = el("button", "btn btn-primary", "Save changes");
    save.id = "btn-edit-save";
    save.setAttribute("data-default", "Save changes");
    save.addEventListener("click", async function () {
      busy("btn-edit-save", true, "Saving…");
      var payload = {
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
      try {
        var out = await api("PATCH", "/api/requests/" + r.id, payload);
        await openDetail(r.id);
        msg("detail-msg", out.reapprovalRequired
          ? "Saved. That is a large enough change that the request has gone back to the approver."
          : "Saved.", "ok");
      } catch (err) {
        msg("edit-msg", err.message, "err");
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

  function renderDetail(d) {
    var r = d.request;
    var body = $("detail-body");
    body.innerHTML = "";

    var head = el("div", "card");
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
    head.appendChild(grid);

    var pdfBtn = el("button", "btn btn-gold", "Download PDF");
    pdfBtn.addEventListener("click", function () {
      downloadPdf({
        date: r.request_date, amount: r.amount, reason: r.reason, vendor: r.vendor,
        chargeCode: r.charge_code, subChargeCode: r.sub_charge_code,
        purchasedBy: r.purchased_by, card: r.card_label || r.card,
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
    body.appendChild(rc);

    // Actions
    var ac = el("div", "card");
    ac.appendChild(el("div", "ct", "Actions"));
    ac.appendChild(el("div", "", "")).id = "detail-msg";
    var mine = r.submitted_by_email.toLowerCase() === me.email.toLowerCase();
    var canDecide = can("approve") && r.status === "pending" &&
                    (can("manage") || r.approver_email.toLowerCase() === me.email.toLowerCase()) &&
                    (!mine || settings.allowSelfApproval);

    if (canDecide) {
      var comment = el("textarea");
      comment.id = "d-comment";
      comment.placeholder = "Comment (required when requesting changes)";
      ac.appendChild(comment);
      var brow = el("div", "btn-row");
      [["approve", "Approve", "btn btn-primary"],
       ["request_changes", "Request changes", "btn btn-gold"],
       ["reject", "Reject", "btn"]].forEach(function (a) {
        var b = el("button", a[2], a[1]);
        b.addEventListener("click", function () { decide(r.id, a[0]); });
        brow.appendChild(b);
      });
      var paper = el("button", "btn", "Record paper approval");
      paper.addEventListener("click", function () { paperApprove(r.id); });
      brow.appendChild(paper);
      ac.appendChild(brow);
    }

    if (r.status === "approved" && r.kind === "pre_purchase" && !r.actuals_completed_at && (mine || can("manage"))) {
      var arow = el("div", "btn-row");
      var actual = el("input"); actual.type = "number"; actual.step = "0.01";
      actual.id = "d-actual"; actual.placeholder = "Actual amount";
      arow.appendChild(actual);
      var ab = el("button", "btn btn-primary", "Complete with actuals");
      ab.addEventListener("click", function () { completeActuals(r.id); });
      arow.appendChild(ab);
      ac.appendChild(arow);
    }

    if (r.status === "approved" && r.payment_method === "reimbursement" && !r.reimbursed_at && can("manage")) {
      var rrow = el("div", "btn-row");
      var ref = el("input"); ref.type = "text"; ref.id = "d-ref"; ref.placeholder = "Reference (cheque no., transfer)";
      rrow.appendChild(ref);
      var rb = el("button", "btn btn-primary", "Mark reimbursed");
      rb.addEventListener("click", function () { markReimbursed(r.id); });
      rrow.appendChild(rb);
      ac.appendChild(rrow);
    }

    var lastRow = el("div", "btn-row");

    if (canEditRequest(r)) {
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

    // Deleting your own request is always on offer; what it means depends on
    // whether anything has been decided. checkDelete on the server decides for
    // real — this only has to label the button honestly.
    var canWithdraw = mine && r.status !== "withdrawn";
    var undecided = r.status === "pending" || r.status === "changes_requested";
    if (can("manage") || canWithdraw) {
      var hard = can("manage") || undecided;
      var del = el("button", "btn", hard ? "Delete request" : "Withdraw request");
      del.addEventListener("click", async function () {
        if (!confirm(hard
          ? "Delete this request and its receipts? This cannot be undone."
          : "Withdraw this request? It stays on the record and drops out of spend reports."
        )) return;
        try {
          await api("DELETE", "/api/requests/" + r.id);
          if (hard) { showTab("history"); loadHistory(); }
          else { await openDetail(r.id); msg("detail-msg", "Withdrawn.", "ok"); }
        } catch (err) { msg("detail-msg", err.message, "err"); }
      });
      lastRow.appendChild(del);
    }
    if (lastRow.childNodes.length) ac.appendChild(lastRow);
    body.appendChild(ac);

    if (canEditRequest(r)) body.appendChild(editPanel(d));

    // Timeline + comments
    var tc = el("div", "card");
    tc.appendChild(el("div", "ct", "History"));
    var tl = el("div", "timeline");
    d.events.forEach(function (e) {
      var item = el("div", "tl-item");
      item.appendChild(el("div", "tl-type", e.type.replace(/_/g, " ")));
      var who = (e.actor_name || e.actor_email) + " · " + fmtWhen(e.created_at);
      item.appendChild(el("div", "tl-who", who));
      if (e.comment) item.appendChild(el("div", "tl-comment", e.comment));
      if (e.meta && e.meta.estimate !== undefined && e.meta.estimate !== null) {
        item.appendChild(el("div", "tl-comment",
          "Estimated " + fmtAmount(e.meta.estimate) + ", actual " + fmtAmount(e.meta.actual)));
      }
      if (e.meta && e.meta.previousAmount !== undefined && e.meta.previousAmount !== null) {
        item.appendChild(el("div", "tl-comment",
          "Approved at " + fmtAmount(e.meta.previousAmount) + ", corrected to " + fmtAmount(e.meta.amount)));
      }
      if (e.meta && e.meta.changes) {
        describeChanges(e.meta.changes).forEach(function (line) {
          item.appendChild(el("div", "tl-comment", line));
        });
      }
      tl.appendChild(item);
    });
    tc.appendChild(tl);

    var cbox = el("textarea"); cbox.id = "d-newcomment"; cbox.placeholder = "Add a comment";
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
    body.appendChild(tc);
  }

  async function decide(id, action) {
    try {
      await api("POST", "/api/requests/" + id + "/decision",
                { action: action, comment: ($("d-comment") || {}).value || "" });
      openDetail(id); loadQueue();
    } catch (err) { msg("detail-msg", err.message, "err"); }
  }

  async function paperApprove(id) {
    var on = prompt("Date it was approved on paper (YYYY-MM-DD):", todayISO());
    if (on === null) return;
    try {
      await api("POST", "/api/requests/" + id + "/paper-approval", { approvedOn: on });
      openDetail(id); loadQueue();
    } catch (err) { msg("detail-msg", err.message, "err"); }
  }

  async function completeActuals(id) {
    try {
      var out = await api("POST", "/api/requests/" + id + "/actuals",
                          { amount: parseFloat(($("d-actual") || {}).value) || 0 });
      if (out.reapprovalRequired) {
        msg("detail-msg", "That is over the approved estimate, so it has gone back for re-approval.", "warn");
      }
      openDetail(id);
    } catch (err) { msg("detail-msg", err.message, "err"); }
  }

  async function markReimbursed(id) {
    try {
      await api("POST", "/api/requests/" + id + "/reimburse",
                { paidOn: todayISO(), reference: ($("d-ref") || {}).value || "" });
      openDetail(id);
    } catch (err) { msg("detail-msg", err.message, "err"); }
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
      t.innerHTML = "<thead><tr><th>Charge code</th><th>Requests</th><th>Total</th></tr></thead>";
      var tb = el("tbody");
      data.totals.forEach(function (row) {
        var tr = el("tr");
        tr.appendChild(el("td", "", displayCode(row.chargeCode)));
        tr.appendChild(el("td", "", String(row.count)));
        tr.appendChild(el("td", "num", fmtAmount(row.total)));
        tb.appendChild(tr);
      });
      var tr2 = el("tr");
      tr2.appendChild(el("td", "", "Total"));
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

  // ── settings ─────────────────────────────────────────────────────────────
  async function loadSettingsTab() {
    if (can("admin")) { loadPermissionsMatrix(); loadCardsAdmin(); }
    if (can("manage")) loadCodes();
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
                   ["can_approve", "Approve"],
                   ["can_manage", "Manage"], ["is_admin", "Admin"]];
      list.innerHTML = "";
      var t = el("table", "umatrix");
      t.innerHTML = "<thead><tr><th>User</th>" +
        flags.map(function (f) { return '<th class="c">' + f[1] + "</th>"; }).join("") +
        "<th>Default approver</th></tr></thead>";
      var tb = el("tbody");
      merged.forEach(function (p) {
        var tr = el("tr");
        var td = el("td");
        td.appendChild(el("strong", "", p.name || "—"));
        td.appendChild(el("div", "muted", p.email));
        tr.appendChild(td);
        flags.forEach(function (f) {
          var c = el("td", "c");
          var box = el("input"); box.type = "checkbox"; box.checked = !!p[f[0]];
          box.addEventListener("change", async function () {
            var patch = { name: p.name || "" };
            patch[f[0]] = box.checked;
            try { await api("PUT", "/api/permissions/" + encodeURIComponent(p.email), patch); msg("perm-msg", "Saved.", "ok"); }
            catch (err) { box.checked = !box.checked; msg("perm-msg", err.message, "err"); }
          });
          c.appendChild(box);
          tr.appendChild(c);
        });
        var dt = el("td");
        var sel = el("select");
        sel.innerHTML = '<option value="">—</option>' + people.map(function (u) {
          return '<option value="' + u.email + '"' +
            (p.default_approver_email === u.email ? " selected" : "") + ">" + (u.name || u.email) + "</option>";
        }).join("");
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
        addSel.innerHTML = '<option value="">+ add user</option>' + people.map(function (u) {
          return '<option value="' + u.email + '">' + (u.name || u.email) + "</option>";
        }).join("");
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
      $("cc-parent").innerHTML = '<option value="">Top-level code</option>' +
        codeTree.map(function (p) { return '<option value="' + p.id + '">Sub-code of ' + p.code + "</option>"; }).join("");
    }
  }

  function codeLine(node, isSub) {
    var line = el("div", "code-line" + (isSub ? " code-sub" : ""));
    line.appendChild(el("span", "code-num", node.code));
    line.appendChild(el("span", "code-label", node.label));
    var x = el("button", "code-x", "×");
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
        code: $("cc-code").value, label: $("cc-label").value,
        parentId: $("cc-parent").value ? Number($("cc-parent").value) : null
      });
      $("cc-code").value = ""; $("cc-label").value = "";
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

  function renderSettings() {
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
    $("submit-area").hidden = !maySubmit;
    $("no-perms").hidden = maySubmit || can("approve") || can("manage") || can("admin");
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
    await loadCards();

    $("f_date").value = todayISO();
    applyKindPayment();
    applyDefaults();
    renderItems();
    loadQueue();
  })();
})();
