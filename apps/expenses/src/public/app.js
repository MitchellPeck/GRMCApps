(function () {
  "use strict";

  // ── state ────────────────────────────────────────────────────────────────
  var queued = [];        // {key, file}
  var items = [];         // {id, title, price, autoType?}
  var codeTree = [];      // [{code, label, subs:[{code,label}]}]
  var settings = {};
  var orgName = "Grace Resurrection Methodist Church";

  var FIELDS = ["f_date", "f_amount", "f_reason", "f_vendor", "f_chargeCode",
                "f_subChargeCode", "f_purchasedBy", "f_card", "f_submittedBy", "f_approvedBy"];

  var $ = function (id) { return document.getElementById(id); };

  // ── helpers ──────────────────────────────────────────────────────────────
  function msg(el, text, kind) {
    var box = $(el);
    if (!text) { box.innerHTML = ""; return; }
    var d = document.createElement("div");
    d.className = "alert alert-" + (kind || "info");
    d.textContent = text;
    box.innerHTML = "";
    box.appendChild(d);
    if (kind === "ok") setTimeout(function () { if (box.firstChild === d) box.innerHTML = ""; }, 3000);
  }

  function busy(btn, on, label) {
    var b = $(btn);
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
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso || "").trim());
    if (!m) return "—";
    return MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + ", " + Number(m[1]);
  }

  function displayCode(code) {
    var v = (code || "").trim();
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

  // ── tabs ─────────────────────────────────────────────────────────────────
  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
      document.querySelectorAll(".panel").forEach(function (x) { x.classList.remove("active"); });
      t.classList.add("active");
      $("p-" + t.getAttribute("data-tab")).classList.add("active");
      if (t.getAttribute("data-tab") === "history") loadHistory();
    });
  });

  // ── upload queue ─────────────────────────────────────────────────────────
  $("f-receipts").addEventListener("change", function (ev) {
    var files = Array.from(ev.target.files || []);
    files.forEach(function (f) {
      var key = f.name + "::" + f.size;
      if (!queued.some(function (q) { return q.key === key; })) queued.push({ key: key, file: f });
    });
    ev.target.value = "";
    renderQueue();
  });

  function renderQueue() {
    var wrap = $("file-queue");
    if (!queued.length) { wrap.innerHTML = ""; return; }
    var html = '<div class="fq">';
    queued.forEach(function (q) {
      html += '<div class="fq-row"><span class="fq-name"></span>' +
              '<span class="fq-size">' + (q.file.size / 1024).toFixed(0) + ' KB</span>' +
              '<button class="fq-x" data-key="' + encodeURIComponent(q.key) + '" title="Remove">&times;</button></div>';
    });
    wrap.innerHTML = html + "</div>";
    // Filenames are set as text, never interpolated into HTML.
    wrap.querySelectorAll(".fq-name").forEach(function (el, i) { el.textContent = queued[i].file.name; });
    wrap.querySelectorAll(".fq-x").forEach(function (b) {
      b.addEventListener("click", function () {
        var key = decodeURIComponent(b.getAttribute("data-key"));
        queued = queued.filter(function (q) { return q.key !== key; });
        renderQueue();
      });
    });
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
      if (data.rejected && data.rejected.length) note += " Skipped (not a PDF): " + data.rejected.join(", ") + ".";
      msg("import-msg", note + " Review below.", (data.failed && data.failed.length) ? "warn" : "ok");
      queued = [];
      renderQueue();
    } catch (err) {
      msg("import-msg", err.message, "err");
    } finally {
      busy("btn-extract", false);
    }
  });

  // ── items table ──────────────────────────────────────────────────────────
  $("btn-add-item").addEventListener("click", function () {
    items.push({ id: newId(), title: "", price: 0, autoType: null });
    renderItems();
  });

  function renderItems() {
    var wrap = $("items-wrap");
    if (!items.length) {
      wrap.innerHTML = '<div class="empty">No items yet — add PDFs and extract, or add an item manually.</div>';
      return;
    }
    var rows = items.map(function (it) {
      return '<tr class="' + (it.autoType ? "auto" : "") + '" data-id="' + it.id + '">' +
             '<td class="t-title"><input type="text" value="" data-f="title"></td>' +
             '<td class="num"><input type="number" step="0.01" value="' + it.price + '" data-f="price"></td>' +
             '<td class="act"><button class="fq-x" data-del="1" title="Remove">&times;</button></td></tr>';
    }).join("");

    wrap.innerHTML =
      '<table class="items"><thead><tr><th>Item</th><th>Price</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="items-foot"><div class="items-total">Total: <strong id="items-total">' +
      fmtAmount(itemsTotal()) + '</strong></div>' +
      '<button class="btn btn-gold" id="btn-sync-amount">Update amount from items</button></div>';

    // Titles are assigned as values, never interpolated into the HTML string.
    wrap.querySelectorAll('input[data-f="title"]').forEach(function (el, i) { el.value = items[i].title; });

    wrap.querySelectorAll("tbody input").forEach(function (el) {
      el.addEventListener("input", function () {
        var id = el.closest("tr").getAttribute("data-id");
        var it = items.find(function (x) { return x.id === id; });
        if (!it) return;
        if (el.getAttribute("data-f") === "price") it.price = parseFloat(el.value) || 0;
        else it.title = el.value;
        $("items-total").textContent = fmtAmount(itemsTotal());
      });
    });
    wrap.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.closest("tr").getAttribute("data-id");
        items = items.filter(function (x) { return x.id !== id; });
        renderItems();
      });
    });
    $("btn-sync-amount").addEventListener("click", updateAmountFromItems);
  }

  function itemsTotal() {
    return items.reduce(function (s, i) { return s + (parseFloat(i.price) || 0); }, 0);
  }

  function updateAmountFromItems() {
    $("f_amount").value = itemsTotal().toFixed(2);
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
    // The sub-code field disappears entirely when the parent has none, as in
    // the original.
    $("sub-field").style.display = subs.length ? "" : "none";
    if (!subs.length) { $("f_subChargeCode").value = ""; return; }
    $("subChargeCodeList").innerHTML = subs.map(function (s) {
      return '<option value="' + s.code + '">' + s.code + " — " + s.label + "</option>";
    }).join("");
  }

  $("f_chargeCode").addEventListener("input", onChargeCodeChange);

  // ── output PDF (ported from the Artifact's buildPdfBlob) ─────────────────
  function getFormData() {
    var d = {};
    FIELDS.forEach(function (id) { d[id] = $(id).value; });
    return d;
  }

  function buildPdfBlob(d) {
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

    row("Date", fmtDate(d.f_date));
    row("Amount", fmtAmount(d.f_amount));

    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
    doc.text("Reason for purchase", marginX, y);
    y += 16;
    doc.setFont("helvetica", "normal"); doc.setFontSize(11.5);
    var reasonLines = doc.splitTextToSize(d.f_reason || "—", rightX - marginX);
    doc.text(reasonLines, marginX, y);
    y += reasonLines.length * 14 + 8;
    doc.setDrawColor(215);
    doc.line(marginX, y, rightX, y);
    y += 18;

    row("Charge code", displayCode(d.f_chargeCode));
    row("Sub-charge code", displayCode(d.f_subChargeCode));
    row("Vendor", d.f_vendor);
    row("Purchased by", d.f_purchasedBy);
    row("Charged to which card", d.f_card);
    row("Submitted by", d.f_submittedBy);
    row("Approved by", d.f_approvedBy);

    y += 30;
    doc.setDrawColor(20); doc.setLineWidth(1);
    doc.line(marginX, y, marginX + 210, y);
    doc.line(marginX + 260, y, marginX + 470, y);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(120);
    doc.text("Submitted by — signature & date", marginX, y + 12);
    doc.text("Approved by — signature & date", marginX + 260, y + 12);

    if (items.length) {
      doc.addPage();
      var ay = 50;
      doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(20);
      doc.text("Itemized Receipts", marginX, ay);
      ay += 10;
      doc.setDrawColor(30); doc.setLineWidth(1);
      doc.line(marginX, ay, rightX, ay);
      ay += 24;

      items.forEach(function (item) {
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
      doc.text(fmtAmount(itemsTotal()), rightX - 60, ay);
    }

    return doc.output("blob");
  }

  $("btn-pdf").addEventListener("click", function () {
    var d = getFormData();
    var blob = buildPdfBlob(d);
    var namePart = (d.f_submittedBy || "form").replace(/[^\w\- ]+/g, "").trim() || "form";
    var filename = "Expense Request - " + namePart + " - " + (d.f_date || todayISO()) + ".pdf";
    // A plain object-URL anchor: the Artifact's downloads capability has no
    // analogue here and needs none.
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  });

  // ── save / clear ─────────────────────────────────────────────────────────
  $("btn-save").addEventListener("click", async function () {
    busy("btn-save", true, "Saving…");
    try {
      var d = getFormData();
      await api("POST", "/api/requests", {
        requestDate: d.f_date,
        amount: parseFloat(d.f_amount) || 0,
        reason: d.f_reason,
        vendor: d.f_vendor,
        chargeCode: d.f_chargeCode,
        subChargeCode: d.f_subChargeCode,
        purchasedBy: d.f_purchasedBy,
        card: d.f_card,
        submittedBy: d.f_submittedBy,
        approvedBy: d.f_approvedBy,
        items: items.map(function (i) {
          return { title: i.title, price: i.price, autoType: i.autoType };
        })
      });
      msg("form-msg", "Saved to history.", "ok");
      loadHistory();
    } catch (err) {
      msg("form-msg", err.message, "err");
    } finally {
      busy("btn-save", false);
    }
  });

  $("btn-clear").addEventListener("click", function () {
    items = []; queued = [];
    renderItems(); renderQueue();
    applyDefaults();
    msg("form-msg", ""); msg("import-msg", "");
  });

  function applyDefaults() {
    FIELDS.forEach(function (id) { $(id).value = ""; });
    $("f_date").value = todayISO();
    $("f_purchasedBy").value = settings.defaultPurchasedBy || "";
    $("f_card").value = settings.defaultCard || "";
    $("f_submittedBy").value = settings.defaultSubmittedBy || "";
    $("f_approvedBy").value = settings.defaultApprovedBy || "";
    onChargeCodeChange();
  }

  // ── history ──────────────────────────────────────────────────────────────
  async function loadHistory() {
    try {
      var data = await api("GET", "/api/requests");
      $("history-count").textContent = data.requests.length ? "(" + data.requests.length + ")" : "";
      var list = $("history-list");
      if (!data.requests.length) {
        list.innerHTML = '<div class="empty">No saved requests yet.</div>';
        return;
      }
      list.innerHTML = "";
      data.requests.forEach(function (r) {
        var row = document.createElement("div");
        row.className = "hrow";

        var main = document.createElement("div");
        main.className = "hrow-main";
        var title = document.createElement("div");
        title.className = "hrow-title";
        title.textContent = r.reason || "(no reason given)";
        var sub = document.createElement("div");
        sub.className = "hrow-sub";
        sub.textContent = [fmtDate(r.request_date), r.vendor, displayCode(r.charge_code),
                           r.created_by_name || r.created_by_email]
                          .filter(Boolean).join(" · ");
        main.appendChild(title); main.appendChild(sub);

        var amt = document.createElement("div");
        amt.className = "hrow-amt";
        amt.textContent = fmtAmount(r.amount);

        var open = document.createElement("button");
        open.className = "btn"; open.textContent = "Open";
        open.addEventListener("click", function () { openRequest(r.id); });

        var del = document.createElement("button");
        del.className = "fq-x"; del.innerHTML = "&times;"; del.title = "Delete";
        del.addEventListener("click", async function () {
          if (!confirm("Delete this request? This cannot be undone.")) return;
          try { await api("DELETE", "/api/requests/" + r.id); loadHistory(); }
          catch (err) { msg("history-msg", err.message, "err"); }
        });

        row.appendChild(main); row.appendChild(amt); row.appendChild(open); row.appendChild(del);
        list.appendChild(row);
      });
    } catch (err) {
      msg("history-msg", err.message, "err");
    }
  }

  async function openRequest(id) {
    try {
      var data = await api("GET", "/api/requests/" + id);
      var r = data.request;
      $("f_date").value = r.request_date ? String(r.request_date).slice(0, 10) : "";
      $("f_amount").value = Number(r.amount).toFixed(2);
      $("f_reason").value = r.reason;
      $("f_vendor").value = r.vendor;
      $("f_chargeCode").value = r.charge_code;
      onChargeCodeChange();
      $("f_subChargeCode").value = r.sub_charge_code;
      $("f_purchasedBy").value = r.purchased_by;
      $("f_card").value = r.card;
      $("f_submittedBy").value = r.submitted_by;
      $("f_approvedBy").value = r.approved_by;
      items = data.items.map(function (i) {
        return { id: newId(), title: i.title, price: Number(i.price) || 0, autoType: i.autoType || null };
      });
      renderItems();
      document.querySelector('.tab[data-tab="new"]').click();
      msg("form-msg", "Loaded from history. Saving creates a new entry.", "info");
    } catch (err) {
      msg("history-msg", err.message, "err");
    }
  }

  // ── settings ─────────────────────────────────────────────────────────────
  $("btn-save-key").addEventListener("click", async function () {
    var key = $("s_key").value.trim();
    if (!key) { msg("key-msg", "Enter a key, or leave it blank to keep the stored one.", "warn"); return; }
    busy("btn-save-key", true, "Saving…");
    try {
      var data = await api("PUT", "/api/settings", { anthropicApiKey: key });
      settings = data.settings;
      $("s_key").value = "";
      renderKeyHint();
      msg("key-msg", "Key saved.", "ok");
    } catch (err) {
      msg("key-msg", err.message, "err");
    } finally {
      busy("btn-save-key", false);
    }
  });

  $("btn-save-defaults").addEventListener("click", async function () {
    busy("btn-save-defaults", true, "Saving…");
    try {
      var data = await api("PUT", "/api/settings", {
        orgName: $("s_org").value,
        defaultPurchasedBy: $("s_purchasedBy").value,
        defaultCard: $("s_card").value,
        defaultSubmittedBy: $("s_submittedBy").value,
        defaultApprovedBy: $("s_approvedBy").value
      });
      settings = data.settings;
      orgName = settings.orgName || orgName;
      msg("defaults-msg", "Defaults saved.", "ok");
    } catch (err) {
      msg("defaults-msg", err.message, "err");
    } finally {
      busy("btn-save-defaults", false);
    }
  });

  function renderKeyHint() {
    $("key-hint").textContent = settings.hasApiKey
      ? "A key is stored (" + settings.apiKeyHint + "). Leave blank to keep it."
      : "No key stored yet — extraction will not work until one is saved.";
  }

  function renderSettings() {
    $("s_org").value = settings.orgName || "";
    $("s_purchasedBy").value = settings.defaultPurchasedBy || "";
    $("s_card").value = settings.defaultCard || "";
    $("s_submittedBy").value = settings.defaultSubmittedBy || "";
    $("s_approvedBy").value = settings.defaultApprovedBy || "";
    renderKeyHint();
  }

  // ── charge code editor ───────────────────────────────────────────────────
  function renderCodes() {
    var list = $("codes-list");
    if (!codeTree.length) {
      list.innerHTML = '<div class="empty">No charge codes yet.</div>';
    } else {
      list.innerHTML = "";
      codeTree.forEach(function (p) {
        var box = document.createElement("div");
        box.className = "code-parent";
        box.appendChild(codeLine(p, false));
        p.subs.forEach(function (s) { box.appendChild(codeLine(s, true)); });
        list.appendChild(box);
      });
    }
    $("c-parent").innerHTML = '<option value="">Top-level code</option>' +
      codeTree.map(function (p) {
        return '<option value="' + p.id + '">Sub-code of ' + p.code + "</option>";
      }).join("");
  }

  function codeLine(node, isSub) {
    var line = document.createElement("div");
    line.className = "code-line" + (isSub ? " code-sub" : "");
    var num = document.createElement("span");
    num.className = "code-num"; num.textContent = node.code;
    var label = document.createElement("span");
    label.className = "code-label"; label.textContent = node.label;
    var x = document.createElement("button");
    x.className = "code-x"; x.innerHTML = "&times;";
    x.title = isSub ? "Delete sub-code" : "Delete code and its sub-codes";
    x.addEventListener("click", async function () {
      if (!confirm("Delete " + node.code + " " + node.label +
                   (isSub ? "?" : "? Its sub-codes go too."))) return;
      try {
        await api("DELETE", "/api/charge-codes/" + node.id);
        await loadCodes();
        msg("codes-msg", "Deleted.", "ok");
      } catch (err) { msg("codes-msg", err.message, "err"); }
    });
    line.appendChild(num); line.appendChild(label); line.appendChild(x);
    return line;
  }

  $("btn-add-code").addEventListener("click", async function () {
    var code = $("c-code").value.trim();
    var label = $("c-label").value.trim();
    var parent = $("c-parent").value;
    if (!code || !label) { msg("codes-msg", "Enter both a code and a label.", "warn"); return; }
    busy("btn-add-code", true, "Adding…");
    try {
      await api("POST", "/api/charge-codes", {
        code: code, label: label, parentId: parent ? Number(parent) : null
      });
      $("c-code").value = ""; $("c-label").value = "";
      await loadCodes();
      msg("codes-msg", "Code added.", "ok");
    } catch (err) {
      msg("codes-msg", err.message, "err");
    } finally {
      busy("btn-add-code", false);
    }
  });

  async function loadCodes() {
    var data = await api("GET", "/api/charge-codes");
    codeTree = data.codes || [];
    buildChargeDatalist();
    renderCodes();
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  (async function init() {
    try {
      var me = await api("GET", "/api/me");
      $("me-label").textContent = me.name || me.email || "";
    } catch (e) { $("me-label").textContent = ""; }

    try {
      var s = await api("GET", "/api/settings");
      settings = s.settings;
      orgName = settings.orgName || orgName;
      renderSettings();
    } catch (err) { msg("form-msg", err.message, "err"); }

    try { await loadCodes(); } catch (err) { msg("codes-msg", err.message, "err"); }

    applyDefaults();
    renderItems();
    loadHistory();
  })();
})();
