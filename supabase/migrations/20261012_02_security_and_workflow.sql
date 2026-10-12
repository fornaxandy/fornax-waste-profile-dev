-- Migration 2: role helpers, workflow triggers and row level security.
-- Roles: customer (own company only), admin (super user), sales, chemist, ops (orders only; no waste profiles or quotes).
-- Rules agreed with Andy, 9–12 Oct 2026. Calls made with no logged-in user (SQL editor, service role) are not restricted.

drop function if exists public.set_updated_at();

-- ------------------------------------------------------------------ helpers
create or replace function app.my_role() returns public.user_role
language sql stable security definer set search_path = '' as $$
  select p.role from public.user_profiles p where p.user_id = (select auth.uid()) and p.is_active
$$;

create or replace function app.my_customer_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.customer_id from public.user_profiles p where p.user_id = (select auth.uid()) and p.is_active
$$;

create or replace function app.has_role(variadic p_roles public.user_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app.my_role() = any (p_roles), false)
$$;

grant execute on function app.my_role(), app.my_customer_id(), app.has_role(public.user_role[]) to authenticated;

create or replace function app.touch_updated() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if to_jsonb(new) ? 'updated_by' then
    new := jsonb_populate_record(new, jsonb_build_object('updated_by', auth.uid()));
  end if;
  return new;
end $$;

create trigger customers_touch before update on public.customers for each row execute function app.touch_updated();
create trigger user_profiles_touch before update on public.user_profiles for each row execute function app.touch_updated();
create trigger collection_sites_touch before update on public.collection_sites for each row execute function app.touch_updated();
create trigger waste_profiles_touch before update on public.waste_profiles for each row execute function app.touch_updated();
create trigger waste_profile_internal_touch before update on public.waste_profile_internal for each row execute function app.touch_updated();
create trigger quotes_touch before update on public.quotes for each row execute function app.touch_updated();

-- ------------------------------------------------------------------ user profiles
create or replace function app.user_profiles_guard() returns trigger
language plpgsql set search_path = '' as $$
declare r public.user_role := app.my_role();
begin
  if auth.uid() is null or r = 'admin' then return new; end if;
  if new.user_id <> old.user_id or new.email <> old.email or new.role <> old.role
     or new.customer_id is distinct from old.customer_id then
    raise exception 'Only the administrator can change login email, role or company.';
  end if;
  if new.is_active <> old.is_active and not (r = 'sales' and old.role = 'customer') then
    raise exception 'Not allowed to change account status.';
  end if;
  if r <> 'sales' and old.user_id <> auth.uid() then
    raise exception 'Not allowed.';
  end if;
  return new;
end $$;
create trigger user_profiles_guard before update on public.user_profiles for each row execute function app.user_profiles_guard();

-- ------------------------------------------------------------------ customers
create or replace function app.customers_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.uid() is null or app.has_role('admin','sales') then return new; end if;
  if new.customer_no <> old.customer_no then
    raise exception 'The customer number can only be changed by Fornax.';
  end if;
  return new;
end $$;
create trigger customers_guard before update on public.customers for each row execute function app.customers_guard();
create or replace function app.set_created_by() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  return new;
end $$;
create trigger customers_created_by before insert on public.customers for each row execute function app.set_created_by();

-- ------------------------------------------------------------------ collection sites
create or replace function app.collection_sites_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then new.created_by := coalesce(auth.uid(), new.created_by); end if;
  if auth.uid() is not null and app.my_role() = 'customer' then
    new.customer_id := app.my_customer_id();
  end if;
  return new;
end $$;
create trigger collection_sites_guard before insert or update on public.collection_sites for each row execute function app.collection_sites_guard();

-- ------------------------------------------------------------------ waste profiles
-- Fill values that come from the customer's choices (service no., equipment, ADR) so they are always consistent.
create or replace function app.waste_profiles_derive() returns trigger
language plpgsql set search_path = '' as $$
declare
  s record; e record; a record;
  subs text[];
begin
  select service_no, description into s from public.ref_services
   where service_type = 'Waste' and waste_type = new.waste_type and unit_of_measure = new.unit_of_measure;
  new.service_no := s.service_no;
  new.service_description := s.description;

  if new.equipment_no is null then
    new.equipment_group := null; new.equipment_description := null;
  else
    select equipment_group, description into e from public.ref_equipment where equipment_no = new.equipment_no;
    new.equipment_group := e.equipment_group; new.equipment_description := e.description;
  end if;

  if new.adr_code is null then
    new.proper_shipping_name := null; new.adr_class_summary := null;
    new.adr_class_1 := null; new.adr_class_2 := null; new.adr_class_3 := null; new.adr_class_4 := null;
  else
    select un_no, proper_shipping_name, class_summary into a from public.ref_adr where adr_code = new.adr_code;
    if new.un_no is not null and new.un_no <> a.un_no then
      raise exception 'ADR code % does not belong to UN number %.', new.adr_code, new.un_no;
    end if;
    new.un_no := a.un_no;
    new.proper_shipping_name := btrim(a.proper_shipping_name);
    new.adr_class_summary := nullif(btrim(a.class_summary), '');
    -- format "primary (sub1,sub2,sub3)"
    new.adr_class_1 := nullif(btrim(split_part(coalesce(a.class_summary, ''), '(', 1)), '');
    subs := string_to_array(nullif(btrim(substring(coalesce(a.class_summary, '') from '\(([^)]*)\)')), ''), ',');
    new.adr_class_2 := btrim(subs[1]); new.adr_class_3 := btrim(subs[2]); new.adr_class_4 := btrim(subs[3]);
  end if;

  if new.collection_site_id is not null and not exists (
       select 1 from public.collection_sites cs where cs.id = new.collection_site_id and cs.customer_id = new.customer_id) then
    raise exception 'The collection site does not belong to this customer.';
  end if;
  return new;
end $$;
create trigger waste_profiles_derive before insert or update on public.waste_profiles
  for each row execute function app.waste_profiles_derive();

create or replace function app.waste_profiles_before_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  if auth.uid() is null then return new; end if;
  if app.my_role() = 'customer' then
    new.customer_id := app.my_customer_id();
  elsif not app.has_role('admin','sales') then
    raise exception 'Not allowed to create waste profiles.';
  end if;
  if new.status not in ('started','draft') then
    raise exception 'A new waste profile must start as Started or Draft.';
  end if;
  new.submitted_at := null; new.submitted_by := null; new.approved_at := null; new.approved_by := null;
  new.deleted_at := null; new.deleted_by := null; new.declaration_confirmed := false;
  return new;
end $$;
create trigger waste_profiles_before_insert before insert on public.waste_profiles
  for each row execute function app.waste_profiles_before_insert();

-- Status workflow and edit locks
--   Started/Draft: customer, sales, chemist and admin can edit. Customer or sales submit -> Pending approval.
--   Pending approval: locked; chemist/admin approve (-> Accepted) or reject (-> Draft).
--   Accepted: locked; chemist/admin can reset to Started.
--   Archive: customer/staff any time. Delete = mark for deletion (any time); only admin can undo or hard delete.
create or replace function app.waste_profiles_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  r public.user_role := app.my_role();
  wf text[] := array['status','archived_at','deleted_at','deleted_by','submitted_at','submitted_by',
                     'approved_at','approved_by','declaration_confirmed','updated_at','updated_by'];
  data_changed boolean;
begin
  if auth.uid() is null or r = 'admin' then return new; end if;

  if new.id <> old.id or new.reference <> old.reference or new.customer_id <> old.customer_id
     or new.created_at <> old.created_at or new.created_by is distinct from old.created_by then
    raise exception 'These fields cannot be changed.';
  end if;

  if old.deleted_at is not null then raise exception 'This waste profile has been deleted.'; end if;
  if new.deleted_at is not null then new.deleted_by := auth.uid(); end if;

  data_changed := (to_jsonb(new) - wf) <> (to_jsonb(old) - wf);

  if data_changed then
    if r in ('customer','sales') and old.status not in ('started','draft') then
      raise exception 'This waste profile is locked (status: %).', old.status;
    end if;
    if r = 'chemist' and old.status = 'accepted' then
      raise exception 'This waste profile is approved and locked. Reset it to Started to edit.';
    end if;
  end if;

  if new.status <> old.status then
    if old.status in ('started','draft') and new.status in ('started','draft') then
      null;  -- save as draft / clear form
    elsif old.status in ('started','draft') and new.status = 'pending_approval' then
      if r not in ('customer','sales','chemist') then raise exception 'Not allowed to submit.'; end if;
      if not new.declaration_confirmed then
        raise exception 'Please confirm the waste is as described before submitting.';
      end if;
      new.submitted_at := now(); new.submitted_by := auth.uid();
    elsif old.status = 'pending_approval' and new.status = 'accepted' then
      if r <> 'chemist' then raise exception 'Only the chemist can approve a waste profile.'; end if;
      new.approved_at := now(); new.approved_by := auth.uid();
    elsif old.status = 'pending_approval' and new.status = 'draft' then
      if r <> 'chemist' then raise exception 'Only the chemist can reject a waste profile.'; end if;
      new.declaration_confirmed := false;
    elsif old.status = 'accepted' and new.status = 'started' then
      if r <> 'chemist' then raise exception 'Only the chemist can reset an approved waste profile.'; end if;
      new.approved_at := null; new.approved_by := null; new.declaration_confirmed := false;
    else
      raise exception 'Status change from % to % is not allowed.', old.status, new.status;
    end if;
  else
    -- no status change: workflow stamps cannot be edited directly
    new.submitted_at := old.submitted_at; new.submitted_by := old.submitted_by;
    new.approved_at := old.approved_at; new.approved_by := old.approved_by;
    if new.declaration_confirmed and not old.declaration_confirmed then new.declaration_confirmed := false; end if;
  end if;
  return new;
end $$;
create trigger waste_profiles_guard before update on public.waste_profiles
  for each row execute function app.waste_profiles_guard();

-- staff-only companion row
create or replace function app.waste_profiles_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.waste_profile_internal (waste_profile_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger waste_profiles_after_insert after insert on public.waste_profiles
  for each row execute function app.waste_profiles_after_insert();

create or replace function app.waste_profile_internal_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.uid() is null or app.has_role('admin','sales') then return new; end if;
  if new.unit_price is distinct from old.unit_price then
    raise exception 'Only Sales can set the price.';
  end if;
  return new;
end $$;
create trigger waste_profile_internal_guard before update on public.waste_profile_internal
  for each row execute function app.waste_profile_internal_guard();

-- ------------------------------------------------------------------ quotes
create or replace function app.quotes_guard() returns trigger
language plpgsql set search_path = '' as $$
declare r public.user_role := app.my_role();
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    if auth.uid() is not null then
      new.status := 'draft'; new.sent_at := null; new.accepted_at := null; new.withdrawn_at := null;
    end if;
    return new;
  end if;
  if auth.uid() is null or r = 'admin' then return new; end if;
  if r = 'customer' then
    if old.status = 'sent' and new.status = 'accepted'
       and (to_jsonb(new) - array['status','accepted_at','accepted_by','updated_at','updated_by'])
         = (to_jsonb(old) - array['status','accepted_at','accepted_by','updated_at','updated_by']) then
      new.accepted_at := now(); new.accepted_by := auth.uid();
      return new;
    end if;
    raise exception 'Customers can only accept a quote.';
  end if;
  -- sales
  if new.customer_id <> old.customer_id then raise exception 'The customer cannot be changed on a quote.'; end if;
  if new.status <> old.status then
    if old.status = 'draft' and new.status = 'sent' then
      new.sent_at := now(); new.sent_by := auth.uid();
    elsif new.status = 'withdrawn' then
      new.withdrawn_at := now(); new.withdrawn_by := auth.uid();
    elsif old.status = 'withdrawn' and new.status = 'draft' then
      new.sent_at := null; new.accepted_at := null; new.accepted_by := null; new.withdrawn_at := null; new.withdrawn_by := null;
    else
      raise exception 'Quote status change from % to % is not allowed.', old.status, new.status;
    end if;
  end if;
  return new;
end $$;
create trigger quotes_guard before insert or update on public.quotes for each row execute function app.quotes_guard();

create or replace function app.quote_lines_guard() returns trigger
language plpgsql set search_path = '' as $$
declare q record; wp record;
begin
  select status, customer_id into q from public.quotes
   where id = case when tg_op = 'DELETE' then old.quote_id else new.quote_id end;
  if auth.uid() is not null and not app.has_role('admin') and q.status <> 'draft' then
    raise exception 'Lines can only be changed while the quote is a draft.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_table_name = 'quote_items' then
    select customer_id, status into wp from public.waste_profiles where id = new.waste_profile_id;
    if wp.customer_id <> q.customer_id then raise exception 'Waste profile belongs to a different customer.'; end if;
    if wp.status <> 'accepted' then raise exception 'Only accepted waste profiles can be added to a quote.'; end if;
    if (select count(*) from public.quote_items where quote_id = new.quote_id) >= 200 then
      raise exception 'A quote can hold at most 200 waste profiles.';
    end if;
  else
    new.created_by := coalesce(auth.uid(), new.created_by);
    if not exists (select 1 from public.ref_services where service_no = new.service_no and service_type = 'G/L') then
      raise exception 'Only additional charges (G/L services) can be added here.';
    end if;
  end if;
  return new;
end $$;
create trigger quote_items_guard before insert or update or delete on public.quote_items for each row execute function app.quote_lines_guard();
create trigger quote_charges_guard before insert or update or delete on public.quote_charges for each row execute function app.quote_lines_guard();

-- Prices a customer may see: only for waste profiles on their sent or accepted quotes.
create or replace function public.my_quote_prices()
returns table (quote_id uuid, waste_profile_id uuid, unit_price numeric)
language sql stable security definer set search_path = '' as $$
  select qi.quote_id, qi.waste_profile_id, wi.unit_price
  from public.quote_items qi
  join public.quotes q on q.id = qi.quote_id
  join public.waste_profile_internal wi on wi.waste_profile_id = qi.waste_profile_id
  where q.status in ('sent','accepted')
    and (q.customer_id = app.my_customer_id() or app.has_role('admin','sales','chemist'))
$$;
revoke all on function public.my_quote_prices() from public, anon;
grant execute on function public.my_quote_prices() to authenticated;

-- ------------------------------------------------------------------ messages
create or replace function app.messages_guard() returns trigger
language plpgsql set search_path = '' as $$
declare root record;
begin
  if auth.uid() is null then return new; end if;
  new.sender_id := auth.uid();
  new.created_at := now();
  if tg_table_name = 'general_messages' then
    if app.my_role() = 'customer' then new.customer_id := app.my_customer_id(); end if;
    if new.thread_id is not null then
      select customer_id into root from public.general_messages where id = new.thread_id and thread_id is null;
      if root.customer_id is distinct from new.customer_id then raise exception 'Invalid conversation.'; end if;
      new.topic := null;
    end if;
  end if;
  return new;
end $$;
create trigger wpm_guard before insert on public.waste_profile_messages for each row execute function app.messages_guard();
create trigger gm_guard before insert on public.general_messages for each row execute function app.messages_guard();

-- ------------------------------------------------------------------ 90-day purge of profiles marked for deletion
create or replace function app.purge_deleted_waste_profiles() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.quote_items where waste_profile_id in
    (select id from public.waste_profiles where deleted_at < now() - interval '90 days');
  delete from public.waste_profiles where deleted_at < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function app.purge_deleted_waste_profiles() from public, anon, authenticated;

-- ------------------------------------------------------------------ row level security policies
-- reference lists: read-only for logged-in users
create policy ref_list_read on public.ref_list_values for select to authenticated using (true);
create policy ref_ewc_read on public.ref_ewc for select to authenticated using (true);
create policy ref_adr_read on public.ref_adr for select to authenticated using (true);
create policy ref_equipment_read on public.ref_equipment for select to authenticated using (true);
create policy ref_services_read on public.ref_services for select to authenticated using (true);

-- user profiles
create policy up_select on public.user_profiles for select to authenticated using (
  user_id = (select auth.uid())
  or (select app.has_role('admin','sales','chemist','ops'))
  or (customer_id is not null and customer_id = (select app.my_customer_id())));
create policy up_update on public.user_profiles for update to authenticated using (
  user_id = (select auth.uid()) or (select app.has_role('admin'))
  or ((select app.has_role('sales')) and role = 'customer'));
create policy up_insert on public.user_profiles for insert to authenticated with check ((select app.has_role('admin')));
create policy up_delete on public.user_profiles for delete to authenticated using ((select app.has_role('admin')));

-- customers
create policy cust_select on public.customers for select to authenticated using (
  (select app.has_role('admin','sales','chemist','ops')) or id = (select app.my_customer_id()));
create policy cust_insert on public.customers for insert to authenticated with check ((select app.has_role('admin','sales')));
create policy cust_update on public.customers for update to authenticated using (
  (select app.has_role('admin','sales')) or id = (select app.my_customer_id()));
create policy cust_delete on public.customers for delete to authenticated using ((select app.has_role('admin')));

-- collection sites
create policy cs_select on public.collection_sites for select to authenticated using (
  (select app.has_role('admin','sales','chemist','ops')) or customer_id = (select app.my_customer_id()));
create policy cs_insert on public.collection_sites for insert to authenticated with check (
  (select app.has_role('admin','sales')) or customer_id = (select app.my_customer_id()));
create policy cs_update on public.collection_sites for update to authenticated using (
  (select app.has_role('admin','sales')) or customer_id = (select app.my_customer_id()));
create policy cs_delete on public.collection_sites for delete to authenticated using (
  (select app.has_role('admin','sales')) or customer_id = (select app.my_customer_id()));

-- waste profiles (Ops has no access)
create policy wp_select on public.waste_profiles for select to authenticated using (
  (select app.has_role('admin'))
  or ((select app.has_role('sales','chemist')) and deleted_at is null)
  or (customer_id = (select app.my_customer_id()) and deleted_at is null));
create policy wp_insert on public.waste_profiles for insert to authenticated with check (
  (select app.has_role('admin','sales')) or customer_id = (select app.my_customer_id()));
create policy wp_update on public.waste_profiles for update to authenticated
  using ((select app.has_role('admin'))
         or ((select app.has_role('sales','chemist')) and deleted_at is null)
         or (customer_id = (select app.my_customer_id()) and deleted_at is null))
  with check ((select app.has_role('admin','sales','chemist')) or customer_id = (select app.my_customer_id()));
create policy wp_delete on public.waste_profiles for delete to authenticated using ((select app.has_role('admin')));

-- staff-only fields
create policy wpi_select on public.waste_profile_internal for select to authenticated using ((select app.has_role('admin','sales','chemist')));
create policy wpi_update on public.waste_profile_internal for update to authenticated using ((select app.has_role('admin','sales','chemist')));

-- quotes: customers see their own once sent; Chemist can read
create policy q_select on public.quotes for select to authenticated using (
  (select app.has_role('admin','sales','chemist'))
  or (customer_id = (select app.my_customer_id()) and status in ('sent','accepted')));
create policy q_insert on public.quotes for insert to authenticated with check ((select app.has_role('admin','sales')));
create policy q_update on public.quotes for update to authenticated using (
  (select app.has_role('admin','sales'))
  or (customer_id = (select app.my_customer_id()) and status = 'sent'));
create policy q_delete on public.quotes for delete to authenticated using (
  (select app.has_role('admin')) or ((select app.has_role('sales')) and status = 'draft'));

create policy qi_select on public.quote_items for select to authenticated using (
  exists (select 1 from public.quotes q where q.id = quote_id));
create policy qi_write on public.quote_items for all to authenticated
  using ((select app.has_role('admin','sales'))) with check ((select app.has_role('admin','sales')));
create policy qc_select on public.quote_charges for select to authenticated using (
  exists (select 1 from public.quotes q where q.id = quote_id));
create policy qc_write on public.quote_charges for all to authenticated
  using ((select app.has_role('admin','sales'))) with check ((select app.has_role('admin','sales')));

-- MAQ messages: the customer of that profile, Sales, Chemist and Admin
create policy wpm_select on public.waste_profile_messages for select to authenticated using (
  (select app.has_role('admin','sales','chemist'))
  or exists (select 1 from public.waste_profiles w where w.id = waste_profile_id and w.customer_id = (select app.my_customer_id())));
create policy wpm_insert on public.waste_profile_messages for insert to authenticated with check (
  (select app.has_role('admin','sales','chemist'))
  or exists (select 1 from public.waste_profiles w where w.id = waste_profile_id and w.customer_id = (select app.my_customer_id()) and w.deleted_at is null));
create policy wpm_delete on public.waste_profile_messages for delete to authenticated using ((select app.has_role('admin')));

-- general messages
create policy gm_select on public.general_messages for select to authenticated using (
  (select app.has_role('admin','sales','chemist')) or customer_id = (select app.my_customer_id()));
create policy gm_insert on public.general_messages for insert to authenticated with check (
  (select app.has_role('admin','sales','chemist')) or customer_id = (select app.my_customer_id()));
create policy gm_delete on public.general_messages for delete to authenticated using ((select app.has_role('admin')));
