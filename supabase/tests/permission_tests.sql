-- Permission and workflow tests. Everything is rolled back: the block ends by raising an
-- exception whose message is the test report, so no test data is ever kept.
do $$
declare
  c1 uuid := gen_random_uuid(); c2 uuid := gen_random_uuid();
  u_c1 uuid := gen_random_uuid(); u_c2 uuid := gen_random_uuid(); u_sales uuid := gen_random_uuid();
  u_chem uuid := gen_random_uuid(); u_ops uuid := gen_random_uuid();
  site uuid; wp uuid; q uuid; n int; t text; rep text[] := '{}';
begin
  -- ---------- setup (as database owner)
  insert into auth.users (id, instance_id, aud, role, email) values
    (u_c1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t-c1@example.test'),
    (u_c2,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t-c2@example.test'),
    (u_sales,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t-sales@example.test'),
    (u_chem,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t-chem@example.test'),
    (u_ops,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t-ops@example.test');
  insert into public.customers (id, customer_no, company_name) values (c1,'TEST-C1','Test Co 1'), (c2,'TEST-C2','Test Co 2');
  insert into public.user_profiles (user_id,email,role,customer_id) values
    (u_c1,'t-c1@example.test','customer',c1), (u_c2,'t-c2@example.test','customer',c2),
    (u_sales,'t-sales@example.test','sales',null), (u_chem,'t-chem@example.test','chemist',null),
    (u_ops,'t-ops@example.test','ops',null);

  -- ---------- 1. logged-out visitor sees nothing
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select (select count(*) from public.customers) + (select count(*) from public.ref_ewc) + (select count(*) from public.user_profiles) into n;
  rep := array_append(rep, (format('01 logged-out visitor rows visible: %s (expect 0)', n))::text);
  execute 'reset role';

  -- ---------- 2. customer 1 creates a profile; auto-fill works
  perform set_config('request.jwt.claims', json_build_object('sub',u_c1,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  insert into public.collection_sites (customer_id, site_name, postcode) values (c2, 'Main site', 'AB1 2CD') returning id into site;
  select customer_id::text into t from public.collection_sites where id = site;
  rep := array_append(rep, (format('02 site forced to own company: %s', (t = c1::text)))::text);
  insert into public.waste_profiles (customer_id, unit_of_measure, collection_site_id, equipment_no, adr_code, waste_description)
    values (c2, 'KG', site, 'EQ0001', '0015-XB', 'Test waste') returning id into wp;
  select format('service=%s equip=%s|%s un=%s class1=%s class2=%s status=%s cust_ok=%s',
    service_no, equipment_group, equipment_description, un_no, adr_class_1, adr_class_2, status, customer_id = c1)
    into t from public.waste_profiles where id = wp;
  rep := array_append(rep, (('03 auto-fill: ' || t || ' (expect INCHAZKG, BOTTLE, 0015, 1.2G, 8, started, true)'))::text);
  select count(*) into n from public.waste_profile_internal where waste_profile_id = wp;
  rep := array_append(rep, (format('04 customer sees staff-only row: %s (expect 0)', n))::text);
  begin update public.waste_profiles set status = 'pending_approval' where id = wp;
        rep := array_append(rep, ('05 submit without declaration: ALLOWED (expect blocked)')::text);
  exception when others then rep := array_append(rep, ('05 submit without declaration: blocked (ok)')::text); end;
  update public.waste_profiles set status = 'draft', waste_description = 'Test waste v2' where id = wp;
  update public.waste_profiles set status = 'pending_approval', declaration_confirmed = true where id = wp;
  select status::text into t from public.waste_profiles where id = wp;
  rep := array_append(rep, (format('06 customer submit: %s (expect pending_approval)', t))::text);
  begin update public.waste_profiles set waste_description = 'changed' where id = wp;
        rep := array_append(rep, ('07 customer edit while pending: ALLOWED (expect blocked)')::text);
  exception when others then rep := array_append(rep, ('07 customer edit while pending: blocked (ok)')::text); end;
  begin update public.customers set customer_no = 'HACK' where id = c1;
        rep := array_append(rep, ('08 customer changes customer no.: ALLOWED (expect blocked)')::text);
  exception when others then rep := array_append(rep, ('08 customer changes customer no.: blocked (ok)')::text); end;
  begin update public.user_profiles set role = 'admin' where user_id = u_c1;
        rep := array_append(rep, ('09 customer makes self admin: ALLOWED (expect blocked)')::text);
  exception when others then rep := array_append(rep, ('09 customer makes self admin: blocked (ok)')::text); end;
  insert into public.waste_profile_messages (waste_profile_id, sender_id, body) values (wp, u_c2, 'Question about this MAQ');
  execute 'reset role';

  -- ---------- 3. customer 2 cannot see customer 1
  perform set_config('request.jwt.claims', json_build_object('sub',u_c2,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  select (select count(*) from public.waste_profiles) + (select count(*) from public.collection_sites)
       + (select count(*) from public.waste_profile_messages) + (select count(*) from public.customers where id = c1) into n;
  rep := array_append(rep, (format('10 other customer sees company 1 data: %s rows (expect 0)', n))::text);
  update public.waste_profiles set waste_description = 'hijack' where id = wp;
  get diagnostics n = row_count;
  rep := array_append(rep, (format('11 other customer edits company 1 profile: %s rows (expect 0)', n))::text);
  execute 'reset role';

  -- ---------- 4. ops sees no waste profiles or quotes
  perform set_config('request.jwt.claims', json_build_object('sub',u_ops,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  select (select count(*) from public.waste_profiles) + (select count(*) from public.quotes) into n;
  rep := array_append(rep, (format('12 ops sees waste profiles/quotes: %s (expect 0)', n))::text);
  execute 'reset role';

  -- ---------- 5. sales cannot approve; chemist can
  perform set_config('request.jwt.claims', json_build_object('sub',u_sales,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin update public.waste_profiles set status = 'accepted' where id = wp;
        rep := array_append(rep, ('13 sales approves MAQ: ALLOWED (expect blocked)')::text);
  exception when others then rep := array_append(rep, ('13 sales approves MAQ: blocked (ok)')::text); end;
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub',u_chem,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  update public.waste_profiles set status = 'accepted' where id = wp;
  select status::text || ' by chemist=' || (approved_by = u_chem) into t from public.waste_profiles where id = wp;
  rep := array_append(rep, (('14 chemist approves: ' || t || ' (expect accepted, true)'))::text);
  begin update public.waste_profile_internal set unit_price = 1 where waste_profile_id = wp;
        rep := array_append(rep, ('15 chemist sets price: ALLOWED (expect blocked)')::text);
  exception when others then rep := array_append(rep, ('15 chemist sets price: blocked (ok)')::text); end;
  execute 'reset role';

  -- ---------- 6. sales prices and quotes
  perform set_config('request.jwt.claims', json_build_object('sub',u_sales,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  update public.waste_profile_internal set unit_price = 0.45 where waste_profile_id = wp;
  insert into public.quotes (customer_id) values (c1) returning id into q;
  insert into public.quote_items (quote_id, waste_profile_id) values (q, wp);
  insert into public.quote_charges (quote_id, service_no, quantity, unit_price) values (q, 'ADMIN', 1, 25);
  begin insert into public.quote_charges (quote_id, service_no, quantity, unit_price) values (q, 'INCHAZKG', 1, 1);
        rep := array_append(rep, ('16 waste service added as charge: ALLOWED (expect blocked)')::text);
  exception when others then rep := array_append(rep, ('16 waste service added as charge: blocked (ok)')::text); end;
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub',u_c1,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.quotes;
  rep := array_append(rep, (format('17 customer sees draft quote: %s (expect 0)', n))::text);
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub',u_sales,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  update public.quotes set status = 'sent' where id = q;
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub',u_c1,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.quotes;
  select string_agg(unit_price::text, ',') into t from public.my_quote_prices();
  rep := array_append(rep, (format('18 customer sees sent quote: %s, price: %s (expect 1, 0.4500)', n, t))::text);
  begin update public.quotes set notes = 'cheaper please' where id = q;
        rep := array_append(rep, ('19 customer edits quote: ALLOWED (expect blocked)')::text);
  exception when others then rep := array_append(rep, ('19 customer edits quote: blocked (ok)')::text); end;
  update public.quotes set status = 'accepted' where id = q;
  select status::text into t from public.quotes where id = q;
  rep := array_append(rep, (format('20 customer accepts quote: %s (expect accepted)', t))::text);
  perform public.delete_waste_profile(wp);
  select count(*) into n from public.waste_profiles where id = wp;
  rep := array_append(rep, (format('21 customer deletes profile, still visible to customer: %s (expect 0)', n))::text);
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub',u_sales,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  update public.quotes set status = 'withdrawn' where id = q;
  select status::text into t from public.quotes where id = q;
  rep := array_append(rep, (format('22 sales withdraws accepted quote: %s (expect withdrawn)', t))::text);
  select count(*) into n from public.waste_profiles where id = wp;
  rep := array_append(rep, (format('23 deleted profile visible to sales: %s (expect 0)', n))::text);
  execute 'reset role';
  select count(*) into n from public.waste_profiles where id = wp and deleted_at is not null;
  rep := array_append(rep, (format('24 deleted profile still kept in database: %s (expect 1)', n))::text);

  raise exception E'TEST REPORT (all changes rolled back)\n%', array_to_string(rep, E'\n');
end $$;
