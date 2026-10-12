// Questionnaire (MAQ) field definitions. Column names match the database (public.waste_profiles).
// Types: text, textarea, number, int, yesno (boolean), list (ref_list_values), select (fixed options),
//        ewc (search), un (search), adr (filtered by UN), equipment, site, date, readonly.
// Defaults follow "populate by exception": numbers 0, text blank, dropdowns empty, yes/no = No.

export const UNIT_OPTIONS = [
  { code: "KG", label: "KG (Kilogram)" },
  { code: "L", label: "L (Litres)" },
  { code: "EA", label: "EA (Each)" },
];

export const WASTE_TYPES = [
  { code: "hazardous", label: "Hazardous waste", enabled: true },
  { code: "clinical", label: "Clinical waste (coming later)", enabled: false },
  { code: "laboratory", label: "Laboratory waste (coming later)", enabled: false },
  { code: "controlled_drugs", label: "Controlled drugs (coming later)", enabled: false },
];

const mgkg = (col, label) => ({ col, label: `${label} (mg/kg)`, type: "number", min: 0, max: 1000000 });

export const SECTIONS = [
  {
    id: "general", title: "The waste",
    fields: [
      { col: "waste_description", label: "Waste description", type: "text", max: 100,
        hint: "In your own words: what the material is, the process it came from and what it looks like (max 100 characters)." },
      { col: "collection_site_id", label: "Collection site", type: "site",
        hint: "Choose one of your saved sites. Add sites under Company details." },
      { col: "collection_date", label: "Collection date (optional)", type: "date" },
      { col: "quantity", label: "Quantity", type: "number", min: 0, unitSuffix: true,
        hint: "Expected total amount in this consignment, in the unit of measure chosen for this waste stream." },
      { col: "equipment_no", label: "Container type", type: "equipment",
        hint: "The container the waste will arrive in." },
      { col: "equipment_quantity", label: "Number of containers", type: "int", min: 0, max: 100000 },
      { col: "physical_form", label: "Physical form", type: "list", list: "physical_form" },
      { col: "ewc_code", label: "EWC code", type: "ewc",
        hint: "Start typing the code or a word from the description. Only codes on the list can be accepted." },
    ],
  },
  {
    id: "transport", title: "Transport (ADR)",
    intro: "If the waste is not dangerous goods for transport, leave the UN number empty.",
    fields: [
      { col: "un_no", label: "UN number", type: "un", hint: "Type the 4-digit UN number." },
      { col: "adr_code", label: "ADR entry", type: "adr", hint: "Choose the entry that matches your waste. The fields below fill automatically." },
      { col: "proper_shipping_name", label: "Proper shipping name", type: "readonly" },
      { col: "adr_class_summary", label: "ADR class", type: "readonly" },
      { col: "packing_group", label: "Packing group", type: "list", list: "packing_group" },
    ],
  },
  {
    id: "hp", title: "Hazardous properties",
    intro: "Answer Yes for each hazardous property the waste displays.",
    fields: [
      ["hp_01", "HP1 Explosive"], ["hp_02", "HP2 Oxidising"], ["hp_03", "HP3 Flammable"],
      ["hp_04", "HP4 Irritant (skin irritation and eye damage)"], ["hp_05", "HP5 Specific target organ toxicity / aspiration toxicity"],
      ["hp_06", "HP6 Acute toxicity"], ["hp_07", "HP7 Carcinogenic"], ["hp_08", "HP8 Corrosive"], ["hp_09", "HP9 Infectious"],
      ["hp_10", "HP10 Toxic for reproduction"], ["hp_11", "HP11 Mutagenic"], ["hp_12", "HP12 Release of an acute toxic gas"],
      ["hp_13", "HP13 Sensitising"], ["hp_14", "HP14 Ecotoxic"],
      ["hp_15", "HP15 Can display a hazardous property not directly shown by the original waste"], ["hp_16", "HP16"],
    ].map(([col, label]) => ({ col, label, type: "yesno" })),
  },
  {
    id: "composition", title: "Composition",
    fields: [
      { col: "component", label: "Hazardous components", type: "textarea",
        hint: "List each hazardous component, e.g. Acetone; Toluene." },
      { col: "concentration", label: "Concentrations", type: "textarea",
        hint: "Concentration of each component, in the same order, e.g. 40%; 10%." },
      { col: "hazardous_source_of_components", label: "Source of composition information", type: "text",
        hint: "Laboratory analysis, safety data sheet or process knowledge." },
      { col: "pops_status", label: "Contains persistent organic pollutants (POPs)?", type: "select",
        options: ["No", "Yes", "Suspected", "Unknown"] },
      { col: "pops_source_of_components", label: "POPs: source of information", type: "text", showIf: { col: "pops_status", in: ["Yes", "Suspected"] } },
      { col: "pop_component", label: "POPs: substance", type: "text", showIf: { col: "pops_status", in: ["Yes", "Suspected"] } },
      { col: "pop_concentration_pct", label: "POPs: concentration (%)", type: "number", min: 0, max: 100, showIf: { col: "pops_status", in: ["Yes", "Suspected"] } },
      { col: "contains_radionuclides", label: "Contains radioactive components?", type: "yesno" },
      { col: "pfas_status", label: "Contains PFAS?", type: "list", list: "yes_no_unknown" },
      { col: "pfas_mg_kg", label: "PFAS (mg/kg)", type: "number", min: 0, max: 1000000, showIf: { col: "pfas_status", in: ["Yes"] } },
    ],
  },
  {
    id: "analysis", title: "Analysis – general",
    fields: [
      { col: "halogen_content_pct", label: "Halogen content (% w/w)", type: "number", min: 0, max: 100 },
      { col: "metal_content_pct", label: "Metal content (% w/w)", type: "number", min: 0, max: 100 },
      { col: "flash_point_c", label: "Flash point (°C)", type: "number", min: -100, max: 1000,
        hint: "Numbers only. If only a range is known (e.g. above 60 °C), enter the bound and explain in a message." },
      { col: "ph_value", label: "pH (0–14)", type: "number", min: 0, max: 14 },
      { col: "water_content_pct", label: "Water content (% w/w)", type: "number", min: 0, max: 100 },
      { col: "ash_content_pct", label: "Ash content (% w/w)", type: "number", min: 0, max: 100 },
      { col: "calorific_value_mj_kg", label: "Calorific value (MJ/kg)", type: "number", min: 0, max: 100 },
      { col: "reducing_agent", label: "Reducing agent?", type: "list", list: "yes_no_unknown" },
      { col: "lachrymator", label: "Lachrymator (tear-inducing)?", type: "list", list: "yes_no_unknown" },
      { col: "odour", label: "Odour", type: "list", list: "odour" },
      { col: "settled_liquid_pct", label: "Settled / free liquid (% v/v)", type: "number", min: 0, max: 100 },
      { col: "compatibility_group", label: "ADR compatibility group (Class 1 explosives only)", type: "list", list: "compatibility_group", showDescription: true },
      { col: "comah_code", label: "COMAH / Seveso category", type: "list", list: "comah", showDescription: true },
    ],
  },
  {
    id: "elements", title: "Analysis – elements and metals",
    intro: "Concentrations in mg/kg (1% = 10,000 mg/kg).",
    fields: [
      mgkg("free_cyanide_mg_kg", "Free cyanide"), mgkg("complexed_cyanide_mg_kg", "Complexed cyanide"),
      mgkg("organic_nitrogen_mg_kg", "Organic nitrogen"), mgkg("fluorine_mg_kg", "Fluorine"), mgkg("chlorine_mg_kg", "Chlorine"),
      mgkg("bromine_mg_kg", "Bromine"), mgkg("iodine_mg_kg", "Iodine"), mgkg("sulfur_mg_kg", "Sulfur"),
      mgkg("phosphorus_mg_kg", "Phosphorus"), mgkg("mercury_mg_kg", "Mercury"), mgkg("cadmium_mg_kg", "Cadmium"),
      mgkg("lead_mg_kg", "Lead"), mgkg("chromium_mg_kg", "Chromium"), mgkg("nickel_mg_kg", "Nickel"), mgkg("copper_mg_kg", "Copper"),
      mgkg("zinc_mg_kg", "Zinc"), mgkg("arsenic_mg_kg", "Arsenic"), mgkg("antimony_mg_kg", "Antimony"), mgkg("tin_mg_kg", "Tin"),
      mgkg("barium_mg_kg", "Barium"), mgkg("cobalt_mg_kg", "Cobalt"), mgkg("manganese_mg_kg", "Manganese"), mgkg("iron_mg_kg", "Iron"),
    ],
  },
];

// Columns the customer edits (sent on save). Read-only/derived columns are filled by the database.
export const EDITABLE_COLS = SECTIONS.flatMap((s) => s.fields)
  .filter((f) => f.type !== "readonly")
  .map((f) => f.col);

export function defaultValue(f) {
  switch (f.type) {
    case "number": case "int": return 0;
    case "yesno": return false;
    case "select": return f.options[0];
    case "list": return f.list === "yes_no_unknown" ? "No" : null;
    default: return null;
  }
}

export function defaultData() {
  const d = {};
  for (const s of SECTIONS) for (const f of s.fields) if (f.type !== "readonly") d[f.col] = defaultValue(f);
  d.un_no = null;
  return d;
}

// Staff-only fields (public.waste_profile_internal). Not shown to customers.
export const INTERNAL_FIELDS = [
  ["unit_price", "Price per unit (£)", "number"],
  ["comments", "Comments for Tegos (max 250)", "text"],
  ["direction_type", "Direction type (material)", "text"],
  ["nos_text", "NOS text (technical names)", "text"],
  ["supplementary_information", "Supplementary information", "text"],
  ["packing_instructions", "Packing instructions", "text"],
  ["tunnel_code", "Tunnel code", "list:tunnel_code"],
  ["emergency_action_code", "Emergency action code (EAC)", "text"],
  ["recovery_disposal_code", "R/D code", "text"],
  ["ewc_ar", "EWC A/R (absolute / mirror)", "text"],
  ["signal_word", "Signal word", "text"],
  ["ehs_image", "EHS image (pictograms)", "text"],
  ["weight_of_active_ingredient", "Weight of active ingredient", "number"],
  ["stabilisation_required", "Stabilisation required", "bool"],
  ["unit_quantity", "Unit quantity", "number"],
  ["count_of_items", "Count of items", "int"],
  ["radioactivity_1", "Radioactivity 1", "text"],
  ["radionuclide_2", "Radionuclide 2", "text"], ["radioactivity_2", "Radioactivity 2", "text"],
  ["radionuclide_3", "Radionuclide 3", "text"], ["radioactivity_3", "Radioactivity 3", "text"],
  ["radionuclide_4", "Radionuclide 4", "text"], ["radioactivity_4", "Radioactivity 4", "text"],
  ["radionuclide_5", "Radionuclide 5", "text"], ["radioactivity_5", "Radioactivity 5", "text"],
  ["radionuclide_6", "Radionuclide 6", "text"], ["radioactivity_6", "Radioactivity 6", "text"],
  ["radionuclide_7", "Radionuclide 7", "text"], ["radioactivity_7", "Radioactivity 7", "text"],
  ["radionuclide_8", "Radionuclide 8", "text"], ["radioactivity_8", "Radioactivity 8", "text"],
  ["radionuclide_9", "Radionuclide 9", "text"], ["radioactivity_9", "Radioactivity 9", "text"],
  ["disposal_site_no", "Disposal site no.", "text"],
  ["landfill_cell", "Landfill cell", "text"],
  ["round_type", "Round type", "text"],
  ["alternative_round_type", "Alternative round type", "text"],
  ["alternative_tour_sequence", "Alternative tour sequence", "text"],
  ["weee_category", "WEEE category", "text"],
  ["weee_classification", "WEEE classification", "text"],
  ["batch_name", "Batch name (Tegos)", "text"],
  ["document_type", "Document type (Tegos)", "text"],
  ["document_no", "Document no. (Tegos)", "text"],
  ["document_line_no", "Document line no. (Tegos)", "text"],
  ["waste_entry_line_no", "Waste entry line no. (Tegos)", "text"],
  ["location_code", "Location code (Tegos)", "text"],
  ["bin_code", "Bin code (Tegos)", "text"],
  ["bin_reference", "Bin reference (Tegos)", "text"],
  ["consignment_note_no", "Consignment note no.", "text"],
  ["external_consignment_note_no", "External consignment note no.", "text"],
  ["received_date", "Received date", "date"],
  ["in_transit", "In transit", "bool"],
  ["i_t_date_in", "In-transit date in", "date"],
  ["i_t_date_out", "In-transit date out", "date"],
  ["waste_mgt_line_exist", "Waste mgt. line exists", "bool"],
  ["delete_line", "Delete line", "bool"],
  ["ghs_code", "GHS code (not used yet)", "text"],
].map(([col, label, type]) => ({ col, label, type }));

export const STATUS_LABEL = {
  started: "Started", draft: "Draft", pending_approval: "Pending approval", accepted: "Accepted",
};
export const QUOTE_STATUS_LABEL = { draft: "Draft", sent: "Sent", accepted: "Accepted by customer", withdrawn: "Withdrawn" };
