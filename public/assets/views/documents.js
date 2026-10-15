// Documents attached to a waste profile, and "fill the form from documents" (Claude, billed to the operator).
//
// 15 Oct 2026:
// - Documents can be removed from a waste profile. Nothing is deleted: the row and the file stay for audit
//   (staff see them under "Removed documents"), but removed documents are never read again.
// - When the reader thinks a document describes a different waste stream, nothing is filled and the person
//   chooses: replace this waste stream, build a new waste stream from the file, fill gaps only, or discard it.
import { supabase, state, esc, run, toast, fmtDate, confirmBox, modal, friendlyError, namesFor } from "../lib.js";

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp,image/gif,text/plain,text/csv";
const STATUS = { not_read: "Not read yet", reading: "Reading…", done: "Read", failed: "Could not read" };
const AUTO_READ_KEY = (id) => `autoread:${id}`;

// onApply(values, filledCols, mode): mode "all" (default), "gaps" (only empty fields) or "replace" (clear form first)
export async function documentsPanel(el, ctx, onApply) {
  const all = await run(supabase.from("waste_profile_documents").select("*").eq("waste_profile_id", ctx.id).order("created_at"));
  const docs = all.filter((d) => !d.removed_at);
  const removed = all.filter((d) => d.removed_at);
  const isStaff = state.profile.role !== "customer";
  const canUpload = ctx.editable;
  const who = isStaff && removed.length ? await namesFor(removed.map((d) => d.removed_by)) : null;

  el.innerHTML = `<div class="panel"><h2>Documents</h2>
    <p class="muted">Upload safety data sheets, analysis reports or similar. ${canUpload ? "The portal can read them and fill in the questionnaire for you to check." : ""}</p>
    <ul class="doc-list">${docs.length ? docs.map((d) => `<li>
        <button type="button" class="link" data-open="${esc(d.storage_path)}">${esc(d.file_name)}</button>
        <span class="muted">· ${fmtDate(d.created_at)} · ${esc(STATUS[d.ai_status] || d.ai_status)}</span>
        ${canUpload ? `<button type="button" class="link link-danger" data-remove="${d.id}" data-name="${esc(d.file_name)}" aria-label="Remove ${esc(d.file_name)}">Remove</button>` : ""}</li>`).join("")
      : `<li class="muted">No documents yet.</li>`}</ul>
    ${canUpload ? `
      <label class="btn btn-small file-btn">Upload document<input type="file" id="doc-file" accept="${ACCEPT}" multiple hidden></label>
      ${docs.length ? `<button type="button" class="btn btn-primary btn-small" id="doc-ai">Fill the form from documents</button>` : ""}
      <p class="hint">PDF, image or text files up to 20 MB.</p>` : ""}
    ${isStaff && removed.length ? `<details class="doc-removed"><summary>Removed documents (${removed.length})</summary>
      <p class="hint">Kept for audit. Not used to fill the form.</p>
      <ul class="doc-list">${removed.map((d) => `<li>
        <button type="button" class="link" data-open="${esc(d.storage_path)}">${esc(d.file_name)}</button>
        <span class="muted">· removed ${fmtDate(d.removed_at, true)}${d.removed_by ? ` by ${esc(who(d.removed_by))}` : ""}${d.removed_reason ? ` · ${esc(d.removed_reason)}` : ""}</span></li>`).join("")}</ul>
      </details>` : ""}
  </div>`;

  const refresh = () => documentsPanel(el, ctx, onApply);

  el.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", async () => {
    const { data, error } = await supabase.storage.from("maq-documents").createSignedUrl(b.dataset.open, 120);
    if (error) { toast(friendlyError(error), "error"); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  }));

  el.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
    const ok = await confirmBox(`Remove ${b.dataset.name}?`,
      "The document is removed from this waste profile and will no longer be used to fill the form. " +
      "Answers already on the form are not changed. Fornax keeps a copy in its records.", "Remove document", "danger");
    if (!ok) return;
    const { error } = await supabase.rpc("remove_waste_profile_document", { p_doc_id: b.dataset.remove, p_reason: "Removed by user" });
    if (error) { toast(friendlyError(error), "error"); return; }
    toast(`${b.dataset.name} removed.`);
    refresh();
  }));

  el.querySelector("#doc-file")?.addEventListener("change", async (e) => {
    const files = [...e.target.files];
    for (const f of files) {
      if (f.size > MAX_BYTES) { toast(`${f.name} is larger than 20 MB.`, "error"); continue; }
      const safe = f.name.replace(/[^\w.\- ]+/g, "_").slice(-120);
      const path = `${ctx.id}/${crypto.randomUUID()}-${safe}`;
      const up = await supabase.storage.from("maq-documents").upload(path, f, { contentType: f.type || "application/octet-stream" });
      if (up.error) { toast(friendlyError(up.error), "error"); continue; }
      await run(supabase.from("waste_profile_documents").insert({
        waste_profile_id: ctx.id, storage_path: path, file_name: f.name, mime_type: f.type, size_bytes: f.size, uploaded_by: state.user.id,
      }));
      toast(`${f.name} uploaded.`);
    }
    refresh();
  });

  el.querySelector("#doc-ai")?.addEventListener("click", async () => {
    const ok = await confirmBox("Fill the form from your documents?",
      "The portal will read the uploaded documents and fill in the answers it can find. Answers already on screen may be replaced. You will be able to check every highlighted answer before saving.",
      "Read documents");
    if (ok) await readDocuments(el, ctx, onApply, {});
  });

  // Arrived here from "build a new waste stream from this file": read the moved document straight away.
  let auto = null;
  try { auto = sessionStorage.getItem(AUTO_READ_KEY(ctx.id)); sessionStorage.removeItem(AUTO_READ_KEY(ctx.id)); } catch { /* ignore */ }
  if (auto && canUpload && docs.length) await readDocuments(el, ctx, onApply, { skip_check: true, mode: "replace" });
}

function profileSummary(ctx) {
  const c = ctx.current || {};
  const out = {};
  for (const k of ["waste_description", "component", "concentration", "ewc_code", "un_no", "physical_form"]) if (c[k]) out[k] = c[k];
  return out;
}

async function readDocuments(el, ctx, onApply, { only_doc_ids, skip_check, mode = "all" }) {
  const btn = el.querySelector("#doc-ai");
  if (btn) { btn.disabled = true; btn.textContent = "Reading documents… (this can take a minute)"; }
  const { data, error } = await supabase.functions.invoke("read-documents", {
    body: { waste_profile_id: ctx.id, profile_summary: profileSummary(ctx), only_doc_ids, skip_check: !!skip_check },
  });
  if (btn) { btn.disabled = false; btn.textContent = "Fill the form from documents"; }
  if (error || data?.error) {
    let msg = data?.error;
    if (!msg && error?.context?.json) { try { msg = (await error.context.json()).error; } catch { /* ignore */ } }
    toast(msg || "The documents could not be read. Please try again later.", "error");
    documentsPanel(el, ctx, onApply);
    return;
  }
  if (data.mismatch?.length) { await handleMismatch(el, ctx, onApply, data.mismatch[0], data.profile_waste); return; }
  const cols = data.filled || [];
  toast(cols.length ? `${cols.length} answers found in your documents. Please check the highlighted fields.` : "No answers could be found in the documents.");
  if (data.notes) toast(data.notes);
  if (cols.length || mode === "replace") onApply(data.values || {}, cols, mode);
  else documentsPanel(el, ctx, onApply);
}

// ---------------------------------------------------------------- a document that looks like a different waste stream
async function handleMismatch(el, ctx, onApply, doc, profileWaste) {
  const option = (value, title, text) => `<label class="choice"><input type="radio" name="mm" value="${value}">
      <span><strong>${esc(title)}</strong><br><span class="muted">${esc(text)}</span></span></label>`;
  const choice = await modal({
    title: "This looks like a different waste stream",
    wide: true,
    body: `<p>The file <strong>${esc(doc.file_name)}</strong> appears to describe a new waste stream:
        <strong>${esc(doc.identified_waste || "a different waste")}</strong>${profileWaste ? `, not <strong>${esc(profileWaste)}</strong>` : ""}.</p>
      ${doc.reason ? `<p class="muted">${esc(doc.reason)}</p>` : ""}
      <p>What would you like to do?</p>
      <div class="choices">
        ${option("replace", "Replace this waste stream", "Clear this form and fill it from this file only. The other documents are removed from this waste profile.")}
        ${option("new", "Build a new waste stream from this file", "Create a separate waste profile, move this file to it and fill it in there. This waste profile stays as it is.")}
        ${option("gaps", "It is the right document – fill in the gaps", "Keep the answers already on the form and only fill in the empty ones from the documents.")}
        ${option("discard", "Ignore and discard this file", "Remove the file from this waste profile and fill the form from the other documents.")}
      </div>
      <p class="hint" id="mm-err" role="alert" style="color:var(--danger)" hidden>Please choose an option.</p>`,
    buttons: [{ label: "Cancel", value: null }, {
      label: "Continue", kind: "primary",
      validate: (w) => { const ok = !!w.querySelector("input[name=mm]:checked"); w.querySelector("#mm-err").hidden = ok; return ok; },
      value: (w) => w.querySelector("input[name=mm]:checked").value,
    }],
  });
  if (!choice) { documentsPanel(el, ctx, onApply); return; }

  const rpc = async (fn, args) => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) { toast(friendlyError(error), "error"); throw error; }
    return data;
  };
  try {
    if (choice === "replace") {
      const others = await run(supabase.from("waste_profile_documents").select("id").eq("waste_profile_id", ctx.id).is("removed_at", null).neq("id", doc.id));
      for (const o of others) await rpc("remove_waste_profile_document", { p_doc_id: o.id, p_reason: `Replaced by different waste stream (${doc.file_name})` });
      await rpc("confirm_waste_profile_document", { p_doc_id: doc.id });
      await readDocuments(el, ctx, onApply, { only_doc_ids: [doc.id], skip_check: true, mode: "replace" });
    } else if (choice === "new") {
      await buildNewStream(ctx, doc);
    } else if (choice === "gaps") {
      await rpc("confirm_waste_profile_document", { p_doc_id: doc.id });
      await readDocuments(el, ctx, onApply, { mode: "gaps" });
    } else if (choice === "discard") {
      await rpc("remove_waste_profile_document", { p_doc_id: doc.id, p_reason: "Discarded: different waste stream" });
      toast(`${doc.file_name} discarded.`);
      const left = await run(supabase.from("waste_profile_documents").select("id").eq("waste_profile_id", ctx.id).is("removed_at", null));
      if (left.length) await readDocuments(el, ctx, onApply, {});
      else documentsPanel(el, ctx, onApply);
    }
  } catch { documentsPanel(el, ctx, onApply); }
}

async function buildNewStream(ctx, doc) {
  const { UNIT_OPTIONS } = await import("../fields.js");
  const unit = await modal({
    title: "New waste stream",
    body: `<p>A new hazardous waste profile will be created for the same customer and <strong>${esc(doc.file_name)}</strong> moved to it.</p>
      <div class="field"><label for="ns-unit">Unit of measure</label>
        <select id="ns-unit">${UNIT_OPTIONS.map((u) => `<option value="${u.code}" ${u.code === ctx.row.unit_of_measure ? "selected" : ""}>${esc(u.label)}</option>`).join("")}</select>
        <p class="hint">Prices will be quoted per this unit. It cannot be changed later.</p></div>`,
    buttons: [{ label: "Cancel", value: null }, { label: "Create and read", kind: "primary", value: (w) => w.querySelector("#ns-unit").value }],
  });
  if (!unit) throw new Error("cancelled");

  const created = await run(supabase.from("waste_profiles")
    .insert({ waste_type: ctx.row.waste_type, unit_of_measure: unit, status: "started", customer_id: ctx.row.customer_id }).select("id, reference"));
  const target = created[0];
  const src = (await run(supabase.from("waste_profile_documents").select("storage_path").eq("id", doc.id)))[0];
  const newPath = `${target.id}/${src.storage_path.split("/").slice(1).join("/")}`;
  const cp = await supabase.storage.from("maq-documents").copy(src.storage_path, newPath);
  if (cp.error) { toast(friendlyError(cp.error), "error"); throw cp.error; }
  const { error } = await supabase.rpc("move_waste_profile_document", { p_doc_id: doc.id, p_target_wp: target.id, p_new_path: newPath });
  if (error) { toast(friendlyError(error), "error"); throw error; }

  try { sessionStorage.setItem(AUTO_READ_KEY(target.id), "1"); } catch { /* ignore */ }
  toast(`New waste profile ${target.reference} created. ${doc.file_name} has been moved to it.`);
  location.hash = (state.profile.role === "customer" ? "#/profile/" : "#/s/profile/") + target.id;
}
