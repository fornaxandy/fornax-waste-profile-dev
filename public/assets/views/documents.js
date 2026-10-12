// Documents attached to a waste profile, and "fill the form from documents" (Claude, billed to the operator).
import { supabase, state, esc, run, toast, fmtDate, confirmBox, friendlyError } from "../lib.js";

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp,image/gif,text/plain,text/csv";
const STATUS = { not_read: "Not read yet", reading: "Reading…", done: "Read", failed: "Could not read" };

export async function documentsPanel(el, ctx, onApply) {
  const docs = await run(supabase.from("waste_profile_documents").select("*").eq("waste_profile_id", ctx.id).order("created_at"));
  const canUpload = ctx.editable;
  el.innerHTML = `<div class="panel"><h2>Documents</h2>
    <p class="muted">Upload safety data sheets, analysis reports or similar. ${canUpload ? "The portal can read them and fill in the questionnaire for you to check." : ""}</p>
    <ul class="doc-list">${docs.length ? docs.map((d) => `<li>
        <button type="button" class="link" data-open="${esc(d.storage_path)}">${esc(d.file_name)}</button>
        <span class="muted">· ${fmtDate(d.created_at)} · ${esc(STATUS[d.ai_status] || d.ai_status)}</span></li>`).join("")
      : `<li class="muted">No documents yet.</li>`}</ul>
    ${canUpload ? `
      <label class="btn btn-small file-btn">Upload document<input type="file" id="doc-file" accept="${ACCEPT}" multiple hidden></label>
      ${docs.length ? `<button type="button" class="btn btn-primary btn-small" id="doc-ai">Fill the form from documents</button>` : ""}
      <p class="hint">PDF, image or text files up to 20 MB.</p>` : ""}
  </div>`;

  el.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", async () => {
    const { data, error } = await supabase.storage.from("maq-documents").createSignedUrl(b.dataset.open, 120);
    if (error) { toast(friendlyError(error), "error"); return; }
    window.open(data.signedUrl, "_blank", "noopener");
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
    documentsPanel(el, ctx, onApply);
  });

  el.querySelector("#doc-ai")?.addEventListener("click", async () => {
    const ok = await confirmBox("Fill the form from your documents?",
      "The portal will read the uploaded documents and fill in the answers it can find. Answers already on screen may be replaced. You will be able to check every highlighted answer before saving.",
      "Read documents");
    if (!ok) return;
    const btn = el.querySelector("#doc-ai");
    btn.disabled = true; btn.textContent = "Reading documents… (this can take a minute)";
    const { data, error } = await supabase.functions.invoke("read-documents", { body: { waste_profile_id: ctx.id } });
    btn.disabled = false; btn.textContent = "Fill the form from documents";
    if (error || data?.error) {
      let msg = data?.error;
      if (!msg && error?.context?.json) { try { msg = (await error.context.json()).error; } catch { /* ignore */ } }
      toast(msg || "The documents could not be read. Please try again later.", "error");
      documentsPanel(el, ctx, onApply);
      return;
    }
    const cols = data.filled || [];
    toast(cols.length ? `${cols.length} answers filled from your documents. Please check the highlighted fields.` : "No answers could be found in the documents.");
    if (data.notes) toast(data.notes);
    if (cols.length) onApply(data.values, cols);
  });
}
