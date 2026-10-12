-- Migration 5: functions the portal calls, document storage, 90-day purge schedule.

-- ------------------------------------------------------------------ logins without passwords
-- Creates an email-code-only login (same shape as logins created by Supabase) and its portal profile.
create or replace function app.create_login(p_email text, p_full_name text, p_role public.user_role, p_customer_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(p_email)); v_id uuid;
begin
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'Please enter a valid email address.'; end if;
  select id into v_id from auth.users where email = v_email;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current,
      phone_change, phone_change_token, reauthentication_token, is_sso_user, is_anonymous, created_at, updated_at)
    values (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_email, now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{"email_verified":true}'::jsonb,
      '', '', '', '', '', '', '', '', false, false, now(), now());
    insert into auth.identities (provider, provider_id, user_id, identity_data, created_at, updated_at)
    values ('email', v_id::text, v_id,
      jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', false, 'phone_verified', false), now(), now());
  elsif exists (select 1 from public.user_profiles where user_id = v_id) then
    raise exception 'This email address is already registered.';
  end if;
  insert into public.user_profiles (user_id, email, full_name, role, customer_id)
  values (v_id, v_email, nullif(btrim(p_full_name), ''), p_role, p_customer_id);
  return v_id;
end $$;
revoke all on function app.create_login(text, text, public.user_role, uuid) from public, anon, authenticated;

-- Sales/Admin: add a customer company with its first login.
create or replace function public.staff_create_customer(p_customer_no text, p_company_name text, p_contact_name text,
  p_email text, p_phone text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_cust uuid;
begin
  if not app.has_role('admin','sales') then raise exception 'Not allowed.'; end if;
  if coalesce(btrim(p_customer_no), '') = '' or coalesce(btrim(p_company_name), '') = '' then
    raise exception 'Customer number and company name are required.';
  end if;
  if exists (select 1 from public.customers where customer_no = btrim(p_customer_no)) then
    raise exception 'Customer number % already exists.', btrim(p_customer_no);
  end if;
  insert into public.customers (customer_no, company_name, phone, created_by)
  values (btrim(p_customer_no), btrim(p_company_name), nullif(btrim(p_phone), ''), auth.uid()) returning id into v_cust;
  perform app.create_login(p_email, p_contact_name, 'customer', v_cust);
  update public.user_profiles set phone = nullif(btrim(p_phone), '') where email = lower(btrim(p_email));
  return v_cust;
end $$;

-- Sales/Admin: add another login for an existing customer company.
create or replace function public.staff_add_customer_user(p_customer_id uuid, p_full_name text, p_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if not app.has_role('admin','sales') then raise exception 'Not allowed.'; end if;
  if not exists (select 1 from public.customers where id = p_customer_id) then raise exception 'Customer not found.'; end if;
  return app.create_login(p_email, p_full_name, 'customer', p_customer_id);
end $$;

-- Sales/Admin: change a customer user's login email (customers cannot change it themselves).
create or replace function public.staff_change_customer_email(p_user_id uuid, p_new_email text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(p_new_email));
begin
  if not app.has_role('admin','sales') then raise exception 'Not allowed.'; end if;
  if not exists (select 1 from public.user_profiles where user_id = p_user_id and role = 'customer') then
    raise exception 'Customer user not found.';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'Please enter a valid email address.'; end if;
  if exists (select 1 from auth.users where email = v_email and id <> p_user_id) then
    raise exception 'This email address is already registered.';
  end if;
  update auth.users set email = v_email, updated_at = now() where id = p_user_id;
  update auth.identities set identity_data = identity_data || jsonb_build_object('email', v_email), updated_at = now()
   where user_id = p_user_id and provider = 'email';
  update public.user_profiles set email = v_email where user_id = p_user_id;
end $$;

revoke all on function public.staff_create_customer(text, text, text, text, text) from public, anon;
revoke all on function public.staff_add_customer_user(uuid, text, text) from public, anon;
revoke all on function public.staff_change_customer_email(uuid, text) from public, anon;
grant execute on function public.staff_create_customer(text, text, text, text, text) to authenticated;
grant execute on function public.staff_add_customer_user(uuid, text, text) to authenticated;
grant execute on function public.staff_change_customer_email(uuid, text) to authenticated;

-- Admin: recover a deleted waste profile.
create or replace function public.recover_waste_profile(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app.has_role('admin') then raise exception 'Not allowed.'; end if;
  update public.waste_profiles set deleted_at = null, deleted_by = null where id = p_id;
end $$;
revoke all on function public.recover_waste_profile(uuid) from public, anon;
grant execute on function public.recover_waste_profile(uuid) to authenticated;

-- ------------------------------------------------------------------ uploaded documents (for AI reading)
create table public.waste_profile_documents (
  id uuid primary key default gen_random_uuid(),
  waste_profile_id uuid not null references public.waste_profiles(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  mime_type text,
  size_bytes integer,
  uploaded_by uuid references auth.users(id),
  ai_status text not null default 'not_read' check (ai_status in ('not_read','reading','done','failed')),
  ai_result jsonb,
  ai_error text,
  ai_input_tokens integer,
  ai_output_tokens integer,
  created_at timestamptz not null default now()
);
create index wpd_profile_idx on public.waste_profile_documents (waste_profile_id);
alter table public.waste_profile_documents enable row level security;
comment on table public.waste_profile_documents is 'Files a customer uploads to a waste profile; read by Claude (billed to Fornax) to pre-fill fields.';

create policy wpd_select on public.waste_profile_documents for select to authenticated using (
  (select app.has_role('admin','sales','chemist'))
  or exists (select 1 from public.waste_profiles w where w.id = waste_profile_id and w.customer_id = (select app.my_customer_id())));
create policy wpd_insert on public.waste_profile_documents for insert to authenticated with check (
  uploaded_by = (select auth.uid()) and (
    (select app.has_role('admin','sales','chemist'))
    or exists (select 1 from public.waste_profiles w where w.id = waste_profile_id
               and w.customer_id = (select app.my_customer_id()) and w.status in ('started','draft'))));
create policy wpd_delete on public.waste_profile_documents for delete to authenticated using ((select app.has_role('admin')));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('maq-documents', 'maq-documents', false, 20971520,
        array['application/pdf','image/png','image/jpeg','image/webp','image/gif','text/plain','text/csv'])
on conflict (id) do nothing;

-- Files live under <waste_profile_id>/<file>. Access follows the waste profile.
create policy maq_docs_read on storage.objects for select to authenticated using (
  bucket_id = 'maq-documents' and exists (
    select 1 from public.waste_profiles w where w.id::text = (storage.foldername(name))[1]
      and ((select app.has_role('admin','sales','chemist')) or w.customer_id = (select app.my_customer_id()))));
create policy maq_docs_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'maq-documents' and exists (
    select 1 from public.waste_profiles w where w.id::text = (storage.foldername(name))[1]
      and ((select app.has_role('admin','sales','chemist'))
           or (w.customer_id = (select app.my_customer_id()) and w.status in ('started','draft')))));
create policy maq_docs_delete on storage.objects for delete to authenticated using (
  bucket_id = 'maq-documents' and (select app.has_role('admin')));

-- ------------------------------------------------------------------ 90-day purge, every night at 02:15 UTC
create extension if not exists pg_cron;
select cron.schedule('purge-deleted-waste-profiles', '15 2 * * *', $$select app.purge_deleted_waste_profiles()$$);
