# Admin SQL (super user only)

Run these in **Supabase → SQL Editor**. Only the super user (Andy) does this; there is no role screen in the portal.

## 1. Give a Fornax staff member access

**Step A: create their login (once per person).**
Supabase → **Authentication → Users → Add user → Create new user**.
Enter their email, leave the password empty, tick **Auto Confirm User**, click **Create user**.
(They will log in with the 6-digit email code, never a password.)

**Step B: give them a role.** Change the email and role, then run:

```sql
insert into public.user_profiles (user_id, email, full_name, role)
select id, email, 'Full Name', 'sales'          -- role: 'admin', 'sales', 'chemist' or 'ops'
from auth.users where email = 'first.last@fornax.co.uk'
on conflict (user_id) do update set role = excluded.role, full_name = excluded.full_name, is_active = true;
```

Current staff (agreed 12 Oct 2026):

| Name | Email | Role |
|---|---|---|
| Andy Przybysz | andy.przybysz@fornax.co.uk | admin (done) |
| Amie Stringer | amie.stringer@fornax.co.uk | sales |
| Charles Robinson | charles.robinson@fornax.co.uk | sales |
| David Mills | david.mills@fornax.co.uk | chemist |
| David Castor | david.castor@fornax.co.uk | ops |

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
