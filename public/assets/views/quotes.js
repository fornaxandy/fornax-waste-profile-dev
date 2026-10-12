// Quotes: customer view (view only, accept) and staff builder (prices, charges, send, withdraw).
import { supabase, state, esc, run, toast, page, loading, setTitle, fmtDate, fmtMoney, fmtNum, statusBadge, empty, modal, confirmBox, hasRole, friendlyError } from "../lib.js";
import { QUOTE_STATUS_LABEL } from "../fields.js";

const ITEM_SELECT = "id, waste_profile_id, waste_profiles(id, reference, waste_description, ewc_code, unit_of_measure, quantity, physical_form, service_no, status)";

function linesTable(items, prices, { editable = false, link } = {}) {
  if (!items.length) return empty("No waste profiles on this quote yet.");
  let total = 0;
  const rows = items.map((it) => {
    const w = it.waste_profiles;
    if (!w) return `<tr><td colspan="8" class="muted">A waste profile on this quote is no longer available.</td></tr>`;
    const p = prices.get(w.id);
    const line = p !== undefined && p !== null && Number(w.quantity) > 0 ? Number(p) * Number(w.quantity) : null;
    if (line !== null) total += line;
    return `<tr>
      <td>${link ? `<a href="${link}${w.id}">${esc(w.reference)}</a>` : esc(w.reference)}</td>
      <td>${esc(w.waste_description)}</td><td>${esc(w.ewc_code)}</td><td>${esc(w.physical_form)}</td>
      <td class="num">${fmtNum(w.quantity)} ${esc(w.unit_of_measure)}</td>
      <td class="num">${editable
        ? `<label class="sr-only" for="price_${w.id}">Price per ${esc(w.unit_of_measure)} for ${esc(w.reference)}</label>
           <input class="price-input" id="price_${w.id}" data-price="${w.id}" type="number" min="0" step="any" value="${p ?? ""}"> / ${esc(w.unit_of_measure)}`
        : (p !== undefined && p !== null ? `${fmtMoney(p)} / ${esc(w.unit_of_measure)}` : "—")}</td>
      <td class="num">${line !== null ? fmtMoney(line) : '<span class="muted">—</span>'}</td>
      ${editable ? `<td><button class="btn btn-small" data-remove-item="${it.id}">Remove</button></td>` : ""}</tr>`;
  }).join("");
  return { html: `<div class="table-wrap"><table class="table"><thead><tr><th>Waste profile</th><th>Description</th><th>EWC</th><th>Form</th>
      <th class="num">Quantity</th><th class="num">Price per unit</th><th class="num">Line total</th>${editable ? "<th></th>" : ""}</tr></thead>
      <tbody>${rows}</tbody></table></div>`, total };
}

function chargesTable(charges, editable) {
  if (!charges.length) return { html: `<p class="muted">No additional charges.</p>`, total: 0 };
  let total = 0;
  const rows = charges.map((c) => {
    const line = Number(c.quantity) * Number(c.unit_price);
    total += line;
    return `<tr><td>${esc(c.service_no)}</td><td>${esc(c.description)}</td><td class="num">${fmtNum(c.quantity)}</td>
      <td class="num">${fmtMoney(c.unit_price)}</td><td class="num">${fmtMoney(line)}</td>
      ${editable ? `<td><button class="btn btn-small" data-remove-charge="${c.id}">Remove</button></td>` : ""}</tr>`;
  }).join("");
  return { html: `<div class="table-wrap"><table class="table"><thead><tr><th>Charge</th><th>Description</th><th class="num">Quantity</th>
    <th class="num">Price</th><th class="num">Total</th>${editable ? "<th></th>" : ""}</tr></thead><tbody>${rows}</tbody></table></div>`, total };
}

// ================================================================ customer
export async function customerList() {
  loading(); setTitle("Quotes");
  const rows = await run(supabase.from("quotes").select("id, reference, status, sent_at, accepted_at").order("sent_at", { ascending: false }));
  page(`<h1>Quotes</h1><p class="muted">Quotes from us for your accepted waste profiles. Quotes are view only.</p>
    ${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Quote</th><th>Status</th><th>Sent</th><th>Accepted</th></tr></thead><tbody>
      ${rows.map((q) => `<tr><td><a href="#/quote/${q.id}">${esc(q.reference)}</a></td><td>${statusBadge(q.status, QUOTE_STATUS_LABEL)}</td>
        <td>${fmtDate(q.sent_at)}</td><td>${fmtDate(q.accepted_at)}</td></tr>`).join("")}</tbody></table></div>`
      : empty("No quotes yet.")}`);
}

export async function customerView(id) {
  loading();
  const q = (await run(supabase.from("quotes").select("*").eq("id", id)))[0];
  if (!q) { page(`<h1>Quote not available</h1><p>It may have been withdrawn.</p><p><a href="#/quotes">Back to quotes</a></p>`); return; }
  setTitle(q.reference);
  const [items, charges, priceRows] = await Promise.all([
    run(supabase.from("quote_items").select(ITEM_SELECT).eq("quote_id", id)),
    run(supabase.from("quote_charges").select("*").eq("quote_id", id).order("created_at")),
    run(supabase.rpc("my_quote_prices")),
  ]);
  const prices = new Map(priceRows.filter((p) => p.quote_id === id).map((p) => [p.waste_profile_id, Number(p.unit_price)]));
  const lines = linesTable(items, prices, { link: "#/profile/" });
  const ch = chargesTable(charges, false);
  const m = page(`
    <p class="crumbs"><a href="#/quotes">← Quotes</a></p>
    <div class="page-head"><div><h1>${esc(q.reference)} ${statusBadge(q.status, QUOTE_STATUS_LABEL)}</h1>
      <p class="muted">Sent ${fmtDate(q.sent_at)}${q.accepted_at ? ` · Accepted ${fmtDate(q.accepted_at)}` : ""} · Prices in GBP, excluding VAT</p></div>
      <div class="head-actions">${q.status === "sent" ? `<button class="btn btn-primary" id="accept">Accept quote</button>` : ""}</div></div>
    <div class="banner">This quote is view only. To discuss it, send us a message.</div>
    ${q.notes ? `<section class="panel"><h2>Notes from us</h2><p class="pre">${esc(q.notes)}</p></section>` : ""}
    <section class="block"><h2>Waste profiles</h2>${lines.html ?? lines}</section>
    <section class="block"><h2>Additional charges</h2>${ch.html}</section>
    <p class="total">Total of priced lines: <strong>${fmtMoney((lines.total || 0) + ch.total)}</strong>
      <span class="muted">(waste lines without a quantity are charged per ${"unit"} as shown)</span></p>`);
  m.querySelector("#accept")?.addEventListener("click", async () => {
    const ok = await confirmBox("Accept this quote?", `You are accepting quote ${q.reference} on behalf of ${state.customer?.company_name || "your company"}.`, "Accept quote");
    if (!ok) return;
    await run(supabase.from("quotes").update({ status: "accepted" }).eq("id", id), "Quote accepted. Thank you.");
    customerView(id);
  });
}

// ================================================================ staff
const STAFF_TABS = [["all", "All"], ["draft", "Draft"], ["sent", "Sent"], ["accepted", "Accepted"], ["withdrawn", "Withdrawn"]];

export async function staffList(status) {
  loading(); setTitle("Quotes");
  let qb = supabase.from("quotes").select("id, reference, status, customer_id, created_at, sent_at, accepted_at, customers(company_name, customer_no)").order("created_at", { ascending: false });
  if (status !== "all") qb = qb.eq("status", status);
  const rows = await run(qb);
  const m = page(`
    <div class="page-head"><h1>Quotes</h1><div class="head-actions">${hasRole("admin", "sales") ? `<button class="btn btn-primary" id="new-quote">New quote</button>` : ""}</div></div>
    <nav class="tabs">${STAFF_TABS.map(([k, l]) => `<a href="#/s/quotes?status=${k}" class="${k === status ? "active" : ""}">${l}</a>`).join("")}</nav>
    ${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Quote</th><th>Customer</th><th>Status</th><th>Created</th><th>Sent</th><th>Accepted</th></tr></thead><tbody>
      ${rows.map((q) => `<tr><td><a href="#/s/quote/${q.id}">${esc(q.reference)}</a></td><td>${esc(q.customers?.company_name)} (${esc(q.customers?.customer_no)})</td>
        <td>${statusBadge(q.status, QUOTE_STATUS_LABEL)}</td><td>${fmtDate(q.created_at)}</td><td>${fmtDate(q.sent_at)}</td><td>${fmtDate(q.accepted_at)}</td></tr>`).join("")}
      </tbody></table></div>` : empty("No quotes.")}`);
  m.querySelector("#new-quote")?.addEventListener("click", () => newQuote());
}

export async function newQuote(customerId = null) {
  const custs = await run(supabase.from("customers").select("id, company_name, customer_no").order("company_name"));
  if (!custs.length) { toast("Add a customer first.", "error"); return; }
  const cid = customerId || await modal({
    title: "New quote",
    body: `<div class="field"><label for="nq-cust">Customer</label><select id="nq-cust">${custs.map((c) =>
      `<option value="${c.id}">${esc(c.company_name)} (${esc(c.customer_no)})</option>`).join("")}</select></div>`,
    buttons: [{ label: "Cancel", value: null }, { label: "Create draft quote", kind: "primary", value: (w) => w.querySelector("#nq-cust").value }],
  });
  if (!cid) return;
  const rows = await run(supabase.from("quotes").insert({ customer_id: cid }).select("id"));
  location.hash = `#/s/quote/${rows[0].id}`;
}

export async function staffEdit(id) {
  loading();
  const q = (await run(supabase.from("quotes").select("*, customers(id, company_name, customer_no)").eq("id", id)))[0];
  if (!q) { page(`<h1>Quote not found</h1>`); return; }
  setTitle(q.reference);
  const [items, charges, services] = await Promise.all([
    run(supabase.from("quote_items").select(ITEM_SELECT).eq("quote_id", id)),
    run(supabase.from("quote_charges").select("*").eq("quote_id", id).order("created_at")),
    run(supabase.from("ref_services").select("*").eq("service_type", "G/L").order("service_no")),
  ]);
  const ids = items.map((i) => i.waste_profile_id);
  const internal = ids.length ? await run(supabase.from("waste_profile_internal").select("waste_profile_id, unit_price").in("waste_profile_id", ids)) : [];
  const prices = new Map(internal.map((r) => [r.waste_profile_id, r.unit_price === null ? null : Number(r.unit_price)]));
  const canEdit = hasRole("admin", "sales") && q.status === "draft";
  const lines = linesTable(items, prices, { editable: canEdit, link: "#/s/profile/" });
  const ch = chargesTable(charges, canEdit);
  const actions = [];
  if (hasRole("admin", "sales")) {
    if (q.status === "draft") { actions.push(`<button class="btn btn-danger" id="q-delete">Delete draft</button>`, `<button class="btn btn-primary" id="q-send">Send to customer</button>`); }
    if (["sent", "accepted"].includes(q.status)) actions.push(`<button class="btn btn-danger" id="q-withdraw">Withdraw quote</button>`);
    if (q.status === "withdrawn") actions.push(`<button class="btn" id="q-revise">Revise (back to draft)</button>`);
  }
  const m = page(`
    <p class="crumbs"><a href="#/s/quotes">← Quotes</a></p>
    <div class="page-head"><div><h1>${esc(q.reference)} ${statusBadge(q.status, QUOTE_STATUS_LABEL)}</h1>
      <p class="muted">Customer: <a href="#/s/customer/${q.customers.id}">${esc(q.customers.company_name)} (${esc(q.customers.customer_no)})</a>
      · Created ${fmtDate(q.created_at)}${q.sent_at ? ` · Sent ${fmtDate(q.sent_at)}` : ""}${q.accepted_at ? ` · Accepted by customer ${fmtDate(q.accepted_at, true)}` : ""}${q.withdrawn_at ? ` · Withdrawn ${fmtDate(q.withdrawn_at)}` : ""}</p></div>
      <div class="head-actions">${actions.join("")}</div></div>
    ${q.status === "draft" ? `<div class="banner">Draft — the customer cannot see this quote until you send it. Prices are per unit of measure and are saved on the waste profile.</div>` : ""}
    <section class="block"><div class="block-head"><h2>Waste profiles (${items.length}/200)</h2>${canEdit ? `<button class="btn" id="add-items">Add accepted waste profiles</button>` : ""}</div>${lines.html ?? lines}</section>
    <section class="block"><div class="block-head"><h2>Additional charges</h2>${canEdit ? `<button class="btn" id="add-charge">Add additional charges</button>` : ""}</div>${ch.html}</section>
    <p class="total">Total of priced lines: <strong>${fmtMoney((lines.total || 0) + ch.total)}</strong></p>
    <section class="panel"><h2>Notes shown to the customer</h2>
      <textarea id="q-notes" rows="3" maxlength="4000" ${canEdit ? "" : "disabled"}>${esc(q.notes)}</textarea>
      ${canEdit ? `<button class="btn" id="save-notes">Save notes</button>` : ""}</section>`);

  const reload = () => staffEdit(id);
  m.querySelectorAll("[data-price]").forEach((inp) => inp.addEventListener("change", async () => {
    const v = inp.value === "" ? null : Number(inp.value);
    if (v !== null && (isNaN(v) || v < 0)) { toast("Enter a price of 0 or more.", "error"); return; }
    await run(supabase.from("waste_profile_internal").update({ unit_price: v }).eq("waste_profile_id", inp.dataset.price), "Price saved.");
    reload();
  }));
  m.querySelectorAll("[data-remove-item]").forEach((b) => b.addEventListener("click", async () => {
    await run(supabase.from("quote_items").delete().eq("id", b.dataset.removeItem), "Removed from quote.");
    reload();
  }));
  m.querySelectorAll("[data-remove-charge]").forEach((b) => b.addEventListener("click", async () => {
    await run(supabase.from("quote_charges").delete().eq("id", b.dataset.removeCharge), "Charge removed.");
    reload();
  }));
  m.querySelector("#save-notes")?.addEventListener("click", async () => {
    await run(supabase.from("quotes").update({ notes: m.querySelector("#q-notes").value.trim() || null }).eq("id", id), "Notes saved.");
  });
  m.querySelector("#add-items")?.addEventListener("click", async () => {
    const avail = await run(supabase.from("waste_profiles").select("id, reference, waste_description, ewc_code, unit_of_measure, quantity")
      .eq("customer_id", q.customer_id).eq("status", "accepted").is("archived_at", null).order("reference"));
    const left = avail.filter((w) => !ids.includes(w.id));
    if (!left.length) { toast("This customer has no other accepted waste profiles.", "error"); return; }
    const chosen = await modal({
      title: "Add accepted waste profiles", wide: true,
      body: `<div class="checklist">${left.map((w) => `<label class="check"><input type="checkbox" value="${w.id}">
        <strong>${esc(w.reference)}</strong> ${esc(w.waste_description || "")} <span class="muted">${esc(w.ewc_code || "")} · ${fmtNum(w.quantity)} ${esc(w.unit_of_measure)}</span></label>`).join("")}</div>`,
      buttons: [{ label: "Cancel", value: null }, { label: "Add to quote", kind: "primary", value: (w) => [...w.querySelectorAll("input:checked")].map((i) => i.value) }],
    });
    if (!chosen?.length) return;
    if (items.length + chosen.length > 200) { toast("A quote can hold at most 200 waste profiles.", "error"); return; }
    await run(supabase.from("quote_items").insert(chosen.map((w) => ({ quote_id: id, waste_profile_id: w }))), "Added to quote.");
    reload();
  });
  m.querySelector("#add-charge")?.addEventListener("click", async () => {
    const res = await modal({
      title: "Add additional charge",
      body: `<div class="field"><label for="ch-svc">Charge</label><select id="ch-svc">${services.map((s) => `<option value="${s.service_no}">${esc(s.service_no)} – ${esc(s.description)}</option>`).join("")}</select></div>
        <div class="field"><label for="ch-qty">How many</label><input id="ch-qty" type="number" min="1" step="any" value="1"></div>
        <div class="field"><label for="ch-price">Price each (£)</label><input id="ch-price" type="number" min="0" step="any"></div>`,
      buttons: [{ label: "Cancel", value: null }, {
        label: "Add charge", kind: "primary",
        validate: (w) => { const p = w.querySelector("#ch-price"); const n = w.querySelector("#ch-qty");
          if (p.value === "" || Number(p.value) < 0) { p.focus(); return false; } if (!(Number(n.value) > 0)) { n.focus(); return false; } return true; },
        value: (w) => ({ service_no: w.querySelector("#ch-svc").value, quantity: Number(w.querySelector("#ch-qty").value), unit_price: Number(w.querySelector("#ch-price").value) }),
      }],
    });
    if (!res) return;
    const svc = services.find((s) => s.service_no === res.service_no);
    await run(supabase.from("quote_charges").insert({ quote_id: id, ...res, description: svc.description, unit_of_measure: svc.unit_of_measure }), "Charge added.");
    reload();
  });
  m.querySelector("#q-send")?.addEventListener("click", async () => {
    if (!items.length) { toast("Add at least one waste profile before sending.", "error"); return; }
    const unpriced = items.filter((i) => prices.get(i.waste_profile_id) === null || prices.get(i.waste_profile_id) === undefined);
    if (unpriced.length) { toast(`Set a price for every waste profile first (${unpriced.length} missing).`, "error"); return; }
    if (!(await confirmBox("Send this quote?", `The customer ${q.customers.company_name} will see this quote in the portal. No email is sent.`, "Send to customer"))) return;
    await run(supabase.from("quotes").update({ status: "sent" }).eq("id", id), "Quote sent. The customer can now see it.");
    reload();
  });
  m.querySelector("#q-withdraw")?.addEventListener("click", async () => {
    let ok;
    if (q.status === "accepted") {
      ok = await modal({
        title: "Withdraw an accepted quote?",
        body: `<p class="error">The customer has already accepted this quote. Withdrawing it removes it and its prices from the customer's screens.</p>
          <label for="wd-confirm">Type <strong>WITHDRAW</strong> to confirm</label><input id="wd-confirm" autocomplete="off">`,
        buttons: [{ label: "Cancel", value: false }, { label: "Withdraw quote", kind: "danger", value: true,
          validate: (w) => w.querySelector("#wd-confirm").value.trim().toUpperCase() === "WITHDRAW" || (toast("Type WITHDRAW to confirm.", "error"), false) }],
      });
    } else ok = await confirmBox("Withdraw this quote?", "It disappears from the customer's screens, together with its prices.", "Withdraw quote", "danger");
    if (!ok) return;
    await run(supabase.from("quotes").update({ status: "withdrawn" }).eq("id", id), "Quote withdrawn.");
    reload();
  });
  m.querySelector("#q-revise")?.addEventListener("click", async () => {
    await run(supabase.from("quotes").update({ status: "draft" }).eq("id", id), "Quote is a draft again.");
    reload();
  });
  m.querySelector("#q-delete")?.addEventListener("click", async () => {
    if (!(await confirmBox("Delete this draft quote?", "The draft and its charges are deleted. Waste profiles and their prices are kept.", "Delete", "danger"))) return;
    const { error } = await supabase.from("quotes").delete().eq("id", id);
    if (error) { toast(friendlyError(error), "error"); return; }
    toast("Draft quote deleted.");
    location.hash = "#/s/quotes";
  });
}
