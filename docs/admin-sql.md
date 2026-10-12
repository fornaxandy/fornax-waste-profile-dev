# Admin SQL (super user only)

Run these in **Supabase → SQL Editor**. Only the super user (Andy) does this; there is no role screen in the portal.

## 1. Give a Fornax staff member access

One snippet creates the login (no password; they log in with the 6-digit email code) and gives the role.
Change the three values on the `values` line, then run. Running it again for an existing email does nothing.

```sql
with staff(email, full_name, role) as (values
  ('first.last@fornax.co.uk', 'First Last', 'sales')     -- role: 'admin', 'sales', 'chemist' or 'ops'
),
new_users as (
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current,
    phone_change, phone_change_token, reauthentication_token, is_sso_user, is_anonymous, created_at, updated_at)
  select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', lower(s.email), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{"email_verified":true}'::jsonb,
    '', '', '', '', '', '', '', '', false, false, now(), now()
  from staff s where not exists (select 1 from auth.users u where u.email = lower(s.email))
  returning id, email),
new_identities as (
  insert into auth.identities (provider, provider_id, user_id, identity_data, created_at, updated_at)
  select 'email', n.id::text, n.id,
    jsonb_build_object('sub', n.id::text, 'email', n.email, 'email_verified', false, 'phone_verified', false), now(), now()
  from new_users n returning user_id)
insert into public.user_profiles (user_id, email, full_name, role)
select n.id, n.email, s.full_name, s.role::public.user_role from new_users n join staff s on lower(s.email) = n.email;
```

If the person already has a login (for example created in the Supabase dashboard), give them a role with:

```sql
insert into public.user_profiles (user_id, email, full_name, role)
select id, email, 'Full Name', 'sales'          -- role: 'admin', 'sales', 'chemist' or 'ops'
from auth.users where email = 'first.last@fornax.co.uk'
on conflict (user_id) do update set role = excluded.role, full_name = excluded.full_name, is_active = true;
```

Customers will be added from the portal by Sales, not with SQL.

The list of staff and their roles is kept in the project plan (not in this public repository).

## 2. Change someone's role

```sql
update public.user_profiles set role = 'chemist' where email = 'first.last@fornax.co.uk';
```

## 3. Remove someone's access (keeps their history)

```sql
update public.user_profiles set is_active = false where email = 'first.last@fornax.co.uk';
```

To restore: run the same with `is_active = true`.

## 4. Check who has which role

```sql
select email, full_name, role, is_active from public.user_profiles where role <> 'customer' order by role, email;
```

## 5. Recover a waste profile a customer deleted (within 90 days)

```sql
update public.waste_profiles set deleted_at = null, deleted_by = null where reference = 'MAQ-000123';
```
