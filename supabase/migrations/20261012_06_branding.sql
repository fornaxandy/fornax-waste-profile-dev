-- Branding shown only after login. The logo lives in the database (not in public/),
-- so the public site and the login page stay unbranded.
create table if not exists public.app_branding (
  key text primary key,
  mime_type text not null,
  data_base64 text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_branding enable row level security;
drop policy if exists branding_read on public.app_branding;
create policy branding_read on public.app_branding for select to authenticated
  using (app.my_role() is not null);
grant select on public.app_branding to authenticated;
revoke all on public.app_branding from anon;
