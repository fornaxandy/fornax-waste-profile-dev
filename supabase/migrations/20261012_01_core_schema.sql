-- Migration 1: core schema for the customer waste-profile portal (MVP).
-- All tables have RLS enabled; access rules are added in migration 2.

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, anon, service_role;

create type public.user_role as enum ('customer','admin','sales','chemist','ops');
create type public.waste_profile_status as enum ('started','draft','pending_approval','accepted');
create type public.quote_status as enum ('draft','sent','accepted','withdrawn');

-- ---------------------------------------------------------------- reference data
create table public.ref_list_values (
  list_name text not null,
  code text not null,
  description text,
  sort_order integer not null default 0,
  primary key (list_name, code)
);
comment on table public.ref_list_values is 'Dropdown values (Tegos lists take priority): physical_form, packing_group, tunnel_code, odour, compatibility_group, comah, yes_no_unknown, adr_class, item.';

create table public.ref_ewc (
  ewc_code text primary key,
  name text not null,
  official_description text
);
comment on table public.ref_ewc is 'Allowed EWC codes only (EWC file, Blocked = false). Customers must pick from this list.';

create table public.ref_adr (
  adr_code text primary key,
  un_no text not null,
  name_description text,
  proper_shipping_name text,
  class_summary text
);
create index ref_adr_un_no_idx on public.ref_adr (un_no);
comment on table public.ref_adr is 'ADR file: col A ADR code, col B UN No., col C description, col D proper shipping name, col E class summary.';

create table public.ref_equipment (
  equipment_no text primary key,
  equipment_group text not null,
  description text not null,
  display_name text generated always as (equipment_group || ' – ' || description) stored
);
comment on table public.ref_equipment is 'Plant equipment / containers. Customer sees display_name; number stored automatically.';

create table public.ref_services (
  service_no text primary key,
  description text not null,
  unit_of_measure text not null check (unit_of_measure in ('KG','L','EA')),
  service_type text not null check (service_type in ('Waste','G/L')),
  waste_type text
);
comment on table public.ref_services is 'Tegos services. Waste services set from waste type + unit; G/L services are quote charges.';

create or replace function app.in_list(p_list text, p_code text)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.ref_list_values v where v.list_name = p_list and v.code = p_code) $$;
grant execute on function app.in_list(text, text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------- customers and users
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  customer_no text not null unique,
  company_name text not null,
  address_line1 text,
  address_line2 text,
  town text,
  postcode text,
  phone text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
comment on column public.customers.customer_no is 'Must match the Tegos customer number. Only staff can change it.';

create table public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  phone text,
  role public.user_role not null default 'customer',
  customer_id uuid references public.customers(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_has_company check (role <> 'customer' or customer_id is not null)
);
create index user_profiles_customer_idx on public.user_profiles (customer_id);
comment on table public.user_profiles is 'One row per login. Roles: customer, admin (super user), sales, chemist, ops. Staff roles are set only by SQL.';

create table public.collection_sites (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  site_name text not null,
  address_line1 text,
  address_line2 text,
  town text,
  postcode text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
create index collection_sites_customer_idx on public.collection_sites (customer_id);
comment on table public.collection_sites is 'Customer-managed collection sites; picked in the MAQ to fill Tegos Collection Site & Postcode (D12).';

-- ---------------------------------------------------------------- waste profiles (MAQ)
create sequence public.waste_profile_ref_seq;
create table public.waste_profiles (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('MAQ-' || lpad(nextval('public.waste_profile_ref_seq')::text, 6, '0')),
  customer_id uuid not null references public.customers(id),
  collection_site_id uuid references public.collection_sites(id),
  status public.waste_profile_status not null default 'started',
  waste_type text not null default 'hazardous' check (waste_type in ('hazardous')),
  service_no text references public.ref_services(service_no),
  service_description text,
  material_no text not null default 'I-0000001',
  waste_description text check (char_length(waste_description) <= 100),
  quantity numeric(14,3) not null default 0 check (quantity >= 0),
  equipment_no text references public.ref_equipment(equipment_no),
  equipment_group text,
  equipment_description text,
  equipment_quantity integer not null default 0 check (equipment_quantity between 0 and 100000),
  unit_of_measure text not null check (unit_of_measure in ('KG','L','EA')),
  ewc_code text references public.ref_ewc(ewc_code),
  un_no text,
  adr_code text references public.ref_adr(adr_code),
  proper_shipping_name text,
  adr_class_1 text,
  adr_class_2 text,
  adr_class_3 text,
  adr_class_4 text,
  adr_class_summary text,
  packing_group text check (packing_group is null or app.in_list('packing_group', packing_group)),
  hp_01 boolean not null default false,
  hp_02 boolean not null default false,
  hp_03 boolean not null default false,
  hp_04 boolean not null default false,
  hp_05 boolean not null default false,
  hp_06 boolean not null default false,
  hp_07 boolean not null default false,
  hp_08 boolean not null default false,
  hp_09 boolean not null default false,
  hp_10 boolean not null default false,
  hp_11 boolean not null default false,
  hp_12 boolean not null default false,
  hp_13 boolean not null default false,
  hp_14 boolean not null default false,
  hp_15 boolean not null default false,
  pops_status text not null default 'No' check (pops_status in ('Yes','No','Suspected','Unknown')),
  pops_source_of_components text,
  pop_component text,
  pop_concentration_pct numeric(14,4) not null default 0 check (pop_concentration_pct between 0 and 100),
  physical_form text check (physical_form is null or app.in_list('physical_form', physical_form)),
  hazardous_source_of_components text,
  concentration text,
  component text,
  contains_radionuclides boolean not null default false,
  collection_date date,
  halogen_content_pct numeric(14,4) not null default 0 check (halogen_content_pct between 0 and 100),
  metal_content_pct numeric(14,4) not null default 0 check (metal_content_pct between 0 and 100),
  flash_point_c numeric(14,4) not null default 0 check (flash_point_c between -100 and 1000),
  ph_value numeric(14,4) not null default 0 check (ph_value between 0 and 14),
  water_content_pct numeric(14,4) not null default 0 check (water_content_pct between 0 and 100),
  ash_content_pct numeric(14,4) not null default 0 check (ash_content_pct between 0 and 100),
  calorific_value_mj_kg numeric(14,4) not null default 0 check (calorific_value_mj_kg between 0 and 100),
  reducing_agent text not null default 'No' check (reducing_agent is null or app.in_list('yes_no_unknown', reducing_agent)),
  lachrymator text not null default 'No' check (lachrymator is null or app.in_list('yes_no_unknown', lachrymator)),
  free_cyanide_mg_kg numeric(14,4) not null default 0 check (free_cyanide_mg_kg between 0 and 1000000),
  complexed_cyanide_mg_kg numeric(14,4) not null default 0 check (complexed_cyanide_mg_kg between 0 and 1000000),
  organic_nitrogen_mg_kg numeric(14,4) not null default 0 check (organic_nitrogen_mg_kg between 0 and 1000000),
  fluorine_mg_kg numeric(14,4) not null default 0 check (fluorine_mg_kg between 0 and 1000000),
  chlorine_mg_kg numeric(14,4) not null default 0 check (chlorine_mg_kg between 0 and 1000000),
  bromine_mg_kg numeric(14,4) not null default 0 check (bromine_mg_kg between 0 and 1000000),
  iodine_mg_kg numeric(14,4) not null default 0 check (iodine_mg_kg between 0 and 1000000),
  sulfur_mg_kg numeric(14,4) not null default 0 check (sulfur_mg_kg between 0 and 1000000),
  phosphorus_mg_kg numeric(14,4) not null default 0 check (phosphorus_mg_kg between 0 and 1000000),
  mercury_mg_kg numeric(14,4) not null default 0 check (mercury_mg_kg between 0 and 1000000),
  cadmium_mg_kg numeric(14,4) not null default 0 check (cadmium_mg_kg between 0 and 1000000),
  lead_mg_kg numeric(14,4) not null default 0 check (lead_mg_kg between 0 and 1000000),
  chromium_mg_kg numeric(14,4) not null default 0 check (chromium_mg_kg between 0 and 1000000),
  nickel_mg_kg numeric(14,4) not null default 0 check (nickel_mg_kg between 0 and 1000000),
  copper_mg_kg numeric(14,4) not null default 0 check (copper_mg_kg between 0 and 1000000),
  zinc_mg_kg numeric(14,4) not null default 0 check (zinc_mg_kg between 0 and 1000000),
  arsenic_mg_kg numeric(14,4) not null default 0 check (arsenic_mg_kg between 0 and 1000000),
  antimony_mg_kg numeric(14,4) not null default 0 check (antimony_mg_kg between 0 and 1000000),
  tin_mg_kg numeric(14,4) not null default 0 check (tin_mg_kg between 0 and 1000000),
  barium_mg_kg numeric(14,4) not null default 0 check (barium_mg_kg between 0 and 1000000),
  cobalt_mg_kg numeric(14,4) not null default 0 check (cobalt_mg_kg between 0 and 1000000),
  manganese_mg_kg numeric(14,4) not null default 0 check (manganese_mg_kg between 0 and 1000000),
  iron_mg_kg numeric(14,4) not null default 0 check (iron_mg_kg between 0 and 1000000),
  pfas_status text not null default 'No' check (pfas_status is null or app.in_list('yes_no_unknown', pfas_status)),
  pfas_mg_kg numeric(14,4) not null default 0 check (pfas_mg_kg between 0 and 1000000),
  odour text check (odour is null or app.in_list('odour', odour)),
  compatibility_group text check (compatibility_group is null or app.in_list('compatibility_group', compatibility_group)),
  settled_liquid_pct numeric(14,4) not null default 0 check (settled_liquid_pct between 0 and 100),
  hp_16 boolean not null default false,
  comah_code text check (comah_code is null or app.in_list('comah', comah_code)),
  declaration_confirmed boolean not null default false,
  submitted_at timestamptz,
  submitted_by uuid references auth.users(id),
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  archived_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
create index waste_profiles_customer_idx on public.waste_profiles (customer_id);
create index waste_profiles_status_idx on public.waste_profiles (status);
comment on table public.waste_profiles is 'Material Assessment Questionnaire / waste profile. Customer-facing fields (HAZ WASTE "Required" rows) plus workflow columns.';

create table public.waste_profile_internal (
  waste_profile_id uuid primary key references public.waste_profiles(id) on delete cascade,
  unit_price numeric(14,4) check (unit_price is null or unit_price >= 0),
  batch_name text,
  document_type text,
  document_no text,
  document_line_no text,
  waste_entry_line_no text,
  waste_mgt_line_exist boolean not null default false,
  delete_line boolean not null default false,
  direction_type text,
  unit_quantity numeric(14,3) not null default 0,
  count_of_items integer not null default 0,
  nos_text text,
  supplementary_information text,
  packing_instructions text,
  tunnel_code text check (tunnel_code is null or app.in_list('tunnel_code', tunnel_code)),
  emergency_action_code text,
  recovery_disposal_code text,
  location_code text,
  bin_code text,
  disposal_site_no text,
  radioactivity_1 text,
  radionuclide_2 text,
  radioactivity_2 text,
  radionuclide_3 text,
  radioactivity_3 text,
  radionuclide_4 text,
  radioactivity_4 text,
  radionuclide_5 text,
  radioactivity_5 text,
  radionuclide_6 text,
  radioactivity_6 text,
  radionuclide_7 text,
  radioactivity_7 text,
  radionuclide_8 text,
  radioactivity_8 text,
  radionuclide_9 text,
  radioactivity_9 text,
  bin_reference text,
  ghs_code text,
  ehs_image text,
  weight_of_active_ingredient numeric(14,4) not null default 0,
  in_transit boolean not null default false,
  i_t_date_in date,
  i_t_date_out date,
  stabilisation_required boolean not null default false,
  landfill_cell text,
  ewc_ar text,
  round_type text,
  alternative_round_type text,
  alternative_tour_sequence text,
  signal_word text,
  received_date date,
  consignment_note_no text,
  external_consignment_note_no text,
  weee_category text,
  weee_classification text,
  comments text check (char_length(comments) <= 250),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
comment on table public.waste_profile_internal is 'Staff-only fields (Sales / System / Not Required rows) and the unit price. Never visible to customers.';
comment on column public.waste_profile_internal.unit_price is 'Price per unit of measure (KG/L/EA), set by Sales. Exported as the last BC Import column "Price".';

-- ---------------------------------------------------------------- quotes
create sequence public.quote_ref_seq;
create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('Q-' || lpad(nextval('public.quote_ref_seq')::text, 6, '0')),
  customer_id uuid not null references public.customers(id),
  status public.quote_status not null default 'draft',
  currency text not null default 'GBP',
  notes text,
  sent_at timestamptz,
  sent_by uuid references auth.users(id),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id),
  withdrawn_at timestamptz,
  withdrawn_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
create index quotes_customer_idx on public.quotes (customer_id);

create table public.quote_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  waste_profile_id uuid not null references public.waste_profiles(id),
  created_at timestamptz not null default now(),
  unique (quote_id, waste_profile_id)
);
create index quote_items_profile_idx on public.quote_items (waste_profile_id);
comment on table public.quote_items is 'Accepted waste profiles on a quote (max 200 per quote). Price lives on the waste profile.';

create table public.quote_charges (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  service_no text not null references public.ref_services(service_no),
  description text,
  unit_of_measure text not null default 'EA',
  quantity numeric(14,3) not null default 1 check (quantity > 0),
  unit_price numeric(14,4) not null default 0 check (unit_price >= 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index quote_charges_quote_idx on public.quote_charges (quote_id);

-- ---------------------------------------------------------------- messages (kept apart from data tables)
create table public.waste_profile_messages (
  id uuid primary key default gen_random_uuid(),
  waste_profile_id uuid not null references public.waste_profiles(id) on delete cascade,
  sender_id uuid not null references auth.users(id),
  body text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index wpm_profile_idx on public.waste_profile_messages (waste_profile_id, created_at);
comment on table public.waste_profile_messages is 'Conversation about one MAQ as a whole.';

create table public.general_messages (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  thread_id uuid references public.general_messages(id) on delete cascade,
  topic text check (char_length(topic) <= 200),
  sender_id uuid not null references auth.users(id),
  body text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now(),
  constraint topic_on_first_message check (thread_id is not null or topic is not null)
);
create index gm_customer_idx on public.general_messages (customer_id, created_at);
create index gm_thread_idx on public.general_messages (thread_id);
comment on table public.general_messages is '"Send a message to Fornax": first message has a topic; replies reference thread_id. Portal only, no email.';

-- ---------------------------------------------------------------- lock everything down (policies come in migration 2)
alter table public.ref_list_values enable row level security;
alter table public.ref_ewc enable row level security;
alter table public.ref_adr enable row level security;
alter table public.ref_equipment enable row level security;
alter table public.ref_services enable row level security;
alter table public.customers enable row level security;
alter table public.user_profiles enable row level security;
alter table public.collection_sites enable row level security;
alter table public.waste_profiles enable row level security;
alter table public.waste_profile_internal enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_items enable row level security;
alter table public.quote_charges enable row level security;
alter table public.waste_profile_messages enable row level security;
alter table public.general_messages enable row level security;
