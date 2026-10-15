-- Migration 7 (15 Oct 2026): documents can be removed from a waste profile (kept for audit), and
-- documents the AI flags as a different waste stream can be confirmed, moved or discarded.

alter table public.waste_profile_documents
  add column removed_at timestamptz,
  add column removed_by uuid references auth.users(id),
  add column removed_reason text,
  add column confirmed_same_waste boolean not null default false,
  add column moved_from_document_id uuid references public.waste_profile_documents(id);

comment on column public.waste_profile_documents.removed_at is
  'Set when someone removes the document from the waste profile. The row and file are kept for audit; removed documents are never read by the AI.';
comment on column public.waste_profile_documents.confirmed_same_waste is
  'The user confirmed this document belongs to this waste profile after the AI flagged it as a different waste stream.';

-- Same rule as the portal screen: who may change this waste profile's data right now.
create or replace function app.can_edit_waste_profile(p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.waste_profiles w
     where w.id = p_id and w.deleted_at is null and (
       app.has_role('admin')
       or (app.has_role('chemist') and w.status in ('started','draft','pending_approval'))
       or (app.has_role('sales') and w.status in ('started','draft'))
       or (w.customer_id = app.my_customer_id() and w.status in ('started','draft'))));
$$;
revoke all on function app.can_edit_waste_profile(uuid) from public, anon;
grant execute on function app.can_edit_waste_profile(uuid) to authenticated;

-- Remove a document from its waste profile. Nothing is deleted: the row and the file stay for audit.
create or replace function public.remove_waste_profile_document(p_doc_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_wp uuid;
begin
  select waste_profile_id into v_wp from public.waste_profile_documents where id = p_doc_id and removed_at is null;
  if v_wp is null then raise exception 'Document not found.'; end if;
  if not app.can_edit_waste_profile(v_wp) then raise exception 'You cannot change the documents of this waste profile.'; end if;
  update public.waste_profile_documents
     set removed_at = now(), removed_by = auth.uid(), removed_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_doc_id;
end $$;

-- The user is sure a flagged document belongs to this waste profile.
create or replace function public.confirm_waste_profile_document(p_doc_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_wp uuid;
begin
  select waste_profile_id into v_wp from public.waste_profile_documents where id = p_doc_id and removed_at is null;
  if v_wp is null then raise exception 'Document not found.'; end if;
  if not app.can_edit_waste_profile(v_wp) then raise exception 'You cannot change the documents of this waste profile.'; end if;
  update public.waste_profile_documents set confirmed_same_waste = true where id = p_doc_id;
end $$;

-- Record a document (already copied in storage to the new profile's folder) on another waste profile of the
-- same customer, and remove it from the original profile with a reason that links the two.
create or replace function public.move_waste_profile_document(p_doc_id uuid, p_target_wp uuid, p_new_path text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare d public.waste_profile_documents; v_new uuid; v_ref text;
begin
  select * into d from public.waste_profile_documents where id = p_doc_id and removed_at is null;
  if d.id is null then raise exception 'Document not found.'; end if;
  if not app.can_edit_waste_profile(d.waste_profile_id) or not app.can_edit_waste_profile(p_target_wp) then
    raise exception 'You cannot change the documents of these waste profiles.';
  end if;
  if (select customer_id from public.waste_profiles where id = d.waste_profile_id)
     is distinct from (select customer_id from public.waste_profiles where id = p_target_wp) then
    raise exception 'Documents can only be moved between waste profiles of the same customer.';
  end if;
  if split_part(p_new_path, '/', 1) <> p_target_wp::text
     or not exists (select 1 from storage.objects where bucket_id = 'maq-documents' and name = p_new_path) then
    raise exception 'The copied file was not found.';
  end if;
  insert into public.waste_profile_documents (waste_profile_id, storage_path, file_name, mime_type, size_bytes, uploaded_by,
                                              confirmed_same_waste, moved_from_document_id)
  values (p_target_wp, p_new_path, d.file_name, d.mime_type, d.size_bytes, auth.uid(), true, d.id)
  returning id into v_new;
  select reference into v_ref from public.waste_profiles where id = p_target_wp;
  update public.waste_profile_documents
     set removed_at = now(), removed_by = auth.uid(), removed_reason = 'Moved to new waste profile ' || coalesce(v_ref, p_target_wp::text)
   where id = d.id;
  return v_new;
end $$;

revoke all on function public.remove_waste_profile_document(uuid, text) from public, anon;
revoke all on function public.confirm_waste_profile_document(uuid) from public, anon;
revoke all on function public.move_waste_profile_document(uuid, uuid, text) from public, anon;
grant execute on function public.remove_waste_profile_document(uuid, text) to authenticated;
grant execute on function public.confirm_waste_profile_document(uuid) to authenticated;
grant execute on function public.move_waste_profile_document(uuid, uuid, text) to authenticated;
