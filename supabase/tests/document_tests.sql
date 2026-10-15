-- Document remove / confirm / move tests (15 Oct 2026). Everything is rolled back: the block ends by
-- raising an exception whose message is the test report.
do $$
declare
  c1 uuid := gen_random_uuid(); c2 uuid := gen_random_uuid();
  u_c1 uuid := gen_random_uuid(); u_c2 uuid := gen_random_uuid(); u_sales uuid := gen_random_uuid();
  wp uuid; wp2 uuid; d1 uuid; d2 uuid; dnew uuid; n int; t text; rep text[] := '{}';
begin
  insert into auth.users (id, instance_id, aud, role, email) values
    (u_c1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t-c1@example.test'),
    (u_c2,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t-c2@example.test'),
    (u_sales,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t-sales@example.test');
  insert into public.customers (id, customer_no, company_name) values (c1,'TEST-C1','Test Co 1'), (c2,'TEST-C2','Test Co 2');
  insert into public.user_profiles (user_id,email,role,customer_id) values
    (u_c1,'t-c1@example.test','customer',c1), (u_c2,'t-c2@example.test','customer',c2), (u_sales,'t-sales@example.test','sales',null);
  insert into public.waste_profiles (customer_id, unit_of_measure, waste_description) values (c1,'KG','Doc test') returning id into wp;
  insert into public.waste_profiles (customer_id, unit_of_measure, waste_description) values (c1,'KG','Doc test 2') returning id into wp2;
  insert into public.waste_profile_documents (waste_profile_id, storage_path, file_name, uploaded_by)
    values (wp, wp || '/a.pdf', 'a.pdf', u_c1) returning id into d1;
  insert into public.waste_profile_documents (waste_profile_id, storage_path, file_name, uploaded_by)
    values (wp, wp || '/b.pdf', 'b.pdf', u_c1) returning id into d2;
  insert into storage.objects (bucket_id, name) values ('maq-documents', wp2 || '/b.pdf');

  -- other customer cannot remove
  perform set_config('request.jwt.claims', json_build_object('sub',u_c2,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin perform public.remove_waste_profile_document(d1, null);
        rep := array_append(rep, '01 other customer removes doc: ALLOWED (expect blocked)');
  exception when others then rep := array_append(rep, '01 other customer removes doc: blocked (ok)'); end;
  execute 'reset role';

  -- own customer removes: row kept, flagged
  perform set_config('request.jwt.claims', json_build_object('sub',u_c1,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.remove_waste_profile_document(d1, 'Removed by user');
  select format('kept=%s removed=%s by_me=%s', count(*), bool_and(removed_at is not null), bool_and(removed_by = u_c1))
    into t from public.waste_profile_documents where id = d1;
  rep := array_append(rep, '02 customer removes own doc: ' || t || ' (expect kept=1 removed=t by_me=t)');
  begin delete from public.waste_profile_documents where id = d1;
        get diagnostics n = row_count;
        rep := array_append(rep, format('03 customer hard-deletes doc rows: %s (expect 0)', n));
  exception when others then rep := array_append(rep, '03 customer hard-deletes doc rows: blocked (ok)'); end;
  perform public.confirm_waste_profile_document(d2);
  select confirmed_same_waste::text into t from public.waste_profile_documents where id = d2;
  rep := array_append(rep, '04 customer confirms doc: ' || t || ' (expect true)');
  dnew := public.move_waste_profile_document(d2, wp2, wp2 || '/b.pdf');
  select format('new_on_target=%s old_removed=%s reason_ok=%s',
    (select waste_profile_id = wp2 from public.waste_profile_documents where id = dnew),
    (select removed_at is not null from public.waste_profile_documents where id = d2),
    (select removed_reason like 'Moved to new waste profile%' from public.waste_profile_documents where id = d2)) into t;
  rep := array_append(rep, '05 move doc to new profile: ' || t || ' (expect t t t)');
  execute 'reset role';

  -- locked profile: customer cannot remove after submit
  update public.waste_profiles set status = 'pending_approval', declaration_confirmed = true where id = wp2;
  execute 'set local role authenticated';
  begin perform public.remove_waste_profile_document(dnew, null);
        rep := array_append(rep, '06 customer removes doc while pending: ALLOWED (expect blocked)');
  exception when others then rep := array_append(rep, '06 customer removes doc while pending: blocked (ok)'); end;
  execute 'reset role';

  raise exception 'TEST REPORT%', E'\n' || array_to_string(rep, E'\n');
end $$;
