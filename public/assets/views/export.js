// Export accepted waste profiles to an Excel file with a single "BC Import" sheet for upload to Tegos.
// Column order and names match the BC Import tab of the Tegos Waste Profile Export workbook, plus "Price" at the end.
import { supabase, esc, run, toast, page, loading, setTitle, fmtDate, fmtNum, empty, downloadBlob, fetchAll, modal } from "../lib.js";

const HEADERS = ["DocumentType", "DocumentNo", "DocumentLineNo", "WasteEntryLineNo", "LineNo", "ServiceNo", "ServiceDescription", "MaterialNo",
  "WasteDescription", "EWCCode", "EWCAR", "UNNo", "ProperShippingName", "ADRCode", "ADRClass1", "ADRClass2", "ADRClass3", "ADRClass4",
  "PackingGroup", "PhysicalForm", "Quantity", "Unit", "UnitQuantity", "ContainerSize", "ContainerSizeDescription", "ContainerQuantity",
  "PackingInstructions", "RecoveryDisposalCode", "ComahCode", "Concentration", "Component", "GHSCode", "SignalWord", "TunnelCode",
  "EmergencyActionCode", "HP1", "HP2", "HP3", "HP4", "HP5", "HP6", "HP7", "HP8", "HP9", "HP10", "HP11", "HP12", "HP13", "HP14", "HP15",
  "HP16", "LabelReference", "DrumIdentifier", "ConsignmentNoteNo", "LocationCode", "DisposalSiteNo", "CollectionDate", "ReceivedDate",
  "HalogenContentPct", "MetalContentPct", "FlashPointC", "pH", "WaterContentPct", "AshContentPct", "CalorificValueMJkg", "ReducingAgent",
  "Lachrymator", "FreeCyanideMgKg", "ComplexedCyanideMgKg", "OrganicNitrogenMgKg", "FluorineMgKg", "ChlorineMgKg", "BromineMgKg",
  "IodineMgKg", "SulfurMgKg", "PhosphorusMgKg", "MercuryMgKg", "CadmiumMgKg", "LeadMgKg", "ChromiumMgKg", "NickelMgKg", "CopperMgKg",
  "ZincMgKg", "ArsenicMgKg", "AntimonyMgKg", "TinMgKg", "BariumMgKg", "CobaltMgKg", "ManganeseMgKg", "IronMgKg", "ContainsPFAS",
  "PFASMgKg", "Odour", "CompatibilityGroup", "SettledLiquidPct", "Comments", "CustomerName", "CollectionSite", "CompletedBy",
  "ContactDetails", "DateCompleted", "DeclarationConfirmed", "LineStatus", "Price"];

const MGKG = { FreeCyanideMgKg: "free_cyanide_mg_kg", ComplexedCyanideMgKg: "complexed_cyanide_mg_kg", OrganicNitrogenMgKg: "organic_nitrogen_mg_kg",
  FluorineMgKg: "fluorine_mg_kg", ChlorineMgKg: "chlorine_mg_kg", BromineMgKg: "bromine_mg_kg", IodineMgKg: "iodine_mg_kg", SulfurMgKg: "sulfur_mg_kg",
  PhosphorusMgKg: "phosphorus_mg_kg", MercuryMgKg: "mercury_mg_kg", CadmiumMgKg: "cadmium_mg_kg", LeadMgKg: "lead_mg_kg", ChromiumMgKg: "chromium_mg_kg",
  NickelMgKg: "nickel_mg_kg", CopperMgKg: "copper_mg_kg", ZincMgKg: "zinc_mg_kg", ArsenicMgKg: "arsenic_mg_kg", AntimonyMgKg: "antimony_mg_kg",
  TinMgKg: "tin_mg_kg", BariumMgKg: "barium_mg_kg", CobaltMgKg: "cobalt_mg_kg", ManganeseMgKg: "manganese_mg_kg", IronMgKg: "iron_mg_kg" };

const yesNo = (b) => (b ? "Yes" : "No");
const n = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));
const d = (v) => (v ? new Date(v) : null);

// Tegos needs the target document on every row (replaces decision D13, 15 Oct 2026):
//   DocumentType  Contract / Quote / Order  (only Quote for now)
//   DocumentNo    WMQ + 7 digits, typed in by the exporting user
//   DocumentLineNo 10000, 20000, 30000 … one per exported profile
//   WasteEntryLineNo and LineNo always 10000
const DOC_TYPES = ["Quote"];               // later: "Contract", "Order"
const DOC_NO_RE = /^WMQ\d{7}$/;

// Accepts "WMQ0000118", "wmq 0000118" or just "118" and returns "WMQ0000118"; null if it cannot be made valid.
export function normaliseDocNo(raw) {
  const s = String(raw || "").toUpperCase().replace(/\s+/g, "");
  const digits = s.startsWith("WMQ") ? s.slice(3) : s;
  if (!/^\d{1,7}$/.test(digits)) return null;
  const out = "WMQ" + digits.padStart(7, "0");
  return DOC_NO_RE.test(out) ? out : null;
}

function askTegosDocument(count) {
  return modal({
    title: "Tegos document",
    body: `<p class="muted">Tegos imports the ${count === 1 ? "waste profile" : `${count} waste profiles`} into an existing document.
        Delete any existing waste profile lines on that document in Tegos before importing.</p>
      <div class="field"><label for="ex_doc_type">Document type</label>
        <select id="ex_doc_type">${DOC_TYPES.map((t) => `<option>${esc(t)}</option>`).join("")}</select></div>
      <div class="field"><label for="ex_doc_no">Quote number *</label>
        <input id="ex_doc_no" type="text" maxlength="12" placeholder="WMQ0000118" autocomplete="off">
        <p class="hint">Format WMQ followed by 7 digits, for example WMQ0000118.</p>
        <p class="hint" id="ex_doc_err" role="alert" style="color:var(--danger)" hidden></p></div>`,
    buttons: [{ label: "Cancel", value: null }, {
      label: "Export to Excel", kind: "primary",
      validate: (w) => {
        const el = w.querySelector("#ex_doc_no"), err = w.querySelector("#ex_doc_err");
        const v = normaliseDocNo(el.value);
        if (v) { el.value = v; return true; }
        el.classList.add("invalid"); el.focus();
        err.textContent = "Enter a quote number in the format WMQ0000118 (WMQ and 7 digits).";
        err.hidden = false;
        return false;
      },
      value: (w) => ({ docType: w.querySelector("#ex_doc_type").value, docNo: normaliseDocNo(w.querySelector("#ex_doc_no").value) }),
    }],
    onOpen: (w) => w.querySelector("#ex_doc_no").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); w.querySelector(".btn-primary").click(); }
    }),
  });
}

function toRow(w, i, idx, cust, site, submitter, doc) {
  const v = {
    DocumentType: doc.docType, DocumentNo: doc.docNo,
    DocumentLineNo: (idx + 1) * 10000, WasteEntryLineNo: 10000, LineNo: 10000,
    ServiceNo: w.service_no, ServiceDescription: w.service_description, MaterialNo: w.material_no,
    WasteDescription: w.waste_description || "", EWCCode: w.ewc_code || "", EWCAR: i.ewc_ar || "",
    UNNo: w.un_no || "", ProperShippingName: w.proper_shipping_name || "", ADRCode: w.adr_code || "",
    ADRClass1: w.adr_class_1 || "", ADRClass2: w.adr_class_2 || "", ADRClass3: w.adr_class_3 || "", ADRClass4: w.adr_class_4 || "",
    PackingGroup: w.packing_group || "", PhysicalForm: w.physical_form || "",
    Quantity: n(w.quantity), Unit: w.unit_of_measure, UnitQuantity: n(i.unit_quantity) || n(w.equipment_quantity),
    ContainerSize: w.equipment_no || "", ContainerSizeDescription: w.equipment_description || "", ContainerQuantity: n(w.equipment_quantity),
    PackingInstructions: i.packing_instructions || "", RecoveryDisposalCode: i.recovery_disposal_code || "", ComahCode: w.comah_code || "",
    Concentration: w.concentration || "", Component: w.component || "", GHSCode: "", SignalWord: i.signal_word || "",
    TunnelCode: i.tunnel_code || "", EmergencyActionCode: i.emergency_action_code || "",
    LabelReference: "", DrumIdentifier: "", ConsignmentNoteNo: i.consignment_note_no || "", LocationCode: i.location_code || "",
    DisposalSiteNo: i.disposal_site_no || "", CollectionDate: d(w.collection_date), ReceivedDate: d(i.received_date),
    HalogenContentPct: n(w.halogen_content_pct), MetalContentPct: n(w.metal_content_pct), FlashPointC: n(w.flash_point_c), pH: n(w.ph_value),
    WaterContentPct: n(w.water_content_pct), AshContentPct: n(w.ash_content_pct), CalorificValueMJkg: n(w.calorific_value_mj_kg),
    ReducingAgent: w.reducing_agent || "No", Lachrymator: w.lachrymator || "No",
    ContainsPFAS: w.pfas_status || "No", PFASMgKg: n(w.pfas_mg_kg), Odour: w.odour || "", CompatibilityGroup: w.compatibility_group || "",
    SettledLiquidPct: n(w.settled_liquid_pct), Comments: (i.comments || "").slice(0, 250),
    CustomerName: cust?.company_name || "",
    CollectionSite: site ? [site.site_name, site.address_line1, site.address_line2, site.town, site.postcode].filter(Boolean).join(", ") : "",
    CompletedBy: submitter?.full_name || submitter?.email || "",
    ContactDetails: [submitter?.email, submitter?.phone].filter(Boolean).join(" / "),
    DateCompleted: d(w.submitted_at), DeclarationConfirmed: yesNo(w.declaration_confirmed), LineStatus: "",
    Price: i.unit_price === null || i.unit_price === undefined ? "" : Number(i.unit_price),
  };
  for (let k = 1; k <= 16; k++) v[`HP${k}`] = yesNo(w[`hp_${String(k).padStart(2, "0")}`]);
  for (const [h, col] of Object.entries(MGKG)) v[h] = n(w[col]);
  return HEADERS.map((h) => v[h] ?? "");
}

export async function view() {
  loading(); setTitle("Export to Tegos");
  const [rows, custs] = await Promise.all([
    run(supabase.from("waste_profiles").select("id, reference, customer_id, waste_description, ewc_code, unit_of_measure, quantity, approved_at")
      .eq("status", "accepted").order("approved_at", { ascending: false })),
    run(supabase.from("customers").select("id, company_name, customer_no")),
  ]);
  const prices = rows.length ? await run(supabase.from("waste_profile_internal").select("waste_profile_id, unit_price").in("waste_profile_id", rows.map((r) => r.id))) : [];
  const priceMap = new Map(prices.map((p) => [p.waste_profile_id, p.unit_price]));
  const custMap = new Map(custs.map((c) => [c.id, c]));
  const m = page(`
    <h1>Export to Tegos</h1>
    <p class="muted">Choose approved waste profiles. The Excel file contains one sheet, <strong>BC Import</strong>, in the Tegos upload layout with the price per unit as the last column.</p>
    ${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th><input type="checkbox" id="sel-all" aria-label="Select all"></th><th>Reference</th><th>Customer</th>
      <th>Description</th><th>EWC</th><th class="num">Quantity</th><th class="num">Price / unit</th><th>Approved</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><input type="checkbox" class="sel" value="${r.id}" aria-label="Select ${esc(r.reference)}"></td>
        <td><a href="#/s/profile/${r.id}">${esc(r.reference)}</a></td><td>${esc(custMap.get(r.customer_id)?.company_name)}</td>
        <td>${esc(r.waste_description)}</td><td>${esc(r.ewc_code)}</td><td class="num">${fmtNum(r.quantity)} ${esc(r.unit_of_measure)}</td>
        <td class="num">${priceMap.get(r.id) ?? '<span class="muted">not priced</span>'}</td><td>${fmtDate(r.approved_at)}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="sticky-actions"><span id="sel-count" class="save-state">0 selected</span><button class="btn btn-primary" id="do-export" disabled>Export to Excel</button></div>`
      : empty("There are no approved waste profiles to export yet.")}`);
  if (!rows.length) return;
  const update = () => {
    const c = m.querySelectorAll(".sel:checked").length;
    m.querySelector("#sel-count").textContent = `${c} selected`;
    m.querySelector("#do-export").disabled = !c;
  };
  m.querySelector("#sel-all").addEventListener("change", (e) => { m.querySelectorAll(".sel").forEach((c) => { c.checked = e.target.checked; }); update(); });
  m.querySelectorAll(".sel").forEach((c) => c.addEventListener("change", update));
  m.querySelector("#do-export").addEventListener("click", async () => {
    const ids = [...m.querySelectorAll(".sel:checked")].map((c) => c.value);
    const doc = await askTegosDocument(ids.length);
    if (!doc) return;
    const btn = m.querySelector("#do-export");
    btn.disabled = true; btn.textContent = "Preparing…";
    try { await exportProfiles(ids, custMap, doc); }
    finally { btn.disabled = false; btn.textContent = "Export to Excel"; }
  });
}

export async function exportProfiles(ids, custMap, doc) {
  if (!doc || !DOC_TYPES.includes(doc.docType) || !DOC_NO_RE.test(doc.docNo || "")) throw new Error("A valid Tegos document type and number are required.");
  const [profiles, internals] = await Promise.all([
    run(supabase.from("waste_profiles").select("*").in("id", ids)),
    run(supabase.from("waste_profile_internal").select("*").in("waste_profile_id", ids)),
  ]);
  const siteIds = [...new Set(profiles.map((p) => p.collection_site_id).filter(Boolean))];
  const userIds = [...new Set(profiles.map((p) => p.submitted_by).filter(Boolean))];
  const [sites, users] = await Promise.all([
    siteIds.length ? run(supabase.from("collection_sites").select("*").in("id", siteIds)) : [],
    userIds.length ? run(supabase.from("user_profiles").select("user_id, full_name, email, phone").in("user_id", userIds)) : [],
  ]);
  const im = new Map(internals.map((x) => [x.waste_profile_id, x]));
  const sm = new Map(sites.map((x) => [x.id, x]));
  const um = new Map(users.map((x) => [x.user_id, x]));
  profiles.sort((a, b) => a.reference.localeCompare(b.reference));
  const data = [HEADERS, ...profiles.map((w, idx) => toRow(w, im.get(w.id) || {}, idx, custMap.get(w.customer_id), sm.get(w.collection_site_id), um.get(w.submitted_by), doc))];

  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const ws = XLSX.utils.aoa_to_sheet(data, { cellDates: true, dateNF: "dd/mm/yyyy" });
  ws["!cols"] = HEADERS.map((h) => ({ wch: Math.max(10, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "BC Import");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array", cellDates: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  downloadBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `BC_Import_${doc.docNo}_${stamp}.xlsx`);
  toast(`Exported ${profiles.length} waste profile${profiles.length === 1 ? "" : "s"} for ${doc.docType} ${doc.docNo}.`);
}
export { fetchAll };
