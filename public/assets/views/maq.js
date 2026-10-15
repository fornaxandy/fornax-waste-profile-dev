// Waste profile / Material Assessment Questionnaire (MAQ) form — customer and staff.
import {
  supabase, state, esc, $, $$, run, toast, modal, confirmBox, loadLists, loadEwc, loadAdr, namesFor,
  page, loading, setTitle, fmtDate, fmtMoney, fmtNum, statusBadge, localCopy, friendlyError, hasRole,
} from "../lib.js";
import {
  SECTIONS, EDITABLE_COLS, defaultData, INTERNAL_FIELDS, STATUS_LABEL, UNIT_OPTIONS,
} from "../fields.js";
import { documentsPanel } from "./documents.js";

const NUMERIC = new Set(SECTIONS.flatMap((s) => s.fields).filter((f) => f.type === "number" || f.type === "int").map((f) => f.col));
const BOOL = new Set(SECTIONS.flatMap((s) => s.fields).filter((f) => f.type === "yesno").map((f) => f.col));

function pick(row) {
  const d = {};
  for (const c of EDITABLE_COLS) d[c] = row[c] ?? null;
  d.un_no = row.un_no ?? null;
  return normalise(d);
}
function normalise(d) {
  const o = {};
  for (const [k, v] of Object.entries(d)) {
    if (NUMERIC.has(k)) o[k] = (v === "" || v === null || v === undefined || isNaN(Number(v))) ? 0 : Number(v);
    else if (BOOL.has(k)) o[k] = v === true || v === "true";
    else o[k] = (v === "" || v === undefined) ? null : v;
  }
  return o;
}
const same = (a, b) => JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));

function canEditData(row) {
  const r = state.profile.role;
  if (row.deleted_at) return false;
  if (r === "admin") return true;
  if (r === "chemist") return ["started", "draft", "pending_approval"].includes(row.status);
  return ["started", "draft"].includes(row.status);   // customer, sales
}

export async function open(id) {
  loading();
  const staffView = state.profile.role !== "customer";
  const [rows, lists, ewc, adr] = await Promise.all([
    run(supabase.from("waste_profiles").select("*").eq("id", id)),
    loadLists(), loadEwc(), loadAdr(),
  ]);
  const row = rows[0];
  if (!row) { page(`<h1>Waste profile not found</h1><p>It may have been deleted.</p>`); return null; }

  const [sites, internal, customerRow, prices] = await Promise.all([
    run(supabase.from("collection_sites").select("*").eq("customer_id", row.customer_id).order("site_name")),
    staffView ? run(supabase.from("waste_profile_internal").select("*").eq("waste_profile_id", id)).then((r) => r[0] || {}) : null,
    staffView ? run(supabase.from("customers").select("id, customer_no, company_name").eq("id", row.customer_id)).then((r) => r[0]) : state.customer,
    staffView ? null : run(supabase.rpc("my_quote_prices")),
  ]);

  const ctx = {
    id, row, lists, ewc, adr, sites, internal, customerRow, staffView,
    saved: pick(row), current: null, cleared: false, dirty: false, aiFilled: new Set(),
    editable: canEditData(row), price: prices?.find((p) => p.waste_profile_id === id)?.unit_price ?? null,
  };
  ctx.current = { ...ctx.saved };

  const local = ctx.editable ? localCopy.get(id) : null;
  let localNote = "";
  if (local?.data && !same(local.data, ctx.saved)) {
    ctx.current = normalise({ ...ctx.saved, ...local.data });
    ctx.cleared = !!local.cleared;
    ctx.aiFilled = new Set(local.aiFilled || []);
    ctx.dirty = true;
    localNote = `Showing unsaved changes kept on this computer (last edited ${fmtDate(local.savedLocallyAt, true)}). They have not been saved as a draft yet.`;
  }

  render(ctx, localNote);
  return {
    beforeLeave: () => askToSave(ctx, false),
    beforeLogout: () => askToSave(ctx, true),
  };
}

// ---------------------------------------------------------------- leaving with unsaved changes
async function askToSave(ctx, loggingOut) {
  if (!ctx.editable || !ctx.dirty) return true;
  const choice = await modal({
    title: "Do you want to save changes?",
    body: `<p>${loggingOut
      ? "You have unsaved changes. If you do not save them, they will be removed from this computer when you sign out."
      : "You have unsaved changes. If you do not save them now, they stay on this computer only until you sign out."}</p>`,
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "Don't save", value: "discard" }, { label: "Save as draft", value: "save", kind: "primary" }],
  });
  if (choice === "save") return await saveDraft(ctx, { skipConfirm: false });
  return choice === "discard";
}

// ---------------------------------------------------------------- rendering
function render(ctx, localNote = "") {
  const { row, staffView, customerRow } = ctx;
  setTitle(row.reference);
  const unit = UNIT_OPTIONS.find((u) => u.code === row.unit_of_measure);
  const back = staffView ? "#/s/profiles" : "#/profiles";
  const lockedMsg = !ctx.editable && !row.deleted_at ? lockMessage(row) : "";

  const m = page(`
    <p class="crumbs"><a href="${back}">← Waste profiles</a></p>
    <div class="page-head">
      <div>
        <h1>${esc(row.reference)} ${statusBadge(row.status, STATUS_LABEL)} ${row.archived_at ? '<span class="badge">Archived</span>' : ""}</h1>
        <p class="muted">Hazardous waste · Unit of measure: <strong>${esc(unit?.label || row.unit_of_measure)}</strong>
          ${staffView ? ` · Customer: <a href="#/s/customer/${customerRow.id}">${esc(customerRow.company_name)} (${esc(customerRow.customer_no)})</a>` : ""}
          · Last updated ${fmtDate(row.updated_at, true)}</p>
        ${row.submitted_at ? `<p class="muted">Submitted ${fmtDate(row.submitted_at, true)}${row.approved_at ? ` · Approved ${fmtDate(row.approved_at, true)}` : ""}</p>` : ""}
        ${ctx.price !== null ? `<p><strong>Accepted price: ${fmtMoney(ctx.price)} per ${esc(row.unit_of_measure)}</strong></p>` : ""}
      </div>
      <div class="head-actions" id="head-actions"></div>
    </div>
    ${localNote ? `<div class="banner banner-warn" id="local-banner">${esc(localNote)}</div>` : ""}
    ${lockedMsg ? `<div class="banner">${esc(lockedMsg)}</div>` : ""}
    <div class="maq-layout">
      <form id="maq-form" class="maq-form" novalidate>
        ${SECTIONS.map((s) => sectionHtml(ctx, s)).join("")}
        ${staffView ? internalHtml(ctx) : ""}
      </form>
      <aside class="maq-side">
        <div id="docs-panel"></div>
        <div class="panel"><h2>Questions about this questionnaire</h2><div id="msg-list" class="msg-list"></div>
          <form id="msg-form" class="msg-form"><label for="msg-body" class="sr-only">Message</label>
            <textarea id="msg-body" rows="3" maxlength="5000" placeholder="Ask a question about this waste profile…"></textarea>
            <button class="btn btn-primary" type="submit">Send</button></form>
        </div>
      </aside>
    </div>
    <div class="sticky-actions" id="actions"></div>
  `);

  wireForm(ctx, m);
  renderActions(ctx);
  loadMessages(ctx);
  documentsPanel($("#docs-panel"), ctx, (values, filledCols, mode) => applyAi(ctx, values, filledCols, mode));
}

function lockMessage(row) {
  if (row.status === "pending_approval") return "This waste profile has been submitted and is waiting for approval. It cannot be changed.";
  if (row.status === "accepted") return "This waste profile has been approved and cannot be changed.";
  return "You cannot change this waste profile.";
}

function sectionHtml(ctx, s) {
  return `<fieldset class="section" id="sec-${s.id}"><legend>${esc(s.title)}</legend>
    ${s.intro ? `<p class="muted">${esc(s.intro)}</p>` : ""}
    <div class="grid ${s.id === "hp" ? "grid-hp" : ""}">${s.fields.map((f) => fieldHtml(ctx, f)).join("")}</div></fieldset>`;
}

function fieldHtml(ctx, f) {
  const v = ctx.current[f.col];
  const dis = ctx.editable ? "" : "disabled";
  const id = `f_${f.col}`;
  const ai = ctx.aiFilled.has(f.col) ? " ai-filled" : "";
  let input = "";
  switch (f.type) {
    case "text": input = `<input id="${id}" name="${f.col}" type="text" value="${esc(v)}" ${f.max ? `maxlength="${f.max}"` : ""} ${dis}>`; break;
    case "textarea": input = `<textarea id="${id}" name="${f.col}" rows="3" ${dis}>${esc(v)}</textarea>`; break;
    case "number": input = `<input id="${id}" name="${f.col}" type="number" step="any" ${f.min !== undefined ? `min="${f.min}"` : ""} ${f.max !== undefined ? `max="${f.max}"` : ""} value="${esc(v)}" ${dis}>`; break;
    case "int": input = `<input id="${id}" name="${f.col}" type="number" step="1" min="${f.min ?? 0}" ${f.max ? `max="${f.max}"` : ""} value="${esc(v)}" ${dis}>`; break;
    case "date": input = `<input id="${id}" name="${f.col}" type="date" value="${esc(v)}" ${dis}>`; break;
    case "yesno":
      return `<div class="field field-yesno${ai}" data-col="${f.col}"><span class="label" id="${id}_l">${esc(f.label)}</span>
        <div class="seg" role="radiogroup" aria-labelledby="${id}_l">
          <label><input type="radio" name="${f.col}" value="false" ${!v ? "checked" : ""} ${dis}> No</label>
          <label><input type="radio" name="${f.col}" value="true" ${v ? "checked" : ""} ${dis}> Yes</label></div></div>`;
    case "select":
      input = `<select id="${id}" name="${f.col}" ${dis}>${f.options.map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`; break;
    case "list": {
      const opts = ctx.lists.byList[f.list] || [];
      input = `<select id="${id}" name="${f.col}" ${dis}><option value="">— Select —</option>${opts.map((o) =>
        `<option value="${esc(o.code)}" ${o.code === v ? "selected" : ""}>${esc(o.code)}${f.showDescription && o.description && o.description !== o.code ? ` – ${esc(o.description)}` : (f.list === "packing_group" && o.description !== o.code ? ` – ${esc(o.description)}` : "")}</option>`).join("")}</select>`;
      break;
    }
    case "equipment": {
      const groups = {};
      for (const e of ctx.lists.equip) (groups[e.equipment_group] ||= []).push(e);
      input = `<select id="${id}" name="${f.col}" ${dis}><option value="">— Select —</option>${Object.entries(groups).map(([g, items]) =>
        `<optgroup label="${esc(g)}">${items.map((e) => `<option value="${esc(e.equipment_no)}" ${e.equipment_no === v ? "selected" : ""}>${esc(e.display_name)}</option>`).join("")}</optgroup>`).join("")}</select>`;
      break;
    }
    case "site": {
      const sites = ctx.sites.filter((s) => s.is_active || s.id === v);
      input = `<select id="${id}" name="${f.col}" ${dis}><option value="">— Select —</option>${sites.map((s) =>
        `<option value="${s.id}" ${s.id === v ? "selected" : ""}>${esc(s.site_name)} – ${esc(s.postcode)}</option>`).join("")}</select>`;
      if (!sites.length) input += `<p class="hint">No sites yet. ${state.profile.role === "customer" ? `<a href="#/company">Add a collection site</a>.` : "The customer can add sites under Company details."}</p>`;
      break;
    }
    case "ewc": {
      const cur = ctx.ewc.find((e) => e.ewc_code === v);
      input = `<input id="${id}" name="${f.col}" list="ewc-list" autocomplete="off" value="${esc(cur ? `${cur.ewc_code} – ${cur.name}` : (v || ""))}" ${dis}
        placeholder="e.g. 16 05 06* or laboratory chemicals">
        <datalist id="ewc-list">${ctx.ewc.map((e) => `<option value="${esc(e.ewc_code)} – ${esc(e.name)}"></option>`).join("")}</datalist>
        <p class="hint" id="ewc-full">${cur?.official_description ? esc(cur.official_description) : ""}</p>`;
      break;
    }
    case "un": {
      const uns = uniqueUn(ctx.adr);
      input = `<input id="${id}" name="${f.col}" list="un-list" autocomplete="off" inputmode="numeric" value="${esc(v ? `${v} – ${uns.get(v) || ""}` : "")}" ${dis} placeholder="e.g. 1993">
        <datalist id="un-list">${[...uns].map(([u, n]) => `<option value="${esc(u)} – ${esc(n)}"></option>`).join("")}</datalist>`;
      break;
    }
    case "adr": {
      input = `<select id="${id}" name="${f.col}" ${dis}>${adrOptions(ctx, ctx.current.un_no, v)}</select>`;
      break;
    }
    case "readonly": {
      input = `<output id="${id}" class="readonly">${esc(readonlyValue(ctx, f.col)) || "—"}</output>`;
      break;
    }
  }
  const unit = f.unitSuffix ? ` (${esc(ctx.row.unit_of_measure)})` : "";
  const hidden = f.showIf && !f.showIf.in.includes(ctx.current[f.showIf.col]) ? " hidden" : "";
  return `<div class="field${ai}" data-col="${f.col}"${hidden}><label for="${id}">${esc(f.label)}${unit}</label>${input}${f.hint ? `<p class="hint">${esc(f.hint)}</p>` : ""}</div>`;
}

let unCache = null;
function uniqueUn(adr) {
  if (unCache) return unCache;
  unCache = new Map();
  for (const a of adr) if (!unCache.has(a.un_no)) unCache.set(a.un_no, (a.proper_shipping_name || "").trim());
  return unCache;
}
function adrOptions(ctx, un, selected) {
  if (!un) return `<option value="">Choose a UN number first</option>`;
  const list = ctx.adr.filter((a) => a.un_no === un);
  return `<option value="">— Select —</option>` + list.map((a) =>
    `<option value="${esc(a.adr_code)}" ${a.adr_code === selected ? "selected" : ""}>${esc(a.adr_code)} – ${esc(a.name_description)}${a.class_summary ? ` (class ${esc(a.class_summary)})` : ""}</option>`).join("");
}
function readonlyValue(ctx, col) {
  const a = ctx.adr.find((x) => x.adr_code === ctx.current.adr_code);
  if (!a) return "";
  return col === "proper_shipping_name" ? (a.proper_shipping_name || "").trim() : (a.class_summary || "");
}

// ---------------------------------------------------------------- staff-only fields
function internalHtml(ctx) {
  const canEdit = hasRole("admin", "sales", "chemist") && !ctx.row.deleted_at;
  const canPrice = hasRole("admin", "sales");
  const i = ctx.internal || {};
  return `<fieldset class="section section-internal"><legend>Internal only (not visible to the customer)</legend>
    <div class="grid">${INTERNAL_FIELDS.map((f) => {
      const v = i[f.col];
      const dis = canEdit && (f.col !== "unit_price" || canPrice) ? "" : "disabled";
      const id = `i_${f.col}`;
      let input;
      if (f.type === "bool") input = `<select id="${id}" name="${f.col}" ${dis}><option value="false" ${!v ? "selected" : ""}>No</option><option value="true" ${v ? "selected" : ""}>Yes</option></select>`;
      else if (f.type.startsWith("list:")) {
        const opts = ctx.lists.byList[f.type.slice(5)] || [];
        input = `<select id="${id}" name="${f.col}" ${dis}><option value="">—</option>${opts.map((o) => `<option ${o.code === v ? "selected" : ""}>${esc(o.code)}</option>`).join("")}</select>`;
      } else if (f.type === "date") input = `<input id="${id}" name="${f.col}" type="date" value="${esc(v)}" ${dis}>`;
      else if (f.type === "number" || f.type === "int") input = `<input id="${id}" name="${f.col}" type="number" step="${f.type === "int" ? 1 : "any"}" min="0" value="${esc(v)}" ${dis}>`;
      else input = `<input id="${id}" name="${f.col}" type="text" value="${esc(v)}" ${f.col === "comments" ? 'maxlength="250"' : ""} ${dis}>`;
      return `<div class="field"><label for="${id}">${esc(f.label)}${f.col === "unit_price" ? ` per ${esc(ctx.row.unit_of_measure)}` : ""}</label>${input}</div>`;
    }).join("")}</div>
    ${canEdit ? `<button type="button" class="btn" id="save-internal">Save internal fields</button>` : ""}
  </fieldset>`;
}

async function saveInternal(ctx) {
  const payload = {};
  for (const f of INTERNAL_FIELDS) {
    const el = document.getElementById(`i_${f.col}`);
    if (!el || el.disabled) continue;
    let v = el.value.trim();
    if (f.type === "bool") v = v === "true";
    else if (f.type === "number" || f.type === "int") v = v === "" ? (f.col === "unit_price" ? null : 0) : Number(v);
    else if (v === "") v = null;
    payload[f.col] = v;
  }
  await run(supabase.from("waste_profile_internal").update(payload).eq("waste_profile_id", ctx.id), "Internal fields saved.");
  Object.assign(ctx.internal, payload);
}

// ---------------------------------------------------------------- form behaviour
function wireForm(ctx, root) {
  const form = $("#maq-form", root);
  const onChange = (e) => {
    const el = e.target;
    const col = el.name;
    if (!col || el.closest(".section-internal")) return;
    let v = el.value;
    if (el.type === "radio") v = v === "true";
    if (col === "ewc_code") {
      const code = v.split(" – ")[0].trim();
      const hit = ctx.ewc.find((x) => x.ewc_code === code);
      $("#ewc-full").textContent = hit?.official_description || (code && !hit ? "Not on the list of accepted EWC codes." : "");
      el.classList.toggle("invalid", !!code && !hit);
      v = hit ? hit.ewc_code : (code ? code : null);
      if (e.type === "change" && hit) el.value = `${hit.ewc_code} – ${hit.name}`;
    }
    if (col === "un_no") {
      const un = v.split(" – ")[0].trim();
      const known = uniqueUn(ctx.adr).has(un);
      el.classList.toggle("invalid", !!un && !known);
      v = known ? un : null;
      if (e.type === "change" && known) el.value = `${un} – ${uniqueUn(ctx.adr).get(un)}`;
      if (v !== ctx.current.un_no) {
        ctx.current.adr_code = null;
        $("#f_adr_code").innerHTML = adrOptions(ctx, v, null);
        refreshReadonly(ctx);
      }
    }
    ctx.current[col] = v;
    if (col === "adr_code") refreshReadonly(ctx);
    ctx.aiFilled.delete(col);
    el.closest(".field")?.classList.remove("ai-filled");
    applyShowIf(ctx);
    markDirty(ctx);
  };
  form.addEventListener("input", onChange);
  form.addEventListener("change", onChange);
  $("#save-internal")?.addEventListener("click", () => saveInternal(ctx));
  $("#msg-form").addEventListener("submit", (e) => { e.preventDefault(); sendMessage(ctx); });
}

function refreshReadonly(ctx) {
  for (const col of ["proper_shipping_name", "adr_class_summary"]) {
    const o = document.getElementById(`f_${col}`);
    if (o) o.textContent = readonlyValue(ctx, col) || "—";
  }
}
function applyShowIf(ctx) {
  for (const s of SECTIONS) for (const f of s.fields) if (f.showIf) {
    const el = document.querySelector(`.field[data-col="${f.col}"]`);
    if (el) el.hidden = !f.showIf.in.includes(ctx.current[f.showIf.col]);
  }
}

let localTimer = null;
function markDirty(ctx) {
  ctx.dirty = !same(ctx.current, ctx.saved) || ctx.cleared;
  clearTimeout(localTimer);
  localTimer = setTimeout(() => {
    if (ctx.dirty) localCopy.set(ctx.id, { data: ctx.current, cleared: ctx.cleared, aiFilled: [...ctx.aiFilled] });
    else localCopy.remove(ctx.id);
  }, 300);
  renderActions(ctx);
}

// mode: "all" fills every answer found; "gaps" only fills fields still at their default;
// "replace" clears the form first (the document describes a different waste stream).
function applyAi(ctx, values, cols, mode = "all") {
  if (!ctx.editable) return;
  const defaults = normalise(defaultData());
  if (mode === "replace") { ctx.current = { ...defaults }; ctx.aiFilled.clear(); }
  const isGap = (k) => JSON.stringify(normalise({ [k]: ctx.current[k] })[k]) === JSON.stringify(defaults[k] ?? null);
  const used = [];
  for (const [k, v] of Object.entries(values)) {
    if (!(EDITABLE_COLS.includes(k) || k === "un_no")) continue;
    if (mode === "gaps" && !isGap(k)) continue;
    if (mode === "gaps" && k === "adr_code" && !used.includes("un_no") && ctx.current.un_no) continue;
    ctx.current[k] = v;
    used.push(k);
  }
  ctx.current = normalise(ctx.current);
  for (const c of cols) if (used.includes(c)) ctx.aiFilled.add(c);
  markDirty(ctx);
  localCopy.set(ctx.id, { data: ctx.current, cleared: ctx.cleared, aiFilled: [...ctx.aiFilled] });
  const msg = mode === "gaps"
    ? (used.length ? `${used.length} empty field${used.length === 1 ? "" : "s"} filled from your documents. Existing answers were kept. Please check the highlighted fields, then save as draft.`
      : "No empty fields could be filled from the documents. Existing answers were kept.")
    : mode === "replace"
      ? "The form was cleared and filled from the new document. Please check the highlighted fields, then save as draft."
      : "Fields filled from your documents are highlighted. Please check them, then save as draft.";
  render(ctx, msg);
}

// ---------------------------------------------------------------- actions
function renderActions(ctx) {
  const { row } = ctx;
  const r = state.profile.role;
  const btn = (id, label, kind = "") => `<button type="button" class="btn ${kind}" id="${id}">${esc(label)}</button>`;
  const a = [];
  if (ctx.editable) {
    a.push(`<span class="save-state">${ctx.dirty ? "Unsaved changes (kept on this computer)" : (row.status === "started" ? "Not saved as a draft yet" : "All changes saved")}</span>`);
    a.push(btn("act-clear", "Clear form"));
    if (row.status === "draft" || ctx.dirty) a.push(btn("act-latest", "Load latest saved version"));
    a.push(btn("act-save", "Save as draft"));
    if (["started", "draft"].includes(row.status) && ["customer", "sales", "admin"].includes(r)) a.push(btn("act-submit", r === "customer" ? "Submit for approval" : "Submit for approval (on customer's behalf)", "btn-primary"));
  }
  if (["chemist", "admin"].includes(r) && row.status === "pending_approval" && !row.deleted_at) {
    a.push(btn("act-reject", "Reject (back to Draft)"));
    a.push(btn("act-approve", "Approve", "btn-primary"));
  }
  if (["chemist", "admin"].includes(r) && row.status === "accepted" && !row.deleted_at) a.push(btn("act-reset", "Reset to Started"));
  $("#actions").innerHTML = a.join("");

  const head = [];
  if (!row.deleted_at) {
    head.push(btn("act-archive", row.archived_at ? "Unarchive" : "Archive", "btn-small"));
    head.push(btn("act-delete", "Delete", "btn-small btn-danger"));
  }
  $("#head-actions").innerHTML = head.join("");

  const on = (id, fn) => document.getElementById(id)?.addEventListener("click", fn);
  on("act-save", () => saveDraft(ctx, {}));
  on("act-submit", () => submit(ctx));
  on("act-latest", () => loadLatest(ctx));
  on("act-clear", () => clearForm(ctx));
  on("act-approve", () => setStatus(ctx, "accepted", "Waste profile approved."));
  on("act-reject", () => reject(ctx));
  on("act-reset", () => resetToStarted(ctx));
  on("act-archive", () => toggleArchive(ctx));
  on("act-delete", () => remove(ctx));
}

function payload(ctx) {
  const p = {};
  for (const c of EDITABLE_COLS) p[c] = ctx.current[c];
  p.un_no = ctx.current.un_no;
  const n = normalise(p);
  if (n.waste_description && n.waste_description.length > 100) n.waste_description = n.waste_description.slice(0, 100);
  return n;
}

function validate(ctx) {
  const ewc = ctx.current.ewc_code;
  if (ewc && !ctx.ewc.some((e) => e.ewc_code === ewc)) {
    toast("The EWC code is not on the list of accepted codes. Choose one from the list or leave it empty.", "error");
    return false;
  }
  for (const s of SECTIONS) for (const f of s.fields) {
    if ((f.type === "number" || f.type === "int") && ctx.current[f.col] !== null) {
      const v = Number(ctx.current[f.col]);
      if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) {
        toast(`${f.label}: must be between ${f.min} and ${f.max}.`, "error");
        document.getElementById(`f_${f.col}`)?.focus();
        return false;
      }
    }
  }
  return true;
}

async function refreshRow(ctx) {
  const rows = await run(supabase.from("waste_profiles").select("*").eq("id", ctx.id));
  ctx.row = rows[0];
  ctx.saved = pick(ctx.row);
  ctx.current = { ...ctx.saved };
  ctx.editable = canEditData(ctx.row);
}

async function saveDraft(ctx, { skipConfirm }) {
  if (!validate(ctx)) return false;
  if (!skipConfirm && ctx.row.status === "draft") {
    const ok = await confirmBox("Replace the saved draft?",
      "Saving will replace the previously saved draft, which may have been saved by another person in your company.", "Save as draft");
    if (!ok) return false;
  }
  const wasCleared = ctx.cleared && same(ctx.current, defaultData());
  const status = wasCleared ? "started" : "draft";
  const { error } = await supabase.from("waste_profiles").update({ ...payload(ctx), status }).eq("id", ctx.id);
  if (error) { toast(friendlyError(error), "error"); return false; }
  localCopy.remove(ctx.id);
  ctx.cleared = false; ctx.dirty = false; ctx.aiFilled.clear();
  await refreshRow(ctx);
  toast(wasCleared ? "This document has been reset to Started." : "Saved as draft. It can now be opened from any computer.");
  render(ctx);
  return true;
}

async function submit(ctx) {
  if (!validate(ctx)) return;
  const res = await modal({
    title: "Submit for approval",
    body: `<p>You are submitting this waste profile exactly as shown on screen. This replaces any draft saved by anyone else.
      After submitting, it cannot be changed unless it is returned to you.</p>
      <label class="check"><input type="checkbox" id="declare"> I confirm the waste is as described to the best of my knowledge.</label>`,
    buttons: [{ label: "Cancel", value: false }, {
      label: "Submit", kind: "primary", value: true,
      validate: (w) => { const c = w.querySelector("#declare"); if (!c.checked) { c.focus(); toast("Please tick the confirmation to submit.", "error"); return false; } return true; },
    }],
  });
  if (!res) return;
  const { error } = await supabase.from("waste_profiles")
    .update({ ...payload(ctx), status: "pending_approval", declaration_confirmed: true }).eq("id", ctx.id);
  if (error) { toast(friendlyError(error), "error"); return; }
  localCopy.remove(ctx.id);
  ctx.dirty = false; ctx.cleared = false; ctx.aiFilled.clear();
  await refreshRow(ctx);
  toast("Submitted for approval. We will review it.");
  render(ctx);
}

async function loadLatest(ctx) {
  const ok = await confirmBox("Load the latest saved version?", "Loading the latest saved version will delete any unsaved changes.", "Load latest saved version", "danger");
  if (!ok) return;
  localCopy.remove(ctx.id);
  await refreshRow(ctx);
  ctx.dirty = false; ctx.cleared = false; ctx.aiFilled.clear();
  render(ctx);
}

async function clearForm(ctx) {
  const ok = await confirmBox("Clear the form?", "All answers will be reset to their defaults. Nothing is saved until you save as draft.", "Clear form", "danger");
  if (!ok) return;
  ctx.current = normalise(defaultData());
  ctx.cleared = true; ctx.aiFilled.clear();
  markDirty(ctx);
  localCopy.set(ctx.id, { data: ctx.current, cleared: true, aiFilled: [] });
  render(ctx, "The form has been cleared. Save as draft to reset the saved version to Started.");
}

async function setStatus(ctx, status, msg) {
  if (ctx.dirty && ctx.editable) {
    const ok = await confirmBox("Unsaved changes", "You have unsaved changes on this form. They will be saved first.", "Save and continue");
    if (!ok) return;
    const { error } = await supabase.from("waste_profiles").update(payload(ctx)).eq("id", ctx.id);
    if (error) { toast(friendlyError(error), "error"); return; }
  }
  const { error } = await supabase.from("waste_profiles").update({ status }).eq("id", ctx.id);
  if (error) { toast(friendlyError(error), "error"); return; }
  localCopy.remove(ctx.id); ctx.dirty = false;
  await refreshRow(ctx);
  toast(msg);
  render(ctx);
}

async function reject(ctx) {
  const reason = await modal({
    title: "Reject and return to the customer",
    body: `<p>The waste profile goes back to Draft so the customer can change it. Your reason is posted in its message thread.</p>
      <label for="rej">Reason *</label><textarea id="rej" rows="4" maxlength="4000"></textarea>`,
    buttons: [{ label: "Cancel", value: null }, {
      label: "Reject", kind: "danger",
      validate: (w) => { const t = w.querySelector("#rej"); if (!t.value.trim()) { t.focus(); return false; } return true; },
      value: (w) => w.querySelector("#rej").value.trim(),
    }],
  });
  if (!reason) return;
  await run(supabase.from("waste_profile_messages").insert({ waste_profile_id: ctx.id, sender_id: state.user.id, body: `Returned for changes: ${reason}` }));
  await setStatus(ctx, "draft", "Returned to the customer as Draft.");
  loadMessages(ctx);
}

async function resetToStarted(ctx) {
  const ok = await confirmBox("Reset to Started?", "The approval is removed and the waste profile can be edited again. Any quote that includes it is not changed automatically.", "Reset to Started", "danger");
  if (ok) await setStatus(ctx, "started", "Reset to Started.");
}

async function toggleArchive(ctx) {
  const archived = !ctx.row.archived_at;
  await run(supabase.from("waste_profiles").update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", ctx.id),
    archived ? "Archived." : "Moved back from the archive.");
  await refreshRow(ctx);
  render(ctx);
}

async function remove(ctx) {
  const ok = await confirmBox("Delete this waste profile?",
    "It will disappear from your lists. It is kept for 90 days in case you need it back — send us a message to recover it.", "Delete", "danger");
  if (!ok) return;
  const { error } = await supabase.rpc("delete_waste_profile", { p_id: ctx.id });
  if (error) { toast(friendlyError(error), "error"); return; }
  localCopy.remove(ctx.id);
  ctx.dirty = false;
  toast("Waste profile deleted.");
  location.hash = state.profile.role === "customer" ? "#/profiles" : "#/s/profiles";
}

// ---------------------------------------------------------------- MAQ messages
async function loadMessages(ctx) {
  const msgs = await run(supabase.from("waste_profile_messages").select("*").eq("waste_profile_id", ctx.id).order("created_at"));
  const name = await namesFor(msgs.map((m) => m.sender_id));
  const box = $("#msg-list");
  if (!box) return;
  box.innerHTML = msgs.length ? msgs.map((m) => `<div class="msg ${m.sender_id === state.user.id ? "msg-mine" : ""}">
      <div class="msg-meta">${esc(m.sender_id === state.user.id ? "You" : name(m.sender_id))} · ${fmtDate(m.created_at, true)}</div>
      <div class="msg-body">${esc(m.body)}</div></div>`).join("")
    : `<p class="muted">No messages yet.</p>`;
  box.scrollTop = box.scrollHeight;
  if (ctx.row.deleted_at) $("#msg-form").hidden = true;
}
async function sendMessage(ctx) {
  const t = $("#msg-body");
  const body = t.value.trim();
  if (!body) return;
  await run(supabase.from("waste_profile_messages").insert({ waste_profile_id: ctx.id, sender_id: state.user.id, body }), "Message sent.");
  t.value = "";
  loadMessages(ctx);
}

// ---------------------------------------------------------------- new waste stream (customer or sales)
export async function newWasteStream(customerId = null) {
  const { WASTE_TYPES } = await import("../fields.js");
  const res = await modal({
    title: "New waste stream",
    body: `<div class="field"><label for="nw-type">What does it relate to?</label>
        <select id="nw-type">${WASTE_TYPES.map((w) => `<option value="${w.code}" ${w.enabled ? "" : "disabled"}>${esc(w.label)}</option>`).join("")}</select></div>
      <div class="field"><label for="nw-unit">Unit of measure</label>
        <select id="nw-unit"><option value="">— Select —</option>${UNIT_OPTIONS.map((u) => `<option value="${u.code}">${esc(u.label)}</option>`).join("")}</select>
        <p class="hint">Prices will be quoted per this unit. It cannot be changed later.</p></div>`,
    buttons: [{ label: "Cancel", value: null }, {
      label: "Create", kind: "primary",
      validate: (w) => { const u = w.querySelector("#nw-unit"); if (!u.value) { u.focus(); u.classList.add("invalid"); return false; } return true; },
      value: (w) => ({ waste_type: w.querySelector("#nw-type").value, unit: w.querySelector("#nw-unit").value }),
    }],
  });
  if (!res) return;
  const insert = { waste_type: res.waste_type, unit_of_measure: res.unit, status: "started", customer_id: customerId || state.profile.customer_id };
  const rows = await run(supabase.from("waste_profiles").insert(insert).select("id"));
  location.hash = (state.profile.role === "customer" ? "#/profile/" : "#/s/profile/") + rows[0].id;
}
export { fmtNum };
