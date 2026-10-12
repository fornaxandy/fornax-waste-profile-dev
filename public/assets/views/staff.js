// Staff screens: dashboard, customers, all waste profiles, deleted profiles, Ops placeholder.
import { supabase, state, esc, run, toast, page, loading, setTitle, fmtDate, statusBadge, empty, formModal, confirmBox, hasRole, friendlyError } from "../lib.js";
import { STATUS_LABEL, QUOTE_STATUS_LABEL } from "../fields.js";
import { profileTable } from "./customer.js";
import { newWasteStream } from "./maq.js";
import { newQuote } from "./quotes.js";

const PROFILE_COLS = "id, reference, customer_id, status, waste_description, ewc_code, unit_of_measure, quantity, physical_form, archived_at, updated_at, submitted_at";

async function customerNames() {
  const rows = await run(supabase.from("customers").select("id, company_name, customer_no").order("company_name"));
  return { rows, map: new Map(rows.map((c) => [c.id, `${c.company_name} (${c.customer_no})`])) };
}
async function staffPrices(ids) {
  if (!ids.length) return new Map();
  const rows = await run(supabase.from("waste_profile_internal").select("waste_profile_id, unit_price").in("waste_profile_id", ids).not("unit_price", "is", null));
  return new Map(rows.map((r) => [r.waste_profile_id, Number(r.unit_price)]));
}
const count = async (q) => { const { count: n } = await q; return n ?? 0; };

// ---------------------------------------------------------------- dashboard
export async function dashboard() {
  loading(); setTitle("Dashboard");
  const head = (t) => supabase.from(t).select("id", { count: "exact", head: true });
  const [pending, accepted, drafts, qDraft, qSent, qAcc, custs, pendingRows] = await Promise.all([
    count(head("waste_profiles").eq("status", "pending_approval")),
    count(head("waste_profiles").eq("status", "accepted").is("archived_at", null)),
    count(head("waste_profiles").in("status", ["started", "draft"]).is("archived_at", null)),
    count(head("quotes").eq("status", "draft")),
    count(head("quotes").eq("status", "sent")),
    count(head("quotes").eq("status", "accepted")),
    customerNames(),
    run(supabase.from("waste_profiles").select(PROFILE_COLS).eq("status", "pending_approval").order("submitted_at").limit(10)),
  ]);
  const tile = (n, label, href) => `<a class="tile" href="${href}"><span class="tile-n">${n}</span><span class="tile-l">${esc(label)}</span></a>`;
  page(`
    <h1>Dashboard</h1>
    <div class="tiles">
      ${tile(pending, "Waiting for approval", "#/s/profiles?status=pending_approval")}
      ${tile(accepted, "Accepted waste profiles", "#/s/profiles?status=accepted")}
      ${tile(drafts, "Being filled in by customers", "#/s/profiles?status=drafts")}
      ${tile(qDraft, "Draft quotes", "#/s/quotes?status=draft")}
      ${tile(qSent, "Quotes sent, not yet accepted", "#/s/quotes?status=sent")}
      ${tile(qAcc, "Quotes accepted by customers", "#/s/quotes?status=accepted")}
      ${tile(custs.rows.length, "Customers", "#/s/customers")}
    </div>
    <section class="block"><div class="block-head"><h2>Oldest waiting for approval</h2><a href="#/s/profiles?status=pending_approval">All</a></div>
      ${profileTable(pendingRows, { customers: custs.map, link: "#/s/profile/" })}</section>`);
}

// ---------------------------------------------------------------- customers
export async function customers() {
  loading(); setTitle("Customers");
  const [custs, people] = await Promise.all([
    run(supabase.from("customers").select("*").order("company_name")),
    run(supabase.from("user_profiles").select("user_id, customer_id, full_name, email, is_active, created_at").eq("role", "customer").order("created_at")),
  ]);
  const first = new Map();
  for (const p of people) if (!first.has(p.customer_id)) first.set(p.customer_id, p);
  const m = page(`
    <div class="page-head"><h1>Customers</h1><div class="head-actions">${hasRole("admin", "sales") ? `<button class="btn btn-primary" id="add-cust">Add customer</button>` : ""}</div></div>
    <div class="field field-inline"><label for="cust-search">Search</label><input id="cust-search" type="search" placeholder="Number, name, company or email"></div>
    ${custs.length ? `<div class="table-wrap"><table class="table" id="cust-table"><thead><tr><th>Customer no.</th><th>Company</th><th>Contact name</th><th>Email</th></tr></thead><tbody>
      ${custs.map((c) => { const p = first.get(c.id) || {};
        return `<tr data-search="${esc(`${c.customer_no} ${c.company_name} ${p.full_name || ""} ${p.email || ""}`.toLowerCase())}">
          <td><a href="#/s/customer/${c.id}">${esc(c.customer_no)}</a></td><td><a href="#/s/customer/${c.id}">${esc(c.company_name)}</a></td>
          <td>${esc(p.full_name)}</td><td>${esc(p.email)}</td></tr>`; }).join("")}</tbody></table></div>` : empty("No customers yet.")}`);
  m.querySelector("#cust-search").addEventListener("input", (e) => {
    const t = e.target.value.trim().toLowerCase();
    m.querySelectorAll("#cust-table tbody tr").forEach((tr) => { tr.hidden = !!t && !tr.dataset.search.includes(t); });
  });
  m.querySelector("#add-cust")?.addEventListener("click", async () => {
    const f = await formModal("Add customer", [
      { name: "customer_no", label: "Tegos customer number", required: true, hint: "Must match the customer's number in Tegos." },
      { name: "company_name", label: "Company name", required: true },
      { name: "contact_name", label: "Contact name", required: true },
      { name: "email", label: "Contact email (their login)", type: "email", required: true, hint: "Only this email address can log in for this contact." },
      { name: "phone", label: "Phone" },
    ], "Add customer");
    if (!f) return;
    const { data, error } = await supabase.rpc("staff_create_customer", {
      p_customer_no: f.customer_no, p_company_name: f.company_name, p_contact_name: f.contact_name, p_email: f.email, p_phone: f.phone || null,
    });
    if (error) { toast(friendlyError(error), "error"); return; }
    toast("Customer added. They can now log in with their email address.");
    location.hash = `#/s/customer/${data}`;
  });
}

export async function customerDetail(id) {
  loading();
  const [cust] = await run(supabase.from("customers").select("*").eq("id", id));
  if (!cust) { page(`<h1>Customer not found</h1>`); return; }
  setTitle(cust.company_name);
  const [people, sites, profiles, quotes] = await Promise.all([
    run(supabase.from("user_profiles").select("*").eq("customer_id", id).order("full_name")),
    run(supabase.from("collection_sites").select("*").eq("customer_id", id).order("site_name")),
    run(supabase.from("waste_profiles").select(PROFILE_COLS).eq("customer_id", id).order("updated_at", { ascending: false })),
    run(supabase.from("quotes").select("id, reference, status, created_at, sent_at, accepted_at").eq("customer_id", id).order("created_at", { ascending: false })),
  ]);
  const prices = await staffPrices(profiles.map((p) => p.id));
  const canEdit = hasRole("admin", "sales");
  const fld = (name, label) => `<div class="field"><label for="cd_${name}">${label}</label><input id="cd_${name}" name="${name}" value="${esc(cust[name])}" ${canEdit ? "" : "disabled"}></div>`;
  const m = page(`
    <p class="crumbs"><a href="#/s/customers">← Customers</a></p>
    <div class="page-head"><h1>${esc(cust.company_name)} <span class="muted">(${esc(cust.customer_no)})</span></h1>
      <div class="head-actions">${canEdit ? `<button class="btn" id="new-ws">New waste stream for this customer</button><button class="btn btn-primary" id="new-q">New quote</button>` : ""}</div></div>
    <section class="block"><h2>Quotes</h2>
      ${quotes.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Quote</th><th>Status</th><th>Created</th><th>Sent</th><th>Accepted</th></tr></thead><tbody>
        ${quotes.map((q) => `<tr><td><a href="#/s/quote/${q.id}">${esc(q.reference)}</a></td><td>${statusBadge(q.status, QUOTE_STATUS_LABEL)}</td>
          <td>${fmtDate(q.created_at)}</td><td>${fmtDate(q.sent_at)}</td><td>${fmtDate(q.accepted_at)}</td></tr>`).join("")}</tbody></table></div>` : empty("No quotes yet.")}</section>
    <section class="block"><h2>Waste profiles</h2>${profileTable(profiles, { prices, link: "#/s/profile/" })}</section>
    <form id="cust-form" class="panel"><h2>Company</h2><div class="grid">
      ${fld("customer_no", "Tegos customer number")}${fld("company_name", "Company name")}${fld("address_line1", "Address line 1")}
      ${fld("address_line2", "Address line 2")}${fld("town", "Town / city")}${fld("postcode", "Postcode")}${fld("phone", "Phone")}</div>
      ${canEdit ? `<button class="btn btn-primary" type="submit">Save company</button>` : ""}</form>
    <section class="panel"><div class="block-head"><h2>People with access</h2>${canEdit ? `<button class="btn" id="add-user">Add person</button>` : ""}</div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Login email</th><th>Phone</th><th>Status</th>${canEdit ? "<th></th>" : ""}</tr></thead><tbody>
      ${people.map((p) => `<tr><td>${esc(p.full_name)}</td><td>${esc(p.email)}</td><td>${esc(p.phone)}</td><td>${p.is_active ? "Active" : "No access"}</td>
        ${canEdit ? `<td class="actions"><button class="btn btn-small" data-email="${p.user_id}">Change email</button>
          <button class="btn btn-small" data-active="${p.user_id}">${p.is_active ? "Remove access" : "Restore access"}</button></td>` : ""}</tr>`).join("")}
      </tbody></table></div></section>
    <section class="panel"><h2>Collection sites</h2>
      ${sites.length ? `<ul class="plain">${sites.map((s) => `<li>${esc(s.site_name)} – ${esc([s.address_line1, s.address_line2, s.town, s.postcode].filter(Boolean).join(", "))}${s.is_active ? "" : " (not in use)"}</li>`).join("")}</ul>` : empty("The customer has not added any sites yet.")}
    </section>`);

  m.querySelector("#new-ws")?.addEventListener("click", () => newWasteStream(id));
  m.querySelector("#new-q")?.addEventListener("click", () => newQuote(id));
  m.querySelector("#cust-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    for (const k in f) f[k] = f[k].trim() || null;
    if (!f.customer_no || !f.company_name) { toast("Customer number and company name are required.", "error"); return; }
    if (f.customer_no !== cust.customer_no && !(await confirmBox("Change the customer number?", "It must match the customer's number in Tegos.", "Change"))) return;
    await run(supabase.from("customers").update(f).eq("id", id), "Company saved.");
    customerDetail(id);
  });
  m.querySelector("#add-user")?.addEventListener("click", async () => {
    const f = await formModal("Add person", [
      { name: "full_name", label: "Name", required: true },
      { name: "email", label: "Email (their login)", type: "email", required: true },
    ], "Add person");
    if (!f) return;
    const { error } = await supabase.rpc("staff_add_customer_user", { p_customer_id: id, p_full_name: f.full_name, p_email: f.email });
    if (error) { toast(friendlyError(error), "error"); return; }
    toast("Person added. They can now log in with their email address.");
    customerDetail(id);
  });
  m.querySelectorAll("[data-email]").forEach((b) => b.addEventListener("click", async () => {
    const p = people.find((x) => x.user_id === b.dataset.email);
    const f = await formModal(`Change login email for ${p.full_name || p.email}`, [{ name: "email", label: "New email", type: "email", value: p.email, required: true }], "Change email");
    if (!f) return;
    const { error } = await supabase.rpc("staff_change_customer_email", { p_user_id: p.user_id, p_new_email: f.email });
    if (error) { toast(friendlyError(error), "error"); return; }
    toast("Login email changed.");
    customerDetail(id);
  }));
  m.querySelectorAll("[data-active]").forEach((b) => b.addEventListener("click", async () => {
    const p = people.find((x) => x.user_id === b.dataset.active);
    if (p.is_active && !(await confirmBox("Remove access?", `${p.full_name || p.email} will no longer be able to log in. Their history is kept.`, "Remove access", "danger"))) return;
    await run(supabase.from("user_profiles").update({ is_active: !p.is_active }).eq("user_id", p.user_id), "Access updated.");
    customerDetail(id);
  }));
}

// ---------------------------------------------------------------- all waste profiles
const TABS = [["pending_approval", "Waiting for approval"], ["accepted", "Accepted"], ["drafts", "Started & drafts"], ["archived", "Archived"], ["all", "All"]];
export async function profiles(status) {
  loading(); setTitle("Waste profiles");
  let q = supabase.from("waste_profiles").select(PROFILE_COLS).order(status === "pending_approval" ? "submitted_at" : "updated_at", { ascending: status === "pending_approval" });
  if (status === "archived") q = q.not("archived_at", "is", null);
  else if (status !== "all") {
    q = q.is("archived_at", null);
    q = status === "drafts" ? q.in("status", ["started", "draft"]) : q.eq("status", status);
  }
  const [rows, custs] = await Promise.all([run(q.limit(1000)), customerNames()]);
  const prices = await staffPrices(rows.map((r) => r.id));
  const m = page(`
    <h1>Waste profiles</h1>
    <nav class="tabs">${TABS.map(([k, l]) => `<a href="#/s/profiles?status=${k}" class="${k === status ? "active" : ""}">${l}</a>`).join("")}</nav>
    <div class="field field-inline"><label for="wp-cust">Customer</label><select id="wp-cust"><option value="">All customers</option>
      ${custs.rows.map((c) => `<option value="${c.id}">${esc(c.company_name)} (${esc(c.customer_no)})</option>`).join("")}</select></div>
    <div id="wp-table">${profileTable(rows, { customers: custs.map, prices, link: "#/s/profile/" })}</div>`);
  m.querySelector("#wp-cust").addEventListener("change", (e) => {
    const c = e.target.value;
    m.querySelector("#wp-table").innerHTML = profileTable(c ? rows.filter((r) => r.customer_id === c) : rows, { customers: custs.map, prices, link: "#/s/profile/" });
  });
}

// ---------------------------------------------------------------- deleted profiles (admin)
export async function deleted() {
  loading(); setTitle("Deleted profiles");
  if (!hasRole("admin")) { page(`<p>Only administrators can see deleted profiles.</p>`); return; }
  const [rows, custs] = await Promise.all([
    run(supabase.from("waste_profiles").select("id, reference, customer_id, status, waste_description, deleted_at, deleted_by").not("deleted_at", "is", null).order("deleted_at", { ascending: false })),
    customerNames(),
  ]);
  const daysLeft = (d) => Math.max(0, 90 - Math.floor((Date.now() - new Date(d)) / 86400000));
  const m = page(`<h1>Deleted waste profiles</h1>
    <p class="muted">Profiles marked for deletion by customers or staff. They are deleted permanently 90 days after being marked.</p>
    ${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Reference</th><th>Customer</th><th>Description</th><th>Status when deleted</th><th>Deleted</th><th>Days left</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.reference)}</td><td>${esc(custs.map.get(r.customer_id))}</td><td>${esc(r.waste_description)}</td>
        <td>${statusBadge(r.status, STATUS_LABEL)}</td><td>${fmtDate(r.deleted_at)}</td><td>${daysLeft(r.deleted_at)}</td>
        <td class="actions"><button class="btn btn-small" data-recover="${r.id}">Recover</button><button class="btn btn-small btn-danger" data-purge="${r.id}">Delete permanently</button></td></tr>`).join("")}
      </tbody></table></div>` : empty("Nothing has been deleted.")}`);
  m.querySelectorAll("[data-recover]").forEach((b) => b.addEventListener("click", async () => {
    const { error } = await supabase.rpc("recover_waste_profile", { p_id: b.dataset.recover });
    if (error) { toast(friendlyError(error), "error"); return; }
    toast("Recovered. The customer can see it again.");
    deleted();
  }));
  m.querySelectorAll("[data-purge]").forEach((b) => b.addEventListener("click", async () => {
    if (!(await confirmBox("Delete permanently?", "This cannot be undone. The waste profile, its messages and documents are removed from the portal. Tegos keeps its own copy.", "Delete permanently", "danger"))) return;
    await run(supabase.from("quote_items").delete().eq("waste_profile_id", b.dataset.purge));
    await run(supabase.from("waste_profiles").delete().eq("id", b.dataset.purge), "Deleted permanently.");
    deleted();
  }));
}

// ---------------------------------------------------------------- Ops
export function ops() {
  setTitle("Orders");
  page(`<h1>Orders</h1><div class="panel"><p>Order handling — delivery time slots, scheduling and order confirmations — arrives in Version 2 of the portal.</p>
    <p class="muted">Your login is ready. Ops users do not see waste profiles or quotes.</p></div>`);
}
export { state };
