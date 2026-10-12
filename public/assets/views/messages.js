// General messages ("Send us a message") and, for staff, recent questionnaire messages.
import { supabase, state, esc, run, page, loading, setTitle, fmtDate, empty, modal, namesFor, isStaff } from "../lib.js";

const base = () => (isStaff() ? "#/s/" : "#/");

export async function list() {
  loading(); setTitle("Messages");
  const staff = isStaff();
  const [roots, replies, custs, maqMsgs] = await Promise.all([
    run(supabase.from("general_messages").select("id, customer_id, topic, body, sender_id, created_at").is("thread_id", null).order("created_at", { ascending: false }).limit(200)),
    run(supabase.from("general_messages").select("thread_id, created_at, sender_id").not("thread_id", "is", null).order("created_at", { ascending: false }).limit(1000)),
    staff ? run(supabase.from("customers").select("id, company_name, customer_no").order("company_name")) : [],
    staff ? run(supabase.from("waste_profile_messages").select("id, body, sender_id, created_at, waste_profile_id, waste_profiles(reference, customer_id)").order("created_at", { ascending: false }).limit(30)) : [],
  ]);
  const custName = new Map(custs.map((c) => [c.id, c.company_name]));
  const last = new Map();
  for (const r of replies) if (!last.has(r.thread_id)) last.set(r.thread_id, r);
  const name = await namesFor([...roots.map((r) => r.sender_id), ...replies.map((r) => r.sender_id), ...maqMsgs.map((m) => m.sender_id)]);

  const threads = roots.map((r) => ({ ...r, lastAt: last.get(r.id)?.created_at || r.created_at, lastBy: last.get(r.id)?.sender_id || r.sender_id }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));

  const m = page(`
    <div class="page-head"><h1>Messages</h1><div class="head-actions"><button class="btn btn-primary" id="new-msg">New message</button></div></div>
    <p class="muted">${staff ? "Messages from customers. Questions about a specific waste profile are shown further down and on the waste profile itself."
      : "Send us a general question. For a question about one waste profile, use the message box on that waste profile."} Messages stay in the portal; no emails are sent.</p>
    ${threads.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Topic</th>${staff ? "<th>Customer</th>" : ""}<th>Last message</th><th>From</th></tr></thead><tbody>
      ${threads.map((t) => `<tr><td><a href="${base()}thread/${t.id}">${esc(t.topic)}</a></td>${staff ? `<td>${esc(custName.get(t.customer_id) || "")}</td>` : ""}
        <td>${fmtDate(t.lastAt, true)}</td><td>${esc(t.lastBy === state.user.id ? "You" : name(t.lastBy))}</td></tr>`).join("")}</tbody></table></div>`
      : empty("No messages yet.")}
    ${staff ? `<h2>Recent questions on waste profiles</h2>${maqMsgs.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Waste profile</th><th>Customer</th><th>Message</th><th>From</th><th>When</th></tr></thead><tbody>
      ${maqMsgs.map((x) => `<tr><td><a href="#/s/profile/${x.waste_profile_id}">${esc(x.waste_profiles?.reference || "")}</a></td>
        <td>${esc(custName.get(x.waste_profiles?.customer_id) || "")}</td><td class="clip">${esc(x.body)}</td>
        <td>${esc(x.sender_id === state.user.id ? "You" : name(x.sender_id))}</td><td>${fmtDate(x.created_at, true)}</td></tr>`).join("")}</tbody></table></div>` : empty("None yet.")}` : ""}`);

  m.querySelector("#new-msg").addEventListener("click", async () => {
    const res = await modal({
      title: "New message",
      body: `${staff ? `<div class="field"><label for="nm-cust">Customer</label><select id="nm-cust">${custs.map((c) => `<option value="${c.id}">${esc(c.company_name)} (${esc(c.customer_no)})</option>`).join("")}</select></div>` : ""}
        <div class="field"><label for="nm-topic">Topic *</label><input id="nm-topic" maxlength="200"></div>
        <div class="field"><label for="nm-body">Message *</label><textarea id="nm-body" rows="6" maxlength="5000"></textarea></div>`,
      buttons: [{ label: "Cancel", value: null }, {
        label: "Send", kind: "primary",
        validate: (w) => { for (const s of ["#nm-topic", "#nm-body"]) { const e = w.querySelector(s); if (!e.value.trim()) { e.focus(); e.classList.add("invalid"); return false; } } return true; },
        value: (w) => ({ topic: w.querySelector("#nm-topic").value.trim(), body: w.querySelector("#nm-body").value.trim(), customer_id: staff ? w.querySelector("#nm-cust").value : state.profile.customer_id }),
      }],
    });
    if (!res) return;
    const rows = await run(supabase.from("general_messages").insert({ ...res, sender_id: state.user.id }).select("id"), "Message sent.");
    location.hash = `${base()}thread/${rows[0].id}`;
  });
}

export async function thread(id) {
  loading();
  const [root] = await run(supabase.from("general_messages").select("*").eq("id", id));
  if (!root) { page(`<h1>Message not found</h1>`); return; }
  setTitle(root.topic);
  const replies = await run(supabase.from("general_messages").select("*").eq("thread_id", id).order("created_at"));
  const all = [root, ...replies];
  const name = await namesFor(all.map((x) => x.sender_id));
  let custLabel = "";
  if (isStaff()) {
    const [c] = await run(supabase.from("customers").select("id, company_name, customer_no").eq("id", root.customer_id));
    custLabel = c ? `<p class="muted">Customer: <a href="#/s/customer/${c.id}">${esc(c.company_name)} (${esc(c.customer_no)})</a></p>` : "";
  }
  const m = page(`
    <p class="crumbs"><a href="${base()}messages">← Messages</a></p>
    <h1>${esc(root.topic)}</h1>${custLabel}
    <div class="msg-list msg-thread">${all.map((x) => `<div class="msg ${x.sender_id === state.user.id ? "msg-mine" : ""}">
      <div class="msg-meta">${esc(x.sender_id === state.user.id ? "You" : name(x.sender_id))} · ${fmtDate(x.created_at, true)}</div>
      <div class="msg-body">${esc(x.body)}</div></div>`).join("")}</div>
    <form id="reply" class="panel"><label for="reply-body">Reply</label><textarea id="reply-body" rows="4" maxlength="5000"></textarea>
      <button class="btn btn-primary" type="submit">Send reply</button></form>`);
  m.querySelector("#reply").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = m.querySelector("#reply-body").value.trim();
    if (!body) return;
    await run(supabase.from("general_messages").insert({ thread_id: id, customer_id: root.customer_id, sender_id: state.user.id, body }), "Reply sent.");
    thread(id);
  });
}
