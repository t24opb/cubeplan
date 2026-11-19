-- CubePlanner: stacking strength.
-- Run once in the Supabase SQL editor, after schema.sql. Until it is
-- run, a product's "Max on top" limit is kept only in the browser it
-- was typed into; afterwards the whole business shares it.

alter table public.products
  add column if not exists top_load_kg numeric(8, 2)
  check (top_load_kg is null or top_load_kg >= 0);

comment on column public.products.top_load_kg is
  'The most weight (kg) one carton can carry on top of it. Null: no limit of its own. 0: nothing may be stacked on it.';
