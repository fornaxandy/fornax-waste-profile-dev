-- Migration 4: "Delete" a waste profile = mark it for deletion (kept 90 days, admin can recover).
-- Done through a function because the row becomes hidden from the person deleting it,
-- which a plain update under row level security does not allow.
create or replace function public.delete_waste_profile(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare cust uuid;
begin
  select customer_id into cust from public.waste_profiles where id = p_id and deleted_at is null;
  if cust is null then raise exception 'Waste profile not found.'; end if;
  if not (app.has_role('admin','sales','chemist') or cust = app.my_customer_id()) then
    raise exception 'Not allowed.';
  end if;
  update public.waste_profiles set deleted_at = now(), deleted_by = auth.uid() where id = p_id;
end $$;
revoke all on function public.delete_waste_profile(uuid) from public, anon;
grant execute on function public.delete_waste_profile(uuid) to authenticated;
