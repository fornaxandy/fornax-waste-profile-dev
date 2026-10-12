// Customer screens: home, waste profile sections, company details and collection sites.
import { supabase, state, esc, run, toast, page, loading, setTitle, fmtDate, fmtMoney, fmtNum, statusBadge, empty, formModal, confirmBox } from "../lib.js";
import { STATUS_LABEL, QUOTE_STATUS_LABEL } from "../fields.js";
import { newWasteStream } from "./maq.js";

const PROFILE_COLS = "id, reference, customer_id, status, waste_description, ewc_code, unit_of_measure, quantity, physical_form, archived_at, updated_at, submitted_at";

// Shared table of waste profiles (customer and staff lists).
export function profileTable(rows, { prices = new Map(), customers = null, link = "#/profile/" } = {}) {
  if (!rows.length) return empty("No waste profiles here.");
  const showPrice = rows.some((r) => prices.has(r.id));
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Reference</th>${customers ? "<th>Customer</th>" : ""}<th>Waste description</th><th>EWC</th><th>Unit</th>
      <th class="num">Quantity</th><th>Physical form</th><th>Status</th>${showPrice ? '<th class="num">Price / unit</th><th class="num">Total</th>' : ""}<th>Updated</th></tr></thead>
    <tbody>${rows.map((r) => {
      const p = prices.get(r.id);
      const total = p !== undefined && Number(r.quantity) > 0 ? p * Number(r.quantity) : null;
      return `<tr>
        <td><a href="${link}${r.id}">${esc(r.reference)}</a></td>
        ${customers ? `<td>${esc(customers.get(r.customer_id) || "")}</td>` : ""}
        <td>${esc(r.waste_description) || '<span class="muted">—</span>'}</td>
        <td>${esc(r.ewc_code)}</td><td>${esc(r.unit_of_measure)}</td>
        <td class="num">${fmtNum(r.quantity)}</td><td>${esc(r.physical_form)}</td>
        <td>${statusBadge(r.status, STATUS_LABEL)}${r.archived_at ? ' <span class="badge">Archived</span>' : ""}</td>
        ${showPrice ? `<td class="num">${p !== undefined ? `${fmtMoney(p)} / ${esc(r.unit_of_measure)}` : ""}</td><td class="num">${total !== null ? fmtMoney(total) : ""}</td>` : ""}
        <td>${fmtDate(r.updated_at)}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

async function myPrices() {
  const rows = await run(supabase.rpc("my_quote_prices"));
  return new Map(rows.map((r) => [r.waste_profile_id, Number(r.unit_price)]));
}

// ---------------------------------------------------------------- home
export async function home() {
  loading(); setTitle("Home");
  const [profiles, quotes, prices] = await Promise.all([
    run(supabase.from("waste_profiles").select(PROFILE_COLS).is("archived_at", null).order("updated_at", { ascending: false }).limit(10)),
    run(supabase.from("quotes").select("id, reference, status, sent_at, accepted_at").order("sent_at", { ascending: false }).limit(10)),
    myPrices(),
  ]);
  const m = page(`
    <div class="page-head"><div><h1>Welcome${state.profile.full_name ? `, ${esc(state.profile.full_name.split(" ")[0])}` : ""}</h1>
      <p class="muted">${esc(state.customer?.company_name || "")}</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="new-ws">New waste stream</button></div></div>
    <section class="block"><div class="block-head"><h2>Your quotes</h2><a href="#/quotes">All quotes</a></div>
      ${quotes.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Quote</th><th>Status</th><th>Sent</th></tr></thead><tbody>
        ${quotes.map((q) => `<tr><td><a href="#/quote/${q.id}">${esc(q.reference)}</a></td><td>${statusBadge(q.status, QUOTE_STATUS_LABEL)}</td><td>${fmtDate(q.sent_at)}</td></tr>`).join("")}
      </tbody></table></div>` : empty("No quotes yet. Quotes appear here once we have priced your accepted waste profiles.")}
    </section>
    <section class="block"><div class="block-head"><h2>Your waste profiles</h2><a href="#/profiles">All waste profiles</a></div>
      ${profileTable(profiles, { prices })}</section>`);
  m.querySelector("#new-ws").addEventListener("click", () => newWasteStream());
}

// ---------------------------------------------------------------- waste profile sections
const TABS = [
  ["all", "All"], ["drafts", "Started & drafts"], ["pending", "Pending approval"], ["accepted", "Accepted"], ["archived", "Archived"],
];
export async function profiles(tab) {
  loading(); setTitle("Waste profiles");
  let q = supabase.from("waste_profiles").select(PROFILE_COLS).order("updated_at", { ascending: false });
  if (tab === "archived") q = q.not("archived_at", "is", null);
  else {
    q = q.is("archived_at", null);
    if (tab === "drafts") q = q.in("status", ["started", "draft"]);
    if (tab === "pending") q = q.eq("status", "pending_approval");
    if (tab === "accepted") q = q.eq("status", "accepted");
  }
  const [rows, prices] = await Promise.all([run(q), myPrices()]);
  const m = page(`
    <div class="page-head"><h1>Waste profiles</h1><div class="head-actions"><button class="btn btn-primary" id="new-ws">New waste stream</button></div></div>
    <nav class="tabs" aria-label="Sections">${TABS.map(([k, l]) => `<a href="#/profiles?tab=${k}" class="${k === tab ? "active" : ""}" ${k === tab ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav>
    ${profileTable(rows, { prices })}`);
  m.querySelector("#new-ws").addEventListener("click", () => newWasteStream());
}

// ---------------------------------------------------------------- company details and collection sites
export async function company() {
  loading(); setTitle("Company details");
  const cid = state.profile.customer_id;
  const [cust, sites, people] = await Promise.all([
    run(supabase.from("customers").select("*").eq("id", cid)).then((r) => r[0]),
    run(supabase.from("collection_sites").select("*").eq("customer_id", cid).order("site_name")),
    run(supabase.from("user_profiles").select("user_id, full_name, email, phone, is_active").eq("customer_id", cid).order("full_name")),
  ]);
  state.customer = cust;
  const field = (name, label, value) => `<div class="field"><label for="c_${name}">${label}</label><input id="c_${name}" name="${name}" value="${esc(value)}"></div>`;
  const m = page(`
    <h1>Company details</h1>
    <form id="company-form" class="panel">
      <h2>Company</h2>
      <div class="grid">
        <div class="field"><span class="label">Customer number</span><output class="readonly">${esc(cust.customer_no)}</output>
          <p class="hint">Set by us. Send us a message to change it.</p></div>
        ${field("company_name", "Company name", cust.company_name)}
        ${field("address_line1", "Address line 1", cust.address_line1)}
        ${field("address_line2", "Address line 2", cust.address_line2)}
        ${field("town", "Town / city", cust.town)}
        ${field("postcode", "Postcode", cust.postcode)}
        ${field("phone", "Phone", cust.phone)}
      </div>
      <button class="btn btn-primary" type="submit">Save company details</button>
    </form>
    <form id="me-form" class="panel">
      <h2>Your details</h2>
      <div class="grid">
        <div class="field"><span class="label">Login email</span><output class="readonly">${esc(state.profile.email)}</output>
          <p class="hint">To change your login email, send us a message.</p></div>
        <div class="field"><label for="me_name">Your name</label><input id="me_name" name="full_name" value="${esc(state.profile.full_name)}"></div>
        <div class="field"><label for="me_phone">Your phone</label><input id="me_phone" name="phone" value="${esc(state.profile.phone)}"></div>
      </div>
      <button class="btn btn-primary" type="submit">Save your details</button>
    </form>
    <section class="panel"><div class="block-head"><h2>Collection sites</h2><button class="btn" id="add-site">Add site</button></div>
      <p class="muted">Sites you send waste from. You choose one on each waste profile.</p>
      ${sites.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Site</th><th>Address</th><th>Postcode</th><th>Status</th><th></th></tr></thead><tbody>
        ${sites.map((s) => `<tr><td>${esc(s.site_name)}</td><td>${esc([s.address_line1, s.address_line2, s.town].filter(Boolean).join(", "))}</td>
          <td>${esc(s.postcode)}</td><td>${s.is_active ? "Active" : "Not in use"}</td>
          <td class="actions"><button class="btn btn-small" data-edit="${s.id}">Edit</button>
          <button class="btn btn-small" data-toggle="${s.id}">${s.is_active ? "Stop using" : "Use again"}</button></td></tr>`).join("")}
      </tbody></table></div>` : empty("No collection sites yet.")}
    </section>
    <section class="panel"><h2>People with access</h2>
      <ul class="plain">${people.map((p) => `<li>${esc(p.full_name || "—")} · ${esc(p.email)}${p.is_active ? "" : " (no longer active)"}</li>`).join("")}</ul>
      <p class="muted">To add a colleague, send us a message with their name and email address.</p>
    </section>`);

  m.querySelector("#company-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    for (const k in f) f[k] = f[k].trim() || null;
    if (!f.company_name) { toast("Company name is required.", "error"); return; }
    await run(supabase.from("customers").update(f).eq("id", cid), "Company details saved.");
  });
  m.querySelector("#me-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const upd = { full_name: f.full_name.trim() || null, phone: f.phone.trim() || null };
    await run(supabase.from("user_profiles").update(upd).eq("user_id", state.user.id), "Your details saved.");
    Object.assign(state.profile, upd);
  });
  const siteForm = (s = {}) => formModal(s.id ? "Edit collection site" : "Add collection site", [
    { name: "site_name", label: "Site name", value: s.site_name, required: true },
    { name: "address_line1", label: "Address line 1", value: s.address_line1 },
    { name: "address_line2", label: "Address line 2", value: s.address_line2 },
    { name: "town", label: "Town / city", value: s.town },
    { name: "postcode", label: "Postcode", value: s.postcode, required: true },
  ]);
  m.querySelector("#add-site").addEventListener("click", async () => {
    const f = await siteForm();
    if (!f) return;
    await run(supabase.from("collection_sites").insert({ ...f, customer_id: cid }), "Site added.");
    company();
  });
  m.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", async () => {
    const s = sites.find((x) => x.id === b.dataset.edit);
    const f = await siteForm(s);
    if (!f) return;
    await run(supabase.from("collection_sites").update(f).eq("id", s.id), "Site saved.");
    company();
  }));
  m.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", async () => {
    const s = sites.find((x) => x.id === b.dataset.toggle);
    if (s.is_active && !(await confirmBox("Stop using this site?", "It will no longer be offered on new waste profiles. Existing waste profiles keep it.", "Stop using"))) return;
    await run(supabase.from("collection_sites").update({ is_active: !s.is_active }).eq("id", s.id), "Site updated.");
    company();
  }));
}
