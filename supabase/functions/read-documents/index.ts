// read-documents: reads the documents uploaded to one waste profile with Claude (billed to Fornax's
// Anthropic account) and returns suggested questionnaire answers. Nothing is saved here: the portal
// shows the suggestions highlighted and the person saves them after checking.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const MODEL = "claude-opus-5-5";          // approved by Andy, 12 Oct 2026
const MAX_DOCS = 5;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const ALLOWED_ORIGINS = ["https://wp-prototype.pages.dev", "http://localhost:8765"];

function cors(req: Request) {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

const num = (description: string) => ({ type: "number", description });
const yn = (description: string) => ({ type: "boolean", description });

function toolSchema(lists: Record<string, string[]>) {
  const props: Record<string, unknown> = {
    waste_description: { type: "string", description: "Short description of the waste in the customer's words, max 100 characters." },
    physical_form: { type: "string", enum: lists.physical_form, description: "Physical form." },
    ewc_code: { type: "string", description: "European Waste Catalogue code in the format 'NN NN NN' with '*' if hazardous, e.g. '16 05 06*'. Only if stated or clearly determinable." },
    un_no: { type: "string", description: "4-digit UN number for transport, e.g. '1993'. Only if stated (section 14 of an SDS)." },
    packing_group: { type: "string", enum: lists.packing_group, description: "ADR packing group." },
    component: { type: "string", description: "Hazardous components, separated by '; ' (e.g. 'Acetone; Toluene')." },
    concentration: { type: "string", description: "Concentration of each component in the same order, separated by '; ' (e.g. '40%; 10-20%')." },
    hazardous_source_of_components: { type: "string", description: "Where the composition came from, e.g. 'Safety data sheet' or 'Laboratory analysis'." },
    pops_status: { type: "string", enum: ["Yes", "No", "Suspected", "Unknown"], description: "Contains persistent organic pollutants?" },
    pfas_status: { type: "string", enum: lists.yes_no_unknown, description: "Contains PFAS?" },
    pfas_mg_kg: num("PFAS concentration in mg/kg."),
    contains_radionuclides: yn("Contains radioactive components."),
    halogen_content_pct: num("Total halogen content, % by weight (0-100)."),
    metal_content_pct: num("Total metal content, % by weight (0-100)."),
    flash_point_c: num("Flash point in °C."),
    ph_value: num("pH (0-14)."),
    water_content_pct: num("Water content, % by weight."),
    ash_content_pct: num("Ash content, % by weight."),
    calorific_value_mj_kg: num("Gross calorific value in MJ/kg."),
    reducing_agent: { type: "string", enum: lists.yes_no_unknown, description: "Is it a reducing agent?" },
    lachrymator: { type: "string", enum: lists.yes_no_unknown, description: "Is it a lachrymator (tear-inducing)?" },
    odour: { type: "string", enum: lists.odour, description: "Odour level." },
    notes: { type: "string", description: "One or two sentences for the person filling the form: anything uncertain or worth checking." },
  };
  const hp: [string, string][] = [["hp_01", "explosive"], ["hp_02", "oxidising"], ["hp_03", "flammable"], ["hp_04", "irritant"],
    ["hp_05", "specific target organ toxicity / aspiration"], ["hp_06", "acute toxicity"], ["hp_07", "carcinogenic"], ["hp_08", "corrosive"],
    ["hp_09", "infectious"], ["hp_10", "toxic for reproduction"], ["hp_11", "mutagenic"], ["hp_12", "releases acute toxic gas"],
    ["hp_13", "sensitising"], ["hp_14", "ecotoxic"], ["hp_15", "can display a hazardous property not shown by the original waste"]];
  for (const [k, d] of hp) props[k] = yn(`Hazardous property ${k.replace("hp_0", "HP").replace("hp_", "HP")} – ${d}. Only true if the documents support it (e.g. via H-statements).`);
  for (const el of ["free_cyanide", "complexed_cyanide", "organic_nitrogen", "fluorine", "chlorine", "bromine", "iodine", "sulfur", "phosphorus",
    "mercury", "cadmium", "lead", "chromium", "nickel", "copper", "zinc", "arsenic", "antimony", "tin", "barium", "cobalt", "manganese", "iron"]) {
    props[`${el}_mg_kg`] = num(`${el.replace("_", " ")} concentration in mg/kg (1% = 10,000 mg/kg).`);
  }
  return {
    name: "fill_waste_profile",
    description: "Record the waste profile answers found in the documents. Leave out any field the documents do not support. Never guess.",
    input_schema: { type: "object", properties: props },
  };
}

const RANGES: Record<string, [number, number]> = {
  halogen_content_pct: [0, 100], metal_content_pct: [0, 100], flash_point_c: [-100, 1000], ph_value: [0, 14],
  water_content_pct: [0, 100], ash_content_pct: [0, 100], calorific_value_mj_kg: [0, 100], pfas_mg_kg: [0, 1e6],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed." }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json(req, { error: "Reading documents is not switched on yet. Please fill in the form manually for now." }, 503);

  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  // Client acting as the caller: row level security decides whether they may see this waste profile.
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let body: { waste_profile_id?: string };
  try { body = await req.json(); } catch { return json(req, { error: "Invalid request." }, 400); }
  const id = body.waste_profile_id;
  if (!id) return json(req, { error: "Missing waste profile." }, 400);

  const { data: wp } = await asUser.from("waste_profiles").select("id, status").eq("id", id).maybeSingle();
  if (!wp) return json(req, { error: "Waste profile not found." }, 404);

  const { data: docs } = await asUser.from("waste_profile_documents").select("*").eq("waste_profile_id", id).order("created_at", { ascending: false }).limit(MAX_DOCS);
  if (!docs?.length) return json(req, { error: "Upload a document first." }, 400);

  const content: unknown[] = [];
  let total = 0;
  for (const d of docs) {
    const { data: file, error } = await admin.storage.from("maq-documents").download(d.storage_path);
    if (error || !file) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) break;
    const mime = d.mime_type || file.type;
    if (mime === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: encodeBase64(bytes) }, title: d.file_name });
    } else if (mime?.startsWith("image/")) {
      content.push({ type: "image", source: { type: "base64", media_type: mime, data: encodeBase64(bytes) } });
    } else {
      content.push({ type: "document", source: { type: "text", media_type: "text/plain", data: new TextDecoder().decode(bytes).slice(0, 200000) }, title: d.file_name });
    }
  }
  if (!content.length) return json(req, { error: "The documents could not be opened." }, 400);

  const { data: listRows } = await admin.from("ref_list_values").select("list_name, code");
  const lists: Record<string, string[]> = {};
  for (const r of listRows ?? []) (lists[r.list_name] ||= []).push(r.code);

  await admin.from("waste_profile_documents").update({ ai_status: "reading" }).in("id", docs.map((d) => d.id));

  content.push({ type: "text", text:
    "You are helping a customer of a hazardous-waste incineration plant complete a waste profile questionnaire. " +
    "Read the attached documents (usually safety data sheets or laboratory reports) and call fill_waste_profile with every answer the documents clearly support. " +
    "Leave out anything not supported. Use the exact list values given in the tool schema. Convert percentages to mg/kg where the field asks for mg/kg (1% = 10,000 mg/kg)." });

  let result: Record<string, unknown> | null = null, usage = { input_tokens: 0, output_tokens: 0 };
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 16000,
        system: "You fill in waste profile questionnaires from documents. Always answer by calling the fill_waste_profile tool exactly once. Do not reply with plain text.",
        // Newer models only accept "auto" here; the system prompt asks for the tool call.
        tools: [toolSchema(lists)], tool_choice: { type: "auto" },
        messages: [{ role: "user", content }],
      }),
    });
    const out = await resp.json();
    if (!resp.ok) throw new Error(out?.error?.message || `Claude API error ${resp.status}`);
    usage = out.usage ?? usage;
    const call = out.content?.find((c: { type: string; name?: string }) => c.type === "tool_use" && c.name === "fill_waste_profile");
    if (!call) throw new Error(`No answers returned (stop_reason: ${out.stop_reason})`);
    result = call.input ?? {};
  } catch (e) {
    await admin.from("waste_profile_documents").update({ ai_status: "failed", ai_error: String(e).slice(0, 500) }).in("id", docs.map((d) => d.id));
    return json(req, { error: "The documents could not be read right now. Please try again later or fill in the form manually." }, 502);
  }

  // ---- validate every suggestion against the portal's rules before returning it
  const values: Record<string, unknown> = {};
  const r = result ?? {};
  const notes = typeof r.notes === "string" ? r.notes.slice(0, 400) : "";
  delete r.notes;
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined || v === "") continue;
    if (k === "ewc_code") {
      const code = String(v).trim();
      const { data } = await admin.from("ref_ewc").select("ewc_code").eq("ewc_code", code).maybeSingle();
      if (data) values.ewc_code = code;
    } else if (k === "un_no") {
      const un = String(v).replace(/\D/g, "").padStart(4, "0").slice(-4);
      const { data } = await admin.from("ref_adr").select("adr_code").eq("un_no", un);
      if (data?.length) { values.un_no = un; if (data.length === 1) values.adr_code = data[0].adr_code; }
    } else if (typeof v === "number" || (k.endsWith("_mg_kg") || k.endsWith("_pct") || k in RANGES)) {
      const n = Number(v);
      if (!isFinite(n)) continue;
      const [lo, hi] = RANGES[k] ?? [0, 1e6];
      if (n >= lo && n <= hi) values[k] = n;
    } else if (typeof v === "boolean") {
      values[k] = v;
    } else {
      values[k] = k === "waste_description" ? String(v).slice(0, 100) : String(v).slice(0, 2000);
    }
  }

  await admin.from("waste_profile_documents").update({
    ai_status: "done", ai_result: { values, notes }, ai_input_tokens: usage.input_tokens, ai_output_tokens: usage.output_tokens,
  }).in("id", docs.map((d) => d.id));

  return json(req, { values, filled: Object.keys(values), notes });
});
