-- Migration 3: allow a customer to move their own quote from sent to accepted.
alter policy q_update on public.quotes
  using ((select app.has_role('admin','sales')) or (customer_id = (select app.my_customer_id()) and status = 'sent'))
  with check ((select app.has_role('admin','sales')) or (customer_id = (select app.my_customer_id()) and status in ('sent','accepted')));
