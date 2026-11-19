-- CubePlanner: business accounts and the products each business shares.
--
-- Run once in the Supabase SQL editor of the project (safe to run again:
-- everything is created "if not exists" or replaced).
--
-- The model
--   businesses    one row per customer business
--   members       which signed-in users belong to which business, and
--                 whether each is an admin or an ordinary member
--   invitations   email addresses an admin has invited; the person joins
--                 the business the first time they sign in with that email
--   products      the cartons a business has set up (from the iPhone app
--                 or the website); every member of the business sees them
--
-- Who may do what (enforced by the row-level security policies below,
-- so it holds for the website, the iPhone app and anything else that
-- talks to the database with a user's sign-in):
--   any signed-in user   create a business (they become its admin);
--                        accept invitations sent to their own email
--   a member             see the business, its members and its products;
--                        add and change products
--   an admin             all of that, plus: rename the business, invite
--                        and remove people, delete products

create extension if not exists pgcrypto;

create table if not exists public.businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now()
);

create table if not exists public.members (
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null default 'member' check (role in ('admin', 'member')),
  email       text not null,
  joined_at   timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index if not exists members_user on public.members (user_id);

create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  email       text not null check (email = lower(btrim(email)) and position('@' in email) > 1),
  role        text not null default 'member' check (role in ('admin', 'member')),
  invited_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now(),
  unique (business_id, email)
);

create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 200),
  sku         text,
  barcode     text,
  length_cm   numeric(8, 1) not null check (length_cm > 0 and length_cm <= 2000),
  width_cm    numeric(8, 1) not null check (width_cm > 0 and width_cm <= 2000),
  height_cm   numeric(8, 1) not null check (height_cm > 0 and height_cm <= 2000),
  weight_kg   numeric(8, 2) check (weight_kg is null or weight_kg >= 0),
  -- May be loaded on its side or end.
  tippable    boolean not null default false,
  colour      text,
  -- 'scan' (measured by the app), 'manual' or 'import'.
  source      text not null default 'manual' check (source in ('scan', 'manual', 'import')),
  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists products_business on public.products (business_id, name);

-- Membership checks. "security definer" so the policies on `members`
-- can ask them without asking themselves in a loop.
create or replace function public.is_member(business uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m where m.business_id = business and m.user_id = auth.uid());
$$;

create or replace function public.is_admin(business uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m where m.business_id = business and m.user_id = auth.uid() and m.role = 'admin');
$$;

-- Creates a business with the caller as its first admin.
create or replace function public.create_business(business_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  insert into public.businesses (name, created_by) values (btrim(business_name), auth.uid()) returning id into new_id;
  insert into public.members (business_id, user_id, role, email)
    values (new_id, auth.uid(), 'admin', lower(coalesce(auth.jwt() ->> 'email', '')));
  return new_id;
end;
$$;

-- Joins the caller to every business that has invited their email
-- address. Called by the website and the app straight after sign-in.
create or replace function public.accept_invitations()
returns integer language plpgsql security definer set search_path = public as $$
declare
  my_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  joined integer := 0;
begin
  if auth.uid() is null or my_email = '' then return 0; end if;
  insert into public.members (business_id, user_id, role, email)
    select i.business_id, auth.uid(), i.role, my_email from public.invitations i where i.email = my_email
    on conflict (business_id, user_id) do nothing;
  get diagnostics joined = row_count;
  delete from public.invitations where email = my_email;
  return joined;
end;
$$;

-- Removes someone from a business. An admin may remove anyone; anyone
-- may remove themselves; the last admin cannot be removed.
create or replace function public.remove_member(business uuid, person uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_admin(business) or person = auth.uid()) then raise exception 'Only an admin can remove other people.'; end if;
  if (select role from public.members where business_id = business and user_id = person) = 'admin'
     and (select count(*) from public.members where business_id = business and role = 'admin') <= 1 then
    raise exception 'A business must keep at least one admin.';
  end if;
  delete from public.members where business_id = business and user_id = person;
end;
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products for each row execute function public.touch_updated_at();

-- Row-level security: nothing is readable or writable except through
-- the policies below.
alter table public.businesses  enable row level security;
alter table public.members     enable row level security;
alter table public.invitations enable row level security;
alter table public.products    enable row level security;

drop policy if exists businesses_read   on public.businesses;
drop policy if exists businesses_rename on public.businesses;
create policy businesses_read   on public.businesses for select to authenticated using (public.is_member(id));
create policy businesses_rename on public.businesses for update to authenticated using (public.is_admin(id)) with check (public.is_admin(id));
-- Businesses are created with create_business(); members are added by
-- create_business() and accept_invitations(), and removed by
-- remove_member(). No direct insert or delete is allowed on either.

drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated using (public.is_member(business_id));

drop policy if exists invitations_read   on public.invitations;
drop policy if exists invitations_send   on public.invitations;
drop policy if exists invitations_cancel on public.invitations;
create policy invitations_read on public.invitations for select to authenticated
  using (public.is_admin(business_id) or email = lower(coalesce(auth.jwt() ->> 'email', '')));
create policy invitations_send on public.invitations for insert to authenticated
  with check (public.is_admin(business_id) and invited_by = auth.uid());
create policy invitations_cancel on public.invitations for delete to authenticated using (public.is_admin(business_id));

drop policy if exists products_read   on public.products;
drop policy if exists products_add    on public.products;
drop policy if exists products_change on public.products;
drop policy if exists products_delete on public.products;
create policy products_read   on public.products for select to authenticated using (public.is_member(business_id));
create policy products_add    on public.products for insert to authenticated with check (public.is_member(business_id));
create policy products_change on public.products for update to authenticated using (public.is_member(business_id)) with check (public.is_member(business_id));
create policy products_delete on public.products for delete to authenticated using (public.is_admin(business_id));

-- Table access is granted here, table by table, so the project can be
-- created with "Grant API access to new tables automatically" switched
-- off. Signed-in users get only what the policies above then narrow
-- down; visitors who are not signed in get nothing at all.
revoke all on public.businesses, public.members, public.invitations, public.products from anon;
revoke all on public.businesses, public.members, public.invitations, public.products from authenticated;
grant select, update                 on public.businesses  to authenticated;
grant select                         on public.members     to authenticated;
grant select, insert, delete         on public.invitations to authenticated;
grant select, insert, update, delete on public.products    to authenticated;

-- Only signed-in users may call the functions.
revoke all on function public.create_business(text), public.accept_invitations(), public.remove_member(uuid, uuid) from public, anon;
grant execute on function public.create_business(text), public.accept_invitations(), public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.is_member(uuid), public.is_admin(uuid) to authenticated;
