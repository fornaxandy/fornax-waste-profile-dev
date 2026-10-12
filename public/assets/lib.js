import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// ---------------------------------------------------------------- session state
export const state = { user: null, profile: null, customer: null, lists: null };
export const isStaff = () => ["admin", "sales", "chemist"].includes(state.profile?.role);
export const hasRole = (...r) => r.includes(state.profile?.role);

// ---------------------------------------------------------------- html helpers
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function fmtDate(d, withTime = false) {
  if (!d) return "";
  const dt = new Date(d);
  return withTime
    ? dt.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
export const fmtMoney = (n) => (n === null || n === undefined || n === "") ? "" :
  Number(n).toLocaleString("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 4 });
export const fmtNum = (n) => (n === null || n === undefined) ? "" : Number(n).toLocaleString("en-GB", { maximumFractionDigits: 3 });

export function statusBadge(status, labels) {
  return `<span class="badge badge-${esc(status)}">${esc(labels[status] || status)}</span>`;
}

// ---------------------------------------------------------------- errors and notices
export function friendlyError(error) {
  const m = error?.message || String(error || "Something went wrong.");
  if (/JWT|session/i.test(m)) return "Your session has expired. Please sign in again.";
  if (/row-level security/i.test(m)) return "You do not have permission to do that.";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Could not connect. Check your connection and try again.";
  return m;
}

export function toast(msg, kind = "ok") {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 8000 : 4000);
}

export async function run(promise, okMsg) {
  const { data, error } = await promise;
  if (error) { toast(friendlyError(error), "error"); throw error; }
  if (okMsg) toast(okMsg);
  return data;
}

// ---------------------------------------------------------------- dialogs
// modal({ title, body (html), buttons: [{label, value, kind}] }) -> Promise<value | null>
export function modal({ title, body = "", buttons = [{ label: "OK", value: true, kind: "primary" }], wide = false, onOpen }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <div class="modal${wide ? " modal-wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">${esc(title)}</h2>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">${buttons.map((b, i) =>
          `<button type="button" class="btn ${b.kind ? "btn-" + b.kind : ""}" data-i="${i}">${esc(b.label)}</button>`).join("")}</div>
      </div>`;
    const close = (v) => { wrap.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    wrap.addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]");
      if (b) {
        const def = buttons[+b.dataset.i];
        if (def.validate && !def.validate(wrap)) return;
        close(typeof def.value === "function" ? def.value(wrap) : def.value);
      } else if (e.target === wrap) close(null);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(wrap);
    onOpen?.(wrap);
    (wrap.querySelector("input, textarea, select") || wrap.querySelector(".btn-primary") || wrap.querySelector("button"))?.focus();
  });
}

export const confirmBox = (title, text, okLabel = "Confirm", kind = "primary") =>
  modal({ title, body: `<p>${esc(text)}</p>`, buttons: [{ label: "Cancel", value: false }, { label: okLabel, value: true, kind }] });

// Form-in-a-dialog helper: fields [{name,label,type,value,required,options,hint}] -> object | null
export function formModal(title, fields, okLabel = "Save", intro = "") {
  const body = (intro ? `<p class="muted">${esc(intro)}</p>` : "") + fields.map((f) => {
    const id = `mf_${f.name}`;
    let input;
    if (f.type === "select") {
      input = `<select id="${id}" name="${f.name}">${f.options.map((o) => {
        const v = typeof o === "object" ? o.value : o, l = typeof o === "object" ? o.label : o;
        return `<option value="${esc(v)}" ${String(v) === String(f.value ?? "") ? "selected" : ""} ${o.disabled ? "disabled" : ""}>${esc(l)}</option>`;
      }).join("")}</select>`;
    } else if (f.type === "textarea") {
      input = `<textarea id="${id}" name="${f.name}" rows="${f.rows || 5}" maxlength="${f.max || 5000}">${esc(f.value)}</textarea>`;
    } else {
      input = `<input id="${id}" name="${f.name}" type="${f.type || "text"}" value="${esc(f.value)}" ${f.max ? `maxlength="${f.max}"` : ""} ${f.step ? `step="${f.step}"` : ""}>`;
    }
    return `<div class="field"><label for="${id}">${esc(f.label)}${f.required ? " *" : ""}</label>${input}${f.hint ? `<p class="hint">${esc(f.hint)}</p>` : ""}</div>`;
  }).join("");
  return modal({
    title, body,
    buttons: [{ label: "Cancel", value: null }, {
      label: okLabel, kind: "primary",
      validate: (w) => {
        for (const f of fields) {
          const el = w.querySelector(`[name="${f.name}"]`);
          if (f.required && !el.value.trim()) { el.focus(); el.classList.add("invalid"); return false; }
        }
        return true;
      },
      value: (w) => Object.fromEntries(fields.map((f) => [f.name, w.querySelector(`[name="${f.name}"]`).value.trim()])),
    }],
  });
}

// ---------------------------------------------------------------- reference lists (loaded once)
export async function loadLists() {
  if (state.lists) return state.lists;
  const [vals, equip, services] = await Promise.all([
    run(supabase.from("ref_list_values").select("list_name, code, description, sort_order").order("sort_order")),
    run(supabase.from("ref_equipment").select("equipment_no, equipment_group, description, display_name").order("equipment_group").order("equipment_no")),
    run(supabase.from("ref_services").select("*").order("service_no")),
  ]);
  const byList = {};
  for (const v of vals) (byList[v.list_name] ||= []).push(v);
  state.lists = { byList, equip, services };
  return state.lists;
}

// Supabase returns at most 1000 rows per request; this pages through larger tables.
export async function fetchAll(table, columns, orderCol) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await run(supabase.from(table).select(columns).order(orderCol).range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

let ewcCache = null, adrCache = null;
export async function loadEwc() {
  ewcCache ||= await fetchAll("ref_ewc", "ewc_code, name, official_description", "ewc_code");
  return ewcCache;
}
export async function loadAdr() {
  adrCache ||= await fetchAll("ref_adr", "adr_code, un_no, name_description, proper_shipping_name, class_summary", "adr_code");
  return adrCache;
}

// Names of people (staff names are shown to customers as "Our team").
const nameCache = new Map();
export async function namesFor(ids) {
  const missing = [...new Set(ids.filter((i) => i && !nameCache.has(i)))];
  if (missing.length) {
    const { data } = await supabase.from("user_profiles").select("user_id, full_name, email, role").in("user_id", missing);
    for (const p of data || []) nameCache.set(p.user_id, p);
  }
  return (id) => {
    const p = nameCache.get(id);
    if (!p) return "Our team";
    if (state.profile.role === "customer" && p.role !== "customer") return "Our team";
    return p.full_name || p.email;
  };
}

// ---------------------------------------------------------------- page chrome
export function setTitle(t) { document.title = t ? `${t} · Portal` : "Portal"; }
export function page(html) { const m = document.getElementById("main"); m.innerHTML = html; m.focus?.(); window.scrollTo(0, 0); return m; }
export const loading = () => page(`<p class="muted">Loading…</p>`);
export const empty = (text) => `<p class="empty">${esc(text)}</p>`;

// ---------------------------------------------------------------- local (this computer only) copies of unsaved MAQ work
const localKey = (id) => `maq_local_${state.user?.id}_${id}`;
export const localCopy = {
  get(id) { try { return JSON.parse(localStorage.getItem(localKey(id)) || "null"); } catch { return null; } },
  set(id, value) { try { localStorage.setItem(localKey(id), JSON.stringify({ ...value, savedLocallyAt: new Date().toISOString() })); } catch { /* storage unavailable */ } },
  remove(id) { try { localStorage.removeItem(localKey(id)); } catch { /* ignore */ } },
  clearAllForUser() {
    try {
      const prefix = `maq_local_${state.user?.id}_`;
      for (const k of Object.keys(localStorage)) if (k.startsWith(prefix)) localStorage.removeItem(k);
    } catch { /* ignore */ }
  },
};

// ---------------------------------------------------------------- download helper
export function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
