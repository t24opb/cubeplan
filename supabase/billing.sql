-- CubePlanner: the paywall. Run once in the Supabase SQL editor AFTER
-- schema.sql, and only when the Stripe functions are deployed and tested
-- (see README.md): from that moment a business's products can only be
-- read on the website while it has a paid plan.
--
-- A business's plan:
--   none      has never paid (every new business starts here)
--   active    paying
--   past_due  a payment failed and Stripe is still retrying; kept working
--   canceled  the subscription ended
--   comped    switched on by hand, no payment (set in this editor only)
--
-- Only the Stripe webhook (which uses the service key) and this editor
-- can change a plan. Signed-in users cannot: they may update nothing on
-- a business except its name.

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'businesses' and column_name = 'plan_status') then
    alter table public.businesses
      add column plan_status text not null default 'none'
        check (plan_status in ('none', 'active', 'past_due', 'canceled', 'comped')),
      add column stripe_customer_id text,
      add column stripe_subscription_id text,
      add column paid_until timestamptz;
    -- Businesses that existed before the paywall keep working.
    update public.businesses set plan_status = 'comped';
  end if;
end $$;

create or replace function public.is_paid(business uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.businesses b where b.id = business and b.plan_status in ('active', 'past_due', 'comped'));
$$;
grant execute on function public.is_paid(uuid) to authenticated;

-- Users may rename their business and nothing else on it.
revoke update on public.businesses from authenticated;
grant update (name) on public.businesses to authenticated;

-- Products: reading, changing and deleting need a paid plan. Adding does
-- not, so the iPhone app can go on sending measured cartons to a business
-- that has not subscribed yet; they are there when it does.
drop policy if exists products_read   on public.products;
drop policy if exists products_change on public.products;
drop policy if exists products_delete on public.products;
create policy products_read   on public.products for select to authenticated
  using (public.is_member(business_id) and public.is_paid(business_id));
create policy products_change on public.products for update to authenticated
  using (public.is_member(business_id) and public.is_paid(business_id))
  with check (public.is_member(business_id) and public.is_paid(business_id));
create policy products_delete on public.products for delete to authenticated
  using (public.is_admin(business_id) and public.is_paid(business_id));
